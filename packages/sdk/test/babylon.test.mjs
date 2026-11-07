import test from 'node:test';
import assert from 'node:assert/strict';
import {NullEngine, Scene, ArcRotateCamera, Camera, Vector3, MeshBuilder, PointerEventTypes, Matrix, TransformNode} from '@babylonjs/core/index.js';
import {installBabylon} from '../src/babylon.mjs';
import {InteractionValidationError} from '../src/events.mjs';

function fixture(t, options = {}) {
  const engine = new NullEngine(), scene = new Scene(engine);
  const camera = new ArcRotateCamera('Camera',0,1,10,Vector3.Zero(),scene);
  const box = MeshBuilder.CreateBox('Rocket',{},scene);
  box.position.set(3,1,2);
  const sphere = MeshBuilder.CreateSphere('Moon',{},scene);
  sphere.position.set(-3,0,1);
  const adapter = installBabylon({scene,adapterId:'babylon-test',...options});
  t.after(() => { adapter.dispose(); scene.dispose(); engine.dispose(); });
  return {engine,scene,camera,box,sphere,adapter};
}
let serial = 0;
function request(adapter, name, action, args = {}) {
  const observation = adapter.observe(), target = observation.targets.find(target => target.name === name);
  return {adapterId:observation.adapterId,id:`operation-${++serial}`,revision:observation.revision,target:target.ref,action,arguments:args};
}
function pick(scene, mesh, event = {button:0,isTrusted:true}) {
  scene.onPointerObservable.notifyObservers({type:PointerEventTypes.POINTERPICK,event,pickInfo:{hit:true,pickedMesh:mesh}});
}

test('real scenes expose bounded presentation targets and explicit argument schemas',t => {
  const {adapter,box,scene} = fixture(t,{maxTargets:2});
  box.metadata = {password:'never-export',public:{label:'optional'}};
  const observation = adapter.observe();
  assert.equal(observation.kind,'game');
  assert.equal(observation.targets.length,2);
  assert.equal(observation.targets[0].role,'camera');
  assert.equal(observation.truncated,1);
  assert.deepEqual(observation.targets[1].actions,['focus','highlight']);
  assert.equal(observation.targets[1].actionSchemas.highlight.properties.enabled.type,'boolean');
  assert.equal(JSON.stringify(observation).includes('never-export'),false);
  assert.equal(adapter.record,undefined);
  assert.throws(() => installBabylon({scene,maxTargets:501}),{code:'INVALID_BABYLON_OPTIONS'});
});

test('focus uses current world position without mutating game objects and preserves exact retry',t => {
  const {adapter,box,camera} = fixture(t);
  const command = request(adapter,'Rocket','focus'), original = box.position.clone();
  const receipt = adapter.act(command);
  assert.equal(receipt.status,'dispatched');
  assert.ok(camera.getTarget().equals(box.getAbsolutePosition()));
  assert.ok(box.position.equals(original));
  camera.setTarget(Vector3.Zero());
  assert.deepEqual(adapter.act(command),receipt);
  assert.ok(camera.getTarget().equals(Vector3.Zero()),'retry does not refocus');
});

test('animation samples change without invalidating eligibility while camera replacement does',t => {
  const {adapter,box,scene} = fixture(t);
  const before = adapter.observe(), command = request(adapter,'Rocket','focus');
  box.position.x += 7;
  const animated = adapter.observe();
  assert.equal(animated.revision,before.revision);
  assert.notDeepEqual(animated.targets[1].sample,before.targets[1].sample);
  const replacement = new ArcRotateCamera('Camera',0,1,10,Vector3.Zero(),scene);
  scene.activeCamera = replacement;
  assert.equal(adapter.act(command).code,'STALE_SURFACE');
  const next = adapter.observe();
  assert.notEqual(next.activeCamera,before.activeCamera);
  scene.activeCamera = new Camera('Inspect only',Vector3.Zero(),scene);
  assert.equal(adapter.observe().targets[1].actions.includes('focus'),false);
});

