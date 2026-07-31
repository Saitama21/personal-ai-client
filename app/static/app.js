const TYPE_META = {
  start: { label: 'Начальная точка', color: '#8bbcff', sin: 'Start point', direction: '—' },
  lineX: { label: 'Прямая (по X)', color: '#299cff', sin: 'Straight', direction: 'по X' },
  lineZ: { label: 'Прямая (по Z)', color: '#b267ff', sin: 'Straight', direction: 'по Z' },
  arcCW: { label: 'Дуга (CW)', color: '#68df6b', sin: 'Arc CW', direction: 'CW' },
  arcCCW: { label: 'Дуга (CCW)', color: '#ff5353', sin: 'Arc CCW', direction: 'CCW' },
  chamfer: { label: 'Фаска', color: '#ffb72f', sin: 'Chamfer', direction: 'угол' },
};

const DEFAULT_CONTOUR = [
  { x: 140, z: 0, type: 'start', rv: '—', direction: '—' },
  { x: 130, z: -3, type: 'lineX', rv: '—', direction: 'по X' },
  { x: 130, z: -20, type: 'lineZ', rv: '—', direction: 'по Z' },
  { x: 92, z: -22, type: 'chamfer', rv: '2×45°', direction: '—' },
  { x: 92, z: -40, type: 'lineZ', rv: '—', direction: 'по Z' },
  { x: 70, z: -42, type: 'chamfer', rv: '2×45°', direction: '—' },
  { x: 70, z: -55, type: 'lineZ', rv: '—', direction: 'по Z' },
];

const state = {
  file: null, restoredFileName: null, image: null, crop: null, dragging: false, start: null, health: null,
  stockMode: 'lathe', contourPoints: [], selectedIndex: 0,
  undoStack: [], redoStack: [], zoom: 1, showGrid: true, showAxes: true, showLegend: true,
  showBlank: true, showLabels: true, showDimensions: false, snap: true, snapStep: 0.1,
  xMode: 'diameter', process: 'outer', z0: 'right', closed: false,
  draggingPoint: false, dragSnapshotTaken: false, currentProjectId: null, currentProjectName: 'Локальный черновик',
  pointModalMode: 'add', validation: [], canvasTransform: null, autosaveTimer: null, serverSaveTimer: null,
  chat: {
    analysis: { analysisId: null, rootResponseId: null, responseId: null, context: '', messages: [] },
    stock: { analysisId: null, rootResponseId: null, responseId: null, context: '', messages: [] },
  },
};
state.shopturn = { wizardStep: 0, customTools: [] };
state.drawingIntel = { tolerances: [], tolerance_interpretations: [], threads: [], chamfers_detected: [], requires_chamfer_decision: true, notes: [] };
state.threadCatalog = [];
state.projectThreads = [];
state.chamfers = [];
state.operationRoute = [];
state.selectedOperationCodes = [];
state.activeRouteIndex = -1;
state.chamferTransform = null;

const $ = id => document.getElementById(id);

const THEME_STORAGE_KEY = 'personal-ai-theme';
const systemDarkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemDarkMedia?.matches ? 'dark' : 'light';
}

function applyTheme(mode = 'auto', persist = true) {
  const safeMode = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
  const resolved = resolveTheme(safeMode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = safeMode;
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, safeMode);
  document.querySelectorAll('[data-theme-choice]').forEach(btn => {
    const active = btn.dataset.themeChoice === safeMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const names = { auto: 'Автоматическая', light: 'Светлая', dark: 'Тёмная' };
  if ($('themeStatus')) $('themeStatus').textContent = `${names[safeMode]} · ${resolved === 'dark' ? 'ночь' : 'день'}`;
  const meta = $('themeColorMeta');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b1420' : '#edf4ff');
}

function initThemeControls() {
  let stored = 'auto';
  try { stored = localStorage.getItem(THEME_STORAGE_KEY) || document.documentElement.dataset.themeMode || 'auto'; } catch (_) {}
  applyTheme(stored, false);
  document.querySelectorAll('[data-theme-choice]').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice));
  });
  const onSystemTheme = () => {
    if ((localStorage.getItem(THEME_STORAGE_KEY) || 'auto') === 'auto') applyTheme('auto', false);
  };
  if (systemDarkMedia?.addEventListener) systemDarkMedia.addEventListener('change', onSystemTheme);
  else if (systemDarkMedia?.addListener) systemDarkMedia.addListener(onSystemTheme);
}

function updateDeviceModeLabel() {
  const width = window.innerWidth;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  let label = 'Стационарный компьютер';
  let text = 'Боковая навигация и многоколоночная рабочая область.';
  if (width <= 700) {
    label = 'Смартфон';
    text = 'Нижняя навигация, крупные зоны нажатия и одноколоночные блоки.';
  } else if (width <= 1024) {
    label = coarse ? 'Планшет' : 'Компактный экран';
    text = 'Горизонтальная стеклянная навигация и адаптивные рабочие карточки.';
  } else if (width <= 1366) {
    label = 'Ноутбук';
    text = 'Компактная боковая панель и автоматическое сворачивание сложных сеток.';
  }
  if ($('deviceModeLabel')) $('deviceModeLabel').textContent = label;
  if ($('deviceModeText')) $('deviceModeText').textContent = text;
  document.documentElement.dataset.deviceLayout = width <= 700 ? 'phone' : width <= 1024 ? 'tablet' : width <= 1366 ? 'laptop' : 'desktop';
}
const fileInput = $('fileInput'), dropZone = $('dropZone'), previewArea = $('previewArea');
const imageCanvas = $('imageCanvas'), imageCtx = imageCanvas.getContext('2d'), pdfPreview = $('pdfPreview');
const contourCanvas = $('contourCanvas'), contourCtx = contourCanvas.getContext('2d');
const miniCanvas = $('miniContourCanvas'), miniCtx = miniCanvas.getContext('2d');
const chamferCanvas = $('chamferCanvas'), chamferCtx = chamferCanvas.getContext('2d');

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function number(v, fallback = 0) { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : fallback; }
function fmt(v) { return number(v).toFixed(3); }
function escapeHtml(v='') { return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3300); }
function renderText(text) { const s = escapeHtml(text); return s.replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\n/g,'<br>'); }
function buildEngineeringContext() {
  const toleranceRules = state.drawingIntel.tolerance_interpretations?.map(x => x.display).join('; ') || '';
  const tolerances = [state.drawingIntel.tolerances?.join('; '), toleranceRules].filter(Boolean).join('; ') || 'не распознаны';
  const threads = state.projectThreads.map(t => `${t.designation}×${t.pitch} ${t.side === 'internal' ? 'внутренняя' : 'наружная'} ${t.tolerance || ''}`.trim()).join('; ') || 'не выбраны';
  const chamfers = state.chamfers.map((c, i) => `${i + 1}: ${c.mode === 'edge_break' ? 'снять остроту' : c.mode === 'none' ? 'не обрабатывать' : c.notation}${c.contourIndex!==null&&c.contourIndex!==undefined?` у точки X/Z №${c.contourIndex+1}`:''}`).join('; ') || 'не отмечены';
  const route = state.operationRoute.filter(o => o.enabled !== false).map((o, i) => `${i + 1}. ${o.label || o.operation} T${o.toolT || '?'} D${o.toolD || '?'}`).join('; ') || 'не сформирован';
  return `Инженерный контекст проекта:
Допуски: ${tolerances}.
Резьбы: ${threads}.
Фаски/кромки: ${chamfers}.
Маршрут обработки: ${route}.`;
}

function chatIds(mode) {
  return mode === 'stock'
    ? { panel: 'stockChatPanel', messages: 'stockChatMessages', input: 'stockChatInput', send: 'stockChatSend', clear: 'stockChatClear', progress: 'stockChatProgress' }
    : { panel: 'analysisChatPanel', messages: 'analysisChatMessages', input: 'analysisChatInput', send: 'analysisChatSend', clear: 'analysisChatClear', progress: 'analysisChatProgress' };
}
function resetChat(mode, hide = true) {
  state.chat[mode] = { analysisId: null, rootResponseId: null, responseId: null, context: '', messages: [] };
  const ids = chatIds(mode);
  $(ids.messages).innerHTML = '';
  $(ids.input).value = '';
  $(ids.panel).classList.toggle('hidden', hide);
}
function startChat(mode, data) {
  state.chat[mode] = {
    analysisId: data.id || null,
    rootResponseId: data.response_id || null,
    responseId: data.response_id || null,
    context: data.response || '',
    messages: [],
  };
  const ids = chatIds(mode);
  $(ids.panel).classList.remove('hidden');
  $(ids.input).value = '';
  renderChat(mode);
}
function renderChat(mode) {
  const ids = chatIds(mode), chat = state.chat[mode];
  if (!chat.messages.length) {
    $(ids.messages).innerHTML = '<div class="chat-empty">Продолжите разговор: ответьте на вопрос ассистента или уточните расчёт.</div>';
    return;
  }
  $(ids.messages).innerHTML = chat.messages.map(message => `
    <div class="chat-row ${message.role}">
      <div class="chat-avatar">${message.role === 'user' ? 'ВЫ' : 'AI'}</div>
      <div class="chat-bubble">${renderText(message.content)}</div>
    </div>`).join('');
  $(ids.messages).scrollTop = $(ids.messages).scrollHeight;
}
async function sendChat(mode) {
  const ids = chatIds(mode), chat = state.chat[mode];
  const question = $(ids.input).value.trim();
  if (!question) return;
  const priorConversation = chat.messages.slice(-16).map(({role, content}) => ({role, content}));
  chat.messages.push({ role: 'user', content: question });
  $(ids.input).value = '';
  $(ids.send).disabled = true;
  $(ids.progress).classList.remove('hidden');
  renderChat(mode);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        question,
        previous_response_id: chat.responseId,
        analysis_id: chat.analysisId,
        context_text: `${chat.context}\n\n${buildEngineeringContext()}`,
        conversation: priorConversation,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Ошибка диалога');
    chat.responseId = data.response_id || chat.responseId;
    chat.messages.push({ role: 'assistant', content: data.response });
    renderChat(mode);
    scheduleAutosave();
  } catch (error) {
    chat.messages.push({ role: 'assistant', content: `Ошибка: ${error.message}` });
    renderChat(mode);
    toast(error.message);
  } finally {
    $(ids.send).disabled = false;
    $(ids.progress).classList.add('hidden');
    $(ids.input).focus();
  }
}
function clearChat(mode) {
  const chat = state.chat[mode];
  chat.messages = [];
  chat.responseId = chat.rootResponseId;
  renderChat(mode);
}
['analysis','stock'].forEach(mode => {
  const ids = chatIds(mode);
  $(ids.send).onclick = () => sendChat(mode);
  $(ids.clear).onclick = () => clearChat(mode);
  $(ids.input).addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChat(mode);
    }
  });
});

async function loadHealth() {
  try {
    const r = await fetch('/api/health'); if (!r.ok) throw new Error('Сервер недоступен'); state.health = await r.json();
    $('statusDot').className = 'status-dot online'; $('statusTitle').textContent = state.health.mock_mode ? 'Тестовый режим' : 'OpenAI подключён';
    $('statusText').textContent = state.health.mock_mode ? 'API не расходуется' : state.health.model; $('modelName').textContent = state.health.model;
    $('modeName').textContent = state.health.mock_mode ? 'MOCK' : 'LIVE'; $('appVersion').textContent = state.health.version || '2.0 PRO';
    $('supportedFormatsText').textContent = `Форматы: ${(state.health.supported_types || []).join(', ')}`;
  } catch (e) { $('statusDot').className = 'status-dot error'; $('statusTitle').textContent = 'Нет соединения'; $('statusText').textContent = e.message; }
}

function setView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  $(`${name}View`).classList.add('active');
  const t = { analysis:['Новый анализ','Загрузите изображение, PDF или SLDDRW и задайте вопрос'], stock:['Stock Removal PRO','AI-план, контур X/Z, проверка и экспорт в SINUMERIK'], projects:['Проекты','Сохранение на Railway Volume'], history:['История','Журнал анализов'], settings:['Настройки','Состояние и горячие клавиши'] };
  $('pageTitle').textContent = t[name][0]; $('pageSubtitle').textContent = t[name][1];
  $('newAnalysisBtn').style.display = ['analysis','stock'].includes(name) ? '' : 'none';
  if (name === 'projects') loadProjects(); if (name === 'history') loadHistory();
  requestAnimationFrame(renderEditor);
}
document.querySelectorAll('.nav-item').forEach(b => b.onclick = () => setView(b.dataset.view));

function syncFileUi() {
  const visibleName = state.file?.name || state.restoredFileName || 'Файл не выбран';
  $('currentFilePill').textContent = visibleName;
  $('fileBadge').textContent = state.file?.name || state.restoredFileName || 'Нет файла';
  $('stockFileBadge').textContent = state.file?.name || state.restoredFileName || 'Нет файла';
  $('currentFilePill').classList.toggle('restored-file', !state.file && !!state.restoredFileName);
  $('analyzeBtn').disabled = !(state.file && $('promptInput').value.trim().length >= 3);
  $('stockBtn').disabled = !state.file; $('aiContourBtn').disabled = !state.file;
}
function updateProjectUi() { $('activeProjectName').textContent = state.currentProjectName; $('projectNameInput').value = state.currentProjectName === 'Локальный черновик' ? '' : state.currentProjectName; }

