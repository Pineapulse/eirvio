import {createInteractionClient, createEventStream, createInterfaceAwareness, SDK_EVENT_CATALOG} from '../../packages/sdk/src/index.mjs';
import {createTaskBoard} from './domain.mjs';

const {host} = createTaskBoard();
const events = createEventStream({catalog: {...SDK_EVENT_CATALOG, 'ui.task_selected': {properties: {taskId: {type: 'string', maxLength: 160}}, required: ['taskId']}}});
const awareness = createInterfaceAwareness({events, surface:{id:'task-board',kind:'website',name:'Launch checklist'},
  contextSchema:{properties:{selectedTaskId:{type:'string'}},required:['selectedTaskId']},initialContext:{selectedTaskId:''}});
const client = createInteractionClient({transport: host, events});
events.subscribe(event => console.log('UI event:', JSON.stringify(event)));
awareness.updateContext({selectedTaskId:'design'});
events.track('ui.task_selected', {taskId: 'design'}, {actor: 'user'});
const userContext = awareness.snapshot();
console.log('Agent awareness:', JSON.stringify(userContext));
console.log('Available actions:', JSON.stringify(await client.catalog()));
const observation = await client.observe();
// An explicitly invoked scripted step reads context, then changes the interface
// through the same guarded command path as a future provider-backed agent.
const command = client.prepare('interface.showTask', {taskId: userContext.context.selectedTaskId}, {observation, commandId: 'demo-highlight-1'});
console.log('Agent UI highlight:', JSON.stringify(await client.submit(command)));
console.log('Same-ID retry:', JSON.stringify(await client.submit(command)));
const stale = client.prepare('tasks.complete', {taskId: 'build'}, {observation, commandId: 'demo-command-2'});
console.log('Stale observation rejected:', JSON.stringify(await client.submit(stale)));
const completion = client.prepare('tasks.complete', {taskId: awareness.snapshot().context.selectedTaskId}, {observation:await client.observe(),commandId:'demo-complete-3'});
console.log('Scripted agent completion:', JSON.stringify(await client.submit(completion)));
console.log('User activity remains distinct from agent output:', JSON.stringify(awareness.snapshot().activities));
console.log('Current board:', JSON.stringify((await client.observe()).projection));
awareness.dispose();
