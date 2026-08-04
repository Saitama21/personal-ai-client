const EPS = 1e-7;

function moveFraction(move, progress) {
  if (progress >= move.endProgress) return 1;
  if (progress <= move.startProgress) return 0;
  return (progress - move.startProgress) / Math.max(EPS, move.endProgress - move.startProgress);
}
function samplesBetween(zStart, zEnd, count = 72, initialValue = 0) {
  if (!Number.isFinite(zStart) || !Number.isFinite(zEnd) || !(zStart > zEnd)) return [];
  return Array.from({ length: count + 1 }, (_, index) => ({ z: zStart + (zEnd - zStart) * index / count, value: initialValue }));
}
function wrapPi(angle) {
  let value = angle % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  if (value < -Math.PI) value += Math.PI * 2;
  return value;
}

export function createFeatureMaterialModel(plan) {
  const drilling = plan.drilling?.status === 'SUPPORTED' ? { diameter: plan.drilling.hole.diameter, targetDepth: plan.drilling.hole.depth, startZ: plan.drilling.hole.startZ, direction: plan.drilling.hole.direction || -1, entrySide: plan.drilling.hole.entrySide || 'z0', tipAngle: plan.drilling.hole.tipAngle } : null;
  const radialDrilling = plan.radialDrilling?.status === 'SUPPORTED' ? plan.radialDrilling.holes.map(hole => ({ ...hole, currentDepth: 0 })) : [];
  const thread = plan.threading?.status === 'SUPPORTED' ? { ...plan.threading.helix, depthSamples: samplesBetween(plan.threading.helix.zStart, plan.threading.helix.zEnd, 96, 0), targetDepth: plan.threading.parameters.radialDepth } : null;
  const af = plan.millingAf?.status === 'SUPPORTED' ? {
    zStart: plan.millingAf.feature.zStart, zEnd: plan.millingAf.feature.zEnd, sides: plan.millingAf.feature.sides, cOffset: plan.millingAf.feature.cOffset,
    sourceRadius: plan.millingAf.parameters.sourceRadius, targetDistance: plan.millingAf.parameters.finalDistance,
    slices: samplesBetween(plan.millingAf.feature.zStart, plan.millingAf.feature.zEnd, 64, null).map(sample => ({ z: sample.z, faceDistances: Array(plan.millingAf.feature.sides).fill(plan.millingAf.parameters.sourceRadius) })),
  } : null;
  const pockets = plan.millingPocket?.status === 'SUPPORTED' ? Array.from({ length: plan.millingPocket.feature.count }, (_, index) => ({
    type: plan.millingPocket.feature.type, placement: plan.millingPocket.feature.placement, length: plan.millingPocket.feature.length, width: plan.millingPocket.feature.width,
    targetDepth: plan.millingPocket.feature.depth, currentDepth: 0, zStart: plan.millingPocket.feature.zStart, zEnd: plan.millingPocket.feature.zEnd,
    xCenter: plan.millingPocket.feature.xCenter, yCenter: plan.millingPocket.feature.yCenter,
    cAngle: plan.millingPocket.feature.cAngle + plan.millingPocket.feature.angularStep * index,
  })) : [];
  return { drilling, radialDrilling, thread, af, pockets };
}

export function simulateFeatureMaterial(plan, progress) {
  const model = plan.featureMaterialModel || createFeatureMaterialModel(plan);
  const state = {
    drilling: model.drilling ? { ...model.drilling, currentDepth: 0 } : null,
    radialDrilling: (model.radialDrilling || []).map(item => ({ ...item, currentDepth: 0 })),
    thread: model.thread ? { ...model.thread, depthSamples: model.thread.depthSamples.map(sample => ({ ...sample })) } : null,
    af: model.af ? { ...model.af, slices: model.af.slices.map(slice => ({ z: slice.z, faceDistances: [...slice.faceDistances] })) } : null,
    pockets: (model.pockets || []).map(item => ({ ...item, currentDepth: 0 })),
  };
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  for (const move of plan.moves || []) {
    const fraction = moveFraction(move, p);
    if (fraction <= 0) break;
    if (move.cutting && move.cutKind === 'drill_axial' && state.drilling) {
      const currentZ = move.from.z + (move.to.z - move.from.z) * fraction;
      state.drilling.currentDepth = Math.max(state.drilling.currentDepth, (currentZ - state.drilling.startZ) * (state.drilling.direction || -1));
    }
    if (move.cutting && move.cutKind === 'drill_radial' && state.radialDrilling[move.holeIndex]) {
      const depth = (move.drilledDepth || 0) * fraction + (move.passIndex > 1 ? Math.max(0, (move.passIndex - 1) * (plan.radialDrilling.feature.peckDepth || 0)) * (1 - fraction) : 0);
      state.radialDrilling[move.holeIndex].currentDepth = Math.max(state.radialDrilling[move.holeIndex].currentDepth, Math.min(move.drilledDepth || depth, depth));
    }
    if (move.cutting && move.cutKind === 'thread_external' && state.thread) {
      const currentZ = move.from.z + (move.to.z - move.from.z) * fraction;
      for (const sample of state.thread.depthSamples) if (sample.z <= state.thread.zStart + EPS && sample.z >= currentZ - EPS) sample.value = Math.max(sample.value, move.targetThreadDepth || 0);
    }
    if (move.cutting && move.cutKind === 'mill_af' && state.af) {
      const zA = move.from.z, zB = move.from.z + (move.to.z - move.from.z) * fraction;
      const hi = Math.max(zA, zB), lo = Math.min(zA, zB);
      for (const slice of state.af.slices) if (slice.z <= hi + EPS && slice.z >= lo - EPS) slice.faceDistances[move.faceIndex] = Math.min(slice.faceDistances[move.faceIndex], move.surfaceDistance);
    }
    if (move.cutting && (move.cutKind === 'mill_pocket' || move.cutKind === 'mill_face_pocket') && state.pockets[move.copyIndex]) {
      state.pockets[move.copyIndex].currentDepth = Math.max(state.pockets[move.copyIndex].currentDepth, (move.depthReached || 0) * fraction);
    }
    if (fraction < 1) break;
  }
  if (state.drilling) state.drilling.currentDepth = Math.min(state.drilling.targetDepth, state.drilling.currentDepth);
  state.radialDrilling.forEach(hole => { hole.currentDepth = Math.min(hole.depth, hole.currentDepth); });
  state.pockets.forEach(pocket => { pocket.currentDepth = Math.min(pocket.targetDepth, pocket.currentDepth); });
  return state;
}