['dragenter','dragover'].forEach(t => dropZone.addEventListener(t,e => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave','drop'].forEach(t => dropZone.addEventListener(t,e => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.ondrop = e => handleFile(e.dataTransfer.files[0]); fileInput.onchange = () => handleFile(fileInput.files[0]);
$('promptInput').oninput = syncFileUi;
document.querySelectorAll('.quick-prompts button').forEach(b => b.onclick = () => { $('promptInput').value = b.dataset.prompt; syncFileUi(); });

async function handleFile(file) {
  if (!file) return; const ext = file.name.split('.').pop().toLowerCase(); const allowed = ['image/jpeg','image/png','image/webp','application/pdf'];
  if (!(allowed.includes(file.type) || ext === 'slddrw' || file.type === 'application/octet-stream')) return toast('Неподдерживаемый формат');
  if (state.health && file.size > state.health.max_file_mb * 1024 * 1024) return toast(`Файл больше ${state.health.max_file_mb} МБ`);
  state.file = file; state.crop = null; state.image = null; dropZone.classList.add('hidden'); previewArea.classList.remove('hidden'); $('selectAllBtn').disabled = true; $('clearSelectionBtn').disabled = true;
  if (file.type === 'application/pdf') {
    imageCanvas.style.display = 'none'; pdfPreview.style.display = 'block'; pdfPreview.src = URL.createObjectURL(file); $('selectionHint').classList.add('hidden'); $('selectionInfo').textContent = 'PDF анализируется целиком';
  } else if (ext === 'slddrw') {
    pdfPreview.style.display = 'none'; imageCanvas.style.display = 'block'; $('selectionHint').classList.add('hidden'); $('selectionInfo').textContent = 'Извлекаю превью SLDDRW...';
    try {
      const form = new FormData(); form.append('file', file); const r = await fetch('/api/slddrw-preview',{method:'POST',body:form}); if (!r.ok) throw new Error((await r.json()).detail || 'Превью не найдено');
      const blob = await r.blob(); const img = new Image(); img.onload = () => { state.image = img; resizeImageCanvas(); drawImageCanvas(); renderChamferEditor(); $('selectionInfo').textContent = 'SLDDRW: встроенное превью'; }; img.src = URL.createObjectURL(blob);
    } catch(e) { $('selectionInfo').textContent = e.message; toast(e.message); }
  } else {
    pdfPreview.style.display = 'none'; imageCanvas.style.display = 'block'; $('selectionHint').classList.remove('hidden'); $('selectionHint').textContent = 'Проведите мышью, чтобы выделить область'; $('selectAllBtn').disabled = false;
    const img = new Image(); img.onload = () => { state.image = img; resizeImageCanvas(); drawImageCanvas(); renderChamferEditor(); }; img.src = URL.createObjectURL(file);
  }
  syncFileUi(); renderChamferEditor(); scheduleAutosave();
}
function resizeImageCanvas() { if (!state.image) return; const ratio = Math.min(1,(previewArea.clientWidth || 900)/state.image.naturalWidth); imageCanvas.width = Math.round(state.image.naturalWidth*ratio); imageCanvas.height = Math.round(state.image.naturalHeight*ratio); }
function drawImageCanvas() { if (!state.image) return; imageCtx.clearRect(0,0,imageCanvas.width,imageCanvas.height); imageCtx.drawImage(state.image,0,0,imageCanvas.width,imageCanvas.height); if (state.crop) { const x=state.crop.x*imageCanvas.width,y=state.crop.y*imageCanvas.height,w=state.crop.width*imageCanvas.width,h=state.crop.height*imageCanvas.height; imageCtx.save(); imageCtx.fillStyle='rgba(0,0,0,.48)'; imageCtx.fillRect(0,0,imageCanvas.width,imageCanvas.height); imageCtx.clearRect(x,y,w,h); imageCtx.drawImage(state.image,state.crop.x*state.image.naturalWidth,state.crop.y*state.image.naturalHeight,state.crop.width*state.image.naturalWidth,state.crop.height*state.image.naturalHeight,x,y,w,h); imageCtx.strokeStyle='#82eaff'; imageCtx.lineWidth=2; imageCtx.setLineDash([8,5]); imageCtx.strokeRect(x,y,w,h); imageCtx.restore(); } }
function imagePointer(e) { const r=imageCanvas.getBoundingClientRect(); return {x:(e.clientX-r.left)*imageCanvas.width/r.width,y:(e.clientY-r.top)*imageCanvas.height/r.height}; }
imageCanvas.onpointerdown=e=>{ if(!state.image || state.file?.name.toLowerCase().endsWith('.slddrw'))return; state.dragging=true; state.start=imagePointer(e); imageCanvas.setPointerCapture(e.pointerId); };
imageCanvas.onpointermove=e=>{ if(!state.dragging)return; const p=imagePointer(e),x=Math.min(p.x,state.start.x),y=Math.min(p.y,state.start.y); state.crop={x:x/imageCanvas.width,y:y/imageCanvas.height,width:Math.abs(p.x-state.start.x)/imageCanvas.width,height:Math.abs(p.y-state.start.y)/imageCanvas.height}; drawImageCanvas(); };
imageCanvas.onpointerup=()=>{ if(!state.dragging)return; state.dragging=false; if(!state.crop || state.crop.width*imageCanvas.width<8 || state.crop.height*imageCanvas.height<8)state.crop=null; $('clearSelectionBtn').disabled=!state.crop; $('selectionInfo').textContent=state.crop?`Область ${Math.round(state.crop.width*100)}% × ${Math.round(state.crop.height*100)}%`:'Область не выбрана'; drawImageCanvas(); };
$('selectAllBtn').onclick=()=>{state.crop={x:0,y:0,width:1,height:1};$('clearSelectionBtn').disabled=false;$('selectionInfo').textContent='Выбрано всё';drawImageCanvas();};
$('clearSelectionBtn').onclick=()=>{state.crop=null;$('clearSelectionBtn').disabled=true;$('selectionInfo').textContent='Область не выбрана';drawImageCanvas();};

$('analyzeBtn').onclick = async () => {
  if (!state.file) return; $('analyzeBtn').disabled=true; $('progress').classList.remove('hidden'); const form=new FormData(); form.append('file',state.file); form.append('prompt',$('promptInput').value.trim()); form.append('project_json',JSON.stringify(collectProjectData())); const ext=state.file.name.split('.').pop().toLowerCase(); if(state.crop && state.file.type!=='application/pdf' && ext!=='slddrw') form.append('crop_json',JSON.stringify(state.crop));
  try { const r=await fetch('/api/analyze',{method:'POST',body:form}); const d=await r.json(); if(!r.ok) throw new Error(d.detail||'Ошибка'); $('resultEmpty').classList.add('hidden'); $('resultContent').classList.remove('hidden'); $('resultContent').innerHTML=renderText(d.response); $('resultMeta').textContent=`${d.model}${d.mock?' · MOCK':''} · #${d.id}`; startChat('analysis',d); applyDrawingIntelligence(d.drawing_intelligence||{}); toast('Анализ готов'); }
  catch(e){toast(e.message);} finally{$('progress').classList.add('hidden');syncFileUi();}
};

document.querySelectorAll('.segmented-item').forEach(b=>b.onclick=()=>{state.stockMode=b.dataset.mode;document.querySelectorAll('.segmented-item').forEach(x=>x.classList.toggle('active',x===b));$('latheFields').classList.toggle('hidden',state.stockMode!=='lathe');$('millFields').classList.toggle('hidden',state.stockMode!=='mill');scheduleAutosave();});
['blankDiameter','blankLength','blankWidth','blankHeight','blankLengthMill','zeroReference','firstSide','stockNotes'].forEach(id=>$(id).addEventListener('input',()=>{renderEditor();scheduleAutosave();}));

$('stockBtn').onclick = async () => {
  if(!state.file)return; $('stockBtn').disabled=true;$('stockProgress').classList.remove('hidden');const f=new FormData();f.append('file',state.file);f.append('stock_mode',state.stockMode);
  if(state.stockMode==='lathe'){f.append('blank_diameter',$('blankDiameter').value);f.append('blank_length',$('blankLength').value);}else{f.append('blank_width',$('blankWidth').value);f.append('blank_height',$('blankHeight').value);f.append('blank_length',$('blankLengthMill').value);} f.append('zero_reference',$('zeroReference').value);f.append('first_side',$('firstSide').value);f.append('notes',$('stockNotes').value);f.append('shopturn_json',JSON.stringify(collectShopTurnPayload()));f.append('project_json',JSON.stringify(collectProjectData()));
  try{const r=await fetch('/api/stock-removal',{method:'POST',body:f});const d=await r.json();if(!r.ok)throw new Error(d.detail||'Ошибка');$('stockResultEmpty').classList.add('hidden');$('stockResultContent').classList.remove('hidden');$('stockResultContent').innerHTML=renderText(d.response);$('stockResultMeta').textContent=`${d.model}${d.mock?' · MOCK':''} · #${d.id}`;startChat('stock',d);toast('План сформирован');}catch(e){toast(e.message);}finally{$('stockProgress').classList.add('hidden');syncFileUi();}
};
$('aiContourBtn').onclick = async () => {
  if(!state.file)return; $('stockProgress').classList.remove('hidden');$('aiContourBtn').disabled=true;const f=new FormData();f.append('file',state.file);f.append('blank_diameter',$('blankDiameter').value);f.append('blank_length',$('blankLength').value);f.append('notes',$('stockNotes').value);
  try{const r=await fetch('/api/contour-ai',{method:'POST',body:f});const d=await r.json();if(!r.ok)throw new Error(d.detail||'Ошибка AI-контура');pushUndo();state.contourPoints=d.points;state.selectedIndex=0;state.closed=false;state.validation=[];renderEditor();scheduleAutosave();toast(`AI-контур готов · уверенность ${Math.round((d.confidence||0)*100)}%`);}catch(e){toast(e.message);}finally{$('stockProgress').classList.add('hidden');syncFileUi();}
};

function pushUndo() { state.undoStack.push(JSON.stringify({points:state.contourPoints,closed:state.closed})); if(state.undoStack.length>80)state.undoStack.shift(); state.redoStack=[]; updateUndoButtons(); }
function restoreSnapshot(s) { const d=JSON.parse(s);state.contourPoints=d.points;state.closed=!!d.closed;state.selectedIndex=Math.min(state.selectedIndex,state.contourPoints.length-1);state.validation=[];renderEditor();scheduleAutosave(); }
function undo(){if(!state.undoStack.length)return;state.redoStack.push(JSON.stringify({points:state.contourPoints,closed:state.closed}));restoreSnapshot(state.undoStack.pop());}
function redo(){if(!state.redoStack.length)return;state.undoStack.push(JSON.stringify({points:state.contourPoints,closed:state.closed}));restoreSnapshot(state.redoStack.pop());}
function updateUndoButtons(){$('undoBtn').disabled=!state.undoStack.length;$('redoBtn').disabled=!state.redoStack.length;}
$('undoBtn').onclick=undo;$('redoBtn').onclick=redo;

function snapValue(v){return state.snap?Math.round(v/state.snapStep)*state.snapStep:v;}
function parseRadius(rv){const m=String(rv||'').match(/R\s*([0-9]+(?:[.,][0-9]+)?)/i);return m?number(m[1],0):0;}
function arcGeom(a,b,r,cw){const dx=b.z-a.z,dy=b.x-a.x,d=Math.hypot(dx,dy);if(!r||d===0||d>2*r)return null;const mx=(a.z+b.z)/2,my=(a.x+b.x)/2,h=Math.sqrt(Math.max(0,r*r-d*d/4));const ux=-dy/d,uy=dx/d;const centers=[{z:mx+ux*h,x:my+uy*h},{z:mx-ux*h,x:my-uy*h}];for(const c of centers){const s=Math.atan2(a.x-c.x,a.z-c.z),e=Math.atan2(b.x-c.x,b.z-c.z);let delta=e-s;if(cw&&delta>0)delta-=Math.PI*2;if(!cw&&delta<0)delta+=Math.PI*2;if(Math.abs(delta)<=Math.PI*1.8)return{c,s,e,delta};}return null;}
function segLength(a,b){if(['arcCW','arcCCW'].includes(b.type)){const r=parseRadius(b.rv),g=arcGeom(a,b,r,b.type==='arcCW');if(g)return Math.abs(g.delta)*r;}return Math.hypot(b.x-a.x,b.z-a.z);}
function totalLength(){let s=0;for(let i=1;i<state.contourPoints.length;i++)s+=segLength(state.contourPoints[i-1],state.contourPoints[i]);if(state.closed&&state.contourPoints.length>2)s+=Math.hypot(state.contourPoints[0].x-state.contourPoints.at(-1).x,state.contourPoints[0].z-state.contourPoints.at(-1).z);return s;}

function bounds(){const xs=state.contourPoints.map(p=>displayX(p.x));const zs=state.contourPoints.map(p=>p.z);let minX=Math.min(...xs,0),maxX=Math.max(...xs,1),minZ=Math.min(...zs,-1),maxZ=Math.max(...zs,0);if(state.showBlank){const d=displayX(number($('blankDiameter').value,0)),l=number($('blankLength').value,0);if(d>0){minX=Math.min(minX,0);maxX=Math.max(maxX,d);}if(l>0){minZ=Math.min(minZ,-l);maxZ=Math.max(maxZ,0);}}return{minX,maxX,minZ,maxZ};}
function displayX(x){return state.xMode==='radius'?x/2:x;}
function storeX(x){return state.xMode==='radius'?x*2:x;}
function makeTransform(canvas){const b=bounds(),pad=48,sw=Math.max(1,b.maxZ-b.minZ),sh=Math.max(1,b.maxX-b.minX),scale=Math.min((canvas.width-pad*2)/sw,(canvas.height-pad*2)/sh)*state.zoom,offsetZ=(canvas.width-sw*scale)/2-b.minZ*scale,offsetX=canvas.height-(canvas.height-sh*scale)/2+b.minX*scale;return{scale,b,toPx:p=>({x:p.z*scale+offsetZ,y:offsetX-displayX(p.x)*scale}),fromPx:(x,y)=>({z:(x-offsetZ)/scale,x:storeX((offsetX-y)/scale)})};}
function drawGrid(ctx,canvas,tr){if(!state.showGrid)return;ctx.save();ctx.strokeStyle='rgba(75,177,255,.11)';ctx.lineWidth=1;const step=Math.max(state.snapStep,1);for(let z=Math.floor(tr.b.minZ/step)*step;z<=tr.b.maxZ;z+=step){const x=z*tr.scale+(canvas.width-(tr.b.maxZ-tr.b.minZ)*tr.scale)/2-tr.b.minZ*tr.scale;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,canvas.height);ctx.stroke();}for(let x=Math.floor(tr.b.minX/step)*step;x<=tr.b.maxX;x+=step){const y=tr.toPx({x:storeX(x),z:0}).y;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();}ctx.restore();}
function drawAxes(ctx,canvas,tr){if(!state.showAxes)return;ctx.save();ctx.strokeStyle='#41e1a4';ctx.lineWidth=2;const z0=tr.toPx({x:0,z:0}).x,x0=tr.toPx({x:0,z:0}).y;ctx.beginPath();ctx.moveTo(z0,0);ctx.lineTo(z0,canvas.height);ctx.stroke();ctx.beginPath();ctx.moveTo(0,x0);ctx.lineTo(canvas.width,x0);ctx.stroke();ctx.fillStyle='#7ff1c3';ctx.font='bold 13px Inter';ctx.fillText('Z0',z0+8,20);ctx.fillText(state.xMode==='radius'?'X (радиус)':'X (диаметр)',10,18);ctx.fillText('Z',canvas.width-20,x0-8);ctx.restore();}
function drawBlank(ctx,tr){if(!state.showBlank)return;const d=number($('blankDiameter').value,0),l=number($('blankLength').value,0);if(d<=0||l<=0)return;const a=tr.toPx({x:d,z:-l}),b=tr.toPx({x:0,z:0});ctx.save();ctx.fillStyle='rgba(145,170,196,.10)';ctx.strokeStyle='rgba(190,216,240,.45)';ctx.setLineDash([8,6]);ctx.lineWidth=2;ctx.fillRect(a.x,a.y,b.x-a.x,b.y-a.y);ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);ctx.fillStyle='rgba(220,235,250,.7)';ctx.font='12px Inter';ctx.fillText(`Заготовка Ø${d} × ${l}`,a.x+8,a.y+18);ctx.restore();}
function drawSegment(ctx,tr,a,b,index,mini){const pa=tr.toPx(a),pb=tr.toPx(b),m=TYPE_META[b.type],sel=index===state.selectedIndex;ctx.save();ctx.strokeStyle=m.color;ctx.lineWidth=sel?5:3;ctx.beginPath();if(['arcCW','arcCCW'].includes(b.type)){const r=parseRadius(b.rv),g=arcGeom(a,b,r,b.type==='arcCW');if(g){const pc=tr.toPx({x:g.c.x,z:g.c.z});ctx.arc(pc.x,pc.y,r*tr.scale,-g.s,-g.e,b.type==='arcCCW');}else{ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);}}else{ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);}ctx.stroke();ctx.restore();if(state.showDimensions&&!mini){ctx.fillStyle='rgba(235,243,255,.9)';ctx.font='11px Inter';ctx.fillText(`${segLength(a,b).toFixed(2)} мм`,(pa.x+pb.x)/2+6,(pa.y+pb.y)/2-6);}}
function drawEditorCanvas(ctx,canvas,mini=false){ctx.clearRect(0,0,canvas.width,canvas.height);const tr=makeTransform(canvas);if(!mini)state.canvasTransform=tr;drawGrid(ctx,canvas,tr);drawBlank(ctx,tr);drawAxes(ctx,canvas,tr);for(let i=1;i<state.contourPoints.length;i++)drawSegment(ctx,tr,state.contourPoints[i-1],state.contourPoints[i],i,mini);if(state.closed&&state.contourPoints.length>2)drawSegment(ctx,tr,state.contourPoints.at(-1),{...state.contourPoints[0],type:'lineZ'},-1,mini);state.contourPoints.forEach((p,i)=>{const q=tr.toPx(p),m=TYPE_META[p.type]||TYPE_META.lineX;ctx.fillStyle=i===state.selectedIndex?'#fff':m.color;ctx.beginPath();ctx.arc(q.x,q.y,i===state.selectedIndex?7:5,0,Math.PI*2);ctx.fill();if(state.showLabels&&!mini){ctx.fillStyle='#edf4ff';ctx.font='bold 12px Inter';ctx.fillText(String(i+1),q.x+7,q.y-8);}});if(state.showLegend&&!mini){let x=18,y=canvas.height-16;for(const k of ['lineX','lineZ','arcCW','arcCCW','chamfer']){ctx.fillStyle=TYPE_META[k].color;ctx.fillRect(x,y-7,18,3);ctx.fillStyle='#dfe9f8';ctx.font='11px Inter';ctx.fillText(TYPE_META[k].label,x+24,y-2);x+=ctx.measureText(TYPE_META[k].label).width+72;}}}

