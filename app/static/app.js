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
    analysis: { analysisId: null, rootResponseId: null, responseId: null, context: '', messages: [], attachment: null },
    stock: { analysisId: null, rootResponseId: null, responseId: null, context: '', messages: [], attachment: null },
  },
};
state.shopturn = { wizardStep: 0, customTools: [] };
state.drawingIntel = { tolerances: [], tolerance_interpretations: [], threads: [], chamfers_detected: [], requires_chamfer_decision: true, notes: [] };
state.threadCatalog = [];
state.threadFamilies = [];
state.threadLibraryUi = { family: 'metric_iso', search: '', diameter: 'all', pitch: 'all', standardOnly: true, selectedId: null };
state.ruleControl = { enabled: true, active: {}, search: '' };
state.projectThreads = [];
state.chamfers = [];
state.chamfersEnabled = true;
state.operationRoute = [];
state.selectedOperationCodes = [];
state.activeRouteIndex = -1;
state.chamferTransform = null;
state.chamferView = { zoom: 1, panX: 0, panY: 0, minZoom: 1, maxZoom: 16 };
state.chamferGesture = { pointers: new Map(), dragging: false, moved: false, startX: 0, startY: 0, originPanX: 0, originPanY: 0, pinchDistance: 0, pinchZoom: 1 };
state.chamferFullscreen = { open:false, mode:'point', snapshot:null, home:null };

const $ = id => document.getElementById(id);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function apiRequest(url, options = {}, { timeoutMs = 120000, retries = 1 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        signal: controller.signal,
      });
      const raw = await response.text();
      let data = {};
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { data = { detail: raw.slice(0, 500) }; }
      }
      if (!response.ok) {
        const detail = data.detail || data.error || `HTTP ${response.status} ${response.statusText}`;
        const error = new Error(detail);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      const networkFailure = error?.name === 'TypeError' || /load failed|failed to fetch|network/i.test(String(error?.message || ''));
      const retryableStatus = Number(error?.status) >= 500;
      if (attempt < retries && (networkFailure || retryableStatus)) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      if (error?.name === 'AbortError') {
        throw new Error('Сервер не ответил за 120 секунд. Повторите отправку.');
      }
      if (networkFailure) {
        throw new Error('Связь с сервером Railway прервана. Проверьте интернет и повторите отправку.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('Неизвестная ошибка соединения');
}

const STOCK_MODE_VALUES = new Set(['lathe', 'mill', 'hybrid']);
const ZERO_REFERENCE_OPTIONS = [
  'X0 по оси детали',
  'Z0 по правому торцу',
  'Z0 по левому торцу',
  'Рабочее смещение G54 подтверждено',
];
const FIRST_SIDE_OPTIONS = [
  'Первая установка — торец A',
  'Вторая установка — торец B',
  'Обработка с двух сторон',
  'Требуется переворот заготовки',
  'Торцовка', 'Наружное точение', 'Внутреннее точение', 'Наружная резьба', 'Внутренняя резьба', 'Фаски', 'Канавки', 'Отрезка',
  'Фрезерование лысок', 'Фрезерование карманов', 'Фрезерование пазов', 'Сверление', 'Развёртывание', 'Зенковка', 'Резьба приводным инструментом', 'Фрезерование контура',
  'Используется ось X', 'Используется ось Z', 'Используется ось C', 'Используется ось Y', 'Используется приводной инструмент',
  'Обработка за один установ', 'Есть припуск на обработку', 'Заготовка после лазерной резки', 'Заготовка после пилы', 'Отверстия уже выполнены',
  'Требуется высокая чистота поверхности', 'Требуется соосность', 'Требуется симметрия',
];

function splitOptionValue(value) {
  return String(value || '').split(';').map(x => x.trim()).filter(Boolean);
}

function syncStockModeUi(mode = state.stockMode) {
  state.stockMode = STOCK_MODE_VALUES.has(mode) ? mode : 'lathe';
  document.querySelectorAll('input[name="stockMode"]').forEach(input => {
    input.checked = input.value === state.stockMode;
    input.closest('.choice-card')?.classList.toggle('selected', input.checked);
  });
  $('latheFields').classList.toggle('hidden', state.stockMode === 'mill');
  $('millFields').classList.toggle('hidden', state.stockMode === 'lathe');
  document.querySelectorAll('[data-operation-group="lathe"]').forEach(el => el.classList.toggle('hidden', state.stockMode === 'mill'));
  document.querySelectorAll('[data-operation-group="mill"]').forEach(el => el.classList.toggle('hidden', state.stockMode === 'lathe'));
}

function syncStockOptionValues() {
  const zeroValues = [...document.querySelectorAll('[data-zero-value]:checked')].map(input => input.dataset.zeroValue);
  const sideValues = [...document.querySelectorAll('[data-side-value]:checked')].map(input => input.dataset.sideValue);
  const zeroCustom = $('zeroReferenceCustom').value.trim();
  const sideCustom = $('firstSideCustom').value.trim();
  if (zeroCustom) zeroValues.push(zeroCustom);
  if (sideCustom) sideValues.push(sideCustom);
  $('zeroReference').value = zeroValues.join('; ');
  $('firstSide').value = sideValues.join('; ');
  document.querySelectorAll('.checkbox-choice').forEach(label => {
    const input = label.querySelector('input[type="checkbox"]');
    label.classList.toggle('selected', !!input?.checked);
  });
}

function applyStockOptionValues(zeroReference = '', firstSide = '') {
  const zeroParts = splitOptionValue(zeroReference);
  const sideParts = splitOptionValue(firstSide);
  document.querySelectorAll('[data-zero-value]').forEach(input => { input.checked = zeroParts.includes(input.dataset.zeroValue); });
  document.querySelectorAll('[data-side-value]').forEach(input => { input.checked = sideParts.includes(input.dataset.sideValue); });
  $('zeroReferenceCustom').value = zeroParts.filter(x => !ZERO_REFERENCE_OPTIONS.includes(x)).join('; ');
  $('firstSideCustom').value = sideParts.filter(x => !FIRST_SIDE_OPTIONS.includes(x)).join('; ');
  syncStockOptionValues();
}

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
function ruleIdentity(kind, value) {
  const raw = typeof value === 'string' ? value : (value?.designation || value?.display || JSON.stringify(value));
  return `${kind}:${String(raw || '').trim().toLowerCase()}`;
}
function isRuleActive(kind, value) {
  const key = ruleIdentity(kind, value);
  return state.ruleControl.active[key] !== false;
}
function activeToleranceContext() {
  if (!state.ruleControl.enabled) return [];
  const tokens = (state.drawingIntel.tolerances || []).filter(x => isRuleActive('tolerance', x));
  const rules = (state.drawingIntel.tolerance_interpretations || []).filter(x => isRuleActive('rule', x)).map(x => x.display);
  return [...tokens, ...rules];
}
function threadDisplay(thread = {}) {
  if (thread.display) return thread.display;
  if (thread.designation && /(?:×|\-|\s(?:UNC|UNF|UNEF|UNS|NPT|NPTF)$)/i.test(thread.designation)) return thread.designation;
  return thread.pitch ? `${thread.designation}×${Number(thread.pitch).toFixed(6).replace(/0+$/,'').replace(/\.$/,'')}` : (thread.designation || 'Резьба');
}
function buildEngineeringContext() {
  const activeTolerances = activeToleranceContext();
  const tolerances = activeTolerances.join('; ') || (state.ruleControl.enabled ? 'не распознаны или отключены' : 'блок правил отключён оператором');
  const threads = state.projectThreads.filter(t => t.enabled !== false).map(t => `${threadDisplay(t)} ${t.side === 'internal' ? 'внутренняя' : 'наружная'} ${t.tolerance || ''}`.trim()).join('; ') || 'не выбраны';
  const chamferItems = state.chamfersEnabled ? state.chamfers.filter(c => c.enabled !== false) : [];
  const chamfers = chamferItems.map((c, i) => `${i + 1}: ${c.mode === 'edge_break' ? 'снять остроту' : c.mode === 'none' ? 'не обрабатывать' : c.notation}${c.contourIndex!==null&&c.contourIndex!==undefined?` у точки X/Z №${c.contourIndex+1}`:''}`).join('; ') || (state.chamfersEnabled ? 'не отмечены' : 'блок фасок отключён оператором');
  const route = state.operationRoute.filter(o => o.enabled !== false).map((o, i) => `${i + 1}. ${o.label || o.operation} T${o.toolT || '?'} D${o.toolD || '?'}`).join('; ') || 'не сформирован';
  return `Инженерный контекст проекта:
Допуски: ${tolerances}.
Резьбы: ${threads}.
Фаски/кромки: ${chamfers}.
Маршрут обработки: ${route}.`;
}

function chatIds(mode) {
  return mode === 'stock'
    ? {panel:'stockChatPanel',messages:'stockChatMessages',input:'stockChatInput',send:'stockChatSend',clear:'stockChatClear',progress:'stockChatProgress',file:'stockChatFile',imagePanel:'stockChatImagePanel',canvas:'stockChatCanvas',useAll:'stockChatUseAll',resetCrop:'stockChatResetCrop',clearImage:'stockChatClearImage',imageStatus:'stockChatImageStatus'}
    : {panel:'analysisChatPanel',messages:'analysisChatMessages',input:'analysisChatInput',send:'analysisChatSend',clear:'analysisChatClear',progress:'analysisChatProgress',file:'analysisChatFile',imagePanel:'analysisChatImagePanel',canvas:'analysisChatCanvas',useAll:'analysisChatUseAll',resetCrop:'analysisChatResetCrop',clearImage:'analysisChatClearImage',imageStatus:'analysisChatImageStatus'};
}
function blankChatState(){return {analysisId:null,rootResponseId:null,responseId:null,context:'',messages:[],attachment:null};}
function resetChat(mode,hide=true){clearChatAttachment(mode);state.chat[mode]=blankChatState();const ids=chatIds(mode);$(ids.messages).innerHTML='';$(ids.input).value='';$(ids.panel).classList.toggle('hidden',hide);}
function startChat(mode,data){clearChatAttachment(mode);state.chat[mode]={analysisId:data.id||null,rootResponseId:null,responseId:null,context:data.response||'',messages:[],attachment:null};const ids=chatIds(mode);$(ids.panel).classList.remove('hidden');$(ids.input).value='';renderChat(mode);}
function renderChat(mode){const ids=chatIds(mode),chat=state.chat[mode];if(!chat.messages.length){$(ids.messages).innerHTML='<div class="chat-empty">Продолжите разговор: ответьте ассистенту, приложите фото или выделите область для уточнения.</div>';return;}$(ids.messages).innerHTML=chat.messages.map(m=>`<div class="chat-row ${m.role}"><div class="chat-avatar">${m.role==='user'?'ВЫ':'AI'}</div><div class="chat-bubble">${m.imageUrl?`<figure class="chat-message-image"><img src="${m.imageUrl}" alt="Приложенное изображение"><figcaption>${m.crop?'Выделенная область изображения':'Приложенное изображение'}</figcaption></figure>`:''}${renderText(m.content)}</div></div>`).join('');$(ids.messages).scrollTop=$(ids.messages).scrollHeight;}
function chatCanvasPosition(e,c){const r=c.getBoundingClientRect();const x=e.clientX??e.touches?.[0]?.clientX,y=e.clientY??e.touches?.[0]?.clientY;return{x:Math.max(0,Math.min(c.width,(x-r.left)*c.width/r.width)),y:Math.max(0,Math.min(c.height,(y-r.top)*c.height/r.height))};}
function drawChatAttachment(mode){const ids=chatIds(mode),a=state.chat[mode]?.attachment;if(!a?.image)return;const c=$(ids.canvas),x=c.getContext('2d'),ratio=Math.min(1,1200/a.image.naturalWidth);c.width=Math.max(1,Math.round(a.image.naturalWidth*ratio));c.height=Math.max(1,Math.round(a.image.naturalHeight*ratio));x.clearRect(0,0,c.width,c.height);x.drawImage(a.image,0,0,c.width,c.height);if(a.crop){const px=a.crop.x*c.width,py=a.crop.y*c.height,pw=a.crop.width*c.width,ph=a.crop.height*c.height;x.save();x.fillStyle='rgba(2,8,16,.58)';x.fillRect(0,0,c.width,c.height);x.clearRect(px,py,pw,ph);x.drawImage(a.image,a.crop.x*a.image.naturalWidth,a.crop.y*a.image.naturalHeight,a.crop.width*a.image.naturalWidth,a.crop.height*a.image.naturalHeight,px,py,pw,ph);x.strokeStyle='#79e7ff';x.lineWidth=3;x.setLineDash([12,8]);x.strokeRect(px,py,pw,ph);x.restore();}}
function updateChatImageStatus(mode){const ids=chatIds(mode),a=state.chat[mode]?.attachment;if(!a){$(ids.imageStatus).textContent='Можно приложить JPG, PNG или WEBP';return;}$(ids.imageStatus).textContent=a.crop?`Выбрана область ${Math.round(a.crop.width*100)}% × ${Math.round(a.crop.height*100)}%`:`Фото: ${a.file.name} · будет отправлено целиком`;}
function clearChatAttachment(mode){const ids=chatIds(mode),chat=state.chat[mode];if(chat)chat.attachment=null;if($(ids.file))$(ids.file).value='';$(ids.imagePanel)?.classList.add('hidden');$(ids.useAll)?.classList.add('hidden');$(ids.resetCrop)?.classList.add('hidden');$(ids.clearImage)?.classList.add('hidden');if($(ids.canvas)){const c=$(ids.canvas);c.getContext('2d').clearRect(0,0,c.width,c.height);}updateChatImageStatus(mode);}
function resetChatCrop(mode){const a=state.chat[mode]?.attachment;if(!a)return;a.crop=null;drawChatAttachment(mode);updateChatImageStatus(mode);}
function useWholeChatImage(mode){const a=state.chat[mode]?.attachment;if(!a)return;a.crop={x:0,y:0,width:1,height:1};drawChatAttachment(mode);updateChatImageStatus(mode);}
function chatAttachmentPreview(mode){const a=state.chat[mode]?.attachment;if(!a?.image)return null;const crop=a.crop||{x:0,y:0,width:1,height:1},c=document.createElement('canvas'),sw=Math.max(1,Math.round(crop.width*a.image.naturalWidth)),sh=Math.max(1,Math.round(crop.height*a.image.naturalHeight)),ratio=Math.min(1,900/sw);c.width=Math.max(1,Math.round(sw*ratio));c.height=Math.max(1,Math.round(sh*ratio));c.getContext('2d').drawImage(a.image,crop.x*a.image.naturalWidth,crop.y*a.image.naturalHeight,sw,sh,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.88);}
function loadChatImage(mode,file){if(!file)return;if(!['image/jpeg','image/png','image/webp'].includes(file.type)){toast('В чате поддерживаются JPG, PNG и WEBP');return;}const reader=new FileReader();reader.onload=()=>{const image=new Image();image.onload=()=>{state.chat[mode].attachment={file,image,crop:null,selecting:false,start:null};const ids=chatIds(mode);$(ids.imagePanel).classList.remove('hidden');$(ids.useAll).classList.remove('hidden');$(ids.resetCrop).classList.remove('hidden');$(ids.clearImage).classList.remove('hidden');drawChatAttachment(mode);updateChatImageStatus(mode);};image.onerror=()=>toast('Не удалось прочитать изображение');image.src=reader.result;};reader.readAsDataURL(file);}
function beginChatCrop(mode,e){const ids=chatIds(mode),a=state.chat[mode]?.attachment;if(!a)return;e.preventDefault();a.selecting=true;a.start=chatCanvasPosition(e,$(ids.canvas));}
function moveChatCrop(mode,e){const ids=chatIds(mode),a=state.chat[mode]?.attachment;if(!a?.selecting)return;e.preventDefault();const c=$(ids.canvas),p=chatCanvasPosition(e,c),x=Math.min(a.start.x,p.x),y=Math.min(a.start.y,p.y),w=Math.abs(p.x-a.start.x),h=Math.abs(p.y-a.start.y);a.crop={x:x/c.width,y:y/c.height,width:w/c.width,height:h/c.height};drawChatAttachment(mode);}
function endChatCrop(mode){const a=state.chat[mode]?.attachment;if(!a?.selecting)return;a.selecting=false;if(!a.crop||a.crop.width*a.image.naturalWidth<8||a.crop.height*a.image.naturalHeight<8)a.crop=null;drawChatAttachment(mode);updateChatImageStatus(mode);}
async function sendChat(mode){
  const ids=chatIds(mode),chat=state.chat[mode],a=chat.attachment,typed=$(ids.input).value.trim(),question=typed||(a?'Проанализируй приложенное изображение или выделенную область и уточни предыдущий ответ.':'');
  if(!question)return;
  const prior=chat.messages.slice(-16).map(({role,content})=>({role,content})),preview=a?chatAttachmentPreview(mode):null,crop=a?.crop?{...a.crop}:null;
  chat.messages.push({role:'user',content:question,imageUrl:preview,crop});
  $(ids.input).value='';$(ids.send).disabled=true;$(ids.progress).textContent='Отправка запроса…';$(ids.progress).classList.remove('hidden');renderChat(mode);
  try{
    let data;
    $(ids.progress).textContent='Ассистент анализирует данные…';
    if(a){
      const f=new FormData();
      f.append('file',a.file);f.append('question',question);f.append('previous_response_id','');f.append('analysis_id',chat.analysisId||'');
      f.append('context_text',`${chat.context}\n\n${buildEngineeringContext()}`);f.append('conversation_json',JSON.stringify(prior));
      if(a.crop)f.append('crop_json',JSON.stringify(a.crop));
      data=await apiRequest('/api/chat-image',{method:'POST',body:f},{timeoutMs:120000,retries:1});
    }else{
      data=await apiRequest('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,previous_response_id:null,analysis_id:chat.analysisId,context_text:`${chat.context}\n\n${buildEngineeringContext()}`,conversation:prior})},{timeoutMs:120000,retries:1});
    }
    if(!data?.response)throw new Error('Сервер вернул ответ без текста');
    chat.responseId=data.response_id||null;chat.messages.push({role:'assistant',content:data.response});
    if(a)clearChatAttachment(mode);renderChat(mode);scheduleAutosave();
  }catch(error){
    const message=error?.message||'Неизвестная ошибка';
    chat.messages.push({role:'assistant',content:`Не удалось получить ответ: ${message}`});renderChat(mode);toast(message);
  }finally{
    $(ids.send).disabled=false;$(ids.progress).classList.add('hidden');$(ids.progress).textContent='Ассистент отвечает...';$(ids.input).focus();
  }
}

function clearChat(mode){const chat=state.chat[mode];chat.messages=[];chat.responseId=null;clearChatAttachment(mode);renderChat(mode);}
['analysis','stock'].forEach(mode=>{const ids=chatIds(mode),canvas=$(ids.canvas);$(ids.send).onclick=()=>sendChat(mode);$(ids.clear).onclick=()=>clearChat(mode);$(ids.file).addEventListener('change',e=>loadChatImage(mode,e.target.files[0]));$(ids.useAll).onclick=()=>useWholeChatImage(mode);$(ids.resetCrop).onclick=()=>resetChatCrop(mode);$(ids.clearImage).onclick=()=>clearChatAttachment(mode);canvas.addEventListener('pointerdown',e=>beginChatCrop(mode,e));canvas.addEventListener('pointermove',e=>moveChatCrop(mode,e));window.addEventListener('pointerup',()=>endChatCrop(mode));$(ids.input).addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat(mode);}});});

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
  const notesReady = ($('stockNotes')?.value || '').trim().length >= 10;
  $('stockBtn').disabled = !(state.file || notesReady); $('aiContourBtn').disabled = !state.file;
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


