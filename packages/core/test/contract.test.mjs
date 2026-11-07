import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {Runtime,MemoryStore,Registry,validate} from '../src/index.mjs';
import {counterRegistry,makeSpec} from '../examples/toy.mjs';
import examples from '../contracts/examples.json' with {type:'json'};

const ctx={runtimeId:'toy-runtime',admin:true};
function setup(){const registry=counterRegistry(),store=new MemoryStore();return {registry,store,r:Runtime.create(makeSpec(),registry,store)};}
function command(r,id){const s=r.snapshot(ctx);return {...structuredClone(examples.command),commandId:id,guards:{...structuredClone(examples.command.guards),runtimeFence:s.runtimeFence,expectedSceneRevision:s.scenes.main.sceneRevision,scopeEpoch:s.scopes.coach.epoch}};}
function ctl(r,id,action,extra={}){const s=r.snapshot(ctx);return {protocolVersion:'0.1.0',operationId:id,runtimeId:s.runtimeId,runtimeFence:s.runtimeFence,expectedControlRevision:s.controlRevision,action,...extra};}

test('published examples and actual outputs conform to their packet definitions',()=>{
  for(const [name,example] of Object.entries(examples))assert.deepEqual(validate(name,example),example);
  const {r}=setup();
  validate('observation',r.observe('main','coach',ctx,'board'));
  validate('outcome',r.submit(command(r,'a'),ctx));
  validate('replay',r.exportReplay(ctx));
  r.control(ctl(r,'end','end'),ctx);
  for(const effect of Object.values(r.snapshot(ctx).effects))validate('effect',r.claimEffect(effect.effectId,ctx));
});

test('malformed, cyclic and oversized input is rejected before mutation',()=>{
  const {r}=setup(),before=r.snapshot(ctx);
  for(const malformed of [null,[],{},true,42])assert.throws(()=>r.submit(malformed,ctx),e=>e.code==='INVALID_SCHEMA');
  const cyclic=command(r,'cycle');cyclic.arguments.cycle=cyclic;
  assert.throws(()=>r.submit(cyclic,ctx),e=>e.code==='INVALID_SCHEMA');
  const large=command(r,'large');large.arguments.payload='x'.repeat(70000);
  assert.throws(()=>r.submit(large,ctx),e=>e.code==='RESOURCE_LIMIT');
  assert.deepEqual(r.snapshot(ctx),before);
});

test('restored stores require a new recovery fence before new work but retain retry lookup',()=>{
  const {r,registry}=setup(),intent=command(r,'first');
  const committed=r.submit(intent,ctx),s=MemoryStore.fromReplay(r.exportReplay(ctx),registry),restored=new Runtime(registry,s);
  assert.deepEqual(restored.submit(intent,ctx),committed);
  assert.throws(()=>restored.submit(command(restored,'new-before-recover'),ctx),e=>e.code==='RECOVERY_REQUIRED');
  restored.control(ctl(restored,'recover','recover',{newRuntimeFence:'new-fence'}),ctx);
  assert.equal(restored.submit(command(restored,'new-after-recover'),ctx).status,'committed');
});

test('sequence checkpoint and domain change share both sides of the storage failure boundary',()=>{
  const {r,store}=setup();r.submitSequence(structuredClone(examples.sequence),ctx);
  const before=r.snapshot(ctx);store.failNext='before';
  assert.throws(()=>r.advance('sequence-1',ctx),e=>e.code==='STORAGE_UNAVAILABLE');
  assert.deepEqual(r.snapshot(ctx),before);
  store.failNext='after';assert.throws(()=>r.advance('sequence-1',ctx),e=>e.code==='ACKNOWLEDGEMENT_LOST');
  assert.equal(r.snapshot(ctx).scenes.main.sceneRevision,1);
  assert.equal(r.getSequence('sequence-1',ctx).index,1);
  r.advance('sequence-1',ctx);
  assert.equal(r.snapshot(ctx).scenes.main.sceneRevision,1);
  assert.equal(r.getOutcome('sequence-1/change',ctx).status,'committed');
});

test('invalid reducer result cannot leave a domain mutation inside a failed sequence checkpoint',()=>{
  const registry=new Registry().register({ruleset:'toy.counter',rulesVersion:'1',stateSchemaVersion:'1',validateState:s=>Number.isInteger(s.value),project:s=>s,operations:{'counter.add':{validate:()=>true,apply:()=>({state:{value:99},result:[]})}}});
  const r=Runtime.create(makeSpec(),registry,new MemoryStore());
  const p={...structuredClone(examples.sequence),steps:[structuredClone(examples.sequence.steps[0])]};
  r.submitSequence(p,ctx);assert.equal(r.advance(p.sequenceId,ctx).status,'failed');
  assert.equal(r.snapshot(ctx).scenes.main.state.value,0);
  assert.equal(r.snapshot(ctx).scenes.main.sceneRevision,0);
});

test('derived IDs encode separators and cannot alias another plan',()=>{
  const {r}=setup();
  const p={...structuredClone(examples.sequence),sequenceId:'a/b',steps:[{id:'c',kind:'effect',effectKind:'toy.show',parameters:{label:'a'},expectedRevision:0}]};
  const q={...structuredClone(p),sequenceId:'a',steps:[{...p.steps[0],id:'b/c'}]};
  r.submitSequence(p,ctx);r.submitSequence(q,ctx);r.advance(p.sequenceId,ctx);r.advance(q.sequenceId,ctx);
  assert.ok(r.claimEffect('a%2Fb/c',ctx));assert.ok(r.claimEffect('a/b%2Fc',ctx));
});

test('generic kernel imports only local core contracts and a built-in hash primitive',()=>{
  const dir=new URL('../src/',import.meta.url);
  const allowed=new Set(['./schema.mjs','./store.mjs','./registry.mjs','./runtime.mjs','node:crypto','../contracts/schemas.json']);
  for(const file of readdirSync(dir).filter(x=>x.endsWith('.mjs'))){
    const source=readFileSync(new URL(file,dir),'utf8');
    for(const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g))assert.ok(allowed.has(match[1]),`unexpected dependency ${file}: ${match[1]}`);
  }
});
