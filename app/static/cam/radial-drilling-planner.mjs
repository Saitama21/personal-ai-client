import { CAM_STATUS, issue } from './contracts.mjs';
import { appendMove, scheduleMoves } from './motion-utils.mjs';
import { diameterAtZ } from './feature-contracts.mjs';

const EPS = 1e-6;

export function validateRadialDrilling(input, feature) {
  const errors = [];
  const warnings = [];
  if (!feature.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors, warnings, enabled: false };
  if (!(feature.diameter > 0)) errors.push(issue('RADIAL_DRILL_DIAMETER_REQUIRED', 'Диаметр радиального сверления должен быть больше нуля.', 'error', 'features'));
  if (!(feature.depth > 0)) errors.push(issue('RADIAL_DRILL_DEPTH_REQUIRED', 'Глубина радиального сверления должна быть больше нуля.', 'error', 'features'));
  if (!(feature.peckDepth > 0)) errors.push(issue('RADIAL_DRILL_PECK_REQUIRED', 'Шаг стружкодробления радиального сверления должен быть больше нуля.', 'error', 'features'));
  if (!(feature.feedRate > 0) || !(feature.rpm > 0)) errors.push(issue('RADIAL_DRILL_CUTTING_DATA_REQUIRED', 'Для радиального сверления нужны положительные обороты и минутная подача.', 'error', 'features'));
  if (!Number.isFinite(feature.radialZ) || feature.radialZ > EPS || feature.radialZ < -input.blankLength - EPS) {
    errors.push(issue('RADIAL_DRILL_Z_INVALID', 'Координата Z радиального отверстия должна находиться в пределах детали.', 'error', 'features'));
  }
  if (!Number.isInteger(feature.count) || feature.count < 1 || feature.count > 64) errors.push(issue('RADIAL_DRILL_COUNT_INVALID', 'Количество радиальных отверстий должно быть от 1 до 64.', 'error', 'features'));
  const sourceDiameter = diameterAtZ(input.contour, feature.radialZ);
  if (!(sourceDiameter > 0)) errors.push(issue('RADIAL_DRILL_SOURCE_DIAMETER_REQUIRED', 'Не удалось определить наружный диаметр в координате радиального сверления.', 'error', 'features'));
  if (sourceDiameter > 0 && feature.depth > sourceDiameter + EPS) errors.push(issue('RADIAL_DRILL_DEPTH_OUTSIDE_PART', 'Глубина радиального сверления больше локального диаметра детали.', 'error', 'features'));
  if (sourceDiameter > 0 && feature.diameter >= sourceDiameter - EPS) warnings.push(issue('RADIAL_DRILL_LARGE_DIAMETER', 'Диаметр радиального отверстия близок к локальному диаметру детали — проверьте остаточную стенку.', 'warning', 'features'));
  if (feature.tipAngle < 80 || feature.tipAngle > 160) warnings.push(issue('RADIAL_DRILL_TIP_ANGLE_UNUSUAL', 'Угол при вершине сверла выходит за типичный диапазон 80…160°.', 'warning', 'features'));
  return { status: errors.length ? CAM_STATUS.BLOCKED : CAM_STATUS.SUPPORTED, errors, warnings, enabled: true, sourceDiameter };
}

export function planRadialDrilling(input, feature) {
  const validation = validateRadialDrilling(input, feature);
  if (!validation.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors: [], warnings: [], operations: [], moves: [], feature };
  if (validation.errors.length) return { status: CAM_STATUS.BLOCKED, errors: validation.errors, warnings: validation.warnings, operations: [], moves: [], feature };

  const sourceDiameter = validation.sourceDiameter;
  const safeDiameter = sourceDiameter + 2 * (feature.retract + feature.diameter / 2);
  const angularStep = feature.angularStep > 0 ? feature.angularStep : 360 / feature.count;
  const moves = [];
  const operations = [];
  let current = { x: safeDiameter, z: feature.radialZ, y: 0, c: feature.cAngle };

  for (let holeIndex = 0; holeIndex < feature.count; holeIndex += 1) {
    const cAngle = feature.cAngle + angularStep * holeIndex;
    const operationId = `drill-radial-${holeIndex + 1}`;
    const startMove = moves.length;
    if (holeIndex > 0 || Math.abs((current.c || 0) - cAngle) > EPS) {
      appendMove(moves, operationId, 'index', 'radial_drill_c_index', current, { ...current, c: cAngle }, {
        holeIndex, toolKind: 'radialDrilling', indexedAxis: 'C', spindleStopped: true,
      });
      current = { ...current, c: cAngle };
    }
    const safe = { x: safeDiameter, z: feature.radialZ, y: 0, c: cAngle };
    if (Math.abs(current.x - safe.x) > EPS || Math.abs(current.z - safe.z) > EPS) {
      appendMove(moves, operationId, 'rapid', 'radial_drill_safe_approach', current, safe, { holeIndex, toolKind: 'radialDrilling' });
    }
    let drilled = 0;
    let peck = 0;
    while (drilled < feature.depth - EPS) {
      peck += 1;
      const nextDepth = Math.min(feature.depth, drilled + feature.peckDepth);
      const startDepth = Math.max(0, drilled - (drilled > 0 ? feature.chipClearance : 0));
      const start = { x: sourceDiameter - 2 * startDepth, z: feature.radialZ, y: 0, c: cAngle };
      const end = { x: sourceDiameter - 2 * nextDepth, z: feature.radialZ, y: 0, c: cAngle };
      appendMove(moves, operationId, 'rapid', 'radial_drill_return_to_peck', safe, start, { holeIndex, passIndex: peck, toolKind: 'radialDrilling' });
      appendMove(moves, operationId, 'feed', 'radial_drill_peck_cut', start, end, {
        cutting: true, cutKind: 'drill_radial', feedRate: feature.feedRate, passIndex: peck,
        holeIndex, holeDiameter: feature.diameter, drilledDepth: nextDepth, sourceDiameter,
        toolKind: 'radialDrilling', spindleRpm: feature.rpm, indexedC: cAngle,
      });
      appendMove(moves, operationId, 'rapid', 'radial_drill_chip_retract', end, safe, { holeIndex, passIndex: peck, toolKind: 'radialDrilling' });
      drilled = nextDepth;
    }
    current = safe;
    operations.push({
      id: operationId,
      kind: 'radial_drilling',
      name: `Радиальное сверление ${holeIndex + 1}/${feature.count} Ø${feature.diameter} · C${Number(cAngle.toFixed(3))}°`,
      status: CAM_STATUS.SUPPORTED,
      moveStart: startMove,
      moveEnd: moves.length - 1,
      holeIndex,
      indexedC: cAngle,
      peckCount: peck,
      safeApproach: true,
      safeRetract: true,
      feature,
    });
  }

  return {
    status: CAM_STATUS.SUPPORTED,
    errors: validation.errors,
    warnings: validation.warnings,
    operations,
    moves,
    feature: { ...feature, sourceDiameter, angularStep },
    holes: Array.from({ length: feature.count }, (_, index) => ({
      type: 'radial',
      diameter: feature.diameter,
      depth: feature.depth,
      z: feature.radialZ,
      cAngle: feature.cAngle + angularStep * index,
      holeIndex: index,
    })),
    parameters: { sourceDiameter, safeDiameter, angularStep },
    estimatedMinutes: scheduleMoves(moves),
  };
}
