import type {SurfaceAdapter} from './surface.mjs';

/** Structural engine boundary: no Babylon dependency is required by EIRVIO.
 * Supply a live Babylon Scene (tested with @babylonjs/core 8.26).
 */
export interface BabylonSceneLike {
  readonly meshes:readonly object[];
  readonly isDisposed:boolean;
  readonly onDisposeObservable:{add(callback:(...args:any[])=>void):unknown;remove(observer:any):unknown};
  readonly onPointerObservable:{add(callback:(...args:any[])=>void):unknown;remove(observer:any):unknown};
}
export interface BabylonOptions {
  scene:BabylonSceneLike;
  /** Unique per installation lifetime; omit to generate a new UUID. */
  adapterId?:string;
  /** 1–500; default 200. The active camera counts toward this limit. */
  maxTargets?:number;
  maxReceipts?:number;
  maxEvents?:number;
  /** Only these own JSON-valued mesh.metadata namespaces are exposed.
   * At most 8 names, 1KiB per value and 16KiB aggregate; unsupported values are omitted.
   */
  metadataNamespaces?:readonly string[];
}
/** Focus and highlight affect presentation only. Mesh refs identify objects, not names.
 * Animated transforms are samples and do not invalidate revisions. Thin instances are
 * aggregate targets; individual instances and gameplay actions need application wiring.
 * Native pointer events are user activity unless isTrusted is explicitly false (system),
 * or an adapter action is running (agent). Attribution is observational, not authentication.
 * Disposal restores only highlights whose value still matches the adapter's last write.
 * Another adapter's active highlight ownership rejects with HIGHLIGHT_OWNED.
 */
export function installBabylon(options:BabylonOptions):SurfaceAdapter;
