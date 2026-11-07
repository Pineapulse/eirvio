import test from 'node:test';
import assert from 'node:assert/strict';
import {createInterfaceAwareness} from '../src/awareness.mjs';
import {createEventStream} from '../src/events.mjs';

const catalog = {'ui.item_selected':{properties:{itemId:{type:'string',maxLength:160}},required:['itemId']}};
const contextSchema = {properties:{selectedItemId:{type:'string'},pane:{type:'object',properties:{name:{type:'string'}},required:['name']}},required:['selectedItemId']};
const makeEvents = options => createEventStream({catalog,clock:() => 123,...options});
function awareness(events, extra = {}) {
  return createInterfaceAwareness({events,surface:{id:'tasks',kind:'website',name:'Task board'},contextSchema,
    initialContext:{selectedItemId:''},awarenessId:'lifetime-1',...extra});
}
const track = (events, itemId, actor = 'user') => events.track('ui.item_selected', {itemId}, {actor});
const code = expected => error => error.code === expected;

test('mixed actors paginate by source events, including empty filtered pages, without skipping user activity', () => {
  const events = makeEvents(), view = awareness(events);
  for (const [id,actor] of [['s1','system'],['a1','agent'],['u1','user'],['s2','system'],['u2','user']]) track(events,id,actor);
  let page = view.snapshot({limit:2});
  assert.deepEqual(page.activities, []); assert.equal(page.nextCursor.cursor,2); assert.equal(page.sourceHead,5); assert.equal(page.hasMore,true);
  page = view.snapshot({after:page.nextCursor,limit:2});
  assert.deepEqual(page.activities.map(event => event.properties.itemId), ['u1']); assert.equal(page.nextCursor.cursor,4); assert.equal(page.hasMore,true);
  page = view.snapshot({after:page.nextCursor,limit:2});
  assert.deepEqual(page.activities.map(event => event.properties.itemId), ['u2']); assert.equal(page.nextCursor.cursor,5); assert.equal(page.hasMore,false);
  page = view.snapshot({after:page.nextCursor,limit:2});
  assert.deepEqual(page.activities, []); assert.equal(page.nextCursor.cursor,5); assert.equal(page.hasMore,false);
  view.dispose();
});

test('omitted limit delegates to source default and eviction gaps remain visible even with filtered activity', () => {
  const events = makeEvents({maxEvents:2}), view = awareness(events);
  track(events,'evicted'); track(events,'system','system'); track(events,'agent','agent');
  const page = view.snapshot();
  assert.deepEqual(page.activities,[]); assert.equal(page.sourceHead,3); assert.equal(page.oldestCursor,2);
  assert.equal(page.gap,true); assert.equal(page.hasMore,false); assert.equal(page.nextCursor.cursor,3);
  assert.equal(view.snapshot({after:{awarenessId:'lifetime-1',cursor:1}}).gap,false);
  view.dispose();
});

test('lifecycle cursor mismatch, malformed guards and future cursors are rejected', () => {
  const events = makeEvents(), first = awareness(events), second = awareness(events,{awarenessId:'lifetime-2'});
  const cursor = first.snapshot().nextCursor;
  assert.throws(() => second.snapshot({after:cursor}), code('AWARENESS_CURSOR_MISMATCH'));
  for (const options of [{after:{awarenessId:'lifetime-2',cursor:1}}, {after:{awarenessId:'lifetime-2',cursor:-1}},
    {after:{awarenessId:'lifetime-2'}}, {limit:0}, {limit:10001}, {limit:1.5}, {unknown:1}]) {
    assert.throws(() => second.snapshot(options), code('INVALID_AWARENESS_CURSOR'));
  }
  first.dispose(); second.dispose();
});

test('context replacement is atomic, independently versioned and never labelled historical', () => {
  const events = makeEvents(), view = awareness(events), notifications = [];
  view.subscribe(notification => notifications.push(notification));
  track(events,'before-context');
  const changed = view.updateContext({selectedItemId:'later',pane:{name:'details'}});
  assert.deepEqual(changed,{context:{selectedItemId:'later',pane:{name:'details'}},contextRevision:1});
  assert.equal(events.history().cursor,1,'private schema validation must not publish shared events');
  const page = view.snapshot();
  assert.equal(page.context.selectedItemId,'later'); assert.equal(page.contextRevision,1);
  assert.equal(page.activities[0].properties.itemId,'before-context'); assert.equal('contextRevision' in page.activities[0],false);
  assert.deepEqual(notifications.map(item => item.type),['activity','context_changed']);
  assert.deepEqual(notifications[1],{type:'context_changed',awarenessId:'lifetime-1',contextRevision:1,context:{selectedItemId:'later',pane:{name:'details'}}});
  view.updateContext({selectedItemId:'later'});
  assert.equal(view.snapshot().contextRevision,2); assert.equal('pane' in view.snapshot().context,false,'replacement is not a merge');
  view.dispose();
});

