import {createSurfaceAdapter} from './surface.mjs';
import {copyPlainJson, InteractionValidationError} from './events.mjs';

const fail = code => { throw new InteractionValidationError(code); };
const fillTypes = new Set(['text','search','email','tel','url','number','date','datetime-local','month','time','week','color','range']);
const privateAttributes = ['data-eirvio-private','data-private','data-redacted','data-eirvio-redacted'];
const textTags = new Set(['P','H1','H2','H3','H4','H5','H6','LI','DT','DD','LEGEND','CAPTION','OUTPUT','BLOCKQUOTE']);
const encoder = new TextEncoder();
const clean = (value, limit = 160) => String(value ?? '').slice(0,limit * 4).replace(/\s+/g,' ').trim().slice(0, limit);
const keys = (args, allowed, required = allowed) => {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(args,key))) fail('INVALID_ACTION_ARGUMENTS');
};

/** Automatic, local semantic DOM observation. This never reads raw HTML. */
export function installWeb(options = {}) {
  if (!options || typeof options !== 'object' || ![Object.prototype,null].includes(Object.getPrototypeOf(options))) fail('INVALID_WEB_OPTIONS');
  const config = {};
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options,key);
    if (!['root','maxTargets','adapterId','maxReceipts','maxEvents'].includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor,'value')) fail('INVALID_WEB_OPTIONS');
    config[key] = descriptor.value;
  }
  const root = config.root === undefined ? globalThis.document?.body : config.root;
  const document = root?.ownerDocument, window = document?.defaultView;
  if (!window || !(root instanceof window.Element)) fail('INVALID_WEB_ROOT');
  const maxTargets = config.maxTargets === undefined ? 200 : config.maxTargets;
  if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > 1000) fail('INVALID_WEB_OPTIONS');
  const refs = new WeakMap(), valueVersions = new WeakMap(); let nextRef = 0, targets = new Map();
  const refFor = element => { if (!refs.has(element)) refs.set(element,`dom-${++nextRef}`); return refs.get(element); };
  const inRoot = element => element === root || root.contains(element);
  function locallyExcluded(element) {
    if (privateAttributes.some(name => element.hasAttribute(name)) || element.hidden || element.hasAttribute('inert')
        || element.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true;
    if (element.tagName === 'INPUT' && ['password','hidden','file'].includes(element.type)) return true;
    const rawAutocomplete = element.getAttribute('autocomplete') ?? '';
    if (rawAutocomplete.length > 2048) return true;
    const autocomplete = rawAutocomplete.toLowerCase();
    if (autocomplete.split(/\s+/).some(token => /^(?:current-password|new-password|one-time-code|cc-.+)$/.test(token))) return true;
    if (['SCRIPT','STYLE','TEMPLATE','NOSCRIPT','HEAD','CANVAS','IFRAME','OBJECT','EMBED'].includes(element.tagName)) return true;
    const style = window.getComputedStyle(element);
    return style.display === 'none' || style.contentVisibility === 'hidden'
      || ['hidden','collapse'].includes(style.visibility) || style.opacity === '0';
  }
  function excluded(element) {
    if (!inRoot(element) || !element.isConnected) return true;
    for (let current = element; current; current = current.parentElement) {
      if (locallyExcluded(current)) return true;
      const parent = current.parentElement;
      if (parent?.tagName === 'DETAILS' && !parent.open) {
        let summary = parent.firstElementChild, examined = 0;
        while (summary && summary.tagName !== 'SUMMARY' && examined++ < 1000) summary = summary.nextElementSibling;
        if (current !== summary || summary?.tagName !== 'SUMMARY') return true;
      }
    }
    return false;
  }
  // Walk without allocating a list of every descendant. Shadow trees are outside
  // this adapter's coverage; excluded subtrees are pruned before reading text.
  function nextNode(node, boundary, descend = true) {
    if (descend && node.firstChild) return node.firstChild;
    while (node !== boundary) { if (node.nextSibling) return node.nextSibling; node = node.parentNode; }
    return null;
  }
  function textOf(element) {
    if (!element || excluded(element)) return '';
    let node = element, text = '', visited = 0;
    while (node && visited++ < 1000 && text.length < 320) {
      let descend = true;
      if (node.nodeType === 1) {
        if (excluded(node) || ['INPUT','TEXTAREA','SELECT'].includes(node.tagName)
            || node.tagName === 'LABEL' && node.control && excluded(node.control)) descend = false;
      } else if (node.nodeType === 3) text += ` ${node.nodeValue.slice(0,319 - text.length)}`;
      node = nextNode(node,element,descend);
    }
    return clean(text);
  }
  function nameOf(element) {
    const labelled = element.getAttribute('aria-labelledby');
    if (labelled) {
      const name = labelled.slice(0,2048).split(/\s+/).slice(0,10).map(id => textOf(document.getElementById(id))).filter(Boolean).join(' ');
      // A supplied label relationship must not fall back to a private source.
      return clean(name);
    }
    if (element.hasAttribute('aria-label')) return clean(element.getAttribute('aria-label'));
    if (element.labels?.length) {
      const labels = []; for (let index = 0; index < Math.min(element.labels.length,10); index++) labels.push(textOf(element.labels[index]));
      return clean(labels.filter(Boolean).join(' '));
    }
    if (element.tagName === 'INPUT' && ['button','submit','reset'].includes(element.type)) return clean(element.value || element.type);
    if (element.tagName === 'INPUT' && element.type === 'image') return clean(element.getAttribute('alt'));
    if (element.tagName === 'IMG') return clean(element.getAttribute('alt'));
    return textOf(element) || (['INPUT','TEXTAREA'].includes(element.tagName) ? clean(element.getAttribute('placeholder')) : '');
  }
  function roleOf(element) {
    const role = clean(element.getAttribute('role')).split(' ')[0];
    if (role && !['none','presentation'].includes(role)) return role;
    const tag = element.tagName;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'A' && element.hasAttribute('href')) return 'link';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'INPUT') {
      if (['button','submit','reset','image'].includes(element.type)) return 'button';
      if (['checkbox','radio'].includes(element.type)) return element.type;
      if (element.type === 'range') return 'slider';
      if (element.type === 'number') return 'spinbutton';
      return 'textbox';
    }
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'IMG' && element.hasAttribute('alt')) return 'img';
    if (textTags.has(tag)) return 'text';
    if (element.tabIndex >= 0) return 'generic';
    if (['DIV','SPAN'].includes(tag) && !element.children.length && textOf(element)) return 'text';
    return null;
  }
  function disabled(element) {
    if (element.matches(':disabled')) return true;
    for (let current = element; current; current = current.parentElement) if (current.getAttribute('aria-disabled')?.toLowerCase() === 'true') return true;
    return false;
  }
  const readonly = element => element.readOnly === true || element.getAttribute('aria-readonly')?.toLowerCase() === 'true';
  const scrollable = element => element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth;
  function actionsOf(element, role) {
    if (!(element instanceof window.HTMLElement) || disabled(element)) return [];
    const actions = [];
    if (['BUTTON','SUMMARY'].includes(element.tagName) || element.tagName === 'A' && element.hasAttribute('href')
        || element.tagName === 'INPUT' && ['button','submit','reset','image'].includes(element.type)
        || ['button','link','tab','menuitem'].includes(role)) actions.push('click');
    if (!readonly(element)) {
      if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' && fillTypes.has(element.type)) actions.push('fill');
      if (element.tagName === 'SELECT' && !element.multiple) actions.push('select');
      if (element.tagName === 'INPUT' && ['checkbox','radio'].includes(element.type)) actions.push('check');
    }
    if (element.tabIndex >= 0 || ['INPUT','TEXTAREA','SELECT','BUTTON','A','SUMMARY'].includes(element.tagName)) actions.push('focus');
    if (scrollable(element)) actions.push('scroll');
    return actions;
  }
  function stateOf(element) {
    const state = {disabled:disabled(element), focused:document.activeElement === element};
    if (['INPUT','TEXTAREA'].includes(element.tagName)) {
      state.readOnly = readonly(element);
      state.required = element.required;
      if (element.tagName === 'INPUT') state.inputType = element.type;
      if (element.tagName === 'INPUT' && ['checkbox','radio'].includes(element.type)) {
        state.checked = element.checked; state.indeterminate = element.indeterminate;
      } else if (element.tagName === 'TEXTAREA' || fillTypes.has(element.type)) {
        const previous = valueVersions.get(element);
        const version = previous ? previous.version + (previous.value === element.value ? 0 : 1) : 0;
        valueVersions.set(element,{value:element.value,version});
        state.value = element.value.slice(0,1024); state.valueTruncated = element.value.length > 1024;
        // Opaque generation catches changes beyond the displayed prefix without
        // leaking the rest of a long value or relying on a lossy hash.
        state.valueVersion = version;
      }
    }
    if (element.tagName === 'SELECT') {
      const options = [];
      for (let index = 0; index < Math.min(element.options.length,200); index++) {
        const option = element.options[index];
        if (options.length >= 20) break;
        if (excluded(option) || option.value.length > 256) continue;
        options.push({value:option.value,name:textOf(option),selected:option.selected,disabled:disabled(option) || option.parentElement?.disabled === true});
      }
      state.options = options; state.optionsTruncated = options.length < element.options.length;
      state.multiple = element.multiple;
    }
    for (const name of ['expanded','selected','pressed','checked','current']) {
      const value = element.getAttribute(`aria-${name}`); if (value !== null) state[name] = clean(value);
    }
    return state;
  }
  function actionSchemas(element, actions, state) {
    const schema = (properties = {}, required = Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
    return Object.fromEntries(actions.map(action => [action,
      action === 'fill' ? schema({value:{type:'string',maxLength:Math.min(4096,element.maxLength >= 0 ? element.maxLength : 4096)}})
      : action === 'select' ? schema({value:{type:'string',enum:[...new Set(state.options.filter(option => !option.disabled).map(option => option.value))]}})
      : action === 'check' ? schema({checked:element.type === 'radio' ? {type:'boolean',enum:[true]} : {type:'boolean'}})
      : action === 'scroll' ? {...schema({top:{type:'number',minimum:0,maximum:10000000},left:{type:'number',minimum:0,maximum:10000000}},[]),minProperties:1}
      : schema()]));
  }
  function sample() {
    targets = new Map(); const result = [], limits = new Set();
    let node = root, visited = 0, bytes = 0, canvas = false, iframe = false, shadow = false;
    while (node) {
      if (++visited > 10000) { limits.add('element-limit'); break; }
      let descend = true;
      if (node.nodeType === 1) {
        if (node.tagName === 'CANVAS') canvas = true;
        if (node.tagName === 'IFRAME') iframe = true;
        if (node.shadowRoot) shadow = true;
        if (excluded(node)) descend = false;
        else {
          const role = roleOf(node), actions = actionsOf(node,role);
          if (role || actions.length) {
            if (result.length >= maxTargets) { limits.add('target-limit'); break; }
            const state = stateOf(node);
            if (actions.includes('select') && !state.options.some(option => !option.disabled)) actions.splice(actions.indexOf('select'),1);
            const target = {ref:refFor(node),role:role || 'region',name:nameOf(node),state,actions,actionSchemas:actionSchemas(node,actions,state)};
            bytes += encoder.encode(JSON.stringify(target)).length;
            if (bytes > 196608) { limits.add('snapshot-byte-limit'); break; }
            result.push(target); targets.set(target.ref,node);
          }
        }
      }
      node = nextNode(node,root,descend);
    }
    return {targets:result, coverage:{mode:'semantic-dom',truncated:limits.size > 0,limits:[...limits],
      unsupported:['canvas-content','iframe-content','shadow-trees','custom-widget-state','layout-occlusion'],
      detected:{canvas,iframe,openShadowRoot:shadow}}};
  }
  let prepared;
  function validate({id,target,action,arguments:input = {}}) {
    prepared = undefined;
    const element = targets.get(typeof target === 'string' ? target : target.ref);
    if (!element || excluded(element) || !actionsOf(element,roleOf(element)).includes(action)) fail('TARGET_UNAVAILABLE');
    const args = copyPlainJson(input,{maxBytes:8192,maxDepth:1});
    let setter, value, option;
    if (['click','focus'].includes(action)) keys(args,[]);
    else if (action === 'fill') {
      keys(args,['value']); value = args.value;
      if (typeof value !== 'string' || value.length > 4096 || element.maxLength >= 0 && value.length > element.maxLength) fail('INVALID_ACTION_ARGUMENTS');
      setter = Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,'value')?.set;
      if (!setter) fail('TARGET_UNAVAILABLE');
    } else if (action === 'select') {
      keys(args,['value']); value = args.value;
      if (typeof value !== 'string' || value.length > 256) fail('INVALID_ACTION_ARGUMENTS');
      if (!stateOf(element).options.some(item => item.value === value && !item.disabled)) fail('INVALID_ACTION_ARGUMENTS');
      for (let index = 0; index < Math.min(element.options.length,200); index++) {
        const item = element.options[index];
        if (item.value === value && !excluded(item) && !disabled(item) && item.parentElement?.disabled !== true) { option = item; break; }
      }
      if (!option) fail('INVALID_ACTION_ARGUMENTS');
      // A private/disabled option can share a public option's value. Setting by
      // index avoids accidentally selecting that earlier, excluded option.
      setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'selectedIndex')?.set;
      if (!setter) fail('TARGET_UNAVAILABLE');
      value = option.index;
    } else if (action === 'check') {
      keys(args,['checked']); if (typeof args.checked !== 'boolean' || element.type === 'radio' && !args.checked) fail('INVALID_ACTION_ARGUMENTS');
    } else if (action === 'scroll') {
      keys(args,['top','left'],[]);
      if (!Object.keys(args).length || Object.values(args).some(value => !Number.isFinite(value) || value < 0 || value > 10000000)) fail('INVALID_ACTION_ARGUMENTS');
    } else fail('INVALID_ACTION_ARGUMENTS');
    prepared = {id,run:() => {
    if (action === 'click') window.HTMLElement.prototype.click.call(element);
    else if (action === 'focus') window.HTMLElement.prototype.focus.call(element);
    else if (action === 'fill' || action === 'select') {
      setter.call(element,value);
      element.dispatchEvent(new window.Event('input',{bubbles:true,composed:true}));
      element.dispatchEvent(new window.Event('change',{bubbles:true}));
    } else if (action === 'check' && element.checked !== args.checked) window.HTMLElement.prototype.click.call(element);
    else if (action === 'scroll') {
      if (typeof window.Element.prototype.scrollTo === 'function') window.Element.prototype.scrollTo.call(element,{top:args.top ?? element.scrollTop,left:args.left ?? element.scrollLeft,behavior:'auto'});
      else { if (args.top !== undefined) element.scrollTop=args.top; if (args.left !== undefined) element.scrollLeft=args.left; }
    }
    }};
  }
  function execute({id}) {
    const effect = prepared; prepared = undefined;
    if (!effect || effect.id !== id) throw new Error('Missing validated DOM action');
    effect.run();
    return {status:'dispatched'};
  }
  const adapter = createSurfaceAdapter({kind:'website',sample,validate,execute,
    ...Object.fromEntries(['adapterId','maxReceipts','maxEvents'].filter(key => config[key] !== undefined).map(key => [key,config[key]]))});
  const eventTypes = ['click','input','change','focusin','scroll'];
  const onEvent = event => {
    const source = event.composedPath()[0] ?? event.target;
    let element = source?.nodeType === 1 ? source : source?.parentElement;
    if (!element || excluded(element)) return;
    // Record only metadata; input text is never placed in the activity stream.
    sample();
    while (element && inRoot(element)) {
      const ref = refs.get(element);
      if (ref && targets.has(ref)) {
        const actor = adapter.isActing() ? 'agent' : event.type === 'scroll' ? 'system' : 'user';
        adapter.record({type:`web.${event.type}`,target:ref,actor,trusted:event.isTrusted === true,
          attribution:adapter.isActing() ? 'adapter-dispatch' : event.type === 'scroll' ? 'unattributed-scroll' : 'non-adapter-event'});
        break;
      }
      element = element.parentElement;
    }
  };
  for (const type of eventTypes) root.addEventListener(type,onEvent,true);
  adapter.onDispose(() => { for (const type of eventTypes) root.removeEventListener(type,onEvent,true); targets.clear(); prepared = undefined; });
  const {observe,act,getOutcome,subscribe,history,dispose,callTool} = adapter;
  return Object.freeze({observe,act,getOutcome,subscribe,history,dispose,callTool,get tools() { return adapter.tools; }});
}
