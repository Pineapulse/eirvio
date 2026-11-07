import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventStream, SDK_EVENT_CATALOG} from '../src/events.mjs';
const catalog = {'ui.item_selected':{properties:{itemId:{type:'string',minLength:1,maxLength:160}},required:['itemId']}};
const stream = options => createEventStream({catalog, clock:() => 1000, ...options});
const code = expected => error => error.code === expected;

test('declared local event retains only allowed properties and explicit context', () => {
  const events = stream(), properties = {itemId:'one'}, context = {actor:'agent',traceId:'trace',correlationId:'call'};
  const event = events.track('ui.item_selected', properties, context);
  properties.itemId = 'changed'; context.actor = 'user'; event.properties.itemId = 'also changed';
  assert.deepEqual(events.history().events[0], {cursor:1,name:'ui.item_selected',properties:{itemId:'one'},context:{actor:'agent',traceId:'trace',correlationId:'call'},timestamp:1000});
  assert.equal(events.track('ui.item_selected', {itemId:'two'}).context.actor, 'user');
  assert.throws(() => events.track('ui.item_selected', {itemId:'one',cookie:'secret'}), code('INVALID_EVENT_PROPERTIES'));
  assert.throws(() => events.track('ui.keypress', {key:'secret'}), code('UNKNOWN_EVENT'));
  assert.throws(() => events.track('ui.item_selected', {itemId:'one'}, {actor:'admin'}), code('INVALID_EVENT_CONTEXT'));
  assert.throws(() => events.track('ui.item_selected', {itemId:'one'}, {actor:'user',url:'private'}), code('INVALID_EVENT_CONTEXT'));
  assert.equal(events.history().cursor, 2);
});

test('intake rejects prototype pollution, exotic objects, functions and accessors without evaluating getters', () => {
  const events = stream(); let accessed = 0;
  const getter = {get itemId() {accessed++; return 'secret';}};
  const cycle = {}; cycle.self = cycle;
  const hidden = {itemId:'one'}; Object.defineProperty(hidden, 'hidden', {value:'secret'});
  const symbol = {itemId:'one', [Symbol('private')]:'secret'};
  for (const value of [JSON.parse('{"__proto__":{"polluted":true}}'), {constructor:'bad'}, Object.create({itemId:'inherited'}),
    {itemId:new Date()}, {itemId:undefined}, {itemId:() => 'key'}, {itemId:1n}, {itemId:NaN}, {itemId:Infinity}, getter, cycle, hidden, symbol]) {
    assert.throws(() => events.track('ui.item_selected', value));
  }
  assert.equal(accessed, 0); assert.equal({}.polluted, undefined); assert.equal(events.history().cursor, 0);
});

test('nested properties are closed allowlists with required fields, enum, item and scalar constraints', () => {
  const events = createEventStream({catalog:{'ui.filter':{properties:{filter:{type:'object',properties:{mode:{type:'string',enum:['ready','done']},count:{type:'integer',minimum:0,maximum:3}},required:['mode']},ids:{type:'array',items:{type:'string'},maxItems:2}},required:['filter']}}});
  events.track('ui.filter', {filter:{mode:'ready',count:2},ids:['one']});
  for (const properties of [{}, {filter:{mode:'other'}}, {filter:{mode:'ready',count:0.5}}, {filter:{mode:'ready',secret:'cookie'}}, {filter:{mode:'ready'},ids:['a','b','c']}, {filter:{mode:'ready'},ids:Array(1)}]) {
    assert.throws(() => events.track('ui.filter', properties));
  }
  assert.equal(events.history().cursor, 1);
});

test('event catalog is copied and unsupported schema claims fail during configuration', () => {
  const ownCatalog = structuredClone(catalog), events = stream({catalog:ownCatalog});
  ownCatalog['ui.item_selected'].properties.password = {type:'string'};
  assert.throws(() => events.track('ui.item_selected', {itemId:'one',password:'secret'}), code('INVALID_EVENT_PROPERTIES'));
  for (const definition of [{type:'string'}, {properties:{},additionalProperties:true}, {properties:{},required:['missing']}, {properties:{item:{type:'constructor'}}}, {properties:{item:{type:'string',pattern:'.*'}}}]) {
    assert.throws(() => createEventStream({catalog:{'ui.event':definition}}), code('INVALID_EVENT_CATALOG'));
  }
});

