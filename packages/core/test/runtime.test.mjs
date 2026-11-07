import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, Registry, MemoryStore, replay } from '../src/index.mjs';
import { counterRegistry, makeSpec } from '../examples/toy.mjs';

const VERSION = '0.1.0';
const ADMIN = { runtimeId: 'toy-runtime', admin: true };
const clone = (value) => structuredClone(value);

function setup() {
  const registry = counterRegistry();
  const store = new MemoryStore();
  const runtime = Runtime.create(makeSpec(), registry, store);
  return { runtime, registry, store };
}

function state(runtime) { return runtime.snapshot(ADMIN); }
function value(runtime, sceneId = 'main') { return state(runtime).scenes[sceneId].state.value; }

function command(runtime, id, amount = 1, { sceneId = 'main', scopeId = 'coach', view = true, ...guards } = {}) {
  const s = state(runtime);
  const result = {
    protocolVersion: VERSION, commandId: id, runtimeId: 'toy-runtime',
    target: { sceneId }, operation: 'counter.add', arguments: { amount },
    guards: {
      runtimeFence: s.runtimeFence, expectedSceneRevision: s.scenes[sceneId].sceneRevision,
      scopeId, scopeEpoch: s.scopes[scopeId].epoch, ...guards,
    },
  };
  if (view) {
    const current = s.views.board;
    result.guards.view = { viewId: 'board', viewEpoch: current.viewEpoch, interactionRevision: current.interactionRevision };
  }
  return result;
}

function control(runtime, id, action, extra = {}) {
  const s = state(runtime);
  return {
    protocolVersion: VERSION, operationId: id, runtimeId: 'toy-runtime', action,
    runtimeFence: s.runtimeFence, expectedControlRevision: s.controlRevision, ...extra,
  };
}

function stop(runtime, id, action = 'interrupt') {
  return control(runtime, id, action, { scopeId: 'coach', scopeEpoch: state(runtime).scopes.coach.epoch });
}

// Rejections may be terminal results or pre-admission exceptions. In either case,
// a stable code is observable and no success is inferred from a thrown error.
function resultOf(fn) {
  try { return fn(); }
  catch (error) {
    if (!error.code) throw error;
    return { status: 'rejected', code: error.code };
  }
}

function rejected(fn, code) {
  const result = resultOf(fn);
  assert.ok(result && ['rejected', 'failed', 'canceled'].includes(result.status), `expected rejection, got ${JSON.stringify(result)}`);
  if (code) assert.equal(result.code, code);
  return result;
}

function plan(runtime, id, steps) {
  return {
    protocolVersion: VERSION, sequenceId: id, runtimeId: 'toy-runtime', sceneId: 'main',
    guards: command(runtime, 'unused').guards, steps,
  };
}

function presentationPlan(runtime, id) {
  return plan(runtime, id, [
    { id: 'change', kind: 'invoke', operation: 'counter.add', arguments: { amount: 1 }, expectedRevision: state(runtime).scenes.main.sceneRevision },
    { id: 'show', kind: 'effect', effectKind: 'toy.show', parameters: { label: 'One' }, revisionFromStep: 'change' },
    { id: 'visible', kind: 'wait', effectStepId: 'show', layer: 'presentation.reconciled', timeoutTicks: 5, timeoutPolicy: 'degrade' },
    { id: 'done', kind: 'finish' },
  ]);
}

function receipt(effect, id, extra = {}) {
  const result = {
    protocolVersion: VERSION, receiptId: id, runtimeId: effect.runtimeId,
    effectId: effect.effectId, sceneId: effect.sceneId, sceneRevision: effect.sceneRevision,
    runtimeFence: effect.runtimeFence, scopeId: effect.scopeId, scopeEpoch: effect.scopeEpoch,
    layer: 'presentation.reconciled', status: 'completed', presentationMode: 'reduced_motion', ...extra,
  };
  if (effect.view) result.view = clone(effect.view);
  return result;
}

