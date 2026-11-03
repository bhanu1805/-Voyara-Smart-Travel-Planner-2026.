const fs=require('fs'),path=require('path');
const EARTH_KM=6371;
const CACHE_FILE=path.join(__dirname,'route-cache.json');
let routeCache={};try{routeCache=JSON.parse(fs.readFileSync(CACHE_FILE,'utf8'))}catch{}
function routeKey(a,b){return [a,b].map(p=>`${Number(p.lat).toFixed(4)},${Number(p.lon).toFixed(4)}`).join('|')}
function saveRouteCache(){try{fs.writeFileSync(CACHE_FILE,JSON.stringify(routeCache))}catch{}}
function haversine(a,b){
  const r=Math.PI/180, dLat=(b.lat-a.lat)*r, dLon=(b.lon-a.lon)*r;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dLon/2)**2;
  const km=2*EARTH_KM*Math.asin(Math.sqrt(x));
  return {distanceKm:km,durationMin:(km/28)*60,mode:'offline-estimate'};
}
async function route(a,b){
  const key=routeKey(a,b),reverse=routeKey(b,a);
  if(process.env.OFFLINE_ROUTING==='true' && routeCache[key]) return {...routeCache[key],mode:'cached-offline-road-route'};
  if(routeCache[key] && process.env.PREFER_CACHED_ROUTES==='true') return {...routeCache[key],mode:'cached-road-route'};
  try{
    const url=`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
    const r=await fetch(url); if(!r.ok) throw new Error('OSRM route failed');
    const j=await r.json(); const x=j.routes?.[0];
    if(!x) throw new Error('No OSRM route');
    const result={distanceKm:x.distance/1000,durationMin:x.duration/60,mode:'OSRM'};routeCache[key]=result;routeCache[reverse]=result;saveRouteCache();return result;
  }catch{if(routeCache[key])return {...routeCache[key],mode:'cached-offline-road-route'};if(routeCache[reverse])return {...routeCache[reverse],mode:'cached-offline-road-route'};return haversine(a,b)}
}
async function optimizePlaces(places,days=1){
  const remaining=[...places].filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));
  const out=[];
  for(let day=1;day<=days;day++){
    if(!remaining.length) break;
    const dayPlaces=[]; let current=remaining.shift(); dayPlaces.push(current); let travel=0; let mode='OSRM';
    while(remaining.length && dayPlaces.length<3){
      let best=0,bestCost=Infinity,bestRoute=null;
      for(let i=0;i<remaining.length;i++){const rr=await route(current,remaining[i]); if(rr.distanceKm<bestCost){bestCost=rr.distanceKm;best=i;bestRoute=rr;}}
      const next=remaining.splice(best,1)[0]; const rr=bestRoute||await route(current,next); travel+=rr.durationMin; if(rr.mode!=='OSRM') mode='offline-estimate'; dayPlaces.push({...next,fromPrevious:rr}); current=next;
    }
    out.push({day,places:dayPlaces,travelMinutes:Math.round(travel),routingMode:mode});
  }
  return out;
}
module.exports={optimizePlaces,route,haversine};
