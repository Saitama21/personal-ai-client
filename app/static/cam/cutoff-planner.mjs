import { CAM_STATUS, issue } from './contracts.mjs';
import { diameterAtZ } from './feature-contracts.mjs';
import { appendMove, scheduleMoves } from './motion-utils.mjs';

const EPS = 1e-6;

export function planCutoff(input, feature = {}) {
  if (!feature.enabled) {
    return {
      status: CAM_STATUS.NOT_IMPLEMENTED,
      errors: [], warnings: [], operations: [], moves: [],
      feature,
      message: 'Отрезка не включена оператором.',
    };
  }

  const errors = [];
  const warnings = [];
  const zPosition = Number(feature.zPosition);
  const bladeWidth = Number(feature.bladeWidth);
  const finalDiameter = Number(feature.finalDiameter);
  const rpm = Number(feature.rpm);
  const feedPerRev = Number(feature.feedPerRev);
  const radialClearance = Math.max(0.5, Number(feature.radialClearance) || 2);
  const axialClearance = Math.max(0.5, Number(feature.axialClearance) || 2);

  if (!feature.safetyConfirmed) {
    errors.push(issue('CUTOFF_SAFETY_UNCONFIRMED', 'Подтвердите свободную зону отрезки: кулачки, задняя бабка, ловитель детали и державка не должны пересекать траекторию.', 'error', 'cam'));
  }
  if (!Number.isFinite(zPosition)) errors.push(issue('CUTOFF_Z_REQUIRED', 'Для отрезки требуется координата Z.', 'error', 'cam'));
  if (Number.isFinite(zPosition) && (zPosition > EPS || zPosition < -input.blankLength - EPS)) {
    errors.push(issue('CUTOFF_Z_OUTSIDE_PART', `Z${zPosition} выходит за диапазон детали Z0…Z-${input.blankLength}.`, 'error', 'cam'));
  }
  if (!(bladeWidth > 0)) errors.push(issue('CUTOFF_BLADE_WIDTH_REQUIRED', 'Укажите ширину отрезной пластины.', 'error', 'tools'));
  if (!(finalDiameter >= 0)) errors.push(issue('CUTOFF_FINAL_DIAMETER_REQUIRED', 'Укажите конечный X в диаметрах: 0 для полной отрезки или положительный диаметр перемычки.', 'error', 'cam'));
  if (!(rpm > 0)) errors.push(issue('CUTOFF_RPM_REQUIRED', 'Для отрезки требуется подтверждённое число оборотов S.', 'error', 'tools'));
  if (!(feedPerRev > 0)) errors.push(issue('CUTOFF_FEED_REQUIRED', 'Для отрезки требуется подтверждённая подача f, мм/об.', 'error', 'tools'));

  const sourceDiameter = Number.isFinite(zPosition)
    ? (Number(feature.sourceDiameter) > 0 ? Number(feature.sourceDiameter) : diameterAtZ(input.contour, zPosition))
    : null;
  if (!(sourceDiameter > 0)) errors.push(issue('CUTOFF_SOURCE_DIAMETER_UNKNOWN', 'Не удалось определить наружный диаметр в позиции отрезки.', 'error', 'contour'));
  if (sourceDiameter > 0 && finalDiameter >= sourceDiameter - EPS) {
    errors.push(issue('CUTOFF_FINAL_DIAMETER_INVALID', `Конечный X${finalDiameter} должен быть меньше исходного Ø${sourceDiameter}.`, 'error', 'cam'));
  }
  if (Number.isFinite(zPosition) && bladeWidth > 0 && zPosition + bladeWidth / 2 > EPS) {
    warnings.push(issue('CUTOFF_BLADE_OVER_FRONT_FACE', 'Часть ширины пластины выходит за правый торец Z0. Проверьте фактическую установку Z.', 'warning', 'cam'));
  }
  if (Number.isFinite(zPosition) && bladeWidth > 0 && zPosition - bladeWidth / 2 < -input.blankLength - EPS) {
    warnings.push(issue('CUTOFF_BLADE_OVER_BACK_FACE', 'Часть ширины пластины выходит за левый торец детали. Это допустимо только при отрезке от прутка/припуска и должно быть подтверждено оператором.', 'warning', 'cam'));
  }
  if (errors.length) {
    return { status: CAM_STATUS.BLOCKED, errors, warnings, operations: [], moves: [], feature, sourceDiameter };
  }

  const moves = [];
  const operations = [];
  const operationId = 'cutoff-1';
  const clearDiameter = sourceDiameter + radialClearance * 2;
  const home = { x: clearDiameter, z: Math.min(0, zPosition + axialClearance) };
  const aligned = { x: clearDiameter, z: zPosition };
  const target = { x: finalDiameter, z: zPosition };
  const feedRate = Math.max(1, rpm * feedPerRev);

  appendMove(moves, operationId, 'rapid', 'cutoff_safe_approach', home, aligned, { toolKind: 'cutoff' });
  appendMove(moves, operationId, 'feed', 'cutoff_radial_feed', aligned, target, {
    cutting: true,
    cutKind: 'cutoff',
    toolKind: 'cutoff',
    feedRate,
    bladeWidth,
    zPosition,
    sourceDiameter,
    targetDiameter: finalDiameter,
  });
  appendMove(moves, operationId, 'rapid', 'cutoff_radial_retract', target, aligned, { toolKind: 'cutoff' });
  appendMove(moves, operationId, 'rapid', 'cutoff_axial_retract', aligned, home, { toolKind: 'cutoff' });

  operations.push({
    id: operationId,
    kind: 'cutoff',
    name: finalDiameter <= EPS ? `Отрезка в Z${zPosition}` : `Прорезка в Z${zPosition} до X${finalDiameter}`,
    status: CAM_STATUS.SUPPORTED,
    moveStart: 0,
    moveEnd: moves.length - 1,
    safeApproach: true,
    safeRetract: true,
    zPosition,
    bladeWidth,
    sourceDiameter,
    finalDiameter,
  });

  const estimatedMinutes = scheduleMoves(moves);
  return {
    status: CAM_STATUS.SUPPORTED,
    errors,
    warnings,
    operations,
    moves,
    feature: { ...feature, zPosition, bladeWidth, finalDiameter, rpm, feedPerRev, radialClearance, axialClearance, sourceDiameter },
    parameters: { sourceDiameter, clearDiameter, feedRate, estimatedMinutes },
    estimatedMinutes,
  };
}
