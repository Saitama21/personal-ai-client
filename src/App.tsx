import { useMemo, useState } from 'react';
import MachineScene from './components/MachineScene';
import type { AxisState, MachineMode, MotionMode } from './core/types';

const modes: {id:MachineMode; label:string}[] = [
  {id:'turning',label:'Точение'}, {id:'drilling',label:'Сверление'}, {id:'milling',label:'Фрезеровка'}
];

export default function App(){
  const [mode,setMode]=useState<MachineMode>('turning');
  const [motion,setMotion]=useState<MotionMode>('rapid');
  const [axes,setAxes]=useState<AxisState>({x:60,z:10,y:0,c:0});
  const [tool,setTool]=useState(1);
  const [spindle,setSpindle]=useState(false);
  const [logs,setLogs]=useState<string[]>(['CNC Trainer PRO v0.2.0 запущен']);
  const addLog=(x:string)=>setLogs(v=>[new Date().toLocaleTimeString('ru-RU')+' — '+x,...v].slice(0,8));
  const step=motion==='rapid'?5:0.5;
  const move=(axis:keyof AxisState,delta:number)=>{ setAxes(v=>({...v,[axis]:Number((v[axis]+delta).toFixed(3))})); addLog(`${axis.toUpperCase()} ${delta>0?'+':''}${delta}`); };
  const title=useMemo(()=>modes.find(m=>m.id===mode)?.label,[mode]);

  return <main>
    <header><div><small>УЧЕБНЫЙ СИМУЛЯТОР</small><h1>CNC Trainer PRO</h1></div><div className="status"><i/>Готов к работе</div></header>
    <nav>{modes.map(m=><button key={m.id} className={mode===m.id?'active':''} onClick={()=>{setMode(m.id);addLog(`Режим: ${m.label}`)}}>{m.label}</button>)}<button>Уроки</button><button>Экзамен</button></nav>
    <section className="layout">
      <aside className="panel controls"><h2>Управление</h2><div className="seg"><button className={motion==='rapid'?'active':''} onClick={()=>setMotion('rapid')}>Быстрый ход</button><button className={motion==='feed'?'active':''} onClick={()=>setMotion('feed')}>Рабочая подача</button></div>
        <div className="readouts"><label>X<input value={axes.x} onChange={e=>setAxes({...axes,x:+e.target.value})}/></label><label>Z<input value={axes.z} onChange={e=>setAxes({...axes,z:+e.target.value})}/></label><label>Y<input value={axes.y} onChange={e=>setAxes({...axes,y:+e.target.value})}/></label><label>C<input value={axes.c} onChange={e=>setAxes({...axes,c:+e.target.value})}/></label></div>
        <div className="jog"><button onClick={()=>move('x',step)}>X+</button><button onClick={()=>move('z',step)}>Z+</button><button onClick={()=>move('x',-step)}>X−</button><button onClick={()=>move('z',-step)}>Z−</button>{mode==='milling'&&<><button onClick={()=>move('y',step)}>Y+</button><button onClick={()=>move('y',-step)}>Y−</button></>}</div>
        <button className="primary" onClick={()=>{setSpindle(!spindle);addLog(spindle?'Шпиндель остановлен':'Шпиндель запущен')}}>{spindle?'Остановить шпиндель':'Запустить шпиндель'}</button>
        <button onClick={()=>{setAxes({x:60,z:10,y:0,c:0});addLog('Переход в безопасную позицию')}}>В безопасную</button>
      </aside>
      <section className="center panel"><div className="section-title"><div><small>СТАНОК TENGYUE CK52PT-Y</small><h2>{title}: 3D-сцена</h2></div><span>X {axes.x.toFixed(1)} · Z {axes.z.toFixed(1)}</span></div><MachineScene axes={axes} mode={mode} tool={tool} spindleOn={spindle}/><div className="lesson"><b>Урок 1. Оси X/Z</b><span>Подведите T1 в точку X50 Z0. На токарном станке X задаётся по диаметру, Z — вдоль детали.</span><button onClick={()=>addLog(Math.abs(axes.x-50)<.01&&Math.abs(axes.z)<.01?'Задание выполнено':'Пока неверно: нужна точка X50 Z0')}>Проверить действие</button></div></section>
      <aside className="panel tools"><h2>Револьвер T1–T15</h2><div className="tool-grid">{Array.from({length:15},(_,i)=>i+1).map(n=><button className={tool===n?'active':''} onClick={()=>{setTool(n);addLog(`Выбран инструмент T${n}`)}} key={n}>T{n}</button>)}</div><h2>Журнал</h2><div className="log">{logs.map((x,i)=><div key={i}>{x}</div>)}</div><h2>Этап 1</h2><ul><li>React + TypeScript</li><li>Three.js WebGL</li><li>Railway healthcheck</li><li>Базовая кинематика</li></ul></aside>
    </section>
  </main>
}
