import type {JsonObject, EventContext} from './events.mjs';
export interface ViewGuard {viewId:string; viewEpoch:number; interactionRevision:number;}
export interface Observation {
  protocolVersion:'0.1.0'; observationId:string; runtimeId:string; runtimeFence:string;
  sceneId:string; sceneKind:'canonical'|'practice'|'demonstration'; sceneRevision:number; controlRevision:number;
  scope:{id:string; epoch:number; status:'active'|'closed'}; view?:ViewGuard; eventCursor:number;
  projection:JsonObject; capabilities:string[]; partial:boolean;
}
export interface Command {
  protocolVersion:'0.1.0'; commandId:string; runtimeId:string; target:{sceneId:string; objectId?:string};
  operation:string; arguments:JsonObject;
  guards:{runtimeFence:string; expectedSceneRevision:number; scopeId:string; scopeEpoch:number; view?:ViewGuard};
}
export interface ScopedControl {
  protocolVersion:'0.1.0'; operationId:string; runtimeId:string; action:'interrupt'|'closeScope';
  runtimeFence:string; expectedControlRevision:number; scopeId:string; scopeEpoch:number; sceneId:string; view?:ViewGuard;
}
export interface Outcome {
  protocolVersion:'0.1.0'; operationId:string; eventCursor:number;
  status:'committed'|'rejected'|'completed'|'canceled'|'failed'|'degraded'|'admitted'|'waiting';
  code?:string; sceneId?:string; previousRevision?:number; sceneRevision?:number; result?:JsonObject;
}
export interface ActionDescription {name:string; description:string; parameters:JsonObject & {type:'object'};}
export interface InteractionTransport {
  observe(): Observation | Promise<Observation>;
  catalog(): ActionDescription[] | Promise<ActionDescription[]>;
  submit(command:Command): Outcome | Promise<Outcome>;
  getOutcome(operationId:string): Outcome | Promise<Outcome>;
  control?(control:ScopedControl): Outcome | Promise<Outcome>;
}
export interface PrepareOptions {observation:Observation; commandId:string;}
export interface PrepareControlOptions {observation:Observation; operationId:string;}
export function prepare(name:string, properties:JsonObject, options:PrepareOptions): Command;
export function prepareControl(action:'interrupt'|'closeScope', options:PrepareControlOptions): ScopedControl;
export interface InteractionClient {
  observe(): Promise<Observation>;
  catalog(): Promise<ActionDescription[]>;
  prepare: typeof prepare;
  submit(command:Command): Promise<Outcome>;
  act(name:string, properties:JsonObject, options:PrepareOptions): Promise<Outcome>;
  getOutcome(operationId:string): Promise<Outcome>;
  prepareControl: typeof prepareControl;
  control(control:ScopedControl): Promise<Outcome>;
}
export class InteractionTransportError extends Error {
  code:'TRANSPORT_UNCERTAIN'|'TRANSPORT_ERROR'; operation:string; uncertain:boolean;
  operationId?:string; request?:Command|ScopedControl; command?:Command; control?:ScopedControl;
  constructor(operation:string, cause:unknown, request?:Command|ScopedControl);
}
export function createInteractionClient(options:{transport:InteractionTransport; events?:{track(name:string, properties:JsonObject, context?:EventContext):unknown}}): InteractionClient;
