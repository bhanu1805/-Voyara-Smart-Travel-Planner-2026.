// Keyless current weather using Open-Meteo; end users do not need to provide API keys.
async function openWeather(lat,lon){
 if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw new Error('Valid latitude and longitude are required.');
 const u=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto`;
 const r=await fetch(u,{signal:AbortSignal.timeout(12000)}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.reason||`Weather service HTTP ${r.status}`);
 const c=j.current||{},codes={0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',45:'Fog',48:'Fog',51:'Light drizzle',53:'Drizzle',55:'Dense drizzle',61:'Light rain',63:'Rain',65:'Heavy rain',71:'Light snow',73:'Snow',75:'Heavy snow',80:'Rain showers',81:'Rain showers',82:'Heavy rain showers',95:'Thunderstorm',96:'Thunderstorm with hail',99:'Thunderstorm with hail'};
 return {configured:true,source:'Open-Meteo',temperature:c.temperature_2m,feelsLike:c.apparent_temperature,humidity:c.relative_humidity_2m,wind:c.wind_speed_10m,description:codes[c.weather_code]||'Current conditions',updatedAt:c.time||new Date().toISOString(),note:'Live weather; no API key required.'};
}
async function currency(base='INR',target='USD'){
  let u=process.env.EXCHANGERATE_API_KEY?`https://v6.exchangerate-api.com/v6/${process.env.EXCHANGERATE_API_KEY}/pair/${base}/${target}`:`https://open.er-api.com/v6/latest/${base}`;
  const r=await fetch(u); if(!r.ok) throw new Error(`ExchangeRate API ${r.status}`); const j=await r.json();
  const rate=j.conversion_rate || j.rates?.[target]; if(!rate) throw new Error('Currency not supported');
  return {base,target,rate,updated:j.time_last_update_utc||new Date().toISOString()};
}
let amadeusToken=null,amadeusExpires=0;
async function amadeusTokenGet(){
  if(!process.env.AMADEUS_CLIENT_ID||!process.env.AMADEUS_CLIENT_SECRET) return null;
  if(amadeusToken && Date.now()<amadeusExpires) return amadeusToken;
  const body=new URLSearchParams({grant_type:'client_credentials',client_id:process.env.AMADEUS_CLIENT_ID,client_secret:process.env.AMADEUS_CLIENT_SECRET});
  const r=await fetch('https://test.api.amadeus.com/v1/security/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  if(!r.ok) throw new Error(`Amadeus auth ${r.status}`); const j=await r.json(); amadeusToken=j.access_token; amadeusExpires=Date.now()+(j.expires_in-30)*1000; return amadeusToken;
}
async function amadeus(path){const t=await amadeusTokenGet(); if(!t) return {configured:false}; const r=await fetch('https://test.api.amadeus.com'+path,{headers:{Authorization:`Bearer ${t}`}}); if(!r.ok) throw new Error(`Amadeus ${r.status}`); return {configured:true,data:await r.json()};}
async function geminiGenerate(parts,system,opts={}){
  const preferred=process.env.GEMINI_MODEL||'gemini-3.8-flash';
  const models=[...new Set([preferred,'gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-3.5-flash','gemini-3.5-flash-lite'])];
  let lastError;
  for(const model of models){
    for(let attempt=0;attempt<2;attempt++){
      try{
        const body={contents:[{role:'user',parts}],generationConfig:{temperature:opts.temperature??0.5,maxOutputTokens:opts.maxOutputTokens??900}};
        if(system)body.systemInstruction={parts:[{text:system}]};
        if(opts.json)body.generationConfig.responseMimeType='application/json';
        const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(opts.timeout||30000)});
        const j=await r.json().catch(()=>({}));
        if(r.ok){const text=j.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim();if(text)return {text,model};lastError=new Error('Gemini returned an empty response');break;}
        lastError=new Error(`Gemini API ${r.status}: ${j.error?.message||'request failed'}`);
        // Retry temporary overload/rate limits; try another model for unavailable model errors.
        if([429,500,502,503,504].includes(r.status)&&attempt===0){await new Promise(resolve=>setTimeout(resolve,900));continue;}
        if([400,404].includes(r.status)||r.status===503)break;
        break;
      }catch(e){lastError=e;if(attempt===0){await new Promise(resolve=>setTimeout(resolve,500));continue;}break;}
    }
    if(lastError && !/\b(400|404|503|429|500|502|504)\b/.test(lastError.message))break;
  }
  throw lastError||new Error('Gemini service unavailable');
}
async function llm(message,context='',language='English'){
 const system=`You are Voyara, a helpful general-purpose AI assistant in a Smart Travel Planner. Answer general questions as well as travel questions. Reply in ${language}; understand multilingual input. Answer the actual question directly; do not respond with a generic list of capabilities. For how-to questions, give steps. For what/where/when/why/which/how much questions, answer the specific request with practical details. For travel budgets, provide an itemised estimate and label it as an estimate. For multilingual input, answer in the requested language and preserve the meaning of the question. Never claim to have live prices, hotel availability, flight status, current news or weather unless supplied in the context. Label estimates and admit uncertainty.`;
 let geminiError;
 if(process.env.GEMINI_API_KEY){try{return (await geminiGenerate([{text:`Context: ${context}\nQuestion: ${message}`}],system,{temperature:0.6,maxOutputTokens:900})).text;}catch(e){geminiError=e;console.error('[Gemini chatbot fallback]',e.message);}}
 if(process.env.ANTHROPIC_API_KEY){try{const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:process.env.ANTHROPIC_MODEL||'claude-3-5-haiku-latest',max_tokens:900,system,messages:[{role:'user',content:`Context: ${context}\nQuestion: ${message}`}] }),signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`Anthropic API ${r.status}`);const j=await r.json();const answer=j.content?.map(x=>x.text||'').join('').trim();if(answer)return answer;}catch(e){console.error('[Anthropic chatbot fallback]',e.message);}}
 if(geminiError)throw geminiError;
 return null;
}
async function visualDestinationSearch(buffer,mimetype){
 if(!process.env.GEMINI_API_KEY)throw new Error('GEMINI_API_KEY is not configured');
 const prompt='Analyze this travel photo and recommend 5 real destinations in India with similar scenery/architecture. Return ONLY valid JSON with keys visualTags (array of 3-6 short tags), summary (short string), recommendations (array of objects with name, state, reason, similarityPercent integer). Similarity is an approximate model judgment, not a verified measurement. Do not claim the photo depicts a specific place unless certain.';
 const result=await geminiGenerate([{text:prompt},{inline_data:{mime_type:mimetype||'image/jpeg',data:buffer.toString('base64')}}],null,{temperature:0.3,maxOutputTokens:1000,timeout:45000,json:true});
 try{return {configured:true,...JSON.parse(result.text)}}catch{return {configured:true,summary:result.text,recommendations:[]}}
}

module.exports={openWeather,currency,amadeus,llm,visualDestinationSearch};