function advancePresentation(runtime, id) {
  assert.equal(runtime.submitSequence(presentationPlan(runtime, id), ADMIN).status, 'admitted');
  runtime.advance(id, ADMIN); // Commit the domain transition.
  runtime.advance(id, ADMIN); // Persist the presentation intent.
  return runtime.claimEffect(`${id}/show`, ADMIN);
}

test('a registered rule commits once and observations/snapshots cannot mutate authority', () => {
  const { runtime } = setup();
  const before = runtime.observe('main', 'coach', ADMIN, 'board');
  assert.equal(before.sceneRevision, 0);
  assert.equal(before.projection.value, 0);
  const outcome = runtime.submit(command(runtime, 'first', 3), ADMIN);
  assert.equal(outcome.status, 'committed');
  assert.equal(outcome.previousRevision, 0);
  assert.equal(outcome.sceneRevision, 1);
  assert.equal(value(runtime), 3);
  before.projection.value = 99;
  const privateCopy = state(runtime);
  privateCopy.scenes.main.state.value = 88;
  assert.equal(value(runtime), 3);
});

test('rules, malformed numbers, unknown operations and missing grants never change domain state', () => {
  const { runtime } = setup();
  rejected(() => runtime.submit(command(runtime, 'underflow', -1), ADMIN), 'RULE_VIOLATION');
  for (const [i, amount] of [NaN, Infinity, 1.5, 11].entries()) {
    rejected(() => runtime.submit(command(runtime, `malformed-${i}`, amount), ADMIN));
  }
  const unknown = command(runtime, 'unknown');
  unknown.operation = 'unregistered.patch';
  rejected(() => runtime.submit(unknown, ADMIN), 'UNKNOWN_OPERATION');
  rejected(() => runtime.submit(command(runtime, 'untrusted'), { runtimeId: 'toy-runtime' }), 'FORBIDDEN');
  assert.equal(value(runtime), 0);
  assert.equal(state(runtime).scenes.main.sceneRevision, 0);
});

test('idempotency returns original success and rejection before new freshness checks', () => {
  const { runtime } = setup();
  const original = command(runtime, 'once', 2);
  const committed = runtime.submit(original, ADMIN);
  const invalid = command(runtime, 'rejected-once', -3);
  const refusal = resultOf(() => runtime.submit(invalid, ADMIN));
  assert.equal(refusal.code, 'RULE_VIOLATION');
  runtime.control(stop(runtime, 'interrupt'), ADMIN);
  runtime.submit(command(runtime, 'later', 4), ADMIN);
  const cursor = state(runtime).eventCursor;
  assert.deepEqual(runtime.submit(clone(original), ADMIN), committed);
  assert.deepEqual(resultOf(() => runtime.submit(clone(invalid), ADMIN)), refusal);
  assert.equal(state(runtime).eventCursor, cursor);
  const changed = clone(original);
  changed.arguments.amount = 5;
  rejected(() => runtime.submit(changed, ADMIN), 'DUPLICATE_ID_MISMATCH');
  rejected(() => runtime.getOutcome('once', { runtimeId: 'other', admin: true }), 'FORBIDDEN');
  assert.equal(value(runtime), 6);
});

test('competing producers with identical revision guards have exactly one winner in either order', async () => {
  for (const reverse of [false, true]) {
    const { runtime } = setup();
    const candidates = [command(runtime, 'a', 2), command(runtime, 'b', 3)];
    if (reverse) candidates.reverse();
    const results = await Promise.all(candidates.map((intent) => Promise.resolve().then(() => resultOf(() => runtime.submit(intent, ADMIN)))));
    assert.equal(results.filter((x) => x.status === 'committed').length, 1);
    assert.equal(results.filter((x) => x.code === 'STATE_CONFLICT').length, 1);
    assert.equal(value(runtime), reverse ? 3 : 2);
    rejected(() => runtime.submit(command(runtime, 'future', 1, { expectedSceneRevision: 2 }), ADMIN), 'STATE_CONFLICT');
    assert.equal(state(runtime).scenes.main.sceneRevision, 1);
  }
});

