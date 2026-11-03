function recommendDestinations({destinations,interests=[],budgetPerDay=Infinity,tripDays=3,history=[]}){
  const wanted=new Set(interests.map(x=>String(x).toLowerCase()));
  return destinations.map(d=>{
    const matches=d.interests.filter(x=>wanted.has(x)).length;
    const budgetPenalty=d.avgDailyCost<=budgetPerDay?1:Math.max(0,1-(d.avgDailyCost-budgetPerDay)/Math.max(budgetPerDay,1));
    const historyBonus=history.includes(d.id)?0.15:0;
    const score=Math.round((matches*25+budgetPenalty*25+historyBonus*10)*100)/100;
    return {...d,score,matchedInterests:matches};
  }).sort((a,b)=>b.score-a.score);
}
module.exports={recommendDestinations};
