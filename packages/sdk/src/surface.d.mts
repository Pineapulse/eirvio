import type {Json, JsonObject} from './events.mjs';
export interface SurfaceTarget {
  ref:string; role:string; name:string; actions:string[];
  state?:JsonObject; sample?:JsonObject; actionSchemas?:JsonObject;
  [key:string]:Json | undefined;
}
export interface SurfaceEvent {
  adapterId:string; cursor:number; timestamp:number; type:string; actor:'user'|'agent'|'system';
  target?:string; action?:string; [key:string]:Json | undefined;
}
export interface SurfaceHistory {
  adapterId:string; events:SurfaceEvent[]; nextCursor:number; cursor:number;
  oldestCursor:number; gap:boolean; hasMore:boolean;
}
export interface SurfaceSnapshot {
  adapterId:string; kind:'website'|'game'|'app'; revision:number; sampledAt:number;
  targets:SurfaceTarget[]; activity:SurfaceHistory;
  [key:string]:unknown;
}
export interface SurfaceAction {
  adapterId:string; id:string; revision:number; target:string; action:string; arguments?:JsonObject;
}
export interface SurfaceReceipt {
  adapterId:string; id:string; status:'rejected'|'pending'|'dispatched'|'completed'|'uncertain';
  code?:string; revisionBefore:number; revisionAfter?:number;
}
export interface SurfaceTool {name:string; description:string; parameters:JsonObject;}
export interface SurfaceAdapter {
  observe():SurfaceSnapshot;
  act(request:SurfaceAction):SurfaceReceipt;
  getOutcome(id:string):SurfaceReceipt | null;
  history(options?:{after?:number;limit?:number}):SurfaceHistory;
  subscribe(listener:(event:SurfaceEvent)=>unknown):()=>void;
  readonly tools:SurfaceTool[];
  callTool(name:'surface_observe',args?:Record<string,never>):SurfaceSnapshot;
  callTool(name:'surface_act',args:SurfaceAction):SurfaceReceipt;
  callTool(name:'surface_get_outcome',args:{id:string}):SurfaceReceipt|null;
  callTool(name:string,args?:JsonObject):SurfaceSnapshot|SurfaceReceipt|null;
  dispose():void;
}
export interface SurfaceKernel extends SurfaceAdapter {
  record(event:{type:string;actor:'user'|'agent'|'system';[key:string]:Json}):SurfaceEvent|undefined;
  isActing():boolean; onDispose(cleanup:()=>void):void;
}
export function createSurfaceAdapter(options:{kind:'website'|'game'|'app';adapterId?:string;maxReceipts?:number;maxEvents?:number;
  sample:()=>{targets:SurfaceTarget[];[key:string]:unknown};
  validate?:(request:SurfaceAction,snapshot:SurfaceSnapshot)=>void;
  execute:(request:SurfaceAction,snapshot:SurfaceSnapshot)=>{status:'dispatched'|'completed'};
}):SurfaceKernel;
export const SURFACE_TOOLS:readonly SurfaceTool[];
