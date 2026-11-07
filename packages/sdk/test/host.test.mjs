import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime, Registry, MemoryStore} from '../../core/src/index.mjs';
import {counterRegistry, makeSpec} from '../../core/examples/toy.mjs';
import {createInteractionHost} from '../src/host.mjs';

const actions = [{name:'counter.add', description:'Add to the counter.',
  parameters:{type:'object', properties:{amount:{type:'integer', minimum:-10, maximum:10}},
    required:['amount'], additionalProperties:false}}];
const admin = {runtimeId:'toy-runtime', admin:true};
const copy = value => structuredClone(value);
const code = expected => error => error.code === expected;

function setup({registry=counterRegistry(), descriptors=actions, viewId='board'}={}) {
  const spec=makeSpec();
  spec.scenes.push({...copy(spec.scenes[0]), sceneId:'other'});
  spec.views.push({viewId:'second', sceneId:'main', viewEpoch:0, interactionRevision:0});
  spec.views.push({viewId:'other-board', sceneId:'other', viewEpoch:0, interactionRevision:0});
  const store=new MemoryStore(), runtime=Runtime.create(spec,registry,store);
  let trusted=copy(admin), calls=0;
  const host=createInteractionHost({runtime,sceneId:'main',scopeId:'coach',viewId,actions:descriptors,
    getContext(){calls++; return trusted;}});
  return {runtime,store,host,setContext(value){trusted=value;},calls:()=>calls};
}
function command(observation,id='command',amount=1) {
  return {protocolVersion:'0.1.0',commandId:id,runtimeId:observation.runtimeId,
    target:{sceneId:observation.sceneId},operation:'counter.add',arguments:{amount},
    guards:{runtimeFence:observation.runtimeFence,expectedSceneRevision:observation.sceneRevision,
      scopeId:observation.scope.id,scopeEpoch:observation.scope.epoch,
      ...(observation.view?{view:copy(observation.view)}:{})}};
}
function control(observation,id='stop',action='interrupt') {
  return {protocolVersion:'0.1.0',operationId:id,runtimeId:observation.runtimeId,action,
    runtimeFence:observation.runtimeFence,expectedControlRevision:observation.controlRevision,
    sceneId:observation.sceneId,scopeId:observation.scope.id,scopeEpoch:observation.scope.epoch,
    ...(observation.view?{view:copy(observation.view)}:{})};
}
function authorized(overrides={}) {
  return {runtimeId:'toy-runtime',scenes:['main'],scopes:['coach'],operations:['counter.add'],
    controls:['interrupt','closeScope'],observe:true,inspect:true,receipts:true,...overrides};
}
function receipt(effect,id='receipt') {
  return {protocolVersion:'0.1.0',receiptId:id,runtimeId:effect.runtimeId,effectId:effect.effectId,
    sceneId:effect.sceneId,sceneRevision:effect.sceneRevision,runtimeFence:effect.runtimeFence,
    scopeId:effect.scopeId,scopeEpoch:effect.scopeEpoch,...(effect.view?{view:copy(effect.view)}:{}),
    layer:'presentation.reconciled',status:'completed'};
}
function dispatched(runtime,id,view='board') {
  const observation=runtime.observe('main','coach',admin,view);
  const plan={protocolVersion:'0.1.0',sequenceId:id,runtimeId:observation.runtimeId,sceneId:'main',
    guards:command(observation).guards,
    steps:[{id:'show',kind:'effect',effectKind:'toy.show',parameters:{label:'Hello'},expectedRevision:observation.sceneRevision},
      {id:'done',kind:'finish'}]};
  assert.equal(runtime.submitSequence(plan,admin).status,'admitted');
  runtime.advance(id,admin);
  return runtime.claimEffect(`${id}/show`,admin);
}

