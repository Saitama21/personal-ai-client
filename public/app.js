(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const canvas = $('#cncCanvas');
  const ctx = canvas.getContext('2d');

  const state = {
    mode: 'turning', tool: 1, rapid: true, step: 1, spindle: false, paused: false,
    x: 60, z: 5, y: 0, c: 0, zeroX: 60, zeroZ: 5, zeroY: 0, zeroC: 0,
    stockDiameter: 60, stockLength: 120, cutProfile: [], drillDepth: 0, millMarks: [], is3d: false
  };

  const toolIcons = ['◩','◪','◲','◧','◨','▯','⌖','┃','╿','✦','♜','♝','♞','♟','◒'];
  const grid = $('#toolGrid');
  for (let i=1;i<=15;i++) {
    const b=document.createElement('button'); b.className='tool'+(i===1?' active':''); b.dataset.tool=i;
    b.innerHTML=`<span>T${i}</span><i>${toolIcons[i-1]}</i>`; grid.appendChild(b);
  }

  function fmt(n, d=3){ return Number(n).toFixed(d); }
  function now(){ return new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
  function log(message){ const row=document.createElement('div'); row.className='log-item'; row.innerHTML=`<time>${now()}</time>${message}`; $('#log').prepend(row); }
  function relative(v,z){ return v-z; }
  function updateUI(){
    $('#toolField').value=`T${state.tool}`;
    $('#mx').textContent=fmt(state.x); $('#mz').textContent=fmt(state.z); $('#my').textContent=fmt(state.y); $('#mc').textContent=fmt(state.c)+'°';
    $('#rx').textContent=fmt(relative(state.x,state.zeroX)); $('#rz').textContent=fmt(relative(state.z,state.zeroZ)); $('#ry').textContent=fmt(relative(state.y,state.zeroY)); $('#rc').textContent=fmt(relative(state.c,state.zeroC))+'°';
    $('#hudCoord').textContent=`X${state.x.toFixed(1)} · Z${state.z.toFixed(1)} · Y${state.y.toFixed(1)} · C${state.c.toFixed(1)}°`;
    $('#hudMode').textContent=state.rapid?'Безопасный ход':'Рабочая подача';
    $('#statusBadge').className='badge '+(state.spindle?'ok':''); $('#statusBadge').textContent=state.spindle?'● Шпиндель работает':'● Готов к работе';
    draw();
  }

  function sceneMap(){
    const W=canvas.width,H=canvas.height;
    const chuckX=150, centerY=H/2, pxPerMm=Math.min(5.2,(W-400)/Math.max(140,state.stockLength));
    const stockStart=chuckX+90, stockEnd=stockStart+state.stockLength*pxPerMm;
    return {W,H,chuckX,centerY,pxPerMm,stockStart,stockEnd};
  }

  function drawGrid(m){
    ctx.strokeStyle='rgba(70,110,145,.18)';ctx.lineWidth=1;
    for(let x=0;x<m.W;x+=45){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,m.H);ctx.stroke()}
    for(let y=0;y<m.H;y+=45){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(m.W,y);ctx.stroke()}
  }
  function drawChuck(m){
    const g=ctx.createLinearGradient(m.chuckX-85,0,m.chuckX+80,0);g.addColorStop(0,'#2a3037');g.addColorStop(.5,'#838c94');g.addColorStop(1,'#222a31');
    ctx.fillStyle=g;ctx.fillRect(m.chuckX-65,m.centerY-105,125,210);
    ctx.fillStyle='#161d24';ctx.beginPath();ctx.arc(m.chuckX,m.centerY,102,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='#8f989f';ctx.lineWidth=8;ctx.beginPath();ctx.arc(m.chuckX,m.centerY,85,0,Math.PI*2);ctx.stroke();
    for(let a=0;a<3;a++){ctx.save();ctx.translate(m.chuckX,m.centerY);ctx.rotate(a*Math.PI*2/3);ctx.fillStyle='#9ba3aa';ctx.fillRect(15,-18,82,36);ctx.restore()}
  }
  function drawStock(m){
    const r=state.stockDiameter*m.pxPerMm/2;
    const grd=ctx.createLinearGradient(0,m.centerY-r,0,m.centerY+r);grd.addColorStop(0,'#dce3e8');grd.addColorStop(.38,'#7c8790');grd.addColorStop(.58,'#e8eef2');grd.addColorStop(1,'#5c6670');
    ctx.fillStyle=grd;ctx.fillRect(m.stockStart,m.centerY-r,m.stockEnd-m.stockStart,r*2);
    ctx.strokeStyle='#eef5f8';ctx.strokeRect(m.stockStart,m.centerY-r,m.stockEnd-m.stockStart,r*2);
    if(state.cutProfile.length){
      ctx.fillStyle='#07101a';
      state.cutProfile.forEach(p=>{const zpx=m.stockStart+p.z*m.pxPerMm;const rr=p.x*m.pxPerMm/2;ctx.fillRect(zpx,m.centerY-r,Math.max(3,p.w*m.pxPerMm),r-rr);ctx.fillRect(zpx,m.centerY+rr,Math.max(3,p.w*m.pxPerMm),r-rr)})
    }
    if(state.drillDepth>0){ctx.fillStyle='#07101a';ctx.fillRect(m.stockEnd-state.drillDepth*m.pxPerMm,m.centerY-7,state.drillDepth*m.pxPerMm,14)}
    state.millMarks.forEach(mark=>{ctx.strokeStyle='#ffbf39';ctx.lineWidth=3;ctx.beginPath();ctx.arc(m.stockStart+mark.z*m.pxPerMm,m.centerY+mark.y,10,0,Math.PI*2);ctx.stroke()});
  }
  function drawTurret(m){
    const tx=m.W-150,ty=m.centerY;
    ctx.fillStyle='#29313a';ctx.beginPath();ctx.arc(tx,ty,105,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#8c959e';ctx.lineWidth=6;ctx.stroke();
    for(let i=0;i<15;i++){const a=i*Math.PI*2/15-Math.PI/2;const x=tx+80*Math.cos(a),y=ty+80*Math.sin(a);ctx.save();ctx.translate(x,y);ctx.rotate(a);ctx.fillStyle=i===state.tool-1?'#e0a938':'#59636d';ctx.fillRect(-15,-9,42,18);ctx.restore();ctx.fillStyle='#d7dee5';ctx.font='12px sans-serif';ctx.fillText(String(i+1),tx+62*Math.cos(a)-5,ty+62*Math.sin(a)+4)}
    ctx.fillStyle='#111820';ctx.beginPath();ctx.arc(tx,ty,35,0,Math.PI*2);ctx.fill();
  }
  function toolPosition(m){
    const stockEndZ=state.stockLength;
    const zFromLeft=stockEndZ-state.z;
    return {x:m.stockStart+zFromLeft*m.pxPerMm,y:m.centerY-state.x*m.pxPerMm/2};
  }
  function drawTool(m){
    const p=toolPosition(m), tx=m.W-150;
    ctx.strokeStyle='#aeb8c1';ctx.lineWidth=18;ctx.beginPath();ctx.moveTo(tx-75,m.centerY-35);ctx.lineTo(p.x+30,p.y);ctx.stroke();
    ctx.fillStyle='#ffd05a';ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x+23,p.y-13);ctx.lineTo(p.x+23,p.y+13);ctx.closePath();ctx.fill();
    ctx.fillStyle='#eaf1f6';ctx.font='14px sans-serif';ctx.fillText(`T${state.tool}`,p.x+28,p.y-17);
  }
  function drawAxes(m){
    ctx.lineWidth=2;ctx.font='14px sans-serif';
    ctx.strokeStyle='#ff7373';ctx.beginPath();ctx.moveTo(m.stockEnd+10,m.centerY+125);ctx.lineTo(m.stockEnd+10,m.centerY-145);ctx.stroke();ctx.fillStyle='#ff9b9b';ctx.fillText('X+',m.stockEnd+20,m.centerY-130);
    ctx.strokeStyle='#60a8ff';ctx.beginPath();ctx.moveTo(m.stockStart-30,m.centerY+150);ctx.lineTo(m.stockEnd+30,m.centerY+150);ctx.stroke();ctx.fillStyle='#82bbff';ctx.fillText('Z+',m.stockEnd+35,m.centerY+155);
  }
  function draw(){
    const m=sceneMap();ctx.clearRect(0,0,m.W,m.H);
    const bg=ctx.createLinearGradient(0,0,0,m.H);bg.addColorStop(0,state.is3d?'#111821':'#07101a');bg.addColorStop(1,'#03070c');ctx.fillStyle=bg;ctx.fillRect(0,0,m.W,m.H);drawGrid(m);drawAxes(m);drawChuck(m);drawStock(m);drawTurret(m);drawTool(m);
    ctx.fillStyle='rgba(0,0,0,.55)';ctx.fillRect(12,12,190,32);ctx.fillStyle='#dbe7f1';ctx.font='14px sans-serif';ctx.fillText(state.mode==='turning'?'ТОКАРНАЯ':state.mode==='drilling'?'СВЕРЛЕНИЕ':'ФРЕЗЕРОВАНИЕ',24,33);
  }

  function applyCutAtCurrent(){
    if(state.rapid){log('Рабочее снятие материала недоступно в быстром ходе');return}
    const zFromLeft=Math.max(0,Math.min(state.stockLength,state.stockLength-state.z));
    if(state.mode==='turning') state.cutProfile.push({z:zFromLeft,x:Math.max(1,state.x),w:Math.max(.5,Number($('#depth').value)||1)});
    if(state.mode==='drilling') state.drillDepth=Math.max(state.drillDepth,Math.max(0,-state.z));
    if(state.mode==='milling') state.millMarks.push({z:zFromLeft,y:state.y*2,c:state.c});
  }
  function move(axis,dir){
    if(state.paused)return;
    state[axis]+=dir*state.step;
    if(axis==='c') state.c=((state.c%360)+360)%360;
    if(!state.rapid) applyCutAtCurrent();
    log(`${state.rapid?'Быстрый':'Рабочий'} ход: ${axis.toUpperCase()} ${dir>0?'+':'−'}${state.step}`);updateUI();
  }

  grid.addEventListener('click',e=>{const b=e.target.closest('.tool');if(!b)return;state.tool=Number(b.dataset.tool);$$('.tool').forEach(x=>x.classList.toggle('active',x===b));log(`Выбран инструмент T${state.tool}`);updateUI()});
  $$('.tab[data-mode]').forEach(b=>b.addEventListener('click',()=>{state.mode=b.dataset.mode;$$('.tab[data-mode]').forEach(x=>x.classList.toggle('active',x===b));$('#sceneTitle').textContent=state.mode==='turning'?'Токарная симуляция':state.mode==='drilling'?'Осевое сверление':'Фрезерование C/Y';log(`Режим: ${b.textContent.trim()}`);draw()}));
  $$('[data-step]').forEach(b=>b.addEventListener('click',()=>{state.step=Number(b.dataset.step);$$('[data-step]').forEach(x=>x.classList.toggle('active',x===b))}));
  $$('[data-move]').forEach(b=>b.addEventListener('click',()=>move(b.dataset.move,Number(b.dataset.dir))));
  $('#rapidMode').onclick=()=>{state.rapid=true;$('#rapidMode').classList.add('active');$('#cutMode').classList.remove('active');updateUI()};
  $('#cutMode').onclick=()=>{state.rapid=false;$('#cutMode').classList.add('active');$('#rapidMode').classList.remove('active');updateUI()};
  $('#spindle').onclick=()=>{state.spindle=!state.spindle;log(state.spindle?'Шпиндель запущен':'Шпиндель остановлен');updateUI()};
  $('#pause').onclick=()=>{state.paused=!state.paused;log(state.paused?'Симуляция поставлена на паузу':'Симуляция продолжена')};
  $('#stop').onclick=()=>{state.spindle=false;state.paused=false;state.rapid=true;log('Аварийная остановка симуляции');updateUI()};
  $('#setZero').onclick=()=>{state.zeroX=state.x;state.zeroZ=state.z;state.zeroY=state.y;state.zeroC=state.c;log('Рабочий ноль детали установлен');updateUI()};
  $('#applyStock').onclick=()=>{state.stockDiameter=Math.max(5,Number($('#stockDiameter').value)||60);state.stockLength=Math.max(10,Number($('#stockLength').value)||120);state.cutProfile=[];state.drillDepth=0;state.millMarks=[];log(`Установлена заготовка Ø${state.stockDiameter} × ${state.stockLength}`);updateUI()};
  $('#applyCut').onclick=()=>log(`Параметры: S${$('#rpm').value}, F${$('#feed').value}, ap ${$('#depth').value}`);
  $('#resetView').onclick=()=>{state.x=60;state.z=5;state.y=0;state.c=0;log('Положение инструмента сброшено');updateUI()};
  $('#toggle3d').onclick=()=>{state.is3d=!state.is3d;$('#toggle3d').classList.toggle('active',state.is3d);log(state.is3d?'Включён объёмный вид':'Включён плоский вид');draw()};
  $('#themeBtn').onclick=()=>document.body.classList.toggle('light');
  $('#checkTask').onclick=()=>{const ok=Math.abs(state.x-30)<.01&&Math.abs(state.z+20)<.01;$('#taskResult').textContent=ok?'✓ Задание выполнено':'Нужно завершить в X30 Z−20';$('#taskResult').style.color=ok?'#67db74':'#ffca52';log(ok?'Учебное задание выполнено':'Проверка задания: координаты не совпали')};
  $('#loadDemo').onclick=()=>{$('#program').value='MODE TURNING\nTOOL T1\nRPM 800\nRAPID X60 Z5\nCUT X40 Z0\nCUT X40 Z-20\nCUT X30 Z-20';log('Демонстрационная программа загружена')};
  $('#runProgram').onclick=async()=>{
    const lines=$('#program').value.split(/\n+/).map(x=>x.trim()).filter(Boolean);log('Запуск учебной программы');
    for(const line of lines){if(state.paused)break;const up=line.toUpperCase();
      if(up.startsWith('MODE ')){const v=up.split(' ')[1];state.mode=v==='MILLING'?'milling':v==='DRILLING'?'drilling':'turning'}
      else if(up.startsWith('TOOL ')){state.tool=Number(up.match(/T(\d+)/)?.[1]||1)}
      else if(up.startsWith('RPM ')){$('#rpm').value=Number(up.split(' ')[1])||800;state.spindle=true}
      else if(up.startsWith('RAPID')||up.startsWith('CUT')){state.rapid=up.startsWith('RAPID');const xm=up.match(/X(-?\d+(?:\.\d+)?)/),zm=up.match(/Z(-?\d+(?:\.\d+)?)/),ym=up.match(/Y(-?\d+(?:\.\d+)?)/),cm=up.match(/C(-?\d+(?:\.\d+)?)/);if(xm)state.x=Number(xm[1]);if(zm)state.z=Number(zm[1]);if(ym)state.y=Number(ym[1]);if(cm)state.c=Number(cm[1]);if(!state.rapid)applyCutAtCurrent()}
      log(`Выполнено: ${line}`);updateUI();await new Promise(r=>setTimeout(r,430));
    }log('Программа завершена');
  };
  window.addEventListener('resize',draw);log('CNC Trainer PRO запущен');log('Заготовка установлена');log('Инструмент T1 выбран');updateUI();
})();
