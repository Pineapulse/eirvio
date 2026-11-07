import type {EventDefinition, EventStream, InterfaceEvent, JsonObject} from './events.mjs';

export interface AwarenessSurface {id:string; kind:'website'|'game'|'app'; name?:string;}
/** Scoped to one awareness lifetime; do not reuse explicit awareness IDs. */
export interface AwarenessCursor {awarenessId:string; cursor:number;}
export type AwarenessActivity = InterfaceEvent & {context:InterfaceEvent['context'] & {actor:'user'}};
export interface AwarenessSnapshot {
  awarenessId:string; surface:AwarenessSurface;
  /** Current app-declared context, not the context when earlier activity happened. */
  contextRevision:number; context:JsonObject;
  activities:AwarenessActivity[];
  /** Last source event scanned, including filtered system/agent events. */
  nextCursor:AwarenessCursor;
  sourceHead:number; oldestCursor:number; gap:boolean; hasMore:boolean;
}
export type AwarenessNotification =
  | {type:'activity'; awarenessId:string; event:AwarenessActivity}
  | {type:'context_changed'; awarenessId:string; contextRevision:number; context:JsonObject};
export type AwarenessListenerErrorDetails =
  | {type:'activity'; awarenessId:string; cursor:number}
  | {type:'context_changed'; awarenessId:string; contextRevision:number};
export interface InterfaceAwarenessOptions {
  events:Pick<EventStream, 'history'|'subscribe'>;
  surface:AwarenessSurface;
  /** Same closed property-schema dialect as event declarations; 16 KiB/depth 8. */
  contextSchema:EventDefinition;
  initialContext:JsonObject;
  /** Defaults to crypto.randomUUID(). Supply a unique ID per instance if unavailable. */
  awarenessId?:string;
  /** Default 100, range 1–10,000. */
  maxListeners?:number;
  onListenerError?:(error:unknown, details:AwarenessListenerErrorDetails) => unknown;
}
export interface InterfaceAwareness {
  /**
   * limit counts all source events scanned. A filtered page may be empty while
   * hasMore is true. Omitted limit uses the source stream's own default bound.
   * Continue with nextCursor; a foreign lifetime ID or future cursor is rejected.
   * Live subscriptions and replay overlap: deduplicate by awarenessId/event.cursor.
   */
  snapshot(options?:{after?:AwarenessCursor; limit?:number}):AwarenessSnapshot;
  /** Atomic full replacement; each valid update increments contextRevision. */
  updateContext(replacement:JsonObject):{context:JsonObject; contextRevision:number};
  /**
   * Synchronous delivery with detached data; throws/rejections are isolated.
   * Reads during notifications are allowed; reentrant context writes reject.
   * If a context subscriber explicitly tracks a new source event, recursive live
   * notification is isolated/reported; snapshot still includes that source event.
   */
  subscribe(listener:(notification:AwarenessNotification) => unknown):() => void;
  /** Idempotent. Releases source subscription; later reads/updates/subscribes reject. */
  dispose():void;
}
export function createInterfaceAwareness(options:InterfaceAwarenessOptions):InterfaceAwareness;
