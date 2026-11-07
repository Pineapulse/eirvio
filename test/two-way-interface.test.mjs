import test from 'node:test';
import assert from 'node:assert/strict';
import {createInteractionClient} from '../packages/sdk/src/client.mjs';
import {createTaskBoard} from '../examples/task-board/domain.mjs';

test('visible interface actions retain domain validation, stale guards and exact retry semantics',async()=>{
  const {host}=createTaskBoard(),client=createInteractionClient({transport:host});
  const before=await client.observe();
  assert.deepEqual((await client.catalog()).map(action=>action.name),['tasks.complete','interface.showTask']);
  const highlight=client.prepare('interface.showTask',{taskId:'design'},{observation:before,commandId:'show-design'});
  const committed=await client.submit(highlight);
  assert.equal(committed.status,'committed');
  assert.deepEqual(await client.submit(highlight),committed);
  assert.equal((await client.observe()).sceneRevision,1);
  const stale=client.prepare('interface.showTask',{taskId:'verify'},{observation:before,commandId:'stale-highlight'});
  assert.equal((await client.submit(stale)).code,'STATE_CONFLICT');
  const invalid=client.prepare('interface.showTask',{taskId:'not-a-task'},{observation:await client.observe(),commandId:'invalid-highlight'});
  assert.equal((await client.submit(invalid)).code,'INVALID_SCHEMA');
  const current=await client.observe();
  assert.equal(current.projection.highlightedTaskId,'design');
  assert.equal(current.projection.tasks.some(task=>task.done),false);
  assert.equal(current.sceneRevision,1);
});