test('cancellation order preserves earlier commits and fences later work; interrupt retry is inert', () => {
  for (const commitFirst of [false, true]) {
    const { runtime } = setup();
    const intent = command(runtime, 'move');
    const interrupt = stop(runtime, 'stop');
    let committed;
    if (commitFirst) committed = runtime.submit(intent, ADMIN);
    const stopped = runtime.control(interrupt, ADMIN);
    if (commitFirst) assert.deepEqual(runtime.submit(intent, ADMIN), committed);
    else rejected(() => runtime.submit(intent, ADMIN), 'SUPERSEDED_SCOPE');
    assert.equal(value(runtime), commitFirst ? 1 : 0);
    const fresh = runtime.submit(command(runtime, 'fresh'), ADMIN);
    assert.equal(fresh.status, 'committed');
    const afterFresh = state(runtime);
    assert.deepEqual(runtime.control(interrupt, ADMIN), stopped);
    assert.equal(state(runtime).scopes.coach.epoch, 1);
    assert.equal(state(runtime).eventCursor, afterFresh.eventCursor);
    rejected(() => runtime.control({ ...interrupt, operationId: 'new-stale-stop' }, ADMIN));
    assert.equal(state(runtime).scopes.coach.epoch, 1);
  }
});

test('selection context changes invalidate attention guards without a scene mutation', () => {
  const { runtime } = setup();
  const oldIntent = command(runtime, 'old-focus');
  runtime.control(control(runtime, 'focus-b', 'bindView', {
    sceneId: 'main', view: { viewId: 'board', viewEpoch: 0, interactionRevision: 1 },
  }), ADMIN);
  assert.equal(state(runtime).scenes.main.sceneRevision, 0);
  rejected(() => runtime.submit(oldIntent, ADMIN), 'STALE_INTERACTION');
  assert.equal(runtime.submit(command(runtime, 'current-focus'), ADMIN).status, 'committed');
});

test('storage failure before commit is atomic; lost acknowledgement is recovered without a duplicate', () => {
  const { runtime, store, registry } = setup();
  const intent = command(runtime, 'crash-command', 4);
  const initial = state(runtime);
  store.failNext = 'before';
  assert.throws(() => runtime.submit(intent, ADMIN));
  assert.deepEqual(state(runtime), initial);
  store.failNext = 'after';
  assert.throws(() => runtime.submit(intent, ADMIN));
  assert.equal(value(runtime), 4);
  const storedOutcome = runtime.getOutcome(intent.commandId, ADMIN);
  const recovered = new Runtime(registry, MemoryStore.fromReplay(runtime.exportReplay(ADMIN), registry));
  recovered.control(control(recovered, 'recover', 'recover', { newRuntimeFence: 'fence-2' }), ADMIN);
  const cursor = state(recovered).eventCursor;
  assert.deepEqual(recovered.submit(intent, ADMIN), storedOutcome);
  assert.equal(state(recovered).eventCursor, cursor);
  assert.equal(value(recovered), 4);
  const abandoned = { ...clone(intent), commandId: 'old-fence-command' };
  rejected(() => recovered.submit(abandoned, ADMIN), 'STALE_RUNTIME');
});

test('recovery fences the prior writer handle and preserves committed outcomes', () => {
  const { runtime, store, registry } = setup();
  const intent = command(runtime, 'saved');
  const outcome = runtime.submit(intent, ADMIN);
  const replacement = new Runtime(registry, store);
  replacement.control(control(replacement, 'takeover', 'recover', { newRuntimeFence: 'fence-2' }), ADMIN);
  assert.deepEqual(replacement.submit(intent, ADMIN), outcome);
  rejected(() => runtime.submit(command(replacement, 'old-writer'), ADMIN), 'STALE_WRITER');
  assert.equal(value(replacement), 1);
});

