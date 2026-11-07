import {createInteractionClient, createEventStream} from '../../packages/sdk/src/index.mjs';
import {createTaskBoard} from './domain.mjs';

const {host} = createTaskBoard();
const events = createEventStream({catalog: {'ui.task_selected': {properties: {taskId: {type: 'string', maxLength: 160}}, required: ['taskId']}}});
const client = createInteractionClient({transport: host});
events.subscribe(event => console.log('UI event:', JSON.stringify(event)));
events.track('ui.task_selected', {taskId: 'design'}, {actor: 'user'});
console.log('Available actions:', JSON.stringify(await client.catalog()));
const observation = await client.observe();
const command = client.prepare('tasks.complete', {taskId: 'design'}, {observation, commandId: 'demo-command-1'});
console.log('Committed:', JSON.stringify(await client.submit(command)));
console.log('Same-ID retry:', JSON.stringify(await client.submit(command)));
const stale = client.prepare('tasks.complete', {taskId: 'build'}, {observation, commandId: 'demo-command-2'});
console.log('Stale observation rejected:', JSON.stringify(await client.submit(stale)));
console.log('Current board:', JSON.stringify((await client.observe()).projection));
