import assert from 'node:assert/strict';
import { buildCamPlan, simulateMaterial, materialProfile } from '../app/static/cam/cam-engine.mjs';
import { clampZoneForInput, exposedTurningProfile } from '../app/static/cam/turning-planner.mjs';

const contour = [
  { x: 60, z: 0 },
  { x: 60, z: -5 },
  { x: 57, z: -5 },
  { x: 50, z: -8.5 },
  { x: 50, z: -30 },
];

const input = {
  blankDiameter: 60,
  blankLength: 30,
  radialAllowance: 0,
  axialAllowance: 0,
  maxDepth: 2,
  finishAllowance: 0.2,
  coordinateSystem: { xMode: 'diameter', zZero: 'right_face' },
  setup: {
    clampSide: 'left',
    clampDiameter: 60,
    clampLength: 5,
    protectClampZone: true,
    processingOrder: 'from_clamp_to_free',
    visualMirror: true,
    baseReference: 'clamp_face',
    confirmed: true,
  },
  contourPoints: contour,
  operations: [{ name: 'Черновое точение', speed: 800, feed: 0.15 }],
  features: {
    drilling: {
      enabled: true,
      orientation: 'axial',
      diameter: 12.2,
      depth: 30,
      peckDepth: 4,
      retractZ: 2,
      rpm: 800,
      feedRate: 90,
      toolId: 'T6',
    },
    radialDrilling: { enabled: false },
    millingAf: { enabled: false },
    millingPocket: { enabled: false },
    threading: { enabled: false },
    cutoff: { enabled: false },
  },
};

const plan = buildCamPlan(input);
assert.equal(plan.executable, true, JSON.stringify(plan.errors));
assert.deepEqual(clampZoneForInput(plan.input), { zMin: -5, zMax: 0, boundaryZ: -5 });
assert.equal(plan.input.setup.clampDiameter, 60);
assert.equal(plan.input.setup.visualMirror, true);

const exposed = exposedTurningProfile(plan.input.contour, plan.input);
assert.equal(exposed[0].z, -5);
assert.equal(exposed[0].x, 60);
assert.ok(exposed.some(point => point.z === -5 && point.x === 57), 'radial transition at clamp boundary is preserved');
assert.ok(exposed.at(-1).z === -30, 'profile ends at the free end');

const turningCuts = plan.turning.moves.filter(move => move.cutting && move.cutKind === 'turn');
assert.ok(turningCuts.length > 0);
assert.ok(turningCuts.every(move => move.from.z <= -5 + 1e-9 && move.to.z <= -5 + 1e-9), 'no turning cut enters protected clamp zone');
assert.equal(turningCuts[0].to.z, -5, 'cycle starts at clamp boundary');
const axialContourMoves = turningCuts.filter(move => move.role === 'rough_cut' || move.role === 'finish_cut');
assert.ok(axialContourMoves.some(move => move.to.z < move.from.z), 'canonical Z motion proceeds from clamp boundary toward free end');

const finalState = simulateMaterial(plan, 1);
const clampSlices = materialProfile(finalState).filter(slice => slice.z >= -5 - 1e-9 && slice.z <= 0 + 1e-9);
assert.ok(clampSlices.length > 0);
assert.ok(clampSlices.every(slice => Math.abs(slice.radius - 30) < 1e-6 || (Math.abs(slice.z + 5) < 1e-6 && slice.radius <= 30)), 'Ø60 clamp section remains unmachined');

assert.equal(plan.drilling.hole.startZ, -30, 'axial drill enters from free right end in mirrored setup');
assert.equal(plan.drilling.hole.direction, 1);
assert.equal(plan.drilling.hole.entrySide, 'free_right');
const firstDrillCut = plan.drilling.moves.find(move => move.cutting);
assert.deepEqual(firstDrillCut.from, { x: 0, z: -30 });
assert.deepEqual(firstDrillCut.to, { x: 0, z: -26 });

assert.ok(plan.warnings.some(item => item.code === 'CLAMP_ZONE_PROTECTED'));
assert.ok(plan.warnings.some(item => item.code === 'DRILL_FROM_FREE_END'));

console.log(JSON.stringify({
  passed: 12,
  clampZone: plan.turning.parameters.clampZone,
  firstTurningCut: turningCuts[0],
  drillEntry: plan.drilling.hole,
}, null, 2));
