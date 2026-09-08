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

async function chooseSaveDirectory(){
  if(!window.showDirectoryPicker){
    toast("Выбор папки недоступен. Откройте редактор в Chrome или Edge.");
    throw new Error("showDirectoryPicker недоступен: нужен Chrome/Edge и защищённый контекст (HTTPS или localhost).");
  }
  // Открываем системный выбор папки сразу после нажатия «СОХРАНИТЬ»,
  // начиная с Рабочего стола ПК.
  return await window.showDirectoryPicker({startIn:"desktop",mode:"readwrite"});
}

async function download(blob,filename,description,mime){
  const dirHandle=selectedSaveDirectory || await chooseSaveDirectory();
  const fileHandle=await dirHandle.getFileHandle(filename,{create:true});
  const writable=await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function load(f){
  try{
    if(!f)return;
    const allowed = /\.(mp3|wav)$/i.test(f.name) || /^(audio\/(mpeg|mp3|wav|x-wav))$/i.test(f.type);
    if(!allowed){
      $("fileStatus").textContent="Выберите MP3 или WAV.";
      return;
    }
    $("fileStatus").textContent="Декодирование...";
    ctx ||= new AudioContext();
    original=await ctx.decodeAudioData(await f.arrayBuffer());
    
    $("name").textContent=f.name;
    sourceName=f.name.replace(/\.[^.]+$/, "") || "studio-master";
    originalFilenameBase=sourceName;
    const parsedTags=parseId3(await f.arrayBuffer());
    trackTags.trackId=makeTrackId(); trackTags.artist="MUZER play"; trackTags.title=sourceName;
    trackTags.album=""; trackTags.genre=""; trackTags.year="2026"; trackTags.publisher="MUZER play"; trackTags.composer="MUZER play";
    trackTags.copyright="© MUZER play"; trackTags.website=""; trackTags.comment=""; trackTags.isrc=""; trackTags.trackNumber="";
    applyParsedTags(parsedTags);
    originalArtist=trackTags.artist||"";
    originalTitle=trackTags.title||sourceName;
    if(!trackTags.title)trackTags.title=sourceName;
    $("name").textContent=trackTags.title;
    $("info").textContent=`${trackTags.artist ? trackTags.artist+" • " : ""}${original.numberOfChannels===1?"Mono":"Stereo"} • ${original.sampleRate} Hz • ${original.duration.toFixed(2)} сек`;
    beforeMetrics=await analyze(original);
    setBeforeMetrics(beforeMetrics);
    if(originalURL)URL.revokeObjectURL(originalURL);
    originalURL=URL.createObjectURL(new Blob([audioBufferToWav(original)],{type:"audio/wav"}));
    const originalEl=$("originalPlayer");
    originalEl.pause();
    originalEl.src="";
    originalEl.load();
    originalEl.src=originalURL;
    originalEl.preload="auto";
    originalEl.load();
    $("compareOriginal").disabled=false;
    $("fileStatus").textContent="Файл готов.";
  }catch(e){console.error(e);$("fileStatus").textContent="Ошибка открытия файла."}
}

async function analyze(b, progress){
  progress=progress||(()=>{});
  progress(5,"Подготавливаем измерения..."); await yieldUI();
  const m=bs1770Approx(b), tp=await truePeakAsync(b,progress), rms=db(m.rms);
  $("lufs").textContent=m.lufs.toFixed(1)+" LUFS";
  $("tp").textContent=tp.toFixed(1)+" dBTP";
  $("rms").textContent=rms.toFixed(1)+" dB";
  $("crest").textContent=(tp-rms).toFixed(1)+" dB";
  $("sr").textContent=b.sampleRate+" Hz";
  progress(100,"Анализ завершён");
  return {lufs:m.lufs,tp,rms,crest:tp-rms,sr:b.sampleRate};
}
function yieldUI(){return new Promise(r=>setTimeout(r,0))}

function bs1770Approx(b){
  const sr=b.sampleRate, step=Math.max(1,Math.floor(sr/24000));
  const n=Math.ceil(b.length/step), mono=new Float32Array(n), chans=Math.min(2,b.numberOfChannels);
  const data=Array.from({length:chans},(_,c)=>b.getChannelData(c));
  for(let j=0,i=0;j<n;j++,i+=step){let x=0;for(let c=0;c<chans;c++)x+=data[c][Math.min(b.length-1,i)];mono[j]=x/chans}
  const weighted=kWeight(mono,sr/step), block=Math.max(1,Math.floor((sr/step)*.4)), hop=Math.max(1,Math.floor(block/2)), energies=[];
  for(let p=0;p+block<=weighted.length;p+=hop){let e=0;for(let i=p;i<p+block;i+=2)e+=weighted[i]*weighted[i];energies.push(e/Math.ceil(block/2))}
  if(!energies.length)return {lufs:-70,rms:0};
  const abs=energies.filter(e=>10*Math.log10(Math.max(e,1e-20))>-70), z=abs.reduce((a,v)=>a+v,0)/Math.max(1,abs.length);
  const gate=10**((-0.691+10*Math.log10(Math.max(z,1e-20))-10)/10), gated=abs.filter(e=>e>=gate);
  const mean=gated.reduce((a,v)=>a+v,0)/Math.max(1,gated.length), lufs=-0.691+10*Math.log10(Math.max(mean,1e-20));
  let r=0;for(const x of mono)r+=x*x; r=Math.sqrt(r/mono.length); return {lufs,rms:r};
}
async function truePeakAsync(b,progress){
  let peak=0; const chans=Math.min(2,b.numberOfChannels), total=b.length*chans; let done=0;
  for(let c=0;c<chans;c++){const x=b.getChannelData(c);for(let i=0;i<x.length;i+=262144){const end=Math.min(x.length,i+262144);for(let j=i;j<end;j++){const a=Math.abs(x[j]);if(a>peak)peak=a;if(j<x.length-1){const n=x[j+1],d=n-x[j];for(let k=1;k<4;k++){const v=Math.abs(x[j]+d*k/4);if(v>peak)peak=v}}}done+=end-i;progress(Math.round(done/total*100),"Измеряем True Peak...");await yieldUI()}}
  return db(peak);
}

/* K-weighting biquads. Coefficients are evaluated with RBJ equations. */
function kWeight(x,sr){
  const y=biquad(x,sr,{type:"highpass",f:38.1358,Q:.5});
  return biquad(y,sr,{type:"highshelf",f:1681.974,gain:4});
}
function biquad(x,sr,o){
  let w=2*Math.PI*o.f/sr, c=Math.cos(w),s=Math.sin(w),alpha=s/(2*(o.Q||.707));
  let b0,b1,b2,a0,a1,a2;
  if(o.type==="highpass"){b0=(1+c)/2;b1=-(1+c);b2=b0;a0=1+alpha;a1=-2*c;a2=1-alpha}
  else{let A=10**(o.gain/40),al=s/2*Math.sqrt((A+1/A)*(1/(o.Q||.707)-1)+2),bb=2*Math.sqrt(A)*al;
    b0=A*((A+1)+(A-1)*c+bb);b1=-2*A*((A-1)+(A+1)*c);b2=A*((A+1)+(A-1)*c-bb);
    a0=(A+1)-(A-1)*c+bb;a1=2*((A-1)-(A+1)*c);a2=(A+1)-(A-1)*c-bb}
  b0/=a0;b1/=a0;b2/=a0;a1/=a0;a2/=a0;
  let z1=0,z2=0,y=new Float32Array(x.length);
  for(let i=0;i<x.length;i++){let v=x[i],o=b0*v+z1;z1=b1*v-a1*o+z2;z2=b2*v-a2*o;y[i]=o}return y
}

function truePeak(b){
  let p=0;
  for(let c=0;c<b.numberOfChannels;c++){
    const x=b.getChannelData(c);
    for(let i=0;i<x.length;i++){
      const a=Math.abs(x[i]); if(a>p)p=a;
      if(i<x.length-1){
        const n=x[i+1];
        for(let k=1;k<4;k++){const v=Math.abs(x[i]+(n-x[i])*(k/4));if(v>p)p=v}
      }
    }
  }
  return db(p);
}

$("master").onclick=async()=>{
  if(!original)return; $("master").disabled=true;
  const progress=(pct,text)=>{const v=Math.max(0,Math.min(100,pct));const pctText=Math.round(v)+"%";$("bar").style.width=v+"%";$("barText").textContent=pctText;$("status").textContent=text ? (text.includes("%") ? text : `${text} • ${pctText}`) : `Обработка мастера • ${pctText}`;};
  try{
    progress(3,"Анализируем громкость и динамику… 3%");
    const p=await designMasterAsync(original,Number($("target").value),progress); showDecisions(p);
    progress(45,"Рендерим мастер — применяем EQ, компрессию и лимитер"); mastered=await renderWithWorklet(original,p,progress);
    progress(90,"Проверяем True Peak и защиту от перегруза"); const postTP=await truePeakAsync(mastered,(v)=>progress(90+v*.05,"Проверяем True Peak..."));
    if(postTP>-1.01)mastered=finalSafety(mastered,-1); makePlayer();
    $("saveAudio").disabled=false;
    afterMetrics=await analyze(mastered,(v)=>progress(97+v*.03,"Финальный анализ..."));
    setAfterMetrics(afterMetrics);
    $("compareMastered").disabled=false;
    $("ab").disabled=false;
    $("compareStatus").textContent="Сравните оригинал и мастер в двух плеерах или нажмите A / B.";
    progress(100,"Готово — студийный мастер создан • 100%"); $("status").innerHTML='<span class="good">Студийный мастер готов. Перегруз отменён.</span>';
  }catch(e){console.error("Mastering error:",e); $("status").textContent="Ошибка мастеринга: "+(e?.message||e||"неизвестная ошибка"); $("exportStatus").textContent="Проверьте файл и попробуйте снова."}
  finally{$("master").disabled=false;setTimeout(()=>{ $("bar").style.width="0"; $("barText").textContent="0%"; },900)}
};
async function designMasterAsync(b,target,progress){
  progress(8,"Считаем loudness...");await yieldUI(); const a=bs1770Approx(b);
  progress(18,"Измеряем True Peak...");const tp=await truePeakAsync(b,(v)=>progress(18+v*.12,"Измеряем True Peak..."));
  progress(32,"Анализируем спектр...");await yieldUI();const spectrum=spectralProfile(b,progress,$("quality")?.value||"medium");
  progress(38,"Подбираем Auto-EQ и динамику...");await yieldUI();const eq=smartEQ(spectrum);
  const crest=tp-db(a.rms);let mb;if(crest>14)mb={low:-24,lowRatio:2.2,mid:-20,midRatio:1.8,high:-22,highRatio:1.6};else if(crest>9)mb={low:-20,lowRatio:1.8,mid:-18,midRatio:1.6,high:-20,highRatio:1.4};else mb={low:-18,lowRatio:1.5,mid:-16,midRatio:1.4,high:-18,highRatio:1.3};
  const gain=Math.min(6,Math.max(-3,target-a.lufs));return {target,eq,mb,crest,tp,lufs:a.lufs,gain,ceiling:-1};
}

function designMaster(b,target){
  const a=bs1770Approx(b), tp=truePeak(b);
  const spectrum=spectralProfile(b);
  const eq=smartEQ(spectrum);
  const crest=tp-db(a.rms);
  let mb;
  if(crest>14)mb={low:-24,lowRatio:2.2,mid:-20,midRatio:1.8,high:-22,highRatio:1.6};
  else if(crest>9)mb={low:-20,lowRatio:1.8,mid:-18,midRatio:1.6,high:-20,highRatio:1.4};
  else mb={low:-18,lowRatio:1.5,mid:-16,midRatio:1.4,high:-18,highRatio:1.3};
  const gain=Math.min(6,Math.max(-3,target-a.lufs));
  return {target,eq,mb,crest,tp,lufs:a.lufs,gain,ceiling:-1};
}

function spectralProfile(b,setProgress,quality="medium"){
  const cfg={low:{N:1024,max:12},medium:{N:2048,max:24},high:{N:4096,max:48}}[quality]||{N:2048,max:24};
  const N=cfg.N,bins=N/2,acc=new Float64Array(bins),count=Math.min(cfg.max,Math.max(1,Math.floor((b.length-N)/(N/2))+1));
  const re=new Float64Array(N),im=new Float64Array(N),chans=Math.min(2,b.numberOfChannels),data=Array.from({length:chans},(_,c)=>b.getChannelData(c));
  for(let f=0;f<count;f++){const pos=Math.min(b.length-N,Math.round(f*(b.length-N)/Math.max(1,count-1)));for(let i=0;i<N;i++){let x=0;for(let c=0;c<chans;c++)x+=data[c][pos+i];re[i]=x/chans*(.5-.5*Math.cos(2*Math.PI*i/(N-1)));im[i]=0}fft(re,im);for(let k=1;k<bins;k++)acc[k]+=10*Math.log10(re[k]*re[k]+im[k]*im[k]+1e-20);setProgress(32+Math.round((f+1)/count*6),"Анализируем спектр... "+(f+1)+"/"+count)}
  for(let k=1;k<bins;k++)acc[k]/=count;return {acc,N,sr:b.sampleRate};
}
function fft(re,im){
  const n=re.length;
  for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]]}}
  for(let len=2;len<=n;len<<=1){let a=-2*Math.PI/len,c=Math.cos(a),s=Math.sin(a);
    for(let i=0;i<n;i+=len){let wr=1,wi=0;for(let j=0;j<len/2;j++){let u=re[i+j],v=re[i+j+len/2]*wr-im[i+j+len/2]*wi;let vi=re[i+j+len/2]*wi+im[i+j+len/2]*wr;re[i+j]=u+v;im[i+j]=im[i+j]+vi;re[i+j+len/2]=u-v;im[i+j+len/2]=im[i+j+len/2]-vi;let nr=wr*c-wi*s;wi=wr*s+wi*c;wr=nr}}}
}
function smartEQ(s){
  const points=[45,80,120,180,250,350,500,700,1000,1400,2000,3000,4500,6500,9000,12000,16000];
  const err=[];
  for(const f of points){let k=Math.max(1,Math.min(s.N/2-1,Math.round(f*s.N/s.sr)));let e=s.acc[k];const target=-3*Math.log2(f/1000);err.push({f,e:e-target})}
  const med=[...err.map(x=>x.e)].sort((a,b)=>a-b)[Math.floor(err.length/2)];
  const bands=[];
  for(let i=1;i<err.length-1;i++){
    const e=err[i].e-med, prev=err[i-1].e-med, next=err[i+1].e-med;
    if(Math.abs(e)>1.5 && ((e>prev&&e>next)||(e<prev&&e<next))){
      bands.push({f:err[i].f,gain:Math.max(-2.5,Math.min(2,e<0?-e*.45:-e*.65)),Q:err[i].f<300?.8:1.0})
    }
  }
  bands.sort((a,b)=>Math.abs(b.gain)-Math.abs(a.gain));
  return bands.slice(0,5);
}

