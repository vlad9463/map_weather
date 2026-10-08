'use strict';
const fs=require('node:fs');
const path=require('node:path');
const FILE=path.join(__dirname,'../data/volga-samara.json');
const URL_LEVEL='https://www.snt-bugorok.ru/category/01-urovni-vody-v-volge/';
const URL_BACKUP='https://www.snt-bugorok.ru/category/bo-11/';
const URL_TEMP='https://rusoir.com/forecast/water-temperature/samarskoj-oblasti';
const URL_RIS='https://volga.risweb.ru/index.php';
const SAMARA_POST_ZERO_BS=25.00; // Datum of the Samara Volga gauge, in m Baltic height system.

const MONTHS=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const text=s=>String(s).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160|#xA0);/gi,' ').replace(/\s+/g,' ').trim();
const rows=s=>[...s.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>text(m[1])).concat(text(s));
function date(d,m,y){const mm=MONTHS.indexOf(m.toLowerCase()),dt=new Date(Date.UTC(+y,mm,+d));return mm>=0&&dt.getUTCMonth()===mm&&dt.getUTCDate()===+d?dt.toISOString().slice(0,10):null}
function samaraToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Samara',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function level(html){
 for(const s of rows(html)){
  const m=s.match(/(?:^|\s)Самара\s+(2\d[.,]\d{1,3})\s+[+−-]?\d+[.,]?\d*\s+(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(20\d{2})(?=\s|$)/i);
  if(m){const v=+m[1].replace(',','.'),d=date(m[2],m[3],m[4]);if(v>=20&&v<=40&&d)return{value:v,unit:'м БС',observedOn:d,kind:'hydropost',sourceName:'СНТ Бугорок (гидропост Самара)',sourceUrl:URL_LEVEL}}
 }
 throw Error('Значение Самары в м БС не найдено');
}
function backup(html,today){
 for(const s of rows(html)){
  const m=s.match(/(?:^|\s)Самара\s+Волга\s+(\d{2,4})\s+[+−-]?\d+\s+(сегодня|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+20\d{2})(?=\s|$)/i);
  if(m){const v=+m[1],parts=m[2].match(/(\d{1,2})\s+(\S+)\s+(20\d{2})/),d=parts?date(parts[1],parts[2],parts[3]):today;if(v>=50&&v<=1500&&d)return{value:+(SAMARA_POST_ZERO_BS+v/100).toFixed(2),unit:'м БС',observedOn:d,kind:'hydropost',sourceName:'СНТ Бугорок (Самара; перевод см над нулём поста)',sourceUrl:URL_BACKUP,originalValueCm:v,gaugeZeroBS:SAMARA_POST_ZERO_BS}}
 }
 throw Error('Резервная строка Самары не найдена');
}
function risLevel(html){
 for(const row of rows(html)){
  const m=row.match(/(?:^|\s)Самара\s*\(1737(?:[.,]\d+)?\s*км\)\s+(\d{2})\.(\d{2})\.(20\d{2})\s+\d{2}:\d{2}\s+(2\d(?:[.,]\d{1,3}))\s*м(?=\s|$)/i);
  if(!m)continue;
  const iso=m[3]+'-'+m[2]+'-'+m[1],dateValue=new Date(iso+'T00:00:00Z');
  const v=+m[4].replace(',','.');
  if(Number.isFinite(v)&&v>=20&&v<=40&&Number.isFinite(dateValue.valueOf())&&dateValue.toISOString().slice(0,10)===iso){
   return{value:v,unit:'м БС',observedOn:iso,kind:'hydropost',sourceName:'РИС Волжского бассейна · пост Самара 1737 км',sourceUrl:URL_RIS};
  }
 }
 throw Error('РИС не отдал текущую строку гидропоста Самара');
}
function temperature(html,year){
 const m=text(html).match(/Сегодня,?\s+(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{1,2}(?:[.,]\d+)?)\s*°\s*C/i);
 if(!m)throw Error('Региональная оценка температуры не найдена');
 const v=+m[3].replace(',','.'),d=date(m[1],m[2],year);
 if(v>35||!d)throw Error('Некорректная температура или дата');
 return{value:v,unit:'°C',observedOn:d,kind:'regional_forecast',sourceName:'Русоир (расчёт по Самарской области)',sourceUrl:URL_TEMP};
}
async function download(url){
 const response=await fetch(url,{headers:{'User-Agent':'RybTochki/1.0 (non-commercial personal project)','Accept':'text/html'},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('HTTP '+response.status);
 const html=await response.text();
 if(html.length<350||/access denied|request has been denied|captcha/i.test(html.slice(0,4000)))throw Error('Доступ источником ограничен');
 return html;
}
function freshness(r,today){
 if(!r||!Number.isFinite(r.value))return r;
 const days=r.observedOn?Math.round((Date.parse(today+'T00:00:00Z')-Date.parse(r.observedOn+'T00:00:00Z'))/86400000):999;
 return{...r,status:days>=0&&days<=2?'ok':'stale'};
}
async function main(){
 const now=new Date().toISOString(),today=samaraToday();
 let old={};try{old=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch{}
 const result={station:'Волга у Самары / Самарская область',updatedAt:now,level:null,temperature:null,errors:{}};
 // The general gauge table may be one day behind the daily graph.
 // Check all sources and keep the newest observation (never downgrade a newer stored reading).
 const probes=await Promise.allSettled([
  download(URL_LEVEL).then(level),
  download(URL_BACKUP).then(html=>backup(html,today)),
  download(URL_RIS).then(risLevel)
 ]);
 const candidates=[];
 const failures=[];
 for(let i=0;i<probes.length;i++){
  const p=probes[i];
  if(p.status==='fulfilled')candidates.push({...p.value,retrievedAt:now});
  else failures.push(['Bugo mBS','Bugo cm','RIS'][i]+': '+String(p.reason?.message||p.reason));
 }
 // Candidate order gives native mBS values preference on equal dates.
 candidates.sort((a,b)=>b.observedOn.localeCompare(a.observedOn));
 const freshest=candidates[0];
 if(freshest)result.level=freshest;
 if(old.level&&Number.isFinite(old.level.value)&&(!result.level||old.level.observedOn>result.level.observedOn)){
  result.level={...old.level};
 }
 if(!result.level)result.errors.level=failures.join('; ')||'Источники не вернули данных';
 // Maintain a growing chronological time-series. Only genuine newly retrieved
 // observations are appended; a carried-forward result is never a new measurement.
 const historyFile=path.resolve(__dirname,'../data/volga-level-history.json');
 let history={station:'Волга у Самары',unit:'м БС',observations:[]};
 try{history=JSON.parse(fs.readFileSync(historyFile,'utf8'))}catch{}
 if(!Array.isArray(history.observations))history.observations=[];
 const observations=new Map(history.observations.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&Number.isFinite(r.value)).map(r=>[r.date,r]));
 for(const v of candidates){
   if(!/^\d{4}-\d{2}-\d{2}$/.test(v.observedOn)||!Number.isFinite(v.value)||v.unit!=='м БС')continue;
   observations.set(v.observedOn,{date:v.observedOn,value:v.value,sourceName:v.sourceName,sourceUrl:v.sourceUrl,provenance:'automated_source',retrievedAt:now});
 }
 history.observations=[...observations.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-365);
 fs.mkdirSync(path.dirname(historyFile),{recursive:true});
 fs.writeFileSync(historyFile,JSON.stringify(history,null,2)+'\n');
 try{result.temperature={...temperature(await download(URL_TEMP),+today.slice(0,4)),retrievedAt:now}}
 catch(e){result.errors.temperature=String(e.message)}
 for(const field of ['level','temperature']){
  if(!result[field]&&old[field]&&Number.isFinite(old[field].value))result[field]={...old[field],status:'stale',warning:'Источник не ответил'};
  if(result[field])result[field]=freshness(result[field],today);
 }
 fs.mkdirSync(path.dirname(FILE),{recursive:true});fs.writeFileSync(FILE,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({level:result.level,temperature:result.temperature,errors:result.errors},null,2));
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1});
module.exports={level,backup,risLevel,temperature,freshness};
