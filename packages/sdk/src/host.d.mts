export type HostJSONValue = null | boolean | number | string | HostJSONValue[] | HostJSONObject;
export interface HostJSONObject { [key: string]: HostJSONValue }

export interface HostView {
  viewId: string;
  viewEpoch: number;
  interactionRevision: number;
}

/** Declarative tool metadata. Registered runtime validators remain authoritative. */
export interface HostAction {
  name: string;
  description: string;
  parameters: HostJSONObject & {type: 'object'};
}

/** Supplied only by trusted application code, freshly for each host call. */
export interface HostContext {
  runtimeId: string;
  admin?: boolean;
  audience?: string;
  scenes?: readonly string[];
  scopes?: readonly string[];
  operations?: readonly string[];
  controls?: readonly string[];
  observe?: boolean;
  inspect?: boolean;
  receipts?: boolean;
}

export interface HostObservation {
  protocolVersion: '0.1.0';
  observationId: string;
  runtimeId: string;
  sceneId: string;
  sceneKind: 'canonical' | 'demonstration' | 'practice';
  sceneRevision: number;
  runtimeFence: string;
  controlRevision: number;
  scope: {id: string; epoch: number; status: 'active' | 'closed'};
  eventCursor: number;
  projection: HostJSONObject;
  capabilities: string[];
  partial: true;
  view?: HostView;
}

export interface HostCommand {
  protocolVersion: '0.1.0';
  commandId: string;
  runtimeId: string;
  target: {sceneId: string; objectId?: string};
  operation: string;
  arguments: HostJSONObject;
  guards: {
    runtimeFence: string;
    expectedSceneRevision: number;
    scopeId: string;
    scopeEpoch: number;
    view?: HostView;
  };
}

export interface HostOutcome {
  protocolVersion: '0.1.0';
  operationId: string;
  status: 'committed' | 'rejected' | 'completed' | 'canceled' | 'failed' | 'degraded' | 'admitted' | 'waiting';
  eventCursor: number;
  code?: string;
  sceneId?: string;
  previousRevision?: number;
  sceneRevision?: number;
  result?: HostJSONObject;
}

/** Scope must be dedicated to this host; scope cancellation is runtime-wide. */
export interface HostControl {
  protocolVersion: '0.1.0';
  operationId: string;
  runtimeId: string;
  action: 'interrupt' | 'closeScope';
  runtimeFence: string;
  expectedControlRevision: number;
  sceneId: string;
  scopeId: string;
  scopeEpoch: number;
  /**
   * Required when a viewId is configured; only viewId is a host boundary check.
   * Native scoped controls use runtimeFence/controlRevision/scopeEpoch freshness,
   * not viewEpoch or interactionRevision. Exact committed retries remain valid.
   */
  view?: HostView;
}

export interface HostReceipt {
  protocolVersion: '0.1.0';
  receiptId: string;
  runtimeId: string;
  effectId: string;
  sceneId: string;
  sceneRevision: number;
  runtimeFence: string;
  scopeId: string;
  scopeEpoch: number;
  view?: HostView;
  layer: 'render.applied' | 'presentation.reconciled' | 'playback.started' | 'playback.ended';
  status: 'completed' | 'canceled' | 'failed' | 'unknown';
  presentationMode?: 'normal' | 'skipped' | 'reduced_motion' | 'static_fallback';
  playedThroughMs?: number;
}

/** Structural interface implemented by the existing synchronous core Runtime. */
export interface HostRuntime {
  observe(sceneId: string, scopeId: string, context: HostContext, viewId?: string): HostObservation;
  submit(command: HostCommand, context: HostContext): HostOutcome;
  getOutcome(id: string, context: HostContext): HostOutcome;
  control(envelope: HostControl, context: HostContext): HostOutcome;
  receiveReceipt(receipt: HostReceipt, context: HostContext): HostOutcome;
}

export interface InteractionHostOptions {
  runtime: HostRuntime;
  getContext(): HostContext;
  sceneId: string;
  scopeId: string;
  viewId?: string;
  /** Up to 64 descriptors within the 64 KiB total JSON input limit. */
  actions: readonly HostAction[];
}

export interface InteractionHost {
  observe(): HostObservation;
  catalog(): HostAction[];
  submit(command: HostCommand): HostOutcome;
  /** IDs admitted through this instance only; resubmit exactly after recreation. */
  getOutcome(id: string): HostOutcome;
  control(envelope: HostControl): HostOutcome;
  receiveReceipt(receipt: HostReceipt): HostOutcome;
}

/** Node host only. Every returned observation uses the public projection. */
export function createInteractionHost(options: InteractionHostOptions): Readonly<InteractionHost>;
