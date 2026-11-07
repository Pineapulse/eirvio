import {copyPlainJson, InteractionValidationError} from './events.mjs';

const limits = {maxDepth:32, maxBytes:65536, maxNodes:4096};
const copy = value => copyPlainJson(value, limits);
const fail = code => { throw new InteractionValidationError(code); };
const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !reserved.has(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const viewValid = view => keys(view, ['viewId','viewEpoch','interactionRevision']) && id(view.viewId) && integer(view.viewEpoch) && integer(view.interactionRevision);
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
function observation(value) {
  const result = copy(value);
  if (!keys(result, ['protocolVersion','observationId','runtimeId','sceneId','sceneKind','sceneRevision','runtimeFence','controlRevision','scope','eventCursor','projection','capabilities','partial'], ['view'])
      || result.protocolVersion !== '0.1.0' || !['observationId','runtimeId','sceneId','runtimeFence'].every(key => id(result[key]))
      || !['canonical','demonstration','practice'].includes(result.sceneKind)
      || !['sceneRevision','controlRevision','eventCursor'].every(key => integer(result[key]))
      || !keys(result.scope, ['id','epoch','status']) || !id(result.scope.id) || !integer(result.scope.epoch) || !['active','closed'].includes(result.scope.status)
      || result.view !== undefined && !viewValid(result.view) || !object(result.projection) || typeof result.partial !== 'boolean'
      || !Array.isArray(result.capabilities) || !result.capabilities.every(id)) fail('INVALID_OBSERVATION');
  return result;
}
function command(value) {
  const result = copy(value), guards = result?.guards;
  if (!keys(result, ['protocolVersion','commandId','runtimeId','target','operation','arguments','guards'])
      || result.protocolVersion !== '0.1.0' || !id(result.commandId) || !id(result.runtimeId) || !id(result.operation)
      || !keys(result.target, ['sceneId'], ['objectId']) || !id(result.target.sceneId) || result.target.objectId !== undefined && !id(result.target.objectId)
      || !object(result.arguments) || !keys(guards, ['runtimeFence','expectedSceneRevision','scopeId','scopeEpoch'], ['view'])
      || !id(guards.runtimeFence) || !id(guards.scopeId) || !integer(guards.scopeEpoch) || !integer(guards.expectedSceneRevision)
      || guards.view !== undefined && !viewValid(guards.view)) fail('INVALID_COMMAND');
  return result;
}
function controlEnvelope(value) {
  const result = copy(value);
  if (!keys(result, ['protocolVersion','operationId','runtimeId','action','runtimeFence','expectedControlRevision','scopeId','scopeEpoch','sceneId'], ['view'])
      || result.protocolVersion !== '0.1.0' || !['interrupt','closeScope'].includes(result.action)
      || !['operationId','runtimeId','runtimeFence','scopeId','sceneId'].every(key => id(result[key]))
      || !integer(result.expectedControlRevision) || !integer(result.scopeEpoch)
      || result.view !== undefined && !viewValid(result.view)) fail('INVALID_CONTROL');
  return result;
}
function outcome(value, expectedId) {
  const result = copy(value);
  if (!keys(result, ['protocolVersion','operationId','status','eventCursor'], ['code','sceneId','previousRevision','sceneRevision','result'])
      || result.protocolVersion !== '0.1.0' || result.operationId !== expectedId || !integer(result.eventCursor)
      || !['committed','rejected','completed','canceled','failed','degraded','admitted','waiting'].includes(result.status)
      || ['code','sceneId'].some(key => result[key] !== undefined && !id(result[key]))
      || ['previousRevision','sceneRevision'].some(key => result[key] !== undefined && !integer(result[key]))
      || result.result !== undefined && !object(result.result)) fail('INVALID_TRANSPORT_RESPONSE');
  return result;
}

/** Pure: copies the supplied basis, without observing, rebasing or submitting. */
export function prepare(name, properties, {observation:basis, commandId} = {}) {
  const current = observation(basis);
  if (!id(name) || !id(commandId)) fail('INVALID_COMMAND');
  if (current.scope.status !== 'active') fail('SCOPE_CLOSED');
  if (!current.capabilities.includes(name)) fail('CAPABILITY_UNAVAILABLE');
  return freeze(command({protocolVersion:'0.1.0', commandId, runtimeId:current.runtimeId,
    target:{sceneId:current.sceneId}, operation:name, arguments:properties,
    guards:{runtimeFence:current.runtimeFence, expectedSceneRevision:current.sceneRevision,
      scopeId:current.scope.id, scopeEpoch:current.scope.epoch, ...(current.view ? {view:current.view} : {})}}));
}
export function prepareControl(action, {observation:basis, operationId} = {}) {
  const current = observation(basis);
  if (current.scope.status !== 'active') fail('SCOPE_CLOSED');
  return freeze(controlEnvelope({protocolVersion:'0.1.0', operationId, runtimeId:current.runtimeId, action,
    runtimeFence:current.runtimeFence, expectedControlRevision:current.controlRevision,
    scopeId:current.scope.id, scopeEpoch:current.scope.epoch, sceneId:current.sceneId,
    ...(current.view ? {view:current.view} : {})}));
}

// Only known pre-admission native errors are definite. Unknown exceptions and
// malformed replies are uncertain even if they resemble network/client errors.
const definite = new Set(['INVALID_SCHEMA','UNSUPPORTED_VERSION','FORBIDDEN','RESOURCE_LIMIT','STALE_WRITER',
  'RECOVERY_REQUIRED','REENTRANT_WRITE','OUTCOME_UNKNOWN','HOST_BOUNDARY_VIOLATION','HOST_ACTION_UNAVAILABLE',
  'HOST_CONTROL_FORBIDDEN','HOST_OUTCOME_UNAVAILABLE','INVALID_HOST_CONTEXT','INVALID_HOST_CONFIGURATION']);
export class InteractionTransportError extends Error {
  constructor(operation, cause, request) {
    const uncertain = operation === 'submit' || operation === 'control';
    super(uncertain ? 'No trustworthy outcome was received. The operation may have committed; retry the exact envelope or look up its ID.' : 'The transport did not return a trustworthy response.', {cause});
    this.name = 'InteractionTransportError'; this.code = uncertain ? 'TRANSPORT_UNCERTAIN' : 'TRANSPORT_ERROR';
    this.operation = operation; this.uncertain = uncertain;
    if (uncertain && request) {
      this.request = freeze(copy(request));
      this.operationId = request.commandId ?? request.operationId;
      if (operation === 'submit') this.command = this.request;
      if (operation === 'control') this.control = this.request;
    }
  }
}

/** Transport methods may be synchronous (an in-process host) or promises. */
export function createInteractionClient({transport, events} = {}) {
  if (!transport || !['observe','catalog','submit','getOutcome'].every(name => typeof transport[name] === 'function')
      || events !== undefined && (!events || typeof events.track !== 'function')) fail('INVALID_CLIENT_OPTIONS');
  const methods = Object.fromEntries(['observe','catalog','submit','getOutcome','control'].filter(name => typeof transport[name] === 'function').map(name => [name, transport[name].bind(transport)]));
  function report(name, properties) {
    if (!events) return;
    try { Promise.resolve(events.track(name, properties, {actor:'system', correlationId:properties.operationId})).catch(() => {}); }
    catch { /* undeclared or failed diagnostics never affect actions */ }
  }
  async function send(method, request, validate) {
    try { return validate(await (request === undefined ? methods[method]() : methods[method](copy(request)))); }
    catch (error) { if (definite.has(error?.code)) throw error; throw new InteractionTransportError(method, error, request); }
  }
  async function mutate(method, request) {
    const properties = {kind:method === 'submit' ? 'command' : 'control', operationId:request.commandId ?? request.operationId, operation:request.operation ?? request.action};
    report('interaction.submitted', properties);
    try {
      const result = await send(method, request, value => {
        const reply = outcome(value, properties.operationId);
        if (!['committed','rejected'].includes(reply.status)) fail('INVALID_TRANSPORT_RESPONSE');
        if (method === 'submit' && reply.status === 'committed'
            && (reply.sceneId !== request.target.sceneId || reply.previousRevision !== request.guards.expectedSceneRevision
              || reply.sceneRevision !== request.guards.expectedSceneRevision + 1 || !object(reply.result))) fail('INVALID_TRANSPORT_RESPONSE');
        return reply;
      });
      report('interaction.outcome', {...properties, status:result.status}); return result;
    } catch (error) {
      if (error instanceof InteractionTransportError && error.uncertain) report('interaction.uncertain', properties);
      throw error;
    }
  }
  return Object.freeze({
    observe: () => send('observe', undefined, observation),
    catalog: () => send('catalog', undefined, value => {
      const result = copy(value);
      if (!Array.isArray(result) || result.some(item => !keys(item, ['name','description','parameters']) || !id(item.name)
          || typeof item.description !== 'string' || !object(item.parameters) || item.parameters.type !== 'object')) fail('INVALID_TRANSPORT_RESPONSE');
      return result;
    }),
    prepare,
    submit: async value => { const prepared = command(value); return mutate('submit', prepared); },
    act: async (name, properties, options) => mutate('submit', prepare(name, properties, options)),
    getOutcome: async operationId => { if (!id(operationId)) fail('INVALID_OPERATION_ID'); return send('getOutcome', operationId, value => outcome(value, operationId)); },
    prepareControl,
    control: async value => { if (!methods.control) fail('CONTROL_UNAVAILABLE'); return mutate('control', controlEnvelope(value)); },
  });
}
