import {createEventStream, copyPlainJson, InteractionValidationError} from './events.mjs';

const fail = code => { throw new InteractionValidationError(code); };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const EVENT_LIMITS = {maxBytes:1048576 + 2048, maxDepth:34, maxNodes:10032};
const MAX_SOURCE_EVENTS = 10000;

// Read only data descriptors; neither options nor transport-like source data may
// invoke getters while being checked. Referenced JSON values are copied separately.
function fields(value, required, optional = [], code = 'INVALID_AWARENESS_OPTIONS') {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const names = Reflect.ownKeys(value), allowed = [...required, ...optional];
  if (names.length > allowed.length || names.some(name => typeof name !== 'string' || !allowed.includes(name))
      || required.some(name => !Object.hasOwn(value, name))) fail(code);
  const result = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    result[name] = descriptor.value;
  }
  return result;
}
function copyEvent(value) {
  const event = copyPlainJson(value, EVENT_LIMITS);
  fields(event, ['cursor','name','properties','context','timestamp'], [], 'INVALID_AWARENESS_SOURCE');
  const context = fields(event.context, ['actor'], ['traceId','correlationId'], 'INVALID_AWARENESS_SOURCE');
  if (!integer(event.cursor, 1) || !integer(event.timestamp) || !identifier(event.name) || !record(event.properties)
      || !['user','agent','system'].includes(context.actor)
      || ['traceId','correlationId'].some(key => context[key] !== undefined && !identifier(context[key]))) fail('INVALID_AWARENESS_SOURCE');
  return event;
}
function sourcePage(value, after, limit) {
  const page = fields(value, ['events','cursor','oldestCursor','gap','hasMore'], [], 'INVALID_AWARENESS_SOURCE');
  if (!integer(page.cursor) || !integer(page.oldestCursor, 1) || page.oldestCursor - 1 > page.cursor
      || typeof page.gap !== 'boolean' || typeof page.hasMore !== 'boolean') fail('INVALID_AWARENESS_SOURCE');
  if (after > page.cursor) fail('INVALID_AWARENESS_CURSOR');
  const list = page.events;
  if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype) fail('INVALID_AWARENESS_SOURCE');
  const length = Object.getOwnPropertyDescriptor(list, 'length')?.value;
  if (!integer(length, 0, limit ?? MAX_SOURCE_EVENTS) || Reflect.ownKeys(list).length !== length + 1) fail('INVALID_AWARENESS_SOURCE');
  const events = [];
  let expected = Math.max(after + 1, page.oldestCursor);
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_AWARENESS_SOURCE');
    const event = copyEvent(descriptor.value);
    if (event.cursor !== expected++ || event.cursor > page.cursor) fail('INVALID_AWARENESS_SOURCE');
    events.push(event);
  }
  const scanned = events.at(-1)?.cursor ?? after;
  if (page.gap !== (after < page.oldestCursor - 1) || page.hasMore !== (scanned < page.cursor)
      || !length && scanned < page.cursor) fail('INVALID_AWARENESS_SOURCE');
  return {...page, events, scanned};
}

/**
 * Current app-declared context plus bounded user activity from one event stream.
 * Supply a fresh awarenessId for every lifetime if crypto.randomUUID is absent.
 * Context is current, never a historical annotation on earlier activity.
 */
