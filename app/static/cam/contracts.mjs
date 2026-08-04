export const CAM_STATUS = Object.freeze({
  SUPPORTED: 'SUPPORTED', PARTIAL: 'PARTIAL', BLOCKED: 'BLOCKED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED', INTERFACE_ONLY: 'INTERFACE_ONLY',
  NOT_EVALUATED: 'NOT_EVALUATED', SUPPORTED_INDEXED: 'SUPPORTED_INDEXED',
  EVALUATED_LIMITED: 'EVALUATED_LIMITED', GENERATED: 'GENERATED',
});

export const CAM_SCHEMA_VERSION = '3.0.0';

export function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function issue(code, message, severity = 'error', stage = 'simulation') {
  return { code, message, severity, stage };
}

export function classifyRouteOperation(name = '') {
  const value = String(name).toLowerCase();
  if (/контрол|измер|inspection/.test(value)) return 'inspection';
  if (/радиал.*сверл|попереч.*сверл|radial.*drill/.test(value)) return 'radial_drilling';
  if (/карман|паз|slot|pocket/.test(value)) return 'milling_pocket';
  if (/фрез|mill|af\b|лыск|шестиг|индексац.*c/.test(value)) return 'milling';
  if (/сверл|drill|расточ.*отверст|метчик|tap/.test(value)) return 'drilling';
  if (/резьб|thread|нарезан/.test(value)) return 'threading';
  if (/отрез|cut\s*off|cutoff|parting|прорез/.test(value)) return 'cutoff';
  if (/торцев|facing/.test(value)) return 'facing';
  if (/чернов.*точ|rough.*turn|наружн.*чернов/.test(value)) return 'rough_turning';
  if (/чистов.*точ|finish.*turn|наружн.*чистов|фаск|chamfer/.test(value)) return 'finish_turning';
  if (/точен|turn|подготов.*(?:диаметр|ø|под)/.test(value)) return 'turning';
  return 'unknown';
}

export function capabilityMatrix(encountered = {}, results = {}) {
  const axial = results.drilling?.status || (encountered.drilling ? CAM_STATUS.BLOCKED : CAM_STATUS.NOT_IMPLEMENTED);
  const radial = results.radialDrilling?.status || (encountered.radialDrilling ? CAM_STATUS.BLOCKED : CAM_STATUS.NOT_IMPLEMENTED);
  const threading = results.threading?.status || (encountered.threading ? CAM_STATUS.BLOCKED : CAM_STATUS.NOT_IMPLEMENTED);
  const af = results.millingAf?.status || (encountered.milling ? CAM_STATUS.BLOCKED : CAM_STATUS.NOT_IMPLEMENTED);
  const pocket = results.millingPocket?.status || (encountered.millingPocket ? CAM_STATUS.BLOCKED : CAM_STATUS.NOT_IMPLEMENTED);
  const cutoff = results.cutoff?.status || (encountered.cutoff ? CAM_STATUS.BLOCKED : CAM_STATUS.NOT_IMPLEMENTED);
  const cSupported = [radial, af, pocket].some(status => status === CAM_STATUS.SUPPORTED);
  const ySupported = [af, pocket].some(status => status === CAM_STATUS.SUPPORTED);
  return {
    turningXZ: { status: CAM_STATUS.SUPPORTED, scope: 'Осесимметричное точение X/Z, X в диаметрах.' },
    materialRemoval: { status: CAM_STATUS.SUPPORTED, scope: 'Прогрессивное 3D-удаление материала: точение, резьба, осевые/радиальные отверстия, AF, карманы, пазы и отрезка.' },
    drilling: { status: axial, scope: 'Осевое сверление с клевками и реалистичной моделью сверла.' },
    radialDrilling: { status: radial, scope: 'Радиальные отверстия с приводным инструментом и индексированием C.' },
    threading: { status: threading, scope: 'Наружная метрическая резьба 60°, синхронные проходы G33.' },
    cutoff: { status: cutoff, scope: 'Радиальная отрезка/прорезка в заданной Z.' },
    millingAf: { status: af, scope: 'AF/лыски/многоугольник с индексируемой C и растровыми проходами по Y.' },
    millingPocket: { status: pocket, scope: 'Радиальные и торцевые карманы/пазы с X/Y/Z и индексируемой C.' },
    milling: { status: (af === CAM_STATUS.SUPPORTED || pocket === CAM_STATUS.SUPPORTED) ? CAM_STATUS.SUPPORTED : CAM_STATUS.NOT_IMPLEMENTED, encountered: Boolean(encountered.milling || encountered.millingPocket), scope: 'Полноценная симуляция приводного фрезерования X/Y/Z с позиционированием C.' },
    axes: { X: CAM_STATUS.SUPPORTED, Z: CAM_STATUS.SUPPORTED, Y: ySupported ? CAM_STATUS.SUPPORTED : CAM_STATUS.NOT_EVALUATED, C: cSupported ? CAM_STATUS.SUPPORTED_INDEXED : CAM_STATUS.NOT_EVALUATED },
    turret: { status: CAM_STATUS.SUPPORTED, scope: '15-позиционный револьвер, визуальная индексация T1–T15 и смена геометрии инструмента.' },
    collision: { status: results.collision?.status || CAM_STATUS.BLOCKED, scope: 'Проверка по заданным оболочкам станка, патрона, инструмента и пределам осей.' },
    postprocessor: { status: results.postprocessor?.status || CAM_STATUS.BLOCKED, scope: 'MPF SINUMERIK 828D после подтверждения OEM M-кодов и безопасных координат.' },
  };
}