function renderStats(){const c={lineX:0,lineZ:0,arcCW:0,arcCCW:0,chamfer:0};state.contourPoints.slice(1).forEach(p=>c[p.type]=(c[p.type]||0)+1);$('contourStats').innerHTML=`<span class="stat-chip">Точек <strong>${state.contourPoints.length}</strong></span><span class="stat-chip type-lineX">Линий <strong>${c.lineX+c.lineZ}</strong></span><span class="stat-chip type-arcCW">Дуг <strong>${c.arcCW+c.arcCCW}</strong></span><span class="stat-chip type-chamfer">Фасок <strong>${c.chamfer}</strong></span><span class="stat-chip">Длина <strong>${totalLength().toFixed(3)} мм</strong></span>`;}
function renderTable(){$('contourTableBody').innerHTML=state.contourPoints.map((p,i)=>`<tr data-i="${i}" class="${i===state.selectedIndex?'selected':''}"><td>${i+1}</td><td>X${fmt(state.xMode==='radius'?p.x/2:p.x)}</td><td>Z${fmt(p.z)}</td><td><span class="type-pill" style="--pill:${TYPE_META[p.type].color}">${TYPE_META[p.type].label}</span></td><td>${escapeHtml(p.rv||'—')}</td><td>${escapeHtml(p.direction||'—')}</td></tr>`).join('');document.querySelectorAll('#contourTableBody tr').forEach(r=>r.onclick=()=>{state.selectedIndex=Number(r.dataset.i);renderEditor();renderChamferEditor();});}
function renderLegend(){const html=['lineX','lineZ','arcCW','arcCCW','chamfer'].map(k=>`<span class="legend-badge"><i style="background:${TYPE_META[k].color}"></i>${TYPE_META[k].label}</span>`).join('');$('legendInline').innerHTML=html;$('legendStack').innerHTML=['lineX','lineZ','arcCW','arcCCW','chamfer'].map(k=>`<div class="legend-item"><i style="background:${TYPE_META[k].color}"></i><span>${TYPE_META[k].label}</span></div>`).join('');}
function renderStep(){const i=state.selectedIndex,p=state.contourPoints[i],prev=state.contourPoints[Math.max(0,i-1)],m=TYPE_META[p.type];$('stepBadge').textContent=`Шаг ${i+1} из ${state.contourPoints.length}`;$('stepTitle').textContent=m.label;$('sinType').textContent=m.sin;$('sinX').textContent=fmt(state.xMode==='radius'?p.x/2:p.x);$('sinZ').textContent=fmt(p.z);$('currentElementType').textContent=m.label;$('currentElementType').style.color=m.color;$('currentElementLength').textContent=i?`${segLength(prev,p).toFixed(3)} мм`:'0.000 мм';$('currentElementDirection').textContent=p.direction||m.direction;const ins=i===0?['Открой Stock Removal → New Contour.','Задай начальную точку.',`Введи X ${fmt(p.x)} и Z ${fmt(p.z)}.`,`Нажми Accept.`]:[`Выбери ${m.sin}.`,`Введи X ${fmt(p.x)} и Z ${fmt(p.z)}.`,p.rv&&p.rv!=='—'?`Задай ${p.rv}.`:'Дополнительный параметр не нужен.','Нажми Accept.'];$('stepInstructions').innerHTML=ins.map(x=>`<li>${x}</li>`).join('');}
function renderMeta(){const a=state.contourPoints[0],b=state.contourPoints.at(-1);$('startPointInfo').textContent=`X${fmt(a.x)} Z${fmt(a.z)}`;$('endPointInfo').textContent=`X${fmt(b.x)} Z${fmt(b.z)}`;$('contourTypeInfo').textContent=state.closed?'Закрытый':'Открытый';$('contourLengthInfo').textContent=`${totalLength().toFixed(3)} мм`;}
function renderValidation(){const box=$('validationList');if(!state.validation.length){box.innerHTML='<div class="validation-empty">Нажми «Проверить»</div>';$('validationBadge').textContent='Не проверен';$('validationBadge').className='badge';return;}box.innerHTML=state.validation.map(v=>`<div class="validation-item ${v.level}"><strong>${v.level==='error'?'Ошибка':v.level==='warn'?'Внимание':'Готово'}</strong><span>${escapeHtml(v.text)}</span></div>`).join('');const errors=state.validation.filter(v=>v.level==='error').length,warns=state.validation.filter(v=>v.level==='warn').length;$('validationBadge').textContent=errors?`${errors} ошибок`:warns?`${warns} замечаний`:'Контур готов';$('validationBadge').className=`badge ${errors?'badge-error':warns?'badge-warn':'badge-ok'}`;}
function renderEditor(){
  renderStats(); renderTable(); renderLegend();
  if(!state.contourPoints.length){
    contourCtx.clearRect(0,0,contourCanvas.width,contourCanvas.height); miniCtx.clearRect(0,0,miniCanvas.width,miniCanvas.height);
    [contourCtx,miniCtx].forEach((c,idx)=>{const cv=idx?miniCanvas:contourCanvas;c.fillStyle='rgba(120,150,185,.16)';c.fillRect(0,0,cv.width,cv.height);c.fillStyle='rgba(225,236,250,.72)';c.font='bold 18px Inter';c.textAlign='center';c.fillText('Контур не создан',cv.width/2,cv.height/2-8);c.font='13px Inter';c.fillText('Добавь первую точку или запусти AI-контур',cv.width/2,cv.height/2+18);c.textAlign='start';});
    $('startPointInfo').textContent='—';$('endPointInfo').textContent='—';$('contourTypeInfo').textContent='Пустой';$('contourLengthInfo').textContent='0.000 мм';
    $('stepBadge').textContent='Шаг 0';$('stepTitle').textContent='Контур пуст';$('sinType').textContent='—';$('sinX').textContent='—';$('sinZ').textContent='—';$('currentElementType').textContent='—';$('currentElementLength').textContent='—';$('currentElementDirection').textContent='—';$('stepInstructions').innerHTML='<li>Добавь первую точку X/Z.</li>';
    $('editPointBtn').disabled=true;$('duplicatePointBtn').disabled=true;$('deletePointBtn').disabled=true;$('reverseContourBtn').disabled=true;$('mirrorZBtn').disabled=true;$('mirrorXBtn').disabled=true;$('rotateContourBtn').disabled=true;
    renderValidation();updateUndoButtons();renderChamferEditor();return;
  }
  state.selectedIndex=Math.max(0,Math.min(state.selectedIndex,state.contourPoints.length-1));
  $('editPointBtn').disabled=false;$('duplicatePointBtn').disabled=false;$('deletePointBtn').disabled=state.contourPoints.length<=1;$('reverseContourBtn').disabled=state.contourPoints.length<2;$('mirrorZBtn').disabled=false;$('mirrorXBtn').disabled=false;$('rotateContourBtn').disabled=false;
  drawEditorCanvas(contourCtx,contourCanvas,false);drawEditorCanvas(miniCtx,miniCanvas,true);renderStep();renderMeta();renderValidation();updateUndoButtons();renderChamferEditor();
}

function validateContour(){const out=[];if(state.contourPoints.length<2)out.push({level:'error',text:'Нужно минимум две точки.'});if(!state.contourPoints.length){state.validation=out;renderValidation();return false;}const d=number($('blankDiameter').value,0),l=number($('blankLength').value,0);state.contourPoints.forEach((p,i)=>{if(!Number.isFinite(p.x)||!Number.isFinite(p.z))out.push({level:'error',text:`Точка ${i+1}: некорректная координата.`});if(p.x<0)out.push({level:'error',text:`Точка ${i+1}: X меньше нуля.`});if(d>0&&p.x>d+0.001)out.push({level:'warn',text:`Точка ${i+1}: X выходит за диаметр заготовки.`});if(l>0&&(p.z>0.001||p.z<-l-0.001))out.push({level:'warn',text:`Точка ${i+1}: Z выходит за длину заготовки.`});if(i>0&&Math.hypot(p.x-state.contourPoints[i-1].x,p.z-state.contourPoints[i-1].z)<0.0001)out.push({level:'error',text:`Точки ${i} и ${i+1} совпадают.`});if(['arcCW','arcCCW'].includes(p.type)&&!parseRadius(p.rv))out.push({level:'error',text:`Точка ${i+1}: для дуги нужен радиус R.`});});if(state.contourPoints[0].type!=='start')out.push({level:'error',text:'Первая точка должна быть начальной.'});if(!out.length)out.push({level:'ok',text:'Координаты и базовая геометрия прошли проверку.'});state.validation=out;renderValidation();return !out.some(v=>v.level==='error');}
$('validateContourBtn').onclick=()=>{validateContour();toast('Проверка завершена');};