export function createInterfaceAwareness(options) {
  const config = fields(options, ['events','surface','contextSchema','initialContext'], ['awarenessId','maxListeners','onListenerError']);
  const {events, contextSchema, initialContext, onListenerError} = config;
  const maxListeners = config.maxListeners === undefined ? 100 : config.maxListeners;
  if (!integer(maxListeners, 1, 10000) || onListenerError !== undefined && typeof onListenerError !== 'function') fail('INVALID_AWARENESS_OPTIONS');
  if (!events || typeof events !== 'object') fail('INVALID_AWARENESS_OPTIONS');
  const history = Object.getOwnPropertyDescriptor(events, 'history')?.value;
  const sourceSubscribe = Object.getOwnPropertyDescriptor(events, 'subscribe')?.value;
  if (typeof history !== 'function' || typeof sourceSubscribe !== 'function') fail('INVALID_AWARENESS_OPTIONS');
  const surface = copyPlainJson(config.surface, {maxBytes:1024, maxDepth:1});
  fields(surface, ['id','kind'], ['name']);
  if (!identifier(surface.id) || !['website','game','app'].includes(surface.kind)
      || surface.name !== undefined && !identifier(surface.name)) fail('INVALID_AWARENESS_OPTIONS');
  let awarenessId = config.awarenessId;
  if (awarenessId === undefined) {
    if (typeof globalThis.crypto?.randomUUID !== 'function') fail('AWARENESS_ID_REQUIRED');
    awarenessId = globalThis.crypto.randomUUID();
  }
  if (!identifier(awarenessId)) fail('INVALID_AWARENESS_OPTIONS');
  // Reuse the event schema dialect and its default 16 KiB/depth-8 property bounds.
  // This private one-entry stream never reaches the shared stream or subscribers.
  const validator = createEventStream({catalog:{'awareness.context':contextSchema}, maxEvents:1, clock:() => 0});
  const validateContext = value => {
    if (value === undefined) fail('INVALID_AWARENESS_CONTEXT');
    return validator.track('awareness.context', value, {actor:'system'}).properties;
  };
  let context = validateContext(initialContext), contextRevision = 0, disposed = false, delivering = false;
  const listeners = new Map();
  const alive = () => { if (disposed) fail('AWARENESS_DISPOSED'); };
  const copyNotification = value => copyPlainJson(value, {maxBytes:EVENT_LIMITS.maxBytes + 512, maxDepth:35, maxNodes:10064});
  function report(error, notification) {
    if (!onListenerError) return;
    const details = notification.type === 'activity'
      ? {type:'activity', awarenessId, cursor:notification.event.cursor}
      : {type:'context_changed', awarenessId, contextRevision:notification.contextRevision};
    try { Promise.resolve(onListenerError(error, details)).catch(() => {}); } catch { /* diagnostics stay isolated */ }
  }
  function notify(notification) {
    if (disposed) return;
    if (delivering) {
      // A subscriber can explicitly publish to the independently owned source.
      // Do not recurse; that source event remains available through snapshot().
      report(new InteractionValidationError('AWARENESS_REENTRANCY'), notification);
      return;
    }
    delivering = true;
    try {
      for (const [token, listener] of [...listeners]) {
        if (disposed) break;
        if (!listeners.has(token)) continue;
        try { Promise.resolve(listener(copyNotification(notification))).catch(error => report(error, notification)); }
        catch (error) { report(error, notification); }
      }
    } finally { delivering = false; }
  }
  // Install once, before returning. snapshot never creates a second subscription.
  const unsubscribe = sourceSubscribe.call(events, value => {
    if (disposed) return;
    const event = copyEvent(value);
    if (event.context.actor === 'user') notify({type:'activity', awarenessId, event});
  });
  if (typeof unsubscribe !== 'function') fail('INVALID_AWARENESS_SOURCE');
  return Object.freeze({
    snapshot(options = {}) {
      alive();
      const safe = copyPlainJson(options, {maxBytes:1024, maxDepth:2, maxNodes:16});
      fields(safe, [], ['after','limit'], 'INVALID_AWARENESS_CURSOR');
      let after = 0;
      if (safe.after !== undefined) {
        fields(safe.after, ['awarenessId','cursor'], [], 'INVALID_AWARENESS_CURSOR');
        if (!identifier(safe.after.awarenessId) || !integer(safe.after.cursor)) fail('INVALID_AWARENESS_CURSOR');
        if (safe.after.awarenessId !== awarenessId) fail('AWARENESS_CURSOR_MISMATCH');
        after = safe.after.cursor;
      }
      if (safe.limit !== undefined && !integer(safe.limit, 1, MAX_SOURCE_EVENTS)) fail('INVALID_AWARENESS_CURSOR');
      let raw;
      try { raw = history.call(events, {after, ...(safe.limit === undefined ? {} : {limit:safe.limit})}); }
      catch (error) { if (error?.code === 'INVALID_EVENT_CURSOR') fail('INVALID_AWARENESS_CURSOR'); throw error; }
      const page = sourcePage(raw, after, safe.limit);
      return {awarenessId, surface:copyPlainJson(surface), contextRevision, context:copyPlainJson(context),
        activities:page.events.filter(event => event.context.actor === 'user'),
        nextCursor:{awarenessId, cursor:page.scanned}, sourceHead:page.cursor, oldestCursor:page.oldestCursor,
        gap:page.gap, hasMore:page.hasMore};
    },
    updateContext(replacement) {
      alive();
      if (delivering) fail('AWARENESS_REENTRANCY');
      if (contextRevision === Number.MAX_SAFE_INTEGER) fail('AWARENESS_RESOURCE_LIMIT');
      const next = validateContext(replacement);
      const result = {context:copyPlainJson(next), contextRevision:contextRevision + 1};
      context = next; contextRevision++;
      notify({type:'context_changed', awarenessId, contextRevision, context});
      return result;
    },
    subscribe(listener) {
      alive();
      if (typeof listener !== 'function') fail('INVALID_LISTENER');
      if (listeners.size >= maxListeners) fail('AWARENESS_RESOURCE_LIMIT');
      const token = Symbol(); listeners.set(token, listener);
      return () => { listeners.delete(token); };
    },
    dispose() {
      if (disposed) return;
      disposed = true; listeners.clear(); unsubscribe();
    },
  });
}
