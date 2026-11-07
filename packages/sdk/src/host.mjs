import {DomainError, validate} from '../../core/src/index.mjs';

const MAX_BYTES = 65_536;
const MAX_NODES = 4_096;
const MAX_DEPTH = 32;
const MAX_ACTIONS = 64;
const scopedControls = new Set(['interrupt', 'closeScope']);
const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);
const fail = code => { throw new DomainError(code); };
const own = (value, key) => Object.hasOwn(value, key);

// Treat direct calls like JSON transport input. Reject accessors, exotic objects,
// cycles and non-JSON values before handing a detached value to the runtime.
function boundedJSON(value) {
  let nodes = 0, bytes = 0;
  const parents = new Set();
  const count = n => { bytes += n; if (bytes > MAX_BYTES) fail('RESOURCE_LIMIT'); };
  function visit(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('RESOURCE_LIMIT');
    if (item === null || typeof item === 'boolean') { count(5); return item; }
    if (typeof item === 'string') { count(Buffer.byteLength(item, 'utf8') + 2); return item; }
    if (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= Number.MAX_SAFE_INTEGER) {
      count(24); return item;
    }
    if (!item || typeof item !== 'object' || parents.has(item)) fail('INVALID_SCHEMA');
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('INVALID_SCHEMA');
    const keys = Reflect.ownKeys(item);
    if (keys.length > MAX_NODES) fail('RESOURCE_LIMIT');
    const result = array ? [] : {};
    if (array && item.length > MAX_NODES) fail('RESOURCE_LIMIT');
    parents.add(item); count(2);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || dangerousKeys.has(key)) fail('INVALID_SCHEMA');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) fail('INVALID_SCHEMA');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !own(descriptor, 'value')) fail('INVALID_SCHEMA');
      count(Buffer.byteLength(key, 'utf8') + 4);
      result[key] = visit(descriptor.value, depth + 1);
    }
    if (array && Object.keys(result).length !== item.length) fail('INVALID_SCHEMA');
    parents.delete(item);
    return result;
  }
  const result = visit(value, 0);
  // Escaping can make the serialized form larger than the traversal estimate.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES) fail('RESOURCE_LIMIT');
  return result;
}

function actionCatalog(input) {
  const actions = boundedJSON(input);
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) fail('INVALID_HOST_CONFIGURATION');
  const names = new Set();
  for (const action of actions) {
    if (!action || Array.isArray(action) || typeof action !== 'object' ||
        Object.keys(action).sort().join(',') !== 'description,name,parameters' ||
        typeof action.description !== 'string' || action.description.length > 2_000 ||
        !action.parameters || Array.isArray(action.parameters) || action.parameters.type !== 'object') {
      fail('INVALID_HOST_CONFIGURATION');
    }
    validate('id', action.name);
    if (names.has(action.name)) fail('INVALID_HOST_CONFIGURATION');
    names.add(action.name);
  }
  return {actions, names};
}

/**
 * A synchronous, public projection boundary around a trusted native Runtime.
 * JSON Schema parameters describe tools; registered domain validators decide
 * whether an action is legal. No provider, model, telemetry or transport runs here.
 *
 * Give this boundary a dedicated scope: native scope cancellation affects that
 * scope throughout the runtime. Only interrupt/closeScope controls are exposed.
 * Control viewId confines the request; native control freshness uses runtimeFence,
 * expectedControlRevision and scopeEpoch, not the view's epoch/revision fields.
 * A real view rebind increments controlRevision. Keeping native guard ordering
 * allows exact retries of committed controls, including after host recreation.
 * Outcome admission is instance-local; after recreating a host, resubmit the exact
 * original envelope before looking up its outcome. Native idempotency is retained.
 */
