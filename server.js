require('dotenv').config();
const express=require('express'),path=require('path'),crypto=require('crypto'),bcrypt=require('bcryptjs'),multer=require('multer');
const db=require('./db'); const {destinations}=require('./data/travelData'); const {recommendDestinations}=require('./services/recommendationService'); const {fallback}=require('./services/chatbotService'); const {optimizePlaces}=require('./services/itineraryService'); const {openWeather,currency,amadeus,llm,visualDestinationSearch}=require('./services/apiServices');
const app=express(),PORT=process.env.PORT||3000; app.use(express.json({limit:'5mb'})); app.use(express.static(path.join(__dirname,'public')));
const uploadDir=path.join(__dirname,'uploads'); require('fs').mkdirSync(uploadDir,{recursive:true}); const upload=multer({dest:uploadDir,limits:{fileSize:8*1024*1024}});
const nearbyCache=new Map();
// Indicative local prices (INR/person), not live ticket or menu prices.
function normalizeNearbyCategory(raw){
  const c=String(raw||'').toLowerCase().replace(/[\s-]+/g,'_');
  if(/restaurant|food|eat|fast_food|food_court|ice_cream|cafe|coffee/.test(c)) return /cafe|coffee/.test(c)?'Cafe':'Restaurant';
  if(/museum|theme_park|zoo|aquarium|gallery|attraction|artwork|viewpoint|tourism|historic|monument/.test(c)) return 'Tourist attraction';
  if(/park|garden|nature_reserve|leisure/.test(c)) return 'Park / Garden';
  if(/market|mall|shop|shopping/.test(c)) return 'Market / Shopping';
  if(/hotel|guest_house|hostel|lodging/.test(c)) return 'Accommodation';
  return 'Nearby place';
}
function addNearbyPrice(place){
  const raw=String(place.category||'').toLowerCase(); const category=normalizeNearbyCategory(raw);
  let priceLabel='Price unavailable; check locally',priceMin=0,priceMax=0,priceType='indicative';
  if(category==='Restaurant'){priceMin=120;priceMax=700;priceLabel='₹'+priceMin+'–₹'+priceMax+' / person';priceType='food';}
  else if(category==='Cafe'){priceMin=80;priceMax=400;priceLabel='₹'+priceMin+'–₹'+priceMax+' / person';priceType='food';}
  else if(category==='Tourist attraction'){priceMin=0;priceMax=500;priceLabel='₹0–₹'+priceMax+' entry / person';priceType='entry';}
  else if(category==='Park / Garden'){priceMin=0;priceMax=100;priceLabel='Free–₹'+priceMax+' entry / person';priceType='entry';}
  else if(category==='Market / Shopping'){priceMin=0;priceMax=1000;priceLabel='Free entry; shopping spend varies';priceType='shopping';}
  else if(category==='Accommodation'){priceMin=800;priceMax=5000;priceLabel='₹'+priceMin+'–₹'+priceMax+' / night (estimate)';priceType='stay';}
  return {...place,category,priceMinINR:priceMin,priceMaxINR:priceMax,priceLabel,priceType,priceNote:'Indicative estimate only; actual prices vary by venue and date.'};
}
function auth(req,res,next){const token=req.headers.authorization?.replace('Bearer ',''); if(!token)return res.status(401).json({error:'Login required'}); const s=db.prepare('SELECT * FROM sessions WHERE token=? AND expires_at>?').get(token,Date.now()); if(!s)return res.status(401).json({error:'Session expired'}); req.user=db.prepare('SELECT id,email FROM users WHERE id=?').get(s.user_id); req.token=token; next();}
function isAdmin(req){return req.user?.email===(process.env.ADMIN_EMAIL||'admin@smarttravel.local');}
app.get('/api/destinations',(req,res)=>res.json({destinations}));
app.post('/api/auth/register',(req,res)=>{try{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');if(!email||password.length<6)return res.status(400).json({error:'Valid email and password (6+ chars) required'});const hash=bcrypt.hashSync(password,10);const r=db.prepare('INSERT INTO users(email,password_hash,created_at) VALUES(?,?,?)').run(email,hash,new Date().toISOString());res.json({ok:true,user:{id:r.lastInsertRowid,email}})}catch(e){res.status(400).json({error:'Email already registered'})}});
app.post('/api/auth/login',(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!u||!bcrypt.compareSync(password,u.password_hash))return res.status(401).json({error:'Invalid credentials'});const token=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token,u.id,Date.now()+7*864e5);res.json({token,user:{id:u.id,email:u.email}})});
app.post('/api/auth/logout',auth,(req,res)=>{db.prepare('DELETE FROM sessions WHERE token=?').run(req.token);res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));

app.get('/api/friends',auth,(req,res)=>{const friends=db.prepare(`SELECT u.id,u.email FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END WHERE f.user_a=? OR f.user_b=?`).all(req.user.id,req.user.id,req.user.id);const invites=db.prepare('SELECT id,to_email,status,created_at FROM friend_invites WHERE from_user=? ORDER BY id DESC').all(req.user.id);res.json({friends,invites})});
app.post('/api/friends/invite',auth,(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'Enter a valid email address.'});if(email===req.user.email)return res.status(400).json({error:'You cannot invite yourself.'});const target=db.prepare('SELECT id FROM users WHERE email=?').get(email);if(!target){db.prepare('INSERT INTO friend_invites(from_user,to_email,status,created_at) VALUES(?,?,?,?) ON CONFLICT(from_user,to_email) DO UPDATE SET status=excluded.status,created_at=excluded.created_at').run(req.user.id,email,'pending',new Date().toISOString());return res.json({ok:true,registered:false,message:'Invite saved. Share your app link with this person; they must register with this email to connect.'})}const a=Math.min(req.user.id,target.id),b=Math.max(req.user.id,target.id);if(a===b)return res.status(400).json({error:'Cannot add yourself.'});db.prepare('INSERT OR IGNORE INTO friendships(user_a,user_b,created_at) VALUES(?,?,?)').run(a,b,new Date().toISOString());res.json({ok:true,registered:true,message:'Friend connected. You can now message each other.'})});
app.get('/api/messages/:friendId',auth,(req,res)=>{const friendId=Number(req.params.friendId);const ok=db.prepare('SELECT 1 FROM friendships WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)').get(req.user.id,friendId,friendId,req.user.id);if(!ok)return res.status(403).json({error:'Connect as friends before chatting.'});const messages=db.prepare('SELECT m.id,m.sender_id senderId,m.recipient_id recipientId,m.body,m.created_at createdAt,u.email senderEmail FROM messages m JOIN users u ON u.id=m.sender_id WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY m.id DESC LIMIT 100').all(req.user.id,friendId,friendId,req.user.id).reverse();db.prepare('UPDATE messages SET read_at=? WHERE sender_id=? AND recipient_id=? AND read_at IS NULL').run(new Date().toISOString(),friendId,req.user.id);res.json({messages})});
app.post('/api/messages/:friendId',auth,(req,res)=>{const friendId=Number(req.params.friendId),body=String(req.body.body||'').trim();if(!body||body.length>4000)return res.status(400).json({error:'Message must contain 1–4000 characters.'});const ok=db.prepare('SELECT 1 FROM friendships WHERE (user_a=? AND user_b=?) OR (user_a=? AND user_b=?)').get(req.user.id,friendId,friendId,req.user.id);if(!ok)return res.status(403).json({error:'Connect as friends before chatting.'});const r=db.prepare('INSERT INTO messages(sender_id,recipient_id,body,created_at) VALUES(?,?,?,?)').run(req.user.id,friendId,body,new Date().toISOString());res.json({ok:true,id:r.lastInsertRowid})});

