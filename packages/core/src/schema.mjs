import schemas from '../contracts/schemas.json' with {type: 'json'};

export class DomainError extends Error {
  constructor(code, message=code) { super(message); this.code=code; }
}
export const fail = code => { throw new DomainError(code); };
export function json(value) {
  const seen=new Set();
  function visit(x,depth) {
    if(depth>64) fail('RESOURCE_LIMIT');
    if(x===null || typeof x==='string' || typeof x==='boolean') return;
    if(typeof x==='number' && Number.isFinite(x) && Math.abs(x)<=Number.MAX_SAFE_INTEGER) return;
    if(typeof x!=='object' || seen.has(x) || (!Array.isArray(x) && Object.getPrototypeOf(x)!==Object.prototype && Object.getPrototypeOf(x)!==null)) fail('INVALID_SCHEMA');
    seen.add(x);
    for(const [key,v] of Object.entries(x)) { if(['__proto__','constructor','prototype'].includes(key)) fail('INVALID_SCHEMA'); visit(v,depth+1); }
    seen.delete(x);
  }
  visit(value,0);
  return JSON.parse(JSON.stringify(value));
}
export function canonical(value) {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function matches(value,schema) {
  if(schema.$ref) return matches(value,schemas.$defs[schema.$ref.split('/').at(-1)]);
  if(schema.oneOf) return schema.oneOf.filter(s=>matches(value,s)).length===1;
  if('const' in schema && value!==schema.const) return false;
  if(schema.enum && !schema.enum.includes(value)) return false;
  switch(schema.type) {
    case 'object':
      if(!value || Array.isArray(value) || typeof value!=='object') return false;
      if((schema.required||[]).some(k=>!Object.hasOwn(value,k))) return false;
      if(schema.additionalProperties===false && Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k))) return false;
      return Object.entries(schema.properties||{}).every(([k,s])=>!Object.hasOwn(value,k)||matches(value[k],s));
    case 'array': return Array.isArray(value) && value.length>=(schema.minItems||0) && value.length<=(schema.maxItems??Infinity) && value.every(v=>matches(v,schema.items));
    case 'string': return typeof value==='string' && value.length>=(schema.minLength||0) && value.length<=(schema.maxLength??Infinity) && (!schema.pattern || new RegExp(schema.pattern).test(value));
    case 'integer': return Number.isSafeInteger(value) && value>=(schema.minimum??-Infinity) && value<=(schema.maximum??Infinity);
    case 'boolean': return typeof value==='boolean';
    default: return true;
  }
}
export function validate(name,value) {
  const copy=json(value);
  if(copy?.protocolVersion!==undefined && copy.protocolVersion!=='0.1.0') fail('UNSUPPORTED_VERSION');
  if(!schemas.$defs[name] || !matches(copy,schemas.$defs[name])) fail('INVALID_SCHEMA');
  if(name!=='replay' && Buffer.byteLength(JSON.stringify(copy))>65536) fail('RESOURCE_LIMIT');
  return copy;
}
