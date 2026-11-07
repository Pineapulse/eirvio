import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createTaskBoard} from '../examples/task-board/domain.mjs';

// Run the actual browser entry and its event handlers with a minimal DOM. The
// transport uses the real host/client; only delivery of selected replies fails.
async function sample(t) {
  class Element {
    children=[]; listeners=new Map(); attributes=new Map(); dataset={}; disabled=false; checked=false; textContent='';
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=[...children];}
    setAttribute(name,value){this.attributes.set(name,value);}
    getAttribute(name){return this.attributes.get(name);}
    addEventListener(type,listener){this.listeners.set(type,listener);}
    async click(){assert.equal(this.disabled,false,'test clicked a disabled control');return this.listeners.get('click')?.();}
  }
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const originalDocument=globalThis.document, originalFetch=globalThis.fetch;
  t.after(()=>{if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;globalThis.fetch=originalFetch;});
  globalThis.document={getElementById:element,createElement:()=>new Element()};
  const {host}=createTaskBoard(), requests=[];
  let dropMethod,wrongLookup;
  globalThis.fetch=async (_url,options)=>{
    const request=JSON.parse(options.body);requests.push(structuredClone(request));
    if(request.method==='getOutcome'&&wrongLookup){const result=wrongLookup;wrongLookup=undefined;return Response.json(result);}
    const result=host[request.method](...request.args);
    if(request.method===dropMethod){dropMethod=undefined;throw new TypeError('Simulated lost response');}
    return Response.json(result);
  };
  const source=(await readFile(new URL('../examples/task-board/app.mjs',import.meta.url),'utf8'))
    .replace("from '/sdk/index.mjs'",`from '${new URL('../packages/sdk/src/index.mjs',import.meta.url).href}'`);
  await import(`data:text/javascript;base64,${Buffer.from(source+'\n// '+randomUUID()).toString('base64')}`);
  return {element,host,requests,drop(method){dropMethod=method;},wrongOutcome(value){wrongLookup=value;}};
}

test('sample recovers a lost first control reply by its own ID and retries it without another interruption',async t=>{
  const {element,host,requests,drop}=await sample(t);
  drop('control');await element('interrupt').click();
  const control=requests.find(request=>request.method==='control').args[0];
  assert.equal(host.observe().scope.epoch,1);
  assert.equal(element('interrupt').disabled,true);
  assert.equal(element('retry').disabled,false);assert.equal(element('recover').disabled,false);
  assert.match(element('retry').textContent,/control/);
  await element('recover').click();
  assert.equal(requests.findLast(request=>request.method==='getOutcome').args[0],control.operationId);
  assert.equal(element('interrupt').disabled,false);
  await element('retry').click();
  const attempts=requests.filter(request=>request.method==='control');
  assert.equal(attempts.length,2);assert.deepEqual(attempts[1].args[0],control);
  assert.equal(host.observe().scope.epoch,1);
  assert.equal(requests.some(request=>request.method==='submit'),false);
});

test('sample never resolves an uncertain control using an earlier task command outcome',async t=>{
  const {element,host,requests,drop,wrongOutcome}=await sample(t);
  await element('tasks').children[0].click();await element('complete').click();
  const command=requests.find(request=>request.method==='submit').args[0];
  assert.equal(host.observe().sceneRevision,1);
  drop('control');await element('interrupt').click();
  const control=requests.find(request=>request.method==='control').args[0];
  wrongOutcome(host.getOutcome(command.commandId));
  await element('recover').click();
  assert.equal(requests.findLast(request=>request.method==='getOutcome').args[0],control.operationId);
  assert.equal(element('interrupt').disabled,true,'an unrelated response must not clear uncertainty');
  await element('retry').click();
  assert.equal(requests.filter(request=>request.method==='submit').length,1,'retry must not replay the task command');
  assert.deepEqual(requests.filter(request=>request.method==='control').map(request=>request.args[0]),[control,control]);
  assert.equal(host.observe().scope.epoch,1);assert.equal(host.observe().sceneRevision,1);
  assert.equal(element('interrupt').disabled,false);
});

test('sample still recovers lost command replies using the exact original command',async t=>{
  const {element,host,requests,drop}=await sample(t);
  await element('tasks').children[0].click();drop('submit');await element('complete').click();
  const command=requests.find(request=>request.method==='submit').args[0];
  assert.equal(element('agent').disabled,true);
  await element('retry').click();
  assert.deepEqual(requests.filter(request=>request.method==='submit').map(request=>request.args[0]),[command,command]);
  assert.equal(host.observe().sceneRevision,1);
  await element('recover').click();
  assert.equal(requests.findLast(request=>request.method==='getOutcome').args[0],command.commandId);
});

