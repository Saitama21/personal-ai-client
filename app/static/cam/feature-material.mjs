const EPS = 1e-7;

function moveFraction(move, progress) {
  if (progress >= move.endProgress) return 1;
  if (progress <= move.startProgress) return 0;
  return (progress - move.startProgress) / Math.max(EPS, move.endProgress - move.startProgress);
}

function samplesBetween(zStart, zEnd, count = 72, initialValue = 0) {
  if (!Number.isFinite(zStart) || !Number.isFinite(zEnd) || !(zStart > zEnd)) return [];
  return Array.from({ length: count + 1 }, (_, index) => ({
    z: zStart + (zEnd - zStart) * index / count,
    value: initialValue,
  }));
}

export function createFeatureMaterialModel(plan) {
  const drilling = plan.drilling?.status === 'SUPPORTED' ? {
    diameter: plan.drilling.hole.diameter,
    targetDepth: plan.drilling.hole.depth,
    startZ: plan.drilling.hole.startZ,
    tipAngle: plan.drilling.hole.tipAngle,
  } : null;
  const thread = plan.threading?.status === 'SUPPORTED' ? {
    ...plan.threading.helix,
    depthSamples: samplesBetween(plan.threading.helix.zStart, plan.threading.helix.zEnd, 96, 0),
    targetDepth: plan.threading.parameters.radialDepth,
  } : null;
  const af = plan.millingAf?.status === 'SUPPORTED' ? {
    zStart: plan.millingAf.feature.zStart,
    zEnd: plan.millingAf.feature.zEnd,
    sides: plan.millingAf.feature.sides,
    cOffset: plan.millingAf.feature.cOffset,
    sourceRadius: plan.millingAf.parameters.sourceRadius,
    targetDistance: plan.millingAf.parameters.finalDistance,
    slices: samplesBetween(plan.millingAf.feature.zStart, plan.millingAf.feature.zEnd, 64, null).map(sample => ({
      z: sample.z,
      faceDistances: Array(plan.millingAf.feature.sides).fill(plan.millingAf.parameters.sourceRadius),
    })),
  } : null;
  return { drilling, thread, af };
}

export function simulateFeatureMaterial(plan, progress) {
  const model = plan.featureMaterialModel || createFeatureMaterialModel(plan);
  const state = {
    drilling: model.drilling ? { ...model.drilling, currentDepth: 0 } : null,
    thread: model.thread ? { ...model.thread, depthSamples: model.thread.depthSamples.map(sample => ({ ...sample })) } : null,
    af: model.af ? { ...model.af, slices: model.af.slices.map(slice => ({ z: slice.z, faceDistances: [...slice.faceDistances] })) } : null,
  };
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  for (const move of plan.moves || []) {
    const fraction = moveFraction(move, p);
    if (fraction <= 0) break;
    if (move.cutting && move.cutKind === 'drill_axial' && state.drilling) {
      const currentZ = move.from.z + (move.to.z - move.from.z) * fraction;
      state.drilling.currentDepth = Math.max(state.drilling.currentDepth, state.drilling.startZ - currentZ);
    }
    if (move.cutting && move.cutKind === 'thread_external' && state.thread) {
      const currentZ = move.from.z + (move.to.z - move.from.z) * fraction;
      for (const sample of state.thread.depthSamples) {
        if (sample.z <= state.thread.zStart + EPS && sample.z >= currentZ - EPS) {
          sample.value = Math.max(sample.value, move.targetThreadDepth || 0);
        }
      }
    }
    if (move.cutting && move.cutKind === 'mill_af' && state.af) {
      const currentZ = move.from.z + (move.to.z - move.from.z) * fraction;
      for (const slice of state.af.slices) {
        if (slice.z <= state.af.zStart + EPS && slice.z >= currentZ - EPS) {
          slice.faceDistances[move.faceIndex] = Math.min(slice.faceDistances[move.faceIndex], move.surfaceDistance);
        }
      }
    }
    if (fraction < 1) break;
  }
  if (state.drilling) state.drilling.currentDepth = Math.min(state.drilling.targetDepth, state.drilling.currentDepth);
  return state;
}

