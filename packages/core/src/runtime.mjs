import {DomainError,fail,json,canonical,validate} from './schema.mjs';
import {digest,verifyState} from './store.mjs';

const V='0.1.0';
const terminal=new Set(['completed','canceled','failed','degraded']);
const contains=(xs,x)=>Array.isArray(xs)&&xs.includes(x);
const has=(o,k)=>Object.hasOwn(o,k);
const stepIdentity=(sequenceId,stepId)=>`${encodeURIComponent(sequenceId)}/${encodeURIComponent(stepId)}`;
function auth(state,ctx,checks={}) {
  if(!ctx || ctx.runtimeId!==state.runtimeId) fail('FORBIDDEN');
  if(ctx.admin===true) return;
  for(const [permission,value] of Object.entries(checks)) {
    if(value===undefined) continue;
    if(value===true ? ctx[permission]!==true : !contains(ctx[permission],value)) fail('FORBIDDEN');
  }
}
function viewValue(v) { return {viewId:v.viewId,viewEpoch:v.viewEpoch,interactionRevision:v.interactionRevision}; }
function scopedAuth(sceneId,scopeId,other={}) {return {scenes:sceneId,scopes:scopeId,...other};}
function outcome(id,status,cursor,extra={}) {return {protocolVersion:V,operationId:id,status,eventCursor:cursor,...extra};}
function checkView(s,view,sceneId) {
  if(!view) return;
  const current=s.views[view.viewId];
  if(!current || current.sceneId!==sceneId || canonical(viewValue(current))!==canonical(view)) fail('STALE_INTERACTION');
}
function checkGuards(s,sceneId,g,checkRevision=true) {
  if(s.closed) fail('SESSION_CLOSED');
  if(g.runtimeFence!==s.runtimeFence) fail('STALE_RUNTIME');
  const scope=s.scopes[g.scopeId];
  if(!scope) fail('FORBIDDEN');
  if(scope.status!=='active') fail('SCOPE_CLOSED');
  if(scope.epoch!==g.scopeEpoch) fail('SUPERSEDED_SCOPE');
  const scene=s.scenes[sceneId];
  if(!scene) fail('UNKNOWN_SCENE');
  checkView(s,g.view,sceneId);
  if(checkRevision && scene.sceneRevision!==g.expectedSceneRevision) fail('STATE_CONFLICT');
  return scene;
}

