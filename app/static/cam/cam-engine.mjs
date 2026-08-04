import {
  CAM_SCHEMA_VERSION, CAM_STATUS, capabilityMatrix, classifyRouteOperation,
  issue, normalizeCamInput, routeCapabilityReport,
} from './contracts.mjs';
import {
  materialProfile, materialVolume as axisymmetricVolume,
  simulateMaterial as simulateAxisymmetricMaterial, targetProfile,
} from './axisymmetric-material.mjs';
import { planTurning, toolPointAt } from './turning-planner.mjs';
import { normalizeFeatureContracts } from './feature-contracts.mjs';
import { planDrilling } from './drilling-planner.mjs';
import { planThreading } from './threading-planner.mjs';
import { planAfMilling } from './af-milling-planner.mjs';
import { planRadialDrilling } from './radial-drilling-planner.mjs';
import { planPocketMilling } from './pocket-milling-planner.mjs';
import { planCutoff } from './cutoff-planner.mjs';
import {
  createFeatureMaterialModel, featureRemovedVolume, radialBoundaryAt,
  simulateFeatureMaterial,
} from './feature-material.mjs';
import { appendMove, scheduleMoves } from './motion-utils.mjs';
import { BoundedCollisionProvider } from './collision-engine.mjs';
import { Sinumerik828DPostprocessor } from './postprocessor-sinumerik.mjs';

export {
  CAM_SCHEMA_VERSION, CAM_STATUS, materialProfile, radialBoundaryAt,
  targetProfile, toolPointAt,
};

function encounteredFeatures(input, features, route = []) {
  const secondary = Array.isArray(input.geometry?.secondaryFeatures) ? input.geometry.secondaryFeatures : [];
  const holes = Array.isArray(input.geometry?.holes) ? input.geometry.holes : [];
  return {
    milling: features.millingAf.enabled || Boolean(input.afContour.length || secondary.length || route.some(item => item.kind === 'milling')),
    millingPocket: features.millingPocket.enabled || route.some(item => item.kind === 'milling_pocket'),
    drilling: features.drilling.enabled || Boolean(holes.length || route.some(item => item.kind === 'drilling')),
    radialDrilling: features.radialDrilling.enabled || route.some(item => item.kind === 'radial_drilling'),
    threading: features.threading.enabled || route.some(item => item.kind === 'threading'),
    cutoff: features.cutoff.enabled || route.some(item => item.kind === 'cutoff'),
  };
}

function samePoint(a = {}, b = {}) {
  return ['x', 'z', 'y', 'c'].every(axis => {
    const av = Number(a[axis]); const bv = Number(b[axis]);
    return (!Number.isFinite(av) && !Number.isFinite(bv)) || Math.abs(av - bv) < 1e-8;
  });
}

function mergeExecutablePlans(input, plans) {
  const operations = [];
  const moves = [];
  let current = null;
  for (const subplan of plans.filter(item => item.status === CAM_STATUS.SUPPORTED && item.moves.length)) {
    const firstOperation = subplan.operations[0];
    const firstPoint = subplan.moves[0].from;
    const operationGlobalStart = moves.length;
    if (current && !samePoint(current, firstPoint)) {
      const safeX = Math.max(input.blankDiameter + 8, current.x || 0, firstPoint.x || 0);
      const toolKind = subplan.moves[0].toolKind || 'turning';
      const transferId = firstOperation.id;
      if (Math.abs((current.x || 0) - safeX) > 1e-8) appendMove(moves, transferId, 'rapid', 'inter_operation_radial_clearance', current, { ...current, x: safeX }, { toolKind });
      const radialCleared = moves.at(-1)?.to || current;
      if (Math.abs((radialCleared.z || 0) - (firstPoint.z || 0)) > 1e-8) appendMove(moves, transferId, 'rapid', 'inter_operation_axial_transfer', radialCleared, { ...radialCleared, z: firstPoint.z }, { toolKind });
      const axiallyTransferred = moves.at(-1)?.to || radialCleared;
      if (!samePoint(axiallyTransferred, firstPoint)) appendMove(moves, transferId, 'rapid', 'inter_operation_target_position', axiallyTransferred, firstPoint, { toolKind });
    }
    const moveOffset = moves.length;
    for (const source of subplan.moves) {
      moves.push({ ...source, id: `move-${moves.length + 1}`, from: { ...source.from }, to: { ...source.to } });
    }
    for (const operation of subplan.operations) {
      operations.push({ ...operation, moveStart: moveOffset + operation.moveStart, moveEnd: moveOffset + operation.moveEnd });
    }
    if (firstOperation) {
      const merged = operations.find(item => item.id === firstOperation.id);
      if (merged) merged.moveStart = operationGlobalStart;
    }
    current = subplan.moves.at(-1).to;
  }
  scheduleMoves(moves);
  return { operations, moves };
}

