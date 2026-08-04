import { CAM_STATUS, issue } from './contracts.mjs';
import { createMaterialModel } from './axisymmetric-material.mjs';
import { activeMoveAt, appendMove, interpolateMove, scheduleMoves } from './motion-utils.mjs';

const EPS = 1e-6;

function addMove(target, operationId, motion, role, from, to, options = {}) {
  return appendMove(target, operationId, motion, role, from, to, options);
}

function clampedProfile(contour, minimumRadius, finishAllowance) {
  return contour.map(point => ({
    z: point.z,
    x: 2 * Math.max(minimumRadius, point.x / 2 + finishAllowance),
  }));
}

function targetProfile(contour) {
  return contour.map(point => ({ z: point.z, x: point.x }));
}

export function diameterAtZ(contour = [], z = 0) {
  if (!Array.isArray(contour) || !contour.length) return null;
  const ordered = [...contour].sort((a, b) => b.z - a.z);
  if (z >= ordered[0].z) return ordered[0].x;
  if (z <= ordered.at(-1).z) return ordered.at(-1).x;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const a = ordered[index]; const b = ordered[index + 1];
    if (z <= a.z + EPS && z >= b.z - EPS) {
      const t = (z - a.z) / (b.z - a.z || 1);
      return a.x + (b.x - a.x) * t;
    }
  }
  return null;
}

export function clampZoneForInput(input) {
  const setup = input?.setup || {};
  if (!setup.enabled || !setup.protectClampZone || !(setup.clampLength > 0)) return null;
  if (setup.clampSide === 'left') return { zMin: -setup.clampLength, zMax: 0, boundaryZ: -setup.clampLength };
  return { zMin: -input.blankLength, zMax: -input.blankLength + setup.clampLength, boundaryZ: -input.blankLength + setup.clampLength };
}

export function exposedTurningProfile(contour = [], input = {}) {
  const zone = clampZoneForInput(input);
  if (!zone || !contour.length) return contour.map(point => ({ ...point }));
  const boundaryX = diameterAtZ(contour, zone.boundaryZ);
  if (!(boundaryX > 0)) return contour.map(point => ({ ...point }));
  if (input.setup.clampSide === 'left') {
    const exposed = [{ x: boundaryX, z: zone.boundaryZ }];
    for (const point of contour) if (point.z < zone.boundaryZ - EPS || (Math.abs(point.z - zone.boundaryZ) <= EPS && Math.abs(point.x - boundaryX) > EPS)) exposed.push({ ...point });
    return exposed;
  }
  const exposed = [];
  for (const point of contour) if (point.z > zone.boundaryZ + EPS) exposed.push({ ...point });
  exposed.push({ x: boundaryX, z: zone.boundaryZ });
  return exposed;
}

function appendContourPass(moves, operations, profile, settings) {
  const operationId = settings.operationId;
  const startMove = moves.length;
  const home = { x: settings.clearDiameter, z: settings.zClearance };
  const first = profile[0];
  const axialApproach = { x: settings.clearDiameter, z: first.z };
  const approach = { x: Math.min(settings.clearDiameter, first.x + settings.entryClearanceDiameter), z: first.z };
  addMove(moves, operationId, 'rapid', 'safe_axial_approach_to_clamp_boundary', home, axialApproach, { passIndex: settings.passIndex });
  addMove(moves, operationId, 'rapid', 'safe_radial_approach', axialApproach, approach, { passIndex: settings.passIndex });
  addMove(moves, operationId, 'feed', 'lead_in_at_clamp_boundary', approach, first, {
    cutting: true, cutKind: 'turn', feedRate: settings.feedRate, passIndex: settings.passIndex,
  });
  for (let index = 0; index < profile.length - 1; index += 1) {
    addMove(moves, operationId, 'feed', settings.role, profile[index], profile[index + 1], {
      cutting: true, cutKind: 'turn', feedRate: settings.feedRate, passIndex: settings.passIndex,
    });
  }
  const end = profile[profile.length - 1];
  const radialClear = { x: settings.clearDiameter, z: end.z };
  addMove(moves, operationId, 'rapid', 'safe_radial_retract', end, radialClear, { passIndex: settings.passIndex });
  addMove(moves, operationId, 'rapid', 'safe_axial_retract', radialClear, home, { passIndex: settings.passIndex });
  operations.push({
    id: operationId,
    kind: settings.kind,
    name: settings.name,
    status: CAM_STATUS.SUPPORTED,
    passIndex: settings.passIndex,
    moveStart: startMove,
    moveEnd: moves.length - 1,
    safeApproach: true,
    safeRetract: true,
    targetMinimumDiameter: Math.min(...profile.map(point => point.x)),
  });
}