test('retrying an older recovery operation does not grant a subsequently replaced writer fence', () => {
  const { runtime, store, registry } = setup();
  const firstRecovery = control(runtime, 'first-recovery', 'recover', { newRuntimeFence: 'fence-2' });
  const originalOutcome = runtime.control(firstRecovery, ADMIN);
  const replacement = new Runtime(registry, store);
  replacement.control(control(replacement, 'second-recovery', 'recover', { newRuntimeFence: 'fence-3' }), ADMIN);
  assert.deepEqual(runtime.control(firstRecovery, ADMIN), originalOutcome);
  rejected(() => runtime.submit(command(replacement, 'superseded-writer'), ADMIN), 'STALE_WRITER');
  assert.equal(value(replacement), 0);
});

test('replay reconstructs all checkpoints without invoking current reducers or projectors', () => {
  const { runtime } = setup();
  const snapshots = [state(runtime)];
  const exports = [runtime.exportReplay(ADMIN)];
  runtime.submit(command(runtime, 'one', 3), ADMIN);
  snapshots.push(state(runtime)); exports.push(runtime.exportReplay(ADMIN));
  runtime.control(stop(runtime, 'stop'), ADMIN);
  snapshots.push(state(runtime)); exports.push(runtime.exportReplay(ADMIN));
  let calls = 0;
  const registry = new Registry();
  registry.register({
    ruleset: 'toy.counter', rulesVersion: '1', stateSchemaVersion: '1',
    validateState(s) { return Number.isInteger(s.value) && s.value >= 0 && s.value <= 100; },
    operations: { 'counter.add': { validate() {}, apply() { calls++; throw new Error('replay executed a reducer'); } } },
    project() { calls++; throw new Error('replay executed a projector'); },
  });
  for (let i = 0; i < exports.length; i++) assert.deepEqual(replay(exports[i], registry), snapshots[i]);
  assert.equal(calls, 0);
});

test('missing, reordered, corrupted and unsupported replay evidence fails explicitly', () => {
  const { runtime, registry } = setup();
  for (let i = 0; i < 3; i++) runtime.submit(command(runtime, `step-${i}`), ADMIN);
  const valid = runtime.exportReplay(ADMIN);
  const changed = clone(valid); changed.records[1].state.scenes.main.state.value = 77;
  const gap = clone(valid); gap.records.splice(1, 1);
  const missingTail = clone(valid); missingTail.records.pop();
  const missingAll = clone(valid); missingAll.records = [];
  const reordered = clone(valid); [reordered.records[0], reordered.records[1]] = [reordered.records[1], reordered.records[0]];
  const genesis = clone(valid); genesis.genesis.scenes.main.state.value = 55;
  const version = clone(valid); version.engineVersion = '99.0.0';
  for (const fixture of [changed, gap, missingTail, missingAll, reordered, genesis, version]) {
    assert.throws(() => replay(fixture, registry), (error) => typeof error.code === 'string' && error.code.length > 0);
  }
  assert.deepEqual(replay(valid, registry), state(runtime));
});

test('sequence cancellation preserves its committed checkpoint and cannot resume via duplicate admission', () => {
  const { runtime } = setup();
  const sequence = plan(runtime, 'two-steps', [
    { id: 'first', kind: 'invoke', operation: 'counter.add', arguments: { amount: 2 }, expectedRevision: 0 },
    { id: 'second', kind: 'invoke', operation: 'counter.add', arguments: { amount: 3 }, revisionFromStep: 'first' },
    { id: 'finish', kind: 'finish' },
  ]);
  const admitted = runtime.submitSequence(sequence, ADMIN);
  runtime.advance(sequence.sequenceId, ADMIN);
  assert.equal(value(runtime), 2);
  runtime.control(stop(runtime, 'cancel-sequence'), ADMIN);
  assert.equal(runtime.getSequence(sequence.sequenceId, ADMIN).status, 'canceled');
  assert.deepEqual(runtime.submitSequence(sequence, ADMIN), admitted);
  for (let i = 0; i < 3; i++) runtime.advance(sequence.sequenceId, ADMIN);
  assert.equal(value(runtime), 2);
  assert.equal(runtime.getSequence(sequence.sequenceId, ADMIN).status, 'canceled');
});

