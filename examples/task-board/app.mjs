import {createInteractionClient, createEventStream, SDK_EVENT_CATALOG} from '/sdk/index.mjs';

const $ = id => document.getElementById(id);
const stream = createEventStream({maxEvents: 100, catalog: {
  ...SDK_EVENT_CATALOG,
  'ui.task_selected': {properties: {taskId: {type: 'string', maxLength: 160}}, required: ['taskId']},
  'agent.step_started': {properties: {taskId: {type: 'string', maxLength: 160}}, required: ['taskId']}
}});
let observation, previousObservation, lastMutation, selection, busy = false, uncertain = false;
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
function render() {
  $('tasks').replaceChildren();
  for (const task of observation?.projection.tasks ?? []) {
    const button = document.createElement('button'); button.className = `task ${task.done ? 'done' : ''}`; button.type = 'button';
    button.setAttribute('aria-pressed', String(selection === task.id)); button.disabled = busy;
    const title = document.createElement('span'); title.textContent = task.title;
    const state = document.createElement('span'); state.className = 'state'; state.textContent = task.done ? '✓ Complete' : 'Ready';
    button.append(title, state); button.addEventListener('click', () => {selection = task.id; stream.track('ui.task_selected', {taskId: task.id}, {actor: 'user', traceId: sessionId}); render();});
    $('tasks').append(button);
  }
  const selected = observation?.projection.tasks.find(task => task.id === selection);
  $('complete').disabled = busy || uncertain || !selected || selected.done;
  $('agent').disabled = busy || uncertain || !observation?.projection.tasks.some(task => !task.done);
  $('retry').disabled = busy || !lastMutation;
  $('recover').disabled = busy || !lastMutation;
  $('retry').textContent = lastMutation?.method === 'control' ? 'Retry exact last control' : 'Retry exact last command';
  $('recover').textContent = lastMutation?.method === 'control' ? 'Look up last control outcome' : 'Look up last outcome';
  $('stale').disabled = busy || uncertain || !previousObservation || !observation?.projection.tasks.some(task => !task.done);
  $('interrupt').disabled = busy || uncertain || !observation;
  $('refresh').disabled = busy;
  $('lose-reply').disabled = busy;
  if (observation) {$('revision').textContent = `Revision ${observation.sceneRevision}`; $('projection').textContent = JSON.stringify(observation.projection, null, 2);}
}
async function refresh() {observation = await client.observe(); render();}
async function run(work) {
  if (busy) return; busy = true; render();
  try {await work();} catch (error) {
    if (error.uncertain) {
      uncertain = true;
      // The SDK retains the exact unresolved request, including scoped controls.
      if (error.request && ['submit', 'control'].includes(error.operation)) lastMutation = {method:error.operation, envelope:error.request};
      message('Reply lost: the operation may have committed. Look up its outcome or retry that exact operation.', true);
    }
    else message(`Request failed: ${error.code ?? 'connection unavailable'}.`, true);
  } finally {busy = false; render();}
}
async function executeMutation(method, envelope) {
  lastMutation = {method, envelope};
  const result = await client[method](envelope);
  uncertain = false;
  message(result.status === 'committed'
    ? method === 'control' ? 'Scope interruption: committed. Committed tasks are preserved.' : `Committed ${envelope.operation}. Command ${envelope.commandId.split(':').at(-1)} is recorded.`
    : `Rejected: ${result.code}. Refresh the observation before preparing a new operation.`, result.status !== 'committed');
  await refresh();
}
async function complete(taskId, basis = observation) {
  previousObservation = structuredClone(basis);
  await executeMutation('submit', client.prepare('tasks.complete', {taskId}, {observation: basis, commandId: `${sessionId}:${++commandSequence}`}));
}
$('complete').addEventListener('click', () => run(() => complete(selection)));
$('agent').addEventListener('click', () => run(async () => {
  await refresh();
  const selectedEvent = stream.history().events.filter(event => event.name === 'ui.task_selected').at(-1);
  const task = observation.projection.tasks.find(task => task.id === selectedEvent?.properties.taskId && !task.done) ?? observation.projection.tasks.find(task => !task.done);
  if (!task) return;
  stream.track('agent.step_started', {taskId: task.id}, {actor: 'agent', traceId: sessionId});
  await complete(task.id);
}));
$('retry').addEventListener('click', () => run(() => executeMutation(lastMutation.method, lastMutation.envelope)));
$('recover').addEventListener('click', () => run(async () => {const result = await client.getOutcome(lastMutation.envelope.commandId ?? lastMutation.envelope.operationId); uncertain = false; message(`Recorded outcome: ${result.status}${result.code ? ' · ' + result.code : ''}.`); await refresh();}));
$('stale').addEventListener('click', () => run(() => complete(observation.projection.tasks.find(task => !task.done).id, previousObservation)));
$('refresh').addEventListener('click', () => run(async () => {await refresh(); message(uncertain ? 'Board refreshed. Resolve the uncertain operation by outcome lookup or exact retry.' : 'Fresh observation received.');}));
$('interrupt').addEventListener('click', () => run(() => executeMutation('control', client.prepareControl('interrupt', {observation, operationId: `${sessionId}:stop:${++commandSequence}`}))));
await run(async () => {$('catalog').textContent = JSON.stringify(await client.catalog(), null, 2); await refresh(); message('Ready. Select a task to publish an interface event.');});
