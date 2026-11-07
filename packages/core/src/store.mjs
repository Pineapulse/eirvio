import {createHash} from 'node:crypto';
import {canonical,json,fail,validate} from './schema.mjs';

export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function verifyState(state,registry) {
  if(state.protocolVersion!=='0.1.0' || state.snapshotSchemaVersion!=='1') fail('UNSUPPORTED_VERSION');
  if(!Number.isSafeInteger(state.eventCursor)||state.eventCursor<0) fail('INTEGRITY_ERROR');
  for(const scene of Object.values(state.scenes)) {
    validate('scene',scene);
    const rule=registry.get(scene.ruleset);
    if(rule.rulesVersion!==scene.rulesVersion || rule.stateSchemaVersion!==scene.stateSchemaVersion) fail('UNSUPPORTED_VERSION');
    if(rule.validateState(json(scene.state))!==true) fail('INTEGRITY_ERROR');
  }
}
export function replay(bundle,registry) {
  if(bundle && (bundle.protocolVersion!=='0.1.0'||bundle.engineVersion!=='0.1.0'||bundle.snapshotSchemaVersion!=='1'))fail('UNSUPPORTED_VERSION');
  const b=validate('replay',bundle);
  let state=json(b.genesis), previousHash=digest(state);
  if(previousHash!==b.genesisHash) fail('INTEGRITY_ERROR');
  verifyState(state,registry);
  for(const record of b.records) {
    const {hash,...body}=record;
    if(record.eventCursor!==state.eventCursor+1 || record.previousHash!==previousHash || digest(body)!==hash || record.state.eventCursor!==record.eventCursor || record.state.runtimeId!==state.runtimeId) fail('INTEGRITY_ERROR');
    verifyState(record.state,registry);
    state=json(record.state); previousHash=hash;
  }
  if(state.eventCursor!==b.finalCursor||previousHash!==b.finalHash)fail('INTEGRITY_ERROR');
  return state;
}

// In-memory atomic storage port. No disk or process-crash durability is claimed.
export class MemoryStore {
  #state; #genesis; #records=[]; #head; #recoveryRequired=false;
  failNext=null;
  get recoveryRequired() {return this.#recoveryRequired;}
  initialize(state) {
    if(this.#state) fail('ALREADY_INITIALIZED');
    this.#state=json(state); this.#genesis=json(state); this.#head=digest(state);
  }
  read() { if(!this.#state) fail('NOT_INITIALIZED'); return json(this.#state); }
  commit(expectedCursor,expectedWriterFence,nextState,event) {
    if(this.#state.eventCursor!==expectedCursor) fail('STORAGE_CONFLICT');
    if(this.#state.runtimeFence!==expectedWriterFence) fail('STALE_WRITER');
    if(this.failNext==='before') { this.failNext=null; fail('STORAGE_UNAVAILABLE'); }
    const state=json(nextState);
    if(state.eventCursor!==expectedCursor+1) fail('INTEGRITY_ERROR');
    const body={eventCursor:state.eventCursor,previousHash:this.#head,type:event.type,data:json(event.data),state};
    const record={...body,hash:digest(body)};
    // All potentially throwing construction precedes the atomic pointer update.
    if(state.runtimeFence!==this.#state.runtimeFence)this.#recoveryRequired=false;
    this.#state=state; this.#records.push(record); this.#head=record.hash;
    if(this.failNext==='after') { this.failNext=null; fail('ACKNOWLEDGEMENT_LOST'); }
  }
  exportReplay() {
    return json({protocolVersion:'0.1.0',engineVersion:'0.1.0',snapshotSchemaVersion:'1',effectPolicy:'never_dispatch',redaction:'host_private_synthetic_only',genesis:this.#genesis,genesisHash:digest(this.#genesis),finalCursor:this.#state.eventCursor,finalHash:this.#head,records:this.#records});
  }
  static fromReplay(bundle,registry) {
    const state=replay(bundle,registry), store=new MemoryStore();
    store.#state=state; store.#genesis=json(bundle.genesis); store.#records=json(bundle.records);
    store.#head=bundle.records.at(-1)?.hash??bundle.genesisHash;
    store.#recoveryRequired=true;
    return store;
  }
}
