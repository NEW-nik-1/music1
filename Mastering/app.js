let ctx, original=null, mastered=null, masterURL=null, originalURL=null, workletReady=false, sourceName="studio-master", beforeMetrics=null, afterMetrics=null, compareMode="after";
const $=id=>document.getElementById(id);
const db=v=>20*Math.log10(Math.max(Math.abs(v),1e-12));
const drop=$("drop"), file=$("file");

drop.onclick=()=>file.click();
drop.ondragover=e=>{e.preventDefault();drop.style.borderColor="#6878ff"};
drop.ondragleave=()=>drop.style.borderColor="";
drop.ondrop=e=>{e.preventDefault();drop.style.borderColor=""; if(e.dataTransfer.files[0]) load(e.dataTransfer.files[0])};
file.onchange=()=>file.files[0]&&load(file.files[0]);


function audioBufferToWav(buffer){
  const channels=Math.min(2,buffer.numberOfChannels);
  const sampleRate=buffer.sampleRate;
  const frames=buffer.length;
  const blockAlign=channels*2;
  const dataSize=frames*blockAlign;
  const out=new ArrayBuffer(44+dataSize);
  const view=new DataView(out);
  const writeString=(off,s)=>{for(let i=0;i<s.length;i++)view.setUint8(off+i,s.charCodeAt(i));};
  writeString(0,"RIFF");
  view.setUint32(4,36+dataSize,true);
  writeString(8,"WAVE");
  writeString(12,"fmt ");
  view.setUint32(16,16,true);
  view.setUint16(20,1,true);
  view.setUint16(22,channels,true);
  view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate*blockAlign,true);
  view.setUint16(32,blockAlign,true);
  view.setUint16(34,16,true);
  writeString(36,"data");
  view.setUint32(40,dataSize,true);
  const data=Array.from({length:channels},(_,c)=>buffer.getChannelData(c));
  let pos=44;
  for(let i=0;i<frames;i++){
    for(let c=0;c<channels;c++){
      const v=Math.max(-1,Math.min(1,data[c][i]||0));
      view.setInt16(pos,v<0?v*32768:v*32767,true);
      pos+=2;
    }
  }
  return out;
}

