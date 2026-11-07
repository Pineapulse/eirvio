import {createInteractionClient, createEventStream, createInterfaceAwareness, SDK_EVENT_CATALOG} from '/sdk/index.mjs';

const $ = id => document.getElementById(id);
const stream = createEventStream({maxEvents: 100, catalog: {
  ...SDK_EVENT_CATALOG,
  'ui.task_selected': {properties: {taskId: {type: 'string', maxLength: 160}}, required: ['taskId']},
  'ui.task_completed': {properties: {taskId: {type: 'string', maxLength: 160}, operationId: {type: 'string', maxLength: 160}}, required: ['taskId', 'operationId']},
  'agent.step_started': {properties: {taskId: {type: 'string', maxLength: 160}, operation: {type: 'string', maxLength: 160}}, required: ['taskId', 'operation']}
}});
const awareness = createInterfaceAwareness({events: stream, surface: {id: 'task-board', kind: 'website', name: 'Launch checklist'},
  contextSchema: {properties: {selectedTaskId: {type: 'string', enum: ['', 'design', 'build', 'verify']}}, required: ['selectedTaskId']},
  initialContext: {selectedTaskId: ''}});
let observation, previousObservation, lastMutation, busy = false, uncertain = false;
const publishedCompletions = new Set();
let commandSequence = 0;
const sessionId = crypto.randomUUID();
async function rpc(method, args = []) {
  const loseReply = method === 'submit' && $('lose-reply').checked;
  if (loseReply) $('lose-reply').checked = false;
  const response = await fetch('/api/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({method, args, loseReply}), signal: AbortSignal.timeout(10000)});
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error), {code: body.error});
  return body;
}
const transport = Object.fromEntries(['observe', 'catalog', 'submit', 'getOutcome', 'control'].map(method => [method, (...args) => rpc(method, args)]));
const client = createInteractionClient({transport, events: stream});
const unsubscribeAwareness = awareness.subscribe(() => renderAwareness());
globalThis.addEventListener?.('pagehide', event => {if (!event.persisted) {unsubscribeAwareness(); awareness.dispose();}});
stream.subscribe(() => {
  const history = stream.history(); $('event-count').textContent = `${history.cursor} events`;
  $('events').replaceChildren();
  for (const event of history.events.slice(-24).reverse()) {
    const row = document.createElement('li');
    for (const [className, value] of [['cursor', `#${event.cursor}`], ['actor', event.context.actor], ['event-name', event.name], ['event-properties', JSON.stringify(event.properties)]]) {
      const span = document.createElement('span'); span.className = className; span.textContent = value; row.append(span);
    }
    $('events').append(row);
  }
});
function message(text, error = false) {$('result').textContent = text; $('result').dataset.state = error ? 'error' : 'ok';}
function taskTitle(id) {return observation?.projection.tasks.find(task => task.id === id)?.title ?? id;}
function renderAwareness() {
  const current = awareness.snapshot(), latest = current.activities.at(-1);
  $('user-context').textContent = current.context.selectedTaskId ? taskTitle(current.context.selectedTaskId) : 'No task selected';
  $('latest-user-activity').textContent = latest
    ? `${latest.name === 'ui.task_completed' ? 'Completed' : 'Selected'} ${taskTitle(latest.properties.taskId)}`
    : current.gap ? 'Earlier activity has left the local history' : 'No user interaction yet';
  $('awareness').textContent = JSON.stringify(current, null, 2);
}
function render() {
  const selection = awareness.snapshot().context.selectedTaskId;
  $('tasks').replaceChildren();
  for (const task of observation?.projection.tasks ?? []) {
    const highlighted = observation.projection.highlightedTaskId === task.id;
    const button = document.createElement('button'); button.className = `task${task.done ? ' done' : ''}${highlighted ? ' highlighted' : ''}`; button.type = 'button'; button.dataset.taskId = task.id;
    button.setAttribute('aria-pressed', String(selection === task.id)); button.disabled = busy;
    const title = document.createElement('span'); title.className = 'task-title'; title.textContent = task.title;
    const state = document.createElement('span'); state.className = 'state'; state.textContent = task.done ? '✓ Complete' : 'Ready';
    const markers = document.createElement('span'); markers.className = 'task-markers';
    if (selection === task.id) {const marker = document.createElement('span'); marker.className = 'user-marker'; marker.textContent = 'Selected by you'; markers.append(marker);}
    if (highlighted) {const marker = document.createElement('span'); marker.className = 'agent-marker'; marker.textContent = 'Agent highlight'; markers.append(marker);}
    button.append(title, state, markers);
    button.addEventListener('click', () => {awareness.updateContext({selectedTaskId: task.id}); stream.track('ui.task_selected', {taskId: task.id}, {actor: 'user', traceId: sessionId}); render();});
    $('tasks').append(button);
  }
  const selected = observation?.projection.tasks.find(task => task.id === selection);
  $('complete').disabled = busy || uncertain || !selected || selected.done;
  $('agent').disabled = busy || uncertain || !selected || selected.done;
  $('agent-highlight').disabled = busy || uncertain || !selected;
  $('retry').disabled = busy || !lastMutation;
  $('recover').disabled = busy || !lastMutation;
  $('retry').textContent = lastMutation?.method === 'control' ? 'Retry exact last control' : 'Retry exact last command';
  $('recover').textContent = lastMutation?.method === 'control' ? 'Look up last control outcome' : 'Look up last outcome';
  $('stale').disabled = busy || uncertain || !previousObservation || !observation?.projection.tasks.some(task => !task.done);
  $('interrupt').disabled = busy || uncertain || !observation;
  $('refresh').disabled = busy;
  $('lose-reply').disabled = busy;
  if (observation) {$('revision').textContent = `Revision ${observation.sceneRevision}`; $('projection').textContent = JSON.stringify(observation.projection, null, 2);}
  renderAwareness();
}
async function refresh() {observation = await client.observe(); render();}
async function run(work) {
  if (busy) return; busy = true; render();
  try {await work();} catch (error) {
    if (error.uncertain) {
      uncertain = true;
      // The SDK retains the exact unresolved request, including scoped controls.
      if (error.request && ['submit', 'control'].includes(error.operation)) {
        const same = lastMutation?.method === error.operation && (lastMutation.envelope.commandId ?? lastMutation.envelope.operationId) === error.operationId;
        lastMutation = {method:error.operation, envelope:error.request, actor:same ? lastMutation.actor : 'system'};
      }
      message('Reply lost: the operation may have committed. Look up its outcome or retry that exact operation.', true);
    }
    else message(`Request failed: ${error.code ?? 'connection unavailable'}.`, true);
  } finally {busy = false; render();}
}
function recordCommittedUserActivity(mutation, outcome) {
  const {method, envelope, actor} = mutation;
  if (method !== 'submit' || actor !== 'user' || envelope.operation !== 'tasks.complete' || outcome.status !== 'committed' || publishedCompletions.has(envelope.commandId)) return;
  stream.track('ui.task_completed', {taskId: envelope.arguments.taskId, operationId: envelope.commandId}, {actor: 'user', traceId: sessionId, correlationId: envelope.commandId});
  publishedCompletions.add(envelope.commandId);
}
async function executeMutation(method, envelope, actor = 'system') {
  lastMutation = {method, envelope, actor};
  const result = await client[method](envelope);
  recordCommittedUserActivity(lastMutation, result);
  uncertain = false;
  message(result.status === 'committed'
    ? method === 'control' ? 'Scope interruption: committed. Committed tasks are preserved.'
      : envelope.operation === 'interface.showTask' ? `Agent highlighted ${taskTitle(envelope.arguments.taskId)}. Your selection stays yours.`
        : `${actor === 'agent' ? 'Agent completed' : 'You completed'} ${taskTitle(envelope.arguments.taskId)}.`
    : `Rejected: ${result.code}. Refresh the observation before preparing a new operation.`, result.status !== 'committed');
  await refresh();
}
async function complete(taskId, basis = observation, actor = 'user') {
  previousObservation = structuredClone(basis);
  await executeMutation('submit', client.prepare('tasks.complete', {taskId}, {observation: basis, commandId: `${sessionId}:${++commandSequence}`}), actor);
}
$('complete').addEventListener('click', () => run(() => complete(awareness.snapshot().context.selectedTaskId)));
async function agentStep(operation) {
  await refresh();
  const current = awareness.snapshot();
  const task = observation.projection.tasks.find(task => task.id === current.context.selectedTaskId);
  if (!task) {message('Select a task for the agent first.'); return;}
  stream.track('agent.step_started', {taskId: task.id, operation}, {actor: 'agent', traceId: sessionId});
  if (operation === 'tasks.complete') await complete(task.id, observation, 'agent');
  else {
    previousObservation = structuredClone(observation);
    await executeMutation('submit', client.prepare(operation, {taskId: task.id}, {observation, commandId: `${sessionId}:${++commandSequence}`}), 'agent');
  }
}
$('agent').addEventListener('click', () => run(() => agentStep('tasks.complete')));
$('agent-highlight').addEventListener('click', () => run(() => agentStep('interface.showTask')));
$('retry').addEventListener('click', () => run(() => executeMutation(lastMutation.method, lastMutation.envelope, lastMutation.actor)));
$('recover').addEventListener('click', () => run(async () => {const result = await client.getOutcome(lastMutation.envelope.commandId ?? lastMutation.envelope.operationId); recordCommittedUserActivity(lastMutation, result); uncertain = false; message(`Recorded outcome: ${result.status}${result.code ? ' · ' + result.code : ''}.`); await refresh();}));
$('stale').addEventListener('click', () => run(() => complete(observation.projection.tasks.find(task => !task.done).id, previousObservation)));
$('refresh').addEventListener('click', () => run(async () => {await refresh(); message(uncertain ? 'Board refreshed. Resolve the uncertain operation by outcome lookup or exact retry.' : 'Fresh observation received.');}));
$('interrupt').addEventListener('click', () => run(() => executeMutation('control', client.prepareControl('interrupt', {observation, operationId: `${sessionId}:stop:${++commandSequence}`}))));
await run(async () => {$('catalog').textContent = JSON.stringify(await client.catalog(), null, 2); await refresh(); message('Select a task, then ask the agent to highlight it or complete it.');});