function pickAnalysisValue(text, patterns, fallback='Не определено') {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1].trim().replace(/[.;,]+$/,'');
  }
  return fallback;
}
function renderTabletAnalysisSummary(response, intelligence={}) {
  const root=document.getElementById('tabletAnalysisSummary');
  const cards=document.getElementById('tabletAnalysisCards');
  const checks=document.getElementById('tabletAnalysisChecks');
  const full=document.getElementById('tabletAnalysisFullText');
  if(!root||!cards||!checks||!full)return;
  const text=String(response||'');
  const data={
    material:pickAnalysisValue(text,[/Материал(?: детали)?[:\s-]+([^\n]+)/i,/AISI\s*\d+/i], intelligence.material||'Не определён'),
    geometry:pickAnalysisValue(text,[/Общая длина[:\s-]+([^\n]+)/i,/Размеры?[^\n]*[:\s-]+([^\n]+)/i], 'См. полный анализ'),
    thread:pickAnalysisValue(text,[/Резьба[:\s-]+([^\n]+)/i,/\b(M\d+(?:[x×]\d+(?:[.,]\d+)?)?)/i], 'Не найдена'),
    chamfer:pickAnalysisValue(text,[/Фаск[аи][^:\n]*[:\s-]+([^\n]+)/i,/([0-9]+(?:[.,][0-9]+)?\s*[x×]\s*[0-9]+°)/i], 'Не найдена'),
    tolerance:pickAnalysisValue(text,[/Допуски?[^:\n]*[:\s-]+([^\n]+)/i,/\b(H14|h14|±IT14\/2)\b/i], 'Не заданы')
  };
  const items=[['◈','Материал',data.material],['⌁','Геометрия',data.geometry],['⟳','Резьба',data.thread],['◇','Фаска',data.chamfer],['±','Допуски',data.tolerance]];
  cards.innerHTML=items.map(([icon,label,value])=>`<article class="tablet-analysis-card"><div class="icon">${icon}</div><div><span>${label}</span><strong>${escapeHtml(value)}</strong></div><em>✓</em></article>`).join('');
  const counts={
    sizes:(intelligence.dimensions||intelligence.sizes||[]).length||((text.match(/(?:Ø|\bR\d|\b\d+(?:[.,]\d+)?\s*мм)/gi)||[]).length),
    tolerances:(intelligence.tolerances||[]).length||((text.match(/(?:H14|h14|IT14|±\s*\d)/g)||[]).length),
    threads:(intelligence.threads||[]).length||((text.match(/\bM\d+(?:[x×]\d+(?:[.,]\d+)?)?/gi)||[]).length),
    chamfers:(intelligence.chamfers||[]).length||((text.match(/\d+(?:[.,]\d+)?\s*[x×]\s*\d+°/g)||[]).length)
  };
  const checkItems=[['Материал найден',data.material!=='Не определён'?'готово':'проверь'],['Размеры извлечены',counts.sizes?String(counts.sizes):'проверь'],['Допуски распознаны',counts.tolerances?String(counts.tolerances):'нет'],['Резьбы распознаны',counts.threads?String(counts.threads):'нет'],['Фаски распознаны',counts.chamfers?String(counts.chamfers):'нет']];
  checks.innerHTML=checkItems.map(([label,value])=>`<li><i>✓</i><span>${label}</span><b>${escapeHtml(value)}</b></li>`).join('');
  full.innerHTML=renderText(text);
  root.classList.remove('hidden');
  root.closest('.result-panel')?.classList.add('has-tablet-summary');
}
function clearTabletAnalysisSummary(){document.getElementById('tabletAnalysisSummary')?.classList.add('hidden');document.querySelector('.result-panel')?.classList.remove('has-tablet-summary');}

$('analyzeBtn').onclick = async () => {
  if (!state.file) return; if(window.__tabletWorkflowActivate) window.__tabletWorkflowActivate(1,false); $('analyzeBtn').disabled=true; $('progress').classList.remove('hidden'); const form=new FormData(); form.append('file',state.file); form.append('prompt',$('promptInput').value.trim()); form.append('project_json',JSON.stringify(collectProjectData())); const ext=state.file.name.split('.').pop().toLowerCase(); if(state.crop && state.file.type!=='application/pdf' && ext!=='slddrw') form.append('crop_json',JSON.stringify(state.crop));
  try { const r=await fetch('/api/analyze',{method:'POST',body:form}); const d=await r.json(); if(!r.ok) throw new Error(d.detail||'Ошибка'); $('resultEmpty').classList.add('hidden'); $('resultContent').classList.remove('hidden'); $('resultContent').innerHTML=renderText(d.response); $('resultMeta').textContent=`${d.model}${d.mock?' · MOCK':''} · #${d.id}`; startChat('analysis',d); applyDrawingIntelligence(d.drawing_intelligence||{}); renderTabletAnalysisSummary(d.response,d.drawing_intelligence||{}); toast('Анализ готов'); if(window.__tabletWorkflowActivate) setTimeout(()=>window.__tabletWorkflowActivate(2,false),450); setTimeout(()=>document.getElementById('tabletAnalysisSummary')?.scrollIntoView({behavior:'smooth',block:'start'}),520); }
  catch(e){toast(e.message);} finally{$('progress').classList.add('hidden');syncFileUi();}
};

document.querySelectorAll('input[name="stockMode"]').forEach(input => input.addEventListener('change', () => {
  if (!input.checked) return;
  syncStockModeUi(input.value);
  renderEditor();
  scheduleAutosave();
}));
document.querySelectorAll('[data-zero-value], [data-side-value]').forEach(input => input.addEventListener('change', () => {
  syncStockOptionValues();
  scheduleAutosave();
}));
['zeroReferenceCustom','firstSideCustom'].forEach(id => $(id).addEventListener('input', () => {
  syncStockOptionValues();
  scheduleAutosave();
}));
['blankDiameter','blankLength','blankWidth','blankHeight','blankLengthMill','stockNotes'].forEach(id=>$(id).addEventListener('input',()=>{renderEditor();scheduleAutosave();}));
syncStockModeUi();
syncStockOptionValues();