function interpolateSamples(samples, z, accessor) {
  if (!samples?.length) return 0;
  if (z >= samples[0].z) return accessor(samples[0]);
  if (z <= samples.at(-1).z) return accessor(samples.at(-1));
  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index];
    const b = samples[index + 1];
    if (z <= a.z && z >= b.z) {
      const t = (z - a.z) / (b.z - a.z || 1);
      return accessor(a) + (accessor(b) - accessor(a)) * t;
    }
  }
  return 0;
}

export function threadDepthAt(state, z) {
  if (!state?.thread || z > state.thread.zStart + EPS || z < state.thread.zEnd - EPS) return 0;
  return interpolateSamples(state.thread.depthSamples, z, sample => sample.value);
}

export function afFaceDistancesAt(state, z) {
  if (!state?.af || z > state.af.zStart + EPS || z < state.af.zEnd - EPS) return null;
  const distances = [];
  for (let face = 0; face < state.af.sides; face += 1) {
    distances.push(interpolateSamples(state.af.slices, z, slice => slice.faceDistances[face]));
  }
  return distances;
}

function wrapPi(angle) {
  let value = angle % (Math.PI * 2);
  if (value > Math.PI) value -= Math.PI * 2;
  if (value < -Math.PI) value += Math.PI * 2;
  return value;
}

export function radialBoundaryAt(state, z, angle, outerRadius) {
  let radius = outerRadius;
  const threadDepth = threadDepthAt(state, z);
  if (threadDepth > EPS && state.thread) {
    const helixPhase = angle - Math.PI * 2 * (state.thread.zStart - z) / state.thread.pitch;
    const triangularGroove = Math.max(0, 1 - Math.abs(wrapPi(helixPhase)) / Math.PI);
    radius = Math.min(radius, outerRadius - threadDepth * triangularGroove);
  }
  const faceDistances = afFaceDistancesAt(state, z);
  if (faceDistances && state.af) {
    for (let face = 0; face < state.af.sides; face += 1) {
      const normal = (state.af.cOffset + 360 * face / state.af.sides) * Math.PI / 180;
      const cosine = Math.cos(angle - normal);
      if (cosine > EPS) radius = Math.min(radius, faceDistances[face] / cosine);
    }
  }
  return Math.max(0.01, radius);
}

export function featureRemovedVolume(plan, state, outerRadiusAtZ) {
  let volume = 0;
  if (state.drilling) {
    const radius = state.drilling.diameter / 2;
    volume += Math.PI * radius * radius * state.drilling.currentDepth;
  }
  const sections = [];
  if (state.thread) sections.push([state.thread.zStart, state.thread.zEnd]);
  if (state.af) sections.push([state.af.zStart, state.af.zEnd]);
  if (sections.length) {
    const zStart = Math.max(...sections.map(section => section[0]));
    const zEnd = Math.min(...sections.map(section => section[1]));
    const zSteps = 72;
    const angleSteps = 144;
    for (let zi = 0; zi < zSteps; zi += 1) {
      const z = zStart + (zEnd - zStart) * (zi + 0.5) / zSteps;
      const outer = outerRadiusAtZ(z);
      let removedArea = 0;
      for (let ai = 0; ai < angleSteps; ai += 1) {
        const angle = Math.PI * 2 * (ai + 0.5) / angleSteps;
        const radius = radialBoundaryAt(state, z, angle, outer);
        removedArea += 0.5 * (outer * outer - radius * radius) * (Math.PI * 2 / angleSteps);
      }
      volume += removedArea * Math.abs(zEnd - zStart) / zSteps;
    }
  }
  return Math.max(0, volume);
}
