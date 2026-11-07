// These cases exercise internal synchronous adapter admission, not a browser,
// model, or transactional business-action implementation.
const scenario = (id,title,description,run) => Object.freeze({id:`kernel.${id}`,version:1,title,kind:'kernel',difficulty:'adversarial',description,run});
const target = state => ({targets:[{ref:'control',role:'button',name:'Synthetic control',actions:['click'],state}]});
const command = (snapshot,id='outer') => ({adapterId:snapshot.adapterId,id,revision:snapshot.revision,target:'control',action:'click',arguments:{}});

export const kernelScenarios = Object.freeze([
  scenario('preflight_reentrancy','Fence reentrant preflight actions',
    'An internal sampler or validator tries to admit another action from the same revision. Only the outer action may execute; an exact pending retry remains safe.',
    async ({assert,seed,record,createSurfaceAdapter}) => {
      const phase=seed%2?'validate':'sample';
      let adapter, request, armed=false, nested, pending, effects=0;
      const reenter=()=>{
        if(!armed)return;
        armed=false;
        pending=adapter.act(request);
        nested=adapter.act({...request,id:'nested'});
      };
      adapter=createSurfaceAdapter({kind:'app',adapterId:`kernel-reentrancy-${seed}`,
        sample:()=>{if(phase==='sample')reenter();return target({effects});},
        validate:()=>{if(phase==='validate')reenter();},
        execute:()=>{effects++;return {status:'dispatched'};}});
      try {
        request=command(adapter.observe());armed=true;
        const result=adapter.act(request);
        record('internal admission results',{phase,effects,nestedStatus:nested.status,nestedCode:nested.code??null,pendingStatus:pending.status});
        assert.equal(result.status,'dispatched');assert.equal(pending.status,'pending');
        assert.equal(nested.code,'SURFACE_BUSY');assert.equal(effects,1);
        assert.deepEqual(adapter.getOutcome('nested'),nested);
        assert.deepEqual(adapter.act(request),result);assert.equal(effects,1);
        assert.equal(adapter.isActing(),false);
      } finally {adapter.dispose();}
    }),

  scenario('preflight_disposal','Stop effects after preflight disposal',
    'An internal callback disposes the adapter during sampling or argument validation. The already-admitted request must become a retained rejection without an effect.',
    async ({assert,seed,record,createSurfaceAdapter}) => {
      const phase=seed%2?'validate':'sample';
      let adapter, armed=false, effects=0, cleanups=0;
      adapter=createSurfaceAdapter({kind:'app',adapterId:`kernel-disposal-${seed}`,
        sample:()=>{if(armed&&phase==='sample')adapter.dispose();return target({effects});},
        validate:()=>{if(phase==='validate')adapter.dispose();},
        execute:()=>{effects++;return {status:'dispatched'};}});
      adapter.onDispose(()=>cleanups++);
      try {
        const request=command(adapter.observe());armed=true;
        const result=adapter.act(request);
        record('internal disposal results',{phase,effects,cleanups,status:result.status,code:result.code??null});
        assert.equal(result.status,'rejected');assert.equal(result.code,'SURFACE_DISPOSED');
        assert.equal(effects,0);assert.equal(cleanups,1);
        assert.deepEqual(adapter.getOutcome(request.id),result);assert.deepEqual(adapter.act(request),result);
        assert.throws(()=>adapter.observe(),{code:'SURFACE_DISPOSED'});
        assert.equal(adapter.isActing(),false);
      } finally {adapter.dispose();}
    }),

  scenario('semantic_sample_key','Preserve semantic keys named sample',
    'A declared state or action-schema property named sample changes after observation. Only target.sample pose data is excluded from the semantic revision guard.',
    async ({assert,seed,record,createSurfaceAdapter}) => {
      const location=seed%2?'state':'schema';let value='before',position=0,effects=0;
      const adapter=createSurfaceAdapter({kind:'app',adapterId:`kernel-sample-key-${seed}`,
        sample:()=>({targets:[{ref:'control',role:'button',name:'Synthetic control',actions:['click'],sample:{position},
          ...(location==='state'?{state:{sample:value}}:{actionSchemas:{click:{type:'object',properties:{sample:{type:'string',enum:[value]}}}}})}]}),
        execute:()=>{effects++;return {status:'dispatched'};}});
      try {
        const before=adapter.observe();position=100+seed%100;
        assert.equal(adapter.observe().revision,before.revision);
        value='after';const after=adapter.observe(),result=adapter.act(command(before));
        record('semantic freshness results',{location,revisionBefore:before.revision,revisionAfter:after.revision,status:result.status,code:result.code??null,effects});
        assert.equal(after.revision,before.revision+1);assert.equal(result.code,'STALE_SURFACE');assert.equal(effects,0);
        assert.equal(adapter.act(command(after,'fresh')).status,'dispatched');assert.equal(effects,1);
      } finally {adapter.dispose();}
    }),

  scenario('history_resource_pages','Page large valid event histories',
    'One hundred individually valid events exceed the aggregate byte or node budget of a single reply. History must return bounded pages with complete, nonduplicated cursors.',
    async ({assert,seed,record,createSurfaceAdapter}) => {
      const payloadKind=seed%2?'bytes':'nodes',payload=payloadKind==='bytes'?'x'.repeat(15000+seed%128):Array(950).fill(0);
      const adapter=createSurfaceAdapter({kind:'app',adapterId:`kernel-history-${seed}`,
        sample:()=>target({}),execute:()=>({status:'dispatched'})});
      try {
        for(let index=0;index<100;index++)adapter.record({type:'synthetic',actor:'user',payload});
        record('valid events retained',{events:100,payloadKind});
        let page=adapter.history(),pages=1;
        assert.ok(page.events.length>0&&page.events.length<100);assert.equal(page.hasMore,true);assert.equal(page.gap,false);
        const cursors=page.events.map(event=>event.cursor),firstPageSize=page.events.length;
        while(page.hasMore){
          const previous=page.nextCursor;page=adapter.history({after:previous});pages++;
          assert.ok(page.events.length>0);assert.ok(page.nextCursor>previous);
          cursors.push(...page.events.map(event=>event.cursor));assert.ok(pages<=100);
        }
        assert.deepEqual(cursors,Array.from({length:100},(_,index)=>index+1));assert.equal(page.nextCursor,100);
        assert.equal(adapter.observe().activity.events.length,20);
        record('bounded complete pagination verified',{payloadKind,pages,firstPageSize,returnedEvents:cursors.length,lastCursor:page.nextCursor});
      } finally {adapter.dispose();}
    }),
]);
