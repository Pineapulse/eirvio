/** JSON data accepted by the core. Runtime validation also checks finite numbers,
 * size/depth limits, plain objects, reserved keys and identifier constraints. */
export type JSONValue = null | boolean | number | string | JSONValue[] | JSONObject;
export interface JSONObject { [key: string]: JSONValue }
export type ProtocolVersion = '0.1.0';
export type SceneKind = 'canonical' | 'demonstration' | 'practice';
export type ScopeStatus = 'active' | 'closed';
export type ControlAction = 'interrupt' | 'closeScope' | 'end' | 'bindView' | 'forkScene' | 'tick' | 'recover';
export type ReceiptLayer = 'render.applied' | 'presentation.reconciled' | 'playback.started' | 'playback.ended';
export type ReceiptStatus = 'completed' | 'canceled' | 'failed' | 'unknown';

export interface View {
  viewId: string;
  viewEpoch: number;
  interactionRevision: number;
}
export interface ViewBinding extends View { sceneId: string }
export interface Scope { epoch: number; status: ScopeStatus }
export interface ObservedScope extends Scope { id: string }
export interface Guards {
  runtimeFence: string;
  expectedSceneRevision: number;
  scopeId: string;
  scopeEpoch: number;
  view?: View;
}
export interface Scene {
  sceneId: string;
  kind: SceneKind;
  ruleset: string;
  rulesVersion: string;
  stateSchemaVersion: string;
  sceneRevision: number;
  state: JSONObject;
  lineage?: { sourceSceneId: string; sourceRevision: number };
}
export interface CommandTarget { sceneId: string; objectId?: string }
export interface Command {
  protocolVersion: ProtocolVersion;
  commandId: string;
  runtimeId: string;
  target: CommandTarget;
  operation: string;
  arguments: JSONObject;
  guards: Guards;
}
export type OutcomeStatus = 'committed' | 'rejected' | 'completed' | 'canceled' | 'failed' | 'degraded' | 'admitted' | 'waiting';
export interface Outcome {
  protocolVersion: ProtocolVersion;
  operationId: string;
  status: OutcomeStatus;
  eventCursor: number;
  code?: string;
  sceneId?: string;
  previousRevision?: number;
  sceneRevision?: number;
  result?: JSONObject;
}
/** Wire schema; Runtime.observe always sets partial to true. */
export interface Observation {
  protocolVersion: ProtocolVersion;
  observationId: string;
  runtimeId: string;
  sceneId: string;
  sceneKind: SceneKind;
  sceneRevision: number;
  runtimeFence: string;
  controlRevision: number;
  scope: ObservedScope;
  view?: View;
  eventCursor: number;
  projection: JSONObject;
  capabilities: string[];
  partial: boolean;
}
export interface RuntimeObservation extends Observation { partial: true }

/** Native submission additionally requires exactly one revision source, and an
 * earlier successful invoke for revisionFromStep. validate checks shape only. */
export interface InvokeStep {
  id: string;
  kind: 'invoke';
  operation: string;
  arguments: JSONObject;
  objectId?: string;
  expectedRevision?: number;
  revisionFromStep?: string;
}
export interface EffectStep {
  id: string;
  kind: 'effect';
  effectKind: string;
  parameters: JSONObject;
  expectedRevision?: number;
  revisionFromStep?: string;
}
export interface WaitStep {
  id: string;
  kind: 'wait';
  effectStepId: string;
  layer: ReceiptLayer;
  timeoutTicks: number;
  timeoutPolicy: 'fail' | 'degrade';
}
export interface FinishStep { id: string; kind: 'finish' }
export type SequenceStep = InvokeStep | EffectStep | WaitStep | FinishStep;
export interface Sequence {
  protocolVersion: ProtocolVersion;
  sequenceId: string;
  runtimeId: string;
  sceneId: string;
  guards: Guards;
  steps: SequenceStep[];
}
export type SequenceStatus = 'admitted' | 'running' | 'waiting' | 'completed' | 'canceled' | 'failed' | 'degraded';
export type SequenceStepResult = Outcome | { effectId: string } | { receiptId: string; status: ReceiptStatus };
export interface SequenceState {
  sequenceId: string;
  plan: Sequence;
  status: SequenceStatus;
  index: number;
  results: Record<string, SequenceStepResult>;
  wait: { effectId: string; layer: ReceiptLayer; deadline: number } | null;
  code?: string;
}
export interface Effect {
  protocolVersion: ProtocolVersion;
  effectId: string;
  runtimeId: string;
  sequenceId?: string;
  stepId?: string;
  sceneId: string;
  sceneRevision: number;
  runtimeFence: string;
  scopeId: string;
  scopeEpoch: number;
  view?: View;
  kind: string;
  parameters: JSONObject;
  status: 'pending' | 'dispatched' | 'canceled';
  system: boolean;
}
export interface DispatchedEffect extends Effect { status: 'dispatched' }
export interface Receipt {
  protocolVersion: ProtocolVersion;
  receiptId: string;
  runtimeId: string;
  effectId: string;
  sceneId: string;
  sceneRevision: number;
  runtimeFence: string;
  scopeId: string;
  scopeEpoch: number;
  view?: View;
  layer: ReceiptLayer;
  status: ReceiptStatus;
  presentationMode?: 'normal' | 'skipped' | 'reduced_motion' | 'static_fallback';
  playedThroughMs?: number;
}
/** Native control wire shape. Runtime checks action-specific requirements:
 * interrupt/closeScope need scopeId + scopeEpoch; bindView needs sceneId + view;
 * forkScene needs sceneId + sourceSceneId + sourceRevision + sceneKind;
 * tick needs ticks; recover needs a never-used newRuntimeFence. */
