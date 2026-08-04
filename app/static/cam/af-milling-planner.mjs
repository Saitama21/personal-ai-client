import { CAM_STATUS, issue } from './contracts.mjs';
import { appendMove, scheduleMoves } from './motion-utils.mjs';
import { diameterAtZ } from './feature-contracts.mjs';

const EPS = 1e-6;
function rasterLanes(width, toolDiameter, stepOver) {
  const half = Math.max(0, (width - Math.min(width, toolDiameter)) / 2);
  if (half < EPS) return [0];
  const step = Math.max(0.2, Math.min(stepOver, toolDiameter * 0.9));
  const values = [];
  for (let y = -half; y <= half + EPS; y += step) values.push(Math.min(half, y));
  if (values.at(-1) < half - EPS) values.push(half);
  return [...new Set(values.map(value => Number(value.toFixed(6))))];
}

export function validateAfMilling(input, feature) {
  const errors = [], warnings = [];
  if (!feature.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors, warnings, enabled: false };
  if (!['C_INDEXED_XYZ', 'C_INDEXED_XZ'].includes(feature.mode)) errors.push(issue('AF_MODE_UNSUPPORTED', 'AF поддерживает индексирование C и проходы X/Y/Z.', 'error', 'features'));
  if (!(feature.widthAcrossFlats > 0)) errors.push(issue('AF_WIDTH_REQUIRED', 'Размер AF должен быть больше нуля.', 'error', 'features'));
  if (!Number.isInteger(feature.sides) || feature.sides < 3 || feature.sides > 12) errors.push(issue('AF_SIDES_INVALID', 'Количество граней должно быть от 3 до 12.', 'error', 'features'));
  if (!(feature.length > 0) || !(feature.zStart > feature.zEnd)) errors.push(issue('AF_LENGTH_INVALID', 'Нужны корректные длина, Z начала и Z конца AF.', 'error', 'features'));
  if (Number.isFinite(feature.zStart) && Number.isFinite(feature.zEnd) && Math.abs((feature.zStart - feature.zEnd) - feature.length) > 0.05) errors.push(issue('AF_LENGTH_MISMATCH', 'Длина AF не совпадает с диапазоном Z.', 'error', 'features'));
  if (feature.zStart > EPS || feature.zEnd < -input.blankLength - EPS) errors.push(issue('AF_Z_OUTSIDE_PART', 'AF выходит за длину детали.', 'error', 'features'));
  if (!(feature.toolDiameter > 0) || !(feature.radialStepDown > 0) || !(feature.stepOver > 0)) errors.push(issue('AF_TOOL_DATA_REQUIRED', 'Нужны диаметр фрезы, глубина прохода и шаг по Y.', 'error', 'features'));
  if (!(feature.feedRate > 0) || !(feature.rpm > 0)) errors.push(issue('AF_CUTTING_DATA_REQUIRED', 'Нужны положительные обороты и подача.', 'error', 'features'));
  const samples = [feature.zStart, (feature.zStart + feature.zEnd) / 2, feature.zEnd];
  const diameters = samples.map(z => diameterAtZ(input.contour, z)).filter(value => value > 0);
  const maxDiameter = diameters.length ? Math.max(...diameters) : null, minDiameter = diameters.length ? Math.min(...diameters) : null;
  const sourceDiameter = feature.sourceDiameter || minDiameter;
  if (!(sourceDiameter > 0)) errors.push(issue('AF_SOURCE_DIAMETER_REQUIRED', 'Не удалось определить исходный диаметр AF.', 'error', 'features'));
  if (maxDiameter && minDiameter && maxDiameter - minDiameter > 0.08) errors.push(issue('AF_SOURCE_NOT_CYLINDRICAL', 'AF должен лежать на цилиндрическом участке.', 'error', 'features'));
  if (sourceDiameter > 0 && feature.widthAcrossFlats >= sourceDiameter - EPS) errors.push(issue('AF_NO_MATERIAL_TO_REMOVE', 'AF должен быть меньше исходного диаметра.', 'error', 'features'));
  return { status: errors.length ? CAM_STATUS.BLOCKED : CAM_STATUS.SUPPORTED, errors, warnings, enabled: true, sourceDiameter };
}

