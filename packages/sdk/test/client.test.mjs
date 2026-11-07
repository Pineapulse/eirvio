import test from 'node:test';
import assert from 'node:assert/strict';
import {createInteractionClient, InteractionTransportError} from '../src/client.mjs';
import {createEventStream, SDK_EVENT_CATALOG} from '../src/events.mjs';
import {createTaskBoard} from '../../../examples/task-board/domain.mjs';
const code = expected => error => error.code === expected;
const prepare = (client, basis, commandId='command-1', taskId='design') => client.prepare('tasks.complete', {taskId}, {observation:basis,commandId});

test('browser client interoperates with the native task-board host and sends zero-argument reads', async () => {
  const {host} = createTaskBoard(), calls = [];
  const transport = Object.fromEntries(['observe','catalog','submit','getOutcome','control'].map(method => [method, (...args) => {calls.push([method,args.length]); return host[method](...args);} ]));
  const client = createInteractionClient({transport});
  const basis = await client.observe(), catalog = await client.catalog();
  assert.equal(catalog[0].name, 'tasks.complete');
  const command = prepare(client, basis), outcome = await client.submit(command);
  assert.equal(outcome.status, 'committed');
  assert.deepEqual(await client.getOutcome(command.commandId), outcome);
  assert.deepEqual(calls, [['observe',0],['catalog',0],['submit',1],['getOutcome',1]]);
  assert.equal((await client.observe()).projection.tasks[0].done, true);
});

test('prepare is pure, checks observed capabilities and copies every supplied guard without rebasing', async () => {
  const {host} = createTaskBoard(), client = createInteractionClient({transport:host}), basis = await client.observe();
  const command = prepare(client, basis);
  assert.deepEqual(command.guards, {runtimeFence:basis.runtimeFence,expectedSceneRevision:0,scopeId:'interface',scopeEpoch:0,view:{viewId:'task-list',viewEpoch:0,interactionRevision:0}});
  assert.equal(host.observe().sceneRevision, 0);
  basis.view.interactionRevision = 99; basis.capabilities.length = 0; basis.projection.tasks[0].done = true;
  assert.equal(command.guards.view.interactionRevision, 0); assert.ok(Object.isFrozen(command.arguments));
  assert.throws(() => {command.commandId='changed';}, TypeError);
  assert.throws(() => prepare(client, basis), code('CAPABILITY_UNAVAILABLE'));
  const fresh = host.observe();
  assert.throws(() => client.prepare('undeclared.action', {}, {observation:fresh,commandId:'missing'}), code('CAPABILITY_UNAVAILABLE'));
  assert.throws(() => client.prepare('tasks.complete', {taskId:'design'}), code('INVALID_JSON'));
  await client.submit(command);
  const stale = prepare(client, fresh, 'stale-new-id', 'build');
  assert.equal(stale.guards.expectedSceneRevision, 0);
  const rejected = await client.submit(stale);
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.code, 'STATE_CONFLICT');
  assert.equal(host.observe().projection.tasks[1].done, false);
});

test('malformed and prototype-bearing prepare/submit inputs fail before transport invocation', async () => {
  const {host} = createTaskBoard(); let submitted = 0;
  const client = createInteractionClient({transport:{...host,submit(command) {submitted++; return host.submit(command);}}});
  const basis = await client.observe(); let accessed = 0;
  for (const properties of [JSON.parse('{"__proto__":{}}'), {constructor:'bad'}, {taskId:undefined}, {get taskId() {accessed++; return 'design';}}, new Date()]) {
    assert.throws(() => prepare(client, {...basis, projection:properties}));
    assert.throws(() => client.prepare('tasks.complete', properties, {observation:basis,commandId:'one'}));
  }
  const command = prepare(client, basis);
  await assert.rejects(client.submit({...command, guards:{...command.guards,view:{viewId:'task-list',viewEpoch:0}}}), code('INVALID_COMMAND'));
  assert.throws(() => prepare(client, {...basis,scope:{...basis.scope,epoch:-1}}), code('INVALID_OBSERVATION'));
  assert.throws(() => prepare(client, {...basis,scope:{...basis.scope,status:'closed'}}), code('SCOPE_CLOSED'));
  assert.throws(() => prepare(client, basis, 'constructor'), code('INVALID_COMMAND'));
  assert.equal(accessed, 0); assert.equal(submitted, 0);
});

test('lost native commit acknowledgement is uncertain and exact identity retry returns the first result', async () => {
  const {host,store} = createTaskBoard(), client = createInteractionClient({transport:host});
  const command = prepare(client, await client.observe()); store.failNext = 'after';
  let uncertain;
  await assert.rejects(client.submit(command), error => {uncertain=error; return error instanceof InteractionTransportError && error.uncertain && error.code==='TRANSPORT_UNCERTAIN';});
  assert.deepEqual(uncertain.command, command); assert.equal(uncertain.operationId, command.commandId);
  assert.ok(Object.isFrozen(uncertain.command.guards.view));
  const retained = await client.getOutcome(command.commandId);
  assert.equal(retained.status, 'committed');
  assert.deepEqual(await client.submit(uncertain.command), retained);
  assert.equal(host.observe().sceneRevision, 1);
  const collision = await client.submit({...command,arguments:{taskId:'build'}});
  assert.equal(collision.code, 'DUPLICATE_ID_MISMATCH'); assert.equal(host.observe().sceneRevision, 1);
});

