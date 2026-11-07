import {writeFileSync,mkdirSync} from 'node:fs';
import {Runtime,MemoryStore,replay} from '../src/index.mjs';
import {counterRegistry,makeSpec} from './toy.mjs';

const registry=counterRegistry(),store=new MemoryStore();
let runtime=Runtime.create(makeSpec(),registry,store);
const context={runtimeId:'toy-runtime',admin:true},trace=[];
const record=(label,result)=>trace.push({label,result});
function control(action,operationId,fields={}) {
  const s=runtime.snapshot(context);
  return {protocolVersion:'0.1.0',runtimeId:s.runtimeId,operationId,action,runtimeFence:s.runtimeFence,expectedControlRevision:s.controlRevision,...fields};
}
function command(commandId,scopeId='coach',amount=1) {
  const o=runtime.observe('main',scopeId,context,'board');
  return {protocolVersion:'0.1.0',commandId,runtimeId:o.runtimeId,target:{sceneId:'main'},operation:'counter.add',arguments:{amount},guards:{runtimeFence:o.runtimeFence,expectedSceneRevision:o.sceneRevision,scopeId,scopeEpoch:o.scope.epoch,view:o.view}};
}
record('initial',runtime.observe('main','coach',context,'board'));
const uncertain=command('uncertain-commit');store.failNext='after';
try {runtime.submit(uncertain,context);}catch(error){record('simulated lost commit acknowledgement',{code:error.code});}
const saved=runtime.exportReplay(context),restoredStore=MemoryStore.fromReplay(saved,registry);
runtime=new Runtime(registry,restoredStore);
record('recover',runtime.control(control('recover','recover-1',{newRuntimeFence:'fence-2'}),context));
record('retry old command',runtime.submit(uncertain,context));
const o=runtime.observe('main','coach',context,'board');
const plan={protocolVersion:'0.1.0',sequenceId:'show-then-change',runtimeId:o.runtimeId,sceneId:'main',guards:{runtimeFence:o.runtimeFence,expectedSceneRevision:o.sceneRevision,scopeId:'coach',scopeEpoch:o.scope.epoch,view:o.view},steps:[
  {id:'move',kind:'invoke',operation:'counter.add',arguments:{amount:1},expectedRevision:o.sceneRevision},
  {id:'show',kind:'effect',effectKind:'toy.show',parameters:{label:'Two tokens'},revisionFromStep:'move'},
  {id:'seen',kind:'wait',effectStepId:'show',layer:'presentation.reconciled',timeoutTicks:5,timeoutPolicy:'degrade'},
  {id:'next',kind:'invoke',operation:'counter.add',arguments:{amount:1},revisionFromStep:'move'}
]};
record('admit sequence',runtime.submitSequence(plan,context));
record('commit sequence move',runtime.advance(plan.sequenceId,context));
record('queue visual intent',runtime.advance(plan.sequenceId,context));
record('fake adapter claimed visual intent',runtime.claimEffect(`${plan.sequenceId}/show`,context));
const scope=runtime.snapshot(context).scopes.coach;
const interrupt=control('interrupt','interrupt-1',{scopeId:'coach',scopeEpoch:scope.epoch});
record('interrupt after state commit',runtime.control(interrupt,context));
record('retry same interrupt',runtime.control(interrupt,context));
record('sequence remains canceled',runtime.advance(plan.sequenceId,context));
record('close coaching scope',runtime.control(control('closeScope','close-coach',{scopeId:'coach',scopeEpoch:runtime.snapshot(context).scopes.coach.epoch}),context));
record('explicit separate-scope practice',runtime.submit(command('practice','learner',1),context));
const bundle=runtime.exportReplay(context),reconstructed=replay(bundle,registry);
record('effect-free replay',{value:reconstructed.scenes.main.state.value,sceneRevision:reconstructed.scenes.main.sceneRevision,coachStatus:reconstructed.scopes.coach.status,sequenceStatus:reconstructed.sequences[plan.sequenceId].status,eventCursor:reconstructed.eventCursor,equivalent:JSON.stringify(reconstructed)===JSON.stringify(runtime.snapshot(context))});
console.log(JSON.stringify({contractVersion:'0.1.0',storage:'simulated in-memory',trace},null,2));
if(process.argv[2]) {
  mkdirSync(process.argv[2],{recursive:true});
  writeFileSync(`${process.argv[2]}/demo-trace.json`,JSON.stringify({contractVersion:'0.1.0',trace},null,2)+'\n');
  writeFileSync(`${process.argv[2]}/replay.json`,JSON.stringify(bundle,null,2)+'\n');
  writeFileSync(`${process.argv[2]}/lost-ack-replay.json`,JSON.stringify(saved,null,2)+'\n');
}
