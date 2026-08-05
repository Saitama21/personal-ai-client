import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { AxisState, MachineMode } from '../core/types';

interface Props { axes: AxisState; mode: MachineMode; tool: number; spindleOn: boolean; }

export default function MachineScene({ axes, mode, tool, spindleOn }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const state = useRef({ axes, mode, tool, spindleOn });
  state.current = { axes, mode, tool, spindleOn };

  useEffect(() => {
    if (!mount.current) return;
    const host = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07111f);
    scene.fog = new THREE.Fog(0x07111f, 10, 22);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(7.5, 5.0, 11.5);
    camera.lookAt(0, 0.3, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    host.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0x9bc9ff, 0x101820, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(4, 8, 6); key.castShadow = true; scene.add(key);
    const rim = new THREE.PointLight(0x4ea1ff, 30, 18); rim.position.set(-5, 3, -4); scene.add(rim);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 14), new THREE.MeshStandardMaterial({ color: 0x0b1725, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -2.2; floor.receiveShadow = true; scene.add(floor);

    const machine = new THREE.Group(); scene.add(machine);
    const metal = new THREE.MeshStandardMaterial({ color: 0x7f8b99, metalness: 0.82, roughness: 0.28 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x252d36, metalness: 0.9, roughness: 0.32 });
    const stockMat = new THREE.MeshStandardMaterial({ color: 0xaeb9c5, metalness: 0.68, roughness: 0.26 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 0.45, roughness: 0.3 });

    const chuck = new THREE.Group(); chuck.position.x = -3.4; machine.add(chuck);
    const chuckBody = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, 1.25, 64), darkMetal);
    chuckBody.rotation.z = Math.PI / 2; chuckBody.castShadow = true; chuck.add(chuckBody);
    for (let i=0;i<3;i++) {
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.42, 0.58), metal);
      const a = i * Math.PI * 2 / 3;
      jaw.position.set(0.72, Math.cos(a)*0.92, Math.sin(a)*0.92);
      jaw.rotation.x = a; jaw.castShadow = true; chuck.add(jaw);
    }

    const stock = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 5.8, 64), stockMat);
    stock.rotation.z = Math.PI/2; stock.position.x = -0.2; stock.castShadow = true; machine.add(stock);

    const turret = new THREE.Group(); turret.position.set(4.1, 0.35, 0); machine.add(turret);
    const turretDisc = new THREE.Mesh(new THREE.CylinderGeometry(1.85,1.85,0.9,15),darkMetal);
    turretDisc.rotation.z=Math.PI/2; turretDisc.castShadow=true; turret.add(turretDisc);
    for(let i=0;i<15;i++){
      const a=i*Math.PI*2/15;
      const holder=new THREE.Mesh(new THREE.BoxGeometry(0.75,0.28,0.35),metal);
      holder.position.set(-0.72,Math.cos(a)*1.6,Math.sin(a)*1.6); holder.rotation.x=a; turret.add(holder);
    }
    const activeHolder = new THREE.Group(); turret.add(activeHolder);
    const shank = new THREE.Mesh(new THREE.BoxGeometry(1.55,0.32,0.38), metal); shank.position.x=-1.45; activeHolder.add(shank);
    const insert = new THREE.Mesh(new THREE.ConeGeometry(0.24,0.48,3),accent); insert.rotation.z=-Math.PI/2; insert.position.x=-2.35; activeHolder.add(insert);

    const axisHelper = new THREE.AxesHelper(2.2); axisHelper.position.set(-0.2,-1.75,2.2); scene.add(axisHelper);

    let frame=0;
    const resize=()=>{ const w=host.clientWidth,h=host.clientHeight; renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix(); };
    const ro=new ResizeObserver(resize); ro.observe(host); resize();
    const animate=()=>{
      frame=requestAnimationFrame(animate);
      const s=state.current;
      if(s.spindleOn){ chuck.rotation.x += 0.045; stock.rotation.x += 0.045; }
      turret.position.x = 4.1 + (s.axes.z - 10) * 0.035;
      turret.position.y = 0.35 + (s.axes.x - 60) * 0.025;
      turret.position.z = s.mode === 'milling' ? s.axes.y * 0.035 : 0;
      turret.rotation.x = (s.tool-1) * Math.PI*2/15;
      renderer.render(scene,camera);
    };
    animate();
    return()=>{ cancelAnimationFrame(frame); ro.disconnect(); renderer.dispose(); host.removeChild(renderer.domElement); scene.traverse(o=>{ if(o instanceof THREE.Mesh){ o.geometry.dispose(); const m=o.material; if(Array.isArray(m))m.forEach(x=>x.dispose()); else m.dispose(); }}); };
  },[]);
  return <div className="scene" ref={mount}><div className="scene-badge">3D • CK52PT-Y / 828D</div></div>;
}