test('unknown failure never triggers retry, fresh observation, or success inference', async () => {
  const {host} = createTaskBoard(); let calls = 0, observations = 0;
  const transport = {...host,observe() {observations++; return host.observe();},submit() {calls++; throw new Error('connection reset');}};
  const client = createInteractionClient({transport}), command = prepare(client, await client.observe());
  await assert.rejects(client.submit(command), error => error.uncertain && error.command.commandId === command.commandId);
  assert.equal(calls, 1); assert.equal(observations, 1); assert.equal(host.observe().sceneRevision, 0);
  await assert.rejects(client.getOutcome(command.commandId), code('HOST_OUTCOME_UNAVAILABLE'));
});

test('malformed or mismatched responses after a commit remain uncertain', async () => {
  const commit = {protocolVersion:'0.1.0',operationId:'command-1',status:'committed',eventCursor:1,sceneId:'workspace',previousRevision:0,sceneRevision:1,result:{}};
  for (const reply of [undefined, {status:'committed'}, {...commit,operationId:'other'}, {...commit,sceneId:'foreign-scene'},
    {...commit,previousRevision:31,sceneRevision:32}, {...commit,sceneRevision:2}, {...commit,result:undefined},
    {protocolVersion:'0.1.0',operationId:'command-1',status:'committed',eventCursor:1}, {...commit,status:'completed'}]) {
    const {host} = createTaskBoard(), client = createInteractionClient({transport:{...host,submit(command) {host.submit(command); return reply;}}});
    const command = prepare(client, await client.observe());
    await assert.rejects(client.submit(command), error => error.uncertain && error.code==='TRANSPORT_UNCERTAIN');
    assert.equal((await client.getOutcome(command.commandId)).status, 'committed');
  }
});

test('definite host rejection and read transport errors retain distinct semantics', async () => {
  const {host} = createTaskBoard();
  const denied = Object.assign(new Error('Denied'), {code:'FORBIDDEN'});
  const client = createInteractionClient({transport:{...host,submit() {throw denied;},catalog() {throw new Error('offline');}}});
  const command = prepare(client, await client.observe());
  await assert.rejects(client.submit(command), error => error === denied && !error.uncertain);
  await assert.rejects(client.catalog(), error => error instanceof InteractionTransportError && error.code==='TRANSPORT_ERROR' && error.uncertain===false);
});

test('scoped controls include exact native context and fence old commands without undoing state', async () => {
  const {host} = createTaskBoard(), client = createInteractionClient({transport:host}), basis = await client.observe();
  const oldCommand = prepare(client, basis), control = client.prepareControl('interrupt', {observation:basis,operationId:'stop-1'});
  assert.deepEqual(control, {protocolVersion:'0.1.0',operationId:'stop-1',runtimeId:basis.runtimeId,action:'interrupt',runtimeFence:basis.runtimeFence,expectedControlRevision:basis.controlRevision,scopeId:basis.scope.id,scopeEpoch:basis.scope.epoch,sceneId:basis.sceneId,view:basis.view});
  const stopped = await client.control(control); assert.equal(stopped.status,'committed');
  assert.deepEqual(await client.control(control), stopped);
  assert.equal((await client.submit(oldCommand)).code, 'SUPERSEDED_SCOPE');
  await client.act('tasks.complete', {taskId:'design'}, {observation:await client.observe(),commandId:'new-command'});
  const close = client.prepareControl('closeScope', {observation:await client.observe(),operationId:'close-1'});
  assert.equal((await client.control(close)).status,'committed');
  assert.equal(host.observe().projection.tasks[0].done,true);
  assert.throws(() => client.prepareControl('end', {observation:basis,operationId:'end-1'}), code('INVALID_CONTROL'));
  await assert.rejects(client.control({...control,newSceneId:'foreign'}), code('INVALID_CONTROL'));
});

test('control transport uncertainty retains the exact control envelope', async () => {
  const {host,store} = createTaskBoard(), client = createInteractionClient({transport:host});
  const control = client.prepareControl('interrupt', {observation:await client.observe(),operationId:'stop-uncertain'});
  store.failNext='after'; let error;
  await assert.rejects(client.control(control), value => {error=value; return value.uncertain && value.operation==='control';});
  assert.deepEqual(error.control, control);
  assert.equal((await client.control(error.control)).status,'committed');
  assert.equal(host.observe().scope.epoch,1);
});

test('events are observational, lifecycle metadata is system-authored, and listener failures cannot alter committed actions', async () => {
  const {host} = createTaskBoard();
  const events = createEventStream({catalog:{...SDK_EVENT_CATALOG,'ui.item_selected':{properties:{itemId:{type:'string'}},required:['itemId']}}});
  events.subscribe(() => {throw new Error('listener failed');});
  events.subscribe(async () => {throw new Error('async listener failed');});
  const client = createInteractionClient({transport:host,events});
  events.track('ui.item_selected', {itemId:'design'}, {actor:'user'});
  assert.equal(host.observe().sceneRevision,0);
  const result = await client.act('tasks.complete', {taskId:'design'}, {observation:await client.observe(),commandId:'event-command'});
  assert.equal(result.status,'committed');
  await new Promise(resolve => setImmediate(resolve));
  const lifecycle = events.history().events.filter(event => event.name.startsWith('interaction.'));
  assert.deepEqual(lifecycle.map(event => event.name), ['interaction.submitted','interaction.outcome']);
  assert.ok(lifecycle.every(event => event.context.actor==='system'));
  assert.ok(lifecycle.every(event => !('arguments' in event.properties) && !('taskId' in event.properties)));
});

test('optional events with no SDK catalog or a rejected track promise cannot fail an action', async () => {
  for (const events of [createEventStream(),{track:async () => {throw new Error('diagnostics unavailable');}}]) {
    const {host} = createTaskBoard(), client = createInteractionClient({transport:host,events});
    assert.equal((await client.act('tasks.complete',{taskId:'design'},{observation:await client.observe(),commandId:'one'})).status,'committed');
  }
  await new Promise(resolve => setImmediate(resolve));
});
