'use strict';
/**
 * Publishes seven-day Open-Meteo forecasts to GitHub Pages.
 * No API calls from iPhones, no secrets, no personal fishing spots uploaded.
 * Geographical coverage: Samara river basin from 52.4–54.2N, 48.7–52.3E.
 */
const fs=require('node:fs');
const path=require('node:path');
const OUT=path.resolve(__dirname,'../data/weather-grid.json');
const MODELS={ecmwf:'ecmwf_ifs025',gfs:'ncep_gfs_global',icon:'icon_global'};
const HOURLY=['temperature_2m','wind_speed_10m','wind_gusts_10m','wind_direction_10m','pressure_msl','precipitation','cloud_cover'];
const DAILY=['sunrise','sunset'];
const PAUSE=ms=>new Promise(r=>setTimeout(r,ms));
const points=[];
for(let y=0;y<=9;y++)for(let x=0;x<=12;x++)points.push({lat:+(52.4+y*.2).toFixed(4),lon:+(48.7+x*.3).toFixed(4)});
function normalized(data){
 if(!data||!Array.isArray(data.hourly?.time)||data.hourly.time.length<48)return null;
 const hourly={time:data.hourly.time};
 for(const field of HOURLY)hourly[field]=Array.isArray(data.hourly[field])?data.hourly[field]:[];
 const daily={time:data.daily?.time||[]};
 for(const field of DAILY)daily[field]=data.daily?.[field]||[];
 return{hourly,daily,updatedAt:new Date().toISOString()};
}
async function group(model,chunk){
 const url=new URL('https://api.open-meteo.com/v1/forecast');
 const pairs={
 latitude:chunk.map(p=>p.lat).join(','),longitude:chunk.map(p=>p.lon).join(','),
 models:model,hourly:HOURLY.join(','),daily:DAILY.join(','),
 timezone:'Europe/Samara',forecast_days:'7',wind_speed_unit:'ms'
 };
 Object.entries(pairs).forEach(([k,v])=>url.searchParams.set(k,String(v)));
 let lastError;
 for(let attempt=0;attempt<3;attempt++){
  try{
   const response=await fetch(url,{signal:AbortSignal.timeout(35000),headers:{'Accept':'application/json'}});
   if(!response.ok)throw Error('HTTP '+response.status+' '+(await response.text()).slice(0,160));
   const json=await response.json(),list=Array.isArray(json)?json:[json];
   if(list.length!==chunk.length)throw Error('API returned '+list.length+' entries, expected '+chunk.length);
   return list.map(normalized);
  }catch(error){lastError=error;console.warn('Open-Meteo '+model+' try '+(attempt+1)+': '+error.message);await PAUSE((attempt+1)*1750)}
 }
 throw lastError;
}
async function main(){
 const now=new Date().toISOString();
 let previous={};try{previous=JSON.parse(fs.readFileSync(OUT,'utf8'))}catch{}
 const result={schema:1,generatedAt:now,region:'Волга, Самара, Сок — район Самары',
  bounds:{south:52.4,north:54.2,west:48.7,east:52.3},step:{lat:.2,lon:.3},
  description:'Model forecasts for nearest grid nodes (not exact saved spots).',points:points.map(p=>({...p})),stats:{},errors:{}};
 for(const [id,api] of Object.entries(MODELS)){
  let success=0;const failures=[];
  for(let offset=0;offset<points.length;offset+=12){
   const chunk=points.slice(offset,offset+12);
   try{
    const data=await group(api,chunk);
    for(let i=0;i<data.length;i++){
     const old=previous.points?.[offset+i]?.[id];
     const value=data[i];
     if(value){result.points[offset+i][id]=value;success++}
     else if(old){result.points[offset+i][id]=old;failures.push('invalid '+offset+' (cached)')}
     else failures.push('invalid '+offset);
    }
   }catch(err){
    failures.push('batch '+offset+': '+err.message);
    for(let i=0;i<chunk.length;i++){
     const old=previous.points?.[offset+i]?.[id];
     if(old)result.points[offset+i][id]=old;
    }
   }
   await PAUSE(280);
  }
  result.stats[id]={updated:success,available:result.points.filter(p=>p[id]).length,expected:points.length};
  if(failures.length)result.errors[id]=failures.slice(0,20);
 }
 if(!Object.values(result.stats).some(s=>s.updated>0)){
  if(fs.existsSync(OUT)){console.error('No fresh model data; preserving previous grid');return}
  console.error('No model data available yet; retaining pending placeholder');return;
 }
 fs.mkdirSync(path.dirname(OUT),{recursive:true});
 fs.writeFileSync(OUT,JSON.stringify(result)+'\n');
 console.log(JSON.stringify({generatedAt:now,gridPoints:points.length,models:result.stats,fileBytes:fs.statSync(OUT).size}));
}
if(require.main===module)main().catch(err=>{console.error(err);process.exitCode=1});
module.exports={normalized,points};
