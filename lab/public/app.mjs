const $=id=>document.getElementById(id);
let currentMode,renderedRun,loading=false;
const titles={testing:'A place to find what breaks.',learning:'Turn failures into better behavior.'};
const descriptions={testing:'Run isolated website, game, and engine-boundary scenarios. Every attempt starts fresh, uses the real SDK, and records evidence you can reproduce.',learning:'Replay a seeded curriculum against the published v0.3.0 engine and the current candidate. See what improved, what regressed, and which cases need attention.'};
function node(tag,text,className){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;}
function renderReport(report){
  if(!report||report.runId===renderedRun)return;renderedRun=report.runId;
  const summary=report.candidate.summary,learning=report.config.mode==='learning';
  const metrics=learning?[[report.baseline.summary.failed,'baseline failures','bad'],[summary.failed,'candidate failures',summary.failed?'bad':'good'],[report.comparison.improvements.length,'scenarios improved','good'],[report.comparison.regressions.length,'regressions',report.comparison.regressions.length?'bad':'good']]
    :[[summary.scenarios,'scenarios',''],[summary.passed,'passed attempts','good'],[summary.failed,'failed attempts',summary.failed?'bad':'good'],[summary.passRate+'%','pass rate','']];
  $('metrics').replaceChildren(...metrics.map(([value,label,style])=>{const box=node('div',undefined,'metric '+style);box.append(node('strong',String(value)),node('span',label));return box;}));
  const source=report.candidate.source;
  $('provenance').textContent=`Candidate ${source.version} · ${source.commit.slice(0,8)}${source.dirty?' + local changes':''} · seed ${report.config.seed} · ${report.config.rounds} round${report.config.rounds===1?'':'s'} · ${new Date(report.completedAt).toLocaleString()}`;
  $('download').hidden=false;$('download').href='/reports/'+report.runId+'.json';
  $('comparison').hidden=!learning;
  if(learning){const comparison=report.comparison;$('comparison').textContent=`${comparison.improvements.length} scenario${comparison.improvements.length===1?'':'s'} now pass that failed in v0.3.0. ${comparison.regressions.length} regressed; ${comparison.unresolved.length} still need work. This compares engine behavior using identical cases and seeds; any previously passing seed that now fails is flagged. This does not train a model.`;}
  const old=new Map(report.baseline?.scenarios.map(scenario=>[scenario.id,scenario])??[]);
  $('scenarios').replaceChildren(...report.candidate.scenarios.map(scenario=>{
    const details=node('details',undefined,'scenario'),title=node('summary');
    const prior=old.get(scenario.id),change=prior?.status==='failed'&&scenario.status==='passed'?'Improved':scenario.status==='passed'?'Passed':'Failed';
    title.append(node('span',scenario.kind,'kind'),node('span',scenario.title),node('span',change,'badge '+scenario.status));
    details.append(title,node('p',scenario.description),node('p',`${scenario.id} · case v${scenario.version} · ${scenario.difficulty}`));
    if(prior)details.append(node('p',`Baseline: ${prior.status}; candidate: ${scenario.status}.`));
    const evidence={...(prior?{baselineAttempts:prior.attempts}:{}),candidateAttempts:scenario.attempts};
    details.append(node('pre',JSON.stringify(evidence,null,2)));return details;
  }));
}
async function refresh(){
  if(loading)return;loading=true;
  try{
    const response=await fetch('/api/state');if(!response.ok)throw new Error('The local lab is unavailable.');const state=await response.json();
    currentMode=state.mode;document.body.classList.toggle('learning',state.mode==='learning');document.title='EIRVIO · '+state.mode+' lab';
    $('eyebrow').textContent=state.mode.toUpperCase()+' ENVIRONMENT';$('title').textContent=titles[state.mode];$('description').textContent=descriptions[state.mode];
    $('run').textContent=state.mode==='learning'?'Run comparison':'Run checks';$('run').disabled=Boolean(state.active);
    $('status').textContent=state.active?`${state.active.mode} run in progress · seed ${state.active.seed}`:'Ready · isolated local runs';
    $('error').hidden=!state.error;$('error').textContent=state.error??'';renderReport(state.latest);
    $('history').replaceChildren(...state.history.map(item=>{const li=node('li'),link=node('a',`${new Date(item.completedAt).toLocaleString()} · seed ${item.seed} · ${item.summary.passed}/${item.summary.attempts} passed`);link.href='/reports/'+item.runId+'.json';li.append(link);return li;}));
  }catch(error){$('status').textContent=error.message;$('run').disabled=true;}finally{loading=false;}
}
$('run').addEventListener('click',async()=>{
  const seed=Number($('seed').value);if(!$('seed').value||!Number.isInteger(seed)||seed<0||seed>0xffffffff){$('error').hidden=false;$('error').textContent='Choose an integer seed from 0 to 4294967295.';return;}
  $('run').disabled=true;
  try{const response=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seed})});const result=await response.json();if(!response.ok)throw new Error(result.error);await refresh();}
  catch(error){$('error').hidden=false;$('error').textContent=error.message;$('run').disabled=false;}
});
refresh();const timer=setInterval(refresh,1500);window.addEventListener('pagehide',event=>{if(!event.persisted)clearInterval(timer);});
