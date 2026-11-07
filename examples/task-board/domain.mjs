import {Runtime, Registry, MemoryStore, DomainError} from '../../packages/core/src/index.mjs';
import {createInteractionHost} from '../../packages/sdk/src/host.mjs';

const taskIds = ['design', 'build', 'verify'];
const taskParameters = {type: 'object', properties: {taskId: {type: 'string', enum: taskIds}}, required: ['taskId'], additionalProperties: false};
const validTask = args => Object.keys(args).length === 1 && taskIds.includes(args.taskId);
export const actions = [{
  name: 'tasks.complete',
  description: 'Mark one existing task complete. A stale board observation is rejected.',
  parameters: taskParameters
}, {
  name: 'interface.showTask',
  description: 'Highlight one existing task in the visible interface without changing the user selection or completing it.',
  parameters: taskParameters
}];

export function createTaskBoard() {
  const registry = new Registry().register({
    ruleset: 'example.tasks', rulesVersion: '2', stateSchemaVersion: '2',
    validateState: state => Object.keys(state).length === 2 && ['', ...taskIds].includes(state.highlightedTaskId) && Array.isArray(state.tasks) && state.tasks.length === 3 &&
      state.tasks.every((task, i) => task.id === taskIds[i] && typeof task.title === 'string' && typeof task.done === 'boolean'),
    project: state => state,
    operations: {
      'tasks.complete': {
        validate: validTask,
        apply(state, args) {
          const task = state.tasks.find(task => task.id === args.taskId);
          if (!task || task.done) throw new DomainError('RULE_VIOLATION');
          task.done = true;
          return {state, result: {taskId: task.id, done: true}};
        }
      },
      'interface.showTask': {
        validate: validTask,
        apply(state, args) {
          if (!state.tasks.some(task => task.id === args.taskId)) throw new DomainError('RULE_VIOLATION');
          state.highlightedTaskId = args.taskId;
          return {state, result: {highlightedTaskId: args.taskId}};
        }
      }
    }
  });
  const store = new MemoryStore();
  const runtime = Runtime.create({
    runtimeId: 'task-board', runtimeFence: 'initial-fence',
    scenes: [{sceneId: 'workspace', kind: 'canonical', ruleset: 'example.tasks', rulesVersion: '2', stateSchemaVersion: '2', sceneRevision: 0,
      state: {highlightedTaskId: '', tasks: [{id: 'design', title: 'Design the interface', done: false}, {id: 'build', title: 'Connect the agent', done: false}, {id: 'verify', title: 'Verify the interaction', done: false}]}}],
    scopes: ['interface'], views: [{viewId: 'task-list', viewEpoch: 0, interactionRevision: 0, sceneId: 'workspace'}]
  }, registry, store);
  const host = createInteractionHost({runtime, sceneId: 'workspace', scopeId: 'interface', viewId: 'task-list', actions,
    getContext: () => ({runtimeId: 'task-board', scenes: ['workspace'], scopes: ['interface'], operations: actions.map(action => action.name),
      controls: ['interrupt', 'closeScope'], observe: true, inspect: true, audience: 'public'})});
  return {host, runtime, store};
}
