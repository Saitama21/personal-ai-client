import { CAM_STATUS, issue } from './contracts.mjs';
import { appendMove, scheduleMoves } from './motion-utils.mjs';
import { diameterAtZ } from './feature-contracts.mjs';

const EPS = 1e-6;

export function validateDrilling(input, feature) {
  const errors = [];
  const warnings = [];
  if (!feature.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors, warnings, enabled: false };
  if (feature.orientation !== 'axial') {
    errors.push(issue('RADIAL_DRILLING_NOT_IMPLEMENTED', 'Радиальное сверление требует подтверждённой приводной кинематики и на этом этапе заблокировано.', 'error', 'features'));
  }
  if (!(feature.diameter > 0)) errors.push(issue('DRILL_DIAMETER_REQUIRED', 'Диаметр сверления должен быть больше нуля.', 'error', 'features'));
  if (!(feature.depth > 0)) errors.push(issue('DRILL_DEPTH_REQUIRED', 'Глубина сверления должна быть больше нуля.', 'error', 'features'));
  if (!(feature.peckDepth > 0)) errors.push(issue('DRILL_PECK_REQUIRED', 'Шаг стружкодробления должен быть больше нуля.', 'error', 'features'));
  if (!(feature.feedRate > 0) || !(feature.rpm > 0)) errors.push(issue('DRILL_CUTTING_DATA_REQUIRED', 'Для сверления нужны положительные обороты и минутная подача.', 'error', 'features'));
  const fromFreeEnd = Boolean(input.setup?.enabled && input.setup.clampSide === 'left' && input.setup.visualMirror);
  const entryZ = fromFreeEnd ? -input.blankLength : feature.startZ;
  const direction = fromFreeEnd ? 1 : -1;
  if (entryZ > EPS || entryZ < -input.blankLength - EPS) errors.push(issue('DRILL_START_Z_INVALID', 'Начало осевого отверстия должно находиться в диапазоне детали.', 'error', 'features'));
  if (feature.depth > input.blankLength + EPS) errors.push(issue('DRILL_DEPTH_OUTSIDE_PART', 'Глубина осевого отверстия выходит за противоположный торец детали.', 'error', 'features'));
  const localDiameter = diameterAtZ(input.contour, entryZ + direction * Math.min(feature.depth, 0.5));
  if (fromFreeEnd) warnings.push(issue('DRILL_FROM_FREE_END', 'Для левого зажима сверление визуализируется со свободного правого торца к патрону.', 'warning', 'features'));
  if (localDiameter > 0 && feature.diameter >= localDiameter - EPS) errors.push(issue('DRILL_DIAMETER_OUTSIDE_PART', `Ø${feature.diameter} не оставляет наружную стенку при Ø${localDiameter}.`, 'error', 'features'));
  if (feature.tipAngle < 80 || feature.tipAngle > 160) warnings.push(issue('DRILL_TIP_ANGLE_UNUSUAL', 'Угол при вершине сверла выходит за типичный диапазон 80…160°.', 'warning', 'features'));
  return { status: errors.length ? CAM_STATUS.BLOCKED : CAM_STATUS.SUPPORTED, errors, warnings, enabled: true };
}

export function planDrilling(input, feature) {
  const validation = validateDrilling(input, feature);
  if (!validation.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors: [], warnings: [], operations: [], moves: [], feature };
  if (validation.errors.length) return { status: CAM_STATUS.BLOCKED, errors: validation.errors, warnings: validation.warnings, operations: [], moves: [], feature };
  const moves = [];
  const operations = [];
  const operationId = 'drill-axial-1';
  const startMove = 0;
  const clearDiameter = input.blankDiameter + 4;
  const fromFreeEnd = Boolean(input.setup?.enabled && input.setup.clampSide === 'left' && input.setup.visualMirror);
  const entryZ = fromFreeEnd ? -input.blankLength : feature.startZ;
  const direction = fromFreeEnd ? 1 : -1;
  const safeZ = entryZ - direction * feature.retractZ;
  const safe = { x: clearDiameter, z: safeZ };
  const axisSafe = { x: 0, z: safeZ };
  appendMove(moves, operationId, 'rapid', 'drill_safe_radial_position', safe, axisSafe, { toolKind: 'drilling' });
  let drilled = 0;
  let peck = 0;
  while (drilled < feature.depth - EPS) {
    peck += 1;
    const nextDepth = Math.min(feature.depth, drilled + feature.peckDepth);
    const startZ = entryZ + direction * drilled - (drilled > 0 ? direction * feature.chipClearance : 0);
    const endZ = entryZ + direction * nextDepth;
    if (drilled > 0) appendMove(moves, operationId, 'rapid', 'drill_return_to_peck', axisSafe, { x: 0, z: startZ }, { passIndex: peck, toolKind: 'drilling' });
    appendMove(moves, operationId, 'feed', 'drill_peck_cut', { x: 0, z: startZ }, { x: 0, z: endZ }, {
      cutting: true, cutKind: 'drill_axial', feedRate: feature.feedRate, passIndex: peck,
      holeDiameter: feature.diameter, drilledDepth: nextDepth, toolKind: 'drilling', spindleRpm: feature.rpm,
    });
    appendMove(moves, operationId, 'rapid', 'drill_chip_retract', { x: 0, z: endZ }, axisSafe, { passIndex: peck, toolKind: 'drilling' });
    drilled = nextDepth;
  }
  appendMove(moves, operationId, 'rapid', 'drill_safe_retract', axisSafe, safe, { toolKind: 'drilling' });
  operations.push({
    id: operationId, kind: 'drilling', name: `Осевое сверление Ø${feature.diameter} на ${feature.depth} мм`,
    status: CAM_STATUS.SUPPORTED, moveStart: startMove, moveEnd: moves.length - 1,
    safeApproach: true, safeRetract: true, peckCount: peck, feature,
  });
  return {
    status: CAM_STATUS.SUPPORTED, errors: validation.errors, warnings: validation.warnings,
    operations, moves, feature, hole: { type: feature.depth >= input.blankLength - EPS ? 'through_axial' : 'blind_axial', diameter: feature.diameter, depth: feature.depth, startZ: entryZ, direction, entrySide: fromFreeEnd ? 'free_right' : 'z0', tipAngle: feature.tipAngle },
    estimatedMinutes: scheduleMoves(moves),
  };
}
