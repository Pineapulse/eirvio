import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {copyPlainJson} from '../packages/sdk/src/events.mjs';

export const LAB_SCHEMA_VERSION = 1;
export function scenarioSeed(seed, id, round) {
  let value = (seed ^ round) >>> 0;
  for (const character of id) value = Math.imul(value ^ character.charCodeAt(0),16777619) >>> 0;
  return value;
}
export function validateConfig({mode='testing',seed=42,rounds=mode==='learning'?3:1}={}) {
  if (!['testing','learning'].includes(mode) || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
      || !Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('Invalid lab configuration');
  return {mode,seed,rounds};
}
export async function evaluateScenarios(scenarios, adapters, configuration) {
  const config = validateConfig(configuration), results = [];
  if (!Array.isArray(scenarios) || !scenarios.length || new Set(scenarios.map(item=>item.id)).size!==scenarios.length) throw new Error('Invalid scenario catalog');
  for (const scenario of scenarios) {
    if (!/^[a-z][a-z0-9_.-]{1,79}$/.test(scenario.id) || !Number.isInteger(scenario.version) || scenario.version<1
        || typeof scenario.run!=='function') throw new Error('Invalid scenario definition');
    const attempts=[];
    for(let round=0;round<config.rounds;round++) {
      const seed=scenarioSeed(config.seed,scenario.id,round), evidence=[], start=performance.now();
      const record=(label,data={})=>{
        if(typeof label!=='string'||label.length>200||evidence.length>=30)throw new Error('Scenario evidence limit exceeded');
        evidence.push({label,data:copyPlainJson(data,{maxDepth:6,maxBytes:4096,maxNodes:1000})});
      };
      let failure;
      try { await scenario.run({assert,seed,record,...adapters}); }
      catch(error) {failure={code:typeof error?.code==='string'?error.code.slice(0,80):'SCENARIO_FAILED',message:String(error?.message??error).slice(0,800)};}
      attempts.push({seed,status:failure?'failed':'passed',durationMs:Math.round(performance.now()-start),evidence,...(failure?{failure}:{})});
    }
    results.push({id:scenario.id,version:scenario.version,title:scenario.title,kind:scenario.kind,difficulty:scenario.difficulty,
      description:scenario.description,status:attempts.every(attempt=>attempt.status==='passed')?'passed':'failed',attempts});
  }
  const attempts=results.flatMap(result=>result.attempts), passed=attempts.filter(attempt=>attempt.status==='passed').length;
  return {summary:{scenarios:results.length,attempts:attempts.length,passed,failed:attempts.length-passed,passRate:Math.round(10000*passed/attempts.length)/100},scenarios:results};
}
export function compareResults(baseline,candidate) {
  const improvements=[],regressions=[],unresolved=[],stable=[],improvedAttempts=[],regressedAttempts=[];
  const before=new Map(baseline.scenarios.map(scenario=>[scenario.id,scenario]));
  for(const result of candidate.scenarios) {
    const previous=before.get(result.id);
    if(!previous || previous.version!==result.version || previous.attempts.length!==result.attempts.length
        || previous.attempts.some((attempt,index)=>attempt.seed!==result.attempts[index].seed))throw new Error('Baseline and candidate scenarios are not comparable');
    let newFailure=false, remainingFailure=false;
    for(let index=0;index<result.attempts.length;index++) {
      const old=previous.attempts[index],current=result.attempts[index];
      if(old.status==='passed'&&current.status==='failed'){newFailure=true;regressedAttempts.push({scenario:result.id,seed:current.seed});}
      if(old.status==='failed'&&current.status==='passed')improvedAttempts.push({scenario:result.id,seed:current.seed});
      if(old.status==='failed'&&current.status==='failed')remainingFailure=true;
    }
    if(newFailure)regressions.push(result.id);
    if(remainingFailure)unresolved.push(result.id);
    if(previous.status==='failed'&&result.status==='passed')improvements.push(result.id);
    if(previous.status==='passed'&&result.status==='passed')stable.push(result.id);
  }
  if(before.size!==candidate.scenarios.length)throw new Error('Baseline and candidate catalogs differ');
  return {improvements,regressions,unresolved,stable,improvedAttempts,regressedAttempts,
    nextActions:[...regressions.map(id=>({scenario:id,priority:'high',action:'Reproduce the failing seed and fix the regression before release.'})),
      ...unresolved.filter(id=>!regressions.includes(id)).map(id=>({scenario:id,priority:'high',action:'Use the retained failure and evidence to troubleshoot this scenario.'})),
      ...improvements.map(id=>({scenario:id,priority:'normal',action:'Keep this scenario in the release checks.'}))]};
}