$('stockBtn').onclick = async () => {
  const notes = $('stockNotes').value.trim();
  if(!state.file && notes.length < 10){
    $('stockNotes').classList.add('field-error');
    toast('Загрузите чертёж или подробно опишите деталь минимум 10 символами');
    return;
  }
  $('stockNotes').classList.remove('field-error');
  $('stockBtn').disabled=true;$('stockProgress').classList.remove('hidden');const f=new FormData();
  if(state.file) f.append('file',state.file);
  f.append('stock_mode',state.stockMode);
  if(state.stockMode==='lathe'){
    f.append('blank_diameter',$('blankDiameter').value);f.append('blank_length',$('blankLength').value);
  }else if(state.stockMode==='mill'){
    f.append('blank_width',$('blankWidth').value);f.append('blank_height',$('blankHeight').value);f.append('blank_length',$('blankLengthMill').value);
  }else{
    f.append('blank_diameter',$('blankDiameter').value);f.append('blank_length',$('blankLength').value);
    f.append('blank_width',$('blankWidth').value);f.append('blank_height',$('blankHeight').value);f.append('blank_mill_length',$('blankLengthMill').value);
  }
  syncStockOptionValues(); f.append('zero_reference',$('zeroReference').value);f.append('first_side',$('firstSide').value);f.append('notes',$('stockNotes').value);f.append('shopturn_json',JSON.stringify(collectShopTurnPayload()));f.append('project_json',JSON.stringify(collectProjectData()));
  try{const r=await fetch('/api/stock-removal',{method:'POST',body:f});const d=await r.json();if(!r.ok)throw new Error(d.detail||'Ошибка');$('stockResultEmpty').classList.add('hidden');$('stockResultContent').classList.remove('hidden');$('stockResultContent').innerHTML=renderText(d.response);$('stockResultMeta').textContent=`${d.model}${d.mock?' · MOCK':''} · ${d.source==='description'?'по описанию':'по чертежу'} · #${d.id}`;startChat('stock',d);toast('План сформирован');}catch(e){toast(e.message);}finally{$('stockProgress').classList.add('hidden');syncFileUi();}
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
function sinumerikText(){const valid=validateContour(),st=collectShopTurnData(),op=SHOP_OPERATIONS[st.operation]||{label:'Операция не выбрана'},route=state.operationRoute.filter(o=>o.enabled!==false),head=[`PERSONAL AI CLIENT PRO · SHOPTURN FLOW`,`ROZFOOD`,`Станок: ${st.machineProfile==='tengyue_ck52pty'?'Tengyue CK52PT-Y · Siemens SINUMERIK 828D / ShopTurn':'Пользовательский профиль'}`,`Дата: ${new Date().toLocaleString('ru-RU')}`,`Операция: ${op.label}`,`Инструмент: T${st.toolT} D${st.toolD} · ${st.toolName} · ${st.holder} · ${st.insert}`,`Режим: S=${st.speed} · F=${st.feed} · глубина=${st.depth} · СОЖ=${st.coolant?'ON':'OFF'}`,`Цикл: Machining=${st.machining} · Pos=${st.position} · X0=${st.x0} · Z0=${st.z0} · X1=${st.x1}${st.incrementMode==='incremental'?' INC':''} · Z1=${st.z1}${st.incrementMode==='incremental'?' INC':''}`,`FS1=${st.fs1} · FS2=${st.fs2} · FS3=${st.fs3} · UX=${st.ux} · UZ=${st.uz}`,`X: ${state.xMode==='diameter'?'диаметр':'радиус'}`,`Z0: ${state.z0==='right'?'правый торец':'левый торец'}`,`Проверка: ${valid?'ПРОЙДЕНА':'ЕСТЬ ОШИБКИ'}`,'',`Резьбы проекта: ${state.projectThreads.filter(t=>t.enabled!==false).map(threadDisplay).join(', ')||'нет'}`,`Фаски/кромки: ${(state.chamfersEnabled?state.chamfers.filter(c=>c.enabled!==false):[]).map(c=>c.mode==='chamfer'?c.notation:c.mode==='edge_break'?'снять остроту':'нет').join(', ')||'нет'}`,'', 'МАРШРУТ ОПЕРАЦИЙ:',...route.map((o,i)=>`${i+1}. ${o.label||o.operation} · T${o.toolT||'?'} D${o.toolD||'?'} · ${o.toolName||'—'} · S=${o.speed||'—'} F=${o.feed||'—'}`),'','КОНТУР X/Z:'];const lines=state.contourPoints.map((p,i)=>{const m=TYPE_META[p.type];return `${String(i+1).padStart(3,'0')} | ${m.sin.padEnd(12)} | X=${fmt(p.x)} | Z=${fmt(p.z)} | ${p.rv||'—'} | ${p.direction||'—'}`;});const steps=buildShopTurnSteps().map((s,i)=>`${i+1}. ${s.title}: ${s.instruction.replace(/<[^>]*>/g,'')}`);return [...head,...lines,'','ПОШАГОВЫЙ ВВОД SHOPTURN:',...steps,'','ВНИМАНИЕ: карта ввода, а не готовая NC-программа. Сверить с исходным чертежом, инструментом и фактической заготовкой перед Cycle Start.'].join('\n');}
$('exportSinumerikBtn').onclick=()=>{const valid=validateContour();if(!valid&&!confirm('В контуре есть ошибки. Всё равно экспортировать?'))return;download('sinumerik-828d-contour.txt','text/plain;charset=utf-8',sinumerikText());};
$('importBtn').onclick=()=>$('importContourInput').click();$('importContourInput').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const txt=await f.text();let points;if(f.name.toLowerCase().endsWith('.json')){const d=JSON.parse(txt);points=Array.isArray(d)?d:d.points;if(d.settings)applyEditorSettings(d.settings);}else{const rows=txt.trim().split(/\r?\n/).slice(1);points=rows.map(r=>{const c=r.split(';');return{x:number(c[1]),z:number(c[2]),type:Object.keys(TYPE_META).find(k=>TYPE_META[k].label===c[3])||'lineX',rv:c[4]||'—',direction:c[5]||'—'};});}if(!Array.isArray(points)||points.length<2)throw new Error();pushUndo();state.contourPoints=points.map((p,i)=>({x:number(p.x),z:number(p.z),type:i===0?'start':TYPE_META[p.type]?p.type:'lineX',rv:p.rv||'—',direction:p.direction||'—'}));state.selectedIndex=0;state.validation=[];renderEditor();scheduleAutosave();toast('Контур импортирован');}catch{toast('Не удалось импортировать файл');}e.target.value='';};

