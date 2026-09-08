let ctx, original=null, mastered=null, masterURL=null, originalURL=null, workletReady=false, sourceName="studio-master", originalFilenameBase="studio-master", originalArtist="", originalTitle="", beforeMetrics=null, afterMetrics=null, compareMode="after";
const $=id=>document.getElementById(id);
const db=v=>20*Math.log10(Math.max(Math.abs(v),1e-12));
const drop=$("drop"), file=$("file");

const chooseFileBtn=$("chooseFileBtn");

function openFilePicker(){
  if(!file)return;
  // Reset the value so selecting the same track again still fires change.
  file.value="";
  file.click();
}

drop.addEventListener("click",e=>{
  if(e.target!==chooseFileBtn) openFilePicker();
});
chooseFileBtn?.addEventListener("click",e=>{
  e.preventDefault();
  e.stopPropagation();
  openFilePicker();
});
drop.addEventListener("dragover",e=>{
  e.preventDefault();
  drop.style.borderColor="#6878ff";
});
drop.addEventListener("dragleave",()=>{
  drop.style.borderColor="";
});
drop.addEventListener("drop",e=>{
  e.preventDefault();
  drop.style.borderColor="";
  const f=e.dataTransfer?.files?.[0];
  if(f) load(f);
});
file.addEventListener("change",()=>{
  const f=file.files?.[0];
  if(f) load(f);
});


function audioBufferToWav(buffer,tags={},bitDepth=16){
  const channels=Math.min(2,buffer.numberOfChannels);
  const sampleRate=buffer.sampleRate;
  const frames=buffer.length;
  const bytesPerSample=bitDepth===24?3:2;
  const blockAlign=channels*bytesPerSample;
  const dataSize=frames*blockAlign;
  const pcm=new ArrayBuffer(44+dataSize);
  const view=new DataView(pcm);
  const writeString=(off,s)=>{for(let i=0;i<s.length;i++)view.setUint8(off+i,s.charCodeAt(i));};
  writeString(0,"RIFF");
  view.setUint32(4,36+dataSize,true);
  writeString(8,"WAVE"); writeString(12,"fmt ");
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,channels,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*blockAlign,true);
  view.setUint16(32,blockAlign,true); view.setUint16(34,bitDepth,true);
  writeString(36,"data"); view.setUint32(40,dataSize,true);
  const data=Array.from({length:channels},(_,c)=>buffer.getChannelData(c));
  let pos=44;
  for(let i=0;i<frames;i++) for(let c=0;c<channels;c++){
    const v=Math.max(-1,Math.min(1,data[c][i]||0));
    if(bitDepth===24){
      let n=Math.round(v<0?v*8388608:v*8388607);
      if(n<0)n+=0x1000000;
      view.setUint8(pos,n&255); view.setUint8(pos+1,(n>>8)&255); view.setUint8(pos+2,(n>>16)&255); pos+=3;
    }else{
      view.setInt16(pos,v<0?v*32768:v*32767,true); pos+=2;
    }
  }
  const infoMap={INAM:tags.title,IART:tags.artist,IURL:tags.website,IGNR:tags.genre,ICRD:tags.year,IPRD:tags.publisher,ICMT:tags.copyright};
  const entries=Object.entries(infoMap).filter(([,v])=>String(v||'').trim());
  if(!entries.length)return pcm;
  // RIFF/WAV LIST/INFO historically uses a single-byte code page.
  // Do NOT put UTF-8 here: many WAV tag readers interpret those bytes as
  // Windows-1252/ANSI and Russian text becomes mojibake. Keep Unicode in
  // the ID3 chunk (UTF-16), and encode LIST/INFO as Windows-1251 for Cyrillic.
  const cp1251 = (str)=>{
    const out=[];
    for(const ch of String(str)){
      const c=ch.charCodeAt(0);
      if(c<0x80){ out.push(c); continue; }
      if(c>=0x0410 && c<=0x044F){ out.push(c<=0x042F ? c-0x0410+0xC0 : c-0x0430+0xE0); continue; }
      const map={"Ё":0xA8,"ё":0xB8,"Є":0xAA,"є":0xBA,"Ї":0xAF,"ї":0xBF,"І":0xB2,"і":0xB3,"Ў":0xA1,"ў":0xA2,"№":0xB9,"«":0xAB,"»":0xBB,"–":0x96,"—":0x97,"…":0x85,"©":0xA9,"®":0xAE,"™":0x99};
      out.push(map[ch] ?? 0x3F);
    }
    return new Uint8Array(out);
  };
  const chunks=[]; let listSize=4;
  for(const [id,val] of entries){
    const bytes=cp1251(String(val)); const size=bytes.length+1, padded=size+(size%2);
    const b=new Uint8Array(8+padded); for(let i=0;i<4;i++)b[i]=id.charCodeAt(i); new DataView(b.buffer).setUint32(4,size,true); b.set(bytes,8); chunks.push(b); listSize+=8+padded;
  }
  const list=new Uint8Array(8+listSize); const lv=new DataView(list.buffer); list.set([76,73,83,84],0); lv.setUint32(4,listSize,true); list.set([73,78,70,79],8); let lp=12;
  for(const b of chunks){list.set(b,lp);lp+=b.length}
  const out=new Uint8Array(pcm.byteLength+list.byteLength); out.set(new Uint8Array(pcm),0); out.set(list,pcm.byteLength);
  new DataView(out.buffer).setUint32(4,out.byteLength-8,true); return out.buffer;
}

