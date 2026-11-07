import {createSurfaceAdapter} from './surface.mjs';
import {copyPlainJson, InteractionValidationError} from './events.mjs';

const fail = code => { throw new InteractionValidationError(code); };
const ownValue = (object, key) => object && typeof object === 'object'
  ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
const alive = node => node && !(typeof node.isDisposed === 'function' ? node.isDisposed() : node.isDisposed);
const visible = mesh => alive(mesh) && typeof mesh.isEnabled === 'function' && mesh.isEnabled()
  && mesh.isVisible !== false && (mesh.visibility === undefined || mesh.visibility > 0);
const name = node => typeof node.name === 'string' ? node.name.slice(0,160) : '';
const vector = value => value && ['x','y','z'].every(key => Number.isFinite(value[key]) && Math.abs(value[key]) <= Number.MAX_SAFE_INTEGER)
  ? {x:value.x,y:value.y,z:value.z} : null;
const focusSchema = {type:'object',properties:{},additionalProperties:false};
const highlightSchema = {type:'object',properties:{enabled:{type:'boolean'}},required:['enabled'],additionalProperties:false};
// Babylon PointerEventTypes values; no engine import or bundled engine is needed.
const pointerTypes = new Map([[1,'game.pointer_down'],[2,'game.pointer_up'],[8,'game.pointer_wheel'],[16,'game.picked']]);
// A mesh presentation property has one adapter owner at a time. This is shared
// across installations so disposing one cannot undo another adapter's request.
const highlightOwners = new WeakMap();

/** Inspect existing scene objects and dispatch presentation-only focus/highlight actions.
 * Mesh refs identify objects, never mesh names. Thin instances remain one aggregate
 * target; individual instances and semantic gameplay need an application adapter.
 */