function outerRadiusAtMaterial(state, z) {
  const profile = materialProfile(state);
  if (!profile.length) return 0;
  const ordered = [...profile].sort((a, b) => b.z - a.z);
  if (z >= ordered[0].z) return ordered[0].radius;
  if (z <= ordered.at(-1).z) return ordered.at(-1).radius;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const a = ordered[index]; const b = ordered[index + 1];
    if (z <= a.z && z >= b.z) {
      const t = (z - a.z) / (b.z - a.z || 1);
      return a.radius + (b.radius - a.radius) * t;
    }
  }
  return ordered.at(-1).radius;
}

export function simulateMaterial(plan, progress) {
  const state = simulateAxisymmetricMaterial(plan, progress);
  state.features = simulateFeatureMaterial(plan, progress);
  state.featureRemovedVolume = featureRemovedVolume(plan, state.features, z => outerRadiusAtMaterial(state, z));
  return state;
}

export function materialVolume(state) {
  return Math.max(0, axisymmetricVolume(state) - (Number(state?.featureRemovedVolume) || 0));
}

function blockedFeatureErrors(features, results) {
  const errors = [];
  for (const [key, result] of [['threading', results.threading], ['drilling', results.drilling], ['radialDrilling', results.radialDrilling], ['millingAf', results.millingAf], ['millingPocket', results.millingPocket], ['cutoff', results.cutoff]]) {
    if (features[key].enabled && result.status === CAM_STATUS.BLOCKED) errors.push(...result.errors);
  }
  return errors;
}