test('explicit agent actions use interface awareness and visibly highlight without changing user selection',async t=>{
  const {element,host,requests}=await sample(t);
  const currentAwareness=()=>JSON.parse(element('awareness').textContent);
  const task=id=>element('tasks').children.find(button=>button.dataset.taskId===id);
  assert.equal(host.observe().sceneRevision,0);
  assert.equal(host.observe().projection.highlightedTaskId,'');
  assert.equal(currentAwareness().context.selectedTaskId,'');
  assert.deepEqual(currentAwareness().activities,[]);
  assert.equal(element('agent-highlight').disabled,true);
  await task('build').click();
  assert.equal(currentAwareness().context.selectedTaskId,'build');
  assert.equal(currentAwareness().activities.at(-1).name,'ui.task_selected');
  assert.equal(element('latest-user-activity').textContent,'Selected Connect the agent');
  assert.equal(requests.filter(request=>request.method==='submit').length,0,'user context must not trigger hidden writes');
  await element('agent-highlight').click();
  assert.equal(host.observe().projection.highlightedTaskId,'build');
  assert.equal(host.observe().projection.tasks.find(item=>item.id==='build').done,false);
  assert.equal(currentAwareness().context.selectedTaskId,'build');
  assert.equal(currentAwareness().activities.length,1,'agent events must not be presented as user activity');
  assert.equal(task('build').getAttribute('aria-pressed'),'true');
  assert.match(task('build').className,/highlighted/);
  await task('verify').click();
  assert.equal(currentAwareness().context.selectedTaskId,'verify');
  assert.equal(host.observe().projection.highlightedTaskId,'build');
  assert.equal(task('build').getAttribute('aria-pressed'),'false');
  assert.equal(task('verify').getAttribute('aria-pressed'),'true');
  assert.equal(requests.filter(request=>request.method==='submit').length,1);
  await element('agent').click();
  const submitted=requests.filter(request=>request.method==='submit').map(request=>request.args[0]);
  assert.deepEqual(submitted.map(command=>[command.operation,command.arguments.taskId]),[['interface.showTask','build'],['tasks.complete','verify']]);
  assert.equal(host.observe().projection.tasks.find(item=>item.id==='verify').done,true);
  assert.equal(host.observe().projection.highlightedTaskId,'build');
  assert.equal(currentAwareness().activities.some(event=>event.name==='ui.task_completed'),false);
  assert.equal(element('latest-user-activity').textContent,'Selected Verify the interaction');
});

test('human completion becomes user activity only after its commit is confirmed, once across recovery and retries',async t=>{
  const {element,host,drop}=await sample(t);
  const activities=()=>JSON.parse(element('awareness').textContent).activities;
  const completions=()=>activities().filter(event=>event.name==='ui.task_completed');
  await element('tasks').children[0].click();drop('submit');await element('complete').click();
  assert.equal(host.observe().projection.tasks[0].done,true);
  assert.equal(completions().length,0,'an uncertain reply is not confirmed user completion');
  await element('recover').click();
  assert.equal(completions().length,1);
  assert.equal(completions()[0].context.actor,'user');
  assert.equal(completions()[0].properties.taskId,'design');
  assert.equal(element('latest-user-activity').textContent,'Completed Design the interface');
  await element('retry').click();await element('recover').click();
  assert.equal(completions().length,1,'exact retries and repeated lookups must not duplicate semantic user events');
  await element('stale').click();
  assert.match(element('result').textContent,/STATE_CONFLICT/);
  assert.equal(completions().length,1,'a rejected completion must not become user activity');
  assert.equal(host.observe().sceneRevision,1);
});

test('lost highlight acknowledgement recovers exact identity without becoming human activity',async t=>{
  const {element,host,requests,drop}=await sample(t);
  await element('tasks').children[1].click();drop('submit');await element('agent-highlight').click();
  assert.equal(host.observe().projection.highlightedTaskId,'build');
  assert.equal(element('agent-highlight').disabled,true);
  await element('retry').click();
  const attempts=requests.filter(request=>request.method==='submit');
  assert.equal(attempts.length,2);assert.deepEqual(attempts[0].args[0],attempts[1].args[0]);
  assert.equal(host.observe().sceneRevision,1);
  const awareness=JSON.parse(element('awareness').textContent);
  assert.equal(awareness.context.selectedTaskId,'build');
  assert.deepEqual(awareness.activities.map(event=>event.name),['ui.task_selected']);
});