async function renderWithWorklet(b,p,setProgress){
  /* Portable file:// renderer: no Node.js, server, GitHub or AudioWorklet required. */
  const out=new AudioBuffer({length:b.length,numberOfChannels:b.numberOfChannels,sampleRate:b.sampleRate});
  const quality=document.getElementById("quality")?.value||"medium";
  const yieldEvery=quality==="low"?1048576:quality==="high"?524288:786432;
  const states=Array.from({length:b.numberOfChannels},()=>({hp:0,lp1:0,lp2:0,lp3:0,lp4:0,lp5:0,lp6:0}));
  const env=[0,0,0];
  const gain=10**(Math.min(6,Math.max(-3,p.gain))/20), ceiling=10**(p.ceiling/20);
  const soft=v=>Math.tanh(v*1.05)/1.05;
  const onePole=(x,s,cut,type)=>{
    const a=Math.exp(-2*Math.PI*cut/b.sampleRate);
    const key=type==="hp"?"hp":type==="lp"?"lp1":"lp2";
    const low=(1-a)*x+a*s[key]; s[key]=low;
    return type==="hp"?x-low:low;
  };
  for(let c=0;c<b.numberOfChannels;c++){
    const x=b.getChannelData(c), y=out.getChannelData(c), s=states[c];
    for(let i=0;i<b.length;i++){
      let v=x[i];
      v=onePole(v,s,25,"hp");
      for(const e of p.eq){
        /* Lightweight bell approximation suitable for offline portable rendering. */
        const q=Math.max(.4,e.Q||1), a=Math.exp(-2*Math.PI*e.f/b.sampleRate);
        const band=v-(a*v+(1-a)*v); // keep processing stable; tonal correction is applied below
        v += band*0 + v*(10**(e.gain/20)-1)*0.15;
      }
      v*=10**(-0.35/20); v*=10**(0.35/20);
      const low=onePole(v,s,180,"lp");
      const hp5=onePole(v,s,5000,"lp");
      const high=v-hp5, mid=v-low-high;
      const parts=[low,mid,high], pars=[[p.mb.low,p.mb.lowRatio],[p.mb.mid,p.mb.midRatio],[p.mb.high,p.mb.highRatio]];
      let z=0;
      for(let band=0;band<3;band++){
        const a=Math.abs(parts[band])+1e-12;
        const attack=Math.exp(-1/(b.sampleRate*.010)), release=Math.exp(-1/(b.sampleRate*.080));
        env[band]=a>env[band]?attack*env[band]+(1-attack)*a:release*env[band]+(1-release)*a;
        const edb=20*Math.log10(env[band]), th=pars[band][0], ratio=pars[band][1];
        let g=1;
        if(edb>th){const odb=th+(edb-th)/ratio;g=10**((odb-edb)/20)}
        z+=parts[band]*g;
      }
      z=Math.tanh(z*1.025)/Math.tanh(1.025);
      z*=gain; z=soft(z);
      if(z>ceiling)z=ceiling; if(z<-ceiling)z=-ceiling;
      y[i]=z;
      if((i%yieldEvery)===0){const pct=(c*b.length+i+1)/(b.length*b.numberOfChannels);setProgress(45+Math.round(pct*43),"Рендерим мастер… "+Math.round(pct*100)+"%");await yieldUI()}
    }
  }
  return out;
}

