import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurfaceAdapter} from '../src/surface.mjs';
import {InteractionValidationError} from '../src/events.mjs';
function fixture(options={}) {
  const state={name:'Save',enabled:true,x:0,count:0};
  const adapter=createSurfaceAdapter({kind:'website',adapterId:'test-lifetime',
    sample:()=>({targets:[{ref:'button-1',role:'button',name:state.name,state:{enabled:state.enabled},sample:{x:state.x},actions:state.enabled?['click']:[]}]}),
    execute:()=>{state.count++;return {status:'dispatched'};},...options});
  const request=(id='one')=>{const view=adapter.observe();return {adapterId:view.adapterId,id,revision:view.revision,target:'button-1',action:'click',arguments:{}};};
  return {adapter,state,request};
}
test('surface discovers tools, dispatches once, and returns detached receipts',()=>{
  const {adapter,state,request}=fixture(), command=request();
  const first=adapter.callTool('surface_act',command);
  assert.equal(first.status,'dispatched'); first.status='corrupted';
  assert.equal(adapter.act(command).status,'dispatched');assert.equal(state.count,1);
  assert.equal(adapter.getOutcome(command.id).status,'dispatched');
  assert.equal(adapter.callTool('surface_get_outcome',{id:'missing'}),null);
  assert.equal(adapter.tools.length,3); adapter.tools[0].name='bad';assert.equal(adapter.tools[0].name,'surface_observe');
  assert.equal(adapter.callTool('surface_observe',{}).targets[0].name,'Save');
});
test('synchronous semantic changes invalidate old observations while pose samples do not',()=>{
  const {adapter,state,request}=fixture();const old=request();state.x=100;
  assert.equal(adapter.observe().revision,old.revision);
  state.name='Delete';assert.equal(adapter.act(old).code,'STALE_SURFACE');assert.equal(state.count,0);
});
test('changed IDs never replay and receipt capacity does not evict old identities',()=>{
  const {adapter,state,request}=fixture({maxReceipts:1}), command=request();
  const outcome=adapter.act(command);
  assert.equal(adapter.act({...command,action:'focus'}).code,'ID_REUSE_CONFLICT');
  assert.equal(adapter.act({...command,id:'two'}).code,'RECEIPT_CAPACITY');
  assert.deepEqual(adapter.act(command),outcome);assert.equal(state.count,1);
});
test('a reentrant exact retry sees pending and cannot invoke twice',()=>{
  let adapter, command, inside, calls=0;
  ({adapter}=fixture({execute:()=>{calls++;inside=adapter.act(command);return {status:'dispatched'};}}));
  command={adapterId:'test-lifetime',id:'recursive',revision:adapter.observe().revision,target:'button-1',action:'click',arguments:{}};
  assert.equal(adapter.act(command).status,'dispatched');assert.equal(inside.status,'pending');assert.equal(calls,1);
});
test('post-invocation failure retains uncertainty and exact retries do not repeat',()=>{
  let calls=0;const {adapter,request}=fixture({execute:()=>{calls++;throw new Error('private detail');}}), command=request();
  const result=adapter.act(command);assert.equal(result.status,'uncertain');assert.equal(result.code,'ACTION_UNCERTAIN');
  assert.equal(JSON.stringify(result).includes('private detail'),false);assert.deepEqual(adapter.act(command),result);assert.equal(calls,1);
});
test('pre-effect argument validation is a definite rejection',()=>{
  const {adapter,request}=fixture({validate:()=>{throw new InteractionValidationError('INVALID_ACTION_ARGUMENTS');}});
  assert.equal(adapter.act(request()).status,'rejected');
});
test('unknown, unavailable, wrong-lifetime and malformed operations are not invoked',()=>{
  const {adapter,state,request}=fixture(); const base=request();
  assert.equal(adapter.act({...base,target:'replacement'}).code,'TARGET_UNAVAILABLE');
  assert.equal(adapter.act({...base,id:'two',action:'remove'}).code,'ACTION_UNAVAILABLE');
  assert.equal(adapter.act({...base,id:'three',adapterId:'other-life'}).code,'ADAPTER_MISMATCH');
  assert.throws(()=>adapter.act({...base,id:'four',script:'arbitrary'}),{code:'INVALID_SURFACE_ACTION'});
  assert.throws(()=>adapter.callTool('eval',{}),{code:'INVALID_SURFACE_TOOL'});
  assert.throws(()=>adapter.callTool('surface_observe',{extra:true}),{code:'INVALID_SURFACE_TOOL'});
  assert.equal(state.count,0);
});
test('disposal releases resources, rejects new work, and preserves known outcomes',()=>{
  const {adapter,request}=fixture();const command=request();const result=adapter.act(command);let cleanup=0;
  adapter.onDispose(()=>cleanup++);adapter.dispose();adapter.dispose();
  assert.equal(cleanup,1);assert.throws(()=>adapter.observe(),{code:'SURFACE_DISPOSED'});
  assert.deepEqual(adapter.act(command),result);assert.deepEqual(adapter.getOutcome('one'),result);
  assert.equal(adapter.act({...command,id:'new'}).code,'SURFACE_DISPOSED');
});
test('bounded event history exposes gaps, pages, actor labels and recent activity in observations',()=>{
  const {adapter}=fixture({maxEvents:2});
  for(let index=0;index<3;index++)adapter.record({type:'click',actor:index===1?'agent':'user',target:'button-1'});
  const page=adapter.history({after:0,limit:1});assert.equal(page.gap,true);assert.equal(page.events[0].cursor,2);assert.equal(page.nextCursor,2);assert.equal(page.hasMore,true);
  assert.equal(adapter.history({after:page.nextCursor}).events[0].cursor,3);
  assert.equal(adapter.observe().activity.events.length,2);
  assert.throws(()=>adapter.history({after:999}),{code:'INVALID_SURFACE_CURSOR'});
});
test('observers are detached, isolated, cannot recursively execute and can unsubscribe',async()=>{
  const {adapter,state,request}=fixture();let seen, nested;
  const off=adapter.subscribe(event=>{event.type='changed';nested=adapter.act(request('nested'));throw new Error('listener');});
  adapter.subscribe(event=>{seen=event.type;return Promise.reject(new Error('async listener'));});
  adapter.record({type:'click',actor:'user'});off();
  assert.equal(seen,'click');assert.equal(nested.code,'SURFACE_BUSY');assert.equal(state.count,0);
  assert.equal(adapter.history().events[0].type,'click'); await new Promise(resolve=>setImmediate(resolve));
});
test('two adapters attribute in-process effects to agent origin',()=>{
  const other=fixture().adapter;let during;
  const {adapter,request}=fixture({execute:()=>{during=other.isActing();return {status:'dispatched'};}});
  adapter.act(request());assert.equal(during,true);assert.equal(other.isActing(),false);
});
test('async execution is uncertain and retained rather than silently retried',async()=>{
  let count=0;const {adapter,request}=fixture({execute:async()=>{count++;throw new Error('async failure');}}), command=request();
  assert.equal(adapter.act(command).status,'uncertain');assert.equal(adapter.act(command).status,'uncertain');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(count,1);
});
test('unavailable observation rejects before execution and can be retried only as the retained rejection',()=>{
  let unavailable=false;
  const {adapter,state,request}=fixture({sample:()=>{if(unavailable)throw new Error('detached');return {targets:[{ref:'button-1',actions:['click']}]};}});
  const command=request();unavailable=true;assert.equal(adapter.act(command).code,'SURFACE_UNAVAILABLE');assert.equal(state.count,0);
});

test('even validation-shaped application exceptions after invocation remain uncertain',()=>{
  let count=0;const {adapter,request}=fixture({execute:()=>{count++;throw new InteractionValidationError('INVALID_SCHEMA');}});
  assert.equal(adapter.act(request()).status,'uncertain');assert.equal(count,1);
});
