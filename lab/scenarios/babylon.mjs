import {NullEngine, Scene, ArcRotateCamera, Vector3, MeshBuilder, PointerEventTypes, Matrix, TransformNode} from '@babylonjs/core/index.js';
import {InteractionValidationError} from '../../packages/sdk/src/events.mjs';

const observe = adapter => adapter.callTool('surface_observe',{});
const act = (adapter, request) => adapter.callTool('surface_act',request);
const outcome = (adapter, id) => adapter.callTool('surface_get_outcome',{id});
const summary = receipt => ({id:receipt.id,status:receipt.status,...(receipt.code ? {code:receipt.code} : {})});
const xyz = value => ({x:value.x,y:value.y,z:value.z});
function randomFor(seed) {
  let state = 2166136261;
  for (const character of String(seed ?? 0)) state = Math.imul(state ^ character.charCodeAt(0),16777619) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15,state | 1);
    value ^= value + Math.imul(value ^ value >>> 7,value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function plan(assert, adapter, name, action, args, id, snapshot = observe(adapter)) {
  const target = snapshot.targets.find(candidate => candidate.name === name);
  assert.ok(target,`Expected public target ${name}`);
  assert.ok(target.actions.includes(action),`Expected advertised ${action} action`);
  return {adapterId:snapshot.adapterId,id,revision:snapshot.revision,target:target.ref,action,arguments:args};
}
function pick(scene, mesh, {trusted = true, instance = undefined} = {}) {
  // A real Babylon Observable with a synthetic native-pointer fixture. NullEngine
  // does not generate browser input, render pixels, or certify human identity.
  scene.onPointerObservable.notifyObservers({type:PointerEventTypes.POINTERPICK,event:{button:0,isTrusted:trusted},
    pickInfo:{hit:true,pickedMesh:mesh,...(instance === undefined ? {} : {thinInstanceIndex:instance})}});
}
async function withScene(seed, installBabylon, body) {
  const engine = new NullEngine(), scene = new Scene(engine), adapters = [];
  try {
    const random = randomFor(seed);
    const camera = new ArcRotateCamera('Camera',-Math.PI/2,1.1,12,Vector3.Zero(),scene);
    const mesh = MeshBuilder.CreateBox('Target',{},scene);
    mesh.position.set(1 + Math.floor(random()*7),1,-2);
    const spare = MeshBuilder.CreateSphere('Spare',{},scene);
    spare.position.set(-3,0,1);
    const install = id => {
      const adapter = installBabylon({scene,adapterId:id});
      adapters.push(adapter);
      return adapter;
    };
    const adapter = install('lab-game');
    await body({engine,scene,camera,mesh,spare,adapter,install,random});
  } finally {
    for (const adapter of adapters.reverse()) adapter.dispose();
    scene.dispose();
    engine.dispose();
  }
}

export const babylonScenarios = [
  {
    id:'game.focus_after_animation',version:1,title:'Focus follows animation without a stale plan',kind:'game',difficulty:'basic',
    description:'Observe a mesh, move it through several animation samples, then focus its current world position using the original guarded plan.',
    run:async ({assert,seed,record,installBabylon}) => withScene(seed,installBabylon,async ({scene,camera,mesh,adapter,random}) => {
      const parent = new TransformNode('Animated parent',scene);
      parent.position.set(2,0,1); mesh.parent = parent;
      const initial = observe(adapter), command = plan(assert,adapter,'Target','focus',{},'animated-focus',initial);
      const initialSample = initial.targets.find(target => target.ref === command.target).sample;
      for (let frame=0; frame<4; frame++) {
        mesh.position.x += 1 + random(); parent.position.z += .5;
        parent.computeWorldMatrix(true); mesh.computeWorldMatrix(true);
        assert.equal(observe(adapter).revision,initial.revision,'Animation must not invalidate an eligible target');
      }
      const finalSample = observe(adapter).targets.find(target => target.ref === command.target).sample;
      assert.notDeepEqual(finalSample,initialSample);
      const meshPosition = mesh.position.clone(), destination = mesh.getAbsolutePosition().clone();
      const receipt = act(adapter,command);
      assert.equal(receipt.status,'dispatched');
      assert.ok(camera.getTarget().equalsWithEpsilon(destination,1e-6));
      assert.ok(mesh.position.equals(meshPosition),'Presentation focus must not move the game object');
      record('animation focus',{frames:4,revision:initial.revision,destination:xyz(destination),receipt:summary(receipt)});
    })
  },
  {
    id:'game.replacement_identity',version:1,title:'Reused names cannot redirect an old plan',kind:'game',difficulty:'intermediate',
    description:'Replace a mesh and then a camera with same-named objects; both old plans must reject, and fresh observations must recover.',
    run:async ({assert,seed,record,installBabylon}) => withScene(seed,installBabylon,async ({scene,camera,mesh,adapter}) => {
      const oldMeshPlan = plan(assert,adapter,'Target','highlight',{enabled:true},'old-mesh');
      mesh.dispose();
      const replacement = MeshBuilder.CreateBox('Target',{},scene);
      replacement.position.set(7,0,2);
      const meshRejected = act(adapter,oldMeshPlan);
      assert.equal(meshRejected.code,'STALE_SURFACE');
      assert.equal(replacement.showBoundingBox,false);
      const current = observe(adapter), replacementRef = current.targets.find(target => target.name === 'Target').ref;
      assert.notEqual(replacementRef,oldMeshPlan.target,'Same name must not reuse object identity');
      assert.equal(act(adapter,plan(assert,adapter,'Target','highlight',{enabled:true},'fresh-mesh',current)).status,'dispatched');
      const oldCameraPlan = plan(assert,adapter,'Target','focus',{},'old-camera');
      const oldCameraRef = observe(adapter).activeCamera, replacementCamera = new ArcRotateCamera('Camera',0,1,10,Vector3.Zero(),scene);
      scene.activeCamera = replacementCamera; camera.dispose();
      const cameraRejected = act(adapter,oldCameraPlan);
      assert.equal(cameraRejected.code,'STALE_SURFACE');
      assert.notEqual(observe(adapter).activeCamera,oldCameraRef);
      assert.ok(replacementCamera.getTarget().equals(Vector3.Zero()));
      const recovered = act(adapter,plan(assert,adapter,'Target','focus',{},'fresh-camera'));
      assert.equal(recovered.status,'dispatched');
      assert.ok(replacementCamera.getTarget().equalsWithEpsilon(replacement.getAbsolutePosition(),1e-6));
      record('replacement fences',{mesh:summary(meshRejected),camera:summary(cameraRejected),recovery:summary(recovered),sameNameDifferentRef:true});
    })
  },
  {
    id:'game.highlight_ownership',version:1,title:'Competing adapters preserve highlight ownership',kind:'game',difficulty:'adversarial',
    description:'A second adapter cannot acquire an active highlight; after an application override, old-owner disposal must preserve the new owner.',
    run:async ({assert,seed,record,installBabylon}) => withScene(seed,installBabylon,async ({mesh,adapter,install}) => {
      const second = install('lab-second');
      assert.equal(act(adapter,plan(assert,adapter,'Target','highlight',{enabled:true},'first-highlight')).status,'dispatched');
      const conflict = act(second,plan(assert,second,'Target','highlight',{enabled:false},'competing-highlight'));
      assert.equal(conflict.code,'HIGHLIGHT_OWNED');
      assert.equal(mesh.showBoundingBox,true);
      mesh.showBoundingBox = false; // Explicit application intervention releases the old value.
      const takeover = act(second,plan(assert,second,'Target','highlight',{enabled:true},'after-override'));
      assert.equal(takeover.status,'dispatched');
      adapter.dispose();
      assert.equal(mesh.showBoundingBox,true,'Disposing a former owner must not undo the new owner');
      second.dispose();
      assert.equal(mesh.showBoundingBox,false,'The final owner restores its own pre-action value');
      const third = install('lab-third');
      mesh.showBoundingBox = true;
      act(third,plan(assert,third,'Target','highlight',{enabled:true},'preexisting-highlight'));
      third.dispose();
      assert.equal(mesh.showBoundingBox,true,'A preexisting application highlight is never adapter-owned');
      record('ownership lifecycle',{conflict:summary(conflict),takeover:summary(takeover),formerOwnerPreserved:true,finalOwnerRestored:true,preexistingPreserved:true});
    })
  },
  {
    id:'game.lost_ack_exact_retry',version:1,title:'A dropped acknowledgement cannot execute twice',kind:'game',difficulty:'intermediate',
    description:'Drop the transport reply after a real focus, recover its retained receipt, and retry exactly after an intervening camera move.',
    run:async ({assert,seed,record,installBabylon}) => withScene(seed,installBabylon,async ({camera,mesh,adapter}) => {
      const native = camera.setTarget.bind(camera);
      let focusCalls = 0, dropReply = true;
      camera.setTarget = value => { focusCalls++; return native(value); };
      const command = plan(assert,adapter,'Target','focus',{},'lost-reply');
      const transport = async request => {
        const receipt = act(adapter,request);
        if (dropReply) { dropReply = false; throw new Error('LAB_ACK_DROPPED_AFTER_DISPATCH'); }
        return receipt;
      };
      await assert.rejects(transport(command),/LAB_ACK_DROPPED_AFTER_DISPATCH/);
      assert.equal(focusCalls,1);
      assert.ok(camera.getTarget().equalsWithEpsilon(mesh.getAbsolutePosition(),1e-6));
      const retained = outcome(adapter,command.id);
      assert.equal(retained.status,'dispatched');
      const userDestination = new Vector3(-9,2,3); native(userDestination);
      const retry = await transport(command);
      assert.deepEqual(retry,retained);
      assert.equal(focusCalls,1);
      assert.ok(camera.getTarget().equals(userDestination),'Exact retry must not undo an intervening camera move');
      const changed = act(adapter,{...command,arguments:{unexpected:true}});
      assert.equal(changed.code,'ID_REUSE_CONFLICT');
      record('lost reply recovery',{retained:summary(retained),retry:summary(retry),changedRequest:summary(changed),nativeExecutions:focusCalls,userMovePreserved:true});
    })
  },
  {
    id:'game.dynamic_pick_awareness',version:1,title:'New objects appear in their first interaction',kind:'game',difficulty:'basic',
    description:'Pick a newly created mesh before observing it, then distinguish synthetic system input from picks generated during agent focus.',
    run:async ({assert,seed,record,installBabylon}) => withScene(seed,installBabylon,async ({scene,camera,adapter}) => {
      const added = MeshBuilder.CreateSphere('New arrival',{},scene);
      added.position.set(4,1,3); added.metadata = {privateToken:'synthetic-private-fixture'};
      pick(scene,added);
      const first = observe(adapter), target = first.targets.find(candidate => candidate.name === 'New arrival');
      const initialPick = first.activity.events.find(event => event.type === 'game.picked');
      assert.equal(initialPick.target,target.ref);
      assert.equal(initialPick.actor,'user');
      assert.equal(JSON.stringify(first).includes('synthetic-private-fixture'),false);
      pick(scene,added,{trusted:false});
      const native = camera.setTarget.bind(camera);
      camera.setTarget = destination => { pick(scene,added); return native(destination); };
      assert.equal(act(adapter,plan(assert,adapter,'New arrival','focus',{},'pick-in-action')).status,'dispatched');
      const picks = observe(adapter).activity.events.filter(event => event.type === 'game.picked');
      assert.deepEqual(picks.map(event => event.actor),['user','system','agent']);
      assert.ok(picks.every(event => event.target === target.ref));
      added.isVisible = false;
      pick(scene,added);
      const hidden = observe(adapter);
      assert.equal(hidden.targets.some(candidate => candidate.ref === target.ref),false);
      assert.equal(hidden.activity.events.at(-1).target,undefined);
      record('pick awareness',{target:target.ref,actors:picks.map(event => event.actor),privateMetadataExcluded:true,hiddenTargetExcluded:true});
    })
  },
  {
    id:'game.scene_disposal',version:1,title:'Scene teardown fences queued work and retains receipts',kind:'game',difficulty:'adversarial',
    description:'Dispose the scene inside a native focus callback while its receipt is pending; later commands must reject and exact retry must not execute.',
    run:async ({assert,seed,record,installBabylon}) => withScene(seed,installBabylon,async ({scene,camera,adapter}) => {
      const queued = plan(assert,adapter,'Target','highlight',{enabled:true},'queued-before-close');
      const command = plan(assert,adapter,'Target','focus',{},'close-during-focus');
      const native = camera.setTarget.bind(camera);
      let observedPending, calls = 0;
      camera.setTarget = destination => {
        calls++; native(destination);
        observedPending = outcome(adapter,command.id);
        scene.dispose();
      };
      const receipt = act(adapter,command);
      assert.equal(observedPending.status,'pending');
      assert.equal(receipt.status,'dispatched','The native invocation returned; this does not promise a rendered frame');
      assert.equal(scene.isDisposed,true);
      assert.throws(() => observe(adapter),{code:'SURFACE_DISPOSED'});
      const rejected = act(adapter,queued);
      assert.equal(rejected.code,'SURFACE_DISPOSED');
      assert.deepEqual(outcome(adapter,command.id),receipt);
      assert.deepEqual(act(adapter,command),receipt);
      assert.equal(calls,1);
      assert.equal(scene.onPointerObservable.observers.length,0);
      record('scene teardown',{duringCallback:summary(observedPending),retained:summary(receipt),queued:summary(rejected),nativeExecutions:calls,observersRemoved:true});
    })
  },
  {
    id:'game.instance_aggregate',version:1,title:'Thin instances stay an explicit aggregate boundary',kind:'game',difficulty:'intermediate',
    description:'Use a real Babylon thin-instance buffer, verify aggregate discovery and picks, and reject invented per-instance commands or gameplay actions.',
    run:async ({assert,seed,record,installBabylon}) => withScene(seed,installBabylon,async ({scene,mesh,adapter,random}) => {
      const count = 2 + Math.floor(random()*4), buffer = new Float32Array(count*16);
      for (let index=0; index<count; index++) buffer.set(Matrix.Translation(index*2,0,0).asArray(),index*16);
      // NullEngine has no GPU instancing extension. The engine's actual buffer API
      // still exercises instance state; this scenario makes no pixel-rendering claim.
      mesh.thinInstanceSetBuffer('matrix',buffer,16);
      const observation = observe(adapter), target = observation.targets.find(candidate => candidate.name === 'Target');
      assert.equal(target.state.thinInstanceCount,count);
      assert.equal(observation.limits.thinInstances,'aggregate-only');
      assert.deepEqual(target.actions,['focus','highlight']);
      pick(scene,mesh,{instance:count-1});
      assert.equal(observe(adapter).activity.events.at(-1).target,target.ref);
      const individual = act(adapter,plan(assert,adapter,'Target','highlight',{enabled:true,instanceIndex:1},'invented-instance'));
      assert.equal(individual.code,'INVALID_ACTION_ARGUMENTS');
      assert.equal(mesh.showBoundingBox,false);
      const gameplay = act(adapter,{...plan(assert,adapter,'Target','focus',{},'invented-gameplay'),action:'move'});
      assert.equal(gameplay.code,'ACTION_UNAVAILABLE');
      assert.equal(act(adapter,plan(assert,adapter,'Target','highlight',{enabled:true},'aggregate-highlight')).status,'dispatched');
      assert.equal(mesh.showBoundingBox,true);
      assert.deepEqual(Array.from(mesh.thinInstanceGetWorldMatrices().flatMap(matrix => Array.from(matrix.asArray()))),Array.from(buffer));
      record('instance boundary',{instances:count,publicTargets:observation.targets.filter(candidate => candidate.ref === target.ref).length,
        individual:summary(individual),gameplay:summary(gameplay),aggregateHighlighted:true,instanceTransformsPreserved:true});
    })
  },
  {
    id:'game.effect_failure_uncertainty',version:1,title:'Post-effect failures remain uncertain',kind:'game',difficulty:'adversarial',
    description:'Throw a validation-shaped callback error after the camera changes; preserve uncertainty and prove exact retry cannot repeat the effect.',
    run:async ({assert,seed,record,installBabylon}) => withScene(seed,installBabylon,async ({camera,mesh,adapter}) => {
      const native = camera.setTarget.bind(camera);
      let calls = 0;
      camera.setTarget = destination => {
        calls++; native(destination);
        throw new InteractionValidationError('LAB_CALLBACK_FAILED_AFTER_EFFECT');
      };
      const malformed = act(adapter,plan(assert,adapter,'Target','focus',{script:'synthetic forbidden argument'},'invalid-before-effect'));
      assert.equal(malformed.code,'INVALID_ACTION_ARGUMENTS');
      assert.equal(calls,0);
      const command = plan(assert,adapter,'Target','focus',{},'callback-after-effect'), receipt = act(adapter,command);
      assert.equal(receipt.status,'uncertain');
      assert.equal(receipt.code,'ACTION_UNCERTAIN');
      assert.ok(camera.getTarget().equalsWithEpsilon(mesh.getAbsolutePosition(),1e-6));
      assert.deepEqual(outcome(adapter,command.id),receipt);
      assert.deepEqual(act(adapter,command),receipt);
      assert.equal(calls,1);
      record('failure phase',{beforeEffect:summary(malformed),afterEffect:summary(receipt),cameraChanged:true,nativeExecutions:calls});
    })
  }
];