test('catalog filters native capabilities, takes fresh permissions, and does not expose private runtime APIs',()=>{
  const descriptors=[...copy(actions),{name:'unknown.action',description:'Not registered.',parameters:{type:'object'}}];
  const {host,setContext,calls}=setup({descriptors});
  assert.deepEqual(host.catalog(),actions);
  assert.deepEqual(host.observe().capabilities,['counter.add']);
  descriptors[0].description='Changed outside';
  const catalog=host.catalog();catalog[0].parameters.properties.amount.maximum=999;
  assert.deepEqual(host.catalog(),actions);
  setContext(authorized({operations:[]}));
  assert.deepEqual(host.catalog(),[]);
  assert.deepEqual(host.observe().capabilities,[]);
  assert.equal(calls(),6);
  for(const name of ['runtime','snapshot','exportReplay','submitSequence','getSequence','claimEffect'])assert.equal(host[name],undefined);
  assert.equal(Object.isFrozen(host),true);
});

test('public projection ignores trusted private audience and caller-supplied administrative context',()=>{
  const registry=new Registry().register({ruleset:'toy.counter',rulesVersion:'1',stateSchemaVersion:'1',
    validateState:s=>typeof s.value==='number',operations:{},
    project:(s,audience)=>audience==='public'?{value:s.value}:{value:s.value,privateSecret:'hidden'}});
  const {host,setContext}=setup({registry,descriptors:[]});
  setContext({...admin,audience:'private'});
  assert.deepEqual(host.observe().projection,{value:0});
  setContext(authorized({observe:false}));
  assert.throws(()=>host.observe(admin),code('FORBIDDEN'));
  assert.throws(()=>host.catalog(admin),code('FORBIDDEN'));
});

test('native idempotency and stale guards survive without automatic retry or rebasing',()=>{
  const {host,store}=setup(), before=host.observe();
  const original=command(before,'once',3), outcome=host.submit(original);
  assert.equal(outcome.status,'committed');
  assert.equal(host.observe().projection.value,3);
  const cursor=store.read().eventCursor;
  assert.deepEqual(host.submit(copy(original)),outcome);
  assert.deepEqual(host.getOutcome('once'),outcome);
  assert.equal(store.read().eventCursor,cursor);
  assert.equal(host.submit(command(before,'stale',2)).code,'STATE_CONFLICT');
  assert.equal(host.observe().projection.value,3);
  assert.equal(host.submit({...original,arguments:{amount:4}}).code,'DUPLICATE_ID_MISMATCH');
});

test('registry validation is authoritative even when JSON Schema metadata differs',()=>{
  const descriptors=copy(actions);descriptors[0].parameters.properties.amount.maximum=1;
  const {host}=setup({descriptors});
  assert.equal(host.submit(command(host.observe(),'legal',3)).status,'committed');
  assert.equal(host.submit(command(host.observe(),'illegal',11)).code,'INVALID_SCHEMA');
  assert.equal(host.observe().projection.value,3);
});

test('revoked operation, observation, inspection and boundary grants apply to every call',()=>{
  const {host,setContext}=setup();
  const original=command(host.observe(),'first');host.submit(original);
  setContext(authorized({operations:[]}));
  assert.throws(()=>host.submit(original,admin),code('FORBIDDEN'));
  assert.throws(()=>host.getOutcome('first',admin),code('FORBIDDEN'));
  setContext(authorized({inspect:false}));
  assert.throws(()=>host.getOutcome('first'),code('FORBIDDEN'));
  assert.throws(()=>host.getOutcome('unknown'),code('FORBIDDEN'));
  for(const grant of ['scenes','scopes']) {
    setContext(authorized({[grant]:[]}));
    assert.throws(()=>host.observe(),code('FORBIDDEN'));
    assert.throws(()=>host.submit(original),code('FORBIDDEN'));
  }
});

test('permissive trusted admin cannot cross configured scene, scope or view',()=>{
  const {host,store}=setup(), base=command(host.observe());
  const alterations=[
    c=>{c.target.sceneId='other';},c=>{c.guards.scopeId='learner';},
    c=>{c.guards.view.viewId='second';},c=>{delete c.guards.view;},
  ];
  for(const change of alterations){const c=copy(base);change(c);assert.throws(()=>host.submit(c),code('HOST_BOUNDARY_VIOLATION'));}
  assert.equal(store.read().eventCursor,0);
  assert.throws(()=>host.submit({...base,operation:'unpublished.action'}),code('HOST_ACTION_UNAVAILABLE'));
  assert.throws(()=>host.submit({...base,admin:true}),code('INVALID_SCHEMA'));
  assert.equal(store.read().eventCursor,0);
});