export function normalizeContour(points = []) {
  const normalized = [];
  for (let index = 0; index < points.length; index += 1) {
    const item = points[index];
    const x = finiteNumber(Array.isArray(item) ? item[0] : item?.x);
    const z = finiteNumber(Array.isArray(item) ? item[1] : item?.z);
    if (x === null || z === null) continue;
    normalized.push({ x, z, sourceIndex: index });
  }
  return normalized.sort((a, b) => (b.z - a.z) || (a.sourceIndex - b.sourceIndex));
}

export function normalizeCamInput(raw = {}) {
  const blankDiameter = finiteNumber(raw.blankDiameter);
  const blankLength = finiteNumber(raw.blankLength);
  const radialAllowance = Math.max(0, finiteNumber(raw.radialAllowance, 0));
  const axialAllowance = Math.max(0, finiteNumber(raw.axialAllowance, 0));
  const maxDepth = finiteNumber(raw.maxDepth, null);
  const finishAllowance = finiteNumber(raw.finishAllowance, 0.2);
  const route = Array.isArray(raw.operations) ? raw.operations.map((operation, index) => ({
    id: operation?.id || `route-${index + 1}`,
    name: String(operation?.name || operation?.operation || operation || `Операция ${index + 1}`),
    tool: operation?.tool || null,
    speed: finiteNumber(operation?.speed ?? operation?.rpm),
    feed: finiteNumber(operation?.feed),
    ap: finiteNumber(operation?.ap ?? operation?.depth),
  })) : [];
  return {
    schemaVersion: CAM_SCHEMA_VERSION, projectId: raw.projectId ?? null,
    blankDiameter, blankLength, radialAllowance, axialAllowance, maxDepth, finishAllowance,
    contour: normalizeContour(raw.contourPoints), route,
    geometry: raw.geometry && typeof raw.geometry === 'object' ? raw.geometry : {},
    afContour: Array.isArray(raw.afContour) ? raw.afContour : [],
    material: String(raw.material || 'Не указан'),
    coordinateSystem: raw.coordinateSystem || { xMode: 'diameter', zZero: 'right_face' },
  };
}

export function routeCapabilityReport(route = [], support = {}) {
  return route.map(operation => {
    const kind = classifyRouteOperation(operation.name);
    if (['facing', 'rough_turning', 'finish_turning', 'turning'].includes(kind)) return { ...operation, kind, status: CAM_STATUS.SUPPORTED };
    const supported = (kind === 'threading' && support.threading)
      || (kind === 'drilling' && support.drilling)
      || (kind === 'radial_drilling' && support.radialDrilling)
      || (kind === 'cutoff' && support.cutoff)
      || (kind === 'milling_pocket' && support.millingPocket)
      || (kind === 'milling' && support.millingAf);
    if (supported) return { ...operation, kind, status: CAM_STATUS.SUPPORTED };
    const reason = kind === 'inspection' ? 'Измерительный цикл и модель щупа пока не реализованы.'
      : kind === 'threading' ? 'Не задана или не прошла валидацию резьба.'
      : kind === 'drilling' ? 'Не задано или не прошло валидацию осевое сверление.'
      : kind === 'radial_drilling' ? 'Не заданы параметры радиальных отверстий.'
      : kind === 'milling_pocket' ? 'Не заданы параметры кармана/паза.'
      : kind === 'milling' ? 'Не заданы параметры AF/многоугольника.'
      : kind === 'cutoff' ? 'Не заданы параметры отрезки.'
      : 'Тип операции не распознан.';
    return { ...operation, kind, status: CAM_STATUS.NOT_IMPLEMENTED, reason };
  });
}
