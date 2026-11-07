export type Json = null | boolean | number | string | Json[] | {[key:string]: Json};
export type JsonObject = {[key:string]: Json};
export type PropertySchema = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'object' | 'array';
  description?: string; enum?: Array<string | number | boolean | null>;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  properties?: Record<string, PropertySchema>; required?: string[]; additionalProperties?: false;
  items?: PropertySchema; minItems?: number; maxItems?: number;
};
export type EventDefinition = Omit<PropertySchema, 'type'> & {type?: 'object'; properties: Record<string, PropertySchema>};
export type EventCatalog = Record<string, EventDefinition>;
export interface EventContext {actor?: 'user' | 'agent' | 'system'; traceId?: string; correlationId?: string;}
export interface InterfaceEvent {cursor:number; name:string; properties:JsonObject; context:EventContext & {actor:'user'|'agent'|'system'}; timestamp:number;}
export interface EventHistory {events:InterfaceEvent[]; cursor:number; oldestCursor:number; gap:boolean; hasMore:boolean;}
export interface EventStream {
  track(name:string, properties?:JsonObject, context?:EventContext): InterfaceEvent;
  subscribe(listener:(event:InterfaceEvent) => unknown): () => void;
  /** Resume after the last consumed event.cursor, not history.cursor when hasMore is true. */
  history(options?:{after?:number; limit?:number}): EventHistory;
}
export interface EventStreamOptions {
  catalog?: EventCatalog; maxEvents?: number; maxPropertyBytes?: number; maxDepth?: number; maxListeners?:number;
  clock?: () => number;
  onListenerError?: (error:unknown, event:{cursor:number; name:string}) => unknown;
}
export class InteractionValidationError extends Error {code:string; constructor(code:string, message?:string);}
export function createEventStream(options?:EventStreamOptions): EventStream;
export const SDK_EVENT_CATALOG: Readonly<EventCatalog>;
/** Internal browser-safe intake; package root need not export this helper. */
export function copyPlainJson<T extends Json>(value:T, limits?:{maxDepth?:number; maxBytes?:number; maxNodes?:number}): T;
