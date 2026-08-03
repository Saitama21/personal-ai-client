import {
  CAM_STATUS,
  buildCamPlan,
  materialVolume,
  simulateMaterial,
  toolPointAt,
} from '../app/static/cam/cam-engine.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function approx(actual, expected, tolerance = 1e-4) {
  return Math.abs(actual - expected) <= tolerance;
}

function baseInput(overrides = {}) {
  return {
    blankDiameter: 50,
    blankLength: 60,
    radialAllowance: 1,
    axialAllowance: 1,
    maxDepth: 2,
    finishAllowance: 0.25,
    contourPoints: [
      { x: 44, z: 0 },
      { x: 44, z: -15 },
      { x: 36, z: -15 },
      { x: 36, z: -60 },
    ],
    operations: [
      { name: 'Торцевание', speed: 900, feed: 0.16 },
      { name: 'Черновое наружное точение', speed: 900, feed: 0.16, ap: 2 },
      { name: 'Чистовое наружное точение', speed: 1100, feed: 0.1 },
    ],
    coordinateSystem: { xMode: 'diameter', zZero: 'right_face' },
    ...overrides,
  };
}

export function runCamEngineTests() {
  const tests = [];
  const run = (name, fn) => {
    fn();
    tests.push(name);
  };

  run('valid X/Z plan is executable', () => {
    const plan = buildCamPlan(baseInput());
    assert(plan.executable, 'A valid turning plan must be executable');
    assert(plan.status === CAM_STATUS.PARTIAL, `Universal geometry without machine passport must be PARTIAL, got ${plan.status}`);
    assert(plan.turning.parameters.roughPassCount > 0, 'Roughing passes were not generated');
    assert(plan.operations.some(operation => operation.kind === 'finish_turning'), 'Finish pass is missing');
    assert(plan.moves.some(move => move.role === 'safe_approach'), 'Safe approach is missing');
    assert(plan.moves.some(move => move.role === 'safe_radial_retract'), 'Radial retract is missing');
    assert(plan.moves.some(move => move.role === 'safe_axial_retract'), 'Axial retract is missing');
    assert(plan.moves.every(move => move.startProgress <= move.endProgress), 'Move schedule is not monotonic');
  });

  run('material is progressively removed to target', () => {
    const plan = buildCamPlan(baseInput());
    const initial = simulateMaterial(plan, 0);
    const middle = simulateMaterial(plan, 0.5);
    const final = simulateMaterial(plan, 1);
    const v0 = materialVolume(initial);
    const v1 = materialVolume(middle);
    const v2 = materialVolume(final);
    assert(v0 > v1 && v1 >= v2, `Volumes must decrease: ${v0}, ${v1}, ${v2}`);
    assert(final.odSlices.every(slice => approx(slice.radius, slice.targetRadius)), 'Final OD does not match the approved target contour');
    assert(approx(final.faceRadius, 0), 'Facing allowance was not fully removed');
  });

  run('tool interpolation follows a scheduled machine move', () => {
    const plan = buildCamPlan(baseInput());
    const point = toolPointAt(plan, 0.35);
    assert(point && point.move && point.operation, 'Tool point lacks move/operation context');
    assert(Number.isFinite(point.x) && Number.isFinite(point.z), 'Tool coordinates are invalid');
    const move = point.move;
    assert(point.x >= Math.min(move.from.x, move.to.x) - 1e-6, 'Interpolated X is outside move');
    assert(point.x <= Math.max(move.from.x, move.to.x) + 1e-6, 'Interpolated X is outside move');
  });

  run('unsupported hybrid features are explicit and not executed', () => {
    const plan = buildCamPlan(baseInput({
      afContour: [[10, 0], [5, 8]],
      operations: [
        { name: 'Черновое наружное точение' },
        { name: 'Фрезерование AF с индексированием C' },
      ],
    }));
    assert(plan.status === CAM_STATUS.PARTIAL, `Hybrid plan must be PARTIAL, got ${plan.status}`);
    assert(plan.executable, 'Supported turning subset must remain executable');
    assert(plan.milling.status === CAM_STATUS.NOT_IMPLEMENTED, 'Milling must not be represented as supported');
    assert(plan.capabilities.axes.C === CAM_STATUS.NOT_IMPLEMENTED, 'C axis must be not implemented');
    assert(plan.capabilities.axes.Y === CAM_STATUS.PARTIAL, 'Y axis must be not implemented');
    assert(plan.moves.every(move => ['face', 'turn', null].includes(move.cutKind)), 'Unsupported milling move entered executable plan');
  });

  run('collision is blocked until machine geometry is confirmed', () => {
    const plan = buildCamPlan(baseInput());
    assert(plan.collision.status === CAM_STATUS.BLOCKED, 'Collision result must be BLOCKED');
    assert(plan.collision.checkedBodies.length === 0, 'No collision bodies may be claimed as checked');
    assert(plan.capabilities.collision.status === CAM_STATUS.BLOCKED, 'Collision capability must be gated by confirmed machine data');
  });

  run('invalid contour blocks execution', () => {
    const plan = buildCamPlan(baseInput({ contourPoints: [{ x: 60, z: 0 }, { x: 40, z: -60 }] }));
    assert(!plan.executable, 'Contour outside stock must not execute');
    assert(plan.status === CAM_STATUS.BLOCKED, `Invalid plan must be BLOCKED, got ${plan.status}`);
    assert(plan.errors.some(error => error.code === 'CONTOUR_OUTSIDE_STOCK'), 'Expected stock-boundary error is missing');
    assert(plan.moves.length === 0, 'Blocked plan must have no executable moves');
  });

  run('missing contour blocks execution without fallback geometry', () => {
    const plan = buildCamPlan(baseInput({ contourPoints: [] }));
    assert(!plan.executable, 'Missing contour must block execution');
    assert(plan.errors.some(error => error.code === 'CONTOUR_REQUIRED'), 'Missing contour warning is absent');
  });

  return { passed: tests.length, tests };
}
