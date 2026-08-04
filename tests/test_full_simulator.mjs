import { CAM_STATUS, buildCamPlan, materialVolume, simulateMaterial, toolPointAt } from '../app/static/cam/cam-engine.mjs';

function assert(condition, message) { if (!condition) throw new Error(message); }

const raw = {
  blankDiameter: 60, blankLength: 80, radialAllowance: 1, axialAllowance: 1,
  maxDepth: 2, finishAllowance: 0.25, material: 'AISI 304',
  contourPoints: [{ x: 54, z: 0 }, { x: 54, z: -30 }, { x: 46, z: -30 }, { x: 46, z: -80 }],
  operations: [
    { name: 'Торцевание' }, { name: 'Черновое наружное точение' }, { name: 'Чистовое наружное точение' },
    { name: 'Нарезание M46x2' }, { name: 'Осевое сверление' }, { name: 'Радиальное сверление' }, { name: 'Фрезерование AF40' }, { name: 'Карман на наружном диаметре' }, { name: 'Отрезка' },
  ],
  features: {
    threading: { enabled: true, designation: 'M46x2', pitch: 2, length: 12, zStart: -31, zEnd: -43, majorDiameter: 46, minorDiameter: 43.546, maxInfeedRadial: 0.3, rpm: 300, runIn: 1, runOut: 1, toolId: 'T3' },
    drilling: { enabled: true, diameter: 8, depth: 35, peckDepth: 5, retractZ: 3, rpm: 850, feedRate: 80, toolId: 'T6' },
    radialDrilling: { enabled: true, diameter: 5, depth: 8, peckDepth: 3, radialZ: -18, cAngle: 0, count: 4, angularStep: 90, rpm: 1600, feedRate: 95, toolId: 'T10' },
    millingAf: { enabled: true, widthAcrossFlats: 40, sides: 6, length: 25, zStart: -35, zEnd: -60, toolDiameter: 8, radialStepDown: 1, stepOver: 3.5, rpm: 2200, feedRate: 240, toolId: 'T4' },
    millingPocket: { enabled: true, type: 'pocket', placement: 'radial', length: 14, width: 10, depth: 3, zCenter: -68, cAngle: 0, count: 2, angularStep: 180, toolDiameter: 6, stepOver: 2, stepDown: 1, rpm: 2500, feedRate: 260, toolId: 'T8' },
    cutoff: { enabled: true, zPosition: -78, bladeWidth: 3, finalDiameter: 0, sourceDiameter: 46, radialClearance: 2, axialClearance: 2, rpm: 400, feedPerRev: 0.06, safetyConfirmed: true, toolId: 'T15' },
  },
  machineSetup: { confirmed: false },
  postprocessor: { confirmed: false },
};

const plan = buildCamPlan(raw);
assert(plan.executable, JSON.stringify(plan.errors));
assert(plan.kinematics.view.chuck === 'LEFT' && plan.kinematics.view.turret === 'RIGHT', 'machine view orientation is wrong');
assert(plan.kinematics.turretStations === 15, '15-position turret missing');
assert(plan.threading.status === CAM_STATUS.SUPPORTED, 'threading not supported');
assert(plan.drilling.status === CAM_STATUS.SUPPORTED, 'axial drilling not supported');
assert(plan.radialDrilling.status === CAM_STATUS.SUPPORTED, 'radial drilling not supported');
assert(plan.millingAf.status === CAM_STATUS.SUPPORTED, 'AF milling not supported');
assert(plan.millingPocket.status === CAM_STATUS.SUPPORTED, 'pocket milling not supported');
assert(plan.cutoff.status === CAM_STATUS.SUPPORTED, 'cutoff not supported');
assert(plan.moves.some(m => m.motion === 'thread' && m.cutKind === 'thread_external'), 'thread path missing');
assert(plan.moves.some(m => m.cutKind === 'drill_axial'), 'axial drilling path missing');
assert(plan.moves.some(m => m.cutKind === 'drill_radial'), 'radial drilling path missing');
assert(plan.moves.some(m => m.cutKind === 'mill_af' && Math.abs(m.to.y) > 0), 'AF Y-axis raster missing');
assert(plan.moves.some(m => m.cutKind === 'mill_pocket' && Math.abs(m.to.y) > 0), 'pocket Y-axis raster missing');
assert(plan.moves.some(m => m.cutKind === 'cutoff'), 'cutoff path missing');
assert(plan.operations.at(-1)?.kind === 'cutoff', 'cutoff is not last');
assert(plan.moves.some(m => m.motion === 'index' && Math.abs(m.to.c) > 0), 'C-axis indexing missing');
assert(plan.capabilities.axes.Y === CAM_STATUS.SUPPORTED, 'Y capability not reported');
assert(plan.capabilities.axes.C === CAM_STATUS.SUPPORTED_INDEXED, 'C capability not reported');
assert(plan.capabilities.turret.status === CAM_STATUS.SUPPORTED, 'turret capability not reported');
const v0 = materialVolume(simulateMaterial(plan, 0));
const v1 = materialVolume(simulateMaterial(plan, 1));
assert(v1 < v0, `material did not decrease: ${v0} -> ${v1}`);
const p = toolPointAt(plan, 0.75);
assert(p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && Number.isFinite(p.c), 'XYZC interpolation failed');
console.log(JSON.stringify({ passed: true, operations: plan.operations.length, moves: plan.moves.length, volumeRemoved: v0 - v1, capabilities: plan.capabilities }, null, 2));
