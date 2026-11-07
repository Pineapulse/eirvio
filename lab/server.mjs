import http from 'node:http';
import {fork} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readLatest} from './baseline.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const modes=['testing','learning'];
const runId=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function createLabServers({workerTimeoutMs=60000}={}) {
  const state={active:null,errors:{testing:null,learning:null}},servers=[];
  let child=null;
  async function recent(mode) {
    const directory=resolve(root,'reports/lab',mode);
    let files;try{files=await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
    const reports=[];
    for(const file of files.filter(file=>file.endsWith('.json')&&runId.test(file.slice(0,-5)))) {
      try{const report=JSON.parse(await readFile(resolve(directory,file),'utf8'));reports.push({runId:report.runId,completedAt:report.completedAt,summary:report.candidate.summary,seed:report.config.seed});}catch{/* Ignore incomplete/unreadable historical reports. */}
    }
    return reports.sort((a,b)=>b.completedAt.localeCompare(a.completedAt)).slice(0,10);
  }
  function start(mode,seed) {
    if(state.active)return false;
    state.active={mode,seed,startedAt:new Date().toISOString()};state.errors[mode]=null;
    let process_;
    try {process_=fork(resolve(root,'lab/run.mjs'),[mode,String(seed)],{cwd:root,stdio:['ignore','ignore','pipe','ipc']});}
    catch(error){state.active=null;state.errors[mode]='The isolated worker could not start.';throw error;}
    child=process_;
    let finished=false,stderr='';
    process_.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    const timer=setTimeout(()=>{state.errors[mode]='The isolated run exceeded its time limit and was stopped. No passing result was recorded.';process_.kill('SIGKILL');},workerTimeoutMs);
    process_.on('message',message=>{if(message?.type==='complete')finished=true;if(message?.type==='failed')state.errors[mode]=String(message.message).slice(0,800);});
    process_.on('error',error=>{clearTimeout(timer);state.errors[mode]=String(error.message).slice(0,800);if(child===process_){child=null;state.active=null;}});
    process_.on('exit',()=>{clearTimeout(timer);if(!finished&&!state.errors[mode])state.errors[mode]=stderr.slice(-800)||'The isolated run ended before producing a report.';if(child===process_){child=null;state.active=null;}});
    return true;
  }
  for(const mode of modes) {
    const server=http.createServer(async(req,res)=>{
      const port=server.address()?.port,hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
      if(!hosts.includes(req.headers.host)){res.writeHead(403).end();return;}
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      const json=(status,value)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(value));
      try {
        if(req.url==='/api/state'&&req.method==='GET')return json(200,{mode,active:state.active,error:state.errors[mode],latest:await readLatest(mode),history:await recent(mode)});
        if(req.url==='/api/run'&&req.method==='POST') {
          if(!hosts.map(host=>`http://${host}`).includes(req.headers.origin)||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'This action is limited to the local lab page.'});
          let data='',length=0;for await(const chunk of req){length+=chunk.length;if(length>1024)return json(413,{error:'Request too large'});data+=chunk.toString();}
          let request;try{request=JSON.parse(data);}catch{return json(400,{error:'Invalid JSON'});}
          if(!request||Array.isArray(request)||typeof request!=='object'||Object.keys(request).some(key=>key!=='seed')||!Number.isInteger(request.seed)||request.seed<0||request.seed>0xffffffff)return json(400,{error:'Choose an integer seed from 0 to 4294967295.'});
          return start(mode,request.seed)?json(202,{started:true}):json(409,{error:'Another lab run is already active.'});
        }
        if(req.method!=='GET')return json(405,{error:'Method not allowed'});
        if(req.url?.startsWith('/reports/')) {
          const id=req.url.slice('/reports/'.length).replace(/\.json$/,'');if(!runId.test(id))return json(404,{error:'Unknown report'});
          const data=await readFile(resolve(root,'reports/lab',mode,id+'.json'),'utf8');res.setHeader('Content-Disposition',`attachment; filename="${mode}-${id}.json"`);return res.writeHead(200,{'Content-Type':'application/json'}).end(data);
        }
        const files={'/':'index.html','/app.mjs':'app.mjs','/styles.css':'styles.css'};
        if(!Object.hasOwn(files,req.url))return json(404,{error:'Not found'});
        const body=await readFile(resolve(root,'lab/public',files[req.url]));return res.writeHead(200,{'Content-Type':req.url==='/'?'text/html; charset=utf-8':req.url==='/app.mjs'?'text/javascript':'text/css'}).end(body);
      } catch(error){return json(error.code==='ENOENT'?404:500,{error:'The lab could not complete this request.'});}
    });servers.push(server);
  }
  return {testing:servers[0],learning:servers[1],stop:async()=>{child?.kill('SIGTERM');await Promise.all(servers.map(server=>new Promise(resolve=>server.listening?server.close(resolve):resolve())));}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const labs=createLabServers();
  try {
    for(const [mode,port]of [['testing',8811],['learning',8812]])await new Promise((resolve,reject)=>{labs[mode].once('error',reject);labs[mode].listen(port,'127.0.0.1',resolve);});
    console.log('Testing lab: http://127.0.0.1:8811/\nLearning lab: http://127.0.0.1:8812/\nSynthetic local scenarios only. Each run uses an isolated worker.');
    const stop=()=>labs.stop();process.on('SIGTERM',stop);process.on('SIGINT',stop);
  } catch(error){console.error(error.message);await labs.stop();process.exitCode=1;}
}
