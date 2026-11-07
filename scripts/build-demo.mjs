import {build} from 'esbuild';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await build({stdin:{contents:"export {Engine,Scene,ArcRotateCamera,HemisphericLight,Vector3,Color3,Color4,MeshBuilder,StandardMaterial} from '@babylonjs/core';",resolveDir:root},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,outfile:resolve(root,'reports/babylon.mjs')});
console.log('Local Babylon demo bundle ready. The SDK has no runtime dependencies.');