test('a dependent step binds the actual preceding revision and rejects an intervening mutation', () => {
  const { runtime } = setup();
  runtime.submitSequence(plan(runtime, 'dependent', [
    { id: 'first', kind: 'invoke', operation: 'counter.add', arguments: { amount: 2 }, expectedRevision: 0 },
    { id: 'second', kind: 'invoke', operation: 'counter.add', arguments: { amount: 3 }, revisionFromStep: 'first' },
    { id: 'finish', kind: 'finish' },
  ]), ADMIN);
  runtime.advance('dependent', ADMIN);
  runtime.submit(command(runtime, 'intervening', 4, { scopeId: 'learner' }), ADMIN);
  runtime.advance('dependent', ADMIN);
  assert.equal(runtime.getSequence('dependent', ADMIN).status, 'failed');
  assert.equal(value(runtime), 6);
  assert.equal(state(runtime).scenes.main.sceneRevision, 2);
});

test('current grants protect duplicate outcome access and are rechecked at every sequence checkpoint', () => {
  const allowed = {
    runtimeId: 'toy-runtime', scenes: ['main'], scopes: ['coach'],
    operations: ['counter.add'], effects: ['toy.show'], inspect: true,
  };
  const revoked = { ...allowed, operations: [] };
  {
    const { runtime } = setup();
    const intent = command(runtime, 'authorized-once');
    assert.equal(runtime.submit(intent, allowed).status, 'committed');
    const before = state(runtime);
    rejected(() => runtime.submit(intent, revoked), 'FORBIDDEN');
    rejected(() => runtime.getOutcome(intent.commandId, revoked), 'FORBIDDEN');
    assert.deepEqual(state(runtime), before);
  }
  {
    const { runtime } = setup();
    runtime.submitSequence(presentationPlan(runtime, 'revoke-command'), allowed);
    runtime.advance('revoke-command', revoked);
    const seq = runtime.getSequence('revoke-command', ADMIN);
    assert.equal(seq.status, 'failed');
    assert.equal(seq.code, 'FORBIDDEN');
    assert.equal(value(runtime), 0);
  }
  {
    const { runtime } = setup();
    runtime.submitSequence(presentationPlan(runtime, 'revoke-effect'), allowed);
    runtime.advance('revoke-effect', allowed);
    runtime.advance('revoke-effect', { ...allowed, effects: [] });
    const seq = runtime.getSequence('revoke-effect', ADMIN);
    assert.equal(seq.status, 'failed');
    assert.equal(seq.code, 'FORBIDDEN');
    assert.equal(value(runtime), 1);
    assert.equal(Object.keys(state(runtime).effects).length, 0);
  }
});

test('early receipts satisfy later waits, duplicates are inert, and delivery cannot rewrite domain state', () => {
  const { runtime } = setup();
  const effect = advancePresentation(runtime, 'early');
  assert.equal(effect.effectId, 'early/show');
  const delivered = receipt(effect, 'received-early');
  const saved = runtime.receiveReceipt(delivered, ADMIN);
  const cursor = state(runtime).eventCursor;
  assert.deepEqual(runtime.receiveReceipt(delivered, ADMIN), saved);
  assert.equal(state(runtime).eventCursor, cursor);
  runtime.advance('early', ADMIN);
  runtime.advance('early', ADMIN);
  assert.equal(runtime.getSequence('early', ADMIN).status, 'completed');
  rejected(() => runtime.receiveReceipt(receipt(effect, 'contradiction', { status: 'failed' }), ADMIN));
  assert.equal(value(runtime), 1);
  assert.equal(state(runtime).scenes.main.sceneRevision, 1);
});