function interpolateSamples(samples, z, accessor) {
  if (!samples?.length) return 0;
  if (z >= samples[0].z) return accessor(samples[0]);
  if (z <= samples.at(-1).z) return accessor(samples.at(-1));
  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index], b = samples[index + 1];
    if (z <= a.z && z >= b.z) { const t = (z - a.z) / (b.z - a.z || 1); return accessor(a) + (accessor(b) - accessor(a)) * t; }
  }
  return 0;
}
export function threadDepthAt(state, z) {
  if (!state?.thread || z > state.thread.zStart + EPS || z < state.thread.zEnd - EPS) return 0;
  return interpolateSamples(state.thread.depthSamples, z, sample => sample.value);
}
export function afFaceDistancesAt(state, z) {
  if (!state?.af || z > state.af.zStart + EPS || z < state.af.zEnd - EPS) return null;
  return Array.from({ length: state.af.sides }, (_, face) => interpolateSamples(state.af.slices, z, slice => slice.faceDistances[face]));
}

function radialFeatureContains(feature, z, angle, outerRadius) {
  const normal = feature.cAngle * Math.PI / 180;
  const tangential = wrapPi(angle - normal) * outerRadius;
  if (feature.diameter) {
    const dz = z - feature.z;
    return dz * dz + tangential * tangential <= (feature.diameter / 2) ** 2 + EPS;
  }
  const zCenter = (feature.zStart + feature.zEnd) / 2;
  return Math.abs(z - zCenter) <= feature.length / 2 + EPS && Math.abs(tangential) <= feature.width / 2 + EPS;
}

export function radialBoundaryAt(state, z, angle, outerRadius) {
  let radius = outerRadius;
  const threadDepth = threadDepthAt(state, z);
  if (threadDepth > EPS && state.thread) {
    const phase = angle - Math.PI * 2 * (state.thread.zStart - z) / state.thread.pitch;
    const groove = Math.max(0, 1 - Math.abs(wrapPi(phase)) / Math.PI);
    radius = Math.min(radius, outerRadius - threadDepth * groove);
  }
  const faceDistances = afFaceDistancesAt(state, z);
  if (faceDistances && state.af) {
    for (let face = 0; face < state.af.sides; face += 1) {
      const normal = (state.af.cOffset + 360 * face / state.af.sides) * Math.PI / 180;
      const cosine = Math.cos(angle - normal);
      if (cosine > EPS) radius = Math.min(radius, faceDistances[face] / cosine);
    }
  }
  for (const hole of state?.radialDrilling || []) if (hole.currentDepth > EPS && radialFeatureContains(hole, z, angle, outerRadius)) radius = Math.min(radius, Math.max(0.01, outerRadius - hole.currentDepth));
  for (const pocket of state?.pockets || []) if (pocket.placement === 'radial' && pocket.currentDepth > EPS && radialFeatureContains(pocket, z, angle, outerRadius)) radius = Math.min(radius, Math.max(0.01, outerRadius - pocket.currentDepth));
  return Math.max(0.01, radius);
}

export function featureRemovedVolume(plan, state, outerRadiusAtZ) {
  let volume = 0;
  if (state.drilling) volume += Math.PI * (state.drilling.diameter / 2) ** 2 * state.drilling.currentDepth;
  for (const hole of state.radialDrilling || []) volume += Math.PI * (hole.diameter / 2) ** 2 * hole.currentDepth;
  for (const pocket of state.pockets || []) volume += pocket.length * pocket.width * pocket.currentDepth;
  const sections = [];
  if (state.thread) sections.push([state.thread.zStart, state.thread.zEnd]);
  if (state.af) sections.push([state.af.zStart, state.af.zEnd]);
  if (sections.length) {
    const zStart = Math.max(...sections.map(section => section[0])), zEnd = Math.min(...sections.map(section => section[1]));
    const zSteps = 72, angleSteps = 144;
    for (let zi = 0; zi < zSteps; zi += 1) {
      const z = zStart + (zEnd - zStart) * (zi + 0.5) / zSteps, outer = outerRadiusAtZ(z);
      let removedArea = 0;
      for (let ai = 0; ai < angleSteps; ai += 1) {
        const angle = Math.PI * 2 * (ai + 0.5) / angleSteps, radius = radialBoundaryAt({ ...state, radialDrilling: [], pockets: [] }, z, angle, outer);
        removedArea += 0.5 * (outer * outer - radius * radius) * (Math.PI * 2 / angleSteps);
      }
      volume += removedArea * Math.abs(zEnd - zStart) / zSteps;
    }
  }
  return Math.max(0, volume);
}