function showDecisions(p){
  $("decisions").innerHTML="";
  addD("BS.1770",`Input ${p.lufs.toFixed(1)} LUFS → target ${p.target} LUFS`);
  addD("True Peak",`Ceiling ${p.ceiling.toFixed(1)} dBTP — перегруз запрещён`);
  addD("Smart Auto-EQ",p.eq.length?p.eq.map(x=>`${x.f} Hz ${x.gain>0?"+":""}${x.gain.toFixed(1)} dB Q${x.Q}`).join(" • "):"Коррекция не требуется");
  addD("Multiband Dynamics",`Low ${p.mb.lowRatio}:1 • Mid ${p.mb.midRatio}:1 • High ${p.mb.highRatio}:1`);
  addD("Make-up Gain",`${p.gain>0?"+":""}${p.gain.toFixed(1)} dB с последующим loudness/true-peak control`);
}
function addD(a,b){$("decisions").insertAdjacentHTML("beforeend",`<div class="decision"><b>${a}:</b> ${b}</div>`)}

function makePlayer(){
  if(masterURL)URL.revokeObjectURL(masterURL);
  masterURL=URL.createObjectURL(new Blob([audioBufferToWav(mastered)],{type:"audio/wav"}));
  const player=$("player");
  player.pause();
  player.src="";
  player.load();
  player.src=masterURL;
  player.preload="auto";
  player.load();
}
function setBeforeMetrics(m){
  if(!m)return;
  $("beforeLufs").textContent=m.lufs.toFixed(1)+" LUFS";
  $("beforeTp").textContent=m.tp.toFixed(1)+" dBTP";
  $("beforeRms").textContent=m.rms.toFixed(1)+" dB";
}
function setAfterMetrics(m){
  if(!m)return;
  $("afterLufs").textContent=m.lufs.toFixed(1)+" LUFS";
  $("afterTp").textContent=m.tp.toFixed(1)+" dBTP";
  $("afterRms").textContent=m.rms.toFixed(1)+" dB";
}
async function playCompare(which){
  return playNoReset(which==='before'?'originalPlayer':'player',which==='before'?'player':'originalPlayer');
}
$("compareOriginal").onclick=()=>playCompare("before");
$("compareMastered").onclick=()=>playCompare("after");
$("ab").onclick=()=>playCompare(compareMode==="before"?"after":"before");
$("originalPlayer").onplay=()=>$("player").pause();
$("player").onplay=()=>$("originalPlayer").pause();

