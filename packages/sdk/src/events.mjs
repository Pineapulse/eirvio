/** Local, declared UI observations. This module never sends data or invokes actions. */
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();
export class InteractionValidationError extends Error {
  constructor(code, message = code) { super(message); this.name = 'InteractionValidationError'; this.code = code; }
}
const fail = code => { throw new InteractionValidationError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// Shared browser-safe intake. Descriptors reject getters without invoking them.
export function copyPlainJson(value, {maxDepth = 8, maxBytes = 16384, maxNodes = 10000} = {}) {
  let bytes = 0, nodes = 0;
  const ancestors = new Set();
  const charge = count => { bytes += count; if (bytes > maxBytes) fail('JSON_RESOURCE_LIMIT'); };
  function visit(input, depth) {
    if (++nodes > maxNodes || depth > maxDepth) fail('JSON_RESOURCE_LIMIT');
    if (input === null || typeof input === 'boolean') { charge(input === null ? 4 : input ? 4 : 5); return input; }
    if (typeof input === 'string') {
      if (input.length > maxBytes) fail('JSON_RESOURCE_LIMIT');
      charge(encoder.encode(JSON.stringify(input)).length); return input;
    }
    if (typeof input === 'number' && Number.isFinite(input) && Math.abs(input) <= Number.MAX_SAFE_INTEGER) {
      charge(String(input).length); return input;
    }
    if (typeof input !== 'object' || ancestors.has(input)) fail('INVALID_JSON');
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('INVALID_JSON');
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
    if (keys.length > maxNodes + 1) fail('JSON_RESOURCE_LIMIT');
    if (keys.some(key => typeof key !== 'string' || forbidden.has(key))) fail('INVALID_JSON');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) fail('INVALID_JSON');
    }
    if (array && (keys.length !== input.length + 1 || keys.some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)))) fail('INVALID_JSON');
    ancestors.add(input); charge(2);
    const result = array ? [] : {};
    let index = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (index++) charge(1);
      if (!array) { if (key.length > maxBytes) fail('JSON_RESOURCE_LIMIT'); charge(encoder.encode(JSON.stringify(key)).length + 1); }
      result[key] = visit(descriptors[key].value, depth + 1);
    }
    ancestors.delete(input);
    return result;
  }
  return visit(value, 0);
}