test('cancellation fences delayed effects and receipts and never revives canceled waits', () => {
  const { runtime } = setup();
  const effect = advancePresentation(runtime, 'late');
  runtime.advance('late', ADMIN);
  assert.equal(runtime.getSequence('late', ADMIN).status, 'waiting');
  runtime.control(stop(runtime, 'stop-late'), ADMIN);
  rejected(() => runtime.receiveReceipt(receipt(effect, 'too-late'), ADMIN));
  const claimedAgain = resultOf(() => runtime.claimEffect(effect.effectId, ADMIN));
  assert.ok(!claimedAgain || claimedAgain.status !== 'dispatched', 'canceled effect was handed off again');
  runtime.advance('late', ADMIN);
  assert.equal(runtime.getSequence('late', ADMIN).status, 'canceled');
  assert.equal(value(runtime), 1);
});

test('a system stop never aliases an already dispatched user effect ID', () => {
  const { runtime } = setup();
  runtime.submitSequence(plan(runtime, 'stop-op/stop', [
    { id: 'coach', kind: 'effect', effectKind: 'toy.show', parameters: { label: 'Cancelable output' }, expectedRevision: 0 },
    { id: 'finish', kind: 'finish' },
  ]), ADMIN);
  runtime.advance('stop-op/stop', ADMIN);
  const original = Object.values(state(runtime).effects).find((effect) => effect.kind === 'toy.show');
  assert.ok(original);
  runtime.claimEffect(original.effectId, ADMIN);
  runtime.control(stop(runtime, 'stop-op'), ADMIN);
  const effects = state(runtime).effects;
  assert.equal(effects[original.effectId].kind, 'toy.show', 'the original correlation record was overwritten');
  assert.equal(effects[original.effectId].status, 'canceled');
  const stops = Object.values(effects).filter((effect) => effect.kind === 'runtime.stop');
  assert.equal(stops.length, 1);
  assert.notEqual(stops[0].effectId, original.effectId, 'adapter deduplication would discard the stop');
});

test('logical deadlines produce explicit degraded terminal outcomes without another domain commit', () => {
  const { runtime } = setup();
  advancePresentation(runtime, 'deadline');
  runtime.advance('deadline', ADMIN);
  assert.equal(runtime.getSequence('deadline', ADMIN).status, 'waiting');
  runtime.control(control(runtime, 'elapsed', 'tick', { ticks: 5 }), ADMIN);
  runtime.advance('deadline', ADMIN);
  assert.equal(runtime.getSequence('deadline', ADMIN).status, 'degraded');
  runtime.advance('deadline', ADMIN);
  assert.equal(runtime.getSequence('deadline', ADMIN).status, 'degraded');
  assert.equal(value(runtime), 1);
});

test('receipt and deadline races follow writer order and never revive an expired wait', () => {
  for (const receiptFirst of [false, true]) {
    const { runtime } = setup();
    const effect = advancePresentation(runtime, 'deadline-race');
    runtime.advance('deadline-race', ADMIN);
    const delivered = receipt(effect, 'race-receipt');
    if (receiptFirst) assert.equal(runtime.receiveReceipt(delivered, ADMIN).status, 'completed');
    runtime.control(control(runtime, 'deadline-tick', 'tick', { ticks: 5 }), ADMIN);
    if (!receiptFirst) {
      assert.equal(runtime.getSequence('deadline-race', ADMIN).status, 'degraded');
      rejected(() => runtime.receiveReceipt(delivered, ADMIN));
    }
    runtime.advance('deadline-race', ADMIN);
    runtime.advance('deadline-race', ADMIN);
    assert.equal(runtime.getSequence('deadline-race', ADMIN).status, receiptFirst ? 'completed' : 'degraded');
    assert.equal(value(runtime), 1);
  }
});