function utf16Payload(value){
  const str=String(value||""), bytes=[0xFF,0xFE];
  for(let i=0;i<str.length;i++){const c=str.charCodeAt(i);bytes.push(c&255,(c>>8)&255)}
  bytes.push(0,0); return new Uint8Array([1,...bytes]);
}
function id3TextFrame(id,value){
  if(value===undefined||value===null||String(value)==="")return null;
  const payload=utf16Payload(value), out=new Uint8Array(10+payload.length);
  out.set([...id].map(c=>c.charCodeAt(0)),0); new DataView(out.buffer).setUint32(4,payload.length,false); out.set(payload,10); return out;
}
function id3TxxxFrame(desc,value){
  if(!value)return null;
  const d=String(desc), v=String(value), raw=[1,0xFF,0xFE];
  for(let i=0;i<d.length;i++){const c=d.charCodeAt(i);raw.push(c&255,(c>>8)&255)}
  raw.push(0,0);
  for(let i=0;i<v.length;i++){const c=v.charCodeAt(i);raw.push(c&255,(c>>8)&255)}
  raw.push(0,0);
  const payload=new Uint8Array(raw), out=new Uint8Array(10+payload.length);
  out.set([84,88,88,88],0); new DataView(out.buffer).setUint32(4,payload.length,false); out.set(payload,10); return out;
}
function id3UrlFrame(value){
  if(!value)return null;
  const u=new TextEncoder().encode(String(value)), payload=new Uint8Array(1+u.length); payload[0]=3; payload.set(u,1);
  const out=new Uint8Array(10+payload.length); out.set([87,79,65,82],0); new DataView(out.buffer).setUint32(4,payload.length,false); out.set(payload,10); return out;
}
function syncsafe(n){return new Uint8Array([(n>>21)&127,(n>>14)&127,(n>>7)&127,n&127]);}