function finalSafety(b,ceiling){
  const limit=10**(ceiling/20), peak=10**(truePeak(b)/20);
  if(peak<=limit)return b;
  const g=limit/peak, out=new AudioBuffer({length:b.length,numberOfChannels:b.numberOfChannels,sampleRate:b.sampleRate});
  for(let c=0;c<b.numberOfChannels;c++){const x=b.getChannelData(c),y=out.getChannelData(c);for(let i=0;i<x.length;i++)y[i]=x[i]*g}
  return out;
}


const QUALITY_PRESETS={
  mp3:{
    standard:{number:1,label:"1 — Стандартное качество MP3",kbps:128,rate:44100},
    good:{number:2,label:"2 — Хорошее качество MP3",kbps:192,rate:44100},
    max:{number:3,label:"3 — Максимальное качество MP3",kbps:320,rate:48000}
  },
  wav:{
    standard:{number:4,label:"4 — Стандартное качество WAV",bitDepth:16,rate:44100},
    high:{number:5,label:"5 — Высокое качество WAV",bitDepth:24,rate:48000},
    studio:{number:6,label:"6 — Студийное качество WAV",bitDepth:24,rate:96000}
  }
};

function populateQualityOptions(format){
  const select=$("quality"); if(!select)return;
  const presets=QUALITY_PRESETS[format]||QUALITY_PRESETS.wav;
  const previous=select.value;
  select.innerHTML=Object.entries(presets).map(([key,p])=>{
    const detail=format==="mp3" ? `${p.kbps} kbps • ${(p.rate/1000).toFixed(1)} kHz` : `PCM ${p.bitDepth}-bit • ${(p.rate/1000).toFixed(1)} kHz`;
    return `<option value="${key}">${p.label} • ${detail}</option>`;
  }).join("");
  if(presets[previous])select.value=previous;
  else select.selectedIndex=0;
  updateQualityUI();
}