test('viewless boundaries reject commands that opt into an unrelated view',()=>{
  const {runtime}=setup();
  const host=createInteractionHost({runtime,getContext:()=>admin,sceneId:'main',scopeId:'coach',actions});
  assert.equal(host.observe().view,undefined);
  const c=command(host.observe());
  assert.equal(host.submit(c).status,'committed');
  c.commandId='other';c.guards.view={viewId:'board',viewEpoch:0,interactionRevision:0};
  assert.throws(()=>host.submit(c),code('HOST_BOUNDARY_VIOLATION'));
});

test('outcome admission prevents cross-view reads and duplicate-ID mismatch does not grant access',()=>{
  const {runtime,host}=setup();
  const foreign=command(runtime.observe('main','coach',admin,'second'),'foreign');
  runtime.submit(foreign,admin);
  assert.throws(()=>host.getOutcome('foreign'),code('HOST_OUTCOME_UNAVAILABLE'));
  const collision=command(host.observe(),'foreign');
  assert.equal(host.submit(collision).code,'DUPLICATE_ID_MISMATCH');
  assert.throws(()=>host.getOutcome('foreign'),code('HOST_OUTCOME_UNAVAILABLE'));
  const ownCommand=command(host.observe(),'owned');const result=host.submit(ownCommand);
  const next=createInteractionHost({runtime,getContext:()=>admin,sceneId:'main',scopeId:'coach',viewId:'board',actions});
  assert.throws(()=>next.getOutcome('owned'),code('HOST_OUTCOME_UNAVAILABLE'));
  assert.deepEqual(next.submit(ownCommand),result);
  assert.deepEqual(next.getOutcome('owned'),result);
});

test('lost storage acknowledgement stays thrown and permits explicit outcome reconciliation',()=>{
  const {host,store}=setup();const c=command(host.observe(),'uncertain');
  store.failNext='after';
  assert.throws(()=>host.submit(c),code('ACKNOWLEDGEMENT_LOST'));
  const result=host.getOutcome('uncertain');
  assert.equal(result.status,'committed');assert.equal(result.result.value,1);
  assert.deepEqual(host.submit(c),result);assert.equal(host.observe().projection.value,1);
  const rejected=command(host.observe(),'never-committed');store.failNext='before';
  assert.throws(()=>host.submit(rejected),code('STORAGE_UNAVAILABLE'));
  assert.throws(()=>host.getOutcome('never-committed'),code('HOST_OUTCOME_UNAVAILABLE'));
});

test('only explicit scoped controls are admitted; native supersession and retry are retained',()=>{
  const {host,store,setContext}=setup(), before=host.observe(), stale=command(before,'stale');
  for(const action of ['end','recover','tick','forkScene','bindView']) {
    assert.throws(()=>host.control({...control(before,action,action)}),code('HOST_CONTROL_FORBIDDEN'));
  }
  for(const change of [c=>{c.scopeId='learner';},c=>{c.sceneId='other';},c=>{c.view.viewId='second';},c=>{delete c.sceneId;},c=>{c.sourceSceneId='other';}]) {
    const c=control(before);change(c);assert.throws(()=>host.control(c),code('HOST_BOUNDARY_VIOLATION'));
  }
  assert.equal(store.read().eventCursor,0);
  const stop=control(before), result=host.control(stop);
  assert.equal(result.status,'committed');assert.deepEqual(host.control(stop),result);
  assert.equal(host.submit(stale).code,'SUPERSEDED_SCOPE');
  setContext(authorized({controls:[]}));
  assert.throws(()=>host.control(control(host.observe(),'revoked')),code('FORBIDDEN'));
  assert.throws(()=>host.getOutcome('stop'),code('FORBIDDEN'));
});