function appendFacing(moves, operations, settings) {
  const operationId = 'turn-face';
  const startMove = moves.length;
  const home = { x: settings.clearDiameter, z: settings.zClearance };
  const faceStart = { x: settings.clearDiameter, z: 0 };
  const faceEnd = { x: 0, z: 0 };
  addMove(moves, operationId, 'rapid', 'safe_approach', home, faceStart);
  addMove(moves, operationId, 'feed', 'facing_cut', faceStart, faceEnd, {
    cutting: true, cutKind: 'face', feedRate: settings.feedRate,
  });
  addMove(moves, operationId, 'rapid', 'safe_radial_retract', faceEnd, faceStart);
  addMove(moves, operationId, 'rapid', 'safe_axial_retract', faceStart, home);
  operations.push({
    id: operationId,
    kind: 'facing',
    name: 'Торцевание осевого припуска',
    status: CAM_STATUS.SUPPORTED,
    moveStart: startMove,
    moveEnd: moves.length - 1,
    safeApproach: true,
    safeRetract: true,
  });
}

export function validateTurningInput(input) {
  const errors = [];
  const warnings = [];
  if (!(input.blankDiameter > 0)) errors.push(issue('BLANK_DIAMETER_REQUIRED', 'Диаметр заготовки должен быть больше нуля.', 'error', 'stock'));
  if (!(input.blankLength > 0)) errors.push(issue('BLANK_LENGTH_REQUIRED', 'Длина детали должна быть больше нуля.', 'error', 'stock'));
  if (input.coordinateSystem?.xMode && input.coordinateSystem.xMode !== 'diameter') {
    errors.push(issue('X_MODE_UNSUPPORTED', 'На этом этапе поддерживается только X в диаметрах.', 'error', 'contour'));
  }
  if (input.contour.length < 2) errors.push(issue('CONTOUR_REQUIRED', 'Нужно минимум две подтверждённые точки наружного X/Z-контура.', 'error', 'contour'));
  for (const point of input.contour) {
    if (!(point.x > 0)) errors.push(issue('CONTOUR_X_INVALID', `Диаметр X=${point.x} должен быть больше нуля.`, 'error', 'contour'));
    if (input.blankDiameter > 0 && point.x > input.blankDiameter + EPS) {
      errors.push(issue('CONTOUR_OUTSIDE_STOCK', `Точка X${point.x} Z${point.z} выходит за Ø${input.blankDiameter}.`, 'error', 'contour'));
    }
    if (point.z > EPS || (input.blankLength > 0 && point.z < -input.blankLength - EPS)) {
      errors.push(issue('CONTOUR_Z_OUTSIDE_STOCK', `Точка X${point.x} Z${point.z} выходит за диапазон Z0…Z-${input.blankLength}.`, 'error', 'contour'));
    }
  }
  for (let index = 1; index < input.contour.length; index += 1) {
    if (input.contour[index].z > input.contour[index - 1].z + EPS) {
      errors.push(issue('CONTOUR_ORDER_INVALID', 'Точки X/Z должны идти от Z0 к отрицательному Z.', 'error', 'contour'));
      break;
    }
  }
  if (input.contour.length && Math.abs(input.contour[0].z) > EPS) warnings.push(issue('CONTOUR_START_NOT_Z0', 'Контур не начинается на Z0; безопасный подвод будет построен к первой точке.', 'warning', 'contour'));
  if (input.contour.length && input.blankLength > 0 && Math.abs(input.contour.at(-1).z + input.blankLength) > 0.05) {
    warnings.push(issue('CONTOUR_LENGTH_MISMATCH', 'Последняя точка контура не совпадает с длиной заготовки.', 'warning', 'contour'));
  }
  const setup = input.setup || {};
  if (setup.enabled) {
    if (!(setup.clampDiameter > 0)) errors.push(issue('CLAMP_DIAMETER_REQUIRED', 'Укажите диаметр участка, зажатого в патроне.', 'error', 'stock'));
    if (setup.clampDiameter > input.blankDiameter + EPS) errors.push(issue('CLAMP_DIAMETER_OUTSIDE_STOCK', `Диаметр зажима Ø${setup.clampDiameter} больше заготовки Ø${input.blankDiameter}.`, 'error', 'stock'));
    if (!(setup.clampLength > 0) || setup.clampLength >= input.blankLength - EPS) errors.push(issue('CLAMP_LENGTH_INVALID', 'Длина зажима должна быть больше 0 и меньше полной длины детали.', 'error', 'stock'));
    const zone = clampZoneForInput(input);
    if (setup.protectClampZone && zone) {
      const boundaryDiameter = diameterAtZ(input.contour, zone.boundaryZ);
      if (!(boundaryDiameter > 0) || Math.abs(boundaryDiameter - setup.clampDiameter) > 0.15) errors.push(issue('CLAMP_PROFILE_MISMATCH', `На границе защищённой зоны требуется Ø${setup.clampDiameter}, но контур даёт Ø${boundaryDiameter ?? '—'}.`, 'error', 'stock'));
      const zonePoints = input.contour.filter(point => point.z <= zone.zMax + EPS && point.z > zone.zMin + EPS);
      if (zonePoints.some(point => Math.abs(point.x - setup.clampDiameter) > 0.15)) errors.push(issue('MACHINING_REQUIRED_INSIDE_CLAMP', 'Целевой наружный контур изменяется внутри зоны зажима. Такой первый установ заблокирован.', 'error', 'stock'));
      warnings.push(issue('CLAMP_ZONE_PROTECTED', `Зона зажима Ø${setup.clampDiameter} × ${setup.clampLength} мм защищена; точение начинается на Z${zone.boundaryZ}.`, 'warning', 'stock'));
      if (!setup.confirmed) warnings.push(issue('CLAMP_LENGTH_OPERATOR_CONFIRMATION', 'Длина зажима получена из геометрии детали и должна быть подтверждена оператором по фактическим кулачкам.', 'warning', 'stock'));
    }
  }
  return { errors, warnings };
}