test('disposed meshes and reused names never retarget old requests',t => {
  const {adapter,box,scene} = fixture(t);
  const command = request(adapter,'Rocket','highlight',{enabled:true});
  box.dispose();
  const replacement = MeshBuilder.CreateBox('Rocket',{},scene);
  const observation = adapter.observe();
  assert.notEqual(observation.targets.find(target => target.name === 'Rocket').ref,command.target);
  assert.equal(adapter.act(command).code,'STALE_SURFACE');
  assert.equal(replacement.showBoundingBox,false);
  replacement.setEnabled(false);
  assert.equal(adapter.observe().targets.some(target => target.name === 'Rocket'),false);
});

test('highlight restoration respects preexisting values and subsequent external changes',t => {
  const {adapter,box,sphere} = fixture(t);
  sphere.showBoundingBox = true;
  adapter.act(request(adapter,'Rocket','highlight',{enabled:true}));
  adapter.act(request(adapter,'Moon','highlight',{enabled:true}));
  assert.equal(box.showBoundingBox,true);
  adapter.dispose();
  assert.equal(box.showBoundingBox,false);
  assert.equal(sphere.showBoundingBox,true);
  const second = installBabylon({scene:box.getScene(),adapterId:'second'});
  second.act(request(second,'Rocket','highlight',{enabled:true}));
  box.showBoundingBox = false;
  second.dispose();
  assert.equal(box.showBoundingBox,false);
  const third = installBabylon({scene:box.getScene(),adapterId:'third'});
  third.act(request(third,'Moon','highlight',{enabled:false}));
  assert.equal(sphere.showBoundingBox,false);
  third.dispose();
  assert.equal(sphere.showBoundingBox,true);
});

test('invalid arguments reject before effects; even validation-shaped effect errors remain uncertain',t => {
  const {adapter,box,camera} = fixture(t);
  assert.equal(adapter.act(request(adapter,'Rocket','focus',{script:'no'})).code,'INVALID_ACTION_ARGUMENTS');
  assert.equal(adapter.act(request(adapter,'Rocket','highlight',{enabled:'true'})).code,'INVALID_ACTION_ARGUMENTS');
  assert.equal(box.showBoundingBox,false);
  let calls = 0;
  const realSetTarget = camera.setTarget.bind(camera);
  camera.setTarget = destination => { calls++; realSetTarget(destination); throw new InteractionValidationError('CALLBACK_FAILED'); };
  const command = request(adapter,'Rocket','focus');
  const receipt = adapter.act(command);
  assert.equal(receipt.status,'uncertain');
  assert.equal(receipt.code,'ACTION_UNCERTAIN');
  assert.ok(camera.getTarget().equals(box.getAbsolutePosition()));
  assert.deepEqual(adapter.act(command),receipt);
  assert.equal(calls,1);
});

test('native picks distinguish human, synthetic and in-action observations across adapters',t => {
  const {adapter,scene,box,camera} = fixture(t);
  const other = installBabylon({scene,adapterId:'other'});
  t.after(() => other.dispose());
  pick(scene,box);
  pick(scene,box,{isTrusted:false});
  const realSetTarget = camera.setTarget.bind(camera);
  camera.setTarget = destination => { pick(scene,box); realSetTarget(destination); };
  adapter.act(request(adapter,'Rocket','focus'));
  const events = adapter.history().events.filter(event => event.type === 'game.picked');
  assert.deepEqual(events.map(event => event.actor),['user','system','agent']);
  assert.ok(events.every(event => event.target === adapter.observe().targets[1].ref));
  assert.equal(other.history().events.at(-1).actor,'agent');
  assert.equal(adapter.observe().activity.events.at(-1).type,'action');
});

test('scene disposal removes observers, fences new actions, and retains receipt lookup and exact retry',t => {
  const {adapter,scene} = fixture(t);
  const command = request(adapter,'Rocket','highlight',{enabled:true}), receipt = adapter.act(command);
  scene.dispose();
  assert.throws(() => adapter.observe(),{code:'SURFACE_DISPOSED'});
  assert.deepEqual(adapter.getOutcome(command.id),receipt);
  assert.deepEqual(adapter.act(command),receipt);
  assert.equal(adapter.act({...command,id:'new'}).code,'SURFACE_DISPOSED');
  assert.throws(() => installBabylon({scene}),{code:'SCENE_DISPOSED'});
  assert.equal(scene.onPointerObservable.observers.length,0);
});