test('closing the coach permits explicit learner work; ending the runtime closes new admission', () => {
  const { runtime } = setup();
  runtime.submit(command(runtime, 'committed-before-end', 2), ADMIN);
  runtime.control(stop(runtime, 'end-coach', 'closeScope'), ADMIN);
  rejected(() => runtime.submit(command(runtime, 'closed-coach'), ADMIN), 'SCOPE_CLOSED');
  assert.equal(runtime.submit(command(runtime, 'learner-practice', 3, { scopeId: 'learner' }), ADMIN).status, 'committed');
  runtime.control(control(runtime, 'end-activity', 'end'), ADMIN);
  rejected(() => runtime.submit(command(runtime, 'after-end', 1, { scopeId: 'learner' }), ADMIN), 'SESSION_CLOSED');
  assert.equal(value(runtime), 5);
});

test('forked scenes have independent state, revisions and lineage', () => {
  const { runtime } = setup();
  runtime.submit(command(runtime, 'main-first', 4), ADMIN);
  runtime.control(control(runtime, 'fork', 'forkScene', {
    sourceSceneId: 'main', sourceRevision: 1, sceneId: 'demo', sceneKind: 'demonstration',
  }), ADMIN);
  runtime.submit(command(runtime, 'demo-change', 2, { sceneId: 'demo', view: false }), ADMIN);
  assert.equal(value(runtime, 'main'), 4);
  assert.equal(value(runtime, 'demo'), 6);
  assert.deepEqual(state(runtime).scenes.demo.lineage, { sourceSceneId: 'main', sourceRevision: 1 });
  assert.equal(state(runtime).scenes.main.sceneRevision, 1);
  assert.equal(state(runtime).scenes.demo.sceneRevision, 1);
});

test('sequence limits and invalid dependencies are rejected before any step executes', () => {
  const { runtime } = setup();
  const excessive = Array.from({ length: 33 }, (_, i) => ({ id: `step-${i}`, kind: 'finish' }));
  rejected(() => runtime.submitSequence(plan(runtime, 'too-many', excessive), ADMIN));
  rejected(() => runtime.submitSequence(plan(runtime, 'forward-reference', [
    { id: 'first', kind: 'invoke', operation: 'counter.add', arguments: { amount: 1 }, revisionFromStep: 'later' },
    { id: 'later', kind: 'finish' },
  ]), ADMIN));
  const both = plan(runtime, 'ambiguous-binding', [
    { id: 'first', kind: 'invoke', operation: 'counter.add', arguments: { amount: 1 }, expectedRevision: 0, revisionFromStep: 'first' },
    { id: 'finish', kind: 'finish' },
  ]);
  rejected(() => runtime.submitSequence(both, ADMIN));
  rejected(() => runtime.submitSequence(plan(runtime, 's'.repeat(160), [
    { id: 'effect', kind: 'effect', effectKind: 'toy.show', parameters: { label: 'Too long to address' }, expectedRevision: 0 },
    { id: 'finish', kind: 'finish' },
  ]), ADMIN), 'INVALID_SCHEMA');
  assert.equal(Object.keys(state(runtime).effects).length, 0);
  assert.equal(value(runtime), 0);
});

test('prototype property names cannot resolve as registered operations or nonexistent scenes', () => {
  const { runtime } = setup();
  for (const name of ['toString', 'constructor', '__proto__']) {
    const intent = command(runtime, `operation-${name}`);
    intent.operation = name;
    const result = rejected(() => runtime.submit(intent, ADMIN));
    assert.ok(['UNKNOWN_OPERATION', 'INVALID_SCHEMA'].includes(result.code));
    const wrongScene = command(runtime, `scene-${name}`, 1, { view: false });
    wrongScene.target.sceneId = name;
    const sceneResult = rejected(() => runtime.submit(wrongScene, ADMIN));
    assert.ok(['UNKNOWN_SCENE', 'INVALID_SCHEMA'].includes(sceneResult.code));
  }
  assert.equal(value(runtime), 0);
});