function collectEditorSettings(){return{xMode:state.xMode,process:state.process,z0:state.z0,closed:state.closed,snap:state.snap,snapStep:state.snapStep,showBlank:state.showBlank,showLabels:state.showLabels,showDimensions:state.showDimensions};}
function applyEditorSettings(s={}){Object.assign(state,{xMode:s.xMode||'diameter',process:s.process||'outer',z0:s.z0||'right',closed:!!s.closed,snap:s.snap!==false,snapStep:number(s.snapStep,.1),showBlank:s.showBlank!==false,showLabels:s.showLabels!==false,showDimensions:!!s.showDimensions});$('xModeSelect').value=state.xMode;$('processSelect').value=state.process;$('z0Select').value=state.z0;$('snapToggle').checked=state.snap;$('snapStepInput').value=state.snapStep;$('blankOverlayToggle').checked=state.showBlank;$('labelsToggle').checked=state.showLabels;$('dimensionsToggle').checked=state.showDimensions;$('closeContourBtn').textContent=state.closed?'Разомкнуть':'Замкнуть';}
function collectProjectData(){syncStockOptionValues();return{contourPoints:state.contourPoints,editor:collectEditorSettings(),shopturn:collectShopTurnData(),operationRoute:state.operationRoute,projectThreads:state.projectThreads,chamfers:state.chamfers,chamfersEnabled:state.chamfersEnabled,drawingIntel:state.drawingIntel,ruleControl:state.ruleControl,threadLibraryUi:state.threadLibraryUi,stockMode:state.stockMode,blank:{diameter:$('blankDiameter').value,length:$('blankLength').value,width:$('blankWidth').value,height:$('blankHeight').value,millLength:$('blankLengthMill').value},zeroReference:$('zeroReference').value,firstSide:$('firstSide').value,stockOptions:{zero:[...document.querySelectorAll('[data-zero-value]:checked')].map(x=>x.dataset.zeroValue),sides:[...document.querySelectorAll('[data-side-value]:checked')].map(x=>x.dataset.sideValue),zeroCustom:$('zeroReferenceCustom').value,sideCustom:$('firstSideCustom').value},notes:$('stockNotes').value,fileName:state.file?.name||state.restoredFileName||null,updatedAt:Date.now()};}
function applyProjectData(d={}, options={}){const restoreFileLabel=options.restoreFileLabel!==false;state.restoredFileName=restoreFileLabel?(d.fileName||null):null;state.contourPoints=Array.isArray(d.contourPoints)?clone(d.contourPoints):[];applyEditorSettings(d.editor||{});state.stockMode=STOCK_MODE_VALUES.has(d.stockMode)?d.stockMode:'lathe';syncStockModeUi(state.stockMode);const b=d.blank||{};$('blankDiameter').value=b.diameter||'';$('blankLength').value=b.length||'';$('blankWidth').value=b.width||'';$('blankHeight').value=b.height||'';$('blankLengthMill').value=b.millLength||'';applyStockOptionValues(d.zeroReference||'',d.firstSide||'');$('stockNotes').value=d.notes||'';applyShopTurnData(d.shopturn||{});state.operationRoute=Array.isArray(d.operationRoute)?clone(d.operationRoute):[];state.selectedOperationCodes=[];state.projectThreads=Array.isArray(d.projectThreads)?clone(d.projectThreads).map(x=>({...x,enabled:x.enabled!==false})):[];state.chamfers=Array.isArray(d.chamfers)?clone(d.chamfers).map(x=>({...x,enabled:x.enabled!==false})):[];state.chamfersEnabled=d.chamfersEnabled!==false;state.ruleControl=d.ruleControl&&typeof d.ruleControl==='object'?{enabled:d.ruleControl.enabled!==false,active:{...(d.ruleControl.active||{})},search:String(d.ruleControl.search||'')}:{enabled:true,active:{},search:''};state.threadLibraryUi=d.threadLibraryUi&&typeof d.threadLibraryUi==='object'?{family:d.threadLibraryUi.family||'metric_iso',search:d.threadLibraryUi.search||'',diameter:d.threadLibraryUi.diameter||'all',pitch:d.threadLibraryUi.pitch||'all',standardOnly:d.threadLibraryUi.standardOnly!==false,selectedId:d.threadLibraryUi.selectedId||null}:{family:'metric_iso',search:'',diameter:'all',pitch:'all',standardOnly:true,selectedId:null};state.drawingIntel=d.drawingIntel||{tolerances:[],tolerance_interpretations:[],threads:[],chamfers_detected:[],requires_chamfer_decision:true,notes:[]};state.drawingIntel.threads=(state.drawingIntel.threads||[]).map(x=>({...x,enabled:x.enabled!==false}));if((state.drawingIntel.tolerances?.length||state.drawingIntel.threads?.length||state.chamfers.length||state.projectThreads.length))$('drawingIntelligencePanel').classList.remove('hidden');state.selectedIndex=0;state.activeRouteIndex=-1;state.validation=[];if($('threadSearchInput'))$('threadSearchInput').value=state.threadLibraryUi.search||'';renderDrawingIntelligence();renderThreadLibrary();renderProjectThreads();renderChamferEditor();renderOperationRoute();renderOperationMultiPicker();renderEditor();syncFileUi();}
function scheduleAutosave(){clearTimeout(state.autosaveTimer);clearTimeout(state.serverSaveTimer);$('autosaveState').textContent='Сохранение...';state.autosaveTimer=setTimeout(()=>{localStorage.setItem('personal-ai-pro-draft',JSON.stringify(collectProjectData()));$('autosaveState').textContent=state.currentProjectId?'Локально сохранено · синхронизация...':'Автосохранено локально';},450);if(state.currentProjectId){state.serverSaveTimer=setTimeout(async()=>{try{const r=await fetch(`/api/projects/${state.currentProjectId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:state.currentProjectName,data:collectProjectData()})});if(r.ok)$('autosaveState').textContent='Синхронизировано с Railway Volume';else $('autosaveState').textContent='Локально сохранено · ошибка синхронизации';}catch{$('autosaveState').textContent='Локально сохранено · сервер недоступен';}},1400);}}
function loadLocalDraft(){try{const d=JSON.parse(localStorage.getItem('personal-ai-pro-draft')||'null');if(d)applyProjectData(d,{restoreFileLabel:false});}catch{}}

async function saveProject(forceCreate=false){const generated=`Проект ${new Date().toLocaleDateString('ru-RU')} ${new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}`;const name=state.currentProjectName==='Локальный черновик'?($('projectNameInput').value.trim()||generated):state.currentProjectName;if(!name.trim())return;const payload={name:name.trim(),data:collectProjectData()};try{const method=state.currentProjectId&&!forceCreate?'PUT':'POST',url=state.currentProjectId&&!forceCreate?`/api/projects/${state.currentProjectId}`:'/api/projects';const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok)throw new Error(d.detail||'Ошибка сохранения');state.currentProjectId=d.id;state.currentProjectName=d.name;updateProjectUi();$('autosaveState').textContent='Сохранено на Railway Volume';toast('Проект сохранён');}catch(e){toast(e.message);}}
$('saveProjectBtn').onclick=()=>saveProject(false);$('createProjectBtn').onclick=async()=>{const name=$('projectNameInput').value.trim()||`Проект ${new Date().toLocaleString('ru-RU')}`;resetWorkspaceForNewProject();state.currentProjectName=name;updateProjectUi();await saveProject(true);};
function resetWorkspaceForNewProject(options={}){
  const autosave = options.autosave !== false;
  state.currentProjectId=null;state.currentProjectName='Локальный черновик';state.file=null;state.restoredFileName=null;state.image=null;state.crop=null;state.contourPoints=[];state.selectedIndex=0;state.undoStack=[];state.redoStack=[];state.validation=[];state.operationRoute=[];state.selectedOperationCodes=[];state.activeRouteIndex=-1;state.projectThreads=[];state.chamfers=[];state.chamfersEnabled=true;state.ruleControl={enabled:true,active:{},search:''};state.threadLibraryUi={family:'metric_iso',search:'',diameter:'all',pitch:'all',standardOnly:true,selectedId:null};state.drawingIntel={tolerances:[],tolerance_interpretations:[],threads:[],chamfers_detected:[],requires_chamfer_decision:true,notes:[]};
  fileInput.value='';dropZone.classList.remove('hidden');previewArea.classList.add('hidden');pdfPreview.src='';
  ['promptInput','blankDiameter','blankLength','blankWidth','blankHeight','blankLengthMill','zeroReference','firstSide','zeroReferenceCustom','firstSideCustom','stockNotes','offsetXInput','offsetZInput'].forEach(id=>{if($(id))$(id).value='';});
  document.querySelectorAll('[data-zero-value], [data-side-value]').forEach(input=>{input.checked=false;input.closest('.choice-card')?.classList.remove('selected');});
  state.stockMode='lathe';syncStockModeUi('lathe');syncStockOptionValues();
  ['confirmDrawing','confirmBlank','confirmZero','confirmTool'].forEach(id=>{if($(id))$(id).checked=false;});
  SHOP_INPUT_IDS.forEach(id=>{const el=$(id);if(!el)return;if(el.type==='checkbox')el.checked=false;else if(el.tagName==='SELECT')el.selectedIndex=0;else el.value='';});
  state.shopturn.wizardStep=0;populateToolPresets('');resetChat('analysis',true);resetChat('stock',true);
  $('resultContent').classList.add('hidden');$('resultEmpty').classList.remove('hidden');clearTabletAnalysisSummary();$('resultMeta').textContent='';$('stockResultContent').classList.add('hidden');$('stockResultEmpty').classList.remove('hidden');$('stockResultMeta').textContent='';$('drawingIntelligencePanel').classList.add('hidden');
  localStorage.removeItem('personal-ai-pro-draft');updateProjectUi();syncFileUi();if($('threadSearchInput'))$('threadSearchInput').value=state.threadLibraryUi.search||'';renderDrawingIntelligence();renderThreadLibrary();renderProjectThreads();renderChamferEditor();renderOperationRoute();renderOperationMultiPicker();renderEditor();renderShopTurn();if(autosave)scheduleAutosave();else $('autosaveState').textContent='Новая чистая сессия';
}
function hasWorkspaceData(){
  return Boolean(
    state.file || state.restoredFileName || state.contourPoints.length || state.operationRoute.length ||
    state.projectThreads.length || state.chamfers.length ||
    $('promptInput')?.value.trim() || $('stockNotes')?.value.trim() ||
    $('blankDiameter')?.value || $('blankLength')?.value || $('blankWidth')?.value ||
    $('blankHeight')?.value || $('blankLengthMill')?.value
  );
}
$('newProjectBtn').onclick=()=>{
  if(hasWorkspaceData() && !confirm('Создать новый проект? Несохранённые рабочие данные будут удалены. Сохранённые проекты и история останутся.')) return;
  resetWorkspaceForNewProject();
  toast('Новый проект создан. Все рабочие поля очищены, проекты и история сохранены.');
};
async function loadProjects(){const list=$('projectsList');list.innerHTML='<div class="result-empty"><span>Загрузка...</span></div>';try{const r=await fetch('/api/projects');const items=await r.json();if(!items.length){list.innerHTML='<div class="result-empty"><strong>Проектов пока нет</strong></div>';return;}list.innerHTML=items.map(p=>`<div class="project-item"><div><h3>${escapeHtml(p.name)}</h3><small>Обновлён ${new Date(p.updated_at*1000).toLocaleString('ru-RU')}</small></div><div><button data-load="${p.id}">Открыть</button><button data-del="${p.id}" class="danger-lite">Удалить</button></div></div>`).join('');list.querySelectorAll('[data-load]').forEach(b=>b.onclick=async()=>{const r=await fetch(`/api/projects/${b.dataset.load}`),d=await r.json();if(!r.ok)return toast(d.detail||'Ошибка');state.currentProjectId=d.id;state.currentProjectName=d.name;applyProjectData(d.data);updateProjectUi();setView('stock');toast('Проект открыт');});list.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Удалить проект?'))return;await fetch(`/api/projects/${b.dataset.del}`,{method:'DELETE'});loadProjects();});}catch(e){list.innerHTML=`<div class="result-empty"><strong>${escapeHtml(e.message)}</strong></div>`;}}


function normalizeChamferNotation(value){
  const raw=String(value||'').trim().replace(/[xх]/gi,'×').replace(/\s+/g,'');
  if(!raw)return '1×45°';
  const m=raw.match(/^(\d+(?:[.,]\d+)?)×(\d+(?:[.,]\d+)?)(?:°)?$/);
  return m?`${m[1].replace(',','.')}×${m[2].replace(',','.')}°`:raw;
}
function normalizeChamferNumber(value,fallback){
  const raw=String(value??'').trim().replace(',','.');
  const number=Number(raw);
  return Number.isFinite(number)&&number>0?String(number):String(fallback);
}
function setChamferInputsFromNotation(value){
  const normalized=normalizeChamferNotation(value);
  const match=normalized.match(/(\d+(?:\.\d+)?)×(\d+(?:\.\d+)?)°?/);
  const compact=normalized.match(/^C(\d+(?:\.\d+)?)$/i);
  const size=match?match[1]:compact?compact[1]:'1';
  const angle=match?match[2]:'45';
  $('chamferSizeInput').value=size;
  $('chamferAngleInput').value=angle;
  return `${size}×${angle}°`;
}
function chamferNotationFromInputs(){
  const size=normalizeChamferNumber($('chamferSizeInput').value,1);
  const angle=normalizeChamferNumber($('chamferAngleInput').value,45);
  $('chamferSizeInput').value=size;
  $('chamferAngleInput').value=angle;
  return `${size}×${angle}°`;
}
function syncChamferNotationControls(){
  const enabled=$('chamferModeSelect').value==='chamfer';
  $('chamferSizeInput').disabled=!enabled;
  $('chamferAngleInput').disabled=!enabled;
  $('chamferNotationSplit').classList.toggle('is-disabled',!enabled);
}
function applyDrawingIntelligence(data={}){
  state.drawingIntel={
    tolerances:Array.isArray(data.tolerances)?data.tolerances:[],
    tolerance_interpretations:Array.isArray(data.tolerance_interpretations)?data.tolerance_interpretations:[],
    threads:Array.isArray(data.threads)?data.threads.map(x=>({...x,enabled:x.enabled!==false})):[],
    chamfers_detected:Array.isArray(data.chamfers_detected)?data.chamfers_detected:[],
    requires_chamfer_decision:data.requires_chamfer_decision!==false,
    notes:Array.isArray(data.notes)?data.notes:[]
  };
  for(const value of state.drawingIntel.tolerances) if(!(ruleIdentity('tolerance',value) in state.ruleControl.active)) state.ruleControl.active[ruleIdentity('tolerance',value)]=true;
  for(const value of state.drawingIntel.tolerance_interpretations) if(!(ruleIdentity('rule',value) in state.ruleControl.active)) state.ruleControl.active[ruleIdentity('rule',value)]=true;
  $('drawingIntelligencePanel').classList.remove('hidden');renderDrawingIntelligence();scheduleAutosave();
}
function toleranceEntries(){
  const interpretations=state.drawingIntel.tolerance_interpretations||[];
  const used=new Set();
  const normalize=value=>String(value||'').trim().toLowerCase().replace(/\s+/g,'');
  const tokens=(state.drawingIntel.tolerances||[]).map((value,index)=>{
    const matchIndex=interpretations.findIndex((rule,i)=>!used.has(i)&&normalize(rule.designation)===normalize(value));
    const match=matchIndex>=0?interpretations[matchIndex]:null;
    if(matchIndex>=0)used.add(matchIndex);
    return {kind:'tolerance',value,index,title:String(value),description:match?.display||'Распознанный допуск или техническое требование',application:match?.application||''};
  });
  const rules=interpretations.map((value,index)=>({kind:'rule',value,index,title:value.designation||'Правило',description:value.display||'',application:value.application||''})).filter((_,index)=>!used.has(index));
  return [...tokens,...rules];
}
function renderToleranceManager(){
  const entries=toleranceEntries();
  const active=entries.filter(x=>isRuleActive(x.kind,x.value)).length;
  $('ruleCountLabel').textContent=`Правила: ${active}/${entries.length}`;
  $('rulesEnabledToggle').checked=state.ruleControl.enabled;
  $('selectAllRulesCheckbox').checked=!!entries.length&&active===entries.length;
  $('selectAllRulesCheckbox').indeterminate=active>0&&active<entries.length;
  $('toleranceList').classList.toggle('is-master-disabled',!state.ruleControl.enabled);
  const search=String(state.ruleControl.search||'').trim().toLowerCase();
  const visibleEntries=search?entries.filter(entry=>[entry.title,entry.description,entry.application].join(' ').toLowerCase().includes(search)):entries;
  if($('engineeringRuleSearchInput')&&$('engineeringRuleSearchInput').value!==state.ruleControl.search)$('engineeringRuleSearchInput').value=state.ruleControl.search||'';
  if($('clearEngineeringRuleSearch'))$('clearEngineeringRuleSearch').classList.toggle('hidden',!search);
  $('toleranceList').innerHTML=visibleEntries.length?visibleEntries.map(entry=>{
    const key=ruleIdentity(entry.kind,entry.value),enabled=isRuleActive(entry.kind,entry.value);
    return `<article class="engineering-rule-row ${enabled?'':'is-disabled'}" data-rule-key="${escapeHtml(key)}">
      <label class="rule-check"><input type="checkbox" data-rule-toggle="${escapeHtml(key)}" ${enabled?'checked':''}><span></span></label>
      <div class="rule-copy"><strong>${escapeHtml(entry.title)}</strong><span>${escapeHtml(entry.description)}</span>${entry.application?`<small>${escapeHtml(entry.application)}</small>`:''}</div>
      <span class="rule-status ${enabled?'active':'off'}">${enabled?'Активно':'Отключено'}</span>
      <button class="rule-more" type="button" title="Переключить" data-rule-more="${escapeHtml(key)}">⋮</button>
    </article>`;
  }).join(''):(entries.length?'<span class="muted-text">По этому запросу правила не найдены.</span>':'<span class="muted-text">Явные допуски не распознаны. Проверь основную надпись и технические требования.</span>');
  document.querySelectorAll('[data-rule-toggle]').forEach(input=>input.onchange=()=>{
    state.ruleControl.active[input.dataset.ruleToggle]=input.checked;renderDrawingIntelligence();scheduleAutosave();
  });
  document.querySelectorAll('[data-rule-more]').forEach(button=>button.onclick=()=>{
    const key=button.dataset.ruleMore;state.ruleControl.active[key]=state.ruleControl.active[key]===false;renderDrawingIntelligence();scheduleAutosave();
  });
}
function renderDetectedThreads(){
  const threads=state.drawingIntel.threads||[],active=threads.filter(x=>x.enabled!==false).length;
  $('detectedThreadCountLabel').textContent=`Правила: ${active}/${threads.length}`;
  $('detectedThreadList').innerHTML=threads.length?threads.map((x,i)=>`<article class="detected-thread-row ${x.enabled===false?'is-disabled':''}">
    <label class="rule-check"><input type="checkbox" data-detected-thread-toggle="${i}" ${x.enabled===false?'':'checked'}><span></span></label>
    <button class="detected-thread" data-thread-index="${i}"><strong>${escapeHtml(x.display||threadDisplay(x))}</strong><span>${x.pitch_source==='iso_coarse_default'?'крупный шаг принят автоматически':'шаг указан на чертеже'}</span></button>
    <span class="rule-status ${x.enabled===false?'off':'active'}">${x.enabled===false?'Отключено':'Стандартная'}</span>
    <button class="rule-more" type="button" data-thread-menu="${i}">⋮</button>
  </article>`).join(''):'<span class="muted-text">Резьбы не распознаны.</span>';
  document.querySelectorAll('[data-thread-index]').forEach(btn=>btn.onclick=()=>selectDetectedThread(Number(btn.dataset.threadIndex)));
  document.querySelectorAll('[data-detected-thread-toggle]').forEach(input=>input.onchange=()=>{const thread=threads[Number(input.dataset.detectedThreadToggle)];if(thread){thread.enabled=input.checked;renderDrawingIntelligence();scheduleAutosave();}});
  document.querySelectorAll('[data-thread-menu]').forEach(button=>button.onclick=()=>{const thread=threads[Number(button.dataset.threadMenu)];if(thread){thread.enabled=thread.enabled===false;renderDrawingIntelligence();scheduleAutosave();}});
}
function renderDrawingIntelligence(){
  if(!$('toleranceList'))return;
  renderToleranceManager();
  renderDetectedThreads();
  const t=state.drawingIntel.tolerances||[],rules=state.drawingIntel.tolerance_interpretations||[],threads=state.drawingIntel.threads||[];
  const activeRules=toleranceEntries().filter(x=>isRuleActive(x.kind,x.value)).length;
  const activeThreads=threads.filter(x=>x.enabled!==false).length;
  $('drawingIntelBadge').textContent=`Допуски: ${activeRules} · Резьбы: ${activeThreads} · Фаски: ${state.chamfers.filter(x=>x.enabled!==false).length}`;
  const filtersChanged=!state.ruleControl.enabled||Object.values(state.ruleControl.active||{}).some(v=>v===false)||!!String(state.ruleControl.search||'').trim()||state.threadLibraryUi.search||state.threadLibraryUi.diameter!=='all'||state.threadLibraryUi.pitch!=='all'||state.threadLibraryUi.standardOnly!==true||state.chamfersEnabled===false||state.chamfers.some(x=>x.enabled===false);
  if($('resetEngineeringFiltersBtn'))$('resetEngineeringFiltersBtn').disabled=!filtersChanged;
  $('chamfersEnabledToggle').checked=state.chamfersEnabled;
  $('chamferRuleCountLabel').textContent=`Правила: ${state.chamfers.filter(x=>x.enabled!==false).length}/${state.chamfers.length}`;
  if(state.drawingIntel.chamfers_detected?.length&&!state.chamfers.length)setChamferInputsFromNotation(state.drawingIntel.chamfers_detected[0]);
  renderProjectThreads();
  renderChamferEditor();
}
function uniqueSorted(values){return [...new Set(values.filter(v=>v!==null&&v!==undefined&&v!==''))].sort((a,b)=>String(a).localeCompare(String(b),'ru',{numeric:true}));}
function familyLabel(id){return state.threadFamilies.find(x=>x.id===id)?.label||id;}
function currentThreadProfile(){return state.threadCatalog.find(x=>x.id===state.threadLibraryUi.selectedId)||null;}
function threadPitchLabel(profile){if(!profile)return '—';if(profile.tpi)return `${profile.tpi} TPI`;return profile.pitch_mm?`${Number(profile.pitch_mm).toFixed(4).replace(/0+$/,'').replace(/\.$/,'')} мм`:'По стандарту';}
function profileSearchText(profile){return [profile.designation,profile.family,profile.standard,profile.note,...(profile.aliases||[])].join(' ').toLowerCase();}
function filteredThreadProfiles(){
  const ui=state.threadLibraryUi,q=ui.search.trim().toLowerCase();
  return state.threadCatalog.filter(p=>{
    if(ui.family&&p.family!==ui.family)return false;
    if(q&&!profileSearchText(p).includes(q))return false;
    if(ui.diameter!=='all'&&String(p.diameter_mm)!==ui.diameter)return false;
    const pitchKey=p.tpi?`tpi:${p.tpi}`:p.pitch_mm!==null&&p.pitch_mm!==undefined?`mm:${p.pitch_mm}`:'none';
    if(ui.pitch!=='all'&&pitchKey!==ui.pitch)return false;
    if(ui.standardOnly&&!p.standard_profile)return false;
    return true;
  });
}
function renderThreadFamilyTabs(){
  $('threadFamilyTabs').innerHTML=state.threadFamilies.map(f=>`<button type="button" class="thread-family-tab ${state.threadLibraryUi.family===f.id?'active':''}" data-thread-family="${escapeHtml(f.id)}">${escapeHtml(f.label)}</button>`).join('');
  document.querySelectorAll('[data-thread-family]').forEach(btn=>btn.onclick=()=>{state.threadLibraryUi.family=btn.dataset.threadFamily;state.threadLibraryUi.diameter='all';state.threadLibraryUi.pitch='all';state.threadLibraryUi.selectedId=null;renderThreadLibrary();});
}
function renderThreadFilters(){
  const familyProfiles=state.threadCatalog.filter(p=>p.family===state.threadLibraryUi.family);
  const diameters=uniqueSorted(familyProfiles.map(p=>p.diameter_mm)).sort((a,b)=>Number(a)-Number(b));
  const pitches=uniqueSorted(familyProfiles.map(p=>p.tpi?`tpi:${p.tpi}`:p.pitch_mm!==null&&p.pitch_mm!==undefined?`mm:${p.pitch_mm}`:'none'));
  $('threadDiameterFilter').innerHTML='<option value="all">Любой</option>'+diameters.map(v=>`<option value="${v}" ${String(v)===state.threadLibraryUi.diameter?'selected':''}>${Number(v).toFixed(3).replace(/0+$/,'').replace(/\.$/,'')} мм</option>`).join('');
  $('threadPitchFilter').innerHTML='<option value="all">Любой</option>'+pitches.map(v=>{
    const label=v.startsWith('tpi:')?`${v.slice(4)} TPI`:v.startsWith('mm:')?`${Number(v.slice(3)).toFixed(4).replace(/0+$/,'').replace(/\.$/,'')} мм`:'По стандарту';
    return `<option value="${v}" ${v===state.threadLibraryUi.pitch?'selected':''}>${label}</option>`;
  }).join('');
  $('threadStandardOnlyToggle').checked=state.threadLibraryUi.standardOnly;
}
function selectThreadProfile(id,render=true){
  const profile=state.threadCatalog.find(x=>x.id===id);if(!profile)return;
  state.threadLibraryUi.selectedId=profile.id;
  if(!$('threadToleranceInput').value.trim())$('threadToleranceInput').value=$('threadSideSelect').value==='internal'?(profile.default_tolerance_internal||''):(profile.default_tolerance_external||'');
  if(render)renderThreadLibrary();
}
function renderThreadDetails(){
  const p=currentThreadProfile();
  if(!p){$('threadDetailsPanel').innerHTML='<div class="thread-detail-empty">Выбери профиль резьбы из библиотеки.</div>';return;}
  $('threadDetailsPanel').innerHTML=`<div class="thread-details-title"><strong>${escapeHtml(p.designation)}</strong><span class="${p.standard_profile?'standard':'template'}">${p.standard_profile?'Стандартная':'Шаблон'}</span></div>
    <dl class="thread-detail-table">
      <div><dt>Семейство</dt><dd>${escapeHtml(familyLabel(p.family))}</dd></div>
      <div><dt>Диаметр</dt><dd>${p.diameter_mm!==null&&p.diameter_mm!==undefined?`${Number(p.diameter_mm).toFixed(3).replace(/0+$/,'').replace(/\.$/,'')} мм`:'Задаётся отдельно'}</dd></div>
      <div><dt>Шаг</dt><dd>${escapeHtml(threadPitchLabel(p))}</dd></div>
      <div><dt>Исполнение</dt><dd>${$('threadSideSelect').value==='internal'?'Внутренняя':'Наружная'}</dd></div>
      <div><dt>Класс допуска</dt><dd>${escapeHtml($('threadToleranceInput').value.trim()||($('threadSideSelect').value==='internal'?p.default_tolerance_internal:p.default_tolerance_external)||'Задать вручную')}</dd></div>
      <div><dt>Профиль</dt><dd>${escapeHtml(p.profile_angle||'По стандарту')}</dd></div>
      <div><dt>Стандарт</dt><dd>${escapeHtml(p.standard||'Специальный')}</dd></div>
      ${p.taper?`<div><dt>Конусность</dt><dd>${escapeHtml(p.taper)}</dd></div>`:''}
    </dl>
    <p class="thread-detail-note">${escapeHtml(p.note||'Перед обработкой проверить исходный стандарт и калибр.')}</p>
    <button id="addThreadToProjectBtn" class="primary-button">＋ Добавить резьбу в проект</button>
    <button id="applyDetectedThreadBtn" class="small-button">◎ Взять из распознанного</button>`;
  $('addThreadToProjectBtn').onclick=()=>addSelectedThreadToProject();
  $('applyDetectedThreadBtn').onclick=()=>selectDetectedThread(0);
}
function renderThreadLibrary(){
  if(!$('threadProfileGrid'))return;
  renderThreadFamilyTabs();renderThreadFilters();
  let profiles=filteredThreadProfiles();
  if(!profiles.length&&state.threadLibraryUi.standardOnly){state.threadLibraryUi.standardOnly=false;renderThreadFilters();profiles=filteredThreadProfiles();}
  if(!profiles.some(x=>x.id===state.threadLibraryUi.selectedId))state.threadLibraryUi.selectedId=profiles[0]?.id||null;
  $('threadProfileGrid').innerHTML=profiles.length?profiles.slice(0,240).map(p=>`<button type="button" class="thread-profile-button ${p.id===state.threadLibraryUi.selectedId?'selected':''}" data-thread-profile="${escapeHtml(p.id)}"><span>${escapeHtml(p.designation)}</span>${p.id===state.threadLibraryUi.selectedId?'<b>✓</b>':''}</button>`).join(''):'<div class="thread-no-results">Профили не найдены. Измени фильтры или отключи «Только стандартные».</div>';
  document.querySelectorAll('[data-thread-profile]').forEach(btn=>btn.onclick=()=>selectThreadProfile(btn.dataset.threadProfile));
  $('threadCatalogCount').textContent=`Показано ${Math.min(profiles.length,240)} из ${state.threadCatalog.length} профилей${profiles.length>240?' · уточни поиск':''}`;
  renderThreadDetails();
}
async function loadThreadCatalog(){
  try{
    const r=await fetch('/api/thread-catalog');const d=await r.json();if(!r.ok)throw new Error();
    state.threadCatalog=d.items||[];state.threadFamilies=d.families||[];
    const selected=state.threadCatalog.find(p=>p.id===state.threadLibraryUi.selectedId);
    const familyExists=state.threadFamilies.some(f=>f.id===state.threadLibraryUi.family);
    if(selected){state.threadLibraryUi.family=selected.family;renderThreadLibrary();}
    else if(familyExists){renderThreadLibrary();}
    else populateThreadCatalog('M8');
  }catch{
    state.threadFamilies=[{id:'metric_iso',label:'Метрическая ISO (M)'}];
    state.threadCatalog=[{id:'metric_iso:m8x1.25',family:'metric_iso',designation:'M8×1.25',pitch_mm:1.25,diameter_mm:8,standard:'ISO',standard_profile:true,default_tolerance_external:'6g',default_tolerance_internal:'6H'}];
    populateThreadCatalog('M8');
  }
}
function populateThreadCatalog(selected='M8'){
  if(!state.threadCatalog.length)return;
  const normalized=String(selected||'').replace(/\s/g,'').toLowerCase();
  const found=state.threadCatalog.find(p=>String(p.designation).replace(/\s/g,'').toLowerCase()===normalized)||state.threadCatalog.find(p=>String(p.designation).replace(/\s/g,'').toLowerCase().startsWith(normalized))||state.threadCatalog.find(p=>p.family==='metric_iso')||state.threadCatalog[0];
  state.threadLibraryUi.family=found.family;state.threadLibraryUi.selectedId=found.id;renderThreadLibrary();
}
function updateThreadPitchOptions(preferred=null){
  if(preferred===null||preferred===undefined)return renderThreadLibrary();
  const current=currentThreadProfile();if(!current)return;
  const base=(current.aliases?.[0]||current.designation.split('×')[0]).toLowerCase();
  const found=state.threadCatalog.find(p=>p.family===current.family&&(p.aliases?.[0]||p.designation.split('×')[0]).toLowerCase()===base&&Math.abs(Number(p.pitch_mm||0)-Number(preferred))<1e-6);
  if(found)state.threadLibraryUi.selectedId=found.id;renderThreadLibrary();
}
function selectDetectedThread(index=0){
  const thread=state.drawingIntel.threads?.[index];if(!thread)return toast('Распознанная резьба не найдена');
  const normalized=String(thread.designation||'').replace(/\s/g,'').toLowerCase();
  const found=state.threadCatalog.find(p=>String(p.designation).replace(/\s/g,'').toLowerCase().startsWith(normalized)&&(!thread.pitch||Math.abs(Number(p.pitch_mm||0)-Number(thread.pitch))<1e-6))||state.threadCatalog.find(p=>String(p.designation).replace(/\s/g,'').toLowerCase().startsWith(normalized));
  if(found){state.threadLibraryUi.family=found.family;state.threadLibraryUi.selectedId=found.id;}
  $('threadToleranceInput').value=thread.tolerance_class||$('threadToleranceInput').value;
  renderThreadLibrary();toast(`${thread.display||threadDisplay(thread)} выбрана из распознавания`);
}
function selectedThread(){
  const p=currentThreadProfile();if(!p)return{};
  return {id:p.id,designation:p.designation,pitch:p.pitch_mm||null,tpi:p.tpi||null,family:p.family,standard:p.standard,profile_angle:p.profile_angle,side:$('threadSideSelect').value,tolerance:$('threadToleranceInput').value.trim(),source:'operator',enabled:true};
}
function renderProjectThreads(){
  if(!$('projectThreadList'))return;
  $('projectThreadList').innerHTML=state.projectThreads.length?`<div class="project-thread-heading">Резьбы проекта</div>`+state.projectThreads.map((t,i)=>`<div class="project-thread ${t.enabled===false?'is-disabled':''}"><label class="rule-check"><input type="checkbox" data-toggle-project-thread="${i}" ${t.enabled===false?'':'checked'}><span></span></label><span><strong>${escapeHtml(threadDisplay(t))}</strong> · ${t.side==='internal'?'внутренняя':'наружная'} ${escapeHtml(t.tolerance||'')}</span><button data-remove-thread="${i}">×</button></div>`).join(''):'<div class="muted-text">Резьбы в проект не добавлены.</div>';
  document.querySelectorAll('[data-remove-thread]').forEach(b=>b.onclick=()=>{state.projectThreads.splice(Number(b.dataset.removeThread),1);renderProjectThreads();scheduleAutosave();});
  document.querySelectorAll('[data-toggle-project-thread]').forEach(input=>input.onchange=()=>{state.projectThreads[Number(input.dataset.toggleProjectThread)].enabled=input.checked;renderProjectThreads();scheduleAutosave();});
}
function addSelectedThreadToProject(){
  const t=selectedThread();if(!t.designation)return toast('Выбери резьбу из библиотеки');
  const duplicate=state.projectThreads.find(x=>x.id===t.id&&x.side===t.side&&x.tolerance===t.tolerance);
  if(duplicate){duplicate.enabled=true;renderProjectThreads();return toast('Эта резьба уже есть в проекте');}
  state.projectThreads.push(t);renderProjectThreads();
  if(['thread_ext','thread_int'].includes($('shopOperationSelect').value)&&t.pitch){$('feedInput').value=t.pitch;$('toolInsertInput').value=`${$('shopOperationSelect').value==='thread_int'?'16IR':'16ER'} ${t.pitch} ISO`;renderShopTurn();}
  scheduleAutosave();toast(`${threadDisplay(t)} добавлена`);
}


function resetEngineeringFilters(){
  state.ruleControl.enabled=true;state.ruleControl.active={};state.ruleControl.search='';
  for(const entry of toleranceEntries())state.ruleControl.active[ruleIdentity(entry.kind,entry.value)]=true;
  state.threadLibraryUi={family:'metric_iso',search:'',diameter:'all',pitch:'all',standardOnly:true,selectedId:null};
  if($('engineeringRuleSearchInput'))$('engineeringRuleSearchInput').value='';$('threadSearchInput').value='';$('threadToleranceInput').value='';$('threadSideSelect').value='external';
  state.chamfersEnabled=true;state.chamfers.forEach(x=>x.enabled=true);
  renderDrawingIntelligence();renderThreadLibrary();scheduleAutosave();toast('Инженерные фильтры сброшены');
}
$('engineeringRuleSearchInput').oninput=e=>{state.ruleControl.search=e.target.value;renderDrawingIntelligence();};
$('clearEngineeringRuleSearch').onclick=()=>{state.ruleControl.search='';$('engineeringRuleSearchInput').value='';renderDrawingIntelligence();$('engineeringRuleSearchInput').focus();};
$('rulesEnabledToggle').onchange=e=>{state.ruleControl.enabled=e.target.checked;renderDrawingIntelligence();scheduleAutosave();};
$('selectAllRulesCheckbox').onchange=e=>{for(const entry of toleranceEntries())state.ruleControl.active[ruleIdentity(entry.kind,entry.value)]=e.target.checked;renderDrawingIntelligence();scheduleAutosave();};
$('enableAllRulesBtn').onclick=()=>{for(const entry of toleranceEntries())state.ruleControl.active[ruleIdentity(entry.kind,entry.value)]=true;state.ruleControl.enabled=true;renderDrawingIntelligence();scheduleAutosave();};
$('resetEngineeringFiltersBtn').onclick=resetEngineeringFilters;
$('threadSearchInput').oninput=e=>{state.threadLibraryUi.search=e.target.value;renderThreadLibrary();};
$('threadDiameterFilter').onchange=e=>{state.threadLibraryUi.diameter=e.target.value;state.threadLibraryUi.selectedId=null;renderThreadLibrary();};
$('threadPitchFilter').onchange=e=>{state.threadLibraryUi.pitch=e.target.value;state.threadLibraryUi.selectedId=null;renderThreadLibrary();};
$('threadStandardOnlyToggle').onchange=e=>{state.threadLibraryUi.standardOnly=e.target.checked;state.threadLibraryUi.selectedId=null;renderThreadLibrary();};
$('threadSideSelect').onchange=()=>{const p=currentThreadProfile();$('threadToleranceInput').value=$('threadSideSelect').value==='internal'?(p?.default_tolerance_internal||''):(p?.default_tolerance_external||'');renderThreadDetails();};
$('threadToleranceInput').oninput=()=>renderThreadDetails();
$('applyAllDetectedThreadsBtn').onclick=()=>{let added=0;for(let i=0;i<(state.drawingIntel.threads||[]).length;i++){const x=state.drawingIntel.threads[i];if(x.enabled===false)continue;selectDetectedThread(i);const t=selectedThread();if(t.designation&&!state.projectThreads.some(p=>p.id===t.id&&p.side===t.side)){state.projectThreads.push(t);added++;}}renderProjectThreads();scheduleAutosave();toast(`Добавлено распознанных резьб: ${added}`);};
document.querySelectorAll('[data-collapse-target]').forEach(button=>button.onclick=()=>{const target=$(button.dataset.collapseTarget);if(!target)return;target.classList.toggle('collapsed');button.textContent=target.classList.contains('collapsed')?'⌄':'⌃';});

function clampChamferView(){
  const v=state.chamferView;v.zoom=Math.max(v.minZoom,Math.min(v.maxZoom,v.zoom));
  const w=chamferCanvas?.width||900,h=chamferCanvas?.height||360;
  const maxX=(w*(v.zoom-1))/2+80,maxY=(h*(v.zoom-1))/2+80;
  v.panX=Math.max(-maxX,Math.min(maxX,v.panX));v.panY=Math.max(-maxY,Math.min(maxY,v.panY));
}
function chamferViewPoint(x,y){const v=state.chamferView,w=chamferCanvas.width,h=chamferCanvas.height;return{x:(x-w/2)*v.zoom+w/2+v.panX,y:(y-h/2)*v.zoom+h/2+v.panY};}
function chamferInversePoint(x,y){const v=state.chamferView,w=chamferCanvas.width,h=chamferCanvas.height;return{x:(x-w/2-v.panX)/v.zoom+w/2,y:(y-h/2-v.panY)/v.zoom+h/2};}
function setChamferZoom(nextZoom,focusX=chamferCanvas.width/2,focusY=chamferCanvas.height/2){
  const before=chamferInversePoint(focusX,focusY),v=state.chamferView;v.zoom=nextZoom;clampChamferView();
  const after=chamferViewPoint(before.x,before.y);v.panX+=focusX-after.x;v.panY+=focusY-after.y;clampChamferView();renderChamferEditor();
}
function resetChamferView(){state.chamferView.zoom=1;state.chamferView.panX=0;state.chamferView.panY=0;renderChamferEditor();}
function updateChamferZoomUi(){
  const label=$('chamferZoomLabel'),slider=$('chamferZoomRange');if(label)label.textContent=`${Math.round(state.chamferView.zoom*100)}%`;if($('chamferFsZoomLabel'))$('chamferFsZoomLabel').textContent=`${Math.round(state.chamferView.zoom*100)}%`;if(slider)slider.value=String(Math.min(8,state.chamferView.zoom));
}
function drawChamferBase(){
  if(!chamferCanvas)return;const w=chamferCanvas.width,h=chamferCanvas.height;clampChamferView();chamferCtx.clearRect(0,0,w,h);chamferCtx.fillStyle='rgba(5,18,31,.72)';chamferCtx.fillRect(0,0,w,h);state.chamferTransform={type:'canvas'};
  chamferCtx.save();chamferCtx.translate(w/2+state.chamferView.panX,h/2+state.chamferView.panY);chamferCtx.scale(state.chamferView.zoom,state.chamferView.zoom);chamferCtx.translate(-w/2,-h/2);
  if(state.image){const scale=Math.min((w-28)/state.image.naturalWidth,(h-28)/state.image.naturalHeight),dw=state.image.naturalWidth*scale,dh=state.image.naturalHeight*scale,dx=(w-dw)/2,dy=(h-dh)/2;chamferCtx.drawImage(state.image,dx,dy,dw,dh);const toPx=p=>chamferViewPoint(p.x,p.y);state.chamferTransform={type:'image',dx,dy,dw,dh,toPx};}
  else if(state.contourPoints.length){const zs=state.contourPoints.map(p=>p.z),xs=state.contourPoints.map(p=>p.x),minZ=Math.min(...zs),maxZ=Math.max(...zs),minX=Math.min(...xs),maxX=Math.max(...xs),scale=Math.min((w-80)/Math.max(1,maxZ-minZ),(h-70)/Math.max(1,maxX-minX)),baseToPx=p=>({x:40+(p.z-minZ)*scale,y:h-35-(p.x-minX)*scale}),toPx=p=>chamferViewPoint(baseToPx(p).x,baseToPx(p).y);chamferCtx.strokeStyle='#71c7ff';chamferCtx.lineWidth=4/state.chamferView.zoom;chamferCtx.beginPath();state.contourPoints.forEach((p,i)=>{const q=baseToPx(p);i?chamferCtx.lineTo(q.x,q.y):chamferCtx.moveTo(q.x,q.y);});chamferCtx.stroke();state.chamferTransform={type:'contour',toPx,baseToPx};}
  else{chamferCtx.fillStyle='rgba(224,236,250,.72)';chamferCtx.font='bold 18px Inter';chamferCtx.textAlign='center';chamferCtx.fillText('Загрузи чертёж или создай контур',w/2,h/2);chamferCtx.textAlign='start';}
  chamferCtx.restore();updateChamferZoomUi();
}
function renderChamferEditor(){
  if(!chamferCanvas)return;
  drawChamferBase();
  const active=state.chamfers.filter(x=>x.enabled!==false).length;
  $('chamferRuleCountLabel').textContent=`Правила: ${active}/${state.chamfers.length}`;
  $('chamfersEnabledToggle').checked=state.chamfersEnabled;
  $('selectAllChamfersCheckbox').checked=!!state.chamfers.length&&active===state.chamfers.length;
  $('selectAllChamfersCheckbox').indeterminate=active>0&&active<state.chamfers.length;
  $('chamferMarkerList').classList.toggle('is-master-disabled',!state.chamfersEnabled);
  state.chamfers.forEach((m,i)=>{
    const baseX=m.x*chamferCanvas.width,baseY=m.y*chamferCanvas.height,{x,y}=chamferViewPoint(baseX,baseY);
    chamferCtx.save();
    chamferCtx.globalAlpha=(state.chamfersEnabled&&m.enabled!==false)?1:.35;
    chamferCtx.fillStyle=m.mode==='none'?'#ff6b6b':m.mode==='edge_break'?'#ffd166':'#63e6be';
    chamferCtx.beginPath();chamferCtx.arc(x,y,8,0,Math.PI*2);chamferCtx.fill();chamferCtx.strokeStyle='#fff';chamferCtx.lineWidth=2;chamferCtx.stroke();
    chamferCtx.fillStyle='#fff';chamferCtx.font='bold 13px Inter';chamferCtx.fillText(`${i+1}. ${m.mode==='edge_break'?'снять остроту':m.mode==='none'?'нет':m.notation}`,x+12,y-10);chamferCtx.restore();
  });
  $('chamferMarkerList').innerHTML=state.chamfers.length?state.chamfers.map((m,i)=>`<div class="chamfer-marker ${m.enabled===false?'is-disabled':''}"><label class="rule-check"><input type="checkbox" data-toggle-chamfer="${i}" ${m.enabled===false?'':'checked'}><span></span></label><span><i>${i+1}</i>${m.mode==='edge_break'?'Снять остроту':m.mode==='none'?'Без обработки':escapeHtml(m.notation)}${m.contourIndex!==null&&m.contourIndex!==undefined?` · точка X/Z №${m.contourIndex+1}`:''}</span><button data-remove-chamfer="${i}">×</button></div>`).join(''):'<div class="muted-text">Точки фасок не поставлены.</div>';
  document.querySelectorAll('[data-remove-chamfer]').forEach(b=>b.onclick=()=>{state.chamfers.splice(Number(b.dataset.removeChamfer),1);renderDrawingIntelligence();scheduleAutosave();});
  document.querySelectorAll('[data-toggle-chamfer]').forEach(input=>input.onchange=()=>{state.chamfers[Number(input.dataset.toggleChamfer)].enabled=input.checked;renderDrawingIntelligence();scheduleAutosave();});
  if(state.chamferFullscreen?.open)updateChamferFullscreenUi();
}
function chamferEventPoint(e){const r=chamferCanvas.getBoundingClientRect();return{x:(e.clientX-r.left)*chamferCanvas.width/r.width,y:(e.clientY-r.top)*chamferCanvas.height/r.height};}
function addChamferAtScreenPoint(px,py){const base=chamferInversePoint(px,py),x=base.x/chamferCanvas.width,y=base.y/chamferCanvas.height,mode=$('chamferModeSelect').value,notation=chamferNotationFromInputs();let contourIndex=null;if(state.chamferTransform?.type==='contour'&&state.contourPoints.length){let best=Infinity;state.contourPoints.forEach((p,i)=>{const q=state.chamferTransform.toPx(p),d=Math.hypot(q.x-px,q.y-py);if(d<best){best=d;contourIndex=i;}});if(best>Math.max(28,55/state.chamferView.zoom))contourIndex=null;}state.chamfers.push({x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y)),mode,notation,contourIndex,enabled:true});if(contourIndex!==null&&contourIndex>0&&mode==='chamfer'){pushUndo();state.contourPoints[contourIndex].type='chamfer';state.contourPoints[contourIndex].rv=notation;state.contourPoints[contourIndex].direction='угол';}setChamferInputsFromNotation(notation);renderChamferEditor();renderEditor();scheduleAutosave();}
chamferCanvas.addEventListener('pointerdown',e=>{chamferCanvas.setPointerCapture?.(e.pointerId);const p=chamferEventPoint(e),g=state.chamferGesture;g.pointers.set(e.pointerId,p);g.moved=false;if(g.pointers.size===1){g.dragging=state.chamferFullscreen.mode==='pan'||!state.chamferFullscreen.open;g.startX=p.x;g.startY=p.y;g.originPanX=state.chamferView.panX;g.originPanY=state.chamferView.panY;}else if(g.pointers.size===2){const pts=[...g.pointers.values()];g.pinchDistance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);g.pinchZoom=state.chamferView.zoom;}e.preventDefault();});
chamferCanvas.addEventListener('pointermove',e=>{const g=state.chamferGesture;if(!g.pointers.has(e.pointerId))return;const p=chamferEventPoint(e);g.pointers.set(e.pointerId,p);if(g.pointers.size===2){const pts=[...g.pointers.values()],dist=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y),cx=(pts[0].x+pts[1].x)/2,cy=(pts[0].y+pts[1].y)/2;if(g.pinchDistance>0)setChamferZoom(g.pinchZoom*dist/g.pinchDistance,cx,cy);g.moved=true;}else if(g.dragging&&g.pointers.size===1){const dx=p.x-g.startX,dy=p.y-g.startY;if(Math.hypot(dx,dy)>5)g.moved=true;if(g.moved){state.chamferView.panX=g.originPanX+dx;state.chamferView.panY=g.originPanY+dy;clampChamferView();renderChamferEditor();}}e.preventDefault();});
function finishChamferPointer(e){const g=state.chamferGesture,p=chamferEventPoint(e),wasSingle=g.pointers.size===1&&!g.moved;g.pointers.delete(e.pointerId);if(!g.pointers.size){g.dragging=false;if(wasSingle&&(!state.chamferFullscreen.open||state.chamferFullscreen.mode!=='pan'))addChamferAtScreenPoint(p.x,p.y);}else if(g.pointers.size===1){const only=[...g.pointers.values()][0];g.startX=only.x;g.startY=only.y;g.originPanX=state.chamferView.panX;g.originPanY=state.chamferView.panY;}e.preventDefault();}
chamferCanvas.addEventListener('pointerup',finishChamferPointer);chamferCanvas.addEventListener('pointercancel',e=>{state.chamferGesture.pointers.delete(e.pointerId);state.chamferGesture.dragging=false;});
chamferCanvas.addEventListener('wheel',e=>{const p=chamferEventPoint(e),factor=e.deltaY<0?1.18:1/1.18;setChamferZoom(state.chamferView.zoom*factor,p.x,p.y);e.preventDefault();},{passive:false});
$('undoChamferBtn').onclick=()=>{state.chamfers.pop();renderDrawingIntelligence();scheduleAutosave();};
$('clearChamfersBtn').onclick=()=>{state.chamfers=[];renderDrawingIntelligence();scheduleAutosave();};
$('addChamferFromControlsBtn').onclick=()=>{const mode=$('chamferModeSelect').value,notation=chamferNotationFromInputs();state.chamfers.push({x:.5,y:.5,mode,notation,contourIndex:null,enabled:true});renderDrawingIntelligence();scheduleAutosave();toast(mode==='chamfer'?`Фаска ${notation} добавлена`:'Правило кромки добавлено');};
$('chamfersEnabledToggle').onchange=e=>{state.chamfersEnabled=e.target.checked;renderDrawingIntelligence();scheduleAutosave();};
$('selectAllChamfersCheckbox').onchange=e=>{state.chamfers.forEach(x=>x.enabled=e.target.checked);renderDrawingIntelligence();scheduleAutosave();};
$('chamferSizeInput').onchange=()=>chamferNotationFromInputs();
$('chamferAngleInput').onchange=()=>chamferNotationFromInputs();
$('chamferModeSelect').onchange=syncChamferNotationControls;
$('chamferZoomInBtn').onclick=()=>setChamferZoom(state.chamferView.zoom*1.35);
$('chamferZoomOutBtn').onclick=()=>setChamferZoom(state.chamferView.zoom/1.35);
$('chamferZoomResetBtn').onclick=resetChamferView;
$('chamferZoomRange').oninput=e=>setChamferZoom(Number(e.target.value));

function updateChamferFullscreenUi(){
  const fs=state.chamferFullscreen;
  document.querySelectorAll('[data-chamfer-mode]').forEach(b=>b.classList.toggle('active',b.dataset.chamferMode===fs.mode));
  const count=$('chamferFsCount');if(count)count.textContent=`Точек: ${state.chamfers.length}`;
  updateChamferZoomUi();
}
function openChamferFullscreen(){
  const modal=$('chamferFullscreenModal'),slot=$('chamferFullscreenCanvasSlot'),home=$('chamferCanvasHome');if(!modal||!slot||!home)return;
  state.chamferFullscreen.snapshot={chamfers:clone(state.chamfers),view:clone(state.chamferView)};
  state.chamferFullscreen.home=home;state.chamferFullscreen.open=true;state.chamferFullscreen.mode='point';
  slot.appendChild(chamferCanvas);modal.classList.remove('hidden');document.body.classList.add('modal-open');
  requestAnimationFrame(()=>{resizeChamferFullscreenCanvas();renderChamferEditor();updateChamferFullscreenUi();});
}
function resizeChamferFullscreenCanvas(){
  if(!state.chamferFullscreen.open)return;const slot=$('chamferFullscreenCanvasSlot');if(!slot)return;
  const r=slot.getBoundingClientRect(),ratio=Math.min(2,window.devicePixelRatio||1);chamferCanvas.width=Math.max(900,Math.round(r.width*ratio));chamferCanvas.height=Math.max(620,Math.round(r.height*ratio));renderChamferEditor();
}
function closeChamferFullscreen(save){
  const fs=state.chamferFullscreen;if(!fs.open)return;
  if(!save&&fs.snapshot){state.chamfers=clone(fs.snapshot.chamfers);state.chamferView=clone(fs.snapshot.view);}
  fs.home.appendChild(chamferCanvas);chamferCanvas.width=900;chamferCanvas.height=540;fs.open=false;fs.snapshot=null;
  $('chamferFullscreenModal').classList.add('hidden');document.body.classList.remove('modal-open');renderDrawingIntelligence();scheduleAutosave();
}
$('openChamferFullscreenBtn').onclick=openChamferFullscreen;
$('cancelChamferFullscreenTop').onclick=()=>closeChamferFullscreen(false);
$('cancelChamferFullscreenBtn').onclick=()=>closeChamferFullscreen(false);
$('doneChamferFullscreenBtn').onclick=()=>{closeChamferFullscreen(true);toast(`Сохранено точек: ${state.chamfers.length}`);};
$('undoChamferFullscreenBtn').onclick=()=>{state.chamfers.pop();renderDrawingIntelligence();updateChamferFullscreenUi();};
$('clearChamferFullscreenBtn').onclick=()=>{state.chamfers=[];renderDrawingIntelligence();updateChamferFullscreenUi();};
$('chamferFsZoomIn').onclick=()=>setChamferZoom(state.chamferView.zoom*1.35);
$('chamferFsZoomOut').onclick=()=>setChamferZoom(state.chamferView.zoom/1.35);
$('chamferFsFit').onclick=resetChamferView;
$('chamferFullscreenHelp').onclick=()=>toast('Точка/Кромка: короткое касание. Рука: перетаскивание. Два пальца: масштаб.');
document.querySelectorAll('[data-chamfer-mode]').forEach(b=>b.onclick=()=>{state.chamferFullscreen.mode=b.dataset.chamferMode;updateChamferFullscreenUi();});
chamferCanvas.addEventListener('pointermove',e=>{if(!state.chamferFullscreen.open)return;const p=chamferEventPoint(e),base=chamferInversePoint(p.x,p.y);$('chamferFsCoordinates').textContent=`X: ${base.x.toFixed(0)} · Y: ${base.y.toFixed(0)}`;},{passive:true});
window.addEventListener('resize',()=>{if(state.chamferFullscreen.open)resizeChamferFullscreenCanvas();});

setChamferInputsFromNotation('1×45°');
syncChamferNotationControls();

function collectShopTurnPayload(){return{...collectShopTurnData(),operations:state.operationRoute,threadSelection:selectedThread(),drawingRules:{enabled:state.ruleControl.enabled,active:activeToleranceContext()},chamfers:state.chamfersEnabled?state.chamfers.filter(x=>x.enabled!==false):[]};}
function makeOperationSnapshot(){const d=collectShopTurnData(),op=SHOP_OPERATIONS[d.operation]||{label:'Операция не выбрана'};return{...d,id:`op-${Date.now()}-${Math.random().toString(16).slice(2)}`,label:op.label,enabled:true,thread:['thread_ext','thread_int'].includes(d.operation)?selectedThread():{}};}
function renderOperationRoute(){
  if(!$('operationRouteList'))return;const enabled=state.operationRoute.filter(o=>o.enabled!==false),tools=new Set(enabled.map(o=>`${o.toolT}/${o.toolD}`));$('routeSummary').textContent=`Операций: ${state.operationRoute.length} · Активных: ${enabled.length} · Инструментов: ${tools.size}`;
  $('operationRouteList').innerHTML=state.operationRoute.length?state.operationRoute.map((o,i)=>`<article class="route-operation ${o.enabled===false?'disabled':''} ${i===state.activeRouteIndex?'active':''}"><div class="route-order">${i+1}</div><div class="route-main"><strong>${escapeHtml(o.label||o.operation||'Операция')}</strong><span>T${escapeHtml(o.toolT||'?')} D${escapeHtml(o.toolD||'?')} · ${escapeHtml(o.toolName||'инструмент не указан')}</span><small>S ${escapeHtml(o.speed||'—')} · F ${escapeHtml(o.feed||'—')} · D ${escapeHtml(o.depth||'—')}${o.thread?.designation?` · ${escapeHtml(threadDisplay(o.thread))}`:''}</small></div><div class="route-actions"><button data-route-action="up" data-route-index="${i}">↑</button><button data-route-action="down" data-route-index="${i}">↓</button><button data-route-action="open" data-route-index="${i}">Открыть</button><button data-route-action="duplicate" data-route-index="${i}">Копия</button><button data-route-action="toggle" data-route-index="${i}">${o.enabled===false?'Вкл':'Выкл'}</button><button data-route-action="delete" data-route-index="${i}" class="danger-lite">×</button></div></article>`).join(''):'<div class="route-empty">Добавь торцовку, точение, расточку, резьбу, канавку и отрезку в нужном порядке.</div>';
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
function applyMachineProfile(profile, showToast=true){
  if(profile!=='tengyue_ck52pty') return;
  const wanted=['Используется ось X','Используется ось Z','Используется ось C','Используется ось Y','Используется приводной инструмент'];
  document.querySelectorAll('[data-side-value]').forEach(input=>{if(wanted.includes(input.dataset.sideValue))input.checked=true;});
  $('toolDrivenToggle').checked=true;
  syncStockOptionValues();
  if(showToast) toast('Профиль CK52PT-Y: оси X/Z/C/Y, револьвер T1–T15 и приводной инструмент применены');
}

function initShopTurn(){populateToolPresets('face');applyToolPreset('face',true);autoFillCycleFromContour(false);SHOP_INPUT_IDS.forEach(id=>$(id)?.addEventListener('input',()=>{renderShopTurn();scheduleAutosave();}));$('machineProfileSelect').addEventListener('change',()=>{applyMachineProfile($('machineProfileSelect').value,true);renderShopTurn();scheduleAutosave();});$('shopOperationSelect').addEventListener('change',()=>{applyOperationDefaults(true);renderShopTurn();scheduleAutosave();});$('toolPresetSelect').addEventListener('change',()=>applyToolPreset($('toolPresetSelect').value,true));$('applyToolPresetBtn').onclick=()=>applyToolPreset($('toolPresetSelect').value,true);$('autoFillShopturnBtn').onclick=()=>autoFillCycleFromContour(true);$('saveCustomToolBtn').onclick=()=>{const d=collectShopTurnData();if(!d.toolName)return toast('Введи название инструмента');const custom=customToolPresets();custom.push({...d,label:`T${d.toolT} · ${d.toolName}`,operation:d.operation});localStorage.setItem('personal-ai-custom-tools',JSON.stringify(custom));populateToolPresets(`custom:${custom.length-1}`);toast('Инструмент сохранён в локальную библиотеку');};$('wizardPrevBtn').onclick=()=>{state.shopturn.wizardStep=Math.max(0,state.shopturn.wizardStep-1);renderShopTurnWizard();};$('wizardNextBtn').onclick=()=>{const max=buildShopTurnSteps().length-1;if(state.shopturn.wizardStep<max)state.shopturn.wizardStep++;else toast('Мастер ввода завершён. Выполни Graphic view и симуляцию.');renderShopTurnWizard();scheduleAutosave();};$('consoleAcceptBtn').onclick=()=>$('wizardNextBtn').click();document.querySelectorAll('[data-console-step]').forEach(btn=>btn.onclick=()=>{state.shopturn.wizardStep=Math.max(0,Math.min(Number(btn.dataset.consoleStep)||0,buildShopTurnSteps().length-1));document.querySelectorAll('[data-console-step]').forEach(x=>x.classList.toggle('active',x===btn));renderShopTurnWizard();scheduleAutosave();toast(`Открыт шаг: ${buildShopTurnSteps()[state.shopturn.wizardStep].title}`);});$('wizardCopyBtn').onclick=async()=>{const s=buildShopTurnSteps()[state.shopturn.wizardStep];const txt=`${s.title}\n${s.path.join(' → ')}\n${s.values.map(([k,v])=>`${k}: ${v}`).join('\n')}\n${s.instruction.replace(/<[^>]*>/g,'')}`;try{await navigator.clipboard.writeText(txt);toast('Данные шага скопированы');}catch{toast('Не удалось скопировать');}};renderShopTurn();}

async function fetchHistoryDetail(id){const r=await fetch(`/api/history/${id}`);const d=await r.json();if(!r.ok)throw new Error(d.detail||'Не удалось открыть запись');return d;}
function showHistoryResult(item){const isStock=String(item.prompt||'').startsWith('Stock Removal |');if(isStock){setView('stock');$('stockResultEmpty').classList.add('hidden');$('stockResultContent').classList.remove('hidden');$('stockResultContent').innerHTML=renderText(item.response||'');$('stockResultMeta').textContent=`${item.model}${item.mock?' · MOCK':''} · #${item.id}`;startChat('stock',{id:item.id,response:item.response,response_id:item.openai_response_id,model:item.model,mock:item.mock,loadHistory:true});}else{setView('analysis');$('promptInput').value=item.prompt||'';$('resultEmpty').classList.add('hidden');$('resultContent').classList.remove('hidden');$('resultContent').innerHTML=renderText(item.response||'');renderTabletAnalysisSummary(item.response||'',item.drawing_intelligence||{});$('resultMeta').textContent=`${item.model}${item.mock?' · MOCK':''} · #${item.id}`;startChat('analysis',{id:item.id,response:item.response,response_id:item.openai_response_id,model:item.model,mock:item.mock,loadHistory:true});}}
async function openHistoryEntry(id){try{const item=await fetchHistoryDetail(id);showHistoryResult(item);}catch(e){toast(e.message);}}
async function loadHistoryProject(id){try{const item=await fetchHistoryDetail(id);resetWorkspaceForNewProject();if(item.project)applyProjectData(item.project);state.restoredFileName=item.filename||item.project?.fileName||null;state.currentProjectName=`Из истории · ${item.filename||`запись ${id}`}`;updateProjectUi();showHistoryResult(item);syncFileUi();scheduleAutosave();toast(item.has_project?'Проект восстановлен из истории':'Результат восстановлен. Исходный файл выбери заново.');}catch(e){toast(e.message);}}
async function loadHistory(){const list=$('historyList');list.innerHTML='<div class="result-empty"><span>Загрузка...</span></div>';try{const r=await fetch('/api/history'),items=await r.json();if(!r.ok)throw new Error('Не удалось загрузить историю');if(!items.length){list.innerHTML='<div class="result-empty"><strong>История пуста</strong></div>';return;}list.innerHTML=items.map(i=>`<article class="history-item"><div class="history-copy"><div class="history-title-row"><h3 title="${escapeHtml(i.filename)}">${escapeHtml(i.filename)}</h3>${i.mock?'<span class="history-tag">MOCK</span>':''}${i.has_project?'<span class="history-tag project-tag">ПРОЕКТ</span>':''}</div><p title="${escapeHtml(i.prompt)}">${escapeHtml(i.prompt)}</p><small>${new Date(i.created_at*1000).toLocaleString('ru-RU')} · ${escapeHtml(i.model||'')}</small></div><div class="history-actions"><button data-open-history="${i.id}" class="small-button">Открыть</button><button data-load-history="${i.id}" class="secondary-button">Загрузить проект</button><button data-del="${i.id}" class="danger-lite" aria-label="Удалить запись">×</button></div></article>`).join('');list.querySelectorAll('[data-open-history]').forEach(b=>b.onclick=()=>openHistoryEntry(Number(b.dataset.openHistory)));list.querySelectorAll('[data-load-history]').forEach(b=>b.onclick=()=>loadHistoryProject(Number(b.dataset.loadHistory)));list.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('Удалить запись из истории?'))return;await fetch(`/api/history/${b.dataset.del}`,{method:'DELETE'});loadHistory();});}catch(e){list.innerHTML=`<div class="result-empty"><strong>${escapeHtml(e.message)}</strong></div>`;}}
$('refreshHistoryBtn').onclick=loadHistory;

$('newAnalysisBtn').onclick=()=>{state.file=null;state.restoredFileName=null;state.image=null;state.crop=null;fileInput.value='';dropZone.classList.remove('hidden');previewArea.classList.add('hidden');pdfPreview.src='';$('promptInput').value='';$('resultContent').classList.add('hidden');$('resultEmpty').classList.remove('hidden');$('stockResultContent').classList.add('hidden');$('stockResultEmpty').classList.remove('hidden');resetChat('analysis',true);resetChat('stock',true);renderChamferEditor();syncFileUi();localStorage.setItem('personal-ai-pro-draft',JSON.stringify(collectProjectData()));$('autosaveState').textContent='Файл очищен · черновик обновлён';toast('Текущий файл и его имя удалены из черновика.');};

document.addEventListener('keydown',e=>{const tag=document.activeElement?.tagName;if(['INPUT','TEXTAREA','SELECT'].includes(tag))return;const mod=e.ctrlKey||e.metaKey;if(mod&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}else if(e.key==='Delete'){e.preventDefault();$('deletePointBtn').click();}else if(e.key.toLowerCase()==='a'){e.preventDefault();openPointModal('add');}else if(e.key.toLowerCase()==='s'){e.preventDefault();saveProject(false);}else if(e.key==='ArrowLeft'){state.selectedIndex=Math.max(0,state.selectedIndex-1);renderEditor();}else if(e.key==='ArrowRight'){state.selectedIndex=Math.min(state.contourPoints.length-1,state.selectedIndex+1);renderEditor();}});
window.addEventListener('resize',()=>{updateDeviceModeLabel();if(state.image){resizeImageCanvas();drawImageCanvas();}renderEditor();renderChamferEditor();});



function initFloatingSidebar(){
  const btn=document.getElementById('sidebarCollapseBtn');
  if(!btn)return;
  const key='personal-ai-sidebar-collapsed';
  const apply=(collapsed)=>{
    document.body.classList.toggle('sidebar-collapsed',collapsed);
    btn.setAttribute('aria-expanded',String(!collapsed));
    btn.title=collapsed?'Развернуть боковую панель':'Свернуть боковую панель';
  };
  let collapsed=false;
  try{collapsed=localStorage.getItem(key)==='1';}catch{}
  apply(collapsed);
  btn.addEventListener('click',()=>{
    collapsed=!document.body.classList.contains('sidebar-collapsed');
    apply(collapsed);
    try{localStorage.setItem(key,collapsed?'1':'0');}catch{}
  });
}

initFloatingSidebar();
initThemeControls();updateDeviceModeLabel();initShopTurn();initOperationMultiPicker();loadHealth();loadThreadCatalog();
// Каждый новый запуск начинается с чистой рабочей сессии. Сохранённые проекты и история не удаляются.
localStorage.removeItem('personal-ai-pro-draft');
resetWorkspaceForNewProject({autosave:false});

// v2.6.0 — data bridge for the physical 3D Stock Removal engine.
window.CNC3D_getData = function CNC3D_getData() {
  const selectedOperations = [...document.querySelectorAll('[data-side-value]:checked')]
    .map(el => el.dataset.sideValue)
    .filter(value => /торц|точен|резьб|фаск|канав|отрез|фрез|сверл|разв|зенков/i.test(value || ''))
    .map((name, index) => ({ id: `selected-${index}`, name, enabled: true }));
  const routeOperations = (Array.isArray(state.operationRoute) ? state.operationRoute : []).map((item, index) => ({
    id: item.id || `route-${index}`,
    name: item.name || item.operationName || item.operation || item.type || item.kind || `Операция ${index + 1}`,
    enabled: item.enabled !== false,
    tool: item.tool || item.toolName || '',
    feed: item.feed || item.f || null,
    speed: item.speed || item.rpm || item.vc || null,
  }));
  return {
    blankDiameter: document.getElementById('blankDiameter')?.value,
    blankLength: document.getElementById('blankLength')?.value,
    blankWidth: document.getElementById('blankWidth')?.value,
    blankHeight: document.getElementById('blankHeight')?.value,
    contourPoints: Array.isArray(state.contourPoints) ? state.contourPoints.map(p => ({...p})) : [],
    xMode: state.xMode,
    process: state.process,
    stockMode: state.stockMode,
    operations: routeOperations.length ? routeOperations : selectedOperations,
    notes: document.getElementById('stockNotes')?.value || '',
    material: /aisi\s*304|нержав/i.test(document.getElementById('stockNotes')?.value || '') ? 'AISI 304' : 'Материал детали',
  };
};


// v2.7.3 Tablet Edition — iPad Pro 10.5 detection fix
(() => {
  const steps=['analysis','ai','verify','tolerances','contour','tools','plan','simulation','export'];
  const labels=['Загрузка','AI-анализ','Проверка','Допуски','Контур','Инструмент','План','Симуляция','Экспорт'];
  let current=0;
  const isTablet=()=>{const widthMatch=window.matchMedia('(min-width: 768px) and (max-width: 1180px)').matches;const ipadLike=(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)||/iPad/.test(navigator.userAgent);return widthMatch||ipadLike;};
  function applyTablet(){document.body.classList.toggle('tablet-edition',isTablet()); sync();}
  function q(id){return document.getElementById(id)}
  function activate(i,scroll=true){current=Math.max(0,Math.min(steps.length-1,i));window.__tabletWorkflowCurrent=current;document.querySelectorAll('.tablet-step').forEach((b,n)=>{b.classList.toggle('active',n===current);b.classList.toggle('done',n<current)}); if(q('tabletStepCounter'))q('tabletStepCounter').textContent=`Шаг ${current+1} из ${steps.length}`; if(q('tabletCurrentStage'))q('tabletCurrentStage').textContent=labels[current]; const pct=Math.round(current/(steps.length-1)*100); if(q('tabletProgressText'))q('tabletProgressText').textContent=pct+'%'; if(q('tabletProgressBar'))q('tabletProgressBar').style.width=pct+'%'; if(q('tabletBackBtn'))q('tabletBackBtn').disabled=current===0; if(q('tabletNextBtn'))q('tabletNextBtn').textContent=current===steps.length-1?'Готово':'Далее →'; if(scroll)navigate(steps[current]);}
  function navigate(step){
    const map={analysis:['analysis', 'dropZone'],ai:['analysis','analyzeBtn'],verify:['analysis','resultContent'],tolerances:['analysis','drawingIntelligencePanel'],contour:['stock','contourPanel'],tools:['stock','toolFlowPanel'],plan:['stock','stockBtn'],simulation:['stock','simulation3dPanel'],export:['stock','gcodePanel']};
    const [view,id]=map[step]||[]; const nav=document.querySelector(`.nav-item[data-view="${view}"]`); if(nav)nav.click(); setTimeout(()=>{const el=q(id);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});},120);
  }
  function sync(){if(!isTablet())return; if(q('tabletProjectName'))q('tabletProjectName').textContent=q('activeProjectName')?.textContent||'Локальный черновик'; if(q('tabletFileState'))q('tabletFileState').textContent=q('currentFilePill')?.textContent||'Не выбран';}
  window.__tabletWorkflowActivate=(i,scroll=true)=>activate(i,scroll); window.addEventListener('resize',applyTablet); document.addEventListener('DOMContentLoaded',()=>{applyTablet();document.querySelectorAll('.tablet-step').forEach((b,i)=>b.addEventListener('click',()=>activate(i)));q('tabletBackBtn')?.addEventListener('click',()=>activate(current-1));q('tabletNextBtn')?.addEventListener('click',()=>activate(current+1));q('tabletSaveBtn')?.addEventListener('click',()=>q('saveProjectBtn')?.click());q('tabletGoVerifyBtn')?.addEventListener('click',()=>activate(2));q('tabletInspectorToggle')?.addEventListener('click',()=>document.body.classList.toggle('tablet-inspector-collapsed'));new MutationObserver(sync).observe(document.body,{subtree:true,childList:true,characterData:true});activate(0,false);});
})();