test('scoped control freshness uses native control/scope guards; view revisions are descriptive',()=>{
  const {host,runtime}=setup(), before=host.observe();
  const original=control(before,'first-stop');
  // Unlike command guards, scoped core controls do not interpret these fields.
  original.view.viewEpoch=42;original.view.interactionRevision=99;
  const committed=host.control(original);assert.equal(committed.status,'committed');
  const current=host.observe();
  const rebound=runtime.control({protocolVersion:'0.1.0',operationId:'rebind',runtimeId:current.runtimeId,
    action:'bindView',runtimeFence:current.runtimeFence,expectedControlRevision:current.controlRevision,
    sceneId:'main',view:{viewId:'board',viewEpoch:1,interactionRevision:1}},admin);
  assert.equal(rebound.status,'committed');
  assert.equal(host.control(control(before,'old-observation')).code,'CONTROL_CONFLICT');
  assert.deepEqual(host.control(original),committed);
  const restarted=createInteractionHost({runtime,getContext:()=>admin,sceneId:'main',scopeId:'coach',viewId:'board',actions});
  assert.deepEqual(restarted.control(original),committed);
  assert.deepEqual(restarted.getOutcome(original.operationId),committed);
});

test('receipts require fresh permission and exact effect scene/scope/view metadata',()=>{
  const {host,runtime,setContext}=setup();
  const effect=dispatched(runtime,'show');const r=receipt(effect);
  setContext(authorized({receipts:false}));
  assert.throws(()=>host.receiveReceipt(r,admin),code('FORBIDDEN'));
  setContext(admin);
  for(const change of [x=>{x.sceneId='other';},x=>{x.scopeId='learner';},x=>{x.view.viewId='second';},x=>{delete x.view;}]) {
    const bad=copy(r);change(bad);assert.throws(()=>host.receiveReceipt(bad),code('HOST_BOUNDARY_VIOLATION'));
  }
  const foreignEffect=dispatched(runtime,'foreign-show','second');
  const forged={...receipt(foreignEffect,'forged'),view:copy(r.view)};
  assert.equal(host.receiveReceipt(forged).code,'RECEIPT_CONTEXT_MISMATCH');
  const result=host.receiveReceipt(r);
  assert.equal(result.status,'completed');assert.deepEqual(host.receiveReceipt(r),result);
  assert.deepEqual(host.getOutcome(r.receiptId),result);
  setContext(authorized({receipts:false}));
  assert.throws(()=>host.getOutcome(r.receiptId),code('FORBIDDEN'));
});

test('malformed and oversized caller objects never run domain writes or accessors',()=>{
  const {host,store}=setup();const base=command(host.observe());
  const cycle={};cycle.self=cycle;
  const argumentsList=[undefined,NaN,Infinity,new Date(),()=>{},cycle,{amount:1n},new Map(),
    {amount:1,extra:'x'.repeat(65_537)},JSON.parse('{"__proto__":{}}')];
  for(const args of argumentsList)assert.throws(()=>host.submit({...base,arguments:args}));
  let accessed=false;const accessor={};Object.defineProperty(accessor,'amount',{enumerable:true,get(){accessed=true;return 1;}});
  assert.throws(()=>host.submit({...base,arguments:accessor}),code('INVALID_SCHEMA'));
  assert.equal(accessed,false);assert.equal(store.read().eventCursor,0);
});

test('catalog metadata, configuration and synchronous context are bounded and validated',()=>{
  for(const descriptors of [null,{},[...actions,...actions],Array.from({length:65},(_,i)=>({...actions[0],name:`action.${i}`})),
    [{...actions[0],description:'x'.repeat(2_001)}],[{...actions[0],parameters:{type:'string'}}],
    [{...actions[0],parameters:{type:'object',description:'x'.repeat(65_537)}}]])assert.throws(()=>setup({descriptors}));
  const {host,setContext}=setup();
  for(const context of [null,undefined,[],Promise.resolve(admin),{runtimeId:4}]) {
    setContext(context);assert.throws(()=>host.observe());
  }
  setContext({...admin,runtimeId:'foreign-runtime'});
  assert.throws(()=>host.observe(),code('FORBIDDEN'));
});