function openPointModal(mode){if(mode==='edit'&&!state.contourPoints.length)return;state.pointModalMode=mode;const p=mode==='edit'?state.contourPoints[state.selectedIndex]:{x:state.contourPoints[state.selectedIndex]?.x||0,z:state.contourPoints[state.selectedIndex]?.z||0,type:'lineX',rv:'—',direction:'по X'};$('pointModalTitle').textContent=mode==='edit'?`Редактирование точки ${state.selectedIndex+1}`:'Добавление точки';$('pointXInput').value=state.xMode==='radius'?p.x/2:p.x;$('pointZInput').value=p.z;$('pointTypeSelect').value=p.type==='start'?'lineX':p.type;$('pointRvInput').value=p.rv||'—';$('pointDirectionInput').value=p.direction||TYPE_META[p.type]?.direction||'—';$('pointInsertSelect').innerHTML=state.contourPoints.length?state.contourPoints.map((_,i)=>`<option value="${i}" ${i===state.selectedIndex?'selected':''}>После точки ${i+1}</option>`).join(''):'<option value="-1">Первая точка</option>';$('pointInsertSelect').disabled=mode==='edit'||!state.contourPoints.length;$('pointModal').classList.remove('hidden');}
function closePointModal(){$('pointModal').classList.add('hidden');}
document.querySelectorAll('[data-close-modal]').forEach(x=>x.onclick=closePointModal);
$('savePointModalBtn').onclick=()=>{const x=storeX(number($('pointXInput').value,NaN)),z=number($('pointZInput').value,NaN);if(!Number.isFinite(x)||!Number.isFinite(z))return toast('Проверь X и Z');const p={x:snapValue(x),z:snapValue(z),type:$('pointTypeSelect').value,rv:$('pointRvInput').value||'—',direction:$('pointDirectionInput').value||'—'};pushUndo();if(state.pointModalMode==='edit'){if(state.selectedIndex===0)p.type='start';state.contourPoints[state.selectedIndex]=p;}else{const idx=state.contourPoints.length?Number($('pointInsertSelect').value)+1:0;if(idx===0)p.type='start';state.contourPoints.splice(idx,0,p);state.selectedIndex=idx;}state.validation=[];closePointModal();renderEditor();scheduleAutosave();};
$('addPointBtn').onclick=()=>openPointModal('add');$('editPointBtn').onclick=()=>openPointModal('edit');
$('duplicatePointBtn').onclick=()=>{if(!state.contourPoints.length)return;pushUndo();const p=clone(state.contourPoints[state.selectedIndex]);p.type=state.selectedIndex===0?'lineX':p.type;state.contourPoints.splice(state.selectedIndex+1,0,p);state.selectedIndex++;state.validation=[];renderEditor();scheduleAutosave();};
$('deletePointBtn').onclick=()=>{if(!state.contourPoints.length)return;if(state.contourPoints.length===1){pushUndo();state.contourPoints=[];state.selectedIndex=0;state.validation=[];renderEditor();scheduleAutosave();return;}if(state.contourPoints.length<=2&&!confirm('После удаления останется одна точка. Продолжить?'))return;pushUndo();state.contourPoints.splice(state.selectedIndex,1);state.selectedIndex=Math.max(0,state.selectedIndex-1);state.contourPoints[0].type='start';state.validation=[];renderEditor();scheduleAutosave();};
$('reverseContourBtn').onclick=()=>{pushUndo();const old=clone(state.contourPoints),rev=old.slice().reverse();for(let i=0;i<rev.length;i++){const source=i<rev.length-1?old[old.length-1-i]:old[1]||old[0];rev[i].type=i===0?'start':source.type;if(rev[i].type==='arcCW')rev[i].type='arcCCW';else if(rev[i].type==='arcCCW')rev[i].type='arcCW';}state.contourPoints=rev;state.selectedIndex=0;state.validation=[];renderEditor();scheduleAutosave();};

$('mirrorZBtn').onclick=()=>{if(!state.contourPoints.length)return;const axis=number($('mirrorAxisZInput').value,0);pushUndo();state.contourPoints.forEach(p=>p.z=2*axis-p.z);state.contourPoints.forEach((p,i)=>{if(i&&p.type==='arcCW')p.type='arcCCW';else if(i&&p.type==='arcCCW')p.type='arcCW';});state.validation=[];renderEditor();scheduleAutosave();toast(`Контур отражён относительно Z=${axis}`);};
$('mirrorXBtn').onclick=()=>{if(!state.contourPoints.length)return;const axis=storeX(number($('mirrorAxisXInput').value,0));pushUndo();state.contourPoints.forEach(p=>p.x=2*axis-p.x);state.validation=[];renderEditor();scheduleAutosave();toast(`Контур отражён относительно X=${number($('mirrorAxisXInput').value,0)}`);};
$('rotateContourBtn').onclick=()=>{if(!state.contourPoints.length)return;const axisX=storeX(number($('mirrorAxisXInput').value,0)),axisZ=number($('mirrorAxisZInput').value,0);pushUndo();state.contourPoints.forEach(p=>{p.x=2*axisX-p.x;p.z=2*axisZ-p.z;});state.validation=[];renderEditor();scheduleAutosave();toast('Контур повёрнут на 180° вокруг заданных осей');};
$('closeContourBtn').onclick=()=>{pushUndo();state.closed=!state.closed;$('closeContourBtn').textContent=state.closed?'Разомкнуть':'Замкнуть';state.validation=[];renderEditor();scheduleAutosave();};
$('applyOffsetBtn').onclick=()=>{const dx=number($('offsetXInput').value,0),dz=number($('offsetZInput').value,0);if(!dx&&!dz)return toast('Введи ΔX или ΔZ');pushUndo();state.contourPoints.forEach(p=>{p.x+=storeX(dx);p.z+=dz;});state.validation=[];renderEditor();scheduleAutosave();};

function canvasPoint(e){const r=contourCanvas.getBoundingClientRect();return{x:(e.clientX-r.left)*contourCanvas.width/r.width,y:(e.clientY-r.top)*contourCanvas.height/r.height};}
function nearestIndex(px,py){if(!state.canvasTransform)return-1;let best=-1,dist=16;state.contourPoints.forEach((p,i)=>{const q=state.canvasTransform.toPx(p),d=Math.hypot(q.x-px,q.y-py);if(d<dist){dist=d;best=i;}});return best;}
contourCanvas.onpointerdown=e=>{const p=canvasPoint(e),i=nearestIndex(p.x,p.y);if(i<0)return;state.selectedIndex=i;state.draggingPoint=true;state.dragSnapshotTaken=false;contourCanvas.setPointerCapture(e.pointerId);renderEditor();};
contourCanvas.onpointermove=e=>{if(!state.draggingPoint)return;if(!state.dragSnapshotTaken){pushUndo();state.dragSnapshotTaken=true;}const p=canvasPoint(e),v=state.canvasTransform.fromPx(p.x,p.y),item=state.contourPoints[state.selectedIndex];item.x=Math.max(0,snapValue(v.x));item.z=snapValue(v.z);state.validation=[];renderEditor();};
contourCanvas.onpointerup=()=>{if(state.draggingPoint){state.draggingPoint=false;scheduleAutosave();}};
contourCanvas.onwheel=e=>{e.preventDefault();state.zoom=Math.max(.35,Math.min(3,state.zoom*(e.deltaY<0?1.08:.92)));renderEditor();};

$('zoomInBtn').onclick=()=>{state.zoom=Math.min(3,state.zoom+.12);renderEditor();};$('zoomOutBtn').onclick=()=>{state.zoom=Math.max(.35,state.zoom-.12);renderEditor();};$('fitGraphBtn').onclick=()=>{state.zoom=1;renderEditor();};
$('prevStepBtn').onclick=()=>{state.selectedIndex=Math.max(0,state.selectedIndex-1);renderEditor();};$('nextStepBtn').onclick=()=>{state.selectedIndex=Math.min(state.contourPoints.length-1,state.selectedIndex+1);renderEditor();};$('contourAcceptBtn').onclick=()=>{if(state.selectedIndex<state.contourPoints.length-1){state.selectedIndex++;toast('Элемент принят. Переход к следующей точке.');}else toast('Последний элемент принят. Контур готов к проверке.');renderEditor();};$('contourCancelBtn').onclick=()=>{state.selectedIndex=Math.max(0,state.selectedIndex-1);renderEditor();toast('Возврат к предыдущему элементу без изменения данных.');};
$('toggleGrid').onchange=e=>{state.showGrid=e.target.checked;renderEditor();};$('toggleAxes').onchange=e=>{state.showAxes=e.target.checked;renderEditor();};$('toggleLegend').onchange=e=>{state.showLegend=e.target.checked;renderEditor();};
$('snapToggle').onchange=e=>{state.snap=e.target.checked;scheduleAutosave();};$('snapStepInput').oninput=e=>{state.snapStep=Math.max(.001,number(e.target.value,.1));scheduleAutosave();};$('blankOverlayToggle').onchange=e=>{state.showBlank=e.target.checked;renderEditor();scheduleAutosave();};$('labelsToggle').onchange=e=>{state.showLabels=e.target.checked;renderEditor();scheduleAutosave();};$('dimensionsToggle').onchange=e=>{state.showDimensions=e.target.checked;renderEditor();scheduleAutosave();};
$('xModeSelect').onchange=e=>{state.xMode=e.target.value;renderEditor();scheduleAutosave();};$('processSelect').onchange=e=>{state.process=e.target.value;scheduleAutosave();};$('z0Select').onchange=e=>{state.z0=e.target.value;scheduleAutosave();};

function download(name,type,content){const blob=new Blob([content],{type}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
$('exportJsonBtn').onclick=()=>download('contour-xz.json','application/json',JSON.stringify({version:2,settings:collectEditorSettings(),points:state.contourPoints},null,2));
$('exportCsvBtn').onclick=()=>download('contour-xz.csv','text/csv;charset=utf-8','№;X;Z;Тип;R/Угол;Направление\n'+state.contourPoints.map((p,i)=>`${i+1};${p.x};${p.z};${TYPE_META[p.type].label};${p.rv};${p.direction}`).join('\n'));
function sinumerikText(){const valid=validateContour(),st=collectShopTurnData(),op=SHOP_OPERATIONS[st.operation]||{label:'Операция не выбрана'},route=state.operationRoute.filter(o=>o.enabled!==false),head=[`PERSONAL AI CLIENT PRO · SHOPTURN FLOW`,`ROZFOOD`,`Станок: ${st.machineProfile==='tengyue_ck52pty'?'Tengyue CK52PT-Y · Siemens SINUMERIK 828D / ShopTurn':'Пользовательский профиль'}`,`Дата: ${new Date().toLocaleString('ru-RU')}`,`Операция: ${op.label}`,`Инструмент: T${st.toolT} D${st.toolD} · ${st.toolName} · ${st.holder} · ${st.insert}`,`Режим: S=${st.speed} · F=${st.feed} · глубина=${st.depth} · СОЖ=${st.coolant?'ON':'OFF'}`,`Цикл: Machining=${st.machining} · Pos=${st.position} · X0=${st.x0} · Z0=${st.z0} · X1=${st.x1}${st.incrementMode==='incremental'?' INC':''} · Z1=${st.z1}${st.incrementMode==='incremental'?' INC':''}`,`FS1=${st.fs1} · FS2=${st.fs2} · FS3=${st.fs3} · UX=${st.ux} · UZ=${st.uz}`,`X: ${state.xMode==='diameter'?'диаметр':'радиус'}`,`Z0: ${state.z0==='right'?'правый торец':'левый торец'}`,`Проверка: ${valid?'ПРОЙДЕНА':'ЕСТЬ ОШИБКИ'}`,'',`Резьбы проекта: ${state.projectThreads.map(t=>`${t.designation}×${t.pitch}`).join(', ')||'нет'}`,`Фаски/кромки: ${state.chamfers.map(c=>c.mode==='chamfer'?c.notation:c.mode==='edge_break'?'снять остроту':'нет').join(', ')||'нет'}`,'', 'МАРШРУТ ОПЕРАЦИЙ:',...route.map((o,i)=>`${i+1}. ${o.label||o.operation} · T${o.toolT||'?'} D${o.toolD||'?'} · ${o.toolName||'—'} · S=${o.speed||'—'} F=${o.feed||'—'}`),'','КОНТУР X/Z:'];const lines=state.contourPoints.map((p,i)=>{const m=TYPE_META[p.type];return `${String(i+1).padStart(3,'0')} | ${m.sin.padEnd(12)} | X=${fmt(p.x)} | Z=${fmt(p.z)} | ${p.rv||'—'} | ${p.direction||'—'}`;});const steps=buildShopTurnSteps().map((s,i)=>`${i+1}. ${s.title}: ${s.instruction.replace(/<[^>]*>/g,'')}`);return [...head,...lines,'','ПОШАГОВЫЙ ВВОД SHOPTURN:',...steps,'','ВНИМАНИЕ: карта ввода, а не готовая NC-программа. Сверить с исходным чертежом, инструментом и фактической заготовкой перед Cycle Start.'].join('\n');}
$('exportSinumerikBtn').onclick=()=>{const valid=validateContour();if(!valid&&!confirm('В контуре есть ошибки. Всё равно экспортировать?'))return;download('sinumerik-828d-contour.txt','text/plain;charset=utf-8',sinumerikText());};
$('importBtn').onclick=()=>$('importContourInput').click();$('importContourInput').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const txt=await f.text();let points;if(f.name.toLowerCase().endsWith('.json')){const d=JSON.parse(txt);points=Array.isArray(d)?d:d.points;if(d.settings)applyEditorSettings(d.settings);}else{const rows=txt.trim().split(/\r?\n/).slice(1);points=rows.map(r=>{const c=r.split(';');return{x:number(c[1]),z:number(c[2]),type:Object.keys(TYPE_META).find(k=>TYPE_META[k].label===c[3])||'lineX',rv:c[4]||'—',direction:c[5]||'—'};});}if(!Array.isArray(points)||points.length<2)throw new Error();pushUndo();state.contourPoints=points.map((p,i)=>({x:number(p.x),z:number(p.z),type:i===0?'start':TYPE_META[p.type]?p.type:'lineX',rv:p.rv||'—',direction:p.direction||'—'}));state.selectedIndex=0;state.validation=[];renderEditor();scheduleAutosave();toast('Контур импортирован');}catch{toast('Не удалось импортировать файл');}e.target.value='';};