test('manual disposal detaches only its own native observers',t => {
  const {adapter,scene} = fixture(t);
  let remaining = 0;
  scene.onPointerObservable.add(() => remaining++);
  adapter.dispose();
  scene.onPointerObservable.notifyObservers({type:PointerEventTypes.POINTERPICK,event:{},pickInfo:null});
  assert.equal(remaining,1);
  assert.equal(scene.onPointerObservable.observers.filter(observer => !observer._willBeUnregistered).length,1);
});

test('metadata is opt-in, bounded, data-only and never invokes namespace getters',t => {
  const {adapter,box,scene} = fixture(t);
  adapter.dispose();
  let reads = 0;
  box.metadata = {public:{label:'Launch'},private:'token',executable:{run:()=>1},huge:'x'.repeat(3000)};
  Object.defineProperty(box.metadata,'getter',{enumerable:true,get(){reads++; return 'secret';}});
  const scoped = installBabylon({scene,metadataNamespaces:['public','private','executable','getter','huge']});
  t.after(() => scoped.dispose());
  assert.deepEqual(scoped.observe().targets[1].state.metadata,{public:{label:'Launch'},private:'token'});
  assert.equal(reads,0);
  const exposed = scoped.observe();
  box.metadata.public.label = 'Return';
  assert.ok(scoped.observe().revision > exposed.revision);
});

test('thin instances are aggregate objects with no gameplay or individual-instance actions',t => {
  const {adapter,box} = fixture(t);
  // NullEngine has no GPU extension; setting a real instance buffer still exercises
  // Babylon's aggregate object state without claiming instance rendering coverage.
  box.thinInstanceSetBuffer('matrix',new Float32Array(Matrix.Identity().asArray()),16);
  const target = adapter.observe().targets.find(target => target.name === 'Rocket');
  assert.equal(target.state.thinInstanceCount,1);
  assert.deepEqual(target.actions,['focus','highlight']);
  assert.equal(adapter.act({...request(adapter,'Rocket','focus'),action:'move'}).code,'ACTION_UNAVAILABLE');
});

test('focus resolves a parented camera target in local coordinates',t => {
  const {adapter,box,camera,scene} = fixture(t);
  const parent = new TransformNode('Camera mount',scene);
  parent.position.set(10,2,0);
  camera.parent = parent;
  assert.equal(adapter.act(request(adapter,'Rocket','focus')).status,'dispatched');
  assert.ok(camera.getTarget().equals(box.getAbsolutePosition().subtract(parent.position)));
});

test('multiple adapters reject conflicting ownership before effects and never restore another owner',t => {
  const {adapter,box,scene} = fixture(t);
  const second = installBabylon({scene,adapterId:'second'});
  t.after(() => second.dispose());
  assert.equal(adapter.act(request(adapter,'Rocket','highlight',{enabled:true})).status,'dispatched');
  assert.equal(second.act(request(second,'Rocket','highlight',{enabled:true})).code,'HIGHLIGHT_OWNED');
  assert.equal(second.act(request(second,'Rocket','highlight',{enabled:false})).code,'HIGHLIGHT_OWNED');
  assert.equal(box.showBoundingBox,true);
  // The application breaks the first owner's value. The second now acquires it.
  box.showBoundingBox = false;
  assert.equal(second.act(request(second,'Rocket','highlight',{enabled:true})).status,'dispatched');
  adapter.dispose();
  assert.equal(box.showBoundingBox,true,'former owner cannot undo the current owner');
  second.dispose();
  assert.equal(box.showBoundingBox,false);
});

test('newly created mesh first picks carry a public target before an explicit observation',t => {
  const {adapter,scene} = fixture(t);
  const added = MeshBuilder.CreateBox('New arrival',{},scene);
  pick(scene,added);
  const event = adapter.history().events.at(-1);
  assert.equal(event.type,'game.picked');
  assert.equal(event.target,adapter.observe().targets.find(target => target.name === 'New arrival').ref);
  added.isVisible = false;
  pick(scene,added);
  assert.equal(adapter.history().events.at(-1).target,undefined);
});
