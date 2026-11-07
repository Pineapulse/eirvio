import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {installWeb} from '../src/web.mjs';
import {InteractionValidationError} from '../src/events.mjs';

function setup(t, html, options = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`,{url:'https://example.test/'});
  const adapter = installWeb({root:dom.window.document.body,adapterId:'web-test',...options});
  t.after(() => {adapter.dispose();dom.window.close();});
  return {adapter,document:dom.window.document,window:dom.window};
}
let sequence = 0;
function request(adapter, name, action, args = {}) {
  const snapshot = adapter.observe(), target = snapshot.targets.find(item => item.name === name);
  assert.ok(target,`Missing target ${name}: ${JSON.stringify(snapshot.targets)}`);
  return {adapterId:snapshot.adapterId,id:`action-${++sequence}`,revision:snapshot.revision,target:target.ref,action,arguments:args};
}
const names = adapter => adapter.observe().targets.map(target => target.name);

test('plain semantic forms expose names, state and closed action schemas without registration', t => {
  const {adapter} = setup(t,`<h1>Checkout</h1><label>Name<input value="Ada" maxlength="40"></label>
    <label>Plan<select><option value="free">Free</option><option value="pro">Professional</option></select></label>
    <label><input type="checkbox">Accept terms</label><button>Save</button><a href="/account?token=URL_SECRET#private">Account</a>`);
  const snapshot=adapter.observe();
  assert.equal(snapshot.kind,'website'); assert.ok(snapshot.targets.some(target=>target.role==='heading'&&target.name==='Checkout'));
  const input=snapshot.targets.find(target=>target.name==='Name');
  assert.equal(input.state.value,'Ada');assert.deepEqual(input.actions,['fill','focus']);
  assert.equal(input.actionSchemas.fill.properties.value.maxLength,40);
  assert.equal(input.actionSchemas.fill.additionalProperties,false);
  const select=snapshot.targets.find(target=>target.name==='Plan');
  assert.deepEqual(select.actionSchemas.select.properties.value.enum,['free','pro']);
  assert.equal(JSON.stringify(snapshot).includes('URL_SECRET'),false);
  assert.deepEqual(snapshot.coverage.limits,[]);
});

test('privacy pruning applies to ancestor text, ARIA references, labels, options and sensitive fields', t => {
  const {adapter,document} = setup(t,`<div id="outside">OUTSIDE_SECRET</div><main id="app">
    <p>Public <span data-private>PRIVATE_SECRET</span><span hidden>HIDDEN_SECRET</span></p>
    <li>Visible <details><summary>More</summary><p>CLOSED_SECRET</p></details></li>
    <div aria-hidden="true">ARIA_SECRET</div><div style="display:none">STYLE_SECRET</div>
    <label>PASSWORD_LABEL_SECRET<input type="password" value="PASSWORD_SECRET"></label>
    <input type="hidden" value="TOKEN_SECRET"><input autocomplete="CC-NUMBER" value="CARD_SECRET">
    <textarea data-redacted>TEXTAREA_SECRET</textarea><input data-eirvio-private placeholder="PLACEHOLDER_SECRET" value="VALUE_SECRET">
    <label data-eirvio-redacted for="public">REDACTED_LABEL_SECRET</label><input id="public" aria-labelledby="outside private-label">
    <span data-private id="private-label">PRIVATE_LABEL_SECRET</span>
    <select aria-label="Choices"><option data-private value="OPTION_SECRET">OPTION_LABEL_SECRET</option><option value="safe">Safe</option></select>
    </main>`);
  const scoped=installWeb({root:document.querySelector('main'),adapterId:'scoped'});t.after(()=>scoped.dispose());
  const output=JSON.stringify(scoped.observe());
  for(const secret of ['OUTSIDE_SECRET','PRIVATE_SECRET','HIDDEN_SECRET','CLOSED_SECRET','ARIA_SECRET','STYLE_SECRET','PASSWORD_LABEL_SECRET',
    'PASSWORD_SECRET','TOKEN_SECRET','CARD_SECRET','TEXTAREA_SECRET','PLACEHOLDER_SECRET','VALUE_SECRET','REDACTED_LABEL_SECRET',
    'PRIVATE_LABEL_SECRET','OPTION_SECRET','OPTION_LABEL_SECRET']) assert.equal(output.includes(secret),false,secret);
  assert.ok(output.includes('Visible'));assert.ok(output.includes('Safe'));
  assert.equal(adapter.observe().targets.some(target=>target.state?.inputType==='password'),false);
});

test('dynamic content-visibility:hidden prunes descendants, ancestor labels and activity before acting', t => {
  const {adapter,document,window}=setup(t,'<li id="panel"><label>Notes<input value="Public"></label><span>Public detail</span></li>');
  const planned=request(adapter,'Notes','fill',{value:'Agent update'}), panel=document.querySelector('#panel'), input=document.querySelector('input');
  panel.style.contentVisibility='hidden';input.value='SYNTHETIC_PRIVATE_VALUE';document.querySelector('span').textContent='SYNTHETIC_PRIVATE_LABEL';
  assert.equal(window.getComputedStyle(panel).contentVisibility,'hidden');
  const hidden=adapter.observe();assert.deepEqual(hidden.targets,[]);
  assert.equal(adapter.act(planned).code,'STALE_SURFACE');assert.equal(input.value,'SYNTHETIC_PRIVATE_VALUE');
  const before=adapter.history().cursor;input.dispatchEvent(new window.Event('input',{bubbles:true}));assert.equal(adapter.history().cursor,before);
  panel.style.contentVisibility='visible';input.value='Public again';document.querySelector('span').textContent='Public detail';
  assert.equal(adapter.act(request(adapter,'Notes','fill',{value:'Allowed now'})).status,'dispatched');assert.equal(input.value,'Allowed now');
});

test('direct value, checked and disabled changes stale old requests synchronously', t => {
  const {adapter,document}=setup(t,'<label>Name<input value="before"></label><label><input type="checkbox">Ready</label><button>Go</button>');
  const fill=request(adapter,'Name','fill',{value:'agent'});document.querySelector('input').value='human';
  assert.equal(adapter.act(fill).code,'STALE_SURFACE');assert.equal(document.querySelector('input').value,'human');
  const check=request(adapter,'Ready','check',{checked:true});document.querySelector('[type=checkbox]').checked=true;
  assert.equal(adapter.act(check).code,'STALE_SURFACE');
  const click=request(adapter,'Go','click');document.querySelector('button').disabled=true;
  assert.equal(adapter.act(click).code,'STALE_SURFACE');
});

test('value changes beyond displayed prefix are guarded without exposing the full value', t => {
  const {adapter,document}=setup(t,'<input aria-label="Long text">');const input=document.querySelector('input');
  input.value='a'.repeat(1024)+'first-secret-suffix';const first=adapter.observe();
  assert.equal(first.targets[0].state.value.length,1024);assert.equal(JSON.stringify(first).includes('first-secret-suffix'),false);
  const action=request(adapter,'Long text','fill',{value:'next'});input.value='a'.repeat(1024)+'second-suffix';
  assert.equal(adapter.act(action).code,'STALE_SURFACE');
});

test('identity refs remain stable on existing elements and never transfer to replacements', t => {
  const {adapter,document}=setup(t,'<button id="save">Save</button>');
  const first=request(adapter,'Save','click');assert.equal(adapter.observe().targets[0].ref,first.target);
  const replacement=document.createElement('button');replacement.id='save';replacement.textContent='Save';
  document.querySelector('button').replaceWith(replacement);
  assert.notEqual(adapter.observe().targets[0].ref,first.target);assert.equal(adapter.act(first).code,'STALE_SURFACE');
});

test('visibility, readonly, fieldset disability, private marking and containment are rechecked', t => {
  for(const mutate of [input=>{input.hidden=true;},input=>{input.readOnly=true;},input=>{input.setAttribute('data-private','');},
    input=>{input.parentElement.disabled=true;},input=>{input.remove();},input=>{input.setAttribute('aria-disabled','true');}]) {
    const {adapter,document}=setup(t,'<fieldset><input aria-label="Name"></fieldset>');const action=request(adapter,'Name','fill',{value:'next'});
    mutate(document.querySelector('input'));assert.equal(adapter.act(action).status,'rejected');assert.notEqual(adapter.act(action).status,'dispatched');
  }
});

test('fill uses realm-native setter and input/change events while bypassing own framework setter', t => {
  const {adapter,document,window}=setup(t,'<label>Name<input></label><textarea aria-label="Notes"></textarea>');
  const input=document.querySelector('input'), native=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');let intercepted=0;
  Object.defineProperty(input,'value',{configurable:true,get(){return native.get.call(this);},set(){intercepted++;}});
  const received=[];input.addEventListener('input',event=>received.push([event.type,event.bubbles,input.value]));input.addEventListener('change',event=>received.push([event.type,event.bubbles,input.value]));
  assert.equal(adapter.act(request(adapter,'Name','fill',{value:'Ada'})).status,'dispatched');
  assert.equal(input.value,'Ada');assert.equal(intercepted,0);assert.deepEqual(received,[['input',true,'Ada'],['change',true,'Ada']]);
  assert.equal(adapter.act(request(adapter,'Notes','fill',{value:'Two\nlines'})).status,'dispatched');assert.equal(document.querySelector('textarea').value,'Two\nlines');
});

test('click, native select, check and focus dispatch through ordinary DOM handlers', t => {
  const {adapter,document}=setup(t,'<button>Go</button><select aria-label="Plan"><option value="a">Alpha</option><option value="b">Beta</option></select><label><input type="checkbox">Ready</label>');
  let clicked=0;document.querySelector('button').addEventListener('click',()=>clicked++);
  assert.equal(adapter.act(request(adapter,'Go','click')).status,'dispatched');assert.equal(clicked,1);
  assert.equal(adapter.act(request(adapter,'Plan','select',{value:'b'})).status,'dispatched');assert.equal(document.querySelector('select').value,'b');
  assert.equal(adapter.act(request(adapter,'Ready','check',{checked:true})).status,'dispatched');assert.equal(document.querySelector('input').checked,true);
  assert.equal(adapter.act(request(adapter,'Ready','check',{checked:false})).status,'dispatched');assert.equal(document.querySelector('input').checked,false);
  assert.equal(adapter.act(request(adapter,'Go','focus')).status,'dispatched');assert.equal(document.activeElement,document.querySelector('button'));
});

test('selection cannot choose a private duplicate or an option outside the bounded advertisement', t => {
  const {adapter,document}=setup(t,'<select aria-label="Plan"><option data-private value="same">PRIVATE</option><option value="same">Public</option></select>');
  assert.equal(adapter.act(request(adapter,'Plan','select',{value:'same'})).status,'dispatched');
  assert.equal(document.querySelector('select').selectedIndex,1);
  const select=document.querySelector('select');
  for(let index=0;index<25;index++){const option=document.createElement('option');option.value=`value-${index}`;option.textContent=`Option ${index}`;select.append(option);}
  assert.equal(adapter.observe().targets[0].state.options.length,20);
  assert.equal(adapter.act(request(adapter,'Plan','select',{value:'value-24'})).code,'INVALID_ACTION_ARGUMENTS');
});

test('invalid action arguments reject before side effects and advertised actions cannot be expanded', t => {
  const {adapter,document}=setup(t,'<input aria-label="Name" maxlength="5"><button>Go</button><select aria-label="Plan"><option value="a">Alpha</option><option disabled value="b">Beta</option></select><label><input type="radio">Only</label>');
  for(const [name,action,args] of [['Name','fill',{value:3}],['Name','fill',{value:'abcdef'}],['Name','fill',{value:'yes',selector:'*'}],
    ['Go','click',{value:'x'}],['Go','focus',{selector:'*'}],['Plan','select',{value:'b'}],['Plan','select',{value:'missing'}],['Only','check',{checked:false}]]) {
    assert.equal(adapter.act(request(adapter,name,action,args)).code,'INVALID_ACTION_ARGUMENTS');
  }
  assert.equal(document.querySelector('input').value,'');
  assert.equal(adapter.act(request(adapter,'Go','fill',{value:'no'})).code,'ACTION_UNAVAILABLE');
});

test('scroll is bounded and meaningfully advertised; asynchronous scroll origin is conservative', t => {
  const {adapter,document,window}=setup(t,'<div aria-label="Pane" tabindex="0">Scrollable</div>');const pane=document.querySelector('div');
  Object.defineProperties(pane,{scrollHeight:{value:500},clientHeight:{value:100},scrollWidth:{value:500},clientWidth:{value:100}});
  assert.equal(adapter.act(request(adapter,'Pane','scroll',{top:75,left:20})).status,'dispatched');assert.equal(pane.scrollTop,75);assert.equal(pane.scrollLeft,20);
  for(const args of [{},{top:-1},{left:Infinity},{top:'3'},{top:1,behavior:'smooth'}]) {
    if(args.left===Infinity) assert.throws(()=>adapter.act(request(adapter,'Pane','scroll',args)));
    else assert.equal(adapter.act(request(adapter,'Pane','scroll',args)).code,'INVALID_ACTION_ARGUMENTS');
  }
  pane.dispatchEvent(new window.Event('scroll'));const event=adapter.history().events.find(event=>event.type==='web.scroll');
  assert.equal(event.actor,'system');assert.equal(event.attribution,'unattributed-scroll');
});

test('automatic activity contains metadata only and attributes synchronous agent effects across adapters', t => {
  const {adapter,document,window}=setup(t,'<input aria-label="Name"><input type="password"><button>Go</button>');
  const other=installWeb({root:document.body,adapterId:'other'});t.after(()=>other.dispose());
  const input=document.querySelector('input');input.value='USER_TYPED_SECRET';input.dispatchEvent(new window.Event('input',{bubbles:true}));
  let event=adapter.history().events.find(event=>event.type==='web.input');assert.equal(event.actor,'user');assert.equal(event.trusted,false);
  assert.equal(JSON.stringify(adapter.history()).includes('USER_TYPED_SECRET'),false);
  document.querySelector('[type=password]').dispatchEvent(new window.Event('input',{bubbles:true}));
  assert.equal(adapter.history().events.filter(event=>event.type==='web.input').length,1);
  adapter.act(request(adapter,'Name','fill',{value:'agent'}));adapter.act(request(adapter,'Go','focus'));
  for(const instance of [adapter,other]) {
    const events=instance.history().events.filter(event=>['web.input','web.change','web.focusin'].includes(event.type));
    assert.ok(events.slice(1).every(event=>event.actor==='agent'));
    assert.equal(events.at(-1).trusted,true,'programmatic native focus may be trusted; attribution still uses active adapter execution');
  }
});

test('side-effect failures remain uncertain even when thrown using exported validation class', t => {
  const {adapter,document,window}=setup(t,'<input aria-label="Name">');const input=document.querySelector('input');
  const native=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
  Object.defineProperty(window.HTMLInputElement.prototype,'value',{...native,set(value){native.set.call(this,value);throw new InteractionValidationError('AFTER_EFFECT');}});
  const action=request(adapter,'Name','fill',{value:'changed'}), receipt=adapter.act(action);
  assert.equal(input.value,'changed');assert.equal(receipt.status,'uncertain');assert.equal(receipt.code,'ACTION_UNCERTAIN');
  assert.deepEqual(adapter.act(action),receipt);assert.deepEqual(adapter.getOutcome(action.id),receipt);
});

test('cancelled application behavior is dispatched rather than claimed complete', t => {
  const {adapter,document}=setup(t,'<label><input type="checkbox">Ready</label>');document.querySelector('input').addEventListener('click',event=>event.preventDefault());
  assert.equal(adapter.act(request(adapter,'Ready','check',{checked:true})).status,'dispatched');assert.equal(document.querySelector('input').checked,false);
});

test('bounds and unsupported coverage are explicit, and private custom widgets cannot be targeted', t => {
  const {adapter,document}=setup(t,'<button>One</button><canvas>CANVAS_TEXT</canvas><iframe></iframe><div id="shadow"></div><button>Two</button><button>Three</button>',{maxTargets:2});
  document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>SHADOW_SECRET</button>';
  const snapshot=adapter.observe();assert.equal(snapshot.targets.length,2);assert.equal(snapshot.coverage.truncated,true);assert.ok(snapshot.coverage.limits.includes('target-limit'));
  assert.deepEqual(snapshot.coverage.detected,{canvas:true,iframe:true,openShadowRoot:true});assert.equal(JSON.stringify(snapshot).includes('SHADOW_SECRET'),false);
  assert.ok(snapshot.coverage.unsupported.includes('shadow-trees'));assert.ok(snapshot.coverage.unsupported.includes('canvas-content'));
});

test('shadow-origin events and unsupported SVG native actions are not promoted to actionable HTML targets', t => {
  const {adapter,document}=setup(t,'<div tabindex="0" aria-label="Host"></div><svg role="button" aria-label="Vector"></svg>');
  const shadow=document.querySelector('div').attachShadow({mode:'open'}), button=document.createElement('button');button.textContent='Private inner button';shadow.append(button);
  assert.deepEqual(adapter.observe().targets.find(target=>target.name==='Vector').actions,[]);
  button.click();assert.equal(adapter.history().events.length,0);
});

test('dispose removes DOM listeners; retained receipts survive and source DOM remains usable', t => {
  const {adapter,document}=setup(t,'<button>Go</button>');const action=request(adapter,'Go','click'), receipt=adapter.act(action);
  for(const internal of ['record','isActing','onDispose']) assert.equal(internal in adapter,false);
  const before=adapter.history().cursor;adapter.dispose();adapter.dispose();document.querySelector('button').click();
  assert.equal(adapter.history().cursor,before);assert.deepEqual(adapter.getOutcome(action.id),receipt);assert.deepEqual(adapter.act(action),receipt);
  assert.throws(()=>adapter.observe(),error=>error.code==='SURFACE_DISPOSED');
});

test('options reject unsupported fields, getters and invalid roots without executing accessors', t => {
  const {document}=setup(t,'<button>Go</button>');let reads=0;
  assert.throws(()=>installWeb({get root(){reads++;return document.body;}}));assert.equal(reads,0);
  for(const options of [{root:null},{root:document},{root:document.body,maxTargets:0},{root:document.body,maxTargets:1001},{root:document.body,selector:'*'}]) assert.throws(()=>installWeb(options));
});
