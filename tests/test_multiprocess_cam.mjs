import {
  CAM_STATUS, buildCamPlan, materialVolume, simulateMaterial, toolPointAt,
} from '../app/static/cam/cam-engine.mjs';
import { planDrilling } from '../app/static/cam/drilling-planner.mjs';
import { planThreading } from '../app/static/cam/threading-planner.mjs';
import { planAfMilling } from '../app/static/cam/af-milling-planner.mjs';
import { normalizeCamInput } from '../app/static/cam/contracts.mjs';
import { normalizeFeatureContracts } from '../app/static/cam/feature-contracts.mjs';

function assert(condition, message) { if (!condition) throw new Error(message); }

function baseRaw(overrides = {}) {
  return {
    blankDiameter: 50, blankLength: 60, radialAllowance: 1, axialAllowance: 1,
    maxDepth: 2, finishAllowance: 0.25,
    contourPoints: [{ x: 44, z: 0 }, { x: 44, z: -15 }, { x: 36, z: -15 }, { x: 36, z: -60 }],
    operations: [
      { name: 'Черновое наружное точение', speed: 900, feed: 0.16 },
      { name: 'Нарезание M44x2' }, { name: 'Осевое сверление' }, { name: 'Фрезерование AF30' },
    ],
    features: {
      threading: { enabled: true, designation: 'M44x2', length: 12, zStart: -1, zEnd: -13, majorDiameter: 44, minorDiameter: 41.546, maxInfeedRadial: 0.3, rpm: 300, runIn: 1, runOut: 1 },
      drilling: { enabled: true, orientation: 'axial', diameter: 8, depth: 30, peckDepth: 5, retractZ: 3, feedRate: 80, rpm: 800 },
      millingAf: { enabled: true, widthAcrossFlats: 30, sides: 6, length: 30, zStart: -20, zEnd: -50, toolDiameter: 8, radialStepDown: 1, feedRate: 240, rpm: 2200 },
    },
    machineSetup: {
      confirmed: true, clearance: 0.2,
      limits: { xMin: 0, xMax: 100, zMin: -150, zMax: 50, yMin: -50, yMax: 50, cMin: -1000, cMax: 1000 },
      chuck: { frontZ: -65, backZ: -120, outerDiameter: 120, jawDiameter: 60 },
      envelopes: {
        turning: { radius: 0.5, cuttingReach: 8, gaugeLength: 80 },
        threading: { radius: 0.5, cuttingReach: 5, gaugeLength: 80 },
        drilling: { radius: 4, cuttingReach: 30, gaugeLength: 80 },
        millingAf: { radius: 4, cuttingReach: 8, gaugeLength: 80 },
      },
    },
    postprocessor: {
      confirmed: true, programName: 'TEST_PART', workOffset: 'G54',
      cAxisClamp: 'M10', cAxisUnclamp: 'M11', liveToolOn: 'M133 S{RPM}', liveToolOff: 'M135',
      coolantOn: 'M8', coolantOff: 'M9', safeParkX: 80, safeParkZ: 20,
    },
    ...overrides,
  };
}

const tests = [];
function run(name, fn) { fn(); tests.push(name); }

run('axial peck drilling has safe approach, cuts and retracts', () => {
  const raw = baseRaw(); const input = normalizeCamInput(raw); const features = normalizeFeatureContracts(raw, input);
  const plan = planDrilling(input, features.drilling);
  assert(plan.status === CAM_STATUS.SUPPORTED, 'axial drill blocked');
  assert(plan.moves.filter(move => move.cutKind === 'drill_axial').length === 6, 'unexpected peck count');
  assert(plan.moves.at(-1).role === 'drill_safe_retract', 'safe drill retract missing');
});

run('radial drilling is explicitly blocked', () => {
  const raw = baseRaw(); raw.features.drilling.orientation = 'radial';
  const input = normalizeCamInput(raw); const feature = normalizeFeatureContracts(raw, input).drilling;
  const plan = planDrilling(input, feature);
  assert(plan.status === CAM_STATUS.BLOCKED, 'radial drill was falsely enabled');
  assert(plan.errors.some(error => error.code === 'RADIAL_DRILLING_NOT_IMPLEMENTED'), 'radial drill gate missing');
});