test('bounded history reports evicted cursor gaps and paginates without exposing retained objects', () => {
  const events = stream({maxEvents:2});
  for (const itemId of ['one','two','three','four']) events.track('ui.item_selected', {itemId});
  const page = events.history({after:0,limit:1});
  assert.deepEqual({...page,events:page.events.map(event => event.cursor)}, {events:[3],cursor:4,oldestCursor:3,gap:true,hasMore:true});
  page.events[0].properties.itemId = 'tampered';
  assert.equal(events.history({after:2}).events[0].properties.itemId, 'three');
  assert.equal(events.history({after:3}).gap, false);
  assert.deepEqual(events.history({after:4}).events, []);
  for (const options of [{after:5}, {after:-1}, {limit:3}, {limit:0}, {extra:1}]) assert.throws(() => events.history(options), code('INVALID_EVENT_CURSOR'));
});

test('byte, depth, count, context and listener limits fail before retaining an event', () => {
  const props = {itemId:'ééé'}, bytes = new TextEncoder().encode(JSON.stringify(props)).length;
  const small = stream({maxPropertyBytes:bytes-1});
  assert.throws(() => small.track('ui.item_selected', props), code('JSON_RESOURCE_LIMIT'));
  assert.equal(small.history().cursor, 0);
  const nested = createEventStream({maxDepth:1,catalog:{'ui.nested':{properties:{item:{type:'object',properties:{id:{type:'string'}}}}}}});
  assert.throws(() => nested.track('ui.nested', {item:{id:'one'}}), code('JSON_RESOURCE_LIMIT'));
  const list = createEventStream({catalog:{'ui.items':{properties:{ids:{type:'array',items:{type:'string'}}}}},maxPropertyBytes:100000});
  assert.throws(() => list.track('ui.items', {ids:Array(10001).fill('a')}), code('JSON_RESOURCE_LIMIT'));
  const limited = stream({maxListeners:1}), off = limited.subscribe(() => {});
  assert.throws(() => limited.subscribe(() => {}), code('EVENT_RESOURCE_LIMIT')); off(); limited.subscribe(() => {});
  for (const options of [{maxEvents:0},{maxEvents:10001},{maxPropertyBytes:0},{maxDepth:33},{maxListeners:0}]) assert.throws(() => stream(options), code('INVALID_EVENT_OPTIONS'));
});

test('throwing, mutating and asynchronously rejecting subscribers are isolated from other subscribers', async () => {
  const errors = [], events = stream({onListenerError(error) {errors.push(error.message); return Promise.reject(new Error('diagnostics failed'));}});
  events.subscribe(() => {throw new Error('sync failed');});
  events.subscribe(async event => {event.properties.itemId = 'tampered'; throw new Error('async failed');});
  const received = []; const off = events.subscribe(event => received.push(event));
  assert.equal(events.track('ui.item_selected', {itemId:'one'}).cursor, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors.sort(), ['async failed','sync failed']);
  assert.equal(received[0].properties.itemId, 'one');
  assert.equal(events.history().events[0].properties.itemId, 'one');
  off(); off(); events.track('ui.item_selected', {itemId:'two'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 1);
});

test('reentrant publishing is isolated and cannot create an unbounded synchronous event loop', () => {
  const errors = [], events = stream({onListenerError:error => errors.push(error.code)});
  events.subscribe(() => events.track('ui.item_selected', {itemId:'recursive'}));
  assert.equal(events.track('ui.item_selected', {itemId:'one'}).cursor, 1);
  assert.deepEqual(errors, ['EVENT_REENTRANCY']); assert.equal(events.history().cursor, 1);
});

test('SDK lifecycle catalog contains metadata only and rejects action arguments', () => {
  const events = createEventStream({catalog:SDK_EVENT_CATALOG});
  events.track('interaction.submitted', {kind:'command',operation:'tasks.complete',operationId:'one'}, {actor:'system'});
  assert.throws(() => events.track('interaction.submitted', {kind:'command',operation:'tasks.complete',operationId:'one',arguments:{text:'private'}}), code('INVALID_EVENT_PROPERTIES'));
});