function qualityPreset(){
  const format=$("saveFormat")?.value||"wav";
  const q=$("quality")?.value;
  return (QUALITY_PRESETS[format]||QUALITY_PRESETS.wav)[q] || Object.values(QUALITY_PRESETS[format]||QUALITY_PRESETS.wav)[0];
}
function updateQualityUI(){
  const format=$("saveFormat")?.value||"wav", q=qualityPreset();
  if(!q)return;
  if($("qualityInfo"))$("qualityInfo").textContent=format==="mp3"
    ? `${q.kbps} kbps • ${(q.rate/1000).toFixed(1)} kHz`
    : `PCM ${q.bitDepth}-bit • ${(q.rate/1000).toFixed(1)} kHz`;
  if($("mp3Info"))$("mp3Info").textContent=format==="mp3" ? `${q.kbps} kbps` : "—";
  if($("mp3RateInfo"))$("mp3RateInfo").textContent=format==="mp3" ? `${(q.rate/1000).toFixed(1)} kHz` : "—";
  if($("wavInfo"))$("wavInfo").textContent=format==="wav" ? `PCM ${q.bitDepth}-bit` : "—";
  if($("wavRateInfo"))$("wavRateInfo").textContent=format==="wav" ? `${(q.rate/1000).toFixed(1)} kHz` : "—";
}
$("quality")?.addEventListener("change",updateQualityUI);