export function planAfMilling(input, feature) {
  const validation = validateAfMilling(input, feature);
  if (!validation.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors: [], warnings: [], operations: [], moves: [], feature };
  if (validation.errors.length) return { status: CAM_STATUS.BLOCKED, errors: validation.errors, warnings: validation.warnings, operations: [], moves: [], feature };
  const sourceRadius = validation.sourceDiameter / 2, finalDistance = feature.widthAcrossFlats / 2;
  const radialDepth = sourceRadius - finalDistance, passCount = Math.max(1, Math.ceil(radialDepth / feature.radialStepDown));
  const toolRadius = feature.toolDiameter / 2, safeCenterRadius = sourceRadius + toolRadius + feature.radialClearance;
  const zApproach = feature.zStart + feature.axialLead, zExit = feature.zEnd - feature.axialLead;
  const chord = 2 * Math.sqrt(Math.max(0, sourceRadius * sourceRadius - finalDistance * finalDistance));
  const lanes = rasterLanes(chord, feature.toolDiameter, feature.stepOver);
  const moves = [], operations = [];
  let current = { x: 2 * safeCenterRadius, z: zApproach, c: feature.cOffset, y: lanes[0] || 0 };
  for (let face = 0; face < feature.sides; face += 1) {
    const cAngle = feature.cOffset + 360 * face / feature.sides;
    for (let pass = 1; pass <= passCount; pass += 1) {
      const operationId = `af-face-${face + 1}-pass-${pass}`, startMove = moves.length;
      if (Math.abs((current.c || 0) - cAngle) > EPS) {
        appendMove(moves, operationId, 'index', 'c_index_at_safe_retract', current, { ...current, c: cAngle }, { faceIndex: face, toolKind: 'millingAf', indexedAxis: 'C', spindleStopped: true });
        current = { ...current, c: cAngle };
      }
      const surfaceDistance = Math.max(finalDistance, sourceRadius - pass * feature.radialStepDown), centerDiameter = 2 * (surfaceDistance + toolRadius);
      for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
        const y = lanes[laneIndex], reverse = laneIndex % 2 === 1;
        const startZ = reverse ? zExit : zApproach, endZ = reverse ? zApproach : zExit;
        const safe = { x: 2 * safeCenterRadius, y, z: startZ, c: cAngle };
        const cutStart = { x: centerDiameter, y, z: startZ, c: cAngle }, cutEnd = { x: centerDiameter, y, z: endZ, c: cAngle };
        if (Math.abs(current.x - safe.x) > EPS || Math.abs(current.y - safe.y) > EPS || Math.abs(current.z - safe.z) > EPS) appendMove(moves, operationId, 'rapid', 'af_safe_approach', current, safe, { faceIndex: face, passIndex: pass, laneIndex, toolKind: 'millingAf' });
        appendMove(moves, operationId, 'feed', 'af_radial_infeed', safe, cutStart, { feedRate: Math.max(30, feature.feedRate * 0.5), faceIndex: face, passIndex: pass, laneIndex, toolKind: 'millingAf', surfaceDistance });
        appendMove(moves, operationId, 'feed', 'af_face_cut_y_raster', cutStart, cutEnd, { cutting: true, cutKind: 'mill_af', feedRate: feature.feedRate, faceIndex: face, passIndex: pass, laneIndex, surfaceDistance, nominalZStart: feature.zStart, nominalZEnd: feature.zEnd, laneY: y, spindleRpm: feature.rpm, toolDiameter: feature.toolDiameter, toolKind: 'millingAf', indexedC: cAngle });
        const retract = { x: 2 * safeCenterRadius, y, z: endZ, c: cAngle };
        appendMove(moves, operationId, 'rapid', 'af_radial_retract', cutEnd, retract, { faceIndex: face, passIndex: pass, laneIndex, toolKind: 'millingAf' });
        current = retract;
      }
      operations.push({ id: operationId, kind: 'milling_af', name: `AF грань ${face + 1}/${feature.sides}, проход ${pass}/${passCount}`, status: CAM_STATUS.SUPPORTED, moveStart: startMove, moveEnd: moves.length - 1, faceIndex: face, passIndex: pass, indexedC: cAngle, surfaceDistance, laneCount: lanes.length, safeApproach: true, safeRetract: true, yRequired: true });
    }
  }
  return { status: CAM_STATUS.SUPPORTED, errors: validation.errors, warnings: validation.warnings, operations, moves, feature: { ...feature, sourceDiameter: validation.sourceDiameter, mode: 'C_INDEXED_XYZ' }, parameters: { sourceRadius, finalDistance, radialDepth, passCount, chordWidth: chord, yLanes: lanes, indexAngles: Array.from({ length: feature.sides }, (_, face) => feature.cOffset + 360 * face / feature.sides) }, estimatedMinutes: scheduleMoves(moves) };
}