export function planTurning(input) {
  const validation = validateTurningInput(input);
  if (validation.errors.length) {
    return { status: CAM_STATUS.BLOCKED, errors: validation.errors, warnings: validation.warnings, operations: [], moves: [], materialModel: null };
  }
  const moves = [];
  const operations = [];
  const stockRadius = input.blankDiameter / 2;
  const machiningProfile = exposedTurningProfile(input.contour, input);
  if (machiningProfile.length < 2) {
    return { status: CAM_STATUS.BLOCKED, errors: [issue('EXPOSED_PROFILE_REQUIRED', 'После исключения зоны зажима не осталось обрабатываемого наружного профиля.', 'error', 'stock')], warnings: validation.warnings, operations: [], moves: [], materialModel: null };
  }
  const minimumTarget = Math.min(...machiningProfile.map(point => point.x / 2));
  let ap = input.maxDepth;
  if (!(ap > 0)) {
    ap = 1.5;
    validation.warnings.push(issue('DEFAULT_AP_USED', 'Глубина резания не задана; для расчёта применено ap=1,5 мм по радиусу.', 'warning', 'tools'));
  }
  ap = Math.min(ap, Math.max(0.05, stockRadius - minimumTarget || ap));
  const finishAllowance = Math.max(0.02, Math.min(Number(input.finishAllowance) || 0.2, ap));
  const zClearance = Math.max(2, input.axialAllowance + 1.5);
  const radialClearance = Math.max(2, input.radialAllowance + 1);
  const clearDiameter = input.blankDiameter + radialClearance * 2;
  const entryClearanceDiameter = 1.2;
  const rpm = input.route.find(item => item.speed > 0)?.speed || 800;
  const feedPerRev = input.route.find(item => item.feed > 0)?.feed || 0.15;
  const feedRate = Math.max(20, rpm * feedPerRev);

  if (input.axialAllowance > EPS && !clampZoneForInput(input)) appendFacing(moves, operations, { clearDiameter, zClearance, feedRate });
  else if (input.axialAllowance > EPS && clampZoneForInput(input)) validation.warnings.push(issue('FACING_SKIPPED_IN_CLAMP', 'Торцевание Z0 пропущено: торец находится внутри защищённой зоны зажима.', 'warning', 'stock'));

  const roughLimit = minimumTarget + finishAllowance;
  const roughPassCount = Math.max(0, Math.ceil((stockRadius - roughLimit) / ap));
  if (roughPassCount > 200) {
    return {
      status: CAM_STATUS.BLOCKED,
      errors: [issue('PASS_COUNT_LIMIT', `Расчёт требует ${roughPassCount} черновых проходов. Проверьте Ø заготовки и ap.`, 'error', 'tools')],
      warnings: validation.warnings,
      operations: [], moves: [], materialModel: null,
    };
  }
  for (let pass = 1; pass <= roughPassCount; pass += 1) {
    const level = Math.max(roughLimit, stockRadius - ap * pass);
    appendContourPass(moves, operations, clampedProfile(machiningProfile, level, finishAllowance), {
      operationId: `turn-rough-${pass}`,
      kind: 'rough_turning',
      name: `Черновой проход ${pass}/${roughPassCount}`,
      role: 'rough_cut',
      passIndex: pass,
      clearDiameter,
      zClearance,
      entryClearanceDiameter,
      feedRate,
    });
  }
  appendContourPass(moves, operations, targetProfile(machiningProfile), {
    operationId: 'turn-finish-1',
    kind: 'finish_turning',
    name: 'Чистовой проход по утверждённому X/Z-контуру',
    role: 'finish_cut',
    passIndex: roughPassCount + 1,
    clearDiameter,
    zClearance,
    entryClearanceDiameter,
    feedRate: Math.max(20, feedRate * 0.65),
  });
  const estimatedMinutes = scheduleMoves(moves);
  return {
    status: CAM_STATUS.SUPPORTED,
    errors: validation.errors,
    warnings: validation.warnings,
    operations,
    moves,
    materialModel: createMaterialModel(input),
    parameters: {
      xMode: 'diameter', apRadial: ap, finishAllowanceRadial: finishAllowance,
      zClearance, radialClearance, clearDiameter, roughPassCount, feedRate, rpm, feedPerRev, clampZone: clampZoneForInput(input), processingOrder: input.setup?.processingOrder || 'canonical',
    },
    estimatedMinutes,
  };
}

export function toolPointAt(plan, progress) {
  if (!plan?.moves?.length) return null;
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  const move = activeMoveAt(plan.moves, p);
  const point = interpolateMove(move, p);
  return {
    ...point,
    move,
    operation: plan.operations.find(item => item.id === move.operationId) || null,
  };
}