export function installBabylon({scene, adapterId, maxTargets = 200, maxReceipts, maxEvents, metadataNamespaces = []} = {}) {
  if (!scene || !Array.isArray(scene.meshes) || !scene.onDisposeObservable?.add || !scene.onDisposeObservable?.remove
      || !scene.onPointerObservable?.add || !scene.onPointerObservable?.remove
      || !Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > 500
      || !Array.isArray(metadataNamespaces) || metadataNamespaces.length > 8
      || new Set(metadataNamespaces).size !== metadataNamespaces.length
      || metadataNamespaces.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(key)
        || ['constructor','prototype','__proto__'].includes(key))) fail('INVALID_BABYLON_OPTIONS');
  if (scene.isDisposed) fail('SCENE_DISPOSED');
  const namespaces = [...metadataNamespaces], identities = new WeakMap(), ownedHighlights = new Map(), ownerToken = {};
  let serial = 0, current = new Map(), prepared;
  const ref = (node, prefix) => {
    if (!identities.has(node)) identities.set(node, `${prefix}-${++serial}`);
    return identities.get(node);
  };
  const activeCamera = () => alive(scene.activeCamera) ? scene.activeCamera : null;
  function sample() {
    if (scene.isDisposed) fail('SCENE_DISPOSED');
    const targets = [], next = new Map(), camera = activeCamera();
    let metadataBudget = 16384, eligibleMeshes = 0;
    const cameraRef = camera ? ref(camera,'camera') : null;
    if (camera) {
      targets.push({ref:cameraRef,role:'camera',name:name(camera),actions:[],
        state:{active:true,canFocus:typeof camera.setTarget === 'function',parent:camera.parent ? ref(camera.parent,'node') : null},
        sample:{position:vector(camera.position),target:typeof camera.getTarget === 'function' ? vector(camera.getTarget()) : null}});
    }
    for (const mesh of scene.meshes) {
      if (!visible(mesh)) continue;
      eligibleMeshes++;
      if (targets.length >= maxTargets) continue;
      const meshRef = ref(mesh,'mesh'), actions = [], actionSchemas = {};
      if (camera && typeof camera.setTarget === 'function' && typeof mesh.getAbsolutePosition === 'function') {
        actions.push('focus'); actionSchemas.focus = focusSchema;
      }
      if (typeof mesh.showBoundingBox === 'boolean') { actions.push('highlight'); actionSchemas.highlight = highlightSchema; }
      const state = {enabled:true,visible:true,pickable:mesh.isPickable === true,highlighted:mesh.showBoundingBox === true,
        thinInstanceCount:Number.isSafeInteger(mesh.thinInstanceCount) && mesh.thinInstanceCount >= 0 ? mesh.thinInstanceCount : 0};
      const metadata = ownValue(mesh,'metadata'), exposed = {};
      for (const namespace of namespaces) {
        const value = ownValue(metadata,namespace);
        if (value === undefined || metadataBudget < 128) continue;
        try {
          const safe = copyPlainJson(value,{maxDepth:4,maxBytes:Math.min(1024,metadataBudget),maxNodes:64});
          // Limit aggregate metadata as well as each explicitly admitted namespace.
          metadataBudget -= new TextEncoder().encode(JSON.stringify(safe)).length + namespace.length + 4;
          if (metadataBudget >= 0) exposed[namespace] = safe;
        } catch { /* Private, executable, cyclic or oversized values are never exported. */ }
      }
      if (Object.keys(exposed).length) state.metadata = exposed;
      targets.push({ref:meshRef,role:'mesh',name:name(mesh),state,actions,actionSchemas,
        sample:{position:vector(mesh.position),worldPosition:typeof mesh.getAbsolutePosition === 'function' ? vector(mesh.getAbsolutePosition()) : null}});
      next.set(meshRef,{mesh,camera,cameraRef});
    }
    current = next;
    return {targets,activeCamera:cameraRef,truncated:Math.max(0,eligibleMeshes - next.size),
      limits:{maxTargets,thinInstances:'aggregate-only',actions:'presentation-only'}};
  }
  function validate(request) {
    prepared = undefined;
    const entry = current.get(request.target), args = request.arguments;
    if (!entry || !visible(entry.mesh) || !scene.meshes.includes(entry.mesh)) fail('TARGET_UNAVAILABLE');
    const {mesh,camera} = entry;
    if (request.action === 'focus') {
      if (Object.keys(args).length) fail('INVALID_ACTION_ARGUMENTS');
      if (!camera || camera !== activeCamera() || typeof camera.setTarget !== 'function') fail('CAMERA_UNAVAILABLE');
      const position = mesh.getAbsolutePosition();
      if (!vector(position) || typeof position.clone !== 'function') fail('INVALID_MESH_POSITION');
      const destination = position.clone();
      // Babylon camera targets are local to the camera's parent, if there is one.
      if (camera.parent) {
        const matrix = camera.parent.computeWorldMatrix?.(true)?.clone();
        if (!matrix || typeof matrix.invert !== 'function' || !Number.isFinite(matrix.determinant()) || matrix.determinant() === 0) fail('CAMERA_UNAVAILABLE');
        matrix.invert();
        const m = matrix.m, {x,y,z} = destination, w = x*m[3] + y*m[7] + z*m[11] + m[15];
        destination.x = (x*m[0] + y*m[4] + z*m[8] + m[12]) / w;
        destination.y = (x*m[1] + y*m[5] + z*m[9] + m[13]) / w;
        destination.z = (x*m[2] + y*m[6] + z*m[10] + m[14]) / w;
        if (!vector(destination)) fail('CAMERA_UNAVAILABLE');
      }
      prepared = () => camera.setTarget(destination);
    } else if (request.action === 'highlight') {
      if (Object.keys(args).length !== 1 || typeof args.enabled !== 'boolean') fail('INVALID_ACTION_ARGUMENTS');
      if (typeof mesh.showBoundingBox !== 'boolean') fail('ACTION_UNAVAILABLE');
      const existing = highlightOwners.get(mesh);
      if (existing && mesh.showBoundingBox !== existing.lastApplied) highlightOwners.delete(mesh);
      else if (existing && existing.owner !== ownerToken) fail('HIGHLIGHT_OWNED');
      prepared = () => {
        let ownership = highlightOwners.get(mesh);
        const before = mesh.showBoundingBox;
        // A later application write relinquishes our old ownership.
        if (ownership && before !== ownership.lastApplied) { highlightOwners.delete(mesh); ownedHighlights.delete(mesh); ownership = undefined; }
        if (before === args.enabled) return;
        ownership ??= {before,lastApplied:args.enabled,owner:ownerToken};
        ownership.lastApplied = args.enabled;
        ownedHighlights.set(mesh,ownership);
        highlightOwners.set(mesh,ownership);
        mesh.showBoundingBox = args.enabled;
        if (args.enabled === ownership.before) { ownedHighlights.delete(mesh); highlightOwners.delete(mesh); }
      };
    } else fail('ACTION_UNAVAILABLE');
  }
  const kernel = createSurfaceAdapter({kind:'game',adapterId,maxReceipts,maxEvents,sample,validate,
    execute() {
      const effect = prepared; prepared = undefined;
      const result = effect();
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new Error('Asynchronous Babylon actions are unsupported');
      }
      return {status:'dispatched'};
    }});
  const subscriptions = [];
  function listen(observable, listener) {
    if (!observable?.add || !observable?.remove) return;
    const token = observable.add(listener);
    subscriptions.push(() => observable.remove(token));
  }
  kernel.onDispose(() => {
    for (const unsubscribe of subscriptions) { try { unsubscribe(); } catch { /* Continue independent cleanup. */ } }
    for (const [mesh,ownership] of ownedHighlights) {
      if (highlightOwners.get(mesh) !== ownership) continue;
      highlightOwners.delete(mesh);
      try { if (alive(mesh) && mesh.showBoundingBox === ownership.lastApplied) mesh.showBoundingBox = ownership.before; } catch { /* Scene teardown may already own the mesh. */ }
    }
    ownedHighlights.clear(); current.clear(); prepared = undefined;
  });
  try {
    listen(scene.onDisposeObservable,() => kernel.dispose());
    listen(scene.onPointerObservable,info => {
      const type = pointerTypes.get(info.type);
      if (!type) return;
      const picked = info.pickInfo?.pickedMesh;
      // Meshes can appear between observations. Refresh the bounded public map
      // before naming a new pick; never publish unobserved or hidden objects.
      if (picked && visible(picked) && scene.meshes.includes(picked)) {
        try { kernel.observe(); } catch { return; }
      }
      const target = picked && visible(picked) && scene.meshes.includes(picked) ? identities.get(picked) : undefined;
      const actor = kernel.isActing() ? 'agent' : info.event?.isTrusted === false ? 'system' : 'user';
      const event = {type,actor};
      if (target && current.has(target)) event.target = target;
      if (Number.isInteger(info.event?.button) && info.event.button >= -1 && info.event.button <= 5) event.button = info.event.button;
      kernel.record(event);
    });
    listen(scene.onActiveCameraChanged,() => kernel.record({type:'game.camera_changed',actor:kernel.isActing() ? 'agent' : 'system'}));
    // Establish identity before the first interaction, and reject unusable scenes at install.
    kernel.observe();
  } catch (error) { kernel.dispose(); throw error; }
  return Object.freeze({observe:kernel.observe,act:kernel.act,getOutcome:kernel.getOutcome,history:kernel.history,
    subscribe:kernel.subscribe,callTool:kernel.callTool,dispose:kernel.dispose,get tools() { return kernel.tools; }});
}
