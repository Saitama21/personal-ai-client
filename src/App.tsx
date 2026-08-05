import { useMemo, useState } from 'react';
import MachineScene from './components/MachineScene';
import type { AxisState, MachineMode, MotionMode, StockSettings } from './core/types';

const modes: {id:MachineMode; label:string; icon:string}[] = [
  {id:'turning',label:'Точение',icon:'◒'},
  {id:'drilling',label:'Сверление',icon:'⌖'},
  {id:'milling',label:'Фрезеровка',icon:'▦'}
];

export default function App(){
  const [mode,setMode]=useState<MachineMode>('turning');
  const [motion,setMotion]=useState<MotionMode>('rapid');
  const [axes,setAxes]=useState<AxisState>({x:70,z:20,y:0,c:0});
  const [tool,setTool]=useState(1);
  const [spindle,setSpindle]=useState(false);
  const [rpm,setRpm]=useState(800);
  const [feed,setFeed]=useState(0.15);
  const [step,setStep]=useState(1);
  const [stock,setStock]=useState<StockSettings>({diameter:60,length:120});
  const [logs,setLogs]=useState<string[]>(['CNC Trainer PRO v0.3.0 запущен']);
  const addLog=(x:string)=>setLogs(v=>[new Date().toLocaleTimeString('ru-RU')+' — '+x,...v].slice(0,10));
  const move=(axis:keyof AxisState,delta:number)=>{
    setAxes(v=>({...v,[axis]:Number((v[axis]+delta).toFixed(3))}));
    addLog(`${axis.toUpperCase()} ${delta>0?'+':''}${delta} мм`);
  };
  const title=useMemo(()=>modes.find(m=>m.id===mode)?.label,[mode]);
  const zeroPart=()=>{setAxes(v=>({...v,x:0,z:0}));addLog('Установлен учебный ноль детали X0 Z0');};

  return <main>
    <header>
      <div><small>УЧЕБНЫЙ СИМУЛЯТОР SINUMERIK 828D</small><h1>CNC Trainer PRO <em>v0.3.0</em></h1></div>
      <div className="status"><i/>{spindle?`Шпиндель ${rpm} об/мин`:'Готов к работе'}</div>
    </header>
    <nav>
      {modes.map(m=><button key={m.id} className={mode===m.id?'active':''} onClick={()=>{setMode(m.id);addLog(`Режим: ${m.label}`)}}><span>{m.icon}</span>{m.label}</button>)}
      <button>▤ Уроки</button><button>✓ Экзамен</button><button>?</button>
    </nav>

    <section className="layout">
      <aside className="panel controls">
        <h2>Управление осями</h2>
        <div className="seg"><button className={motion==='rapid'?'active':''} onClick={()=>setMotion('rapid')}>Быстрый ход</button><button className={motion==='feed'?'active':''} onClick={()=>setMotion('feed')}>Рабочая подача</button></div>
        <div className="readouts">
          {(['x','z','y','c'] as (keyof AxisState)[]).map(axis=><label key={axis}>{axis.toUpperCase()} {axis==='c'?'°':'мм'}<input type="number" value={axes[axis]} onChange={e=>setAxes({...axes,[axis]:Number(e.target.value)})}/></label>)}
        </div>
        <label className="field">Шаг перемещения
          <select value={step} onChange={e=>setStep(Number(e.target.value))}><option value="0.1">0,1 мм</option><option value="1">1 мм</option><option value="5">5 мм</option><option value="10">10 мм</option></select>
        </label>
        <div className="jog"><button onClick={()=>move('x',step)}>X+</button><button onClick={()=>move('z',step)}>Z+</button><button onClick={()=>move('x',-step)}>X−</button><button onClick={()=>move('z',-step)}>Z−</button>{mode==='milling'&&<><button onClick={()=>move('y',step)}>Y+</button><button onClick={()=>move('y',-step)}>Y−</button></>}</div>
        <button className="primary" onClick={()=>{setSpindle(!spindle);addLog(spindle?'Шпиндель остановлен':`Шпиндель запущен: ${rpm} об/мин`)}}>{spindle?'■ Остановить шпиндель':'▶ Запустить шпиндель'}</button>
        <button onClick={()=>{setAxes({x:70,z:20,y:0,c:0});addLog('Револьвер отведён в безопасную позицию')}}>В безопасную позицию</button>
      </aside>

      <section className="center panel">
        <div className="section-title"><div><small>СТАНОК TENGYUE CK52PT-Y · SHOPTURN</small><h2>{title}: цифровой учебный стенд</h2></div><span>T{tool} · X {axes.x.toFixed(1)} · Z {axes.z.toFixed(1)}</span></div>
        <MachineScene axes={axes} mode={mode} tool={tool} spindleOn={spindle} rpm={rpm} stock={stock}/>
        <div className="machine-strip"><span><b>Патрон</b> слева</span><span><b>Заготовка</b> Ø{stock.diameter} × {stock.length}</span><span><b>Револьвер</b> справа</span><span><b>Активный</b> T{tool}</span></div>
        <div className="lesson"><b>Урок 1. Оси X/Z</b><span>Подведите T1 в точку X50 Z0. X задаётся по диаметру, Z — вдоль детали.</span><button onClick={()=>addLog(Math.abs(axes.x-50)<.01&&Math.abs(axes.z)<.01?'Задание выполнено':'Пока неверно: нужна точка X50 Z0')}>Проверить</button></div>
      </section>

      <aside className="panel tools">
        <h2>Револьвер T1–T15</h2>
        <div className="tool-grid">{Array.from({length:15},(_,i)=>i+1).map(n=><button className={tool===n?'active':''} onClick={()=>{setTool(n);addLog(`Индексация револьвера: T${n}`)}} key={n}><small>{n===1?'Резец':n===6?'Сверло':n===10?'Фреза':'Гнездо'}</small>T{n}</button>)}</div>
        <h2>Режимы резания</h2>
        <label className="field">Обороты шпинделя<input type="number" value={rpm} onChange={e=>setRpm(Number(e.target.value))}/></label>
        <label className="field">Подача, мм/об<input type="number" step="0.01" value={feed} onChange={e=>setFeed(Number(e.target.value))}/></label>
        <h2>Заготовка</h2>
        <div className="stock-grid"><label>Ø, мм<input type="number" value={stock.diameter} onChange={e=>setStock({...stock,diameter:Number(e.target.value)})}/></label><label>L, мм<input type="number" value={stock.length} onChange={e=>setStock({...stock,length:Number(e.target.value)})}/></label></div>
        <button className="wide" onClick={zeroPart}>Установить ноль детали</button>
      </aside>
    </section>

    <section className="bottom-grid">
      <div className="panel"><h2>Журнал действий</h2><div className="log">{logs.map((x,i)=><div key={i}>{x}</div>)}</div></div>
      <div className="panel stage"><h2>Этап 2 — реализовано</h2><div><span>✓ 3-кулачковый патрон</span><span>✓ 15-позиционный револьвер</span><span>✓ Индексация T1–T15</span><span>✓ Движение X/Z/Y</span><span>✓ Вращение шпинделя</span><span>✓ Размеры заготовки</span></div></div>
      <div className="panel"><h2>Подсказки</h2><ul><li>X — диаметр детали.</li><li>Z− обычно идёт в сторону патрона.</li><li>Перед сменой T отводи револьвер.</li><li>Рабочую подачу включай только у материала.</li></ul></div>
    </section>
  </main>
}
