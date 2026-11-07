import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,rename,mkdtemp,readFile,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export const RELEASE_BASELINE = Object.freeze({version:'0.3.0',ref:'v0.3.0',commit:'1bfad18b9b3af3671c6933e6eba143c146797b22'});
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function loadBaseline() {
  // Fixed, previously published source only. No checkout changes, package install,
  // remote code fetch, shell interpolation or caller-selected Git revision.
  const actual=execFileSync('git',['rev-parse',`${RELEASE_BASELINE.ref}^{commit}`],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(actual!==RELEASE_BASELINE.commit)throw new Error('The v0.3.0 baseline tag does not match the recorded release commit');
  const directory=await mkdtemp(join(tmpdir(),'eirvio-baseline-'));
  try {
    for(const name of ['web.mjs','babylon.mjs','surface.mjs','events.mjs']) {
      const contents=execFileSync('git',['show',`${actual}:packages/sdk/src/${name}`],{cwd:root,encoding:'utf8',maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
      await writeFile(join(directory,name),contents);
    }
    const [{installWeb},{installBabylon},{createSurfaceAdapter}]=await Promise.all([import(pathToFileURL(join(directory,'web.mjs'))),import(pathToFileURL(join(directory,'babylon.mjs'))),import(pathToFileURL(join(directory,'surface.mjs')))]);
    return {adapters:{installWeb,installBabylon,createSurfaceAdapter},source:{...RELEASE_BASELINE,dirty:false},dispose:()=>rm(directory,{recursive:true,force:true})};
  } catch(error) {await rm(directory,{recursive:true,force:true});throw error;}
}
export function candidateSource() {
  const metadata=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
  const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const dirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:root,encoding:'utf8'}).trim().length>0;
  const sourceHashes=Object.fromEntries(['web.mjs','babylon.mjs','surface.mjs','events.mjs'].map(name=>[name,createHash('sha256').update(readFileSync(resolve(root,'packages/sdk/src',name))).digest('hex')]));
  return {version:metadata.version,commit,dirty,sourceHashes};
}
export async function saveReport(report) {
  const directory=resolve(root,'reports/lab',report.config.mode);await mkdir(directory,{recursive:true});
  const filename=report.runId+'.json', temporary=join(directory,filename+'.tmp');
  const data=JSON.stringify(report,null,2)+'\n';
  await writeFile(temporary,data);await rename(temporary,join(directory,filename));
  const latest=join(directory,report.runId+'.latest.tmp');await writeFile(latest,data);await rename(latest,join(directory,'latest.json'));
  return join(directory,filename);
}
export async function readLatest(mode) {
  if(!['testing','learning'].includes(mode))throw new Error('Invalid lab mode');
  try{return JSON.parse(await readFile(resolve(root,'reports/lab',mode,'latest.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