function id3CommentFrame(value){
  if(!value)return null;
  const text=String(value), raw=[1,0xFF,0xFE,0x00,0x00];
  for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);raw.push(c&255,(c>>8)&255)}
  raw.push(0,0);
  const payload=new Uint8Array(raw), out=new Uint8Array(10+payload.length);
  out.set([67,79,77,77],0); new DataView(out.buffer).setUint32(4,payload.length,false); out.set(payload,10); return out;
}
// ЖЁСТКАЯ ОЧИСТКА ID3: экспорт всегда создаётся с нуля.
// Ни один исходный ID3 frame (TXXX/PRIV/COMM/GEOB/UFID/APIC и т.д.)
// не копируется автоматически. Поэтому скрытые AI-поля и служебные AI-метки
// физически отсутствуют в готовом файле. Записываются только перечисленные ниже
// стандартные поля редактора и новый Track ID.
function buildId3Bytes(tags){
  const frames=[
    id3TextFrame("TPE1",tags.artist), id3TextFrame("TIT2",tags.title), id3TextFrame("TALB",tags.album),
    id3TextFrame("TCON",tags.genre), id3TextFrame("TDRC",tags.year), id3TextFrame("TPUB",tags.publisher),
    id3TextFrame("TCOM",tags.composer), id3TextFrame("TCOP",tags.copyright), id3UrlFrame(tags.website),
    id3TextFrame("TSRC",tags.isrc), id3TextFrame("TRCK",tags.trackNumber), id3CommentFrame(tags.comment),
    id3TxxxFrame("Track ID",tags.trackId)
  ].filter(Boolean);
  const size=frames.reduce((n,f)=>n+f.length,0), head=new Uint8Array(10);
  head.set([73,68,51,3,0,0],0); head.set(syncsafe(size),6);
  const out=new Uint8Array(10+size); out.set(head,0); let p=10;
  for(const f of frames){out.set(f,p);p+=f.length}
  return out;
}
function addId3ChunkToWav(wav,tags){
  const id3=buildId3Bytes(tags), pad=id3.length%2, chunk=new Uint8Array(8+id3.length+pad);
  chunk.set([105,100,51,32],0); new DataView(chunk.buffer).setUint32(4,id3.length,true); chunk.set(id3,8);
  const src=new Uint8Array(wav), out=new Uint8Array(src.length+chunk.length); out.set(src); out.set(chunk,src.length);
  new DataView(out.buffer).setUint32(4,out.length-8,true); return out.buffer;
}
function addMp3Tags(chunks,tags){
  return [buildId3Bytes(tags),...chunks];
}

const DEFAULT_TRACK_ID="muzer-play-26-00000";
const TRACK_ID_STORAGE_KEY="muzerPlayUsedTrackIds";
const usedTrackIds=new Set();
try{
  const saved=JSON.parse(localStorage.getItem(TRACK_ID_STORAGE_KEY)||"[]");
  if(Array.isArray(saved)) saved.forEach(id=>usedTrackIds.add(String(id)));
}catch(e){}
function rememberTrackId(id){
  if(!id)return;
  usedTrackIds.add(String(id));
  try{localStorage.setItem(TRACK_ID_STORAGE_KEY,JSON.stringify([...usedTrackIds].slice(-10000)))}catch(e){}
}
const trackTags={
  trackId:DEFAULT_TRACK_ID, artist:"MUZER play", title:"", album:"", genre:"",
  year:"2026", publisher:"MUZER play", composer:"MUZER play",
  copyright:"© MUZER play", website:"", comment:"", isrc:"", trackNumber:"",
};

