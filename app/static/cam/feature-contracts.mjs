import { CAM_STATUS, finiteNumber, issue } from './contracts.mjs';

const EPS = 1e-6;

function enabled(value) {
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function parseMetricDesignation(value = '') {
  const match = String(value).replace(',', '.').match(/M\s*(\d+(?:\.\d+)?)(?:\s*[xх×]\s*(\d+(?:\.\d+)?))?/i);
  return match ? { nominalDiameter: Number(match[1]), pitch: match[2] ? Number(match[2]) : null } : null;
}

export function diameterAtZ(contour, z) {
  if (!Array.isArray(contour) || !contour.length) return null;
  if (z >= contour[0].z) return contour[0].x;
  if (z <= contour.at(-1).z) return contour.at(-1).x;
  for (let index = 0; index < contour.length - 1; index += 1) {
    const a = contour[index];
    const b = contour[index + 1];
    if (z <= a.z + EPS && z >= b.z - EPS) {
      if (Math.abs(b.z - a.z) < EPS) return Math.min(a.x, b.x);
      const t = (z - a.z) / (b.z - a.z);
      return a.x + (b.x - a.x) * t;
    }
  }
  return null;
}

function normalizeThread(raw = {}, input) {
  const parsed = parseMetricDesignation(raw.designation || '');
  const length = finiteNumber(raw.length, null);
  const zEnd = finiteNumber(raw.zEnd, input.blankLength > 0 ? -input.blankLength : null);
  const zStart = finiteNumber(raw.zStart, Number.isFinite(zEnd) && length > 0 ? zEnd + length : null);
  const nominalDiameter = finiteNumber(raw.nominalDiameter, parsed?.nominalDiameter ?? null);
  const pitch = finiteNumber(raw.pitch, parsed?.pitch ?? null);
  const computedMinor = nominalDiameter > 0 && pitch > 0 ? nominalDiameter - 1.226869 * pitch : null;
  return {
    enabled: enabled(raw.enabled),
    standard: 'ISO_METRIC_EXTERNAL_60',
    designation: String(raw.designation || ''),
    nominalDiameter,
    pitch,
    length,
    zStart,
    zEnd,
    majorDiameter: finiteNumber(raw.majorDiameter, nominalDiameter),
    minorDiameter: finiteNumber(raw.minorDiameter, computedMinor),
    maxInfeedRadial: finiteNumber(raw.maxInfeedRadial, 0.22),
    springPasses: Math.max(0, Math.round(finiteNumber(raw.springPasses, 1))),
    rpm: finiteNumber(raw.rpm, 350),
    runIn: finiteNumber(raw.runIn, Math.max(1.5, pitch || 0)),
    runOut: finiteNumber(raw.runOut, Math.max(1.5, pitch || 0)),
    toolId: String(raw.toolId || 'T3'),
  };
}

function normalizeDrilling(raw = {}) {
  return {
    enabled: enabled(raw.enabled),
    orientation: String(raw.orientation || 'axial').toLowerCase(),
    diameter: finiteNumber(raw.diameter, null),
    depth: finiteNumber(raw.depth, null),
    startZ: finiteNumber(raw.startZ, 0),
    peckDepth: finiteNumber(raw.peckDepth, null),
    retractZ: finiteNumber(raw.retractZ, 2),
    chipClearance: finiteNumber(raw.chipClearance, 0.5),
    tipAngle: finiteNumber(raw.tipAngle, 118),
    rpm: finiteNumber(raw.rpm, 800),
    feedRate: finiteNumber(raw.feedRate, 90),
    toolId: String(raw.toolId || 'T5'),
    shankDiameter: finiteNumber(raw.shankDiameter, finiteNumber(raw.diameter, null)),
    fluteLength: finiteNumber(raw.fluteLength, finiteNumber(raw.depth, null)),
    radialZ: finiteNumber(raw.radialZ, null),
    cAngle: finiteNumber(raw.cAngle, 0),
  };
}

function normalizeAf(raw = {}) {
  const length = finiteNumber(raw.length, null);
  const zStart = finiteNumber(raw.zStart, 0);
  const zEnd = finiteNumber(raw.zEnd, Number.isFinite(zStart) && length > 0 ? zStart - length : null);
  return {
    enabled: enabled(raw.enabled),
    mode: 'C_INDEXED_XZ',
    widthAcrossFlats: finiteNumber(raw.widthAcrossFlats, null),
    sides: Math.round(finiteNumber(raw.sides, 6)),
    length,
    zStart,
    zEnd,
    sourceDiameter: finiteNumber(raw.sourceDiameter, null),
    toolDiameter: finiteNumber(raw.toolDiameter, 8),
    radialStepDown: finiteNumber(raw.radialStepDown, 1),
    axialLead: finiteNumber(raw.axialLead, 1.5),
    radialClearance: finiteNumber(raw.radialClearance, 2),
    cOffset: finiteNumber(raw.cOffset, 0),
    rpm: finiteNumber(raw.rpm, 2200),
    feedRate: finiteNumber(raw.feedRate, 240),
    toolId: String(raw.toolId || 'T4'),
  };
}

function normalizeCutoff(raw = {}, input) {
  const defaultZ = input.blankLength > 0 ? -input.blankLength : null;
  return {
    enabled: enabled(raw.enabled),
    zPosition: finiteNumber(raw.zPosition, defaultZ),
    bladeWidth: finiteNumber(raw.bladeWidth, null),
    finalDiameter: finiteNumber(raw.finalDiameter, null),
    sourceDiameter: finiteNumber(raw.sourceDiameter, null),
    radialClearance: finiteNumber(raw.radialClearance, 2),
    axialClearance: finiteNumber(raw.axialClearance, 2),
    rpm: finiteNumber(raw.rpm, null),
    feedPerRev: finiteNumber(raw.feedPerRev, null),
    safetyConfirmed: enabled(raw.safetyConfirmed),
    toolId: String(raw.toolId || 'T7'),
  };
}

function normalizeEnvelope(raw = {}, defaults = {}) {
  return {
    radius: finiteNumber(raw.radius, defaults.radius),
    cuttingReach: finiteNumber(raw.cuttingReach, defaults.cuttingReach),
    gaugeLength: finiteNumber(raw.gaugeLength, defaults.gaugeLength),
  };
}

function normalizeMachine(raw = {}, input) {
  const limits = raw.limits || {};
  const chuck = raw.chuck || {};
  return {
    confirmed: enabled(raw.confirmed),
    source: String(raw.source || 'USER_REQUIRED'),
    clearance: finiteNumber(raw.clearance, 1),
    limits: {
      xMin: finiteNumber(limits.xMin, 0),
      xMax: finiteNumber(limits.xMax, null),
      zMin: finiteNumber(limits.zMin, null),
      zMax: finiteNumber(limits.zMax, null),
      yMin: finiteNumber(limits.yMin, 0),
      yMax: finiteNumber(limits.yMax, 0),
      cMin: finiteNumber(limits.cMin, -360000),
      cMax: finiteNumber(limits.cMax, 360000),
    },
    chuck: {
      frontZ: finiteNumber(chuck.frontZ, input.blankLength > 0 ? -input.blankLength - 3 : null),
      backZ: finiteNumber(chuck.backZ, input.blankLength > 0 ? -input.blankLength - 80 : null),
      outerDiameter: finiteNumber(chuck.outerDiameter, null),
      jawDiameter: finiteNumber(chuck.jawDiameter, finiteNumber(chuck.outerDiameter, null)),
    },
    restrictedZones: Array.isArray(raw.restrictedZones) ? raw.restrictedZones.map((zone, index) => ({
      id: String(zone.id || `zone-${index + 1}`),
      name: String(zone.name || `Ограниченная зона ${index + 1}`),
      xMin: finiteNumber(zone.xMin, null), xMax: finiteNumber(zone.xMax, null),
      yMin: finiteNumber(zone.yMin, null), yMax: finiteNumber(zone.yMax, null),
      zMin: finiteNumber(zone.zMin, null), zMax: finiteNumber(zone.zMax, null),
    })) : [],
    envelopes: {
      turning: normalizeEnvelope(raw.envelopes?.turning, { radius: null, cuttingReach: null, gaugeLength: null }),
      threading: normalizeEnvelope(raw.envelopes?.threading, { radius: null, cuttingReach: null, gaugeLength: null }),
      drilling: normalizeEnvelope(raw.envelopes?.drilling, { radius: null, cuttingReach: null, gaugeLength: null }),
      millingAf: normalizeEnvelope(raw.envelopes?.millingAf, { radius: null, cuttingReach: null, gaugeLength: null }),
      cutoff: normalizeEnvelope(raw.envelopes?.cutoff, { radius: null, cuttingReach: null, gaugeLength: null }),
    },
  };
}

function normalizePost(raw = {}) {
  const sanitize = value => String(value || '').trim().replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24);
  return {
    confirmed: enabled(raw.confirmed),
    programName: sanitize(raw.programName || 'PAC_PRO_PART') || 'PAC_PRO_PART',
    workOffset: sanitize(raw.workOffset || 'G54') || 'G54',
    cAxisClamp: String(raw.cAxisClamp || '').trim(),
    cAxisUnclamp: String(raw.cAxisUnclamp || '').trim(),
    liveToolOn: String(raw.liveToolOn || '').trim(),
    liveToolOff: String(raw.liveToolOff || '').trim(),
    coolantOn: String(raw.coolantOn || 'M8').trim(),
    coolantOff: String(raw.coolantOff || 'M9').trim(),
    safeParkX: finiteNumber(raw.safeParkX, null),
    safeParkZ: finiteNumber(raw.safeParkZ, null),
  };
}