export interface Control {
  protocolVersion: ProtocolVersion;
  operationId: string;
  runtimeId: string;
  action: ControlAction;
  runtimeFence: string;
  expectedControlRevision: number;
  scopeId?: string;
  scopeEpoch?: number;
  view?: View;
  sceneId?: string;
  sourceSceneId?: string;
  sourceRevision?: number;
  sceneKind?: 'demonstration' | 'practice';
  ticks?: number;
  newRuntimeFence?: string;
}

/** Trusted host argument, never a client/model authorization envelope. */
export interface RuntimeContext {
  runtimeId: string;
  admin?: boolean;
  audience?: string;
  scenes?: readonly string[];
  scopes?: readonly string[];
  operations?: readonly string[];
  controls?: readonly string[];
  effects?: readonly string[];
  observe?: boolean;
  inspect?: boolean;
  receipts?: boolean;
  dispatch?: boolean;
}
export interface RuntimeSpec {
  runtimeId: string;
  runtimeFence: string;
  /** Initial scene revisions must be zero. */
  scenes: Scene[];
  scopes: string[];
  views?: ViewBinding[];
}
export interface RuleOperation {
  /** Only the boolean true admits arguments. */
  validate(arguments_: JSONObject): boolean;
  /** Synchronous, trusted reducer. Domain errors reject without committing state. */
  apply(state: JSONObject, arguments_: JSONObject, target: CommandTarget): { state: JSONObject; result: JSONObject };
}
export interface Ruleset {
  ruleset: string;
  rulesVersion: string;
  stateSchemaVersion: string;
  validateState(state: JSONObject): boolean;
  operations: Readonly<Record<string, RuleOperation>>;
  project(state: JSONObject, audience: string): JSONObject;
}
export type RegisteredRuleset = Readonly<Omit<Ruleset, 'operations'>> & {
  readonly operations: Readonly<Record<string, Readonly<RuleOperation>>>;
};
export class Registry {
  constructor();
  register(rule: Ruleset): this;
  get(name: string): RegisteredRuleset;
  registerEffect(kind: string, validator: (parameters: JSONObject) => boolean): this;
  checkEffect(kind: string, parameters: JSONObject): void;
}