function decodeId3Text(data){
  if(!data || !data.length)return "";
  const enc=data[0], body=data.subarray(1);
  try{
    if(enc===0) return new TextDecoder("iso-8859-1").decode(body).replace(/\0+$/,"").trim();
    if(enc===3) return new TextDecoder("utf-8").decode(body).replace(/\0+$/,"").trim();
    let little=false, off=0;
    if(body.length>=2 && body[0]===0xFF && body[1]===0xFE){little=true;off=2}
    else if(body.length>=2 && body[0]===0xFE && body[1]===0xFF){little=false;off=2}
    else {little=true}
    const vals=[];
    for(let i=off;i+1<body.length;i+=2) vals.push(little ? body[i]|(body[i+1]<<8) : (body[i]<<8)|body[i+1]);
    return String.fromCharCode(...vals).replace(/\0+$/,"").trim();
  }catch(e){return ""}
}
function syncsafeToInt(a){return ((a[0]&127)<<21)|((a[1]&127)<<14)|((a[2]&127)<<7)|(a[3]&127)}
function normalFrameSize(view,pos,version){
  if(version===4)return syncsafeToInt(new Uint8Array(view.buffer,view.byteOffset+pos,4));
  return view.getUint32(pos,false);
}
function parseId3(buffer){
  const bytes=new Uint8Array(buffer), out={};
  if(bytes.length>=10 && bytes[0]===73&&bytes[1]===68&&bytes[2]===51){
    const ver=bytes[3], size=syncsafeToInt(bytes.subarray(6,10)), end=Math.min(bytes.length,10+size);
    let p=10;
    while(p+10<=end){
      const id=String.fromCharCode(...bytes.subarray(p,p+4));
      if(!/^[A-Z0-9]{4}$/.test(id))break;
      const view=new DataView(buffer,p+4,4), sz=normalFrameSize(view,0,ver);
      if(!sz || p+10+sz>end)break;
      const payload=bytes.subarray(p+10,p+10+sz);
      if(id[0]==="T" && id!=="TXXX" && id!=="TXX" ){
        const val=decodeId3Text(payload);
        if(val) out[id]=val;
      }else if(id==="TXXX"){
        const val=decodeId3Text(payload);
        const raw=val.split(/\0/);
        const desc=(raw[0]||"").trim(), value=raw.slice(1).join("\0").trim();
        if(desc) out["TXXX:"+desc.toLowerCase()]=value||desc;
      }else if(id==="COMM"){
        const enc=payload[0]; let off=4;
        if(enc===0||enc===3){while(off<payload.length&&payload[off]!==0)off++; off++}
        else {while(off+1<payload.length&&(payload[off]||payload[off+1]))off+=2;off+=2}
        const val=decodeId3Text(new Uint8Array([enc,...payload.subarray(off)]));
        if(val) out.COMM=val;
      }
      p+=10+sz;
    }
  }
  // ID3v1 fallback
  if(!out.TIT2 && bytes.length>=128){
    const s=bytes.length-128, tag=String.fromCharCode(...bytes.subarray(s,s+3));
    if(tag==="TAG"){
      const txt=(a,b)=>new TextDecoder("windows-1252").decode(bytes.subarray(s+a,s+b)).replace(/\0/g,"").trim();
      out.TIT2=txt(3,33); out.TPE1=txt(33,63); out.TALB=txt(63,93); out.TYER=txt(93,97); out.TCON=String(bytes[s+127]);
      out.COMM=txt(97,127);
    }
  }
  return out;
}
function makeTrackId(){
  let id, attempts=0;
  do{
    const n=window.crypto?.getRandomValues
      ? new Uint32Array(1)
      : null;
    if(n){window.crypto.getRandomValues(n); id=`muzer-play-26-${String(n[0]%100000).padStart(5,"0")}`}
    else id=`muzer-play-26-${String(Math.floor(Math.random()*100000)).padStart(5,"0")}`;
    attempts++;
    if(attempts>100000) throw new Error("Не удалось создать уникальный Track ID");
  }while(usedTrackIds.has(id));
  rememberTrackId(id);
  return id;
}
function applyParsedTags(parsed){
  const findT=(id)=>parsed[id]||"";
  // Track ID исходного файла никогда не переносим: каждый новый обработанный трек получает новый уникальный ID.
  trackTags.trackId=makeTrackId();
  trackTags.artist=findT("TPE1")||"MUZER play";
  trackTags.title=findT("TIT2")||trackTags.title||"";
  trackTags.album=findT("TALB");
  trackTags.genre=findT("TCON");
  trackTags.year=findT("TDRC")||findT("TYER")||"2026";
  trackTags.publisher=findT("TPUB")||"MUZER play";
  trackTags.composer=findT("TCOM")||"MUZER play";
  trackTags.copyright=findT("TCOP")||"© MUZER play";
  trackTags.website=findT("WXXX")||findT("WOAR")||"";
  trackTags.comment=findT("COMM")||"";
  trackTags.isrc=findT("TSRC")||"";
  trackTags.trackNumber=findT("TRCK")||"";
}
function getTrackTags(){return {...trackTags}}