export class Runtime {
  #registry; #store; #writerFence; #busy=false;
  constructor(registry,store) {this.#registry=registry;this.#store=store;this.#writerFence=store.read().runtimeFence;}
  static create(spec,registry,store) {
    const x=json(spec);
    if(typeof x.runtimeId!=='string'||!x.runtimeId||typeof x.runtimeFence!=='string'||!x.runtimeFence||!Array.isArray(x.scenes)||!x.scenes.length||x.scenes.length>8||!Array.isArray(x.scopes)||!x.scopes.length||x.scopes.length>16) fail('INVALID_SCHEMA');
    const s={protocolVersion:V,snapshotSchemaVersion:'1',runtimeId:x.runtimeId,runtimeFence:x.runtimeFence,usedFences:[x.runtimeFence],eventCursor:0,controlRevision:0,logicalTick:0,closed:false,scenes:{},scopes:{},views:{},outcomes:{},sequences:{},effects:{},receipts:{}};
    validate('id',x.runtimeId);validate('id',x.runtimeFence);
    for(const scene of x.scenes) {
      validate('scene',scene); if(scene.sceneRevision!==0||has(s.scenes,scene.sceneId)) fail('INVALID_SCHEMA'); s.scenes[scene.sceneId]=scene;
    }
    for(const id of x.scopes) {validate('id',id);if(has(s.scopes,id)) fail('INVALID_SCHEMA');s.scopes[id]={epoch:0,status:'active'};}
    for(const v of x.views??[]) {
      validate('view',viewValue(v));if(!has(s.scenes,v.sceneId)||has(s.views,v.viewId)) fail('INVALID_SCHEMA');s.views[v.viewId]=v;
    }
    verifyState(s,registry);store.initialize(s);return new Runtime(registry,store);
  }
  #commit(before,next,type,data) {
    if(this.#writerFence!==before.runtimeFence) fail('STALE_WRITER');
    if(this.#store.recoveryRequired && !type.startsWith('control.'))fail('RECOVERY_REQUIRED');
    next.eventCursor=before.eventCursor+1;
    this.#store.commit(before.eventCursor,this.#writerFence,next,{type,data});
  }
  #exclusive(fn) {
    if(this.#busy) fail('REENTRANT_WRITE');
    this.#busy=true;try{return fn();}finally{this.#busy=false;}
  }
  #mutation(schema,payload,idField,ctx,checks,fn) {
    return this.#exclusive(()=>{
      const p=validate(schema,payload),before=this.#store.read(),id=p[idField];
      if(p.runtimeId!==before.runtimeId) fail('FORBIDDEN');
      auth(before,ctx,typeof checks==='function'?checks(before,p):checks);
      const fingerprint=digest({schema,payload:p}),existing=before.outcomes[id];
      if(existing) {
        if(existing.fingerprint!==fingerprint) return outcome(id,'rejected',before.eventCursor,{code:'DUPLICATE_ID_MISMATCH'});
        return json(existing.outcome);
      }
      if(this.#writerFence!==before.runtimeFence) fail('STALE_WRITER');
      if(this.#store.recoveryRequired && !(schema==='control'&&p.action==='recover'))fail('RECOVERY_REQUIRED');
      let next=json(before),result;
      try { result=fn(next,p,before.eventCursor+1);validate('outcome',result); }
      catch(e) {
        if(!(e instanceof DomainError)) throw e;
        next=json(before);result=outcome(id,'rejected',before.eventCursor+1,{code:e.code});
      }
      next.outcomes[id]={fingerprint,outcome:result,access:typeof checks==='function'?checks(before,p):checks};
      this.#commit(before,next,`${schema}.${result.status}`,{operationId:id,status:result.status,...(result.code?{code:result.code}:{})});
      if(schema==='control' && p.action==='recover' && result.status==='committed') this.#writerFence=next.runtimeFence;
      return json(result);
    });
  }
  observe(sceneId,scopeId,ctx,viewId) {
    validate('id',sceneId);validate('id',scopeId);if(viewId!==undefined)validate('id',viewId);
    const s=this.#store.read();auth(s,ctx,scopedAuth(sceneId,scopeId,{observe:true}));
    const scene=s.scenes[sceneId],scope=s.scopes[scopeId];if(!scene||!scope) fail('UNKNOWN_SCENE');
    const rule=this.#registry.get(scene.ruleset),projection=json(rule.project(json(scene.state),ctx.audience??'public'));
    const o={protocolVersion:V,observationId:`obs/${digest({runtimeId:s.runtimeId,cursor:s.eventCursor,sceneId,scopeId,viewId:viewId??null,audience:ctx.audience??'public'}).slice(0,32)}`,runtimeId:s.runtimeId,sceneId,sceneKind:scene.kind,sceneRevision:scene.sceneRevision,runtimeFence:s.runtimeFence,controlRevision:s.controlRevision,scope:{id:scopeId,...scope},eventCursor:s.eventCursor,projection,capabilities:Object.keys(rule.operations).filter(op=>ctx.admin||contains(ctx.operations,op)),partial:true};
    if(viewId!==undefined) {const v=s.views[viewId];if(!v||v.sceneId!==sceneId)fail('STALE_INTERACTION');o.view=viewValue(v);}
    return validate('observation',o);
  }
  #applyCommand(s,p,cursor,ctx) {
    auth(s,ctx,scopedAuth(p.target.sceneId,p.guards.scopeId,{operations:p.operation}));
    const scene=checkGuards(s,p.target.sceneId,p.guards),rule=this.#registry.get(scene.ruleset),op=rule.operations[p.operation];
    if(!op)fail('UNKNOWN_OPERATION');
    if(op.validate(json(p.arguments))!==true)fail('INVALID_SCHEMA');
    const result=json(op.apply(json(scene.state),json(p.arguments),json(p.target)));
    if(!result.state||!result.result||rule.validateState(json(result.state))!==true)fail('RULE_VIOLATION');
    const previousRevision=scene.sceneRevision;
    const committed=validate('outcome',outcome(p.commandId,'committed',cursor,{sceneId:scene.sceneId,previousRevision,sceneRevision:scene.sceneRevision+1,result:result.result}));
    scene.state=result.state;scene.sceneRevision++;
    return committed;
  }
  submit(command,ctx) {
    return this.#mutation('command',command,'commandId',ctx,(_,p)=>scopedAuth(p.target.sceneId,p.guards.scopeId,{operations:p.operation}),
      (s,p,cursor)=>this.#applyCommand(s,p,cursor,ctx));
  }
  submitSequence(plan,ctx) {
    return this.#mutation('sequence',plan,'sequenceId',ctx,(_,p)=>scopedAuth(p.sceneId,p.guards.scopeId), (s,p,cursor)=>{
      checkGuards(s,p.sceneId,p.guards);
      const seen=new Map();
      for(let i=0;i<p.steps.length;i++) {
        const step=p.steps[i];if(seen.has(step.id)) fail('INVALID_SCHEMA');
        validate('id',stepIdentity(p.sequenceId,step.id));
        if(step.kind==='invoke'||step.kind==='effect') {
          if(has(step,'expectedRevision')===has(step,'revisionFromStep'))fail('INVALID_SCHEMA');
          if(step.revisionFromStep && seen.get(step.revisionFromStep)!=='invoke')fail('INVALID_SCHEMA');
          if(step.kind==='invoke') {
            auth(s,ctx,{operations:step.operation});
            const op=this.#registry.get(s.scenes[p.sceneId].ruleset).operations[step.operation];
            if(!op)fail('UNKNOWN_OPERATION');if(op.validate(json(step.arguments))!==true)fail('INVALID_SCHEMA');
          } else {auth(s,ctx,{effects:step.effectKind});this.#registry.checkEffect(step.effectKind,json(step.parameters));}
        }
        if(step.kind==='wait' && seen.get(step.effectStepId)!=='effect') fail('INVALID_SCHEMA');
        if(step.kind==='finish' && i!==p.steps.length-1)fail('INVALID_SCHEMA');
        seen.set(step.id,step.kind);
      }
      s.sequences[p.sequenceId]={sequenceId:p.sequenceId,plan:p,status:'admitted',index:0,results:{},wait:null};
      return outcome(p.sequenceId,'admitted',cursor);
    });
  }
  advance(sequenceId,ctx) {
    validate('id',sequenceId);
    return this.#exclusive(()=>{
      const before=this.#store.read(),original=before.sequences[sequenceId];if(!original)fail('UNKNOWN_SEQUENCE');
      auth(before,ctx,scopedAuth(original.plan.sceneId,original.plan.guards.scopeId));
      if(terminal.has(original.status))return json(original);
      const next=json(before),seq=next.sequences[sequenceId],p=seq.plan,step=p.steps[seq.index],cursor=before.eventCursor+1;
      try {
        checkGuards(next,p.sceneId,p.guards,false);
        if(!step)seq.status='completed';
        else if(step.kind==='invoke') {
          const expected=step.expectedRevision??seq.results[step.revisionFromStep]?.sceneRevision;
          const cmd={protocolVersion:V,commandId:stepIdentity(sequenceId,step.id),runtimeId:p.runtimeId,target:{sceneId:p.sceneId,...(step.objectId?{objectId:step.objectId}:{})},operation:step.operation,arguments:step.arguments,guards:{...p.guards,expectedSceneRevision:expected}};
          validate('command',cmd);
          const fingerprint=digest({schema:'command',payload:cmd});
          if(next.outcomes[cmd.commandId])fail('DUPLICATE_ID_MISMATCH');
          let result;
          try { result=this.#applyCommand(next,cmd,cursor,ctx); }
          catch(e) {if(!(e instanceof DomainError))throw e;result=outcome(cmd.commandId,'rejected',cursor,{code:e.code});}
          next.outcomes[cmd.commandId]={fingerprint,outcome:result,access:scopedAuth(p.sceneId,p.guards.scopeId,{operations:step.operation})};
          seq.results[step.id]=result;
          if(result.status!=='committed'){seq.status='failed';seq.code=result.code;}else seq.index++;
        } else if(step.kind==='effect') {
          auth(next,ctx,{effects:step.effectKind});this.#registry.checkEffect(step.effectKind,json(step.parameters));
          const revision=step.expectedRevision??seq.results[step.revisionFromStep]?.sceneRevision;
          checkGuards(next,p.sceneId,{...p.guards,expectedSceneRevision:revision});
          const effectId=stepIdentity(sequenceId,step.id);
          if(has(next.effects,effectId))fail('DUPLICATE_ID_MISMATCH');
          next.effects[effectId]={protocolVersion:V,effectId,runtimeId:p.runtimeId,sequenceId,stepId:step.id,sceneId:p.sceneId,sceneRevision:revision,runtimeFence:p.guards.runtimeFence,scopeId:p.guards.scopeId,scopeEpoch:p.guards.scopeEpoch,...(p.guards.view?{view:p.guards.view}:{}),kind:step.effectKind,parameters:step.parameters,status:'pending',system:false};
          seq.results[step.id]={effectId};seq.index++;
        } else if(step.kind==='wait') {
          const effectId=seq.results[step.effectStepId].effectId,effect=next.effects[effectId];
          checkGuards(next,effect.sceneId,{runtimeFence:effect.runtimeFence,expectedSceneRevision:effect.sceneRevision,scopeId:effect.scopeId,scopeEpoch:effect.scopeEpoch,...(effect.view?{view:effect.view}:{})});
          const receipt=next.receipts[effectId]?.[step.layer];
          if(receipt) {
            seq.results[step.id]={receiptId:receipt.receiptId,status:receipt.status};seq.wait=null;
            if(receipt.status==='completed')seq.index++;
            else {seq.status=receipt.status==='canceled'?'canceled':'degraded';seq.code='DELIVERY_'+receipt.status.toUpperCase();}
          } else {
            if(!seq.wait)seq.wait={effectId,layer:step.layer,deadline:next.logicalTick+step.timeoutTicks};
            if(next.logicalTick>=seq.wait.deadline){seq.status=step.timeoutPolicy==='fail'?'failed':'degraded';seq.code='DEADLINE_EXCEEDED';seq.wait=null;}
            else seq.status='waiting';
          }
        } else {seq.index++;seq.status='completed';}
        if(!terminal.has(seq.status)&&seq.status!=='waiting')seq.status=seq.index>=p.steps.length?'completed':'running';
        if(seq.status==='waiting'&&!seq.wait)seq.status=seq.index>=p.steps.length?'completed':'running';
      } catch(e) {if(!(e instanceof DomainError))throw e;seq.status=['SUPERSEDED_SCOPE','SCOPE_CLOSED','SESSION_CLOSED','STALE_RUNTIME'].includes(e.code)?'canceled':'failed';seq.code=e.code;seq.wait=null;}
      if(terminal.has(seq.status)&&seq.status!=='completed')for(const effect of Object.values(next.effects))if(effect.sequenceId===sequenceId)effect.status='canceled';
      this.#commit(before,next,`sequence.${seq.status}`,{sequenceId,stepId:step?.id??'end',status:seq.status});
      return json(seq);
    });
  }
  #cancelScope(s,scopeId,close,operationId,canceledRuntimeFence=s.runtimeFence) {
    const scope=s.scopes[scopeId],oldEpoch=scope.epoch;
    scope.epoch++;if(close)scope.status='closed';
    for(const seq of Object.values(s.sequences)) if(seq.plan.guards.scopeId===scopeId&&!terminal.has(seq.status)){seq.status='canceled';seq.code=close?'SCOPE_CLOSED':'SUPERSEDED_SCOPE';seq.wait=null;}
    for(const effect of Object.values(s.effects))if(effect.scopeId===scopeId&&!effect.system)effect.status='canceled';
    const sceneId=Object.keys(s.scenes)[0],effectId=`runtime.stop.${digest({operationId,scopeId}).slice(0,32)}`;
    s.effects[effectId]={protocolVersion:V,effectId,runtimeId:s.runtimeId,sceneId,sceneRevision:s.scenes[sceneId].sceneRevision,runtimeFence:s.runtimeFence,scopeId,scopeEpoch:scope.epoch,kind:'runtime.stop',parameters:{canceledRuntimeFence,canceledScopeId:scopeId,canceledEpoch:oldEpoch},status:'pending',system:true};
  }
  control(envelope,ctx) {
    return this.#mutation('control',envelope,'operationId',ctx,(_,p)=>({controls:p.action,...(p.scopeId?{scopes:p.scopeId}:{}),...(p.sceneId?{scenes:p.sceneId}:{}),...(p.sourceSceneId?{scenes:p.sourceSceneId}:{})}), (s,p,cursor)=>{
      if(p.runtimeFence!==s.runtimeFence)fail('STALE_RUNTIME');
      if(p.expectedControlRevision!==s.controlRevision)fail('CONTROL_CONFLICT');
      if(s.closed && p.action!=='recover')fail('SESSION_CLOSED');
      if(['end','recover','tick','forkScene','bindView'].includes(p.action) && !ctx.admin)fail('FORBIDDEN');
      let result={};
      if(p.action==='interrupt'||p.action==='closeScope') {
        if(!p.scopeId||!Number.isSafeInteger(p.scopeEpoch))fail('INVALID_SCHEMA');
        const scope=s.scopes[p.scopeId];if(!scope)fail('FORBIDDEN');if(scope.status==='closed')fail('SCOPE_CLOSED');if(scope.epoch!==p.scopeEpoch)fail('SUPERSEDED_SCOPE');
        this.#cancelScope(s,p.scopeId,p.action==='closeScope',p.operationId);result={scopeId:p.scopeId,scopeEpoch:s.scopes[p.scopeId].epoch};
      } else if(p.action==='end') {
        for(const id of Object.keys(s.scopes))this.#cancelScope(s,id,true,p.operationId);s.closed=true;
      } else if(p.action==='recover') {
        if(!p.newRuntimeFence||s.usedFences.includes(p.newRuntimeFence))fail('INVALID_SCHEMA');
        for(const effect of Object.values(s.effects))effect.status='canceled';
        const canceledRuntimeFence=s.runtimeFence;s.runtimeFence=p.newRuntimeFence;s.usedFences.push(p.newRuntimeFence);
        for(const id of Object.keys(s.scopes))this.#cancelScope(s,id,s.scopes[id].status==='closed',p.operationId,canceledRuntimeFence);
        result={runtimeFence:s.runtimeFence};
      } else if(p.action==='forkScene') {
        if(!p.sceneId||!p.sourceSceneId||!has(p,'sourceRevision')||!p.sceneKind)fail('INVALID_SCHEMA');
        if(has(s.scenes,p.sceneId))fail('SCENE_EXISTS');if(Object.keys(s.scenes).length>=8)fail('RESOURCE_LIMIT');
        const source=s.scenes[p.sourceSceneId];if(!source)fail('UNKNOWN_SCENE');if(source.sceneRevision!==p.sourceRevision)fail('STATE_CONFLICT');
        s.scenes[p.sceneId]={...json(source),sceneId:p.sceneId,kind:p.sceneKind,sceneRevision:0,lineage:{sourceSceneId:p.sourceSceneId,sourceRevision:p.sourceRevision}};
        result={sceneId:p.sceneId};
      } else if(p.action==='bindView') {
        if(!p.view||!p.sceneId||!s.scenes[p.sceneId])fail('INVALID_SCHEMA');
        const old=s.views[p.view.viewId];
        if(old&&(p.view.interactionRevision<=old.interactionRevision||p.view.viewEpoch<old.viewEpoch||(p.sceneId!==old.sceneId&&p.view.viewEpoch<=old.viewEpoch)))fail('STALE_INTERACTION');
        if(!old&&(p.view.viewEpoch!==0||p.view.interactionRevision!==0))fail('INVALID_SCHEMA');
        s.views[p.view.viewId]={...p.view,sceneId:p.sceneId};
      } else if(p.action==='tick') {
        if(!p.ticks)fail('INVALID_SCHEMA');s.logicalTick+=p.ticks;
        for(const seq of Object.values(s.sequences)) {
          if(seq.status!=='waiting'||!seq.wait||seq.wait.deadline>s.logicalTick||s.receipts[seq.wait.effectId]?.[seq.wait.layer])continue;
          const step=seq.plan.steps[seq.index];seq.status=step.timeoutPolicy==='fail'?'failed':'degraded';seq.code='DEADLINE_EXCEEDED';seq.wait=null;
          for(const effect of Object.values(s.effects))if(effect.sequenceId===seq.sequenceId)effect.status='canceled';
        }
      }
      s.controlRevision++;
      return outcome(p.operationId,'committed',cursor,{result:{...result,controlRevision:s.controlRevision}});
    });
  }
  claimEffect(effectId,ctx) {
    validate('id',effectId);
    return this.#exclusive(()=>{
      const before=this.#store.read(),effect=before.effects[effectId];if(!effect)fail('UNKNOWN_EFFECT');
      auth(before,ctx,scopedAuth(effect.sceneId,effect.scopeId,{dispatch:true,effects:effect.kind}));
      if(effect.status!=='pending')return null;
      const next=json(before),e=next.effects[effectId];
      try {
        if(e.system) {if(e.runtimeFence!==next.runtimeFence)fail('STALE_RUNTIME');}
        else checkGuards(next,e.sceneId,{runtimeFence:e.runtimeFence,expectedSceneRevision:e.sceneRevision,scopeId:e.scopeId,scopeEpoch:e.scopeEpoch,...(e.view?{view:e.view}:{})});
        e.status='dispatched';
      } catch(err) {if(!(err instanceof DomainError))throw err;e.status='canceled';}
      this.#commit(before,next,`effect.${e.status}`,{effectId});
      return e.status==='dispatched'?json(e):null;
    });
  }
  receiveReceipt(receipt,ctx) {
    return this.#mutation('receipt',receipt,'receiptId',ctx,(_,p)=>scopedAuth(p.sceneId,p.scopeId,{receipts:true}), (s,p,cursor)=>{
      const e=s.effects[p.effectId];if(!e||e.system)fail('UNKNOWN_EFFECT');
      if(e.sceneId!==p.sceneId||e.sceneRevision!==p.sceneRevision||e.runtimeFence!==p.runtimeFence||e.scopeId!==p.scopeId||e.scopeEpoch!==p.scopeEpoch||canonical(e.view??null)!==canonical(p.view??null))fail('RECEIPT_CONTEXT_MISMATCH');
      checkGuards(s,p.sceneId,{runtimeFence:p.runtimeFence,expectedSceneRevision:p.sceneRevision,scopeId:p.scopeId,scopeEpoch:p.scopeEpoch,...(p.view?{view:p.view}:{})});
      if(e.status!=='dispatched')fail('EFFECT_NOT_DISPATCHED');
      const previous=s.receipts[p.effectId]?.[p.layer];
      if(previous) {
        const {receiptId:ignored1,...a}=previous,{receiptId:ignored2,...b}=p;
        if(canonical(a)!==canonical(b))fail('RECEIPT_CONFLICT');
      } else {s.receipts[p.effectId]??={};s.receipts[p.effectId][p.layer]=p;}
      return outcome(p.receiptId,'completed',cursor,{result:{effectId:p.effectId,layer:p.layer,status:p.status}});
    });
  }
  getOutcome(id,ctx) {
    validate('id',id);
    const s=this.#store.read();auth(s,ctx,{inspect:true});
    const record=s.outcomes[id];if(!record)fail('OUTCOME_UNKNOWN');auth(s,ctx,record.access);return json(record.outcome);
  }
  getSequence(id,ctx) {
    validate('id',id);
    const s=this.#store.read(),seq=s.sequences[id];auth(s,ctx,{inspect:true});if(!seq)fail('UNKNOWN_SEQUENCE');auth(s,ctx,scopedAuth(seq.plan.sceneId,seq.plan.guards.scopeId));return json(seq);
  }
  snapshot(ctx) {const s=this.#store.read();auth(s,ctx);if(!ctx.admin)fail('FORBIDDEN');return s;}
  exportReplay(ctx) {const s=this.#store.read();auth(s,ctx);if(!ctx.admin)fail('FORBIDDEN');return this.#store.exportReplay();}
}
