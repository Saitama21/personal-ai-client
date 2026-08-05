import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { AxisState, CameraView, MachineMode, MotionMode, StockSettings } from '../core/types';

interface Props { axes: AxisState; mode: MachineMode; motion:MotionMode; tool: number; spindleOn: boolean; rpm:number; stock:StockSettings; cameraView:CameraView; danger:boolean; }

function disposeObject(root: THREE.Object3D){
  root.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();const m=o.material;Array.isArray(m)?m.forEach(x=>x.dispose()):m.dispose();}});
}

export default function MachineScene({ axes, mode, motion, tool, spindleOn, rpm, stock, cameraView, danger }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const state = useRef({ axes, mode, motion, tool, spindleOn, rpm, stock, cameraView, danger });
  state.current = { axes, mode, motion, tool, spindleOn, rpm, stock, cameraView, danger };

  useEffect(() => {
    if (!mount.current) return;
    const host = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06101c);
    scene.fog = new THREE.Fog(0x06101c, 13, 28);

    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(8.8, 5.8, 12.8);
    camera.lookAt(0, 0.15, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha:false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xb9d7ff, 0x0b1118, 1.7));
    const key = new THREE.DirectionalLight(0xffffff, 3.8); key.position.set(5, 9, 7); key.castShadow=true; scene.add(key);
    const fill = new THREE.PointLight(0x4f9fff, 40, 22); fill.position.set(-5,2,-5); scene.add(fill);
    const warm = new THREE.PointLight(0xffca78, 22, 14); warm.position.set(4,3,4); scene.add(warm);

    const floorMat=new THREE.MeshStandardMaterial({color:0x0b1723,roughness:.92,metalness:.1});
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(26,15),floorMat);floor.rotation.x=-Math.PI/2;floor.position.y=-2.45;floor.receiveShadow=true;scene.add(floor);
    const back=new THREE.Mesh(new THREE.PlaneGeometry(25,10),new THREE.MeshStandardMaterial({color:0x0a1520,roughness:.8}));back.position.set(0,2,-4.4);scene.add(back);

    const metal=new THREE.MeshStandardMaterial({color:0x8795a5,metalness:.88,roughness:.25});
    const dark=new THREE.MeshStandardMaterial({color:0x242d37,metalness:.92,roughness:.28});
    const black=new THREE.MeshStandardMaterial({color:0x10161d,metalness:.75,roughness:.38});
    const stockMat=new THREE.MeshStandardMaterial({color:0xbcc6d0,metalness:.72,roughness:.22});
    const accent=new THREE.MeshStandardMaterial({color:0xf4c84f,metalness:.45,roughness:.3,emissive:0x4a3100});

    const machine=new THREE.Group();scene.add(machine);
    const enclosure=new THREE.Mesh(new THREE.BoxGeometry(13,6.2,.35),black);enclosure.position.set(0,.45,-3.8);enclosure.receiveShadow=true;machine.add(enclosure);
    const bed=new THREE.Mesh(new THREE.BoxGeometry(12.8,.65,4.2),dark);bed.position.set(0,-2.0,0);bed.castShadow=true;bed.receiveShadow=true;machine.add(bed);

    const spindleGroup=new THREE.Group();spindleGroup.position.x=-4.25;machine.add(spindleGroup);
    const spindleHousing=new THREE.Mesh(new THREE.CylinderGeometry(2.2,2.2,1.45,64),black);spindleHousing.rotation.z=Math.PI/2;spindleHousing.castShadow=true;spindleGroup.add(spindleHousing);
    const chuck=new THREE.Group();chuck.position.x=.85;spindleGroup.add(chuck);
    const chuckBody=new THREE.Mesh(new THREE.CylinderGeometry(1.72,1.72,1.15,64),dark);chuckBody.rotation.z=Math.PI/2;chuckBody.castShadow=true;chuck.add(chuckBody);
    const chuckFace=new THREE.Mesh(new THREE.CylinderGeometry(1.48,1.48,.08,64),metal);chuckFace.rotation.z=Math.PI/2;chuckFace.position.x=.61;chuck.add(chuckFace);
    for(let i=0;i<3;i++){
      const a=i*Math.PI*2/3;
      const jawGroup=new THREE.Group();jawGroup.rotation.x=a;chuck.add(jawGroup);
      const jawBase=new THREE.Mesh(new THREE.BoxGeometry(.8,.48,.82),metal);jawBase.position.set(.78,.92,0);jawBase.castShadow=true;jawGroup.add(jawBase);
      const jawTop=new THREE.Mesh(new THREE.BoxGeometry(.58,.36,.58),dark);jawTop.position.set(1.0,.56,0);jawTop.castShadow=true;jawGroup.add(jawTop);
    }

    const stockGroup=new THREE.Group();machine.add(stockGroup);
    let stockMesh:THREE.Mesh | null=null;
    const rebuildStock=(d:number,l:number)=>{
      if(stockMesh){stockGroup.remove(stockMesh);stockMesh.geometry.dispose();}
      const radius=THREE.MathUtils.clamp(d/60,0.45,1.55);
      const length=THREE.MathUtils.clamp(l/120*5.7,2.2,8.2);
      stockMesh=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,length,72),stockMat);
      stockMesh.rotation.z=Math.PI/2;stockMesh.position.x=-2.72+length/2;stockMesh.castShadow=true;stockGroup.add(stockMesh);
    };
    rebuildStock(stock.diameter,stock.length);

    const carriage=new THREE.Group();machine.add(carriage);
    const slideZ=new THREE.Mesh(new THREE.BoxGeometry(4.2,.55,3.4),black);slideZ.position.set(3.4,-1.55,0);slideZ.castShadow=true;carriage.add(slideZ);
    const turret=new THREE.Group();turret.position.set(4.2,.2,0);carriage.add(turret);
    const turretDisc=new THREE.Mesh(new THREE.CylinderGeometry(1.82,1.82,1.05,15),dark);turretDisc.rotation.z=Math.PI/2;turretDisc.castShadow=true;turret.add(turretDisc);
    const turretFace=new THREE.Mesh(new THREE.CylinderGeometry(1.5,1.5,.06,64),metal);turretFace.rotation.z=Math.PI/2;turretFace.position.x=-.55;turret.add(turretFace);
    const holders:THREE.Group[]=[];
    for(let i=0;i<15;i++){
      const a=i*Math.PI*2/15;
      const holderGroup=new THREE.Group();holderGroup.rotation.x=a;turret.add(holderGroup);holders.push(holderGroup);
      const block=new THREE.Mesh(new THREE.BoxGeometry(.78,.32,.42),i===0?metal:dark);block.position.set(-.74,1.72,0);block.castShadow=true;holderGroup.add(block);
      const slot=new THREE.Mesh(new THREE.BoxGeometry(.32,.18,.2),black);slot.position.set(-1.22,1.72,0);holderGroup.add(slot);
    }
    const activeTool=new THREE.Group();turret.add(activeTool);
    const shank=new THREE.Mesh(new THREE.BoxGeometry(1.75,.34,.42),metal);shank.position.set(-1.45,0,0);shank.castShadow=true;activeTool.add(shank);
    const insert=new THREE.Mesh(new THREE.ConeGeometry(.25,.5,3),accent);insert.rotation.z=-Math.PI/2;insert.position.x=-2.52;insert.castShadow=true;activeTool.add(insert);

    const labels=new THREE.Group();scene.add(labels);
    const xLine=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,-1.8,2.5),new THREE.Vector3(0,1.5,2.5)]),new THREE.LineBasicMaterial({color:0xff6e6e}));labels.add(xLine);
    const zLine=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-4.8,-1.55,2.5),new THREE.Vector3(4.8,-1.55,2.5)]),new THREE.LineBasicMaterial({color:0x58a5ff}));labels.add(zLine);

    const targetCamera=new THREE.Vector3(8.8,5.8,12.8);
    let currentToolAngle=0;
    let targetToolAngle=0;
    let lastD=stock.diameter,lastL=stock.length;
    let frame=0;
    const resize=()=>{const w=Math.max(host.clientWidth,1),h=Math.max(host.clientHeight,1);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();};
    const ro=new ResizeObserver(resize);ro.observe(host);resize();
    const animate=()=>{
      frame=requestAnimationFrame(animate);
      const s=state.current;
      if(s.stock.diameter!==lastD||s.stock.length!==lastL){lastD=s.stock.diameter;lastL=s.stock.length;rebuildStock(lastD,lastL);}
      const views:Record<CameraView,[number,number,number]>={iso:[8.8,5.8,12.8],front:[8.8,.4,12.8],top:[.5,15,.5],sinumerik:[10.8,3.5,14.8]};
      targetCamera.set(...views[s.cameraView]);
      camera.position.lerp(targetCamera,.08);camera.lookAt(0,.1,0);
      const speed=Math.min(Math.max(s.rpm,0)/800,2.2)*.045;
      if(s.spindleOn){chuck.rotation.x+=speed;if(stockMesh)stockMesh.rotation.x+=speed;}
      const zTarget=4.15+(s.axes.z-20)*.035;
      const xTarget=.2+(70-s.axes.x)*.027;
      const lerpRate=s.motion==='rapid'?.17:.07;
      turret.position.x+= (zTarget-turret.position.x)*lerpRate;
      turret.position.y+= (xTarget-turret.position.y)*lerpRate;
      turret.position.z+= ((s.mode==='milling'?s.axes.y*.035:0)-turret.position.z)*lerpRate;
      accent.color.setHex(s.danger?0xff4d4d:0xf4c84f);accent.emissive.setHex(s.danger?0x7a0000:0x4a3100);
      targetToolAngle=-(s.tool-1)*Math.PI*2/15;
      let diff=((targetToolAngle-currentToolAngle+Math.PI)%(Math.PI*2))-Math.PI;
      currentToolAngle+=diff*.13;turretDisc.rotation.x=currentToolAngle;turretFace.rotation.x=currentToolAngle;
      holders.forEach((h,i)=>h.visible=i!==s.tool-1);
      renderer.render(scene,camera);
    };
    animate();
    return()=>{cancelAnimationFrame(frame);ro.disconnect();renderer.dispose();disposeObject(scene);if(renderer.domElement.parentNode===host)host.removeChild(renderer.domElement);};
  },[]);
  return <div className="scene" ref={mount}><div className="scene-badge">3D • CK52PT-Y / 828D</div><div className="orientation"><span>ПАТРОН</span><b>← Z− &nbsp;&nbsp; Z+ →</b><span>РЕВОЛЬВЕР</span></div></div>;
}
