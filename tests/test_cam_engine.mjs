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
    assert(plan.millingAf.status === CAM_STATUS.NOT_IMPLEMENTED, 'AF milling must require explicit feature data');
    assert(plan.capabilities.axes.C === CAM_STATUS.NOT_EVALUATED, 'C axis must remain not evaluated without an enabled feature');
    assert(plan.capabilities.axes.Y === CAM_STATUS.NOT_EVALUATED, 'Y axis must remain not evaluated without an enabled feature');
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


  run('cutoff is planned as the final supported X/Z operation', () => {
    const plan = buildCamPlan(baseInput({
      operations: [
        { name: 'Торцевание', speed: 900, feed: 0.16 },
        { name: 'Черновое наружное точение', speed: 900, feed: 0.16, ap: 2 },
        { name: 'Чистовое наружное точение', speed: 1100, feed: 0.1 },
        { name: 'Отрезка в Z-60 до X0', speed: 500, feed: 0.05 },
      ],
      features: {
        cutoff: {
          enabled: true,
          zPosition: -60,
          bladeWidth: 2,
          finalDiameter: 0,
          radialClearance: 2,
          axialClearance: 2,
          rpm: 500,
          feedPerRev: 0.05,
          safetyConfirmed: true,
          toolId: 'T7',
        },
      },
    }));
    assert(plan.cutoff.status === CAM_STATUS.SUPPORTED, `Cutoff must be supported, got ${plan.cutoff.status}`);
    assert(plan.operations.at(-1)?.kind === 'cutoff', 'Cutoff must remain the final planned operation');
    assert(plan.moves.some(move => move.cutKind === 'cutoff' && move.cutting), 'Cutoff cutting move is missing');
    assert(plan.routeReport.at(-1)?.status === CAM_STATUS.SUPPORTED, 'Cutoff route item is not marked supported');
    assert(plan.capabilities.cutoff.status === CAM_STATUS.SUPPORTED, 'Cutoff capability is not reported as supported');
    const final = simulateMaterial(plan, 1);
    const cutoffSlice = final.odSlices.find(slice => Math.abs(slice.z + 60) < 1e-6);
    assert(cutoffSlice && approx(cutoffSlice.radius, 0), 'Cutoff groove did not reach the requested final diameter');
  });

  run('cutoff route item must remain last', () => {
    const plan = buildCamPlan(baseInput({
      operations: [
        { name: 'Отрезка в Z-60 до X0' },
        { name: 'Чистовое наружное точение' },
      ],
      features: {
        cutoff: {
          enabled: true,
          zPosition: -60,
          bladeWidth: 2,
          finalDiameter: 0,
          rpm: 500,
          feedPerRev: 0.05,
          safetyConfirmed: true,
        },
      },
    }));
    assert(!plan.geometryExecutable, 'A cutoff placed before another operation must block execution');
    assert(plan.errors.some(error => error.code === 'CUTOFF_MUST_BE_LAST'), 'Missing cutoff route-order error');
  });

  run('cutoff is blocked until the free zone is confirmed', () => {
    const plan = buildCamPlan(baseInput({
      operations: [{ name: 'Отрезка в Z-60 до X0' }],
      features: {
        cutoff: {
          enabled: true,
          zPosition: -60,
          bladeWidth: 2,
          finalDiameter: 0,
          rpm: 500,
          feedPerRev: 0.05,
          safetyConfirmed: false,
        },
      },
    }));
    assert(plan.cutoff.status === CAM_STATUS.BLOCKED, 'Unconfirmed cutoff safety must block the cutoff planner');
    assert(!plan.geometryExecutable, 'Blocked cutoff must block executable geometry');
    assert(plan.errors.some(error => error.code === 'CUTOFF_SAFETY_UNCONFIRMED'), 'Missing cutoff safety error');
  });

  return { passed: tests.length, tests };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(runCamEngineTests(), null, 2));