export function buildCamPlan(rawInput, providers = {}) {
  const input = normalizeCamInput(rawInput);
  const features = normalizeFeatureContracts(rawInput, input);
  const turning = planTurning(input);
  const threading = planThreading(input, features.threading);
  const drilling = planDrilling(input, features.drilling);
  const radialDrilling = planRadialDrilling(input, features.radialDrilling);
  const millingAf = planAfMilling(input, features.millingAf);
  const millingPocket = planPocketMilling(input, features.millingPocket);
  const cutoff = planCutoff(input, features.cutoff);
  const plannerResults = { threading, drilling, radialDrilling, millingAf, millingPocket, cutoff };
  const provisionalRoute = routeCapabilityReport(input.route);
  const encountered = encounteredFeatures(input, features, provisionalRoute);
  const routeReport = routeCapabilityReport(input.route, {
    threading: threading.status === CAM_STATUS.SUPPORTED,
    drilling: drilling.status === CAM_STATUS.SUPPORTED,
    radialDrilling: radialDrilling.status === CAM_STATUS.SUPPORTED,
    millingAf: millingAf.status === CAM_STATUS.SUPPORTED,
    millingPocket: millingPocket.status === CAM_STATUS.SUPPORTED,
    cutoff: cutoff.status === CAM_STATUS.SUPPORTED,
  });
  const unsupportedOperations = routeReport.filter(item => item.status === CAM_STATUS.NOT_IMPLEMENTED);
  const cutoffRouteIndex = routeReport.findIndex(item => item.kind === 'cutoff');
  const routeOrderErrors = cutoffRouteIndex >= 0 && cutoffRouteIndex !== routeReport.length - 1
    ? [issue('CUTOFF_MUST_BE_LAST', 'Отрезка должна быть последней операцией технологического маршрута.', 'error', 'route')]
    : [];
  const featureErrors = blockedFeatureErrors(features, plannerResults);
  const geometryErrors = [...turning.errors, ...featureErrors, ...routeOrderErrors];
  const geometryExecutable = turning.status === CAM_STATUS.SUPPORTED && geometryErrors.length === 0;
  const merged = geometryExecutable
    ? mergeExecutablePlans(input, [turning, threading, drilling, radialDrilling, millingAf, millingPocket, cutoff])
    : { operations: [], moves: [] };
  const warnings = [
    ...turning.warnings, ...threading.warnings, ...drilling.warnings, ...radialDrilling.warnings, ...millingAf.warnings, ...millingPocket.warnings, ...cutoff.warnings,
  ];
  if (unsupportedOperations.length) warnings.push(issue('ROUTE_PARTIALLY_UNSUPPORTED', 'Маршрут содержит операции вне рассчитанного подмножества; выпуск MPF заблокирован.', 'warning', 'route'));
  const plan = {
    schemaVersion: CAM_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    input, setup: input.setup, features,
    machineSetup: features.machineSetup,
    postConfig: features.postprocessor,
    turning, threading, drilling, radialDrilling, millingAf, millingPocket, milling: { af: millingAf, pocket: millingPocket }, cutoff,
    routeReport, unsupportedOperations, warnings, errors: geometryErrors,
    operations: merged.operations, moves: merged.moves,
    materialModel: turning.materialModel,
    estimatedMinutes: merged.moves.reduce((sum, move) => sum + (move.durationMinutes || 0), 0),
    executable: geometryExecutable,
    geometryExecutable,
    kinematics: {
      model: 'CK52PT_Y_TURN_MILL_XYZC_V2', axes: { X: 'DIAMETER', Z: 'LINEAR', Y: 'LINEAR', C: 'INDEXED_BLOCKING' }, turretStations: 15, view: { chuck: 'LEFT', turret: 'RIGHT', clampDiameter: input.setup?.clampDiameter || null, clampLength: input.setup?.clampLength || null, protectedClampZone: Boolean(input.setup?.protectClampZone), processingOrder: input.setup?.processingOrder || 'canonical' },
    },
  };
  plan.featureMaterialModel = createFeatureMaterialModel(plan);
  const collisionProvider = providers.collision || new BoundedCollisionProvider();
  plan.collision = geometryExecutable
    ? collisionProvider.evaluate({ plan, machineSetup: features.machineSetup })
    : { status: CAM_STATUS.BLOCKED, safe: false, errors: geometryErrors, collisions: [], checkedBodies: [], samplesChecked: 0, message: 'Коллизии не проверены: геометрический план заблокирован.' };
  const postprocessor = providers.postprocessor || new Sinumerik828DPostprocessor();
  plan.postprocessor = geometryExecutable
    ? postprocessor.generate(plan, features.postprocessor)
    : { status: CAM_STATUS.BLOCKED, errors: geometryErrors, lines: [], text: '', trace: [] };
  plan.releaseReady = plan.collision.safe === true && plan.postprocessor.status === CAM_STATUS.GENERATED;
  plan.status = !geometryExecutable ? CAM_STATUS.BLOCKED
    : (unsupportedOperations.length || !plan.releaseReady ? CAM_STATUS.PARTIAL : CAM_STATUS.SUPPORTED);
  plan.capabilities = capabilityMatrix(encountered, { ...plannerResults, collision: plan.collision, postprocessor: plan.postprocessor });
  return plan;
}

export function planSummary(plan) {
  return {
    schemaVersion: plan.schemaVersion, status: plan.status, executable: plan.executable,
    releaseReady: plan.releaseReady, generatedAt: plan.generatedAt,
    operationCount: plan.operations.length, moveCount: plan.moves.length,
    roughPassCount: plan.turning?.parameters?.roughPassCount || 0,
    estimatedMinutes: plan.estimatedMinutes, capabilities: plan.capabilities,
    unsupportedOperations: plan.unsupportedOperations.map(item => ({ name: item.name, kind: item.kind, reason: item.reason })),
    warnings: plan.warnings, errors: plan.errors, collision: plan.collision,
    postprocessor: { status: plan.postprocessor.status, checksum: plan.postprocessor.checksum || null, statistics: plan.postprocessor.statistics || null, errors: plan.postprocessor.errors || [] },
  };
}

export function operationAt(plan, progress) { return toolPointAt(plan, progress)?.operation || null; }
export function classifyOperation(name) { return classifyRouteOperation(name); }
