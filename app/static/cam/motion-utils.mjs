const EPS = 1e-9;

export function machinePoint(point = {}) {
  const result = {};
  for (const axis of ['x', 'z', 'y', 'c']) {
    const value = Number(point[axis]);
    if (Number.isFinite(value)) result[axis] = value;
  }
  return result;
}

export function linearDistance(from = {}, to = {}) {
  const dx = ((Number(to.x) || 0) - (Number(from.x) || 0)) / 2;
  const dy = (Number(to.y) || 0) - (Number(from.y) || 0);
  const dz = (Number(to.z) || 0) - (Number(from.z) || 0);
  return Math.hypot(dx, dy, dz);
}

export function appendMove(target, operationId, motion, role, from, to, options = {}) {
  const move = {
    id: `move-${target.length + 1}`,
    operationId,
    motion,
    role,
    cutting: Boolean(options.cutting),
    cutKind: options.cutKind || null,
    from: machinePoint(from),
    to: machinePoint(to),
    feedRate: Number(options.feedRate) || null,
    passIndex: options.passIndex ?? null,
  };
  for (const [key, value] of Object.entries(options)) {
    if (!(key in move)) move[key] = value;
  }
  target.push(move);
  return move;
}

export function scheduleMoves(moves, settings = {}) {
  const rapidRate = Number(settings.rapidRate) || 6000;
  const cAxisRate = Number(settings.cAxisRate) || 1800;
  let totalMinutes = 0;
  for (const move of moves) {
    let duration;
    if (move.motion === 'index') {
      duration = Math.abs((Number(move.to.c) || 0) - (Number(move.from.c) || 0)) / cAxisRate;
    } else if (move.motion === 'dwell') {
      duration = Math.max(0, Number(move.dwellSeconds) || 0) / 60;
    } else {
      const rate = move.motion === 'rapid' ? rapidRate : Math.max(1, Number(move.feedRate) || 120);
      duration = linearDistance(move.from, move.to) / rate;
    }
    move.durationMinutes = Math.max(duration, 0.00001);
    totalMinutes += move.durationMinutes;
  }
  let elapsed = 0;
  for (const move of moves) {
    move.startProgress = totalMinutes > EPS ? elapsed / totalMinutes : 0;
    elapsed += move.durationMinutes;
    move.endProgress = totalMinutes > EPS ? elapsed / totalMinutes : 1;
  }
  return totalMinutes;
}

export function interpolateMove(move, progress) {
  if (!move) return null;
  const denominator = Math.max(EPS, move.endProgress - move.startProgress);
  const local = Math.max(0, Math.min(1, (progress - move.startProgress) / denominator));
  const point = {};
  for (const axis of ['x', 'z', 'y', 'c']) {
    const from = Number(move.from?.[axis]);
    const to = Number(move.to?.[axis]);
    if (Number.isFinite(from) || Number.isFinite(to)) {
      const a = Number.isFinite(from) ? from : to;
      const b = Number.isFinite(to) ? to : from;
      point[axis] = a + (b - a) * local;
    }
  }
  return { ...point, local };
}

export function activeMoveAt(moves, progress) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  return moves.find(move => p <= move.endProgress + EPS) || moves.at(-1) || null;
}