app.post('/api/recommendations',(req,res)=>{res.json({results:recommendDestinations({destinations,interests:req.body.interests||[],budgetPerDay:Number(req.body.budgetPerDay)||Infinity,tripDays:Number(req.body.tripDays)||3,history:[]})})});
app.get('/api/geocode/reverse',async(req,res)=>{try{const {lat,lon}=req.query;const u=`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;const r=await fetch(u,{headers:{'User-Agent':'SmartTravelPlanner-StudentProject/3.0'}});const j=await r.json();res.json({displayName:j.display_name,city:j.address?.city||j.address?.town||j.address?.village||j.address?.state,country:j.address?.country,lat:Number(lat),lon:Number(lon)})}catch(e){res.status(502).json({error:e.message})}});
app.get('/api/nearby',async(req,res)=>{
  const lat=Number(req.query.lat),lon=Number(req.query.lon),radius=Math.min(Math.max(Number(req.query.radius)||5000,500),20000);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return res.status(400).json({error:'Valid location coordinates are required. Click Detect my location first.'});
  const cacheKey=`${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(radius/1000)}`; const cached=nearbyCache.get(cacheKey); if(cached&&Date.now()-cached.at<30*60*1000)return res.json({...cached.data,cached:true});
  // Keep the query focused so public Overpass instances are less likely to time out.
  const q=`[out:json][timeout:18];(nwr(around:${radius},${lat},${lon})[name][tourism~"attraction|museum|viewpoint|gallery|zoo|theme_park|artwork"];nwr(around:${radius},${lat},${lon})[name][amenity~"restaurant|cafe|fast_food|food_court|ice_cream"];nwr(around:${radius},${lat},${lon})[name][leisure~"park|nature_reserve|garden"];nwr(around:${radius},${lat},${lon})[name][shop~"mall|market"];);out center tags 100;`;
  const endpoints=[
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter'
  ];
  let lastError='All public OpenStreetMap place servers are busy. Please retry shortly.';
  for(const endpoint of endpoints){
    // Try POST first; some public mirrors handle GET more reliably during load spikes.
    for(const method of ['POST','GET']){
      try{
        const url=method==='GET'?`${endpoint}?data=${encodeURIComponent(q)}`:endpoint;
        const rr=await fetch(url,{method,headers:{'User-Agent':'VoyaraSmartTravelPlanner/4.2 (educational travel planner)',...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'}:{})},body:method==='POST'?new URLSearchParams({data:q}):undefined,signal:AbortSignal.timeout(8000)});
        if(!rr.ok){lastError=`OpenStreetMap data server returned HTTP ${rr.status}`;continue;}
        const j=await rr.json();
        if(j.remark){lastError='OpenStreetMap query was rate-limited or timed out. Try a smaller radius.';continue;}
        const seen=new Set();
        const places=(j.elements||[]).filter(e=>e.tags?.name).map(e=>addNearbyPrice({id:String(e.id),name:e.tags.name,category:e.tags.tourism||e.tags.amenity||e.tags.leisure||e.tags.shop||'place',lat:Number(e.lat??e.center?.lat),lon:Number(e.lon??e.center?.lon)})).filter(x=>Number.isFinite(x.lat)&&Number.isFinite(x.lon)).filter(x=>{const k=`${x.name.toLowerCase()}|${x.lat.toFixed(4)}|${x.lon.toFixed(4)}`;if(seen.has(k))return false;seen.add(k);return true;});
        const data={places,source:'OpenStreetMap',count:places.length,radius,cached:false}; nearbyCache.set(cacheKey,{at:Date.now(),data}); return res.json(data);
      }catch(e){lastError=e.name==='TimeoutError'?'Nearby search timed out while contacting OpenStreetMap.':`Could not reach OpenStreetMap (${e.message}).`;}
    }
  }
  // Fallback provider: Photon (OpenStreetMap-based) often responds when Overpass is overloaded.
  try {
    const queries=['tourist attraction','restaurant','cafe','park','museum'];
    const found=new Map();
    for(const term of queries){
      try{
        const u=`https://photon.komoot.io/api/?q=${encodeURIComponent(term)}&lat=${lat}&lon=${lon}&limit=12&lang=en`;
        const pr=await fetch(u,{headers:{'User-Agent':'VoyaraSmartTravelPlanner/5.0'},signal:AbortSignal.timeout(4500)});
        if(!pr.ok)continue; const pj=await pr.json();
        for(const f of (pj.features||[])){
          const p=f.properties||{},xy=f.geometry?.coordinates||[]; const plat=Number(xy[1]),plon=Number(xy[0]);
          const name=p.name||p.street||p.locality; if(!name||!Number.isFinite(plat)||!Number.isFinite(plon))continue;
          const rad=6371000, dLat=(plat-lat)*Math.PI/180,dLon=(plon-lon)*Math.PI/180;
          const a=Math.sin(dLat/2)**2+Math.cos(lat*Math.PI/180)*Math.cos(plat*Math.PI/180)*Math.sin(dLon/2)**2;
          const distance=2*rad*Math.asin(Math.min(1,Math.sqrt(a))); if(distance>radius)continue;
          const key=`${name.toLowerCase()}|${plat.toFixed(4)}|${plon.toFixed(4)}`;
          if(!found.has(key))found.set(key,addNearbyPrice({id:`photon-${key}`,name,category:term,lat:plat,lon:plon,distanceMeters:Math.round(distance)}));
        }
      }catch(_e){}
      if(found.size>=15)break;
    }
    if(found.size){
      const places=[...found.values()].sort((a,b)=>a.distanceMeters-b.distanceMeters).slice(0,60);
      const data={places,source:'Photon / OpenStreetMap fallback',count:places.length,radius,cached:false,warning:'Using the backup map provider because the primary place service is busy.'};
      nearbyCache.set(cacheKey,{at:Date.now(),data}); return res.json(data);
    }
  } catch(_e){}
  // Last-resort OSM geocoder search, spatially bounded around the user's coordinates.
  // It is slower/less complete than Overpass, but can still return named places if Overpass and Photon are unavailable.
  try {
    const dLat=radius/111000, dLon=radius/(111000*Math.max(0.2,Math.cos(lat*Math.PI/180)));
    const viewbox=[lon-dLon,lat+dLat,lon+dLon,lat-dLat].join(',');
    const found=new Map();
    for(const term of ['tourist attraction','restaurant','cafe','park','museum','hotel']){
      try {
        const u=`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=10&bounded=1&viewbox=${viewbox}&q=${encodeURIComponent(term)}`;
        const nr=await fetch(u,{headers:{'User-Agent':'VoyaraSmartTravelPlanner/5.1 (travel planner)'},signal:AbortSignal.timeout(5000)});
        if(!nr.ok)continue; const nj=await nr.json();
        for(const p of nj){const plat=Number(p.lat),plon=Number(p.lon),name=p.name||p.display_name?.split(',')[0];if(!name||!Number.isFinite(plat)||!Number.isFinite(plon))continue;
          const rad=6371000,d1=(plat-lat)*Math.PI/180,d2=(plon-lon)*Math.PI/180,a=Math.sin(d1/2)**2+Math.cos(lat*Math.PI/180)*Math.cos(plat*Math.PI/180)*Math.sin(d2/2)**2,dist=2*rad*Math.asin(Math.min(1,Math.sqrt(a)));
          if(dist>radius)continue;const key=`${name.toLowerCase()}|${plat.toFixed(4)}|${plon.toFixed(4)}`;if(!found.has(key))found.set(key,addNearbyPrice({id:`nominatim-${key}`,name,category:term,lat:plat,lon:plon,distanceMeters:Math.round(dist)}));
        }
      } catch(_e){}
      if(found.size>=15)break;
    }
    if(found.size){const places=[...found.values()].sort((a,b)=>a.distanceMeters-b.distanceMeters).slice(0,60);const data={places,source:'OpenStreetMap Nominatim fallback',count:places.length,radius,cached:false,warning:'Using an alternate OpenStreetMap search provider.'};nearbyCache.set(cacheKey,{at:Date.now(),data});return res.json(data);}
  } catch(_e){}
  if(cached)return res.json({...cached.data,cached:true,warning:'Showing cached nearby places because live map data is temporarily unavailable.'});
  res.status(502).json({error:`${lastError} Backup map search also failed. Check your internet connection and retry.`});
});
app.get('/api/route',async(req,res)=>{try{const {fromLat,fromLon,toLat,toLon}=req.query;const r=await fetch(`https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`);const j=await r.json();const x=j.routes?.[0];if(!x)return res.status(404).json({error:'No route'});res.json({distanceKm:x.distance/1000,durationMin:x.duration/60,geometry:x.geometry})}catch(e){res.status(502).json({error:e.message})}});
app.post('/api/weather',async(req,res)=>{try{const {lat,lon}=req.body||{};res.json(await openWeather(Number(lat),Number(lon)))}catch(e){res.status(502).json({error:e.message})}});
app.get('/api/currency',async(req,res)=>{try{res.json(await currency(req.query.base||'INR',req.query.target||'USD'))}catch(e){res.status(502).json({error:e.message})}});
app.post('/api/trips',auth,(req,res)=>{const r=db.prepare('INSERT INTO trips(user_id,destination_id,trip_json,created_at) VALUES(?,?,?,?)').run(req.user.id,req.body.destinationId||null,JSON.stringify(req.body),new Date().toISOString());res.json({id:r.lastInsertRowid})});
app.get('/api/trips',auth,(req,res)=>res.json({trips:db.prepare('SELECT * FROM trips WHERE user_id=? ORDER BY id DESC').all(req.user.id).map(t=>({...t,trip:JSON.parse(t.trip_json)}))}));
app.post('/api/reviews',auth,(req,res)=>{const {placeId,placeName,rating,comment}=req.body;if(!placeId||!placeName||rating<1||rating>5)return res.status(400).json({error:'Place and 1-5 rating required'});db.prepare('INSERT INTO reviews(user_id,place_id,place_name,rating,comment,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,place_id) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,created_at=excluded.created_at').run(req.user.id,placeId,placeName,rating,comment||'',new Date().toISOString());res.json({ok:true})});
app.get('/api/reviews',async(req,res)=>{const rows=db.prepare('SELECT place_id placeId,place_name placeName,ROUND(AVG(rating),1) rating,COUNT(*) count FROM reviews WHERE place_id=? GROUP BY place_id,place_name').get(req.query.placeId);res.json({review:rows||null})});
app.post('/api/itinerary/generate',async(req,res)=>{
  try{
    const destination=String(req.body.destination||'').trim();
    const days=Math.max(1,Math.min(14,Number(req.body.days)||3));
    const budget=Math.max(0,Number(req.body.budget)||0);
    const interests=(req.body.interests||[]).map(x=>String(x).toLowerCase());
    if(!destination) return res.status(400).json({error:'Enter an Indian destination, city or region.'});
    const geo=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(destination)}`,{headers:{'User-Agent':'SmartTravelPlanner-StudentProject/4.0'}});
    if(!geo.ok) throw new Error('Destination search failed');
    const gj=await geo.json();
    if(!gj.length) return res.status(404).json({error:'Could not find that destination in India. Try a city, state, hill station or tourist place.'});
    const center={lat:Number(gj[0].lat),lon:Number(gj[0].lon)};
    const radius=Math.min(25000,Math.max(8000,days*6000));
    const q=`[out:json][timeout:25];(node["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park|hotel"](around:${radius},${center.lat},${center.lon});way["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park|hotel"](around:${radius},${center.lat},${center.lon});node["amenity"~"restaurant|cafe"](around:${radius},${center.lat},${center.lon});way["amenity"~"restaurant|cafe"](around:${radius},${center.lat},${center.lon});node["leisure"~"park|nature_reserve"](around:${radius},${center.lat},${center.lon}););out center 180;`;
    let places=[];
    try{
      const rr=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',headers:{'Content-Type':'text/plain','User-Agent':'SmartTravelPlanner-StudentProject/4.0'},body:q});
      const oj=await rr.json();
      places=(oj.elements||[]).filter(e=>e.tags?.name).map(e=>({id:String(e.id),name:e.tags.name,category:e.tags.tourism||e.tags.amenity||e.tags.leisure||'place',lat:e.lat??e.center?.lat,lon:e.lon??e.center?.lon})).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));
    }catch{}
    const wanted=new Set(interests);
    const scored=places.map(p=>{let score=0; const c=p.category; if(wanted.has('food')&&['restaurant','cafe'].includes(c))score+=5; if(wanted.has('nature')&&['park','nature_reserve','viewpoint'].includes(c))score+=5; if(wanted.has('culture')&&['museum','attraction','gallery'].includes(c))score+=5; if(wanted.has('history')&&['museum','attraction'].includes(c))score+=3; if(wanted.has('adventure')&&['viewpoint','theme_park'].includes(c))score+=3; if(wanted.has('relaxation')&&['park','viewpoint'].includes(c))score+=2; return {...p,score};}).sort((a,b)=>b.score-a.score);
    const selected=[]; const used=new Set();
    const target=Math.min(Math.max(days*3,6),Math.min(places.length,days*4));
    for(const p of scored){ if(selected.length>=target) break; if(!used.has(p.name.toLowerCase())){used.add(p.name.toLowerCase());selected.push(p);} }
    if(!selected.length) return res.json({destination:gj[0].display_name,days,budget,warning:'No named attractions were found nearby. Try a larger destination/region name.',itinerary:[]});
    const routePlan=await optimizePlaces(selected,days);
    const perDayBudget=budget?budget/days:0;
    const stayTotal=budget?Math.round(budget*0.30):0, foodTotal=budget?Math.round(budget*0.20):0, transportTotal=budget?Math.round(budget*0.20):0, activityTotal=budget?Math.round(budget*0.15):0, miscTotal=budget?Math.round(budget*0.15):0;
    const dayItinerary=routePlan.map(d=>{
      const dayFood=Math.round(foodTotal/days), dayStay=Math.round(stayTotal/days), dayTransport=Math.round(transportTotal/days), dayActivity=Math.round(activityTotal/days), dayMisc=Math.round(miscTotal/days);
      const activities=d.places.filter(p=>!['restaurant','cafe','hotel'].includes(p.category));
      const food=d.places.find(p=>['restaurant','cafe'].includes(p.category));
      const total=dayFood+dayStay+dayTransport+dayActivity+dayMisc;
      return {day:d.day,routingMode:d.routingMode,travelMinutes:d.travelMinutes,stops:d.places, schedule:[
        {time:'08:00',type:'stay',title:'Breakfast / start from stay',cost:Math.round(dayFood*.25)},
        ...activities.map((p,i)=>({time:['10:00','12:00','15:00','17:30'][i]||'18:30',type:'visit',title:p.name,category:p.category,cost:Math.round(dayActivity/Math.max(activities.length,1))})),
        ...(food?[{time:'13:00',type:'food',title:`Lunch at ${food.name}`,cost:Math.round(dayFood*.75)}]:[{time:'13:00',type:'food',title:'Local lunch near the planned route',cost:Math.round(dayFood*.75)}]),
        {time:'20:00',type:'stay',title:'Stay / accommodation',cost:dayStay},
        {time:'21:00',type:'misc',title:'Local travel & miscellaneous buffer',cost:dayTransport+dayMisc}
      ],estimatedTotal:total};
    });
    res.json({destination:gj[0].display_name,center,days,budget,perDayBudget:Math.round(perDayBudget),budgetBreakdown:{stay:stayTotal,food:foodTotal,transport:transportTotal,activities:activityTotal,misc: miscTotal},itinerary:dayItinerary,offlineRoutingSupported:true,note:'Place data and live road routing use OpenStreetMap/OSRM when online. If OSRM is unavailable, the itinerary falls back to coordinate-based travel-time estimates.'});
  }catch(e){res.status(502).json({error:e.message})}
});

app.post('/api/itinerary/optimize',async(req,res)=>{try{res.json({itinerary:await optimizePlaces(req.body.places||[],Number(req.body.days)||1)})}catch(e){res.status(502).json({error:e.message})}});
app.post('/api/group-trip',auth,(req,res)=>{const members=req.body.members||[];if(!members.length)return res.status(400).json({error:'Add group members'});const scored=destinations.map(d=>{let total=0;for(const m of members){const ints=new Set((m.interests||[]).map(x=>x.toLowerCase()));const match=d.interests.filter(x=>ints.has(x)).length;const budget=Number(m.budgetPerDay)||Infinity;total+=match*30+(d.avgDailyCost<=budget?30:Math.max(0,30-(d.avgDailyCost-budget)/Math.max(budget,1)*30));}return {...d,groupScore:Math.round(total/members.length*100)/100};}).sort((a,b)=>b.groupScore-a.groupScore);res.json({results:scored})});
function detectReplyLanguage(message,selected='English') {
  const text=String(message||'');
  // Distinguish common Marathi wording before generic Devanagari script detection.
  if(/\b(आहे|कसे|कशी|करायचे|महाराष्ट्र|गोव्याच्या|सहलीचे|किती)\b/.test(text)) return 'Marathi';
  // Prefer script detection so users do not have to change the language menu before every question.
  if(/[\u0C80-\u0CFF]/.test(text)) return 'Kannada';
  if(/[\u0900-\u097F]/.test(text)) return 'Hindi';
  if(/[\u0B80-\u0BFF]/.test(text)) return 'Tamil';
  if(/[\u0C00-\u0C7F]/.test(text)) return 'Telugu';
  if(/[\u0A80-\u0AFF]/.test(text)) return 'Gujarati';
  if(/[\u0980-\u09FF]/.test(text)) return 'Bengali';
  if(/[\u0D00-\u0D7F]/.test(text)) return 'Malayalam';
  if(/[\u0900-\u097F]/.test(text) && /गोवा|मौसम/.test(text)) return 'Hindi';
  return ['English','Hindi','Kannada','Marathi','Tamil','Telugu'].includes(selected)?selected:'English';
}
const WEATHER_CITY_COORDS={
 'Goa':[15.2993,74.1240],'Bengaluru':[12.9716,77.5946],'Mumbai':[19.0760,72.8777],'Delhi':[28.6139,77.2090],
 'Jaipur':[26.9124,75.7873],'Mysuru':[12.2958,76.6394],'Pune':[18.5204,73.8567],'Manali':[32.2432,77.1892],
 'Hyderabad':[17.3850,78.4867],'Chennai':[13.0827,80.2707],'Kolkata':[22.5726,88.3639],'Hosapete':[15.2695,76.3871],
 'Hampi':[15.3350,76.4600],'Belagavi':[15.8497,74.4977],'Gokarna':[14.5479,74.3188],'Kerala':[10.8505,76.2711],
 'Mangaluru':[12.9141,74.8560],'Ooty':[11.4102,76.6950],'Coorg':[12.3375,75.8069],'Agra':[27.1767,78.0081]
};
app.post('/api/chatbot',async(req,res)=>{
  const message=String(req.body.message||'');
  const language=detectReplyLanguage(message,String(req.body.language||'English'));
  try{
    // Weather questions should call the real weather API, not just return a generic chatbot sentence.
    const weatherIntent=/(weather|temperature|forecast|मौसम|हवामान|ಹವಾಮಾನ|ವಾತಾವರಣ|வானிலை|வானிலை|వాతావరణ)/i.test(message);
    let weatherContext=null;
    if(weatherIntent){
      let lat=Number(req.body.location?.lat),lon=Number(req.body.location?.lon),place='your current location';
      // Resolve common multilingual city mentions first; then try Nominatim for other city names.
      const cityAliases=[
        [/goa|गोवा|ಗೋವಾ|गोव्यात|கோவா|గోవా/i,'Goa'],[/bengaluru|bangalore|ಬೆಂಗಳೂರು|बेंगलुरु|பெங்களூரு|బెంగళూరు/i,'Bengaluru'],
        [/mumbai|मुंबई|ಮುಂಬೈ|மும்பை|ముంబై/i,'Mumbai'],[/delhi|दिल्ली|ದೆಹಲಿ|டெல்லி|ఢిల్లీ/i,'Delhi'],
        [/jaipur|जयपुर|ಜೈಪುರ|ஜெய்ப்பூர்|జైపూర్/i,'Jaipur'],[/mysuru|mysore|ಮೈಸೂರು|मैसूर|மைசூர்|మైసూరు/i,'Mysuru'],
        [/pune|पुणे|ಪುಣೆ|புனே|పుణె/i,'Pune'],[/manali|मनाली|ಮನಾಲಿ|மணாலி|మనాలి/i,'Manali'],
        [/hyderabad|హైదరాబాద్|హೈದರాబాద్|हैदराबाद|ஹைதராபாத்/i,'Hyderabad'],[/chennai|चेन्नई|ಚೆನ್ನೈ|சென்னை|చెన్నై/i,'Chennai'],
        [/kolkata|कोलकाता|ಕೋಲ್ಕತ್ತಾ|கொல்கத்தா|కోల్‌కతా/i,'Kolkata'],[/hosapete|hospet|ಹೊಸಪೇಟೆ|होसपेटे/i,'Hosapete'],[/hampi|ಹಂಪಿ|हंपी|ஹம்பி|హంపి/i,'Hampi'],[/belagavi|belgaum|ಬೆಳಗಾವಿ|बेळगाव|ಬೆಳಗಾವಿ/i,'Belagavi'],[/gokarna|ಗೋಕರ್ಣ|गोकर्ण|கோகರ್ಣம்/i,'Gokarna'],[/kerala|ಕೇರಳ|केरल|கேரளா|కేరళ/i,'Kerala'],[/mangaluru|mangalore|ಮಂಗಳೂರು|मंगलुरु|மங்களூர்/i,'Mangaluru'],[/ooty|ஊட்டி|ಊಟಿ|ऊटी/i,'Ooty'],[/coorg|kodagu|ಕೊಡಗು|कूर्ग/i,'Coorg'],[/agra|आगरा|ಆಗ್ರಾ|ஆக்ரா/i,'Agra']
      ];
      const alias=cityAliases.find(([re])=>re.test(message));
      let query=alias?.[1]||'';
      if(!query){
        const match=message.match(/(?:weather|temperature|forecast)\s+(?:in|at|for)\s+(.+?)\s*$/i);
        if(match)query=match[1].replace(/[?!.,]+$/,'').trim();
      }
      if(query && WEATHER_CITY_COORDS[query]) { [lat,lon]=WEATHER_CITY_COORDS[query]; place=query; }
      if(query && !WEATHER_CITY_COORDS[query] && !/^(my location|here|current location)$/i.test(query)){
        try {
          const gr=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(query)}`,{headers:{'User-Agent':'VoyaraSmartTravelPlanner/5.0 (travel planner)'},signal:AbortSignal.timeout(7000)});
          const gj=await gr.json();
          if(gj[0]){lat=Number(gj[0].lat);lon=Number(gj[0].lon);place=gj[0].display_name?.split(',').slice(0,2).join(',')||query;}
          else if(alias){const coords={'Goa':[15.2993,74.1240],'Bengaluru':[12.9716,77.5946],'Mumbai':[19.0760,72.8777],'Delhi':[28.6139,77.2090],'Jaipur':[26.9124,75.7873],'Mysuru':[12.2958,76.6394],'Pune':[18.5204,73.8567],'Manali':[32.2432,77.1892],'Hyderabad':[17.3850,78.4867],'Chennai':[13.0827,80.2707],'Kolkata':[22.5726,88.3639],'Hosapete':[15.2695,76.3871]}; [lat,lon]=coords[query];place=query;}
        } catch(_e) { if(alias){ const coords={'Goa':[15.2993,74.1240],'Bengaluru':[12.9716,77.5946],'Mumbai':[19.0760,72.8777],'Delhi':[28.6139,77.2090],'Jaipur':[26.9124,75.7873],'Mysuru':[12.2958,76.6394],'Pune':[18.5204,73.8567],'Manali':[32.2432,77.1892],'Hyderabad':[17.3850,78.4867],'Chennai':[13.0827,80.2707],'Kolkata':[22.5726,88.3639],'Hosapete':[15.2695,76.3871]}; [lat,lon]=coords[query]; place=query; } }
      }
      if(Number.isFinite(lat)&&Number.isFinite(lon)){
        const weatherData=await openWeather(lat,lon,req.body.apiKey);
        weatherContext={place,...weatherData};
      } else {
        weatherContext={error:'Detect your location or include a city, for example: weather in Jaipur.'};
      }
    }
    const context={...(req.body.context||{}),...(weatherContext?{liveWeather:weatherContext}:{})};
    let ai=null; try{ai=await llm(message,JSON.stringify(context),language)}catch(e){console.error('[Voyara AI temporarily unavailable]',e.message)}
    if(ai)return res.json({reply:ai,language,mode:'AI',weather:weatherContext||undefined});
    if(weatherContext && !weatherContext.error){
      const t=weatherContext.temperature,desc=weatherContext.description||'conditions unavailable',humidity=weatherContext.humidity;
      const localized={English:`Current weather for ${weatherContext.place}: ${t}°C, ${desc}, humidity ${humidity}%. This is live Open-Meteo data.`,Hindi:`${weatherContext.place} का वर्तमान मौसम: ${t}°C, ${desc}, आर्द्रता ${humidity}%. यह लाइव Open-Meteo डेटा है।`,Kannada:`${weatherContext.place} ಪ್ರಸ್ತುತ ಹವಾಮಾನ: ${t}°C, ${desc}, ಆರ್ದ್ರತೆ ${humidity}%. ಇದು ಲೈವ್ Open-Meteo ಡೇಟಾ.`,Marathi:`${weatherContext.place} येथील सध्याचे हवामान: ${t}°C, ${desc}, आर्द्रता ${humidity}%. हा थेट OpenWeather डेटा आहे.`,Tamil:`${weatherContext.place} தற்போதைய வானிலை: ${t}°C, ${desc}, ஈரப்பதம் ${humidity}%. இது நேரடி Open-Meteo தரவு.`,Telugu:`${weatherContext.place} ప్రస్తుత వాతావరణం: ${t}°C, ${desc}, తేమ ${humidity}%. ఇది ప్రత్యక్ష Open-Meteo డేటా.`};
      return res.json({reply:localized[language]||localized.English,language,mode:'live-weather',weather:weatherContext});
    }
    if(weatherContext?.error){const localized={English:weatherContext.error,Hindi:`${weatherContext.error} (कृपया Live Weather कार्ड में API key सेट करें।)`,Kannada:`${weatherContext.error} (Live Weather ಕಾರ್ಡ್‌ನಲ್ಲಿ API key ಹೊಂದಿಸಿ.)`,Marathi:`${weatherContext.error} (Live Weather कार्डमध्ये API key सेट करा.)`,Tamil:`${weatherContext.error} (Live Weather பகுதியில் API key அமைக்கவும்.)`,Telugu:`${weatherContext.error} (Live Weather కార్డ్‌లో API key సెట్ చేయండి.)`};return res.json({reply:localized[language]||localized.English,language,mode:'fallback',fallback:true});}
    return res.json({reply:fallback(message,language),language,mode:'fallback',fallback:true});
  }catch(e){
    console.error('[Voyara chatbot]',e.message);
    const hasAI=!!(process.env.GEMINI_API_KEY||process.env.ANTHROPIC_API_KEY);
    const isWeather=/weather|temperature|forecast|मौसम|हवामान|ಹವಾಮಾನ|ವಾತಾವರಣ|வானிலை|వాతావరణ/i.test(message);
    const weatherFallback={English:'I could not retrieve live weather just now. Try the Live Weather card, or ask “weather in Goa” again in a moment.',Hindi:'अभी लाइव मौसम नहीं मिल पाया। कृपया थोड़ी देर बाद फिर कोशिश करें या Live Weather विकल्प चुनें।',Kannada:'ಈಗ ಲೈವ್ ಹವಾಮಾನ ಪಡೆಯಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ. ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ ಅಥವಾ Live Weather ಆಯ್ಕೆಯನ್ನು ಬಳಸಿ.',Marathi:'आत्ता थेट हवामान मिळू शकले नाही. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा किंवा Live Weather पर्याय वापरा.',Tamil:'இப்போது நேரடி வானிலையைப் பெற முடியவில்லை. சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும் அல்லது Live Weather விருப்பத்தைப் பயன்படுத்தவும்.',Telugu:'ప్రస్తుతం లైవ్ వాతావరణాన్ని పొందలేకపోయాను. కొద్దిసేపటి తర్వాత మళ్లీ ప్రయత్నించండి లేదా Live Weather ఎంపికను ఉపయోగించండి.'};
    const msgText=isWeather?(weatherFallback[language]||weatherFallback.English):fallback(message,language);
    return res.json({reply:msgText,language,mode:'fallback',fallback:true,note:'The AI provider is temporarily unavailable; this built-in fallback keeps the chat usable. Try again shortly for a full AI answer.'});
  }
});
app.get('/api/bookings/hotels',async(req,res)=>{
 const {cityCode='',checkInDate='',checkOutDate='',adults=1}=req.query;
 if(!cityCode||!checkInDate||!checkOutDate)return res.status(400).json({error:'Enter a destination and check-in/check-out dates.'});
 if(checkOutDate<=checkInDate)return res.status(400).json({error:'Check-out date must be after check-in date.'});
 const searchUrl=`https://www.booking.com/searchresults.html?ss=${encodeURIComponent(cityCode)}&checkin=${encodeURIComponent(checkInDate)}&checkout=${encodeURIComponent(checkOutDate)}&group_adults=${encodeURIComponent(adults)}`;
 const googleUrl=`https://www.google.com/travel/hotels?q=${encodeURIComponent(cityCode)}`;
 try{
  const code=String(cityCode).trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(code))return res.json({configured:false,searchUrl,googleUrl,message:'Opening live hotel search. Amadeus direct search requires a 3-letter city code.'});
  const found=await amadeus(`/v1/reference-data/locations/hotels/by-city?cityCode=${encodeURIComponent(code)}&radius=20&radiusUnit=KM&hotelSource=ALL`);
  if(!found.configured)return res.json({configured:false,searchUrl,googleUrl,message:'Amadeus is not configured; use live hotel search links.'});
  const ids=(found.data?.data||[]).slice(0,10).map(x=>x.hotelId).filter(Boolean);
  if(!ids.length)return res.json({configured:true,data:{data:[]},searchUrl,googleUrl,message:'No hotels found in Amadeus test inventory; use live hotel search links.'});
  const offers=await amadeus(`/v3/shopping/hotel-offers?hotelIds=${ids.join(',')}&checkInDate=${checkInDate}&checkOutDate=${checkOutDate}&adults=${Math.max(1,Number(adults)||1)}`);
  res.json({...offers,searchUrl,googleUrl});
 }catch(e){res.json({configured:false,searchUrl,googleUrl,message:`Amadeus unavailable (${e.message}); use live hotel search links.`})}
});
app.get('/api/bookings/flights',async(req,res)=>{
 const origin=String(req.query.origin||'').trim().toUpperCase(),destination=String(req.query.destination||'').trim().toUpperCase(),departureDate=String(req.query.departureDate||'');
 if(!origin||!destination||!departureDate)return res.status(400).json({error:'Enter origin, destination and departure date.'});
 const searchUrl=`https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${origin} to ${destination} on ${departureDate}`)}`;
 try{
  if(!/^[A-Z]{3}$/.test(origin)||!/^[A-Z]{3}$/.test(destination))return res.json({configured:false,searchUrl,message:'Opening flight search. For Amadeus direct offers, use 3-letter airport codes such as BLR and GOI.'});
  const q=new URLSearchParams({originLocationCode:origin,destinationLocationCode:destination,departureDate,adults:String(req.query.adults||1),max:'10'});
  const j=await amadeus('/v2/shopping/flight-offers?'+q);
  if(!j.configured)return res.json({configured:false,searchUrl,message:'Amadeus is not configured; use live flight search.'});
  res.json({...j,searchUrl});
 }catch(e){res.json({configured:false,searchUrl,message:`Amadeus unavailable (${e.message}); use live flight search.`})}
});
app.get('/api/flight-status',async(req,res)=>{try{const carrierCode=String(req.query.carrierCode||'').toUpperCase(),flightNumber=String(req.query.flightNumber||''),scheduledDepartureDate=String(req.query.scheduledDepartureDate||'');if(!/^[A-Z0-9]{2}$/.test(carrierCode)||!flightNumber||!scheduledDepartureDate)return res.status(400).json({error:'Enter a 2-character airline code, flight number and departure date.'});const q=new URLSearchParams({carrierCode,flightNumber,scheduledDepartureDate});const j=await amadeus('/v2/schedule/flights?'+q);if(!j.configured)return res.status(503).json({error:'Live flight status is not connected. Add Amadeus Client ID and Client Secret to .env, then restart the server.'});res.json(j)}catch(e){res.status(502).json({error:e.message})}});
app.post('/api/photo-search',upload.single('photo'),async(req,res)=>{
 if(!req.file)return res.status(400).json({error:'Upload a photo'});
 try{
  const buffer=require('fs').readFileSync(req.file.path);
  try{const result=await visualDestinationSearch(buffer,req.file.mimetype);return res.json(result)}
  catch(e){
   console.error('[Photo matching fallback]',e.message);
   const fileName=String(req.file.originalname||'').toLowerCase();
   let tag='scenic landscapes',summary='AI image analysis is temporarily busy. These are backup suggestions; they are not confirmed visual matches.',list;
   if(/beach|sea|coast|ocean|island|baia|sand/.test(fileName)){tag='beach, turquoise water, coastal cliffs';list=[['Palolem Beach','Goa','Relaxed beach and palm-lined coastline',84],['Varkala Cliff','Kerala','Cliffside views over the Arabian Sea',81],['Radhanagar Beach','Andaman and Nicobar Islands','Clear water and pale sandy shoreline',80],['Marari Beach','Kerala','Quiet tropical beach scenery',77],['Kovalam Beach','Kerala','Curved shoreline and coastal viewpoints',75]];}
   else if(/mountain|hill|snow|valley/.test(fileName)){tag='mountains, hills, valleys';list=[['Manali','Himachal Pradesh','Mountain valley scenery',84],['Gulmarg','Jammu and Kashmir','Alpine meadows and mountain views',82],['Munnar','Kerala','Green hills and tea-covered slopes',80],['Darjeeling','West Bengal','Himalayan viewpoints and tea gardens',78],['Coorg','Karnataka','Lush green hills and forest scenery',76]];}
   else if(/temple|palace|fort|historic|architecture/.test(fileName)){tag='heritage architecture, historic sites';list=[['Hampi','Karnataka','Historic stone architecture and dramatic ruins',84],['Jaipur','Rajasthan','Forts, palaces and heritage architecture',82],['Mysuru Palace','Karnataka','Ornate royal architecture',80],['Khajuraho','Madhya Pradesh','Historic temple architecture',78],['Udaipur','Rajasthan','Palaces and lakeside heritage',76]];}
   else {list=[['Munnar','Kerala','Lush green hills and scenic viewpoints',78],['Coorg','Karnataka','Forests, hills and waterfalls',77],['Udaipur','Rajasthan','Lake and palace scenery',76],['Hampi','Karnataka','Distinctive historic landscape',74],['Darjeeling','West Bengal','Mountain and tea-garden views',73]];}
   return res.json({configured:true,fallback:true,summary:`${summary} Filename-based hint: ${tag}.`,visualTags:tag.split(', '),recommendations:list.map(([name,state,reason,similarityPercent])=>({name,state,reason,similarityPercent}))});
  }
 }catch(e){res.status(500).json({error:e.message})}
 finally{require('fs').promises.unlink(req.file.path).catch(()=>{})}
});
app.get('/api/admin/reviews',auth,(req,res)=>{if(!isAdmin(req))return res.status(403).json({error:'Admin only'});const reviews=db.prepare('SELECT r.id,r.place_name placeName,r.rating,r.comment,r.created_at createdAt,u.email FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 200').all();res.json({reviews})});
app.get('/api/admin/analytics',auth,(req,res)=>{if(!isAdmin(req))return res.status(403).json({error:'Admin only'});const totalUsers=db.prepare('SELECT COUNT(*) n FROM users').get().n,totalTrips=db.prepare('SELECT COUNT(*) n FROM trips').get().n,avgBudget=db.prepare("SELECT AVG(json_extract(trip_json,'$.budgetPerDay')) n FROM trips").get().n,popular=db.prepare('SELECT destination_id id,COUNT(*) n FROM trips GROUP BY destination_id ORDER BY n DESC LIMIT 10').all();res.json({totalUsers,totalTrips,avgBudget:Math.round(avgBudget||0),popular})});
app.get('/api/health',(req,res)=>res.json({ok:true,port:PORT,aiConfigured:!!(process.env.GEMINI_API_KEY||process.env.ANTHROPIC_API_KEY),geminiModel:process.env.GEMINI_MODEL||'gemini-3.8-flash',weatherProvider:'Open-Meteo',nearbyProvider:'OpenStreetMap/Overpass + Photon + Nominatim'}));
app.get('/api/config',(req,res)=>res.json({features:{weather:true,currency:true,llm:!!(process.env.GEMINI_API_KEY||process.env.ANTHROPIC_API_KEY),booking:!!(process.env.AMADEUS_CLIENT_ID&&process.env.AMADEUS_CLIENT_SECRET),photo:true,pwa:true}}));
app.get(/^(?!\/api).*/,(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`Smart Travel Planner v3 running at http://localhost:${PORT}`));
