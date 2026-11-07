import {Engine,Scene,ArcRotateCamera,HemisphericLight,Vector3,Color3,Color4,MeshBuilder,StandardMaterial} from '/vendor/babylon.mjs';
import {installBabylon} from '/sdk/babylon.mjs';

/** The scene supplies normal Babylon objects; the adapter discovers its controls. */
export function startGame(canvas) {
  const engine = new Engine(canvas,true), scene = new Scene(engine);
  scene.clearColor = new Color4(0.018,0.025,0.065,1);
  const camera = new ArcRotateCamera('Orbit camera',-Math.PI/2.1,1.18,11,Vector3.Zero(),scene);
  camera.lowerRadiusLimit = 3; camera.upperRadiusLimit = 18;
  camera.wheelPrecision = 45;
  camera.attachControl(canvas,true);
  const light = new HemisphericLight('Starlight',new Vector3(-1,2,-2),scene);
  light.intensity = 1.6;
  const material = (name, color, glow = 0) => {
    const result = new StandardMaterial(name,scene);
    result.diffuseColor = Color3.FromHexString(color);
    result.emissiveColor = result.diffuseColor.scale(glow);
    result.specularColor = new Color3(.18,.2,.3);
    return result;
  };
  const lunar = material('Lunar lavender','#a7addb',.06), dark = material('Crater shadow','#616b9f',.05);
  const silver = material('Rocket shell','#eceeff',.1), orange = material('Coral fins','#fc7e63',.2);
  const glass = material('Blue window','#5bc7f8',.6), flame = material('Engine glow','#ffc77e',1);
  const moon = MeshBuilder.CreateSphere('Moon',{diameter:2.7,segments:32},scene);
  moon.position.set(-2.15,.15,0); moon.material = lunar;
  for (const [index,x,y,z,size] of [[0,-.35,.3,-1.18,.5],[1,.5,-.3,-1.13,.33],[2,.38,.78,-.85,.4]]) {
    const crater = MeshBuilder.CreateSphere(`Moon crater ${index+1}`,{diameter:size,segments:16},scene);
    crater.parent = moon; crater.position.set(x,y,z); crater.scaling.z = .25; crater.material = dark;
  }
  const rocket = MeshBuilder.CreateLathe('Rocket',{shape:[new Vector3(0,-1.15,0),new Vector3(.42,-1.15,0),
    new Vector3(.48,-.8,0),new Vector3(.48,.55,0),new Vector3(.3,1.05,0),new Vector3(0,1.5,0)],tessellation:40,cap:3},scene);
  rocket.position.set(2.1,.15,0); rocket.rotation.z = -.18; rocket.material = silver;
  const window = MeshBuilder.CreateSphere('Rocket window',{diameter:.56,segments:20},scene);
  window.parent = rocket; window.position.set(0,.35,-.43); window.scaling.z = .25; window.material = glass;
  for (const direction of [-1,1]) {
    const fin = MeshBuilder.CreateBox(`Rocket fin ${direction<0?'left':'right'}`,{width:.5,height:.85,depth:.16},scene);
    fin.parent = rocket; fin.position.set(direction*.51,-.82,0); fin.rotation.z = direction*.32; fin.material = orange;
  }
  const exhaust = MeshBuilder.CreateCylinder('Engine flame',{height:.85,diameterTop:.3,diameterBottom:0,tessellation:20},scene);
  exhaust.parent = rocket; exhaust.position.y = -1.52; exhaust.material = flame;
  const starlight = material('Stars','#b3c6ff',1);
  for (let i=0; i<42; i++) {
    const star = MeshBuilder.CreateSphere(`Star ${i+1}`,{diameter:i%7===0?.055:.025,segments:4},scene);
    star.position.set(Math.sin(i*127.1)*9,Math.cos(i*49.7)*5,2+(i%5));
    star.material = starlight; star.isPickable = false;
  }
  const adapter = installBabylon({scene});
  let disposed = false;
  const resize = () => engine.resize();
  globalThis.addEventListener('resize',resize);
  engine.runRenderLoop(() => scene.render());
  const cleanup = (disposeScene = true) => {
    if (disposed) return;
    disposed = true;
    adapter.dispose();
    globalThis.removeEventListener('resize',resize);
    camera.detachControl();
    engine.stopRenderLoop();
    if (disposeScene) { scene.dispose(); engine.dispose(); }
    else queueMicrotask(() => engine.dispose());
  };
  scene.onDisposeObservable.add(() => cleanup(false));
  return Object.freeze({...adapter,dispose:() => cleanup()});
}
