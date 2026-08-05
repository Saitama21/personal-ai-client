import { CAM_STATUS, issue } from './contracts.mjs';
import { appendMove, scheduleMoves } from './motion-utils.mjs';
import { diameterAtZ } from './feature-contracts.mjs';

const EPS = 1e-6;

export function validateAfMilling(input, feature) {
  const errors = [];
  const warnings = [];
  if (!feature.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors, warnings, enabled: false };
  if (feature.mode !== 'C_INDEXED_XZ') errors.push(issue('AF_MODE_UNSUPPORTED', 'Поддерживается только индексируемое C фрезерование граней с подачами X/Z и Y=0.', 'error', 'features'));
  if (!(feature.widthAcrossFlats > 0)) errors.push(issue('AF_WIDTH_REQUIRED', 'Размер AF должен быть больше нуля.', 'error', 'features'));
  if (!Number.isInteger(feature.sides) || feature.sides < 3 || feature.sides > 12) errors.push(issue('AF_SIDES_INVALID', 'Количество граней должно быть целым числом от 3 до 12.', 'error', 'features'));
  if (!(feature.length > 0) || !(feature.zStart > feature.zEnd)) errors.push(issue('AF_LENGTH_INVALID', 'Нужны корректные длина, Z начала и Z конца AF.', 'error', 'features'));
  if (Number.isFinite(feature.zStart) && Number.isFinite(feature.zEnd) && Math.abs((feature.zStart - feature.zEnd) - feature.length) > 0.05) {
    errors.push(issue('AF_LENGTH_MISMATCH', 'Длина AF не совпадает с разностью Z начала и конца.', 'error', 'features'));
  }
  if (feature.zStart > EPS || feature.zEnd < -input.blankLength - EPS) errors.push(issue('AF_Z_OUTSIDE_PART', 'AF-участок выходит за длину детали.', 'error', 'features'));
  if (!(feature.toolDiameter > 0) || !(feature.radialStepDown > 0)) errors.push(issue('AF_TOOL_DATA_REQUIRED', 'Нужны положительные диаметр фрезы и радиальная глубина прохода.', 'error', 'features'));
  if (!(feature.feedRate > 0) || !(feature.rpm > 0)) errors.push(issue('AF_CUTTING_DATA_REQUIRED', 'Для AF нужны положительные обороты и минутная подача.', 'error', 'features'));
  const samples = [feature.zStart, (feature.zStart + feature.zEnd) / 2, feature.zEnd];
  const diameters = samples.map(z => diameterAtZ(input.contour, z)).filter(value => value > 0);
  const maxDiameter = diameters.length ? Math.max(...diameters) : null;
  const minDiameter = diameters.length ? Math.min(...diameters) : null;
  const sourceDiameter = feature.sourceDiameter || minDiameter;
  if (!(sourceDiameter > 0)) errors.push(issue('AF_SOURCE_DIAMETER_REQUIRED', 'Не удалось определить исходный диаметр AF-участка.', 'error', 'features'));
  if (maxDiameter && minDiameter && maxDiameter - minDiameter > 0.08) errors.push(issue('AF_SOURCE_NOT_CYLINDRICAL', 'AF-участок должен лежать на цилиндрическом наружном участке X/Z-контура.', 'error', 'features'));
  if (sourceDiameter > 0 && feature.widthAcrossFlats >= sourceDiameter - EPS) errors.push(issue('AF_NO_MATERIAL_TO_REMOVE', 'AF должен быть меньше исходного диаметра участка.', 'error', 'features'));
  const minimumAcrossFlats = sourceDiameter > 0 ? sourceDiameter * Math.cos(Math.PI / feature.sides) : 0;
  if (sourceDiameter > 0 && feature.widthAcrossFlats < minimumAcrossFlats * 0.35) warnings.push(issue('AF_DEEP_CUT', 'Глубина граней велика относительно исходного диаметра.', 'warning', 'features'));
  return { status: errors.length ? CAM_STATUS.BLOCKED : CAM_STATUS.SUPPORTED, errors, warnings, enabled: true, sourceDiameter };
}