export interface AccessRequirements {
  scenes?: string;
  scopes?: string;
  operations?: string;
  controls?: string;
  effects?: string;
  observe?: boolean;
  inspect?: boolean;
  receipts?: boolean;
  dispatch?: boolean;
}
export interface StoredOutcome {
  fingerprint: string;
  outcome: Outcome;
  access: AccessRequirements;
}
/** Host-private full state. This is not a public observation or telemetry event. */
export interface RuntimeSnapshot {
  protocolVersion: ProtocolVersion;
  snapshotSchemaVersion: '1';
  runtimeId: string;
  runtimeFence: string;
  usedFences: string[];
  eventCursor: number;
  controlRevision: number;
  logicalTick: number;
  closed: boolean;
  scenes: Record<string, Scene>;
  scopes: Record<string, Scope>;
  views: Record<string, ViewBinding>;
  outcomes: Record<string, StoredOutcome>;
  sequences: Record<string, SequenceState>;
  effects: Record<string, Effect>;
  receipts: Record<string, Partial<Record<ReceiptLayer, Receipt>>>;
}
export interface StoreEvent { type: string; data: JSONObject }
export interface ReplayRecord extends StoreEvent {
  eventCursor: number;
  previousHash: string;
  hash: string;
  state: RuntimeSnapshot;
}
/** Schema validation alone does not validate embedded snapshot internals. */
export interface ReplayEnvelope {
  protocolVersion: ProtocolVersion;
  engineVersion: '0.1.0';
  snapshotSchemaVersion: '1';
  effectPolicy: 'never_dispatch';
  redaction: 'host_private_synthetic_only';
  genesis: JSONObject;
  genesisHash: string;
  finalCursor: number;
  finalHash: string;
  records: Array<StoreEvent & { eventCursor: number; previousHash: string; hash: string; state: JSONObject }>;
}
export interface ReplayBundle {
  protocolVersion: ProtocolVersion;
  engineVersion: '0.1.0';
  snapshotSchemaVersion: '1';
  effectPolicy: 'never_dispatch';
  redaction: 'host_private_synthetic_only';
  genesis: RuntimeSnapshot;
  genesisHash: string;
  finalCursor: number;
  finalHash: string;
  records: ReplayRecord[];
}
/** Synchronous atomic storage port. Implementations own durability and fencing. */
export interface RuntimeStore {
  readonly recoveryRequired?: boolean;
  initialize(state: RuntimeSnapshot): void;
  read(): RuntimeSnapshot;
  commit(expectedCursor: number, expectedWriterFence: string, nextState: RuntimeSnapshot, event: StoreEvent): void;
  exportReplay(): ReplayBundle;
}
/** Atomic in memory only; process-crash durability is not provided. */
export class MemoryStore implements RuntimeStore {
  constructor();
  failNext: 'before' | 'after' | null;
  readonly recoveryRequired: boolean;
  initialize(state: RuntimeSnapshot): void;
  read(): RuntimeSnapshot;
  commit(expectedCursor: number, expectedWriterFence: string, nextState: RuntimeSnapshot, event: StoreEvent): void;
  exportReplay(): ReplayBundle;
  /** Restored stores require recover before admitting new work. */
  static fromReplay(bundle: ReplayBundle | ReplayEnvelope, registry: Registry): MemoryStore;
}
export class Runtime {
  /** Attaches to an initialized store; does not perform recovery. */
  constructor(registry: Registry, store: RuntimeStore);
  static create(spec: RuntimeSpec, registry: Registry, store: RuntimeStore): Runtime;
  observe(sceneId: string, scopeId: string, context: RuntimeContext, viewId?: string): RuntimeObservation;
  submit(command: Command, context: RuntimeContext): Outcome;
  submitSequence(sequence: Sequence, context: RuntimeContext): Outcome;
  advance(sequenceId: string, context: RuntimeContext): SequenceState;
  control(envelope: Control, context: RuntimeContext): Outcome;
  claimEffect(effectId: string, context: RuntimeContext): DispatchedEffect | null;
  receiveReceipt(receipt: Receipt, context: RuntimeContext): Outcome;
  getOutcome(operationId: string, context: RuntimeContext): Outcome;
  getSequence(sequenceId: string, context: RuntimeContext): SequenceState;
  snapshot(context: RuntimeContext): RuntimeSnapshot;
  exportReplay(context: RuntimeContext): ReplayBundle;
}
export class DomainError extends Error {
  constructor(code: string, message?: string);
  code: string;
}

/** Named shapes implemented by the owned contracts/schemas.json packet. */
export interface SchemaTypes {
  id: string;
  view: View;
  guards: Guards;
  scene: Scene;
  command: Command;
  outcome: Outcome;
  observation: Observation;
  invokeStep: InvokeStep;
  effectStep: EffectStep;
  waitStep: WaitStep;
  finishStep: FinishStep;
  step: SequenceStep;
  sequence: Sequence;
  effect: Effect;
  receipt: Receipt;
  control: Control;
  replay: ReplayEnvelope;
}
/** Validates the named wire schema and returns a detached JSON copy. It does not
 * authorize a request or enforce domain/revision/sequence execution invariants. */
export function validate<Name extends keyof SchemaTypes>(name: Name, value: unknown): SchemaTypes[Name];
/** Integrity reconstruction only: no reducer execution or effect dispatch. */
export function replay(bundle: ReplayBundle | ReplayEnvelope, registry: Registry): RuntimeSnapshot;