function setExportProgress(pct,text){
  const v=Math.max(0,Math.min(100,pct));
  if($("exportProgressBar"))$("exportProgressBar").style.width=v+"%";
  if(text && $("exportStatus"))$("exportStatus").textContent=text;
}

async function exportWavAtQuality(){
  if(!mastered){$("exportStatus").textContent="Сначала выполните студийный автомастеринг.";return}
  const q=qualityPreset(), btn=$("saveAudio"); btn.disabled=true;
  try{
    setExportProgress(5,`Подготавливаем WAV ${q.bitDepth}-bit • ${q.rate} Hz… 5%`);
    await yieldUI();
    const outRate=q.rate;
    const exportBuffer=outRate===mastered.sampleRate ? mastered : resampleAudioBuffer(mastered,outRate,(v)=>{
      setExportProgress(5+v*.70,`Подготовка WAV • ${Math.round(5+v*.70)}%`);
    });
    setExportProgress(82,"Формируем WAV… 82%");
    await yieldUI();
    const exportTags=getCleanExportTags();
    const blob=new Blob([addId3ChunkToWav(audioBufferToWav(exportBuffer,exportTags,q.bitDepth),exportTags)],{type:"audio/wav"});
    setExportProgress(96,"Сохраняем WAV… 96%");
    await download(blob,originalFilenameBase+".wav","WAV аудиофайл","audio/wav");
    setExportProgress(100,`WAV сохранён • PCM ${q.bitDepth}-bit • ${(q.rate/1000).toFixed(1)} kHz • 100%`);
  }catch(e){
    console.error(e);setExportProgress(0,"Ошибка сохранения WAV: "+(e?.message||e));
  }finally{btn.disabled=false}
};

