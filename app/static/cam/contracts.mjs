export const CAM_STATUS = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  PARTIAL: 'PARTIAL',
  BLOCKED: 'BLOCKED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERFACE_ONLY: 'INTERFACE_ONLY',
  NOT_EVALUATED: 'NOT_EVALUATED',
  SUPPORTED_INDEXED: 'SUPPORTED_INDEXED',
  EVALUATED_LIMITED: 'EVALUATED_LIMITED',
  GENERATED: 'GENERATED',
});

export const CAM_SCHEMA_VERSION = '2.0.0';

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
  if (/фрез|mill|af\b|лыск|шестиг|карман|паз|индексац.*c/.test(value)) return 'milling';
  if (/сверл|drill|расточ.*отверст|метчик|tap/.test(value)) return 'drilling';
  if (/резьб|thread|нарезан/.test(value)) return 'threading';
  if (/торцев|facing/.test(value)) return 'facing';
  if (/чернов.*точ|rough.*turn|наружн.*чернов/.test(value)) return 'rough_turning';
  if (/чистов.*точ|finish.*turn|наружн.*чистов|фаск|chamfer/.test(value)) return 'finish_turning';
  if (/точен|turn|подготов.*(?:диаметр|ø|под)/.test(value)) return 'turning';
  return 'unknown';
}

export function capabilityMatrix(encountered = {}, results = {}) {
  const drillingStatus = results.drilling?.status || (encountered.drilling ? CAM_STATUS.BLOCKED : CAM_STATUS.NOT_IMPLEMENTED);
  const threadingStatus = results.threading?.status || (encountered.threading ? CAM_STATUS.BLOCKED : CAM_STATUS.NOT_IMPLEMENTED);
  const millingStatus = results.millingAf?.status || (encountered.milling ? CAM_STATUS.BLOCKED : CAM_STATUS.NOT_IMPLEMENTED);
  return {
    turningXZ: {
      status: CAM_STATUS.SUPPORTED,
      scope: 'Наружное осесимметричное точение по X/Z; X в диаметрах',
    },
    materialRemoval: {
      status: CAM_STATUS.SUPPORTED,
      scope: 'Детерминированная 3D-модель: X/Z, осевое отверстие, резьба и индексируемые AF-грани',
    },
    drilling: { status: drillingStatus, scope: 'Осевой стружкодробящий цикл; радиальное сверление заблокировано' },
    threading: { status: threadingStatus, scope: 'Наружная метрическая 60°, синхронные X/Z-проходы G33' },
    milling: {
      status: millingStatus,
      encountered: Boolean(encountered.milling),
      scope: 'Только AF-грани с блокирующей индексацией C и подачами X/Z; непрерывная C/Y не заявляется',
    },
    axes: {
      X: CAM_STATUS.SUPPORTED,
      Z: CAM_STATUS.SUPPORTED,
      C: millingStatus === CAM_STATUS.SUPPORTED ? CAM_STATUS.SUPPORTED_INDEXED : CAM_STATUS.NOT_IMPLEMENTED,
      Y: CAM_STATUS.NOT_IMPLEMENTED,
    },
    collision: {
      status: results.collision?.status || CAM_STATUS.BLOCKED,
      scope: 'Проверка по подтверждённым оболочкам заготовки, патрона, инструмента, державки, ходов и запретных зон',
    },
    postprocessor: { status: results.postprocessor?.status || CAM_STATUS.BLOCKED, scope: 'Детерминированный MPF SINUMERIK 828D после коллизионного шлюза' },
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
    schemaVersion: CAM_SCHEMA_VERSION,
    projectId: raw.projectId ?? null,
    blankDiameter,
    blankLength,
    radialAllowance,
    axialAllowance,
    maxDepth,
    finishAllowance,
    contour: normalizeContour(raw.contourPoints),
    route,
    geometry: raw.geometry && typeof raw.geometry === 'object' ? raw.geometry : {},
    afContour: Array.isArray(raw.afContour) ? raw.afContour : [],
    material: String(raw.material || 'Не указан'),
    coordinateSystem: raw.coordinateSystem || { xMode: 'diameter', zZero: 'right_face' },
  };
}

export function routeCapabilityReport(route = [], support = {}) {
  return route.map(operation => {
    const kind = classifyRouteOperation(operation.name);
    if (['facing', 'rough_turning', 'finish_turning', 'turning'].includes(kind)) {
      return { ...operation, kind, status: CAM_STATUS.SUPPORTED };
    }
    const supported = (kind === 'threading' && support.threading)
      || (kind === 'drilling' && support.drilling)
      || (kind === 'milling' && support.millingAf && /af(?:\b|\s*\d)|гран|шестиг|лыск/i.test(operation.name));
    if (supported) return { ...operation, kind, status: CAM_STATUS.SUPPORTED };
    return {
      ...operation,
      kind,
      status: CAM_STATUS.NOT_IMPLEMENTED,
      reason: kind === 'milling'
        ? 'Поддерживается только рассчитанное AF-фрезерование с индексацией C'
        : kind === 'threading'
          ? 'Не задана или не прошла валидацию модель резьбы'
          : kind === 'drilling'
            ? 'Не задана или не прошла валидацию модель осевого сверления'
            : kind === 'inspection'
              ? 'Измерительный цикл и модель щупа не реализованы'
            : 'Тип операции не распознан как поддерживаемое наружное точение',
    };
  });
}
