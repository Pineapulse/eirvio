import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';

const observe = adapter => adapter.callTool('surface_observe',{});
const act = (adapter,request) => adapter.callTool('surface_act',request);
const outcome = (adapter,id) => adapter.callTool('surface_get_outcome',{id});
const recordStep = async (context,label,data = {}) => { if (context.record) await context.record(label,data); };
const publicSuffix = seed => String((seed >>> 0) % 10000).padStart(4,'0');
function plan(adapter,name,action,args = {},snapshot = observe(adapter)) {
  const target = snapshot.targets.find(candidate => candidate.name === name && candidate.actions.includes(action));
  if (!target) throw new Error(`Synthetic target unavailable: ${name}/${action}`);
  return {adapterId:snapshot.adapterId,id:randomUUID(),revision:snapshot.revision,target:target.ref,action,arguments:args};
}
async function withPage(context,html,run) {
  // No resources or page scripts are enabled: fixture behavior is local JS below.
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`,{url:'https://eirvio-lab.invalid/'});
  let adapter;
  try {
    adapter = context.installWeb({root:dom.window.document.body,adapterId:randomUUID()});
    await run({adapter,document:dom.window.document,window:dom.window});
  } finally { try { adapter?.dispose(); } finally { dom.window.close(); } }
}
const scenario = (id,title,difficulty,description,run) => Object.freeze({id:`web.${id}`,version:1,title,kind:'website',difficulty,description,run});

export const webScenarios = Object.freeze([
  scenario('plain_form','Complete an ordinary form','basic',
    'Discover an unregistered form, fill and select native controls, then verify application submission separately from dispatched receipts.',
    async context => withPage(context,`<form><label>Name<input required></label><label>Plan<select><option value="basic">Basic</option><option value="plus">Plus</option></select></label>
      <label><input type="checkbox" required>Terms</label><button>Save profile</button></form><p role="status">Waiting</p>`,async ({adapter,document}) => {
      const {assert,seed}=context, value=`Learner ${publicSuffix(seed)}`, choice=seed % 2 ? 'plus' : 'basic';let saved=0, savedName;
      document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();saved++;savedName=document.querySelector('input').value;document.querySelector('[role=status]').textContent='Saved';});
      const initial=observe(adapter);assert.ok(initial.targets.some(target=>target.name==='Name'));
      await recordStep(context,'form discovered',{targets:initial.targets.length});
      for(const [name,action,args] of [['Name','fill',{value}],['Plan','select',{value:choice}],['Terms','check',{checked:true}],['Save profile','click',{}]]) {
        const request=plan(adapter,name,action,args), receipt=act(adapter,request);
        assert.equal(receipt.status,'dispatched');assert.deepEqual(outcome(adapter,request.id),receipt);
      }
      assert.equal(saved,1);assert.equal(savedName,value);assert.equal(document.querySelector('select').value,choice);
      assert.ok(observe(adapter).targets.some(target=>target.name==='Saved'));
      await recordStep(context,'application submission verified',{submissions:saved,receiptStatus:'dispatched',selectedPlan:choice});
    })),

  scenario('user_interruption','Human input invalidates an agent plan','intermediate',
    'A synthetic user edits after observation; stale fill is rejected, retained as an outcome, and a newly observed action can proceed.',
    async context => withPage(context,'<label>Destination<input value="Initial"></label><p>Plan a route</p>',async ({adapter,document,window}) => {
      const {assert,seed}=context, input=document.querySelector('input'), old=plan(adapter,'Destination','fill',{value:'Old agent plan'});
      input.value=`User choice ${publicSuffix(seed)}`;input.dispatchEvent(new window.Event('input',{bubbles:true}));
      const receipt=act(adapter,old);assert.equal(receipt.status,'rejected');assert.equal(receipt.code,'STALE_SURFACE');
      assert.equal(input.value,`User choice ${publicSuffix(seed)}`);assert.deepEqual(outcome(adapter,old.id),receipt);
      const fresh=observe(adapter);assert.ok(fresh.activity.events.some(event=>event.type==='web.input'&&event.actor==='user'));
      assert.equal(JSON.stringify(fresh.activity).includes(input.value),false,'Activity records must not contain typed values');
      await recordStep(context,'stale plan safely rejected',{code:receipt.code,userInputPreserved:true});
      const revised=plan(adapter,'Destination','fill',{value:`Reconciled ${publicSuffix(seed)}`},fresh);
      assert.equal(act(adapter,revised).status,'dispatched');assert.equal(input.value,`Reconciled ${publicSuffix(seed)}`);
      await recordStep(context,'explicit replanning succeeds',{revisionAdvanced:fresh.revision>old.revision});
    })),

  scenario('replaced_button','Replacement nodes receive new references','intermediate',
    'Replace a button with an identical ID and label, reject the old reference, then dispatch once to the replacement.',
    async context => withPage(context,'<button id="confirm">Confirm</button><p role="status">Pending</p>',async ({adapter,document}) => {
      const {assert}=context;let oldClicks=0,newClicks=0;
      const original=document.querySelector('button');original.addEventListener('click',()=>oldClicks++);
      const old=plan(adapter,'Confirm','click'), replacement=original.cloneNode(true);
      replacement.addEventListener('click',()=>{newClicks++;document.querySelector('[role=status]').textContent='Confirmed';});original.replaceWith(replacement);
      const rejected=act(adapter,old);assert.equal(rejected.code,'STALE_SURFACE');assert.equal(oldClicks+newClicks,0);
      const fresh=observe(adapter), current=plan(adapter,'Confirm','click',{},fresh);assert.notEqual(current.target,old.target);
      const receipt=act(adapter,current);assert.equal(receipt.status,'dispatched');assert.deepEqual(act(adapter,current),receipt);
      assert.equal(oldClicks,0);assert.equal(newClicks,1);
      await recordStep(context,'identity fencing verified',{oldCode:rejected.code,referenceChanged:true,replacementEffects:newClicks});
    })),

  scenario('lost_reply_retry','Recover a lost acknowledgement exactly once','adversarial',
    'Discard an action reply, reconcile by ID, retry the exact request, and reject changed content under the retained ID.',
    async context => withPage(context,'<button>Increment</button><output>0</output>',async ({adapter,document}) => {
      const {assert}=context;let count=0;
      document.querySelector('button').addEventListener('click',()=>{document.querySelector('output').textContent=String(++count);});
      const request=plan(adapter,'Increment','click');act(adapter,request); // Deliberately discard this reply; no actual network is involved.
      assert.equal(count,1);const recovered=outcome(adapter,request.id);assert.equal(recovered.status,'dispatched');
      const retry=act(adapter,structuredClone(request));assert.deepEqual(retry,recovered);assert.equal(count,1);
      const conflict=act(adapter,{...request,arguments:{unexpected:true}});assert.equal(conflict.code,'ID_REUSE_CONFLICT');assert.equal(count,1);
      assert.equal(outcome(adapter,randomUUID()),null);
      await recordStep(context,'lost reply reconciled',{exactRetryEffects:count,changedRequestCode:conflict.code});
      assert.equal(act(adapter,plan(adapter,'Increment','click')).status,'dispatched');assert.equal(count,2);
      await recordStep(context,'new deliberate action remains possible',{totalEffects:count});
    })),

  scenario('controlled_input','Update a framework-controlled field','intermediate',
    'A small controlled-input fixture tracks its own value setter, normalizes native input events, and rejects a plan interrupted by later user input.',
    async context => withPage(context,'<label>Display name<input></label><button>Publish name</button><output>Unpublished</output>',async ({adapter,document,window}) => {
      const {assert,seed}=context, input=document.querySelector('input'), native=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
      let tracked='',model='',updates=0,published='';
      Object.defineProperty(input,'value',{configurable:true,get(){return native.get.call(this);},set(value){tracked=String(value);native.set.call(this,value);}});
      input.addEventListener('input',()=>{const actual=native.get.call(input);if(actual!==tracked){model=actual.trim().toUpperCase();updates++;input.value=model;}});
      document.querySelector('button').addEventListener('click',()=>{published=model;document.querySelector('output').textContent=published;});
      const value=` member ${publicSuffix(seed)} `;
      assert.equal(act(adapter,plan(adapter,'Display name','fill',{value})).status,'dispatched');assert.equal(updates,1);assert.equal(model,value.trim().toUpperCase());
      const oldPublish=plan(adapter,'Publish name','click');
      native.set.call(input,`user ${publicSuffix(seed)}`);input.dispatchEvent(new window.Event('input',{bubbles:true}));
      assert.equal(act(adapter,oldPublish).code,'STALE_SURFACE');assert.equal(published,'');assert.equal(updates,2);
      assert.equal(act(adapter,plan(adapter,'Publish name','click')).status,'dispatched');assert.equal(published,model);
      await recordStep(context,'controlled app state verified',{normalizedUpdates:updates,stalePublishRejected:true,modelMatchesPublished:true});
    })),

  scenario('dynamic_privacy','Hide content while a plan is outstanding','adversarial',
    'Apply a privacy marker and then CSS content-visibility:hidden dynamically; no hidden values or labels may appear in observations or activity.',
    async context => withPage(context,'<li id="panel"><label>Notes<input value="Public note"></label><span id="message">Public message</span></li><button>Continue</button>',async ({adapter,document,window}) => {
      const {assert,seed}=context, panel=document.querySelector('#panel'),input=document.querySelector('input'),message=document.querySelector('#message');
      const request=plan(adapter,'Notes','fill',{value:'Planned note'}), privateMarker=`synthetic-private-${publicSuffix(seed)}`;
      const attribute=seed % 2 ? 'data-private' : 'data-eirvio-redacted';panel.setAttribute(attribute,'');input.value=privateMarker;message.textContent=privateMarker;
      const hidden=observe(adapter);assert.equal(JSON.stringify(hidden).includes(privateMarker),false,'Marked private content must be omitted');
      assert.equal(act(adapter,request).code,'STALE_SURFACE');const before=observe(adapter).activity.cursor;
      input.dispatchEvent(new window.Event('input',{bubbles:true}));assert.equal(observe(adapter).activity.cursor,before);
      await recordStep(context,'dynamic marker respected',{contentOmitted:true,privateActivityOmitted:true,stalePlanRejected:true});
      panel.removeAttribute(attribute);panel.style.contentVisibility='hidden';
      assert.equal(window.getComputedStyle(panel).contentVisibility,'hidden');
      const cssHidden=observe(adapter);
      const exposed=cssHidden.targets.some(target=>target.name==='Notes')||JSON.stringify(cssHidden).includes(privateMarker);
      await recordStep(context,'CSS hidden subtree checked',{computedHidden:true,hiddenSubtreeExposed:exposed});
      assert.equal(exposed,false,'CSS content-visibility:hidden must exclude descendant targets and ancestor labels');
      panel.style.contentVisibility='visible';input.value='Public again';message.textContent='Public message';
      assert.equal(act(adapter,plan(adapter,'Notes','fill',{value:'Updated public note'})).status,'dispatched');assert.equal(input.value,'Updated public note');
      await recordStep(context,'public field restored',{visibleAgain:true});
    })),

  scenario('unsupported_surfaces','Keep unsupported surfaces explicit','intermediate',
    'Expose an ordinary button alongside canvas, iframe and shadow trees; unsupported contents remain unaddressable while the normal DOM still works.',
    async context => withPage(context,'<button>Public action</button><canvas>Canvas fallback</canvas><iframe></iframe><div id="open" tabindex="0" aria-label="Open host"></div><div id="closed"></div>',async ({adapter,document}) => {
      const {assert}=context;let clicks=0;document.querySelector('button').addEventListener('click',()=>clicks++);
      const open=document.querySelector('#open').attachShadow({mode:'open'}),closed=document.querySelector('#closed').attachShadow({mode:'closed'});
      for(const [root,name] of [[open,'Open shadow action'],[closed,'Closed shadow action']]) {const button=document.createElement('button');button.textContent=name;root.append(button);}
      const frame=document.querySelector('iframe');frame.contentDocument.body.innerHTML='<button>Frame action</button>';
      const snapshot=observe(adapter), output=JSON.stringify(snapshot);
      for(const name of ['Open shadow action','Closed shadow action','Frame action','Canvas fallback']) assert.equal(output.includes(name),false);
      for(const area of ['shadow-trees','iframe-content','canvas-content']) assert.ok(snapshot.coverage.unsupported.includes(area));
      assert.deepEqual(snapshot.coverage.detected,{canvas:true,iframe:true,openShadowRoot:true});
      const before=snapshot.activity.cursor;open.querySelector('button').click();frame.contentDocument.querySelector('button').click();assert.equal(observe(adapter).activity.cursor,before);
      const unknown={adapterId:snapshot.adapterId,id:randomUUID(),revision:observe(adapter).revision,target:'unobserved-frame-target',action:'click',arguments:{}};
      assert.equal(act(adapter,unknown).code,'TARGET_UNAVAILABLE');assert.equal(act(adapter,plan(adapter,'Public action','click')).status,'dispatched');assert.equal(clicks,1);
      await recordStep(context,'unsupported scope stays explicit',{unsupportedAreas:3,unsupportedEventsOmitted:true,publicEffects:clicks});
    })),

  scenario('validation_dispatch','Distinguish dispatch from application success','adversarial',
    'Native form validation and an application availability rule prevent submission effects despite dispatched clicks; verify the final success independently.',
    async context => withPage(context,'<form><label>Email<input type="email" required></label><label><input type="checkbox" required>Accept conditions</label><button>Reserve</button></form><p role="status">Waiting</p>',async ({adapter,document}) => {
      const {assert}=context;let submitted=0,confirmed=0,available=false;
      document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();submitted++;document.querySelector('[role=status]').textContent=available?'Confirmed':'Unavailable';if(available)confirmed++;});
      assert.equal(act(adapter,plan(adapter,'Reserve','click')).status,'dispatched');assert.equal(submitted,0);
      assert.equal(act(adapter,plan(adapter,'Email','fill',{value:'not-an-email'})).status,'dispatched');
      assert.equal(act(adapter,plan(adapter,'Reserve','click')).status,'dispatched');assert.equal(submitted,0);
      assert.equal(act(adapter,plan(adapter,'Email','fill',{value:'learner@example.invalid'})).status,'dispatched');
      assert.equal(act(adapter,plan(adapter,'Accept conditions','check',{checked:true})).status,'dispatched');
      assert.equal(act(adapter,plan(adapter,'Reserve','click')).status,'dispatched');assert.equal(submitted,1);assert.equal(confirmed,0);
      assert.ok(observe(adapter).targets.some(target=>target.name==='Unavailable'));
      await recordStep(context,'dispatch did not imply success',{nativeValidationBlocked:true,applicationRuleBlocked:true,confirmed});
      available=true;assert.equal(act(adapter,plan(adapter,'Reserve','click')).status,'dispatched');assert.equal(confirmed,1);
      assert.ok(observe(adapter).targets.some(target=>target.name==='Confirmed'));
      await recordStep(context,'independent app success observed',{submitted,confirmed});
    })),

  scenario('select_boundaries','Select only an advertised public option','adversarial',
    'Choose a public option whose value duplicates a private disabled option, then reject an option outside the bounded advertised choice list.',
    async context => withPage(context,'<label>Plan<select><option value="none">None</option><option disabled data-private value="shared">Private choice</option><option value="shared">Public choice</option></select></label>',async ({adapter,document}) => {
      const {assert,seed}=context, select=document.querySelector('select');let changes=0;select.addEventListener('change',()=>changes++);
      const first=observe(adapter);assert.equal(JSON.stringify(first).includes('Private choice'),false);
      assert.equal(act(adapter,plan(adapter,'Plan','select',{value:'shared'})).status,'dispatched');assert.equal(select.selectedIndex,2);assert.equal(changes,1);
      const added=25+seed % 4;
      for(let index=0;index<added;index++){const option=document.createElement('option');option.value=`extra-${index}`;option.textContent=`Extra ${index}`;select.append(option);}
      const limited=observe(adapter), target=limited.targets.find(item=>item.name==='Plan');assert.equal(target.state.options.length,20);assert.equal(target.state.optionsTruncated,true);
      const rejected=act(adapter,plan(adapter,'Plan','select',{value:`extra-${added-1}`},limited));assert.equal(rejected.code,'INVALID_ACTION_ARGUMENTS');assert.equal(changes,1);
      assert.equal(act(adapter,plan(adapter,'Plan','select',{value:'none'})).status,'dispatched');assert.equal(select.selectedIndex,0);
      await recordStep(context,'selection boundary verified',{privateDuplicateSkipped:true,unadvertisedCode:rejected.code,changeEvents:changes});
    })),
]);
