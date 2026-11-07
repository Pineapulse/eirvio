import {Registry,DomainError} from '../src/index.mjs';
export function counterRegistry() {
  return new Registry().register({ruleset:'toy.counter',rulesVersion:'1',stateSchemaVersion:'1',
    validateState:s=>Object.keys(s).length===1 && Number.isInteger(s.value) && s.value>=0 && s.value<=100,
    operations:{'counter.add':{
      validate:a=>Object.keys(a).length===1 && Number.isInteger(a.amount) && Math.abs(a.amount)<=10,
      apply:(s,a)=>{ const value=s.value+a.amount; if(value<0 || value>100) throw new DomainError('RULE_VIOLATION'); return {state:{value},result:{value}}; }
    }},project:s=>({value:s.value})
  }).registerEffect('toy.show',p=>typeof p.label==='string' && p.label.length<=200);
}
export function makeSpec() { return {runtimeId:'toy-runtime',runtimeFence:'fence-1',scenes:[{sceneId:'main',kind:'canonical',ruleset:'toy.counter',rulesVersion:'1',stateSchemaVersion:'1',sceneRevision:0,state:{value:0}}],scopes:['coach','learner'],views:[{viewId:'board',viewEpoch:0,interactionRevision:0,sceneId:'main'}]}; }