test('hostile dictionary IDs and prototype keys are rejected cleanly or treated as ordinary IDs', () => {
  for (const id of ['toString', 'constructor', '__proto__']) {
    const { runtime } = setup();
    const intent = command(runtime, id);
    const result = resultOf(() => runtime.submit(intent, ADMIN));
    if (result.status === 'committed') {
      assert.deepEqual(runtime.submit(intent, ADMIN), result);
      assert.equal(value(runtime), 1);
    } else {
      assert.equal(result.code, 'INVALID_SCHEMA', 'a previously unused ID must not be mistaken for a duplicate');
      assert.equal(value(runtime), 0);
    }
  }
  const { runtime } = setup();
  const poison = command(runtime, 'prototype-key');
  poison.arguments = JSON.parse('{"amount":1,"__proto__":{"polluted":true}}');
  rejected(() => runtime.submit(poison, ADMIN), 'INVALID_SCHEMA');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(value(runtime), 0);
});

test('seeded adversarial traces agree with an independent counter/revision/epoch model', () => {
  // 32 deterministic seeds × 80 operations; this is local milestone evidence,
  // not the separate million-operation S2 exit corpus proposed by QA.
  for (let seed = 1; seed <= 32; seed++) {
    const { runtime, registry } = setup();
    let randomState = seed, expectedValue = 0, expectedRevision = 0, expectedEpoch = 0, controlRevision = 0;
    const history = [];
    const rand = (n) => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % n; };
    for (let index = 0; index < 80; index++) {
      const choice = rand(6);
      const label = `seed ${seed}, operation ${index}`;
      if (choice === 4 && history.length) {
        const prior = history[rand(history.length)];
        const cursor = state(runtime).eventCursor;
        assert.deepEqual(resultOf(() => runtime.submit(clone(prior.intent), ADMIN)), prior.result, label);
        assert.equal(state(runtime).eventCursor, cursor, label);
      } else if (choice === 5) {
        const interrupt = {
          protocolVersion: VERSION, operationId: `s${seed}-stop-${index}`, runtimeId: 'toy-runtime', action: 'interrupt',
          runtimeFence: 'fence-1', expectedControlRevision: controlRevision, scopeId: 'coach', scopeEpoch: expectedEpoch,
        };
        const saved = runtime.control(interrupt, ADMIN);
        expectedEpoch++; controlRevision++;
        assert.deepEqual(runtime.control(interrupt, ADMIN), saved, label);
      } else {
        const amount = rand(21) - 10;
        const revision = choice === 2 ? expectedRevision + 1 : choice === 3 && expectedRevision > 0 ? expectedRevision - 1 : expectedRevision;
        const intent = {
          protocolVersion: VERSION, commandId: `s${seed}-command-${index}`, runtimeId: 'toy-runtime',
          target: { sceneId: 'main' }, operation: 'counter.add', arguments: { amount },
          guards: { runtimeFence: 'fence-1', expectedSceneRevision: revision, scopeId: 'coach', scopeEpoch: expectedEpoch },
        };
        const result = resultOf(() => runtime.submit(intent, ADMIN));
        if (revision !== expectedRevision) assert.equal(result.code, 'STATE_CONFLICT', label);
        else if (expectedValue + amount < 0 || expectedValue + amount > 100) assert.equal(result.code, 'RULE_VIOLATION', label);
        else {
          assert.equal(result.status, 'committed', label);
          expectedValue += amount; expectedRevision++;
        }
        history.push({ intent: clone(intent), result: clone(result) });
      }
      const actual = state(runtime);
      assert.equal(actual.scenes.main.state.value, expectedValue, label);
      assert.equal(actual.scenes.main.sceneRevision, expectedRevision, label);
      assert.equal(actual.scopes.coach.epoch, expectedEpoch, label);
      assert.equal(actual.controlRevision, controlRevision, label);
      if (index % 20 === 0) assert.deepEqual(replay(runtime.exportReplay(ADMIN), registry), actual, label);
    }
  }
});
