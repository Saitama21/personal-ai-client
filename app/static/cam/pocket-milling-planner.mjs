import { CAM_STATUS, issue } from './contracts.mjs';
import { appendMove, scheduleMoves } from './motion-utils.mjs';
import { diameterAtZ } from './feature-contracts.mjs';

const EPS = 1e-6;

function laneValues(width, toolDiameter, stepOver, type) {
  if (type === 'slot' || width <= toolDiameter + EPS) return [0];
  const half = Math.max(0, (width - toolDiameter) / 2);
  const lanes = [];
  for (let y = -half; y <= half + EPS; y += stepOver) lanes.push(Number(Math.min(half, y).toFixed(6)));
  if (lanes.at(-1) < half - EPS) lanes.push(half);
  return [...new Set(lanes.map(value => Number(value.toFixed(6))))];
}

export function validatePocketMilling(input, feature) {
  const errors = [];
  const warnings = [];
  if (!feature.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors, warnings, enabled: false };
  if (!['pocket', 'slot'].includes(feature.type)) errors.push(issue('MILL_FEATURE_TYPE_INVALID', 'Тип фрезерной операции должен быть pocket или slot.', 'error', 'features'));
  if (!['radial', 'face'].includes(feature.placement)) errors.push(issue('MILL_PLACEMENT_INVALID', 'Расположение фрезерного элемента должно быть radial или face.', 'error', 'features'));
  if (!(feature.length > 0) || !(feature.width > 0) || !(feature.depth > 0)) errors.push(issue('MILL_GEOMETRY_REQUIRED', 'Для кармана/паза нужны положительные длина, ширина и глубина.', 'error', 'features'));
  if (!(feature.toolDiameter > 0) || !(feature.stepOver > 0) || !(feature.stepDown > 0)) errors.push(issue('MILL_TOOL_DATA_REQUIRED', 'Нужны положительные диаметр фрезы, шаг перекрытия и глубина прохода.', 'error', 'features'));
  if (!(feature.feedRate > 0) || !(feature.rpm > 0)) errors.push(issue('MILL_CUTTING_DATA_REQUIRED', 'Для фрезерования нужны положительные обороты и минутная подача.', 'error', 'features'));
  if (!Number.isInteger(feature.count) || feature.count < 1 || feature.count > 32) errors.push(issue('MILL_COUNT_INVALID', 'Количество повторов должно быть от 1 до 32.', 'error', 'features'));
  if (feature.width + EPS < feature.toolDiameter && feature.type === 'pocket') warnings.push(issue('MILL_TOOL_WIDER_THAN_POCKET', 'Фреза шире указанного кармана. Для кармана выберите меньшую фрезу.', 'warning', 'features'));

  let sourceDiameter = null;
  let zStart = feature.zStart;
  let zEnd = feature.zEnd;
  if (feature.placement === 'radial') {
    if (!(zStart > zEnd)) {
      zStart = feature.zCenter + feature.length / 2;
      zEnd = feature.zCenter - feature.length / 2;
    }
    if (zStart > EPS || zEnd < -input.blankLength - EPS) errors.push(issue('MILL_Z_OUTSIDE_PART', 'Карман/паз выходит за длину детали.', 'error', 'features'));
    sourceDiameter = diameterAtZ(input.contour, (zStart + zEnd) / 2);
    if (!(sourceDiameter > 0)) errors.push(issue('MILL_SOURCE_DIAMETER_REQUIRED', 'Не удалось определить наружный диаметр под карманом/пазом.', 'error', 'features'));
    if (sourceDiameter > 0 && feature.depth >= sourceDiameter / 2 - EPS) warnings.push(issue('MILL_DEEP_RADIAL_FEATURE', 'Глубина кармана/паза близка к радиусу детали — проверьте остаточную стенку.', 'warning', 'features'));
  } else {
    zStart = 0;
    zEnd = -feature.depth;
    if (!Number.isFinite(feature.xCenter) || !Number.isFinite(feature.yCenter)) errors.push(issue('FACE_MILL_CENTER_REQUIRED', 'Для торцевого кармана нужны координаты центра X/Y.', 'error', 'features'));
  }
  return { status: errors.length ? CAM_STATUS.BLOCKED : CAM_STATUS.SUPPORTED, errors, warnings, enabled: true, sourceDiameter, zStart, zEnd };
}

