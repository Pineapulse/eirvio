import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateScenarios,compareResults,validateConfig,scenarioSeed} from '../lab/evaluate.mjs';
import {createLabServers} from '../lab/server.mjs';
const fixture=(run)=>({id:'test.case',version:1,title:'Fixture',kind:'kernel',difficulty:'adversarial',description:'Synthetic runner validation',run});
test('lab records failed assertions honestly and runs each reproducible seed independently',async()=>{
  const seen=[];
  const result=await evaluateScenarios([fixture(({seed,record})=>{seen.push(seed);record('attempt',{seed});assert.fail('deliberate failure');})],{},{mode:'learning',seed:42});
  assert.equal(result.summary.attempts,3);assert.equal(result.summary.failed,3);assert.equal(result.summary.passed,0);
  assert.equal(new Set(seen).size,3);assert.deepEqual(seen,[0,1,2].map(round=>scenarioSeed(42,'test.case',round)));
  assert.equal(result.scenarios[0].attempts[0].failure.code,'ERR_ASSERTION');
});
test('baseline comparison identifies improvements and regressions without treating expected rejections as failures',async()=>{
  const good=await evaluateScenarios([fixture(({assert})=>assert.equal('rejected','rejected'))],{},{seed:42});
  const bad=await evaluateScenarios([fixture(({assert})=>assert.fail('expected demonstration failure'))],{},{seed:42});
  assert.deepEqual(compareResults(bad,good).improvements,['test.case']);assert.deepEqual(compareResults(good,bad).regressions,['test.case']);
  assert.deepEqual(compareResults(bad,bad).unresolved,['test.case']);
  const otherSeed=await evaluateScenarios([fixture(()=>{})],{},{seed:99});
  assert.throws(()=>compareResults(good,otherSeed),/not comparable/);
});
test('lab bounds evidence, rejects unsupported configuration and detaches retained records',async()=>{
  const value={status:'before'};
  const result=await evaluateScenarios([fixture(({record})=>{record('copy',value);value.status='after';record('oversized',{value:'x'.repeat(5000)});})],{},{mode:'testing'});
  assert.equal(result.summary.failed,1);assert.equal(result.scenarios[0].attempts[0].evidence[0].data.status,'before');
  assert.throws(()=>validateConfig({mode:'remote'}));assert.throws(()=>validateConfig({seed:-1}));assert.throws(()=>validateConfig({rounds:100}));
});
test('lab environments expose their own mode and reject cross-origin execution and arbitrary paths',async()=>{
  const labs=createLabServers();
  try {
    for(const mode of ['testing','learning'])await new Promise((resolve,reject)=>{labs[mode].once('error',reject);labs[mode].listen(0,'127.0.0.1',resolve);});
    for(const mode of ['testing','learning']) {
      const origin=`http://127.0.0.1:${labs[mode].address().port}`;
      const state=await(await fetch(origin+'/api/state')).json();assert.equal(state.mode,mode);
      for(const file of ['/','/app.mjs','/styles.css'])assert.equal((await fetch(origin+file)).status,200);
      for(const file of ['/.env','/reports/unknown','/packages/sdk/src/events.mjs'])assert.equal((await fetch(origin+file)).status,404);
      assert.equal((await fetch(origin+'/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"seed":42}'})).status,403);
      assert.equal((await fetch(origin+'/api/run',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:'{"seed":42,"command":"arbitrary"}'})).status,400);
      assert.equal((await fetch(origin+'/api/run',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:'{"seed":-1}'})).status,400);
      assert.equal((await fetch(origin+'/api/run',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:'x'.repeat(2048)})).status,413);
    }
  } finally {await labs.stop();}
});

test('comparison cannot hide a newly failing seed behind another existing failure',()=>{
  const result=statuses=>({scenarios:[{id:'mixed.case',version:1,status:'failed',attempts:statuses.map((status,index)=>({seed:index,status}))}]});
  const comparison=compareResults(result(['failed','passed']),result(['passed','failed']));
  assert.deepEqual(comparison.regressions,['mixed.case']);
  assert.deepEqual(comparison.regressedAttempts,[{scenario:'mixed.case',seed:1}]);
  assert.deepEqual(comparison.improvedAttempts,[{scenario:'mixed.case',seed:0}]);
  assert.deepEqual(comparison.improvements,[]);
});
