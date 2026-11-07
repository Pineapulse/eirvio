import {fail} from './schema.mjs';
export class Registry {
  #rules=new Map(); #effects=new Map();
  register(rule) {
    if(!rule.ruleset || !rule.rulesVersion || !rule.stateSchemaVersion || typeof rule.validateState!=='function' || typeof rule.project!=='function' || !rule.operations || this.#rules.has(rule.ruleset)) fail('INVALID_REGISTRATION');
    for(const op of Object.values(rule.operations)) if(typeof op.validate!=='function' || typeof op.apply!=='function') fail('INVALID_REGISTRATION');
    const operations=Object.fromEntries(Object.entries(rule.operations).map(([name,op])=>[name,Object.freeze({...op})]));
    this.#rules.set(rule.ruleset,Object.freeze({...rule,operations:Object.freeze(operations)})); return this;
  }
  get(name) { const rule=this.#rules.get(name); if(!rule) fail('UNKNOWN_RULESET'); return rule; }
  registerEffect(kind,validator) { if(kind.startsWith('runtime.') || typeof validator!=='function' || this.#effects.has(kind)) fail('INVALID_REGISTRATION'); this.#effects.set(kind,validator); return this; }
  checkEffect(kind,parameters) { const v=this.#effects.get(kind); if(!v) fail('UNKNOWN_EFFECT'); if(v(parameters)!==true) fail('INVALID_SCHEMA'); }
}