export function planPocketMilling(input, feature) {
  const validation = validatePocketMilling(input, feature);
  if (!validation.enabled) return { status: CAM_STATUS.NOT_IMPLEMENTED, errors: [], warnings: [], operations: [], moves: [], feature };
  if (validation.errors.length) return { status: CAM_STATUS.BLOCKED, errors: validation.errors, warnings: validation.warnings, operations: [], moves: [], feature };

  const toolRadius = feature.toolDiameter / 2;
  const lanes = laneValues(feature.width, feature.toolDiameter, feature.stepOver, feature.type);
  const depthPasses = Math.max(1, Math.ceil(feature.depth / feature.stepDown));
  const angularStep = feature.angularStep > 0 ? feature.angularStep : 360 / feature.count;
  const moves = [];
  const operations = [];
  let current = null;

  for (let copyIndex = 0; copyIndex < feature.count; copyIndex += 1) {
    const cAngle = feature.cAngle + angularStep * copyIndex;
    for (let pass = 1; pass <= depthPasses; pass += 1) {
      const depthReached = Math.min(feature.depth, pass * feature.stepDown);
      const operationId = `mill-${feature.type}-${copyIndex + 1}-pass-${pass}`;
      const startMove = moves.length;

      if (feature.placement === 'radial') {
        const sourceDiameter = validation.sourceDiameter;
        const safeX = sourceDiameter + 2 * (feature.radialClearance + toolRadius);
        const cutX = Math.max(0, sourceDiameter - 2 * depthReached);
        const zStart = validation.zStart;
        const zEnd = validation.zEnd;
        const firstLane = lanes[0] || 0;
        const safe = { x: safeX, z: zStart, y: firstLane, c: cAngle };
        if (!current) current = { ...safe };
        if (Math.abs((current.c || 0) - cAngle) > EPS) {
          appendMove(moves, operationId, 'index', 'pocket_c_index', current, { ...current, c: cAngle }, { copyIndex, passIndex: pass, toolKind: 'millingPocket', indexedAxis: 'C', spindleStopped: true });
          current = { ...current, c: cAngle };
        }
        if (Math.abs(current.x - safe.x) > EPS || Math.abs(current.z - safe.z) > EPS || Math.abs((current.y || 0) - safe.y) > EPS) {
          appendMove(moves, operationId, 'rapid', 'pocket_safe_approach', current, safe, { copyIndex, passIndex: pass, toolKind: 'millingPocket' });
        }
        const plunge = { x: cutX, z: zStart, y: firstLane, c: cAngle };
        appendMove(moves, operationId, 'feed', 'pocket_radial_infeed', safe, plunge, {
          feedRate: Math.max(20, feature.feedRate * 0.35), copyIndex, passIndex: pass, toolKind: 'millingPocket', depthReached,
        });
        let cursor = plunge;
        lanes.forEach((lane, laneIndex) => {
          const targetStart = { x: cutX, z: laneIndex % 2 === 0 ? zStart : zEnd, y: lane, c: cAngle };
          if (Math.abs(cursor.y - targetStart.y) > EPS || Math.abs(cursor.z - targetStart.z) > EPS) {
            appendMove(moves, operationId, 'feed', 'pocket_lane_step', cursor, targetStart, {
              cutting: true, cutKind: 'mill_pocket', feedRate: feature.feedRate, copyIndex, passIndex: pass, laneIndex,
              depthReached, toolKind: 'millingPocket', placement: 'radial', featureType: feature.type,
            });
          }
          const targetEnd = { x: cutX, z: laneIndex % 2 === 0 ? zEnd : zStart, y: lane, c: cAngle };
          appendMove(moves, operationId, 'feed', 'pocket_raster_cut', targetStart, targetEnd, {
            cutting: true, cutKind: 'mill_pocket', feedRate: feature.feedRate, copyIndex, passIndex: pass, laneIndex,
            depthReached, toolKind: 'millingPocket', placement: 'radial', featureType: feature.type,
            zStart, zEnd, width: feature.width, sourceDiameter,
          });
          cursor = targetEnd;
        });
        const retract = { x: safeX, z: cursor.z, y: cursor.y, c: cAngle };
        appendMove(moves, operationId, 'rapid', 'pocket_radial_retract', cursor, retract, { copyIndex, passIndex: pass, toolKind: 'millingPocket' });
        current = retract;
      } else {
        const halfLength = feature.length / 2;
        const xStart = feature.xCenter - halfLength;
        const xEnd = feature.xCenter + halfLength;
        const safeZ = feature.axialClearance;
        const cutZ = -depthReached;
        const firstLane = feature.yCenter + (lanes[0] || 0);
        const safe = { x: xStart, y: firstLane, z: safeZ, c: cAngle };
        if (!current) current = { ...safe };
        if (Math.abs((current.c || 0) - cAngle) > EPS) {
          appendMove(moves, operationId, 'index', 'face_pocket_c_index', current, { ...current, c: cAngle }, { copyIndex, passIndex: pass, toolKind: 'millingPocket', indexedAxis: 'C', spindleStopped: true });
          current = { ...current, c: cAngle };
        }
        appendMove(moves, operationId, 'rapid', 'face_pocket_safe_approach', current, safe, { copyIndex, passIndex: pass, toolKind: 'millingPocket' });
        const plunge = { ...safe, z: cutZ };
        appendMove(moves, operationId, 'feed', 'face_pocket_plunge', safe, plunge, { feedRate: Math.max(20, feature.feedRate * 0.35), copyIndex, passIndex: pass, toolKind: 'millingPocket', depthReached });
        let cursor = plunge;
        lanes.forEach((lane, laneIndex) => {
          const y = feature.yCenter + lane;
          const targetStart = { x: laneIndex % 2 === 0 ? xStart : xEnd, y, z: cutZ, c: cAngle };
          if (Math.abs(cursor.x - targetStart.x) > EPS || Math.abs(cursor.y - targetStart.y) > EPS) appendMove(moves, operationId, 'feed', 'face_pocket_lane_step', cursor, targetStart, { cutting: true, cutKind: 'mill_face_pocket', feedRate: feature.feedRate, copyIndex, passIndex: pass, laneIndex, depthReached, toolKind: 'millingPocket', placement: 'face', featureType: feature.type });
          const targetEnd = { x: laneIndex % 2 === 0 ? xEnd : xStart, y, z: cutZ, c: cAngle };
          appendMove(moves, operationId, 'feed', 'face_pocket_raster_cut', targetStart, targetEnd, { cutting: true, cutKind: 'mill_face_pocket', feedRate: feature.feedRate, copyIndex, passIndex: pass, laneIndex, depthReached, toolKind: 'millingPocket', placement: 'face', featureType: feature.type, width: feature.width, length: feature.length });
          cursor = targetEnd;
        });
        const retract = { ...cursor, z: safeZ };
        appendMove(moves, operationId, 'rapid', 'face_pocket_axial_retract', cursor, retract, { copyIndex, passIndex: pass, toolKind: 'millingPocket' });
        current = retract;
      }

      operations.push({
        id: operationId,
        kind: 'milling_pocket',
        name: `${feature.type === 'slot' ? 'Паз' : 'Карман'} ${copyIndex + 1}/${feature.count} · проход ${pass}/${depthPasses}`,
        status: CAM_STATUS.SUPPORTED,
        moveStart: startMove,
        moveEnd: moves.length - 1,
        copyIndex,
        passIndex: pass,
        indexedC: cAngle,
        depthReached,
        yRequired: true,
        safeApproach: true,
        safeRetract: true,
      });
    }
  }

  return {
    status: CAM_STATUS.SUPPORTED,
    errors: validation.errors,
    warnings: validation.warnings,
    operations,
    moves,
    feature: { ...feature, sourceDiameter: validation.sourceDiameter, zStart: validation.zStart, zEnd: validation.zEnd, angularStep },
    parameters: { lanes, depthPasses, angularStep, sourceDiameter: validation.sourceDiameter },
    estimatedMinutes: scheduleMoves(moves),
  };
}