run('thread planner produces synchronized pitch-controlled passes', () => {
  const raw = baseRaw(); const input = normalizeCamInput(raw); const feature = normalizeFeatureContracts(raw, input).threading;
  const plan = planThreading(input, feature);
  assert(plan.status === CAM_STATUS.SUPPORTED, 'threading blocked');
  assert(plan.moves.some(move => move.motion === 'thread' && move.pitch === 2 && move.synchronized), 'G33 contract missing');
  assert(plan.helix.turns === 6, 'helix turns mismatch');
});

run('AF planner indexes C and cuts every face', () => {
  const raw = baseRaw(); const input = normalizeCamInput(raw); const feature = normalizeFeatureContracts(raw, input).millingAf;
  const plan = planAfMilling(input, feature);
  assert(plan.status === CAM_STATUS.SUPPORTED, 'AF blocked');
  assert(plan.moves.filter(move => move.motion === 'index').length === 5, 'C index count mismatch');
  assert(new Set(plan.moves.filter(move => move.cutKind === 'mill_af').map(move => move.faceIndex)).size === 6, 'not every AF face is cut');
  assert(plan.moves.filter(move => move.motion === 'index').every(move => plan.operations.some(op => op.id === move.operationId)), 'orphan C index move');
});

run('unified plan removes 3D material progressively', () => {
  const plan = buildCamPlan(baseRaw({ machineSetup: { confirmed: false }, postprocessor: { confirmed: false } }));
  assert(plan.executable, 'geometry should remain simulatable before machine confirmation');
  assert(plan.operations.some(op => op.kind === 'threading') && plan.operations.some(op => op.kind === 'drilling') && plan.operations.some(op => op.kind === 'milling_af'), 'feature operations missing');
  const v0 = materialVolume(simulateMaterial(plan, 0)); const v5 = materialVolume(simulateMaterial(plan, 0.5)); const v1 = materialVolume(simulateMaterial(plan, 1));
  assert(v0 > v5 && v5 > v1, `non-progressive volumes ${v0}, ${v5}, ${v1}`);
  assert(toolPointAt(plan, 0.8)?.operation, 'unified tool timeline missing operation');
});

run('unconfirmed machine blocks collision and MPF', () => {
  const plan = buildCamPlan(baseRaw({ machineSetup: { confirmed: false }, postprocessor: { confirmed: false } }));
  assert(plan.collision.status === CAM_STATUS.BLOCKED && !plan.collision.safe, 'collision gate did not block');
  assert(plan.postprocessor.status === CAM_STATUS.BLOCKED, 'post gate did not block');
  assert(!plan.releaseReady, 'unsafe plan became release-ready');
});

run('confirmed envelopes pass collision and generate deterministic MPF', () => {
  const input = baseRaw(); const first = buildCamPlan(input); const second = buildCamPlan(input);
  assert(first.collision.status === CAM_STATUS.EVALUATED_LIMITED, JSON.stringify(first.collision.collisions?.slice(0, 3)));
  assert(first.postprocessor.status === CAM_STATUS.GENERATED, JSON.stringify(first.postprocessor.errors));
  assert(first.releaseReady && first.status === CAM_STATUS.SUPPORTED, 'release gate is not ready');
  assert(first.postprocessor.text === second.postprocessor.text, 'post output is not deterministic');
  assert(first.postprocessor.text.includes('G33') && first.postprocessor.text.includes('SPOS=AC'), 'thread or C index code absent');
  assert(first.postprocessor.statistics.mappedMoveCount >= first.postprocessor.statistics.cuttingMoveCount, 'cutting trace incomplete');
});

run('real configured collision blocks export', () => {
  const raw = baseRaw(); raw.machineSetup = { ...raw.machineSetup, restrictedZones: [{ id: 'guard', name: 'Guard', xMin: 0, xMax: 100, yMin: -20, yMax: 20, zMin: -10, zMax: 10 }] };
  const plan = buildCamPlan(raw);
  assert(plan.collision.status === CAM_STATUS.BLOCKED && plan.collision.collisions.some(item => item.code === 'HOLDER_RESTRICTED_ZONE'), 'configured collision not detected');
  assert(plan.postprocessor.status === CAM_STATUS.BLOCKED, 'colliding plan exported');
});

console.log(JSON.stringify({ passed: tests.length, tests }, null, 2));