export function createInteractionHost(options) {
  if (!options || typeof options !== 'object') fail('INVALID_HOST_CONFIGURATION');
  const {runtime, getContext, sceneId, scopeId, viewId} = options;
  if (!runtime || !['observe', 'submit', 'getOutcome', 'control', 'receiveReceipt'].every(k => typeof runtime[k] === 'function') ||
      typeof getContext !== 'function') fail('INVALID_HOST_CONFIGURATION');
  validate('id', sceneId); validate('id', scopeId);
  if (viewId !== undefined) validate('id', viewId);
  const {actions, names} = actionCatalog(options.actions);
  const admitted = new Set();

  function context() {
    const source = getContext();
    if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.then === 'function') fail('INVALID_HOST_CONTEXT');
    validate('id', source.runtimeId);
    const allowed = (key, value) => source.admin === true || (Array.isArray(source[key]) && source[key].includes(value));
    return {
      runtimeId: source.runtimeId,
      // Never pass the administrative bypass, private audience, or unrelated grants.
      audience: 'public',
      scenes: allowed('scenes', sceneId) ? [sceneId] : [],
      scopes: allowed('scopes', scopeId) ? [scopeId] : [],
      operations: [...names].filter(name => allowed('operations', name)),
      controls: [...scopedControls].filter(name => allowed('controls', name)),
      observe: source.admin === true || source.observe === true,
      inspect: source.admin === true || source.inspect === true,
      receipts: source.admin === true || source.receipts === true,
    };
  }
  function checkView(view) {
    if (viewId === undefined ? view !== undefined : view?.viewId !== viewId) fail('HOST_BOUNDARY_VIOLATION');
  }
  function checkBoundary(scene, scope, view) {
    if (scene !== sceneId || scope !== scopeId) fail('HOST_BOUNDARY_VIOLATION');
    checkView(view);
  }
  function observation(ctx) {
    return validate('observation', runtime.observe(sceneId, scopeId, ctx, viewId));
  }
  function mutate(id, operation) {
    try {
      const result = validate('outcome', operation());
      // A colliding foreign envelope must not authorize lookup of its result.
      if (result.code !== 'DUPLICATE_ID_MISMATCH') admitted.add(id);
      return result;
    } catch (error) {
      // This native storage error specifically means commit happened. Do not turn
      // it into a success; allow explicit outcome reconciliation by stable ID.
      if (error?.code === 'ACKNOWLEDGEMENT_LOST') admitted.add(id);
      throw error;
    }
  }

  return Object.freeze({
    observe() { return observation(context()); },
    catalog() {
      const current = observation(context());
      return structuredClone(actions.filter(action => current.capabilities.includes(action.name)));
    },
    submit(command) {
      const ctx = context(), envelope = validate('command', boundedJSON(command));
      checkBoundary(envelope.target.sceneId, envelope.guards.scopeId, envelope.guards.view);
      if (!names.has(envelope.operation)) fail('HOST_ACTION_UNAVAILABLE');
      return mutate(envelope.commandId, () => runtime.submit(envelope, ctx));
    },
    getOutcome(id) {
      const ctx = context(); validate('id', id);
      // Check inspection permission before revealing local ID membership.
      if (!ctx.inspect || !ctx.scenes.includes(sceneId) || !ctx.scopes.includes(scopeId)) fail('FORBIDDEN');
      if (!admitted.has(id)) fail('HOST_OUTCOME_UNAVAILABLE');
      return validate('outcome', runtime.getOutcome(id, ctx));
    },
    control(control) {
      const ctx = context(), envelope = validate('control', boundedJSON(control));
      if (!scopedControls.has(envelope.action)) fail('HOST_CONTROL_FORBIDDEN');
      checkBoundary(envelope.sceneId, envelope.scopeId, envelope.view);
      const fields = new Set(['protocolVersion', 'operationId', 'runtimeId', 'action', 'runtimeFence',
        'expectedControlRevision', 'scopeId', 'scopeEpoch', 'sceneId', 'view']);
      if (Object.keys(envelope).some(key => !fields.has(key))) fail('HOST_BOUNDARY_VIOLATION');
      return mutate(envelope.operationId, () => runtime.control(envelope, ctx));
    },
    receiveReceipt(receipt) {
      const ctx = context(), envelope = validate('receipt', boundedJSON(receipt));
      checkBoundary(envelope.sceneId, envelope.scopeId, envelope.view);
      return mutate(envelope.receiptId, () => runtime.receiveReceipt(envelope, ctx));
    },
  });
}
