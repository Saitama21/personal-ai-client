const EPS = 1e-7;

function interpolate(a, b, t) {
  return a + (b - a) * t;
}

export function sampleContour(contour, stepMm = 0.35) {
  if (!Array.isArray(contour) || contour.length < 2) return [];
  const result = [];
  for (let index = 0; index < contour.length - 1; index += 1) {
    const a = contour[index];
    const b = contour[index + 1];
    if (!result.length) result.push({ z: a.z, radius: a.x / 2 });
    const dz = b.z - a.z;
    const count = Math.max(1, Math.ceil(Math.abs(dz) / stepMm));
    for (let part = 1; part <= count; part += 1) {
      const t = part / count;
      result.push({ z: interpolate(a.z, b.z, t), radius: interpolate(a.x, b.x, t) / 2 });
    }
  }
  return result;
}

export function createMaterialModel({ blankDiameter, contour, axialAllowance = 0, sampleStep = 0.35 }) {
  const stockRadius = blankDiameter / 2;
  const target = sampleContour(contour, sampleStep);
  const odSlices = target.map(point => ({ z: point.z, radius: stockRadius, targetRadius: point.radius }));
  return {
    stockRadius,
    axialAllowance,
    faceRadius: axialAllowance > EPS ? stockRadius : 0,
    odSlices,
    target,
  };
}

export function cloneMaterialState(model) {
  return {
    stockRadius: model.stockRadius,
    axialAllowance: model.axialAllowance,
    faceRadius: model.faceRadius,
    odSlices: model.odSlices.map(slice => ({ ...slice })),
    target: model.target.map(slice => ({ ...slice })),
  };
}

function applyFaceMove(state, from, to, fraction) {
  if (state.axialAllowance <= EPS) return;
  const currentX = interpolate(from.x, to.x, fraction);
  state.faceRadius = Math.min(state.faceRadius, Math.max(0, currentX / 2));
}

function applyTurningMove(state, from, to, fraction) {
  const end = {
    x: interpolate(from.x, to.x, fraction),
    z: interpolate(from.z, to.z, fraction),
  };
  const zMin = Math.min(from.z, end.z) - EPS;
  const zMax = Math.max(from.z, end.z) + EPS;
  const dz = end.z - from.z;
  for (const slice of state.odSlices) {
    if (slice.z < zMin || slice.z > zMax) continue;
    const t = Math.abs(dz) <= EPS ? 1 : (slice.z - from.z) / dz;
    const cutRadius = interpolate(from.x, end.x, Math.max(0, Math.min(1, t))) / 2;
    slice.radius = Math.max(slice.targetRadius, Math.min(slice.radius, cutRadius));
  }
}

function applyCutoffMove(state, move, fraction, feature = {}) {
  const currentDiameter = interpolate(move.from.x, move.to.x, fraction);
  const cutRadius = Math.max(0, currentDiameter / 2);
  const zPosition = Number(feature.zPosition ?? move.zPosition ?? move.to.z);
  const bladeWidth = Math.max(0, Number(feature.bladeWidth ?? move.bladeWidth) || 0);
  const halfWidth = bladeWidth / 2 + EPS;
  for (const slice of state.odSlices) {
    if (Math.abs(slice.z - zPosition) > halfWidth) continue;
    slice.radius = Math.min(slice.radius, cutRadius);
  }
}

function moveFraction(move, progress) {
  if (progress >= move.endProgress) return 1;
  if (progress <= move.startProgress) return 0;
  return (progress - move.startProgress) / Math.max(EPS, move.endProgress - move.startProgress);
}

export function simulateMaterial(plan, progress) {
  const state = cloneMaterialState(plan.materialModel);
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  for (const move of plan.moves) {
    const fraction = moveFraction(move, clamped);
    if (fraction <= 0) break;
    if (move.cutting && move.cutKind === 'face') applyFaceMove(state, move.from, move.to, fraction);
    if (move.cutting && move.cutKind === 'turn') applyTurningMove(state, move.from, move.to, fraction);
    if (move.cutting && move.cutKind === 'cutoff') applyCutoffMove(state, move, fraction, plan.features?.cutoff);
    if (fraction < 1) break;
  }
  return state;
}

export function materialProfile(state) {
  const profile = [];
  if (state.axialAllowance > EPS) {
    profile.push({ z: state.axialAllowance, radius: state.faceRadius });
    profile.push({ z: 0, radius: state.faceRadius });
  }
  for (const slice of state.odSlices) profile.push({ z: slice.z, radius: slice.radius });
  return profile;
}

export function targetProfile(model) {
  const profile = [];
  if (model.axialAllowance > EPS) {
    profile.push({ z: model.axialAllowance, radius: 0 });
    profile.push({ z: 0, radius: 0 });
  }
  return profile.concat(model.target.map(point => ({ ...point })));
}

export function materialVolume(state) {
  let volume = 0;
  for (let index = 0; index < state.odSlices.length - 1; index += 1) {
    const a = state.odSlices[index];
    const b = state.odSlices[index + 1];
    const dz = Math.abs(b.z - a.z);
    volume += Math.PI * ((a.radius * a.radius) + (b.radius * b.radius)) * 0.5 * dz;
  }
  if (state.axialAllowance > EPS) volume += Math.PI * state.faceRadius * state.faceRadius * state.axialAllowance;
  return volume;
}
