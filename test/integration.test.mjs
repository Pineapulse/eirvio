import test from 'node:test';
import assert from 'node:assert/strict';
import {createInteractionClient, createEventStream} from '../packages/sdk/src/index.mjs';
import {createTaskBoard} from '../examples/task-board/domain.mjs';
import {createDemoServer} from '../examples/task-board/server.mjs';

test('UI events do not mutate state; explicit agent commands share native retry and stale-state semantics', async () => {
  const {host} = createTaskBoard(), client = createInteractionClient({transport:host});
  const events = createEventStream({catalog:{'ui.task_selected':{properties:{taskId:{type:'string'}},required:['taskId']}}});
  events.track('ui.task_selected',{taskId:'design'},{actor:'user'});
  const basis = await client.observe();
  assert.equal(basis.sceneRevision,0);
  assert.deepEqual((await client.catalog()).map(action=>action.name),['tasks.complete','interface.showTask']);
  const command = client.prepare('tasks.complete',{taskId:'design'},{observation:basis,commandId:'first'});
  const committed = await client.submit(command);
  assert.equal(committed.status,'committed');
  assert.deepEqual(await client.submit(command),committed);
  assert.equal((await client.observe()).sceneRevision,1);
  assert.equal((await client.act('tasks.complete',{taskId:'build'},{observation:basis,commandId:'stale'})).code,'STATE_CONFLICT');
});

test('a lost acknowledgement is uncertain and reconciles by exact identity without another mutation', async () => {
  const {host,store} = createTaskBoard(), client = createInteractionClient({transport:host});
  const command = client.prepare('tasks.complete',{taskId:'design'},{observation:await client.observe(),commandId:'lost'});
  store.failNext='after';
  await assert.rejects(client.submit(command),error=>error.uncertain===true&&error.command.commandId==='lost');
  assert.equal((await client.getOutcome('lost')).status,'committed');
  assert.equal((await client.submit(command)).status,'committed');
  assert.equal((await client.observe()).sceneRevision,1);
});

test('interruption fences new commands from the old scope but keeps committed state', async () => {
  const {host} = createTaskBoard(), client = createInteractionClient({transport:host});
  const basis=await client.observe();
  const control=client.prepareControl('interrupt',{observation:basis,operationId:'interrupt'});
  assert.equal((await client.control(control)).status,'committed');
  const result=await client.act('tasks.complete',{taskId:'design'},{observation:basis,commandId:'late'});
  assert.equal(result.code,'SUPERSEDED_SCOPE');
  assert.equal((await client.observe()).sceneRevision,0);
});

test('the browser transport serves the SDK and preserves lost-reply recovery with request boundaries', async () => {
  const server=createDemoServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  let loseReply=false;
  async function rpc(method,...args) {
    const drop=loseReply;loseReply=false;
    const response=await fetch(origin+'/api/rpc',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({method,args,loseReply:drop})});
    const body=await response.json();
    if(!response.ok)throw Object.assign(new Error(body.error),{code:body.error});
    return body;
  }
  try {
    for(const path of ['/','/app.mjs','/styles.css','/sdk/index.mjs','/sdk/client.mjs','/sdk/events.mjs','/sdk/awareness.mjs'])assert.equal((await fetch(origin+path)).status,200,path);
    for(const path of ['/sdk/host.mjs','/packages/core/src/store.mjs','/.env'])assert.equal((await fetch(origin+path)).status,404,path);
    assert.equal((await fetch(origin+'/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
    const client=createInteractionClient({transport:Object.fromEntries(['observe','catalog','submit','getOutcome','control'].map(method=>[method,(...args)=>rpc(method,...args)]))});
    const command=client.prepare('tasks.complete',{taskId:'verify'},{observation:await client.observe(),commandId:'http-lost'});
    loseReply=true;
    await assert.rejects(client.submit(command),error=>error.uncertain===true);
    assert.equal((await client.getOutcome('http-lost')).status,'committed');
    assert.equal((await client.submit(command)).sceneRevision,1);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('user awareness remains observational while trusted view changes fence attention-sensitive agent actions', async () => {
  const {createInterfaceAwareness}=await import('../packages/sdk/src/index.mjs');
  const {host,runtime}=createTaskBoard(), client=createInteractionClient({transport:host});
  const events=createEventStream({catalog:{'ui.selected':{properties:{taskId:{type:'string'}},required:['taskId']}}});
  const awareness=createInterfaceAwareness({events,surface:{id:'task-board',kind:'website'},
    contextSchema:{properties:{selectedTaskId:{type:'string'}},required:['selectedTaskId']},initialContext:{selectedTaskId:'design'}});
  try {
    const basis=await client.observe();
    const stale=client.prepare('interface.showTask',{taskId:'design'},{observation:basis,commandId:'old-attention'});
    awareness.updateContext({selectedTaskId:'build'});
    events.track('ui.selected',{taskId:'build'},{actor:'user'});
    assert.equal((await client.observe()).sceneRevision,0);
    assert.deepEqual((await client.observe()).view,basis.view,'awareness is not a trusted view mutation');
    assert.equal(awareness.snapshot().context.selectedTaskId,'build');
    const rebound=runtime.control({protocolVersion:'0.1.0',operationId:'trusted-focus-update',runtimeId:basis.runtimeId,
      action:'bindView',runtimeFence:basis.runtimeFence,expectedControlRevision:basis.controlRevision,sceneId:basis.sceneId,
      view:{...basis.view,interactionRevision:basis.view.interactionRevision+1}}, {runtimeId:basis.runtimeId,admin:true});
    assert.equal(rebound.status,'committed');
    assert.equal((await client.submit(stale)).code,'STALE_INTERACTION');
    const fresh=await client.observe();
    assert.equal((await client.act('interface.showTask',{taskId:awareness.snapshot().context.selectedTaskId},
      {observation:fresh,commandId:'current-attention'})).status,'committed');
    assert.equal((await client.observe()).projection.highlightedTaskId,'build');
  } finally {awareness.dispose();}
});
