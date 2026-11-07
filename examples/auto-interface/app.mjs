import {installWeb} from '/sdk/web.mjs';
import {startGame} from '/auto/game.mjs';
const $=id=>document.getElementById(id);
// Ordinary application logic. No event-tracking hooks or manually registered controls.
$('passport-form').addEventListener('submit',event=>{
  event.preventDefault();const name=$('explorer-name').value.trim();
  if(name)$('passport-result').textContent=`Welcome, ${name}! Your pass to ${$('destination').selectedOptions[0].textContent} is ready.${$('sound').checked?' Sound is on.':''}`;
});
const website=installWeb({root:$('website-example')});
let game, active=website, mode='web', scheduled=false, lastSnapshot='';
const names=new Map();
function update(){
  scheduled=false;const snapshot=active.observe();
  for(const target of snapshot.targets)names.set(target.ref,target.name||target.role);
  $('target-count').textContent=snapshot.targets.length;$('event-count').textContent=snapshot.activity.cursor;
  const actionable=snapshot.targets.filter(target=>target.actions.some(action=>!['focus','scroll'].includes(action))).slice(0,6);
  $('targets').replaceChildren(...actionable.map(target=>{const li=document.createElement('li'),name=document.createElement('span'),actions=document.createElement('small');name.textContent=target.name||target.role;actions.textContent=target.actions.filter(action=>action!=='scroll').join(' · ');li.append(name,actions);return li;}));
  const recent=snapshot.activity.events.filter(event=>event.type!=='focusout').slice(-5).reverse();
  if(recent.length)$('activity').replaceChildren(...recent.map(event=>{const li=document.createElement('li'),actor=document.createElement('span'),description=document.createElement('span');actor.className=`actor ${event.actor}`;actor.textContent=event.actor;description.textContent=`${event.action||event.type}${event.target?' · '+(names.get(event.target)||event.target):''}${event.status?' · '+event.status:''}`;li.append(actor,description);return li;}));
  else{const li=document.createElement('li');li.className='muted';li.textContent='Use the interface to start the live feed.';$('activity').replaceChildren(li);}
  const data=JSON.stringify(snapshot,null,2);if(data!==lastSnapshot){$('snapshot').textContent=data;lastSnapshot=data;}
}
function schedule(){if(!scheduled){scheduled=true;queueMicrotask(update);}}
website.subscribe(schedule);
for(const selected of ['web','game'])$(selected+'-tab').addEventListener('click',()=>{
  mode=selected;
  for(const candidate of ['web','game']){$(candidate+'-tab').setAttribute('aria-selected',String(candidate===selected));$(candidate+'-panel').hidden=candidate!==selected;$(candidate+'-actions').hidden=candidate!==selected;}
  if(selected==='game'&&!game){game=startGame($('game-canvas'));game.subscribe(schedule);}
  active=selected==='web'?website:game;
  $('surface-title').textContent=selected==='web'?'Your website':'Your Babylon scene';
  $('install-code').textContent=selected==='web'?'installWeb({root: page})':'installBabylon({scene})';
  $('action-result').textContent='Ready when you are.';update();window.dispatchEvent(new Event('resize'));
});
function runAction(intent){
  const snapshot=active.callTool('surface_observe',{});
  const plan=mode==='web'?{
    fill:{name:'Explorer name',action:'fill',arguments:{value:'Alex'}},
    select:{name:'Destination',action:'select',arguments:{value:'moon'}},
    submit:{name:'Create my pass',action:'click',arguments:{}}
  }:{focus:{name:'Moon',action:'focus',arguments:{}},highlight:{name:'Rocket',action:'highlight',arguments:{enabled:true}},clear:{name:'Rocket',action:'highlight',arguments:{enabled:false}}};
  const chosen=plan[intent],target=snapshot.targets.find(item=>item.name===chosen.name&&item.actions.includes(chosen.action));
  if(!target){$('action-result').textContent='That action is not available in the current view.';return;}
  const result=active.callTool('surface_act',{adapterId:snapshot.adapterId,id:crypto.randomUUID(),revision:snapshot.revision,target:target.ref,action:chosen.action,arguments:chosen.arguments});
  $('action-result').textContent=`${chosen.action} → ${result.status}${result.code?' · '+result.code:''}. Observe the interface for its application result.`;update();
}
for(const button of document.querySelectorAll('[data-intent]'))button.addEventListener('click',()=>runAction(button.dataset.intent));
const timer=setInterval(update,1000);update();
window.addEventListener('pagehide',event=>{if(!event.persisted){clearInterval(timer);website.dispose();game?.dispose();}});