test('invalid, oversized and accessor contexts cannot partially change revision or notify', () => {
  const events = makeEvents(), view = awareness(events); let notifications=0, accessed=0;
  view.subscribe(() => notifications++);
  const initial = view.snapshot();
  const hidden = {selectedItemId:'one'}; Object.defineProperty(hidden,'secret',{value:'private'});
  for (const context of [{}, {selectedItemId:'one',password:'private'}, {selectedItemId:3}, {selectedItemId:'x'.repeat(16384)},
    {get selectedItemId(){accessed++;return 'one';}}, JSON.parse('{"selectedItemId":"one","__proto__":{}}'), hidden, undefined, new Date()]) {
    assert.throws(() => view.updateContext(context));
    assert.deepEqual(view.snapshot(),initial);
  }
  assert.equal(accessed,0); assert.equal(notifications,0); assert.equal(events.history().cursor,0);
  view.dispose();
});

test('surface, contexts, snapshots and each notification are detached copies', () => {
  const events = makeEvents(), surface={id:'tasks',kind:'app',name:'Tasks'}, initial={selectedItemId:'first',pane:{name:'list'}};
  const view=awareness(events,{surface,initialContext:initial}), received=[];
  surface.name='changed'; initial.pane.name='changed';
  view.subscribe(notification => {
    if(notification.type==='activity')notification.event.properties.itemId='tampered';
    else notification.context.pane.name='tampered';
  });
  view.subscribe(notification => received.push(notification));
  const replacement={selectedItemId:'next',pane:{name:'detail'}}, result=view.updateContext(replacement);
  replacement.pane.name='changed'; result.context.pane.name='changed'; track(events,'one');
  assert.equal(received[0].context.pane.name,'detail'); assert.equal(received[1].event.properties.itemId,'one');
  const page=view.snapshot(); page.context.pane.name='changed'; page.surface.name='changed'; page.activities[0].properties.itemId='changed'; page.nextCursor.cursor=999;
  const next=view.snapshot(); assert.equal(next.context.pane.name,'detail'); assert.equal(next.surface.name,'Tasks'); assert.equal(next.activities[0].properties.itemId,'one');
  assert.equal(events.history().events[0].properties.itemId,'one'); view.dispose();
});

test('context notifications permit reads while reentrant updates reject before mutation', () => {
  const events=makeEvents(), errors=[], view=awareness(events,{onListenerError:error=>errors.push(error.code)}), seen=[];
  view.subscribe(notification => {seen.push(view.snapshot().contextRevision);view.updateContext({selectedItemId:'recursive'});});
  view.updateContext({selectedItemId:'one'});
  track(events,'two');
  assert.deepEqual(errors,['AWARENESS_REENTRANCY','AWARENESS_REENTRANCY']);
  assert.deepEqual(seen,[1,1]); assert.equal(view.snapshot().contextRevision,1); assert.equal(view.snapshot().context.selectedItemId,'one');
  view.dispose();
});

test('nested source activity during a context notification is isolated live but remains available for replay', () => {
  const events=makeEvents(), errors=[], delivered=[], view=awareness(events,{onListenerError:(error,details)=>errors.push({code:error.code,...details})});
  view.subscribe(notification => {delivered.push(notification.type);if(notification.type==='context_changed')track(events,'nested');});
  view.updateContext({selectedItemId:'one'});
  assert.deepEqual(delivered,['context_changed']); assert.equal(errors[0].code,'AWARENESS_REENTRANCY');
  assert.equal(errors[0].cursor,1); assert.deepEqual(view.snapshot().activities.map(event=>event.properties.itemId),['nested']);
  assert.equal(view.snapshot().contextRevision,1); view.dispose();
});

test('source protects activity-originated synchronous track recursion before committing another event', () => {
  const errors=[], events=makeEvents(), view=awareness(events,{onListenerError:error=>errors.push(error.code)});
  view.subscribe(notification => {if(notification.type==='activity')track(events,'recursive');});
  track(events,'one');
  assert.deepEqual(errors,['EVENT_REENTRANCY']); assert.equal(events.history().cursor,1); view.dispose();
});

