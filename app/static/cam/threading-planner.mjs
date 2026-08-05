import { CAM_STATUS, issue } from './contracts.mjs';
import { appendMove, scheduleMoves } from './motion-utils.mjs';
import { diameterAtZ } from './feature-contracts.mjs';

const EPS = 1e-6;

export function validateThreading(input, feature) {
  const errors = [];
  const warnings = [];
  if (!feature.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors, warnings, enabled: false };
  if (feature.standard !== 'ISO_METRIC_EXTERNAL_60') errors.push(issue('THREAD_STANDARD_UNSUPPORTED', 'Поддерживается только наружная метрическая резьба ISO 60°.', 'error', 'features'));
  if (!(feature.nominalDiameter > 0) || !(feature.majorDiameter > 0)) errors.push(issue('THREAD_DIAMETER_REQUIRED', 'Нужен положительный номинальный/наружный диаметр резьбы.', 'error', 'features'));
  if (!(feature.pitch > 0)) errors.push(issue('THREAD_PITCH_REQUIRED', 'Шаг резьбы должен быть больше нуля.', 'error', 'features'));
  if (!(feature.length > 0) || !(feature.zStart > feature.zEnd)) errors.push(issue('THREAD_LENGTH_INVALID', 'Для резьбы нужны корректные Z начала, Z конца и положительная длина.', 'error', 'features'));
  if (Number.isFinite(feature.zStart) && Number.isFinite(feature.zEnd) && Math.abs((feature.zStart - feature.zEnd) - feature.length) > 0.05) {
    errors.push(issue('THREAD_LENGTH_MISMATCH', 'Длина резьбы не совпадает с разностью Z начала и конца.', 'error', 'features'));
  }
  if (feature.zStart > EPS || feature.zEnd < -input.blankLength - EPS) errors.push(issue('THREAD_Z_OUTSIDE_PART', 'Резьбовой участок выходит за длину детали.', 'error', 'features'));
  if (!(feature.minorDiameter > 0) || feature.minorDiameter >= feature.majorDiameter) errors.push(issue('THREAD_MINOR_DIAMETER_INVALID', 'Внутренний диаметр наружной резьбы должен быть положительным и меньше наружного.', 'error', 'features'));
  if (!(feature.maxInfeedRadial > 0)) errors.push(issue('THREAD_INFEED_REQUIRED', 'Максимальная радиальная подача на проход должна быть больше нуля.', 'error', 'features'));
  if (!(feature.rpm > 0)) errors.push(issue('THREAD_RPM_REQUIRED', 'Для синхронизации резьбы нужны положительные обороты.', 'error', 'features'));
  if (feature.pitch > 0 && feature.nominalDiameter > 0 && feature.pitch > feature.nominalDiameter / 3) warnings.push(issue('THREAD_PITCH_UNUSUAL', 'Шаг велик относительно номинального диаметра; требуется проверка технологом.', 'warning', 'features'));
  if (Number.isFinite(feature.zStart) && Number.isFinite(feature.zEnd)) {
    const samples = [feature.zStart, (feature.zStart + feature.zEnd) / 2, feature.zEnd];
    for (const z of samples) {
      const diameter = diameterAtZ(input.contour, z);
      if (diameter > 0 && Math.abs(diameter - feature.majorDiameter) > 0.15) {
        errors.push(issue('THREAD_MAJOR_CONTOUR_MISMATCH', `На Z${z} контур Ø${diameter}, а резьба требует Ø${feature.majorDiameter}.`, 'error', 'features'));
        break;
      }
    }
  }
  return { status: errors.length ? CAM_STATUS.BLOCKED : CAM_STATUS.SUPPORTED, errors, warnings, enabled: true };
}

export function planThreading(input, feature) {
  const validation = validateThreading(input, feature);
  if (!validation.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors: [], warnings: [], operations: [], moves: [], feature };
  if (validation.errors.length) return { status: CAM_STATUS.BLOCKED, errors: validation.errors, warnings: validation.warnings, operations: [], moves: [], feature };
  const moves = [];
  const operations = [];
  const radialDepth = (feature.majorDiameter - feature.minorDiameter) / 2;
  const cuttingPasses = Math.max(1, Math.ceil(radialDepth / feature.maxInfeedRadial));
  const totalPasses = cuttingPasses + feature.springPasses;
  const threadStart = feature.zStart + feature.runIn;
  const threadEnd = feature.zEnd - feature.runOut;
  const clearDiameter = Math.max(input.blankDiameter + 4, feature.majorDiameter + 4);
  const home = { x: clearDiameter, z: threadStart };
  const revolutions = (threadStart - threadEnd) / feature.pitch;
  for (let pass = 1; pass <= totalPasses; pass += 1) {
    const cuttingIndex = Math.min(pass, cuttingPasses);
    const reachedDepth = Math.min(radialDepth, cuttingIndex * feature.maxInfeedRadial);
    const passDiameter = feature.majorDiameter - reachedDepth * 2;
    const operationId = `thread-pass-${pass}`;
    const startMove = moves.length;
    const approach = { x: feature.majorDiameter + 0.8, z: threadStart };
    appendMove(moves, operationId, 'rapid', 'thread_safe_approach', home, approach, { passIndex: pass, toolKind: 'threading' });
    appendMove(moves, operationId, 'feed', 'thread_radial_infeed', approach, { x: passDiameter, z: threadStart }, {
      feedRate: Math.max(20, feature.rpm * 0.05), passIndex: pass, toolKind: 'threading', targetThreadDepth: reachedDepth,
    });
    appendMove(moves, operationId, 'thread', 'thread_synchronized_cut', { x: passDiameter, z: threadStart }, { x: passDiameter, z: threadEnd }, {
      cutting: true, cutKind: 'thread_external', feedRate: feature.rpm * feature.pitch, passIndex: pass,
      pitch: feature.pitch, spindleRpm: feature.rpm, spindleRevolutions: revolutions,
      synchronized: true, threadZStart: feature.zStart, threadZEnd: feature.zEnd,
      targetThreadDepth: reachedDepth, springPass: pass > cuttingPasses, toolKind: 'threading',
    });
    appendMove(moves, operationId, 'rapid', 'thread_radial_retract', { x: passDiameter, z: threadEnd }, { x: clearDiameter, z: threadEnd }, { passIndex: pass, toolKind: 'threading' });
    appendMove(moves, operationId, 'rapid', 'thread_axial_return', { x: clearDiameter, z: threadEnd }, home, { passIndex: pass, toolKind: 'threading' });
    operations.push({
      id: operationId, kind: 'threading', name: `${pass > cuttingPasses ? 'Пружинный' : 'Резьбовой'} проход ${pass}/${totalPasses}`,
      status: CAM_STATUS.SUPPORTED, moveStart: startMove, moveEnd: moves.length - 1, passIndex: pass,
      safeApproach: true, safeRetract: true, synchronized: true, pitch: feature.pitch,
      spindleRevolutions: revolutions, targetThreadDepth: reachedDepth,
    });
  }
  return {
    status: CAM_STATUS.SUPPORTED, errors: validation.errors, warnings: validation.warnings,
    operations, moves, feature, parameters: { radialDepth, cuttingPasses, springPasses: feature.springPasses, totalPasses, threadStart, threadEnd, revolutions },
    helix: { zStart: feature.zStart, zEnd: feature.zEnd, pitch: feature.pitch, majorRadius: feature.majorDiameter / 2, minorRadius: feature.minorDiameter / 2, turns: feature.length / feature.pitch },
    estimatedMinutes: scheduleMoves(moves),
  };
}
