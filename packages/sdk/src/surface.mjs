import {copyPlainJson, InteractionValidationError} from './events.mjs';

// Shared only within this JS realm: adapter-generated events must not become user activity
// when two adapters observe the same page.
let activeExecutions = 0;
const fail = code => { throw new InteractionValidationError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const bounded = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const copyLimits = {maxDepth:24, maxBytes:1048576, maxNodes:60000};
const copy = value => copyPlainJson(value, copyLimits);
const encoder = new TextEncoder();
function measure(value) {
  const count = item => item !== null && typeof item === 'object' ? 1 + Object.values(item).reduce((sum, child) => sum + count(child), 0) : 1;
  return {bytes:encoder.encode(JSON.stringify(value)).length, nodes:count(value)};
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const deepFreeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; };
const schema = (properties, required = Object.keys(properties)) => ({type:'object', properties, required, additionalProperties:false});
const string = {type:'string', minLength:1, maxLength:160};
export const SURFACE_TOOLS = deepFreeze([
  {name:'surface_observe', description:'Read the current structured interface, available target actions, and recent interaction events. No screenshot. Use its adapterId and revision for the next action.', parameters:schema({})},
  {name:'surface_act', description:'Invoke an advertised action on an observed target. Read target actionSchemas for arguments. Reuse the exact same id and request after a lost reply; never invent a new id to retry. Dispatched is not application success.', parameters:schema({adapterId:string, id:string, revision:{type:'integer', minimum:0}, target:string, action:string, arguments:{type:'object'}}, ['adapterId','id','revision','target','action','arguments'])},
  {name:'surface_get_outcome', description:'Read the retained receipt of an action by id in this adapter lifetime. Null means no retained receipt; it does not prove that an external application did nothing.', parameters:schema({id:string})}
]);

/** Internal kernel for synchronous, in-process adapters. It is not a transaction manager. */
export function createSurfaceAdapter({kind, adapterId = globalThis.crypto?.randomUUID?.(), sample, execute, validate = () => {},
  maxReceipts = 1000, maxEvents = 1000} = {}) {
  if (!['website','game','app'].includes(kind) || !identifier(adapterId) || typeof sample !== 'function' || typeof execute !== 'function'
      || typeof validate !== 'function' || !bounded(maxReceipts,10000) || !bounded(maxEvents,10000)) fail('INVALID_SURFACE_OPTIONS');
  const receipts = new Map(), listeners = new Set(), cleanups = new Set(), events = [], eventSizes = new WeakMap();
  let disposed = false, processing = false, sampling = false, notifying = false, revision = 0, signature, cursor = 0;
  const ensure = () => { if (disposed) fail('SURFACE_DISPOSED'); };
  function refresh() {
    ensure();
    if (sampling) fail('SURFACE_BUSY');
    sampling = true;
    try {
      const value = copy(sample());
      ensure();
      if (!object(value) || !Array.isArray(value.targets) || value.targets.length > 2000
          || value.targets.some(target => !object(target) || !identifier(target.ref) || !Array.isArray(target.actions)
            || target.actions.some(action => !identifier(action)))
          || new Set(value.targets.map(target => target.ref)).size !== value.targets.length) fail('INVALID_SURFACE_SAMPLE');
      // Only the designated per-target pose sample is non-semantic. A domain
      // state or action schema may legitimately contain a property named sample.
      const next = canonical({...value, targets:value.targets.map(({sample:pose, ...target}) => target)});
      if (signature !== undefined && signature !== next) revision++;
      signature = next;
      return {...value, adapterId, kind, revision, sampledAt:Date.now()};
    } finally { sampling = false; }
  }
  function history(options = {}) {
    const safe = copyPlainJson(options, {maxDepth:1,maxBytes:1024});
    if (!object(safe) || Object.keys(safe).some(key => !['after','limit'].includes(key))
        || !Number.isSafeInteger(safe.after ?? 0) || (safe.after ?? 0) < 0 || (safe.after ?? 0) > cursor
        || !bounded(safe.limit ?? Math.min(maxEvents,100), maxEvents)) fail('INVALID_SURFACE_CURSOR');
    const after = safe.after ?? 0, limit = safe.limit ?? Math.min(maxEvents,100);
    const eligible = events.filter(event => event.cursor > after);
    const result = {adapterId, events:[], nextCursor:cursor, cursor,
      oldestCursor:events[0]?.cursor ?? cursor + 1, gap:after < (events[0]?.cursor ?? 1) - 1, hasMore:false};
    let {bytes, nodes} = measure(result);
    for (const event of eligible) {
      if (result.events.length >= limit) break;
      const size = eventSizes.get(event), addedBytes = size.bytes + (result.events.length ? 1 : 0);
      if (bytes + addedBytes > copyLimits.maxBytes || nodes + size.nodes > copyLimits.maxNodes) break;
      result.events.push(event); bytes += addedBytes; nodes += size.nodes;
    }
    result.nextCursor = result.events.at(-1)?.cursor ?? after;
    result.hasMore = eligible.length > result.events.length;
    return copy(result);
  }
  function record(input) {
    if (disposed) return;
    const value = copyPlainJson(input, {maxDepth:8,maxBytes:16384,maxNodes:1000});
    if (!object(value) || !identifier(value.type) || !['user','agent','system'].includes(value.actor)) fail('INVALID_SURFACE_EVENT');
    const event = {...value, adapterId, cursor:++cursor, timestamp:Date.now()};
    eventSizes.set(event, measure(event));
    events.push(event); if (events.length > maxEvents) events.shift();
    // Nested records remain in history but do not recursively notify listeners.
    if (!notifying) {
      notifying = true;
      try {
        for (const listener of [...listeners]) {
          if (!listeners.has(listener)) continue;
          try { Promise.resolve(listener(copy(event))).catch(() => {}); } catch { /* observers cannot break UI actions */ }
        }
      } finally { notifying = false; }
    }
    return copy(event);
  }
  const reject = (request, code) => ({adapterId,id:request.id,status:'rejected',code,revisionBefore:revision});
  function act(input) {
    const request = copyPlainJson(input, {maxDepth:8,maxBytes:32768,maxNodes:4096});
    if (!object(request) || Object.keys(request).some(key => !['adapterId','id','revision','target','action','arguments'].includes(key))
        || !['adapterId','id','target','action'].every(key => identifier(request[key]))
        || !Number.isSafeInteger(request.revision) || request.revision < 0
        || request.arguments !== undefined && !object(request.arguments)) fail('INVALID_SURFACE_ACTION');
    request.arguments ??= {};
    const key = canonical(request), retained = receipts.get(request.id);
    if (retained) return copy(retained.key === key ? retained.receipt : reject(request,'ID_REUSE_CONFLICT'));
    if (request.adapterId !== adapterId) return reject(request,'ADAPTER_MISMATCH');
    if (disposed) return reject(request,'SURFACE_DISPOSED');
    if (receipts.size >= maxReceipts) return reject(request,'RECEIPT_CAPACITY');
    const entry = {key, receipt:{adapterId,id:request.id,status:'pending',revisionBefore:revision}};
    receipts.set(request.id,entry);
    if (processing || sampling || notifying) {entry.receipt = reject(request,'SURFACE_BUSY'); return copy(entry.receipt);}
    // Admission covers sampling and validation too: neither callback may start a
    // second action from the revision being checked by the first one.
    processing = true;
    try {
      let before;
      try { before = refresh(); } catch {entry.receipt = reject(request,disposed ? 'SURFACE_DISPOSED' : 'SURFACE_UNAVAILABLE'); return copy(entry.receipt);}
      const target = before.targets.find(candidate => candidate.ref === request.target);
      const code = request.revision !== before.revision ? 'STALE_SURFACE' : !target ? 'TARGET_UNAVAILABLE'
        : !target.actions.includes(request.action) ? 'ACTION_UNAVAILABLE' : null;
      if (code) {entry.receipt = reject(request,code); return copy(entry.receipt);}
      try {
        const validation = validate(copy(request),copy(before));
        if (validation && typeof validation.then === 'function') {Promise.resolve(validation).catch(() => {}); throw new Error('Async validation is not supported');}
        ensure();
      } catch (error) {
        entry.receipt = reject(request, error instanceof InteractionValidationError && /^[A-Z_]+$/.test(error.code) ? error.code : 'VALIDATION_FAILED');
        return copy(entry.receipt);
      }
      entry.receipt.revisionBefore = before.revision;
      activeExecutions++;
      try {
        const result = execute(copy(request),copy(before));
        if (result && typeof result.then === 'function') {Promise.resolve(result).catch(() => {}); throw new Error('Async execution is not supported');}
        const safe = copy(result);
        if (!object(safe) || !['dispatched','completed'].includes(safe.status)) throw new Error('Invalid execution receipt');
        entry.receipt = {adapterId,id:request.id,status:safe.status,revisionBefore:before.revision};
        try {entry.receipt.revisionAfter = refresh().revision;} catch { /* navigation/disposal can prevent another observation */ }
      } catch (error) {
        entry.receipt = {adapterId,id:request.id,status:'uncertain',
          code:'ACTION_UNCERTAIN',revisionBefore:before.revision};
      } finally {
        try {record({type:'action',actor:'agent',operationId:request.id,target:request.target,action:request.action,status:entry.receipt.status});}
        finally {activeExecutions--;}
      }
      return copy(entry.receipt);
    } finally { processing = false; }
  }
  function observe() {
    const snapshot = refresh();
    // Bounded recent history makes a normal agent observation aware of human input,
    // without requiring a separate analytics service or subscription transport.
    return {...snapshot, activity:history({after:Math.max(0,cursor - Math.min(maxEvents,20)),limit:Math.min(maxEvents,20)})};
  }
  function getOutcome(id) {if (!identifier(id)) fail('INVALID_OPERATION_ID'); return receipts.has(id) ? copy(receipts.get(id).receipt) : null;}
  const tools = copy(SURFACE_TOOLS);
  function callTool(name, args = {}) {
    const safe = copyPlainJson(args, {maxDepth:8,maxBytes:32768,maxNodes:4096});
    if (!object(safe)) fail('INVALID_TOOL_ARGUMENTS');
    if (name === 'surface_observe' && !Object.keys(safe).length) return observe();
    if (name === 'surface_act') return act(safe);
    if (name === 'surface_get_outcome' && Object.keys(safe).length === 1 && Object.hasOwn(safe,'id')) return getOutcome(safe.id);
    fail('INVALID_SURFACE_TOOL');
  }
  return Object.freeze({observe,act,getOutcome,history,callTool,get tools() {return copy(tools);},record,
    isActing:() => activeExecutions > 0,
    subscribe(listener) {ensure(); if (typeof listener !== 'function') fail('INVALID_LISTENER'); if(listeners.size >= 100) fail('SURFACE_LISTENER_LIMIT'); listeners.add(listener); return () => listeners.delete(listener);},
    onDispose(cleanup) {ensure(); if (typeof cleanup !== 'function') fail('INVALID_CLEANUP'); cleanups.add(cleanup);},
    dispose() {if(disposed)return; disposed = true; listeners.clear(); for (const cleanup of cleanups) {try{cleanup();}catch{/* cleanup is best effort */}} cleanups.clear();}
  });
}
