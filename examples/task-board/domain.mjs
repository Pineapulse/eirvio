import {Runtime, Registry, MemoryStore, DomainError} from '../../packages/core/src/index.mjs';
import {createInteractionHost} from '../../packages/sdk/src/host.mjs';

export const actions = [{
  name: 'tasks.complete',
  description: 'Mark one existing task complete. A stale board observation is rejected.',
  parameters: {type: 'object', properties: {taskId: {type: 'string', enum: ['design', 'build', 'verify']}}, required: ['taskId'], additionalProperties: false}
}];

export function createTaskBoard() {
  const registry = new Registry().register({
    ruleset: 'example.tasks', rulesVersion: '1', stateSchemaVersion: '1',
    validateState: state => Object.keys(state).length === 1 && Array.isArray(state.tasks) && state.tasks.length === 3 &&
      state.tasks.every((task, i) => task.id === ['design', 'build', 'verify'][i] && typeof task.title === 'string' && typeof task.done === 'boolean'),
    project: state => state,
    operations: {
      'tasks.complete': {
        validate: args => Object.keys(args).length === 1 && ['design', 'build', 'verify'].includes(args.taskId),
        apply(state, args) {
          const task = state.tasks.find(task => task.id === args.taskId);
          if (!task || task.done) throw new DomainError('RULE_VIOLATION');
          task.done = true;
          return {state, result: {taskId: task.id, done: true}};
        }
      }
    }
  });
  const store = new MemoryStore();
  const runtime = Runtime.create({
    runtimeId: 'task-board', runtimeFence: 'initial-fence',
    scenes: [{sceneId: 'workspace', kind: 'canonical', ruleset: 'example.tasks', rulesVersion: '1', stateSchemaVersion: '1', sceneRevision: 0,
      state: {tasks: [{id: 'design', title: 'Design the interface', done: false}, {id: 'build', title: 'Connect the agent', done: false}, {id: 'verify', title: 'Verify the interaction', done: false}]}}],
    scopes: ['interface'], views: [{viewId: 'task-list', viewEpoch: 0, interactionRevision: 0, sceneId: 'workspace'}]
  }, registry, store);
  const host = createInteractionHost({runtime, sceneId: 'workspace', scopeId: 'interface', viewId: 'task-list', actions,
    getContext: () => ({runtimeId: 'task-board', scenes: ['workspace'], scopes: ['interface'], operations: ['tasks.complete'],
      controls: ['interrupt', 'closeScope'], observe: true, inspect: true, audience: 'public'})});
  return {host, runtime, store};
}