test('throwing/rejecting listeners and diagnostics do not affect other listeners or valid updates', async () => {
  const events=makeEvents(), errors=[], view=awareness(events,{onListenerError:error=>{errors.push(error.message);return Promise.reject(new Error('diagnostics failed'));}}), received=[];
  view.subscribe(()=>{throw new Error('sync failed');});
  view.subscribe(async()=>{throw new Error('async failed');});
  const off=view.subscribe(notification=>received.push(notification.type));
  assert.equal(view.updateContext({selectedItemId:'one'}).contextRevision,1); track(events,'two');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(received,['context_changed','activity']); assert.equal(errors.length,4);
  off();off(); view.updateContext({selectedItemId:'three'});
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(received.length,2); view.dispose();
});

test('source subscribes once; bounded listeners and disposal release resources while shared events remain usable', () => {
  const events=makeEvents({maxListeners:1}); let subscriptions=0, releases=0;
  const source={history:events.history,subscribe(listener){subscriptions++;const off=events.subscribe(listener);return()=>{releases++;off();};}};
  const view=awareness(source,{maxListeners:1});
  assert.equal(subscriptions,1); view.snapshot();view.snapshot();assert.equal(subscriptions,1);
  const off=view.subscribe(()=>{}); assert.throws(()=>view.subscribe(()=>{}),code('AWARENESS_RESOURCE_LIMIT'));off();view.subscribe(()=>{});
  view.dispose();view.dispose();off();assert.equal(releases,1);
  for(const action of [()=>view.snapshot(),()=>view.updateContext({selectedItemId:'one'}),()=>view.subscribe(()=>{})]) assert.throws(action,code('AWARENESS_DISPOSED'));
  let live=0;const sharedOff=events.subscribe(()=>live++);track(events,'after-disposal');assert.equal(live,1);sharedOff();
});

test('dispose during notification prevents later listeners from receiving it', () => {
  const events=makeEvents(), view=awareness(events);let late=0;
  view.subscribe(()=>view.dispose());view.subscribe(()=>late++);track(events,'one');
  assert.equal(late,0);assert.throws(()=>view.snapshot(),code('AWARENESS_DISPOSED'));track(events,'still-shared');
});

test('configuration and source data reject accessors without running them', () => {
  const events=makeEvents();let reads=0;
  for (const maxListeners of [null, 0, 10001, 1.5, '1']) {
    assert.throws(()=>awareness(events,{maxListeners}),code('INVALID_AWARENESS_OPTIONS'));
  }
  assert.throws(()=>awareness(events,{surface:{get id(){reads++;return 'x';},kind:'app'}}));
  assert.throws(()=>createInterfaceAwareness({events,surface:{id:'one',kind:'app'},contextSchema, get initialContext(){reads++;return {};}}));
  assert.throws(()=>awareness({get history(){reads++;return events.history;},subscribe:events.subscribe}));
  const view=awareness({subscribe:events.subscribe,history:()=>({get events(){reads++;return [];},cursor:0,oldestCursor:1,gap:false,hasMore:false})});
  assert.throws(()=>view.snapshot(),code('INVALID_AWARENESS_SOURCE'));
  assert.equal(reads,0);view.dispose();
});

test('default IDs are unique; explicit IDs support environments without randomUUID', () => {
  const events=makeEvents(), first=awareness(events,{awarenessId:undefined}), second=awareness(events,{awarenessId:undefined});
  assert.notEqual(first.snapshot().awarenessId,second.snapshot().awarenessId);first.dispose();second.dispose();
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  try {
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});
    assert.throws(()=>awareness(events,{awarenessId:undefined}),code('AWARENESS_ID_REQUIRED'));
    const explicit=awareness(events,{awarenessId:'explicit-unique-lifetime'});assert.equal(explicit.snapshot().awarenessId,'explicit-unique-lifetime');explicit.dispose();
  } finally {Object.defineProperty(globalThis,'crypto',descriptor);}
});

test('awareness observes user activity only and does not invoke action-like methods', () => {
  const events=makeEvents();let actions=0;
  const source={...events,submit(){actions++;},control(){actions++;},act(){actions++;}}, view=awareness(source), received=[];
  view.subscribe(notification=>received.push(notification));
  track(events,'agent','agent');track(events,'system','system');track(events,'user');view.updateContext({selectedItemId:'user'});view.snapshot();
  assert.deepEqual(received.map(item=>item.type),['activity','context_changed']);assert.equal(received[0].event.properties.itemId,'user');assert.equal(actions,0);view.dispose();
});
