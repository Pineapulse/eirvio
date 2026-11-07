import type {Scene} from '@babylonjs/core';
import {installBabylon} from 'eirvio/babylon';
import type {SurfaceAdapter} from 'eirvio';
declare const scene:Scene;
const adapter:SurfaceAdapter=installBabylon({scene});
adapter.observe();
// @ts-expect-error A scene must provide native observables and a mesh collection.
installBabylon({scene:{meshes:[]}});