function checkSchema(schema, root = false) {
  if (!object(schema)) fail('INVALID_EVENT_CATALOG');
  const type = schema.type ?? (root ? 'object' : undefined);
  const types = {string:['minLength','maxLength'], number:['minimum','maximum'], integer:['minimum','maximum'],
    boolean:[], null:[], object:['properties','required','additionalProperties'], array:['items','minItems','maxItems']};
  const fields = Object.hasOwn(types, type) ? types[type] : undefined;
  if (root && type !== 'object') fail('INVALID_EVENT_CATALOG');
  if (!fields || Object.keys(schema).some(key => !['type','description','enum',...fields].includes(key))) fail('INVALID_EVENT_CATALOG');
  if (schema.description !== undefined && typeof schema.description !== 'string') fail('INVALID_EVENT_CATALOG');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 100
      || schema.enum.some(value => value !== null && !['string','number','boolean'].includes(typeof value)))) fail('INVALID_EVENT_CATALOG');
  if (type === 'object') {
    if (!object(schema.properties) || schema.additionalProperties !== undefined && schema.additionalProperties !== false) fail('INVALID_EVENT_CATALOG');
    if (schema.required !== undefined && (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length
        || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties, key)))) fail('INVALID_EVENT_CATALOG');
    for (const child of Object.values(schema.properties)) checkSchema(child);
  } else if (type === 'array') checkSchema(schema.items);
  for (const [min, max] of [['minLength','maxLength'],['minItems','maxItems']]) {
    if ([min,max].some(key => schema[key] !== undefined && !integer(schema[key], 0, 1000000))
        || schema[min] !== undefined && schema[max] !== undefined && schema[min] > schema[max]) fail('INVALID_EVENT_CATALOG');
  }
  for (const key of ['minimum','maximum']) if (schema[key] !== undefined && typeof schema[key] !== 'number') fail('INVALID_EVENT_CATALOG');
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) fail('INVALID_EVENT_CATALOG');
}
function matches(value, schema, root = false) {
  const type = schema.type ?? (root ? 'object' : undefined);
  if (schema.enum && !schema.enum.some(item => item === value)) return false;
  switch (type) {
    case 'object': return object(value) && Object.keys(value).every(key => Object.hasOwn(schema.properties, key) && matches(value[key], schema.properties[key]))
      && (schema.required ?? []).every(key => Object.hasOwn(value, key));
    case 'array': return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && value.every(item => matches(item, schema.items));
    case 'string': return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity);
    case 'number': case 'integer': return typeof value === 'number' && (type !== 'integer' || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}
const eventName = name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(name) && !forbidden.has(name);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160;

export function createEventStream({catalog = {}, maxEvents = 1000, maxPropertyBytes = 16384, maxDepth = 8,
  maxListeners = 100, clock = Date.now, onListenerError} = {}) {
  if (!integer(maxEvents, 1, 10000) || !integer(maxPropertyBytes, 1, 1048576) || !integer(maxDepth, 1, 32)
      || !integer(maxListeners, 1, 10000) || typeof clock !== 'function'
      || onListenerError !== undefined && typeof onListenerError !== 'function') fail('INVALID_EVENT_OPTIONS');
  const declared = copyPlainJson(catalog, {maxDepth:32, maxBytes:262144});
  if (!object(declared)) fail('INVALID_EVENT_CATALOG');
  for (const [name, schema] of Object.entries(declared)) { if (!eventName(name)) fail('INVALID_EVENT_CATALOG'); checkSchema(schema, true); }
  const retained = [], listeners = new Map();
  const limits = {maxDepth, maxBytes:maxPropertyBytes};
  let cursor = 0, delivering = false;
  const copyEvent = event => copyPlainJson(event, {maxDepth:maxDepth + 2, maxBytes:maxPropertyBytes + 2048, maxNodes:10032});
  function report(error, event) {
    if (!onListenerError) return;
    try { Promise.resolve(onListenerError(error, {cursor:event.cursor, name:event.name})).catch(() => {}); } catch { /* diagnostics cannot break delivery */ }
  }
  return Object.freeze({
    track(name, properties = {}, context = {}) {
      if (delivering) fail('EVENT_REENTRANCY');
      if (!eventName(name) || !Object.hasOwn(declared, name)) fail('UNKNOWN_EVENT');
      const safeProperties = copyPlainJson(properties, limits), safeContext = copyPlainJson(context, {maxDepth:1, maxBytes:1024});
      if (!matches(safeProperties, declared[name], true)) fail('INVALID_EVENT_PROPERTIES');
      if (!object(safeContext) || Object.keys(safeContext).some(key => !['actor','traceId','correlationId'].includes(key))
          || safeContext.actor !== undefined && !['user','agent','system'].includes(safeContext.actor)
          || ['traceId','correlationId'].some(key => safeContext[key] !== undefined && !identifier(safeContext[key]))) fail('INVALID_EVENT_CONTEXT');
      const timestamp = clock();
      if (!integer(timestamp, 0, Number.MAX_SAFE_INTEGER) || cursor === Number.MAX_SAFE_INTEGER) fail('EVENT_RESOURCE_LIMIT');
      const event = {cursor:++cursor, name, properties:safeProperties, context:{actor:'user', ...safeContext}, timestamp};
      retained.push(event); if (retained.length > maxEvents) retained.shift();
      delivering = true;
      try {
        for (const [token, listener] of [...listeners]) {
          if (!listeners.has(token)) continue;
          try { Promise.resolve(listener(copyEvent(event))).catch(error => report(error, event)); }
          catch (error) { report(error, event); }
        }
      } finally { delivering = false; }
      return copyEvent(event);
    },
    subscribe(listener) {
      if (typeof listener !== 'function') fail('INVALID_LISTENER');
      if (listeners.size >= maxListeners) fail('EVENT_RESOURCE_LIMIT');
      const token = Symbol(); listeners.set(token, listener);
      return () => { listeners.delete(token); };
    },
    history(options = {}) {
      const safe = copyPlainJson(options, {maxDepth:1, maxBytes:1024});
      if (!object(safe) || Object.keys(safe).some(key => !['after','limit'].includes(key))) fail('INVALID_EVENT_CURSOR');
      const {after = 0, limit = maxEvents} = safe;
      if (!integer(after, 0, cursor) || !integer(limit, 1, maxEvents)) fail('INVALID_EVENT_CURSOR');
      const oldestCursor = retained[0]?.cursor ?? cursor + 1, available = retained.filter(event => event.cursor > after);
      return {events:available.slice(0, limit).map(copyEvent), cursor, oldestCursor, gap:after < oldestCursor - 1, hasMore:available.length > limit};
    },
  });
}

// Merge explicitly into an app's catalog to retain SDK lifecycle observations.
// Properties deliberately exclude command arguments, projections and results.
const lifecycleProperties = {kind:{type:'string',enum:['command','control']}, operationId:{type:'string',maxLength:160}, operation:{type:'string',maxLength:160}};
const deepFreeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; };
export const SDK_EVENT_CATALOG = deepFreeze({
  'interaction.submitted': {description:'A validated envelope is being sent; this is not a commit.', properties:{...lifecycleProperties}, required:['kind','operationId','operation']},
  'interaction.outcome': {description:'A matching native outcome was received; execution is not proof of delivery or learning.', properties:{...lifecycleProperties,status:{type:'string',maxLength:160}}, required:['kind','operationId','operation','status']},
  'interaction.uncertain': {description:'No trustworthy outcome arrived; use exact identity for reconciliation.', properties:{...lifecycleProperties}, required:['kind','operationId','operation']},
});
