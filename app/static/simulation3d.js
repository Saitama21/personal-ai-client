(() => {
  'use strict';
  const $s = id => document.getElementById(id);
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const num = (v,f=0) => Number.isFinite(Number(v)) ? Number(v) : f;
  const sim = { renderer:null, scene:null, camera:null, part:null, tool:null, chuck:null, grid:null, running:false, progress:0, speed:1, last:0, data:null, dragging:false, px:0, py:0, yaw:-0.7, pitch:0.35, distance:130, removed:0, totalRemoved:0, currentOp:0 };

  function collectData(){
    const points = (window.CNC3D_getData ? window.CNC3D_getData() : null) || {};
    return points;
  }
  function defaultContour(d,l){ return [{x:d,z:0},{x:d,z:-Math.max(4,l*.12)},{x:d*.62,z:-Math.max(6,l*.2)},{x:d*.62,z:-l*.78},{x:d*.38,z:-l*.82},{x:d*.38,z:-l}]; }
  function normalizeData(raw={}){
    const diameter=Math.max(1,num(raw.blankDiameter,16)), length=Math.max(1,num(raw.blankLength,31));
    let contour=Array.isArray(raw.contourPoints)?raw.contourPoints.filter(p=>Number.isFinite(+p.x)&&Number.isFinite(+p.z)).map(p=>({x:+p.x,z:+p.z})):[];
    if(contour.length<2) contour=defaultContour(diameter,length);
    const xMode=raw.xMode||'diameter';
    contour=contour.map(p=>({z:p.z, r:Math.abs(p.x)/(xMode==='radius'?1:2)})).sort((a,b)=>b.z-a.z);
    const ops=(Array.isArray(raw.operations)?raw.operations:[]).filter(o=>o.enabled!==false);
    return {diameter,length,contour,ops:ops.length?ops:[{name:'Черновое точение'},{name:'Чистовое точение'}], material:raw.material||'AISI 304'};
  }
  function radiusAt(contour,z,stockR){
    if(!contour.length)return stockR;
    if(z>=contour[0].z)return clamp(contour[0].r,0.1,stockR);
    if(z<=contour[contour.length-1].z)return clamp(contour[contour.length-1].r,0.1,stockR);
    for(let i=0;i<contour.length-1;i++){
      const a=contour[i],b=contour[i+1];
      if(z<=a.z&&z>=b.z){ const t=(z-a.z)/(b.z-a.z||1); return clamp(a.r+(b.r-a.r)*t,0.1,stockR); }
    }
    return stockR;
  }
  function operationWeight(local,opIndex,opCount){
    const seg=1/opCount, start=opIndex*seg, end=(opIndex+1)*seg;
    return clamp((local-start)/(end-start),0,1);
  }
  function buildProfile(progress){
    const d=sim.data, stockR=d.diameter/2, slices=180, opCount=d.ops.length;
    const pts=[]; let removed=0, stockVol=Math.PI*stockR*stockR*d.length, finalVol=0;
    for(let i=0;i<=slices;i++){
      const axial=i/slices*d.length, z=-axial, target=radiusAt(d.contour,z,stockR);
      const axialSweep=clamp(progress*1.18-(i/slices)*0.18,0,1);
      let cut=0;
      for(let op=0;op<opCount;op++) cut=Math.max(cut, operationWeight(axialSweep,op,opCount));
      const roughAllowance=opCount>1 && progress<(opCount-1)/opCount ? Math.min(0.5,Math.max(0,(stockR-target)*0.12)) : 0;
      const effectiveTarget=Math.min(stockR,target+roughAllowance);
      const r=stockR-(stockR-effectiveTarget)*cut;
      pts.push(new THREE.Vector2(Math.max(.08,r), axial-d.length/2));
      if(i<slices){ const dz=d.length/slices; removed += Math.PI*(stockR*stockR-r*r)*dz; finalVol += Math.PI*target*target*dz; }
    }
    sim.totalRemoved=Math.max(0,stockVol-finalVol); sim.removed=removed;
    return pts;
  }
  function disposeObject(obj){ if(!obj)return; obj.traverse?.(o=>{o.geometry?.dispose?.(); if(o.material){(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.dispose?.());}}); obj.parent?.remove(obj); }
  function rebuildPart(){
    if(!sim.scene||!sim.data)return;
    disposeObject(sim.part);
    const geo=new THREE.LatheGeometry(buildProfile(sim.progress),96);
    geo.computeVertexNormals();
    const mat=new THREE.MeshStandardMaterial({color:0x9aa8b4,metalness:.88,roughness:.28,side:THREE.DoubleSide});
    sim.part=new THREE.Mesh(geo,mat); sim.part.rotation.z=Math.PI/2; sim.scene.add(sim.part);
    updateTool(); updateUi();
  }
  function updateTool(){
    if(!sim.tool||!sim.data)return;
    const d=sim.data, axial=clamp(sim.progress*1.18,0,1)*d.length, z=axial-d.length/2;
    const target=radiusAt(d.contour,-axial,d.diameter/2);
    sim.tool.position.set(z,target+2.2,0); sim.tool.rotation.z=-Math.PI/2;
    const opCount=d.ops.length; sim.currentOp=Math.min(opCount-1,Math.floor(clamp(sim.progress,.0001,.9999)*opCount));
  }
  function setupScene(){
    const host=$s('stock3dViewport'); if(!host)return false;
    if(!window.THREE){
      const fallback=$s('simFallback');
      fallback?.classList.remove('hidden');
      if(fallback) fallback.textContent='3D-движок ещё не загружен. Обновите страницу.';
      if($s('simEngineBadge')) $s('simEngineBadge').textContent='Движок не загружен';
      return false;
    }
    try {
      const probe=document.createElement('canvas');
      const gl=probe.getContext('webgl2')||probe.getContext('webgl')||probe.getContext('experimental-webgl');
      if(!gl) throw new Error('WebGL context unavailable');
    } catch(err) {
      const fallback=$s('simFallback');
      fallback?.classList.remove('hidden');
      if(fallback) fallback.textContent='WebGL отключён в браузере или недоступен на этом устройстве.';
      if($s('simEngineBadge')) $s('simEngineBadge').textContent='WebGL недоступен';
      console.error(err);
      return false;
    }
    host.innerHTML='';
    let renderer;
    try { renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance'}); }
    catch(err){
      const fallback=$s('simFallback'); fallback?.classList.remove('hidden');
      if(fallback) fallback.textContent='Не удалось создать WebGL-сцену: '+(err?.message||err);
      if($s('simEngineBadge')) $s('simEngineBadge').textContent='Ошибка WebGL';
      console.error(err); return false;
    } renderer.setPixelRatio(Math.min(devicePixelRatio||1,2)); renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap; host.appendChild(renderer.domElement); sim.renderer=renderer;
    sim.scene=new THREE.Scene(); sim.scene.background=new THREE.Color(0x07121e);
    sim.camera=new THREE.PerspectiveCamera(38,1,.1,2000);
    sim.scene.add(new THREE.HemisphereLight(0xbfe9ff,0x12202d,2.1));
    const key=new THREE.DirectionalLight(0xffffff,3.2); key.position.set(70,90,80); key.castShadow=true; sim.scene.add(key);
    const rim=new THREE.DirectionalLight(0x35d9ff,2.4); rim.position.set(-70,20,-70); sim.scene.add(rim);
    sim.grid=new THREE.GridHelper(180,18,0x1a6c82,0x163746); sim.grid.rotation.z=Math.PI/2; sim.grid.position.y=-22; sim.scene.add(sim.grid);
    const chuckMat=new THREE.MeshStandardMaterial({color:0x27333d,metalness:.85,roughness:.35});
    sim.chuck=new THREE.Mesh(new THREE.CylinderGeometry(22,22,18,48),chuckMat); sim.chuck.rotation.z=Math.PI/2; sim.chuck.position.x=-30; sim.scene.add(sim.chuck);
    const toolGroup=new THREE.Group();
    const holder=new THREE.Mesh(new THREE.BoxGeometry(26,7,7),new THREE.MeshStandardMaterial({color:0x35424c,metalness:.75,roughness:.3})); holder.position.x=12;
    const insert=new THREE.Mesh(new THREE.ConeGeometry(4.5,7,3),new THREE.MeshStandardMaterial({color:0xe6b14a,metalness:.5,roughness:.25})); insert.rotation.z=Math.PI/2; insert.position.x=-3.5;
    toolGroup.add(holder,insert); sim.tool=toolGroup; sim.scene.add(toolGroup);
    function resize(){const w=Math.max(300,host.clientWidth),h=Math.max(300,host.clientHeight);renderer.setSize(w,h,false);sim.camera.aspect=w/h;sim.camera.updateProjectionMatrix();}
    new ResizeObserver(resize).observe(host); resize();
    const c=renderer.domElement;
    c.addEventListener('pointerdown',e=>{sim.dragging=true;sim.px=e.clientX;sim.py=e.clientY;c.setPointerCapture?.(e.pointerId)});
    c.addEventListener('pointermove',e=>{if(!sim.dragging)return;sim.yaw-=(e.clientX-sim.px)*.006;sim.pitch=clamp(sim.pitch+(e.clientY-sim.py)*.006,-1.1,1.1);sim.px=e.clientX;sim.py=e.clientY;});
    c.addEventListener('pointerup',()=>sim.dragging=false); c.addEventListener('pointercancel',()=>sim.dragging=false);
    c.addEventListener('wheel',e=>{e.preventDefault();sim.distance=clamp(sim.distance+e.deltaY*.08,55,300)},{passive:false});
    requestAnimationFrame(loop); return true;
  }
  function cameraUpdate(){
    const d=sim.distance,cp=Math.cos(sim.pitch);sim.camera.position.set(Math.cos(sim.yaw)*cp*d,Math.sin(sim.pitch)*d,Math.sin(sim.yaw)*cp*d);sim.camera.lookAt(0,0,0);
  }
  function loop(t){
    requestAnimationFrame(loop); const dt=Math.min(.05,(t-(sim.last||t))/1000);sim.last=t;
    if(sim.running){sim.progress=clamp(sim.progress+dt*.075*sim.speed,0,1); if(sim.progress>=1)sim.running=false; rebuildPart();}
    if(sim.part)sim.part.rotation.x+=dt*.45;
    if(sim.chuck)sim.chuck.rotation.x+=dt*.45;
    cameraUpdate(); sim.renderer?.render(sim.scene,sim.camera);
  }
  function build(){
    sim.data=normalizeData(collectData());sim.progress=0;sim.running=false;rebuildPart();
    $s('simStatusBadge').textContent='Модель построена';
  }
  function updateUi(){
    if(!sim.data)return; const pct=Math.round(sim.progress*100),ops=sim.data.ops;
    if($s('simProgressRange'))$s('simProgressRange').value=Math.round(sim.progress*1000);
    $s('simProgressValue').textContent=pct+'%';
    const op=ops[Math.min(ops.length-1,sim.currentOp)]||{};$s('simOperationLabel').textContent=`${sim.currentOp+1}/${ops.length} · ${op.name||op.operation||op.type||'Обработка'}`;
    $s('simRemovedLabel').textContent=`Снято: ${Math.round(sim.removed).toLocaleString('ru-RU')} мм³`;
    $s('simBlankMetric').textContent=`Ø${sim.data.diameter} × ${sim.data.length} мм`;$s('simOpsMetric').textContent=ops.length;
    $s('simVolumeMetric').textContent=`${Math.round(sim.totalRemoved).toLocaleString('ru-RU')} мм³`;
    $s('simTimeMetric').textContent=`≈ ${Math.max(1,Math.round(sim.data.length*ops.length/6))} мин`;
    $s('simStatusBadge').textContent=sim.running?'Обработка':'Пауза';
  }
  function step(delta){ if(!sim.data)build(); const n=sim.data.ops.length;sim.currentOp=clamp(sim.currentOp+delta,0,n-1);sim.progress=(sim.currentOp+(delta>0?1:0))/n;sim.running=false;rebuildPart(); }
  function bind(){
    $s('simBuildBtn')?.addEventListener('click',build);$s('simPlayBtn')?.addEventListener('click',()=>{if(!sim.data)build();if(sim.progress>=1)sim.progress=0;sim.running=true;});
    $s('simPauseBtn')?.addEventListener('click',()=>{sim.running=false;updateUi()});$s('simResetBtn')?.addEventListener('click',()=>{sim.progress=0;sim.running=false;rebuildPart()});
    $s('simProgressRange')?.addEventListener('input',e=>{if(!sim.data)build();sim.progress=+e.target.value/1000;sim.running=false;rebuildPart()});
    $s('simSpeedRange')?.addEventListener('input',e=>{sim.speed=+e.target.value;$s('simSpeedValue').textContent=sim.speed+'×'});
    $s('simPrevStepBtn')?.addEventListener('click',()=>step(-1));$s('simNextStepBtn')?.addEventListener('click',()=>step(1));
    window.addEventListener('cnc-contour-updated',()=>{if(sim.data)build()});
  }
  function init3D(){
    if(sim.renderer)return;
    if(setupScene()){
      bind();
      if($s('simFallback')) $s('simFallback').classList.add('hidden');
      if($s('simEngineBadge')) $s('simEngineBadge').textContent='WebGL готов';
      setTimeout(build,300);
    }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init3D,{once:true}); else init3D();
})();