function collectEditorSettings(){return{xMode:state.xMode,process:state.process,z0:state.z0,closed:state.closed,snap:state.snap,snapStep:state.snapStep,showBlank:state.showBlank,showLabels:state.showLabels,showDimensions:state.showDimensions};}
function applyEditorSettings(s={}){Object.assign(state,{xMode:s.xMode||'diameter',process:s.process||'outer',z0:s.z0||'right',closed:!!s.closed,snap:s.snap!==false,snapStep:number(s.snapStep,.1),showBlank:s.showBlank!==false,showLabels:s.showLabels!==false,showDimensions:!!s.showDimensions});$('xModeSelect').value=state.xMode;$('processSelect').value=state.process;$('z0Select').value=state.z0;$('snapToggle').checked=state.snap;$('snapStepInput').value=state.snapStep;$('blankOverlayToggle').checked=state.showBlank;$('labelsToggle').checked=state.showLabels;$('dimensionsToggle').checked=state.showDimensions;$('closeContourBtn').textContent=state.closed?'Разомкнуть':'Замкнуть';}
function collectProjectData(){return{contourPoints:state.contourPoints,editor:collectEditorSettings(),shopturn:collectShopTurnData(),operationRoute:state.operationRoute,projectThreads:state.projectThreads,chamfers:state.chamfers,drawingIntel:state.drawingIntel,stockMode:state.stockMode,blank:{diameter:$('blankDiameter').value,length:$('blankLength').value,width:$('blankWidth').value,height:$('blankHeight').value,millLength:$('blankLengthMill').value},zeroReference:$('zeroReference').value,firstSide:$('firstSide').value,notes:$('stockNotes').value,fileName:state.file?.name||state.restoredFileName||null,updatedAt:Date.now()};}
function applyProjectData(d={}){state.restoredFileName=d.fileName||null;state.contourPoints=Array.isArray(d.contourPoints)?clone(d.contourPoints):[];applyEditorSettings(d.editor||{});state.stockMode=d.stockMode||'lathe';document.querySelectorAll('.segmented-item').forEach(b=>b.classList.toggle('active',b.dataset.mode===state.stockMode));$('latheFields').classList.toggle('hidden',state.stockMode!=='lathe');$('millFields').classList.toggle('hidden',state.stockMode!=='mill');const b=d.blank||{};$('blankDiameter').value=b.diameter||'';$('blankLength').value=b.length||'';$('blankWidth').value=b.width||'';$('blankHeight').value=b.height||'';$('blankLengthMill').value=b.millLength||'';$('zeroReference').value=d.zeroReference||'';$('firstSide').value=d.firstSide||'';$('stockNotes').value=d.notes||'';applyShopTurnData(d.shopturn||{});state.operationRoute=Array.isArray(d.operationRoute)?clone(d.operationRoute):[];state.selectedOperationCodes=[];state.projectThreads=Array.isArray(d.projectThreads)?clone(d.projectThreads):[];state.chamfers=Array.isArray(d.chamfers)?clone(d.chamfers):[];state.drawingIntel=d.drawingIntel||{tolerances:[],tolerance_interpretations:[],threads:[],chamfers_detected:[],requires_chamfer_decision:true,notes:[]};if((state.drawingIntel.tolerances?.length||state.drawingIntel.threads?.length||state.chamfers.length||state.projectThreads.length))$('drawingIntelligencePanel').classList.remove('hidden');state.selectedIndex=0;state.activeRouteIndex=-1;state.validation=[];renderDrawingIntelligence();renderProjectThreads();renderChamferEditor();renderOperationRoute();renderOperationMultiPicker();renderEditor();syncFileUi();}
function scheduleAutosave(){clearTimeout(state.autosaveTimer);clearTimeout(state.serverSaveTimer);$('autosaveState').textContent='Сохранение...';state.autosaveTimer=setTimeout(()=>{localStorage.setItem('personal-ai-pro-draft',JSON.stringify(collectProjectData()));$('autosaveState').textContent=state.currentProjectId?'Локально сохранено · синхронизация...':'Автосохранено локально';},450);if(state.currentProjectId){state.serverSaveTimer=setTimeout(async()=>{try{const r=await fetch(`/api/projects/${state.currentProjectId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:state.currentProjectName,data:collectProjectData()})});if(r.ok)$('autosaveState').textContent='Синхронизировано с Railway Volume';else $('autosaveState').textContent='Локально сохранено · ошибка синхронизации';}catch{$('autosaveState').textContent='Локально сохранено · сервер недоступен';}},1400);}}
function loadLocalDraft(){try{const d=JSON.parse(localStorage.getItem('personal-ai-pro-draft')||'null');if(d)applyProjectData(d);}catch{}}

async function saveProject(forceCreate=false){const generated=`Проект ${new Date().toLocaleDateString('ru-RU')} ${new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}`;const name=state.currentProjectName==='Локальный черновик'?($('projectNameInput').value.trim()||generated):state.currentProjectName;if(!name.trim())return;const payload={name:name.trim(),data:collectProjectData()};try{const method=state.currentProjectId&&!forceCreate?'PUT':'POST',url=state.currentProjectId&&!forceCreate?`/api/projects/${state.currentProjectId}`:'/api/projects';const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok)throw new Error(d.detail||'Ошибка сохранения');state.currentProjectId=d.id;state.currentProjectName=d.name;updateProjectUi();$('autosaveState').textContent='Сохранено на Railway Volume';toast('Проект сохранён');}catch(e){toast(e.message);}}
$('saveProjectBtn').onclick=()=>saveProject(false);$('createProjectBtn').onclick=async()=>{const name=$('projectNameInput').value.trim()||`Проект ${new Date().toLocaleString('ru-RU')}`;resetWorkspaceForNewProject();state.currentProjectName=name;updateProjectUi();await saveProject(true);};
function resetWorkspaceForNewProject(){
  state.currentProjectId=null;state.currentProjectName='Локальный черновик';state.file=null;state.restoredFileName=null;state.image=null;state.crop=null;state.contourPoints=[];state.selectedIndex=0;state.undoStack=[];state.redoStack=[];state.validation=[];state.operationRoute=[];state.selectedOperationCodes=[];state.activeRouteIndex=-1;state.projectThreads=[];state.chamfers=[];state.drawingIntel={tolerances:[],tolerance_interpretations:[],threads:[],chamfers_detected:[],requires_chamfer_decision:true,notes:[]};
  fileInput.value='';dropZone.classList.remove('hidden');previewArea.classList.add('hidden');pdfPreview.src='';
  ['promptInput','blankDiameter','blankLength','blankWidth','blankHeight','blankLengthMill','zeroReference','firstSide','stockNotes','offsetXInput','offsetZInput'].forEach(id=>{if($(id))$(id).value='';});
  ['confirmDrawing','confirmBlank','confirmZero','confirmTool'].forEach(id=>{if($(id))$(id).checked=false;});
  SHOP_INPUT_IDS.forEach(id=>{const el=$(id);if(!el)return;if(el.type==='checkbox')el.checked=false;else if(el.tagName==='SELECT')el.selectedIndex=0;else el.value='';});
  state.shopturn.wizardStep=0;populateToolPresets('');resetChat('analysis',true);resetChat('stock',true);
  $('resultContent').classList.add('hidden');$('resultEmpty').classList.remove('hidden');$('resultMeta').textContent='';$('stockResultContent').classList.add('hidden');$('stockResultEmpty').classList.remove('hidden');$('stockResultMeta').textContent='';$('drawingIntelligencePanel').classList.add('hidden');
  localStorage.removeItem('personal-ai-pro-draft');updateProjectUi();syncFileUi();renderDrawingIntelligence();renderProjectThreads();renderChamferEditor();renderOperationRoute();renderOperationMultiPicker();renderEditor();renderShopTurn();scheduleAutosave();
}
$('newProjectBtn').onclick=()=>{resetWorkspaceForNewProject();toast('Новый проект создан. Все рабочие поля очищены, история сохранена.');};
async function loadProjects(){const list=$('projectsList');list.innerHTML='<div class="result-empty"><span>Загрузка...</span></div>';try{const r=await fetch('/api/projects');const items=await r.json();if(!items.length){list.innerHTML='<div class="result-empty"><strong>Проектов пока нет</strong></div>';return;}list.innerHTML=items.map(p=>`<div class="project-item"><div><h3>${escapeHtml(p.name)}</h3><small>Обновлён ${new Date(p.updated_at*1000).toLocaleString('ru-RU')}</small></div><div><button data-load="${p.id}">Открыть</button><button data-del="${p.id}" class="danger-lite">Удалить</button></div></div>`).join('');list.querySelectorAll('[data-load]').forEach(b=>b.onclick=async()=>{const r=await fetch(`/api/projects/${b.dataset.load}`),d=await r.json();if(!r.ok)return toast(d.detail||'Ошибка');state.currentProjectId=d.id;state.currentProjectName=d.name;applyProjectData(d.data);updateProjectUi();setView('stock');toast('Проект открыт');});list.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Удалить проект?'))return;await fetch(`/api/projects/${b.dataset.del}`,{method:'DELETE'});loadProjects();});}catch(e){list.innerHTML=`<div class="result-empty"><strong>${escapeHtml(e.message)}</strong></div>`;}}


function normalizeChamferNotation(value){
  const raw=String(value||'').trim().replace(/[xх]/gi,'×').replace(/\s+/g,'');
  if(!raw)return '1×45°';
  const m=raw.match(/^(\d+(?:[.,]\d+)?)×(\d+(?:[.,]\d+)?)(?:°)?$/);
  return m?`${m[1].replace(',','.')}×${m[2].replace(',','.')}°`:raw;
}
function applyDrawingIntelligence(data={}){
  state.drawingIntel={tolerances:Array.isArray(data.tolerances)?data.tolerances:[],tolerance_interpretations:Array.isArray(data.tolerance_interpretations)?data.tolerance_interpretations:[],threads:Array.isArray(data.threads)?data.threads:[],chamfers_detected:Array.isArray(data.chamfers_detected)?data.chamfers_detected:[],requires_chamfer_decision:data.requires_chamfer_decision!==false,notes:Array.isArray(data.notes)?data.notes:[]};
  $('drawingIntelligencePanel').classList.remove('hidden');renderDrawingIntelligence();scheduleAutosave();
}
function renderDrawingIntelligence(){
  if(!$('toleranceList'))return;
  const t=state.drawingIntel.tolerances||[],rules=state.drawingIntel.tolerance_interpretations||[],threads=state.drawingIntel.threads||[];
  const toleranceTokens=t.map(x=>`<div class="intel-token tolerance-token">${escapeHtml(x)}</div>`).join('');
  const ruleCards=rules.map(x=>`<div class="tolerance-rule-card"><strong>${escapeHtml(x.designation)}</strong><span>${escapeHtml(x.display)}</span><small>${escapeHtml(x.application||'')}</small></div>`).join('');
  $('toleranceList').innerHTML=(toleranceTokens+ruleCards)||'<span class="muted-text">Явные допуски не распознаны. Проверь основную надпись и технические требования.</span>';
  $('detectedThreadList').innerHTML=threads.length?threads.map((x,i)=>`<button class="detected-thread" data-thread-index="${i}"><strong>${escapeHtml(x.display||`${x.designation}×${x.pitch}`)}</strong><span>${x.pitch_source==='iso_coarse_default'?'крупный шаг принят автоматически':'шаг указан на чертеже'}</span></button>`).join(''):'<span class="muted-text">Резьбы не распознаны.</span>';
  $('drawingIntelBadge').textContent=`Допуски: ${t.length} · Правила: ${rules.length} · Резьбы: ${threads.length}`;
  document.querySelectorAll('[data-thread-index]').forEach(btn=>btn.onclick=()=>selectDetectedThread(Number(btn.dataset.threadIndex)));
  if(state.drawingIntel.chamfers_detected?.length&&!state.chamfers.length)$('chamferNotationInput').value=normalizeChamferNotation(state.drawingIntel.chamfers_detected[0]);
}
async function loadThreadCatalog(){
  try{const r=await fetch('/api/thread-catalog');const d=await r.json();if(!r.ok)throw new Error();state.threadCatalog=d.items||[];populateThreadCatalog();}catch{state.threadCatalog=[];$('threadDesignationSelect').innerHTML='<option value="M8">M8</option>';$('threadPitchSelect').innerHTML='<option value="1.25">1.25</option>';}
}
function populateThreadCatalog(selected='M8'){
  const sel=$('threadDesignationSelect');if(!sel)return;sel.innerHTML=state.threadCatalog.map(x=>`<option value="${x.designation}" ${x.designation===selected?'selected':''}>${x.designation}</option>`).join('');updateThreadPitchOptions();
}
function updateThreadPitchOptions(preferred=null){
  const item=state.threadCatalog.find(x=>x.designation===$('threadDesignationSelect').value)||state.threadCatalog[0];if(!item)return;const pitches=[...new Set(item.pitches||[item.coarse])].sort((a,b)=>a-b);$('threadPitchSelect').innerHTML=pitches.map(p=>`<option value="${p}" ${(preferred??item.coarse)==p?'selected':''}>${p}${p==item.coarse?' · крупный':''}</option>`).join('');
}
function selectDetectedThread(index=0){
  const thread=state.drawingIntel.threads?.[index];if(!thread)return toast('Распознанная резьба не найдена');populateThreadCatalog(thread.designation);updateThreadPitchOptions(thread.pitch);$('threadToleranceInput').value=thread.tolerance_class||'';toast(`${thread.display} выбрана из распознавания`);
}
function selectedThread(){return{designation:$('threadDesignationSelect').value,pitch:number($('threadPitchSelect').value),side:$('threadSideSelect').value,tolerance:$('threadToleranceInput').value.trim(),source:'operator'};}
function renderProjectThreads(){
  if(!$('projectThreadList'))return;$('projectThreadList').innerHTML=state.projectThreads.length?state.projectThreads.map((t,i)=>`<div class="project-thread"><span><strong>${escapeHtml(t.designation)}×${escapeHtml(t.pitch)}</strong> · ${t.side==='internal'?'внутренняя':'наружная'} ${escapeHtml(t.tolerance||'')}</span><button data-remove-thread="${i}">×</button></div>`).join(''):'<div class="muted-text">Резьбы в проект не добавлены.</div>';
  document.querySelectorAll('[data-remove-thread]').forEach(b=>b.onclick=()=>{state.projectThreads.splice(Number(b.dataset.removeThread),1);renderProjectThreads();scheduleAutosave();});
}
$('threadDesignationSelect').onchange=()=>updateThreadPitchOptions();
$('applyDetectedThreadBtn').onclick=()=>selectDetectedThread(0);
$('addThreadToProjectBtn').onclick=()=>{const t=selectedThread();if(!t.designation||!t.pitch)return toast('Выбери резьбу и шаг');state.projectThreads.push(t);renderProjectThreads();if(['thread_ext','thread_int'].includes($('shopOperationSelect').value)){$('feedInput').value=t.pitch;$('toolInsertInput').value=`${$('shopOperationSelect').value==='thread_int'?'16IR':'16ER'} ${t.pitch} ISO`;renderShopTurn();}scheduleAutosave();toast(`${t.designation}×${t.pitch} добавлена`);};

function drawChamferBase(){
  if(!chamferCanvas)return;const w=chamferCanvas.width,h=chamferCanvas.height;chamferCtx.clearRect(0,0,w,h);chamferCtx.fillStyle='rgba(5,18,31,.72)';chamferCtx.fillRect(0,0,w,h);state.chamferTransform={type:'canvas'};
  if(state.image){const scale=Math.min((w-28)/state.image.naturalWidth,(h-28)/state.image.naturalHeight),dw=state.image.naturalWidth*scale,dh=state.image.naturalHeight*scale,dx=(w-dw)/2,dy=(h-dh)/2;chamferCtx.drawImage(state.image,dx,dy,dw,dh);state.chamferTransform={type:'image',dx,dy,dw,dh};}
  else if(state.contourPoints.length){const zs=state.contourPoints.map(p=>p.z),xs=state.contourPoints.map(p=>p.x),minZ=Math.min(...zs),maxZ=Math.max(...zs),minX=Math.min(...xs),maxX=Math.max(...xs),scale=Math.min((w-80)/Math.max(1,maxZ-minZ),(h-70)/Math.max(1,maxX-minX)),toPx=p=>({x:40+(p.z-minZ)*scale,y:h-35-(p.x-minX)*scale});chamferCtx.strokeStyle='#71c7ff';chamferCtx.lineWidth=4;chamferCtx.beginPath();state.contourPoints.forEach((p,i)=>{const q=toPx(p);i?chamferCtx.lineTo(q.x,q.y):chamferCtx.moveTo(q.x,q.y);});chamferCtx.stroke();state.chamferTransform={type:'contour',toPx};}
  else{chamferCtx.fillStyle='rgba(224,236,250,.72)';chamferCtx.font='bold 18px Inter';chamferCtx.textAlign='center';chamferCtx.fillText('Загрузи чертёж или создай контур',w/2,h/2);chamferCtx.textAlign='start';}
}
function renderChamferEditor(){
  if(!chamferCanvas)return;drawChamferBase();state.chamfers.forEach((m,i)=>{const x=m.x*chamferCanvas.width,y=m.y*chamferCanvas.height;chamferCtx.fillStyle=m.mode==='none'?'#ff6b6b':m.mode==='edge_break'?'#ffd166':'#63e6be';chamferCtx.beginPath();chamferCtx.arc(x,y,8,0,Math.PI*2);chamferCtx.fill();chamferCtx.strokeStyle='#fff';chamferCtx.lineWidth=2;chamferCtx.stroke();chamferCtx.fillStyle='#fff';chamferCtx.font='bold 13px Inter';chamferCtx.fillText(`${i+1}. ${m.mode==='edge_break'?'снять остроту':m.mode==='none'?'нет':m.notation}`,x+12,y-10);});
  $('chamferMarkerList').innerHTML=state.chamfers.length?state.chamfers.map((m,i)=>`<div class="chamfer-marker"><span><i>${i+1}</i>${m.mode==='edge_break'?'Снять остроту':m.mode==='none'?'Без обработки':escapeHtml(m.notation)}${m.contourIndex!==null&&m.contourIndex!==undefined?` · точка X/Z №${m.contourIndex+1}`:''}</span><button data-remove-chamfer="${i}">×</button></div>`).join(''):'<div class="muted-text">Точки фасок не поставлены.</div>';
  document.querySelectorAll('[data-remove-chamfer]').forEach(b=>b.onclick=()=>{state.chamfers.splice(Number(b.dataset.removeChamfer),1);renderChamferEditor();scheduleAutosave();});
}
chamferCanvas.onclick=e=>{const r=chamferCanvas.getBoundingClientRect(),px=(e.clientX-r.left)*chamferCanvas.width/r.width,py=(e.clientY-r.top)*chamferCanvas.height/r.height,x=px/chamferCanvas.width,y=py/chamferCanvas.height,mode=$('chamferModeSelect').value,notation=normalizeChamferNotation($('chamferNotationInput').value);let contourIndex=null;if(state.chamferTransform?.type==='contour'&&state.contourPoints.length){let best=Infinity;state.contourPoints.forEach((p,i)=>{const q=state.chamferTransform.toPx(p),d=Math.hypot(q.x-px,q.y-py);if(d<best){best=d;contourIndex=i;}});if(best>55)contourIndex=null;}state.chamfers.push({x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y)),mode,notation,contourIndex});if(contourIndex!==null&&contourIndex>0&&mode==='chamfer'){pushUndo();state.contourPoints[contourIndex].type='chamfer';state.contourPoints[contourIndex].rv=notation;state.contourPoints[contourIndex].direction='угол';} $('chamferNotationInput').value=notation;renderChamferEditor();renderEditor();scheduleAutosave();};
$('undoChamferBtn').onclick=()=>{state.chamfers.pop();renderChamferEditor();scheduleAutosave();};
$('clearChamfersBtn').onclick=()=>{state.chamfers=[];renderChamferEditor();scheduleAutosave();};
$('chamferNotationInput').onchange=e=>e.target.value=normalizeChamferNotation(e.target.value);

function collectShopTurnPayload(){return{...collectShopTurnData(),operations:state.operationRoute,threadSelection:selectedThread(),chamfers:state.chamfers};}
function makeOperationSnapshot(){const d=collectShopTurnData(),op=SHOP_OPERATIONS[d.operation]||{label:'Операция не выбрана'};return{...d,id:`op-${Date.now()}-${Math.random().toString(16).slice(2)}`,label:op.label,enabled:true,thread:['thread_ext','thread_int'].includes(d.operation)?selectedThread():{}};}
function renderOperationRoute(){
  if(!$('operationRouteList'))return;const enabled=state.operationRoute.filter(o=>o.enabled!==false),tools=new Set(enabled.map(o=>`${o.toolT}/${o.toolD}`));$('routeSummary').textContent=`Операций: ${state.operationRoute.length} · Активных: ${enabled.length} · Инструментов: ${tools.size}`;
  $('operationRouteList').innerHTML=state.operationRoute.length?state.operationRoute.map((o,i)=>`<article class="route-operation ${o.enabled===false?'disabled':''} ${i===state.activeRouteIndex?'active':''}"><div class="route-order">${i+1}</div><div class="route-main"><strong>${escapeHtml(o.label||o.operation||'Операция')}</strong><span>T${escapeHtml(o.toolT||'?')} D${escapeHtml(o.toolD||'?')} · ${escapeHtml(o.toolName||'инструмент не указан')}</span><small>S ${escapeHtml(o.speed||'—')} · F ${escapeHtml(o.feed||'—')} · D ${escapeHtml(o.depth||'—')}${o.thread?.designation?` · ${escapeHtml(o.thread.designation)}×${escapeHtml(o.thread.pitch)}`:''}</small></div><div class="route-actions"><button data-route-action="up" data-route-index="${i}">↑</button><button data-route-action="down" data-route-index="${i}">↓</button><button data-route-action="open" data-route-index="${i}">Открыть</button><button data-route-action="duplicate" data-route-index="${i}">Копия</button><button data-route-action="toggle" data-route-index="${i}">${o.enabled===false?'Вкл':'Выкл'}</button><button data-route-action="delete" data-route-index="${i}" class="danger-lite">×</button></div></article>`).join(''):'<div class="route-empty">Добавь торцовку, точение, расточку, резьбу, канавку и отрезку в нужном порядке.</div>';
  document.querySelectorAll('[data-route-action]').forEach(btn=>btn.onclick=()=>handleRouteAction(btn.dataset.routeAction,Number(btn.dataset.routeIndex)));
}
function handleRouteAction(action,index){const route=state.operationRoute,item=route[index];if(!item)return;if(action==='up'&&index>0)[route[index-1],route[index]]=[route[index],route[index-1]];else if(action==='down'&&index<route.length-1)[route[index+1],route[index]]=[route[index],route[index+1]];else if(action==='open'){state.activeRouteIndex=index;applyShopTurnData(item);if(item.thread?.designation){populateThreadCatalog(item.thread.designation);updateThreadPitchOptions(item.thread.pitch);$('threadSideSelect').value=item.thread.side||'external';$('threadToleranceInput').value=item.thread.tolerance||'';}setView('stock');toast(`Открыта операция ${index+1}`);}else if(action==='duplicate'){const copy=clone(item);copy.id=`op-${Date.now()}`;route.splice(index+1,0,copy);}else if(action==='toggle')item.enabled=item.enabled===false;else if(action==='delete'){route.splice(index,1);if(state.activeRouteIndex>=route.length)state.activeRouteIndex=route.length-1;}renderOperationRoute();validateOperationRoute(false);scheduleAutosave();}
function validateOperationRoute(showToast=true){const warnings=[],active=state.operationRoute.filter(o=>o.enabled!==false);if(!active.length)warnings.push({level:'warn',text:'Маршрут пуст.'});const partIndex=active.findIndex(o=>o.operation==='partoff');if(partIndex>=0&&partIndex!==active.length-1)warnings.push({level:'error',text:'Отрезка должна быть последней активной операцией.'});active.forEach((o,i)=>{if(/чистов/i.test(o.toolName||'')&&active.slice(i+1).some(x=>/чернов/i.test(x.toolName||'')))warnings.push({level:'warn',text:`Чистовая операция №${i+1} стоит раньше черновой.`});if(['thread_ext','thread_int'].includes(o.operation)&&(!o.thread?.designation||!o.thread?.pitch))warnings.push({level:'error',text:`Для резьбовой операции №${i+1} не выбраны размер и шаг.`});if(!o.toolT||!o.toolD)warnings.push({level:'error',text:`В операции №${i+1} не указан T/D.`});});const map=new Map();active.forEach((o,i)=>{const key=`${o.toolT}/${o.toolD}`;if(map.has(key)&&map.get(key)!==o.toolName)warnings.push({level:'warn',text:`T${o.toolT} D${o.toolD} используются для разных инструментов.`});else map.set(key,o.toolName);});$('routeWarnings').innerHTML=warnings.length?warnings.map(w=>`<div class="route-warning ${w.level}">${escapeHtml(w.text)}</div>`).join(''):'<div class="route-warning ok">Порядок операций прошёл базовую проверку.</div>';if(showToast)toast(warnings.some(w=>w.level==='error')?'В маршруте есть ошибки':warnings.length?'Маршрут проверен с замечаниями':'Маршрут готов');return !warnings.some(w=>w.level==='error');}
$('addOperationBtn').onclick=()=>{const op=makeOperationSnapshot();if(!op.operation)return toast('Сначала выбери операцию ShopTurn');state.operationRoute.push(op);state.activeRouteIndex=state.operationRoute.length-1;renderOperationRoute();validateOperationRoute(false);scheduleAutosave();toast('Операция добавлена в маршрут');};
$('updateOperationBtn').onclick=()=>{if(state.activeRouteIndex<0||!state.operationRoute[state.activeRouteIndex])return toast('Сначала открой операцию из маршрута');const existing=state.operationRoute[state.activeRouteIndex],fresh=makeOperationSnapshot();fresh.id=existing.id;fresh.enabled=existing.enabled;state.operationRoute[state.activeRouteIndex]=fresh;renderOperationRoute();validateOperationRoute(false);scheduleAutosave();toast('Активная операция обновлена');};
$('validateRouteBtn').onclick=()=>validateOperationRoute(true);
$('exportRouteBtn').onclick=()=>download('shopturn-operation-route.json','application/json',JSON.stringify({version:1,machine:'Tengyue CK52PT-Y · SINUMERIK 828D',threads:state.projectThreads,chamfers:state.chamfers,operations:state.operationRoute},null,2));
$('startRouteBtn').onclick=()=>{const idx=state.operationRoute.findIndex(o=>o.enabled!==false);if(idx<0)return toast('Добавь операции в маршрут');state.activeRouteIndex=idx;handleRouteAction('open',idx);state.shopturn.wizardStep=0;renderShopTurnWizard();};
$('nextRouteOperationBtn').onclick=()=>{let idx=state.activeRouteIndex;do{idx++;}while(idx<state.operationRoute.length&&state.operationRoute[idx].enabled===false);if(idx>=state.operationRoute.length)return toast('Маршрут завершён');state.activeRouteIndex=idx;handleRouteAction('open',idx);state.shopturn.wizardStep=0;renderShopTurnWizard();};


function renderOperationMultiPicker(){
  if(!$('operationPickerOptions')) return;
  const selected=new Set(state.selectedOperationCodes);
  $('operationPickerOptions').innerHTML=Object.entries(SHOP_OPERATIONS).map(([code,op])=>`<label class="operation-option ${selected.has(code)?'selected':''}"><input type="checkbox" value="${code}" ${selected.has(code)?'checked':''}/><span><strong>${escapeHtml(op.label)}</strong><small>${escapeHtml(op.machining)} · ${escapeHtml(op.position)}</small></span></label>`).join('');
  $('selectedOperationCount').textContent=selected.size?`Выбрано: ${selected.size}`:'Не выбраны';
  $('operationPickerOptions').querySelectorAll('input').forEach(input=>input.onchange=()=>{
    const code=input.value;
    if(input.checked&&!state.selectedOperationCodes.includes(code))state.selectedOperationCodes.push(code);
    if(!input.checked)state.selectedOperationCodes=state.selectedOperationCodes.filter(x=>x!==code);
    renderOperationMultiPicker();
  });
}
function operationSnapshotForCode(code,index=0){
  const op=SHOP_OPERATIONS[code];if(!op)return null;
  const presetKey=op.preferred||'';const preset=TOOL_PRESETS[presetKey]||{};
  const current=collectShopTurnData();
  return {...current,...preset,id:`op-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,operation:code,preset:presetKey,label:op.label,machining:op.machining,position:op.position,enabled:true,thread:['thread_ext','thread_int'].includes(code)?selectedThread():{},x0:current.x0,z0:current.z0,x1:current.x1,z1:current.z1,fs1:current.fs1,fs2:current.fs2,fs3:current.fs3,ux:current.ux,uz:current.uz,incrementMode:current.incrementMode};
}
function addSelectedOperationsToRoute(){
  if(!state.selectedOperationCodes.length)return toast('Отметь хотя бы одну операцию');
  const added=state.selectedOperationCodes.map(operationSnapshotForCode).filter(Boolean);
  state.operationRoute.push(...added);state.activeRouteIndex=state.operationRoute.length-added.length;
  renderOperationRoute();validateOperationRoute(false);scheduleAutosave();
  toast(`Добавлено операций: ${added.length}`);
}
function initOperationMultiPicker(){
  if(!$('operationPickerToggle'))return;
  renderOperationMultiPicker();
  $('operationPickerToggle').onclick=()=>{const menu=$('operationPickerMenu');const opening=menu.classList.contains('hidden');menu.classList.toggle('hidden',!opening);$('operationPickerToggle').setAttribute('aria-expanded',String(opening));$('operationPickerToggle').textContent=opening?'Скрыть список ▴':'Выбрать операции ▾';};
  $('clearOperationSelectionBtn').onclick=()=>{state.selectedOperationCodes=[];renderOperationMultiPicker();};
  $('typicalRouteBtn').onclick=()=>{state.selectedOperationCodes=['face','od_turn','contour','id_turn','thread_int','groove','partoff'];renderOperationMultiPicker();};
  $('addSelectedOperationsBtn').onclick=addSelectedOperationsToRoute;
}

const TOOL_PRESETS = {
  outer_rough: { label:'T1 · Наружный черновой · CNMG 120408', operation:'od_turn', toolT:'1', toolD:'1', toolName:'Наружный проходной черновой', holder:'PCLNR 2525M12', insert:'CNMG 120408', orientation:'right', noseRadius:'0.8', width:'', coolant:true, driven:false, speed:'650', feed:'0.18', depth:'1.5' },
  outer_finish: { label:'T2 · Наружный чистовой · DNMG 150404', operation:'od_turn', toolT:'2', toolD:'2', toolName:'Наружный проходной чистовой', holder:'PDJNR 2525M15', insert:'DNMG 150404', orientation:'right', noseRadius:'0.4', width:'', coolant:true, driven:false, speed:'800', feed:'0.08', depth:'0.3' },
  face: { label:'T1 · Торцовка · CNMG 120408', operation:'face', toolT:'1', toolD:'1', toolName:'Подрезной / наружный проходной', holder:'PCLNR 2525M12', insert:'CNMG 120408', orientation:'right', noseRadius:'0.8', width:'', coolant:true, driven:false, speed:'650', feed:'0.12', depth:'1.0' },
  boring: { label:'T3 · Расточной · CCMT 09T304', operation:'id_turn', toolT:'3', toolD:'3', toolName:'Расточной резец', holder:'SCLCR 2525M09', insert:'CCMT 09T304', orientation:'internal', noseRadius:'0.4', width:'', coolant:true, driven:false, speed:'600', feed:'0.10', depth:'0.8' },
  groove: { label:'T4 · Канавочный · MGMN300', operation:'groove', toolT:'4', toolD:'4', toolName:'Канавочный резец 3 мм', holder:'MGEHR 2525-3', insert:'MGMN300', orientation:'right', noseRadius:'0.2', width:'3.0', coolant:true, driven:false, speed:'450', feed:'0.07', depth:'0.8' },
  partoff: { label:'T5 · Отрезной · 3 мм', operation:'partoff', toolT:'5', toolD:'5', toolName:'Отрезной резец 3 мм', holder:'MGEHR 2525-3', insert:'MGMN300', orientation:'right', noseRadius:'0.2', width:'3.0', coolant:true, driven:false, speed:'350', feed:'0.05', depth:'1.0' },
  thread_ext: { label:'T6 · Наружная резьба · 16ER', operation:'thread_ext', toolT:'6', toolD:'6', toolName:'Наружный резьбовой резец', holder:'SER 2525M16', insert:'16ER 1.5 ISO', orientation:'right', noseRadius:'0', width:'', coolant:true, driven:false, speed:'250', feed:'1.5', depth:'0.15' },
  thread_int: { label:'T7 · Внутренняя резьба · 16IR', operation:'thread_int', toolT:'7', toolD:'7', toolName:'Внутренний резьбовой резец', holder:'SIR 0020R16', insert:'16IR 1.5 ISO', orientation:'internal', noseRadius:'0', width:'', coolant:true, driven:false, speed:'220', feed:'1.5', depth:'0.12' },
  drill: { label:'T8 · Сверло осевое', operation:'drilling', toolT:'8', toolD:'8', toolName:'Сверло осевое', holder:'Axial drill holder', insert:'Сверло Ø10', orientation:'axial', noseRadius:'0', width:'10', coolant:true, driven:false, speed:'700', feed:'0.10', depth:'2.0' },
  driven_mill: { label:'T9 · Приводная фреза Ø8', operation:'milling', toolT:'9', toolD:'9', toolName:'Концевая фреза приводная Ø8', holder:'ER32 driven holder', insert:'Фреза Ø8 · 4 зуба', orientation:'radial', noseRadius:'0', width:'8', coolant:true, driven:true, speed:'2500', feed:'220', depth:'1.0' },
};
const SHOP_OPERATIONS = {
  face: { label:'Face · Торцовка', machining:'Face', position:'Face', preferred:'face' },
  od_turn: { label:'OD Turning · Наружное точение', machining:'Longitudinal', position:'Outside', preferred:'outer_rough' },
  contour: { label:'Stock Removal · Контур X/Z', machining:'Contour', position:'Outside', preferred:'outer_rough' },
  id_turn: { label:'ID Turning · Расточка', machining:'Longitudinal', position:'Inside', preferred:'boring' },
  groove: { label:'Groove · Канавка', machining:'Groove', position:'Outside', preferred:'groove' },
  partoff: { label:'Part-off · Отрезка', machining:'Part-off', position:'Outside', preferred:'partoff' },
  thread_ext: { label:'Thread OD · Наружная резьба', machining:'Thread', position:'Outside', preferred:'thread_ext' },
  thread_int: { label:'Thread ID · Внутренняя резьба', machining:'Thread', position:'Inside', preferred:'thread_int' },
  drilling: { label:'Drilling · Сверление', machining:'Drilling', position:'Face', preferred:'drill' },
  milling: { label:'Driven tool · Приводной инструмент', machining:'Milling', position:'Radial/Y', preferred:'driven_mill' },
};
const SHOP_INPUT_IDS = ['machineProfileSelect','shopOperationSelect','toolPresetSelect','toolTInput','toolDInput','toolNameInput','toolHolderInput','toolInsertInput','toolOrientationSelect','toolNoseRadiusInput','toolWidthInput','toolCoolantToggle','toolDrivenToggle','spindleModeSelect','spindleSpeedInput','feedInput','depthInput','machiningInput','positionInput','cycleX0Input','cycleZ0Input','cycleX1Input','cycleZ1Input','fs1Input','fs2Input','fs3Input','uxInput','uzInput','incrementModeSelect'];
function customToolPresets(){try{return JSON.parse(localStorage.getItem('personal-ai-custom-tools')||'[]');}catch{return[];}}
function populateToolPresets(selected=''){const custom=customToolPresets();state.shopturn.customTools=custom;$('toolPresetSelect').innerHTML=['<option value="">Выберите инструмент</option>',...Object.entries(TOOL_PRESETS).map(([key,v])=>`<option value="${key}" ${selected===key?'selected':''}>${escapeHtml(v.label)}</option>`),...custom.map((v,i)=>`<option value="custom:${i}" ${selected===`custom:${i}`?'selected':''}>Свой · ${escapeHtml(v.label||v.toolName||`Инструмент ${i+1}`)}</option>`)].join('');}
function presetByKey(key){if(key.startsWith('custom:'))return state.shopturn.customTools[Number(key.split(':')[1])]||null;return TOOL_PRESETS[key]||null;}
function applyToolPreset(key,changeOperation=true){const p=presetByKey(key);if(!p)return;if(changeOperation&&p.operation)$('shopOperationSelect').value=p.operation;$('toolTInput').value=p.toolT||'1';$('toolDInput').value=p.toolD||p.toolT||'1';$('toolNameInput').value=p.toolName||'';$('toolHolderInput').value=p.holder||'';$('toolInsertInput').value=p.insert||'';$('toolOrientationSelect').value=p.orientation||'right';$('toolNoseRadiusInput').value=p.noseRadius??'';$('toolWidthInput').value=p.width??'';$('toolCoolantToggle').checked=p.coolant!==false;$('toolDrivenToggle').checked=!!p.driven;$('spindleSpeedInput').value=p.speed||'';$('feedInput').value=p.feed||'';$('depthInput').value=p.depth||'';applyOperationDefaults(false);renderShopTurn();scheduleAutosave();}
function collectShopTurnData(){return{machineProfile:$('machineProfileSelect').value,operation:$('shopOperationSelect').value,preset:$('toolPresetSelect').value,toolT:$('toolTInput').value.trim(),toolD:$('toolDInput').value.trim(),toolName:$('toolNameInput').value.trim(),holder:$('toolHolderInput').value.trim(),insert:$('toolInsertInput').value.trim(),orientation:$('toolOrientationSelect').value,noseRadius:$('toolNoseRadiusInput').value.trim(),width:$('toolWidthInput').value.trim(),coolant:$('toolCoolantToggle').checked,driven:$('toolDrivenToggle').checked,spindleMode:$('spindleModeSelect').value,speed:$('spindleSpeedInput').value.trim(),feed:$('feedInput').value.trim(),depth:$('depthInput').value.trim(),machining:$('machiningInput').value.trim(),position:$('positionInput').value.trim(),x0:$('cycleX0Input').value.trim(),z0:$('cycleZ0Input').value.trim(),x1:$('cycleX1Input').value.trim(),z1:$('cycleZ1Input').value.trim(),fs1:$('fs1Input').value.trim(),fs2:$('fs2Input').value.trim(),fs3:$('fs3Input').value.trim(),ux:$('uxInput').value.trim(),uz:$('uzInput').value.trim(),incrementMode:$('incrementModeSelect').value,wizardStep:state.shopturn.wizardStep};}
function applyShopTurnData(d={}){populateToolPresets(d.preset||'');const map={machineProfileSelect:d.machineProfile,shopOperationSelect:d.operation,toolPresetSelect:d.preset,toolTInput:d.toolT,toolDInput:d.toolD,toolNameInput:d.toolName,toolHolderInput:d.holder,toolInsertInput:d.insert,toolOrientationSelect:d.orientation,toolNoseRadiusInput:d.noseRadius,toolWidthInput:d.width,spindleModeSelect:d.spindleMode,spindleSpeedInput:d.speed,feedInput:d.feed,depthInput:d.depth,machiningInput:d.machining,positionInput:d.position,cycleX0Input:d.x0,cycleZ0Input:d.z0,cycleX1Input:d.x1,cycleZ1Input:d.z1,fs1Input:d.fs1,fs2Input:d.fs2,fs3Input:d.fs3,uxInput:d.ux,uzInput:d.uz,incrementModeSelect:d.incrementMode};for(const[id,v]of Object.entries(map))if(v!==undefined&&v!==null&&$(id))$(id).value=v;$('toolCoolantToggle').checked=d.coolant!==false;$('toolDrivenToggle').checked=!!d.driven;state.shopturn.wizardStep=Math.max(0,number(d.wizardStep,0));renderShopTurn();}
function applyOperationDefaults(selectPreset=true){const op=SHOP_OPERATIONS[$('shopOperationSelect').value]||{machining:'',position:'',preferred:''};$('machiningInput').value=op.machining;$('positionInput').value=op.position;if(selectPreset){$('toolPresetSelect').value=op.preferred;applyToolPreset(op.preferred,false);}autoFillCycleFromContour(false);}
function autoFillCycleFromContour(showToast=true){const op=$('shopOperationSelect').value,pts=state.contourPoints,first=pts[0]||{x:0,z:0},last=pts.at(-1)||first,selected=pts[state.selectedIndex]||first,blankD=number($('blankDiameter').value,first.x),blankL=number($('blankLength').value,Math.abs(last.z));let x0=first.x,z0=first.z,x1=last.x,z1=last.z;if(op==='face'){x0=blankD||first.x;z0=0;x1=0;z1=-Math.abs(number($('depthInput').value,1));}else if(op==='partoff'){x0=blankD||first.x;z0=selected.z;x1=0;z1=selected.z;}else if(op==='groove'){x0=blankD||first.x;z0=selected.z;x1=Math.max(0,selected.x-number($('depthInput').value,1)*2);z1=selected.z;}else if(op==='drilling'){x0=0;z0=2;x1=0;z1=-Math.abs(blankL||last.z);}else if(op==='milling'){x0=selected.x;z0=selected.z;x1=last.x;z1=last.z;}$('cycleX0Input').value=fmt(x0);$('cycleZ0Input').value=fmt(z0);$('cycleX1Input').value=fmt(x1);$('cycleZ1Input').value=fmt(z1);renderShopTurn();if(showToast)toast('Поля цикла подставлены из заготовки и контура');}
function buildShopTurnSteps(){const d=collectShopTurnData(),op=SHOP_OPERATIONS[d.operation]||{label:'Операция не выбрана',machining:'',position:''},inc=d.incrementMode==='incremental'?' INC':'';return[
{title:'Открой программу',path:['NC','WKS','Program'],instruction:'Открой рабочую программу детали на стойке. Убедись, что выбран правильный канал и активна нужная система координат.',values:[['Станок','CK52PT-Y'],['Стойка','SINUMERIK 828D / ShopTurn']]},
{title:'Открой Stock removal',path:['Program','Turning','Stock removal'],instruction:'В меню токарных циклов выбери <strong>Stock removal</strong>. Для обработки по готовому X/Z-контуру затем выбери <strong>New contour</strong>.',values:[['Операция',op.label],['Machining',d.machining]]},
{title:'Выбери инструмент',path:['Stock removal','Select tool'],instruction:`Нажми <strong>Select tool</strong> и выбери позицию револьвера <strong>T${escapeHtml(d.toolT||'?')}</strong> с корректором <strong>D${escapeHtml(d.toolD||'?')}</strong>. Сверь ориентацию пластины.`,values:[['T / D',`T${d.toolT} / D${d.toolD}`],['Инструмент',d.toolName||'не указан'],['Державка',d.holder||'—'],['Пластина',d.insert||'—']],field:'tool'},
{title:'Введи F и S',path:['Stock removal','T,F,S'],instruction:'Задай подачу и обороты. Значения являются подготовленными настройками и должны быть проверены по материалу, пластине и жёсткости установки.',values:[['F',`${d.feed||'?'} мм/об`],['S',`${d.speed||'?'} ${d.spindleMode==='css'?'м/мин':'об/мин'}`],['СОЖ',d.coolant?'Включить':'Выключить']],field:'speed'},
{title:'Выбери Machining и Pos.',path:['Stock removal','Machining / Pos.'],instruction:`В поле <strong>Machining</strong> выбери <strong>${escapeHtml(d.machining||'—')}</strong>, а в поле <strong>Pos.</strong> — <strong>${escapeHtml(d.position||'—')}</strong>.`,values:[['Machining',d.machining||'—'],['Pos.',d.position||'—']],field:'machining'},
{title:'Введи начальные X0 / Z0',path:['Stock removal','X0 / Z0'],instruction:'Введи начальную область цикла. Перед Accept проверь, что X используется в выбранном представлении диаметра/радиуса и что Z0 соответствует реальному торцу.',values:[['X0',d.x0||'—'],['Z0',d.z0||'—']],field:'x0'},
{title:'Введи конечные X1 / Z1',path:['Stock removal','X1 / Z1'],instruction:`Введи конечную область обработки. Для X1 и Z1 сейчас выбран режим <strong>${d.incrementMode==='incremental'?'INC / приращение':'абсолютные координаты'}</strong>.`,values:[['X1',`${d.x1||'—'}${inc}`],['Z1',`${d.z1||'—'}${inc}`]],field:'x1'},
{title:'Заполни FS1 / FS2 / FS3',path:['Stock removal','FS fields'],instruction:'Заполни дополнительные переходы или оставь нули, если твой цикл и выбранная операция их не используют. Сверяй значение по подсказке конкретного экрана ShopTurn.',values:[['FS1',d.fs1||'0'],['FS2',d.fs2||'0'],['FS3',d.fs3||'0']],field:'fs'},
{title:'Глубина и припуски',path:['Stock removal','D / UX / UZ'],instruction:'Введи глубину прохода D и чистовые припуски UX/UZ. Не путай глубину D в цикле с номером корректора D в верхней части экрана.',values:[['D · глубина',d.depth||'—'],['UX',d.ux||'0'],['UZ',d.uz||'0']],field:'allowance'},
{title:'Проверь Graphic view',path:['Stock removal','Graphic view'],instruction:'Открой <strong>Graphic view</strong>. Проверь сторону обработки, положение Z0, ступени, направление съёма и отсутствие захода инструмента в патрон или необрабатываемую часть.',values:[['Контур',state.closed?'Закрытый':'Открытый'],['Точек',String(state.contourPoints.length)],['Длина',`${totalLength().toFixed(3)} мм`]]},
{title:'Нажми Accept',path:['Stock removal','Accept'],instruction:'Если инструмент, поля цикла и графика совпадают с чертежом, нажми <strong>Accept</strong>. Затем выполни графическую симуляцию программы перед реальным запуском.',values:[['Проверка контура',state.validation.some(v=>v.level==='error')?'Есть ошибки':'Нет критических ошибок'],['Следующий шаг','Graphic simulation']]},
];}
function renderShopTurn(){if(!$('shopOperationSelect'))return;const d=collectShopTurnData(),op=SHOP_OPERATIONS[d.operation]||{label:'Операция не выбрана',machining:'',position:''};$('screenT').textContent=d.toolT||'—';$('screenD').textContent=d.toolD||'—';$('screenF').textContent=d.feed||'—';$('screenS').textContent=d.speed||'—';$('screenMachining').textContent=d.machining||op.machining;$('screenPosition').textContent=d.position||op.position;$('screenX0').textContent=d.x0||'—';$('screenZ0').textContent=d.z0||'—';$('screenX1').textContent=`${d.x1||'—'}${d.incrementMode==='incremental'?' inc':''}`;$('screenZ1').textContent=`${d.z1||'—'}${d.incrementMode==='incremental'?' inc':''}`;$('screenFS').textContent=`${d.fs1||'0'} / ${d.fs2||'0'} / ${d.fs3||'0'}`;$('screenDepth').textContent=d.depth||'—';$('screenAllowance').textContent=`${d.ux||'0'} / ${d.uz||'0'}`;$('consoleProgramName').textContent=op.machining==='Contour'?'Stock removal · New contour':op.label;$('consolePath').textContent=`NC/WKS → Program → ${op.label}`;$('toolSummaryCard').innerHTML=`<div><strong>T${escapeHtml(d.toolT||'?')} D${escapeHtml(d.toolD||'?')}</strong> · ${escapeHtml(d.toolName||'Инструмент не выбран')}</div><div>${escapeHtml(d.holder||'—')} · ${escapeHtml(d.insert||'—')} · R${escapeHtml(d.noseRadius||'—')}</div><div>S ${escapeHtml(d.speed||'—')} · F ${escapeHtml(d.feed||'—')} · D ${escapeHtml(d.depth||'—')} · СОЖ ${d.coolant?'ON':'OFF'}</div>`;const ready=!!(d.toolT&&d.toolD&&d.toolName&&d.speed&&d.feed&&d.x0&&d.z0&&d.x1&&d.z1);$('shopturnReadyBadge').textContent=ready?'Готово к проверке':'Заполни обязательные поля';$('shopturnReadyBadge').className=`badge ${ready?'badge-ready':'badge-missing'}`;renderShopTurnWizard();}
function renderShopTurnWizard(){const steps=buildShopTurnSteps();state.shopturn.wizardStep=Math.max(0,Math.min(state.shopturn.wizardStep,steps.length-1));const step=steps[state.shopturn.wizardStep];$('wizardTitle').textContent=step.title;$('wizardCounter').textContent=`Шаг ${state.shopturn.wizardStep+1} из ${steps.length}`;$('wizardProgressBar').style.width=`${((state.shopturn.wizardStep+1)/steps.length)*100}%`;$('wizardBreadcrumb').innerHTML=step.path.map(x=>`<span>${escapeHtml(x)}</span>`).join('<span>→</span>');$('wizardInstruction').innerHTML=step.instruction;$('wizardValues').innerHTML=step.values.map(([k,v])=>`<div class="wizard-value"><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join('');$('wizardPrevBtn').disabled=state.shopturn.wizardStep===0;$('wizardNextBtn').textContent=state.shopturn.wizardStep===steps.length-1?'Готово ✓':'Далее →';$('wizardAllSteps').innerHTML=steps.map((s,i)=>`<div class="wizard-step-item ${i===state.shopturn.wizardStep?'active':''} ${i<state.shopturn.wizardStep?'done':''}" data-step="${i}"><i>${i<state.shopturn.wizardStep?'✓':i+1}</i><span>${escapeHtml(s.title)}</span></div>`).join('');document.querySelectorAll('.console-row').forEach(r=>r.classList.remove('active-field'));if(step.field){const fieldMap={tool:null,speed:null,machining:'machining',x0:'x0',x1:'x1',fs:'fs',allowance:'allowance'};const f=fieldMap[step.field];if(f)document.querySelector(`[data-shop-field="${f}"]`)?.classList.add('active-field');}document.querySelectorAll('.wizard-step-item').forEach(x=>x.onclick=()=>{state.shopturn.wizardStep=Number(x.dataset.step);renderShopTurnWizard();scheduleAutosave();});}
function initShopTurn(){populateToolPresets('face');applyToolPreset('face',true);autoFillCycleFromContour(false);SHOP_INPUT_IDS.forEach(id=>$(id)?.addEventListener('input',()=>{renderShopTurn();scheduleAutosave();}));$('shopOperationSelect').addEventListener('change',()=>{applyOperationDefaults(true);renderShopTurn();scheduleAutosave();});$('toolPresetSelect').addEventListener('change',()=>applyToolPreset($('toolPresetSelect').value,true));$('applyToolPresetBtn').onclick=()=>applyToolPreset($('toolPresetSelect').value,true);$('autoFillShopturnBtn').onclick=()=>autoFillCycleFromContour(true);$('saveCustomToolBtn').onclick=()=>{const d=collectShopTurnData();if(!d.toolName)return toast('Введи название инструмента');const custom=customToolPresets();custom.push({...d,label:`T${d.toolT} · ${d.toolName}`,operation:d.operation});localStorage.setItem('personal-ai-custom-tools',JSON.stringify(custom));populateToolPresets(`custom:${custom.length-1}`);toast('Инструмент сохранён в локальную библиотеку');};$('wizardPrevBtn').onclick=()=>{state.shopturn.wizardStep=Math.max(0,state.shopturn.wizardStep-1);renderShopTurnWizard();};$('wizardNextBtn').onclick=()=>{const max=buildShopTurnSteps().length-1;if(state.shopturn.wizardStep<max)state.shopturn.wizardStep++;else toast('Мастер ввода завершён. Выполни Graphic view и симуляцию.');renderShopTurnWizard();scheduleAutosave();};$('consoleAcceptBtn').onclick=()=>$('wizardNextBtn').click();document.querySelectorAll('[data-console-step]').forEach(btn=>btn.onclick=()=>{state.shopturn.wizardStep=Math.max(0,Math.min(Number(btn.dataset.consoleStep)||0,buildShopTurnSteps().length-1));document.querySelectorAll('[data-console-step]').forEach(x=>x.classList.toggle('active',x===btn));renderShopTurnWizard();scheduleAutosave();toast(`Открыт шаг: ${buildShopTurnSteps()[state.shopturn.wizardStep].title}`);});$('wizardCopyBtn').onclick=async()=>{const s=buildShopTurnSteps()[state.shopturn.wizardStep];const txt=`${s.title}\n${s.path.join(' → ')}\n${s.values.map(([k,v])=>`${k}: ${v}`).join('\n')}\n${s.instruction.replace(/<[^>]*>/g,'')}`;try{await navigator.clipboard.writeText(txt);toast('Данные шага скопированы');}catch{toast('Не удалось скопировать');}};renderShopTurn();}

async function fetchHistoryDetail(id){const r=await fetch(`/api/history/${id}`);const d=await r.json();if(!r.ok)throw new Error(d.detail||'Не удалось открыть запись');return d;}
function showHistoryResult(item){const isStock=String(item.prompt||'').startsWith('Stock Removal |');if(isStock){setView('stock');$('stockResultEmpty').classList.add('hidden');$('stockResultContent').classList.remove('hidden');$('stockResultContent').innerHTML=renderText(item.response||'');$('stockResultMeta').textContent=`${item.model}${item.mock?' · MOCK':''} · #${item.id}`;startChat('stock',{id:item.id,response:item.response,response_id:item.openai_response_id,model:item.model,mock:item.mock});}else{setView('analysis');$('promptInput').value=item.prompt||'';$('resultEmpty').classList.add('hidden');$('resultContent').classList.remove('hidden');$('resultContent').innerHTML=renderText(item.response||'');$('resultMeta').textContent=`${item.model}${item.mock?' · MOCK':''} · #${item.id}`;startChat('analysis',{id:item.id,response:item.response,response_id:item.openai_response_id,model:item.model,mock:item.mock});}}
async function openHistoryEntry(id){try{const item=await fetchHistoryDetail(id);showHistoryResult(item);}catch(e){toast(e.message);}}
async function loadHistoryProject(id){try{const item=await fetchHistoryDetail(id);resetWorkspaceForNewProject();if(item.project)applyProjectData(item.project);state.restoredFileName=item.filename||item.project?.fileName||null;state.currentProjectName=`Из истории · ${item.filename||`запись ${id}`}`;updateProjectUi();showHistoryResult(item);syncFileUi();scheduleAutosave();toast(item.has_project?'Проект восстановлен из истории':'Результат восстановлен. Исходный файл выбери заново.');}catch(e){toast(e.message);}}
async function loadHistory(){const list=$('historyList');list.innerHTML='<div class="result-empty"><span>Загрузка...</span></div>';try{const r=await fetch('/api/history'),items=await r.json();if(!r.ok)throw new Error('Не удалось загрузить историю');if(!items.length){list.innerHTML='<div class="result-empty"><strong>История пуста</strong></div>';return;}list.innerHTML=items.map(i=>`<article class="history-item"><div class="history-copy"><div class="history-title-row"><h3 title="${escapeHtml(i.filename)}">${escapeHtml(i.filename)}</h3>${i.mock?'<span class="history-tag">MOCK</span>':''}${i.has_project?'<span class="history-tag project-tag">ПРОЕКТ</span>':''}</div><p title="${escapeHtml(i.prompt)}">${escapeHtml(i.prompt)}</p><small>${new Date(i.created_at*1000).toLocaleString('ru-RU')} · ${escapeHtml(i.model||'')}</small></div><div class="history-actions"><button data-open-history="${i.id}" class="small-button">Открыть</button><button data-load-history="${i.id}" class="secondary-button">Загрузить проект</button><button data-del="${i.id}" class="danger-lite" aria-label="Удалить запись">×</button></div></article>`).join('');list.querySelectorAll('[data-open-history]').forEach(b=>b.onclick=()=>openHistoryEntry(Number(b.dataset.openHistory)));list.querySelectorAll('[data-load-history]').forEach(b=>b.onclick=()=>loadHistoryProject(Number(b.dataset.loadHistory)));list.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Удалить запись из истории?'))return;await fetch(`/api/history/${b.dataset.del}`,{method:'DELETE'});loadHistory();});}catch(e){list.innerHTML=`<div class="result-empty"><strong>${escapeHtml(e.message)}</strong></div>`;}}
$('refreshHistoryBtn').onclick=loadHistory;

$('newAnalysisBtn').onclick=()=>{state.file=null;state.restoredFileName=null;state.image=null;state.crop=null;fileInput.value='';dropZone.classList.remove('hidden');previewArea.classList.add('hidden');$('promptInput').value='';$('resultContent').classList.add('hidden');$('resultEmpty').classList.remove('hidden');$('stockResultContent').classList.add('hidden');$('stockResultEmpty').classList.remove('hidden');resetChat('analysis',true);resetChat('stock',true);renderChamferEditor();syncFileUi();};

document.addEventListener('keydown',e=>{const tag=document.activeElement?.tagName;if(['INPUT','TEXTAREA','SELECT'].includes(tag))return;const mod=e.ctrlKey||e.metaKey;if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}else if(e.key==='Delete'){e.preventDefault();$('deletePointBtn').click();}else if(e.key.toLowerCase()==='a'){e.preventDefault();openPointModal('add');}else if(e.key.toLowerCase()==='s'){e.preventDefault();saveProject(false);}else if(e.key==='ArrowLeft'){state.selectedIndex=Math.max(0,state.selectedIndex-1);renderEditor();}else if(e.key==='ArrowRight'){state.selectedIndex=Math.min(state.contourPoints.length-1,state.selectedIndex+1);renderEditor();}});
window.addEventListener('resize',()=>{updateDeviceModeLabel();if(state.image){resizeImageCanvas();drawImageCanvas();}renderEditor();renderChamferEditor();});

initThemeControls();updateDeviceModeLabel();initShopTurn();initOperationMultiPicker();loadHealth();loadThreadCatalog();loadLocalDraft();updateProjectUi();syncFileUi();renderDrawingIntelligence();renderProjectThreads();renderChamferEditor();renderOperationRoute();renderEditor();renderShopTurn();