// При каждом экспорте создаём НОВЫЙ чистый ID3.
// Старые ID3/AI-поля исходника никогда не переносятся.
// Имя файла, TITLE и ARTIST сохраняются оригинальными.
function getCleanExportTags(){
  // Только белый список полей. Любые неизвестные/скрытые поля исходного файла
  // сюда не попадают и физически не могут оказаться в новом ID3.
  return {
    trackId:makeTrackId(),
    artist:originalArtist||trackTags.artist||"MUZER play",
    title:originalTitle||trackTags.title||originalFilenameBase||"",
    album:trackTags.album||"",
    genre:trackTags.genre||"",
    year:trackTags.year||"",
    publisher:trackTags.publisher||"MUZER play",
    composer:trackTags.composer||"MUZER play",
    copyright:trackTags.copyright||"© MUZER play",
    website:trackTags.website||"",
    comment:trackTags.comment||"",
    isrc:trackTags.isrc||"",
    trackNumber:trackTags.trackNumber||""
  };
}
function fillTagForm(){
  const ids=["trackId","artist","title","album","genre","year","publisher","composer","copyright","website","comment","isrc","trackNumber"];
  ids.forEach(k=>{const el=$("tag"+k.charAt(0).toUpperCase()+k.slice(1)); if(el)el.value=trackTags[k]||""});
}
function openTagEditor(){fillTagForm();$("tagModal").classList.add("open");$("tagModal").setAttribute("aria-hidden","false");$("tagArtist").focus()}
function closeTagEditor(){ $("tagModal").classList.remove("open");$("tagModal").setAttribute("aria-hidden","true") }
$("editTagsBtn")?.addEventListener("click",openTagEditor);
$("cancelTags")?.addEventListener("click",closeTagEditor);
$("randomTrackId")?.addEventListener("click",()=>{$("tagTrackId").value=makeTrackId()});
$("tagModal")?.addEventListener("click",e=>{if(e.target.id==="tagModal")closeTagEditor()});
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeTagEditor()});
$("saveTags")?.addEventListener("click",()=>{
  const get=id=>$(id)?.value.trim()||"";
  const enteredTrackId=get("tagTrackId");
  if(!enteredTrackId || enteredTrackId===trackTags.trackId){
    trackTags.trackId=trackTags.trackId||makeTrackId();
  }else{
    if(usedTrackIds.has(enteredTrackId)){
      trackTags.trackId=makeTrackId();
    }else{
      trackTags.trackId=enteredTrackId;
      rememberTrackId(enteredTrackId);
    }
  }
  trackTags.artist=get("tagArtist")||"MUZER play"; trackTags.title=get("tagTitle")||sourceName;
  trackTags.album=get("tagAlbum"); trackTags.genre=get("tagGenre"); trackTags.year=get("tagYear").slice(0,4)||"2026";
  trackTags.publisher=get("tagPublisher")||"MUZER play"; trackTags.composer=get("tagComposer")||"MUZER play";
  trackTags.copyright=get("tagCopyright")||"© MUZER play"; trackTags.website=get("tagWebsite");
  trackTags.comment=get("tagComment"); trackTags.isrc=get("tagIsrc"); trackTags.trackNumber=get("tagTrackNumber");
  // Имя сохраняемого файла всегда остаётся оригинальным именем загруженного трека.
  // Изменение ID3 TITLE не переименовывает файл при экспорте.
  $("name").textContent=trackTags.title; toast("ID3-теги сохранены"); closeTagEditor();
});

let selectedSaveDirectory=null;
let selectedSaveFile=null;

function isVKMiniApp(){
  return !!(window.vkBridge && typeof window.vkBridge.send === "function");
}

async function chooseSaveTarget(filename,mime){
  // В Chromium используем системный диалог "Сохранить файл".
  // startIn=desktop просит браузер открыть Рабочий стол, если это поддерживается.
  if(!isVKMiniApp() && typeof window.showSaveFilePicker === "function"){
    return await window.showSaveFilePicker({
      suggestedName:filename,
      startIn:"desktop",
      types:[{description:"Аудиофайл",accept:{[mime]:[filename.toLowerCase().endsWith(".mp3")?".mp3":".wav"]}}]
    });
  }
  return null;
}

async function download(blob,filename,description,mime){
  if(selectedSaveFile){
    const writable=await selectedSaveFile.createWritable();
    await writable.write(blob);
    await writable.close();
    toast(filename+" — сохранён");
    return;
  }

  // Firefox / Safari / VK: используем стандартное скачивание браузера.
  // Место загрузки определяется настройками самого браузера.
  const url=URL.createObjectURL(blob);
  try{
    const a=document.createElement("a");
    a.href=url;
    a.download=filename;
    a.rel="noopener";
    a.style.display="none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(filename+" — загрузка началась");
  }finally{
    setTimeout(()=>URL.revokeObjectURL(url),15000);
  }
}

function resampleAudioBuffer(buffer,outRate,onProgress){
  if(buffer.sampleRate===outRate)return buffer;
  const outLen=Math.max(1,Math.round(buffer.length*outRate/buffer.sampleRate));
  const out=new AudioBuffer({length:outLen,numberOfChannels:buffer.numberOfChannels,sampleRate:outRate});
  const ratio=buffer.sampleRate/outRate;
  for(let c=0;c<buffer.numberOfChannels;c++){
    const src=buffer.getChannelData(c), dst=out.getChannelData(c);
    for(let i=0;i<outLen;i++){
      const x=i*ratio,j=Math.floor(x),f=x-j,j2=Math.min(j+1,src.length-1);
      dst[i]=src[j]*(1-f)+src[j2]*f;
    }
  }
  if(onProgress)onProgress(100);
  return out;
}

