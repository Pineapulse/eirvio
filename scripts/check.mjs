import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, readdir, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function run(command,args,cwd=root,capture=false) {
  const result=spawnSync(command,args,{cwd,encoding:'utf8',stdio:capture?'pipe':'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr??''}`);
  return result.stdout;
}
run('npm',['test']);
run('npm',['run','typecheck']);
run('npm',['run','demo']);
const temporary=await mkdtemp(resolve(tmpdir(),'eirvio package check '));
try {
  const packed=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',temporary],root,true))[0];
  for(const file of packed.files){
    if(!/^(package\.json|README\.md|LICENSE|docs\/|packages\/(sdk\/src|core\/(src|contracts))\/)/.test(file.path))throw new Error(`Unexpected package file: ${file.path}`);
    if(file.path.endsWith('.mjs')||file.path.endsWith('.json')){
      const source=await readFile(resolve(root,file.path),'utf8');
      if(/\/Users\/|\/home\/|file:\/\//.test(source))throw new Error(`Local path in distributable: ${file.path}`);
    }
  }
  // All browser entry modules must remain independent of Node and the host/core.
  for(const name of ['index.mjs','client.mjs','events.mjs']){
    const source=await readFile(resolve(root,'packages/sdk/src',name),'utf8');
    if(/(?:from\s*|import\s*\()["'][^"']*(?:node:|core\/|host\.mjs)/.test(source))throw new Error(`Browser entry imports host-only code: ${name}`);
  }
  const consumer=resolve(temporary,'clean consumer');await mkdir(consumer);
  await writeFile(resolve(consumer,'package.json'),JSON.stringify({private:true,type:'module'}));
  run('npm',['install','--ignore-scripts','--offline','--no-audit','--no-fund',resolve(temporary,packed.filename)],consumer,true);
  await writeFile(resolve(consumer,'consumer.mjs'),`import {createEventStream,createInteractionClient} from 'eirvio';
import {createInteractionHost} from 'eirvio/host';
import {Runtime,Registry,MemoryStore} from 'eirvio/core';
if([createEventStream,createInteractionClient,createInteractionHost,Runtime,Registry,MemoryStore].some(value=>typeof value!=='function'))throw new Error('Missing public export');
const stream=createEventStream({catalog:{'test.ready':{properties:{ready:{type:'boolean'}},required:['ready']}}});
if(stream.track('test.ready',{ready:true}).cursor!==1)throw new Error('Installed SDK failed');
console.log('Clean tarball consumer passed');\n`);
  run(process.execPath,['consumer.mjs'],consumer);
  await mkdir(resolve(root,'reports'),{recursive:true});
  await writeFile(resolve(root,'reports/package.json'),JSON.stringify({status:'passed',name:packed.name,version:packed.version,files:packed.files.map(file=>file.path),integrity:packed.integrity,size:packed.size,unpackedSize:packed.unpackedSize},null,2)+'\n');
  console.log(`Package verified: ${packed.files.length} files, ${packed.size} bytes; no runtime dependencies.`);
} finally {await rm(temporary,{recursive:true,force:true});}