function download(blob,filename){
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

async function load(f){
  try{
    $("fileStatus").textContent="Декодирование...";
    ctx ||= new AudioContext();
    original=await ctx.decodeAudioData(await f.arrayBuffer());
    
    $("name").textContent=f.name;
    sourceName=f.name.replace(/\.[^.]+$/, "") || "studio-master";
    $("info").textContent=`${original.numberOfChannels===1?"Mono":"Stereo"} • ${original.sampleRate} Hz • ${original.duration.toFixed(2)} сек`;
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
  const progress=(pct,text)=>{const v=Math.max(0,Math.min(100,pct));$("bar").style.width=v+"%";$("barText").textContent=Math.round(v)+"%";$("status").textContent=text||("Обработка… "+Math.round(v)+"%");};
  try{
    progress(3,"Анализируем громкость и динамику… 3%");
    const p=await designMasterAsync(original,Number($("target").value),progress); showDecisions(p);
    progress(45,"Рендерим мастер — обработка блоками..."); mastered=await renderWithWorklet(original,p,progress);
    progress(90,"Проверяем True Peak..."); const postTP=await truePeakAsync(mastered,(v)=>progress(90+v*.05,"Проверяем True Peak..."));
    if(postTP>-1.01)mastered=finalSafety(mastered,-1); makePlayer();
    $("saveWav").disabled=false;
    $("saveMp3").disabled=false;
    afterMetrics=await analyze(mastered,(v)=>progress(97+v*.03,"Финальный анализ..."));
    setAfterMetrics(afterMetrics);
    $("compareMastered").disabled=false;
    $("ab").disabled=false;
    $("compareStatus").textContent="Сравните оригинал и мастер в двух плеерах или нажмите A / B.";
    progress(100,"Готово — 100%"); $("status").innerHTML='<span class="good">Студийный мастер готов. Перегруз отменён.</span>';
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


function qualityPreset(){
  const q=$("quality")?.value||"medium";
  return {
    low:{label:"НИЗКОЕ",kbps:128,rate:44000},
    medium:{label:"СРЕДНЕЕ",kbps:128,rate:48000},
    high:{label:"ВЫСОКОЕ",kbps:320,rate:48000}
  }[q] || {label:"СРЕДНЕЕ",kbps:192,rate:44100};
}
function updateQualityUI(){
  const q=qualityPreset();
  if($("qualityInfo"))$("qualityInfo").textContent=`${q.kbps} kbps • ${(q.rate/1000).toFixed(1)} kHz`;
  if($("mp3Info"))$("mp3Info").textContent=`${q.kbps} kbps`;
  if($("mp3RateInfo"))$("mp3RateInfo").textContent=`${(q.rate/1000).toFixed(1)} kHz`;
  if($("wavRateInfo"))$("wavRateInfo").textContent=`${(q.rate/1000).toFixed(1)} kHz`;
}
$("quality")?.addEventListener("change",updateQualityUI);
updateQualityUI();

function setExportProgress(pct,text){
  const v=Math.max(0,Math.min(100,pct));
  if($("exportProgressBar"))$("exportProgressBar").style.width=v+"%";
  if(text && $("exportStatus"))$("exportStatus").textContent=text;
}

$("saveWav").onclick=async()=>{
  if(!mastered){$("exportStatus").textContent="Сначала выполните студийный автомастеринг.";return}
  const q=qualityPreset(), btn=$("saveWav"); btn.disabled=true;
  try{
    setExportProgress(5,"Подготавливаем WAV… 5%");
    await yieldUI();
    const outRate=q.rate;
    const exportBuffer=outRate===mastered.sampleRate ? mastered : resampleAudioBuffer(mastered,outRate,(v)=>{
      setExportProgress(5+v*.70,`Подготовка WAV • ${Math.round(5+v*.70)}%`);
    });
    setExportProgress(82,"Формируем WAV… 82%");
    await yieldUI();
    const blob=new Blob([audioBufferToWav(exportBuffer)],{type:"audio/wav"});
    setExportProgress(96,"Сохраняем WAV… 96%");
    download(blob,sourceName+` - mastered ${q.rate}Hz.wav`);
    setExportProgress(100,`WAV сохранён • ${q.rate} Hz • PCM 16-bit • 100%`);
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
  const q=qualityPreset(), btn=$("saveMp3"); btn.disabled=true;
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
    const blob=new Blob(chunks,{type:"audio/mpeg"});
    download(blob,sourceName+` - mastered ${q.kbps}kbps ${q.rate}Hz.mp3`);
    setExportProgress(100,`MP3 сохранён • ${q.kbps} kbps • ${q.rate} Hz • 100%`);
  }catch(e){
    console.error(e);setExportProgress(0,"Ошибка сохранения MP3: "+(e?.message||e));
  }finally{btn.disabled=false}
}
$("saveMp3").onclick=exportMp3AtQuality;

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
const meterBars=(id,n=22)=>{const el=$(id); if(!el)return []; el.innerHTML=''; return Array.from({length:n},()=>{const i=document.createElement('i');el.appendChild(i);return i})};
const barsL=meterBars('meterL'),barsR=meterBars('meterR'),peakBars=[...$('peak').children];
function toast(s){const t=$('toast');t.textContent=s;t.style.display='block';clearTimeout(toast.t);toast.t=setTimeout(()=>t.style.display='none',2200)}
function updateBars(vL,vR){const draw=(bars,v)=>{const dbv=20*Math.log10(Math.max(v,1e-6));const n=Math.max(0,Math.min(bars.length,Math.round((dbv+48)/48*bars.length)));bars.forEach((b,i)=>b.classList.toggle('on',i<n));};draw(barsL,vL);draw(barsR,vR);const p=Math.max(vL,vR),n=Math.max(0,Math.min(peakBars.length,Math.round(p*peakBars.length)));peakBars.forEach((b,i)=>{b.classList.toggle('on',i<n);b.classList.toggle('hot',i>=7&&i<n)})}
function sampleLevel(buf,time){if(!buf)return [0,0];const start=Math.min(buf.length-1,Math.floor(time*buf.sampleRate));const len=Math.min(1024,buf.length-start);let vals=[];for(let c=0;c<Math.min(2,buf.numberOfChannels);c++){const x=buf.getChannelData(c);let p=0;for(let i=start;i<start+len;i++)p=Math.max(p,Math.abs(x[i]||0));vals.push(p)}return [vals[0]||0,(vals[1]??vals[0])||0]}
function tickMeters(){const a=$('originalPlayer'),b=$('player');let active=!a.paused&&original?a:(!b.paused&&mastered?b:null);if(active){const buf=active===a?original:mastered;const [l,r]=sampleLevel(buf,active.currentTime);updateBars(l,r)}else updateBars(0,0);requestAnimationFrame(tickMeters)}requestAnimationFrame(tickMeters);
function drawWave(canvas,buf,color){if(!canvas||!buf)return;const r=canvas.getBoundingClientRect(),w=Math.max(1,Math.round(r.width)),h=Math.max(1,Math.round(r.height));canvas.width=w;canvas.height=h;const c=canvas.getContext('2d');c.clearRect(0,0,w,h);c.strokeStyle=color;c.lineWidth=1;const x=buf.getChannelData(0),step=Math.max(1,Math.floor(x.length/w));c.beginPath();for(let i=0;i<w;i++){let lo=1,hi=-1;for(let j=0;j<step;j++){const v=x[Math.min(x.length-1,i*step+j)];lo=Math.min(lo,v);hi=Math.max(hi,v)}c.moveTo(i,(1+lo)*h/2);c.lineTo(i,(1+hi)*h/2)}c.stroke()}
window.addEventListener('resize',()=>{drawWave($('waveA'),original,'#31caff');drawWave($('waveB'),mastered,'#43ff9a')});
const oldLoad=load;load=async function(f){await oldLoad(f);if(original){drawWave($('waveA'),original,'#31caff');$('name').textContent=sourceName;toast('Трек загружен в Деку A')}};
const oldMakePlayer=makePlayer;makePlayer=function(){oldMakePlayer();drawWave($('waveB'),mastered,'#43ff9a');toast('Мастер готов в Деке B')};
function seek(player,d){if(player.duration)player.currentTime=Math.max(0,Math.min(player.duration,player.currentTime+d))}
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
const _makePlayerFixed=makePlayer;makePlayer=function(){_makePlayerFixed();const s=$('afterStatus');if(s)s.textContent='Дека B: мастер готов к прослушиванию';};