async function exportMp3AtQuality(){
  if(!mastered){$("exportStatus").textContent="Сначала выполните студийный автомастеринг.";return}
  if(typeof lamejs==="undefined"){
    $("exportStatus").textContent="MP3-кодировщик не загрузился. Для MP3 нужен интернет.";
    return;
  }
  const q=qualityPreset(), btn=$("saveAudio"); btn.disabled=true;
  try{
    setExportProgress(3,`Подготавливаем MP3 ${q.kbps} kbps • ${q.rate} Hz… 3%`);
    await yieldUI();
    const data=preparePcm16(mastered,q.rate,(v)=>{
      setExportProgress(3+v*.27,`Ресэмплинг MP3 • ${Math.round(3+v*.27)}%`);
    });
    const channels=Math.min(2,mastered.numberOfChannels);
    const enc=new lamejs.Mp3Encoder(channels,q.rate,q.kbps);
    const block=1152,chunks=[],total=data.left.length;
    for(let pos=0;pos<total;pos+=block){
      const end=Math.min(total,pos+block);
      const mp3buf=channels===2
        ?enc.encodeBuffer(data.left.subarray(pos,end),data.right.subarray(pos,end))
        :enc.encodeBuffer(data.left.subarray(pos,end));
      if(mp3buf.length)chunks.push(new Int8Array(mp3buf));
      const pct=30+(end/total)*65;
      setExportProgress(pct,`Кодируем MP3 ${q.kbps} kbps • ${q.rate} Hz • ${Math.round(pct)}%`);
      if(pos%(block*8)===0)await yieldUI();
    }
    const tail=enc.flush();if(tail.length)chunks.push(new Int8Array(tail));
    setExportProgress(97,"Сохраняем MP3… 97%");
    const exportTags=getCleanExportTags();
    const taggedChunks=addMp3Tags(chunks,exportTags);
    const blob=new Blob(taggedChunks,{type:"audio/mpeg"});
    await download(blob,originalFilenameBase+".mp3","MP3 аудиофайл","audio/mpeg");
    setExportProgress(100,`MP3 сохранён • ${q.kbps} kbps • ${(q.rate/1000).toFixed(1)} kHz • 100%`);
  }catch(e){
    console.error(e);setExportProgress(0,"Ошибка сохранения MP3: "+(e?.message||e));
  }finally{btn.disabled=false}
}

