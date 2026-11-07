import {createInteractionClient, createEventStream, SDK_EVENT_CATALOG, type Command} from 'eirvio';
import {createInteractionHost} from 'eirvio/host';
import {Runtime, Registry, MemoryStore} from 'eirvio/core';

const registry = new Registry().register({
  ruleset: 'counter', rulesVersion: '1', stateSchemaVersion: '1',
  validateState: state => typeof state.count === 'number',
  project: state => state,
  operations: {'counter.add': {validate: args => typeof args.amount === 'number', apply: (state, args) => ({state: {count: Number(state.count) + Number(args.amount)}, result: {ok: true}})}}
});
const runtime = Runtime.create({runtimeId:'typed', runtimeFence:'f1', scenes:[{sceneId:'main', kind:'canonical', ruleset:'counter', rulesVersion:'1', stateSchemaVersion:'1', sceneRevision:0, state:{count:0}}], scopes:['interface']}, registry, new MemoryStore());
const host = createInteractionHost({runtime, getContext:() => ({runtimeId:'typed', admin:true}), sceneId:'main', scopeId:'interface',
  actions:[{name:'counter.add', description:'Add to count', parameters:{type:'object', properties:{amount:{type:'number'}}}}]});
const events = createEventStream({catalog:{...SDK_EVENT_CATALOG, 'ui.selected':{properties:{id:{type:'string'}},required:['id']}}});
const client = createInteractionClient({transport:host, events});
const basis = await client.observe();
const command: Command = client.prepare('counter.add', {amount:1}, {observation:basis, commandId:'typed-1'});
const outcome = await client.submit(command);
events.track('ui.selected', {id:'one'}, {actor:'user'});
console.log(outcome.status);
// @ts-expect-error commands require an explicit observation and identity
client.prepare('counter.add', {amount:1});
// @ts-expect-error actor values are finite and descriptive
events.track('ui.selected', {id:'one'}, {actor:'administrator'});
// @ts-expect-error global administrative controls are not a client capability
client.prepareControl('recover', {observation:basis, operationId:'typed-2'});