export function planAfMilling(input, feature) {
  const validation = validateAfMilling(input, feature);
  if (!validation.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors: [], warnings: [], operations: [], moves: [], feature };
  if (validation.errors.length) return { status: CAM_STATUS.BLOCKED, errors: validation.errors, warnings: validation.warnings, operations: [], moves: [], feature };
  const normalizedFeature = { ...feature, sourceDiameter: validation.sourceDiameter };
  const sourceRadius = validation.sourceDiameter / 2;
  const finalDistance = feature.widthAcrossFlats / 2;
  const radialDepth = sourceRadius - finalDistance;
  const passCount = Math.max(1, Math.ceil(radialDepth / feature.radialStepDown));
  const toolRadius = feature.toolDiameter / 2;
  const safeCenterRadius = sourceRadius + toolRadius + feature.radialClearance;
  const zApproach = feature.zStart + feature.axialLead;
  const zExit = feature.zEnd - feature.axialLead;
  const moves = [];
  const operations = [];
  let currentC = feature.cOffset;
  let currentPoint = { x: 2 * safeCenterRadius, z: zApproach, c: currentC, y: 0 };
  for (let face = 0; face < feature.sides; face += 1) {
    const cAngle = feature.cOffset + (360 * face) / feature.sides;
    for (let pass = 1; pass <= passCount; pass += 1) {
      const operationId = `af-face-${face + 1}-pass-${pass}`;
      const startMove = moves.length;
      if (face > 0 && pass === 1) {
        appendMove(moves, operationId, 'index', 'c_index_at_safe_retract', currentPoint, { ...currentPoint, c: cAngle }, {
          faceIndex: face, toolKind: 'millingAf', indexedAxis: 'C', spindleStopped: true,
        });
        currentC = cAngle;
        currentPoint = { ...currentPoint, c: currentC };
      }
      const surfaceDistance = Math.max(finalDistance, sourceRadius - pass * feature.radialStepDown);
      const centerRadius = surfaceDistance + toolRadius;
      const approach = { x: 2 * safeCenterRadius, z: zApproach, c: currentC, y: 0 };
      const cutStart = { x: 2 * centerRadius, z: zApproach, c: currentC, y: 0 };
      const cutEnd = { x: 2 * centerRadius, z: zExit, c: currentC, y: 0 };
      if (currentPoint.z !== approach.z || currentPoint.x !== approach.x) {
        appendMove(moves, operationId, 'rapid', 'af_safe_approach', currentPoint, approach, { faceIndex: face, passIndex: pass, toolKind: 'millingAf' });
      }
      appendMove(moves, operationId, 'feed', 'af_radial_infeed', approach, cutStart, {
        feedRate: Math.max(30, feature.feedRate * 0.5), faceIndex: face, passIndex: pass, toolKind: 'millingAf', surfaceDistance,
      });
      appendMove(moves, operationId, 'feed', 'af_face_cut', cutStart, cutEnd, {
        cutting: true, cutKind: 'mill_af', feedRate: feature.feedRate, faceIndex: face, passIndex: pass,
        surfaceDistance, nominalZStart: feature.zStart, nominalZEnd: feature.zEnd,
        spindleRpm: feature.rpm, toolDiameter: feature.toolDiameter, toolKind: 'millingAf', indexedC: currentC,
      });
      const retract = { x: 2 * safeCenterRadius, z: zExit, c: currentC, y: 0 };
      appendMove(moves, operationId, 'rapid', 'af_radial_retract', cutEnd, retract, { faceIndex: face, passIndex: pass, toolKind: 'millingAf' });
      appendMove(moves, operationId, 'rapid', 'af_axial_return', retract, approach, { faceIndex: face, passIndex: pass, toolKind: 'millingAf' });
      currentPoint = approach;
      operations.push({
        id: operationId, kind: 'milling_af', name: `AF грань ${face + 1}/${feature.sides}, проход ${pass}/${passCount}`,
        status: CAM_STATUS.SUPPORTED, moveStart: startMove, moveEnd: moves.length - 1,
        faceIndex: face, passIndex: pass, indexedC: currentC, surfaceDistance,
        safeApproach: true, safeRetract: true, yRequired: false,
      });
    }
  }
  return {
    status: CAM_STATUS.SUPPORTED, errors: validation.errors, warnings: validation.warnings,
    operations, moves, feature: normalizedFeature,
    parameters: { sourceRadius, finalDistance, radialDepth, passCount, indexAngles: Array.from({ length: feature.sides }, (_, face) => feature.cOffset + 360 * face / feature.sides) },
    estimatedMinutes: scheduleMoves(moves),
  };
}
