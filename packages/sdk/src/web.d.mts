import type {SurfaceAdapter} from './surface.mjs';

export interface InstallWebOptions {
  /** Connected DOM element; defaults to document.body. Shadow trees are not scanned. */
  root?:Element;
  /** Default 200; range 1–1,000. Additional byte and traversal bounds may truncate. */
  maxTargets?:number;
  /** Unique adapter lifetime ID. Defaults to crypto.randomUUID() in the kernel. */
  adapterId?:string;
  maxReceipts?:number;
  maxEvents?:number;
}
/**
 * Observe semantic DOM targets and dispatch advertised native actions locally.
 * Actions require the exact adapterId/revision/ref from a fresh observation.
 * click/focus take {}; fill/select take {value}; check takes {checked}; scroll
 * takes at least one of {top,left}. Per-target actionSchemas declare the bounds.
 * All action receipts are dispatched, not proof that the application accepted
 * the interaction. Framework-native setters emit bubbling input/change events.
 *
 * Hidden/inert/password/file and password/payment-autocomplete controls are
 * excluded, as are subtrees marked data-eirvio-private, data-private,
 * data-redacted or data-eirvio-redacted. Public form values are observed;
 * application authors must mark other sensitive content private explicitly.
 * Events contain metadata, never typed values. Non-adapter DOM events use actor
 * user; asynchronous scroll uses system/unattributed-scroll because its origin
 * cannot reliably be linked to a dispatch. The trusted flag describes isTrusted
 * and is not proof of a human source or of causal attribution for later app work.
 * Canvas, iframe, shadow-tree, custom-widget state and layout-occlusion coverage
 * are explicitly unsupported. dispose removes installed event listeners.
 */
export function installWeb(options?:InstallWebOptions):SurfaceAdapter;