function preparePcm16(buffer,outRate,onProgress){
  const channels=Math.min(2,buffer.numberOfChannels), srcRate=buffer.sampleRate;
  const outLen=Math.max(1,Math.round(buffer.length*outRate/srcRate));
  const left=new Int16Array(outLen), right=channels===2?new Int16Array(outLen):null;
  const srcL=buffer.getChannelData(0), srcR=channels===2?buffer.getChannelData(1):null;
  const ratio=srcRate/outRate;
  const step=Math.max(1,Math.floor(outLen/100));
  for(let i=0;i<outLen;i++){
    const x=i*ratio, j=Math.floor(x), f=x-j, j2=Math.min(j+1,buffer.length-1);
    let l=srcL[j]*(1-f)+srcL[j2]*f;l=Math.max(-1,Math.min(1,l));left[i]=l<0?l*32768:l*32767;
    if(right){let r=srcR[j]*(1-f)+srcR[j2]*f;r=Math.max(-1,Math.min(1,r));right[i]=r<0?r*32768:r*32767}
    if(onProgress && (i%step===0 || i===outLen-1))onProgress(i/outLen*100);
  }
  return {left,right};
}

// ===== VK Mini Apps lifecycle =====
document.addEventListener("visibilitychange",()=>{
  if(!document.hidden && ctx && ctx.state==="suspended") ctx.resume().catch(()=>{});
});
window.addEventListener("pageshow",()=>{
  if(ctx && ctx.state==="suspended") ctx.resume().catch(()=>{});
});

// ===== Console UI helpers =====
function toast(s){const t=$("toast");t.textContent=s;t.style.display="block";clearTimeout(toast.t);toast.t=setTimeout(()=>t.style.display="none",2200)}
function drawWave(canvas,buf,color){if(!canvas||!buf)return;const r=canvas.getBoundingClientRect(),w=Math.max(1,Math.round(r.width)),h=Math.max(1,Math.round(r.height));canvas.width=w;canvas.height=h;const c=canvas.getContext('2d');c.clearRect(0,0,w,h);c.strokeStyle=color;c.lineWidth=1;const x=buf.getChannelData(0),step=Math.max(1,Math.floor(x.length/w));c.beginPath();for(let i=0;i<w;i++){let lo=1,hi=-1;for(let j=0;j<step;j++){const v=x[Math.min(x.length-1,i*step+j)];lo=Math.min(lo,v);hi=Math.max(hi,v)}c.moveTo(i,(1+lo)*h/2);c.lineTo(i,(1+hi)*h/2)}c.stroke()}
window.addEventListener('resize',()=>{drawWave($('waveA'),original,'#31caff');drawWave($('waveB'),mastered,'#43ff9a')});
const oldLoad=load;load=async function(f){await oldLoad(f);if(original){drawWave($('waveA'),original,'#31caff');$('name').textContent=sourceName;toast('Трек загружен в Деку A')}};
const oldMakePlayer=makePlayer;makePlayer=function(){oldMakePlayer();drawWave($('waveB'),mastered,'#43ff9a');toast('Мастер готов в Деке B')};
function seek(player,d){if(player.duration)player.currentTime=Math.max(0,Math.min(player.duration,player.currentTime+d))}

$("generatorSite")?.addEventListener("change",async e=>{
  const url=e.target.value;
  if(!url)return;
  try{
    if(isVKMiniApp()){
      await window.vkBridge.send("VKWebAppOpenURL",{url});
    }else{
      window.open(url,"_blank","noopener,noreferrer");
    }
  }catch(err){
    console.warn("Open URL failed:",err);
    window.location.href=url;
  }
  e.target.value="";
});
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{const a=b.dataset.action;if(a==='analyze'&&original){analyze(original).then(m=>{beforeMetrics=m;setBeforeMetrics(m);toast('Анализ завершён')})}else if(a==='eq')toast('Smart Auto-EQ применяется во время мастеринга');else if(a==='compress')toast('Многополосная компрессия активна');else if(a==='limit')toast('True Peak ceiling: -1.0 dBTP');else if(a==='spectrum')toast('Спектральный анализ выполняется при мастеринге');else if(a==='normalize')toast('Цель громкости: '+$('target').value+' LUFS');else if(a==='settings')toast('Выберите качество и целевую громкость внизу')});