export function normalizeFeatureContracts(raw = {}, input) {
  const features = raw.features || raw.camFeatures || {};
  const machineRaw = raw.machineSetup || features.machineSetup || {};
  const postRaw = raw.postprocessor || features.postprocessor || {};
  return {
    threading: normalizeThread(features.threading || features.thread || {}, input),
    drilling: normalizeDrilling(features.drilling || {}, input),
    millingAf: normalizeAf(features.millingAf || features.af || {}),
    cutoff: normalizeCutoff(features.cutoff || features.parting || {}, input),
    machineSetup: normalizeMachine(machineRaw, input),
    postprocessor: normalizePost(postRaw),
  };
}

export function validateMachineSetup(machine) {
  const errors = [];
  if (!machine.confirmed) errors.push(issue('MACHINE_SETUP_UNCONFIRMED', 'Размеры патрона, зоны станка и инструментальные оболочки должны быть подтверждены пользователем.', 'error', 'collision'));
  const required = [
    ['X_MAX_REQUIRED', machine.limits.xMax, 'Не задан максимальный ход X.'],
    ['Z_MIN_REQUIRED', machine.limits.zMin, 'Не задан минимальный ход Z.'],
    ['Z_MAX_REQUIRED', machine.limits.zMax, 'Не задан максимальный ход Z.'],
    ['CHUCK_DIAMETER_REQUIRED', machine.chuck.outerDiameter, 'Не задан наружный диаметр патрона.'],
    ['CHUCK_FRONT_REQUIRED', machine.chuck.frontZ, 'Не задан Z передней плоскости патрона.'],
  ];
  for (const [code, value, message] of required) if (!Number.isFinite(value)) errors.push(issue(code, message, 'error', 'collision'));
  for (const [kind, envelope] of Object.entries(machine.envelopes)) {
    for (const property of ['radius', 'cuttingReach', 'gaugeLength']) {
      if (!(envelope[property] >= 0)) errors.push(issue('TOOL_ENVELOPE_REQUIRED', `Для ${kind} не задан параметр оболочки ${property}.`, 'error', 'collision'));
    }
  }
  if (Number.isFinite(machine.chuck.frontZ) && Number.isFinite(machine.chuck.backZ) && machine.chuck.backZ >= machine.chuck.frontZ) {
    errors.push(issue('CHUCK_Z_RANGE_INVALID', 'Задняя плоскость патрона должна иметь Z меньше передней.', 'error', 'collision'));
  }
  return { status: errors.length ? CAM_STATUS.BLOCKED : CAM_STATUS.SUPPORTED, errors };
}