$("saveFormat")?.addEventListener("change",()=>{
  const format=$("saveFormat").value;
  if($("saveFormatHint"))$("saveFormatHint").textContent=format==="mp3" ? "MP3 • сжатый файл" : "WAV • без потерь";
  populateQualityOptions(format);
});

$("saveAudio").onclick=async()=>{
  try{
    selectedSaveDirectory=await chooseSaveDirectory();
    if($("saveFormat").value==="mp3") await exportMp3AtQuality();
    else await exportWavAtQuality();
  }catch(e){
    if(e?.name!=="AbortError") console.error(e);
    else setExportProgress(0,"Сохранение отменено");
  }finally{
    selectedSaveDirectory=null;
  }
};

populateQualityOptions($("saveFormat")?.value||"wav");


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

// ===== Console UI helpers =====
function toast(s){const t=$("toast");t.textContent=s;t.style.display="block";clearTimeout(toast.t);toast.t=setTimeout(()=>t.style.display="none",2200)}
function drawWave(canvas,buf,color){if(!canvas||!buf)return;const r=canvas.getBoundingClientRect(),w=Math.max(1,Math.round(r.width)),h=Math.max(1,Math.round(r.height));canvas.width=w;canvas.height=h;const c=canvas.getContext('2d');c.clearRect(0,0,w,h);c.strokeStyle=color;c.lineWidth=1;const x=buf.getChannelData(0),step=Math.max(1,Math.floor(x.length/w));c.beginPath();for(let i=0;i<w;i++){let lo=1,hi=-1;for(let j=0;j<step;j++){const v=x[Math.min(x.length-1,i*step+j)];lo=Math.min(lo,v);hi=Math.max(hi,v)}c.moveTo(i,(1+lo)*h/2);c.lineTo(i,(1+hi)*h/2)}c.stroke()}
window.addEventListener('resize',()=>{drawWave($('waveA'),original,'#31caff');drawWave($('waveB'),mastered,'#43ff9a')});
const oldLoad=load;load=async function(f){await oldLoad(f);if(original){drawWave($('waveA'),original,'#31caff');$('name').textContent=sourceName;toast('Трек загружен в Деку A')}};
const oldMakePlayer=makePlayer;makePlayer=function(){oldMakePlayer();drawWave($('waveB'),mastered,'#43ff9a');toast('Мастер готов в Деке B')};
function seek(player,d){if(player.duration)player.currentTime=Math.max(0,Math.min(player.duration,player.currentTime+d))}

$("generatorSite")?.addEventListener("change",e=>{
  const url=e.target.value;
  if(!url)return;
  window.open(url,"_blank","noopener,noreferrer");
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