// ===== Fixed console player/timeline integration =====
function fmtTime(s){if(!Number.isFinite(s)||s<0)return '0:00';const m=Math.floor(s/60),q=Math.floor(s%60);return m+':'+String(q).padStart(2,'0')}
function bindTimeline(playerId,seekId,timeId,durId){
  const p=$(playerId), r=$(seekId), t=$(timeId), d=$(durId); if(!p||!r)return;
  const sync=()=>{const dur=Number.isFinite(p.duration)?p.duration:0;t.textContent=fmtTime(p.currentTime);d.textContent=fmtTime(dur);if(!r.matches(':active'))r.value=dur?Math.round(p.currentTime/dur*1000):0};
  p.addEventListener('loadedmetadata',sync);p.addEventListener('durationchange',sync);p.addEventListener('timeupdate',sync);p.addEventListener('ended',sync);
  r.addEventListener('input',()=>{if(Number.isFinite(p.duration)&&p.duration>0)p.currentTime=p.duration*(Number(r.value)/1000);sync()});
}
bindTimeline('originalPlayer','aSeek','aTime','aDur');bindTimeline('player','bSeek','bTime','bDur');
for(const id of ['originalPlayer','player']){const el=$(id);el.preload='auto';el.addEventListener('error',()=>{const err=el.error;const code=err?err.code:0;const text=code===1?'загрузка отменена':code===2?'ошибка сети':code===3?'ошибка декодирования':code===4?'формат не поддерживается':'неизвестная ошибка';console.error('Audio element error',id,err);$("compareStatus").textContent='Ошибка воспроизведения: '+text;});}
async function playNoReset(id,otherId){
  const p=$(id),o=$(otherId);
  if(!p || !p.src){
    $("compareStatus").textContent=id==='originalPlayer'?'Сначала загрузите трек в Деку A.':'Сначала выполните студийный автомастеринг.';
    return;
  }
  try{
    if(ctx && ctx.state==='suspended') await ctx.resume();
    o.pause();
    // load() makes the Blob URL deterministic after switching/replacing tracks.
    if(p.readyState<2) p.load();
    await p.play();
    compareMode=id==='originalPlayer'?'before':'after';
    $("compareStatus").textContent=compareMode==='before'?'Слушаем ДО мастеринга — исходный файл.':'Слушаем ПОСЛЕ мастеринга — обработанный файл.';
  }catch(e){
    console.error('Playback error:',e);
    const msg=e && e.name==='NotAllowedError'?'Браузер запретил воспроизведение. Нажмите PLAY ещё раз.':(e?.message||'Не удалось воспроизвести файл.');
    $("compareStatus").textContent=msg;
    $("fileStatus").textContent=id==='originalPlayer'?msg:'Дека B: '+msg;
  }
}
$('aPlay').onclick=()=>playNoReset('originalPlayer','player');$('aPause').onclick=()=>$('originalPlayer').pause();$('aPrev').onclick=()=>seek($('originalPlayer'),-10);$('aNext').onclick=()=>seek($('originalPlayer'),10);
$('bPlay').onclick=()=>playNoReset('player','originalPlayer');$('bPause').onclick=()=>$('player').pause();$('bPrev').onclick=()=>seek($('player'),-10);$('bNext').onclick=()=>seek($('player'),10);

// Spin cassette reels only while the corresponding deck is actually playing.
function syncDeckReel(playerId, deckId){
  const p=$(playerId), d=$(deckId);
  if(!p||!d)return;
  const sync=()=>d.classList.toggle('playing', !p.paused && !p.ended);
  ['play','playing','pause','ended','emptied','abort'].forEach(ev=>p.addEventListener(ev,sync));
  sync();
}
syncDeckReel('originalPlayer','drop');
syncDeckReel('player','deckB');
const _makePlayerFixed=makePlayer;makePlayer=function(){_makePlayerFixed();const s=$('afterStatus');if(s)s.textContent='Дека B: мастер готов к прослушиванию';};
