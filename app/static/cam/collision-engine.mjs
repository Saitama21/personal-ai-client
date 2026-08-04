import { CAM_STATUS, issue } from './contracts.mjs';
import { validateMachineSetup } from './feature-contracts.mjs';
import { interpolateMove, linearDistance } from './motion-utils.mjs';

const EPS = 1e-6;

function outerRadiusAt(plan, z) {
  const contour = plan.input.contour;
  if (!contour.length) return plan.input.blankDiameter / 2;
  if (z >= contour[0].z) return contour[0].x / 2;
  if (z <= contour.at(-1).z) return contour.at(-1).x / 2;
  for (let index = 0; index < contour.length - 1; index += 1) {
    const a = contour[index];
    const b = contour[index + 1];
    if (z <= a.z + EPS && z >= b.z - EPS) {
      if (Math.abs(b.z - a.z) < EPS) return Math.min(a.x, b.x) / 2;
      const t = (z - a.z) / (b.z - a.z);
      return (a.x + (b.x - a.x) * t) / 2;
    }
  }
  return plan.input.blankDiameter / 2;
}

function envelopeFor(machine, move) {
  return machine.envelopes[move.toolKind] || machine.envelopes.turning;
}

function inRange(value, min, max, margin = 0) {
  if (!Number.isFinite(value)) return false;
  if (Number.isFinite(min) && value < min - margin) return false;
  if (Number.isFinite(max) && value > max + margin) return false;
  return true;
}

function pointInExpandedZone(point, zone, radius) {
  return inRange(point.x, zone.xMin, zone.xMax, radius * 2)
    && inRange(point.y || 0, zone.yMin, zone.yMax, radius)
    && inRange(point.z, zone.zMin, zone.zMax, radius);
}

function sampleMove(move, resolution = 1) {
  const linear = linearDistance(move.from, move.to);
  const cDelta = Math.abs((move.to.c || 0) - (move.from.c || 0));
  const count = Math.max(2, Math.min(240, Math.ceil(Math.max(linear / resolution, cDelta / 5)) + 1));
  return Array.from({ length: count }, (_, index) => {
    const local = index / (count - 1);
    const pseudoProgress = move.startProgress + (move.endProgress - move.startProgress) * local;
    return { ...interpolateMove(move, pseudoProgress), local };
  });
}

function collisionRecord(code, bodyA, bodyB, move, point, message) {
  return {
    code, bodyA, bodyB, moveId: move.id, operationId: move.operationId, role: move.role,
    point: { x: point.x ?? null, y: point.y ?? 0, z: point.z ?? null, c: point.c ?? null },
    message,
  };
}

export class BoundedCollisionProvider {
  evaluate(context = {}) {
    const plan = context.plan;
    const machine = context.machineSetup;
    const setupValidation = validateMachineSetup(machine);
    if (setupValidation.errors.length) {
      return {
        status: CAM_STATUS.BLOCKED, safe: false, provider: 'BoundedCollisionProvider',
        model: 'CK52PT_Y_CONFIGURED_ENVELOPES_V2', checkedBodies: [], collisions: [],
        errors: setupValidation.errors, samplesChecked: 0,
        message: 'Коллизионная проверка заблокирована: конфигурация станка не подтверждена.',
      };
    }
    const collisions = [];
    const trace = [];
    let samplesChecked = 0;
    const clearance = Math.max(0, machine.clearance || 0);
    const chuckRadius = Math.max(machine.chuck.outerDiameter, machine.chuck.jawDiameter || 0) / 2;
    for (const move of plan.moves) {
      const envelope = envelopeFor(machine, move);
      const samples = sampleMove(move, Math.max(0.4, clearance || 1));
      for (const point of samples) {
        samplesChecked += 1;
        const radial = Math.hypot((point.x || 0) / 2, point.y || 0);
        const holderCenterRadius = radial + Math.max(0, envelope.cuttingReach || 0);
        const holderRadius = Math.max(0, envelope.radius || 0) + clearance;
        if (!inRange(point.x, machine.limits.xMin, machine.limits.xMax)
          || !inRange(point.z, machine.limits.zMin, machine.limits.zMax)
          || !inRange(point.y || 0, machine.limits.yMin, machine.limits.yMax)) {
          collisions.push(collisionRecord('AXIS_LIMIT', 'tool_tip', 'machine_limits', move, point, 'Точка траектории выходит за подтверждённые пределы осей.'));
          break;
        }
        if (Number.isFinite(point.c) && !inRange(point.c, machine.limits.cMin, machine.limits.cMax)) {
          collisions.push(collisionRecord('C_AXIS_LIMIT', 'indexed_spindle', 'c_axis_limits', move, point, 'Индексация C выходит за подтверждённый диапазон.'));
          break;
        }
        const inChuckZ = point.z <= machine.chuck.frontZ + clearance && point.z >= machine.chuck.backZ - clearance;
        if (inChuckZ && radial <= chuckRadius + clearance) {
          collisions.push(collisionRecord('TOOL_CHUCK', 'tool_tip', 'chuck', move, point, 'Точка инструмента входит в оболочку патрона/кулачков.'));
          break;
        }
        if (inChuckZ && holderCenterRadius - holderRadius <= chuckRadius) {
          collisions.push(collisionRecord('HOLDER_CHUCK', 'tool_holder', 'chuck', move, point, 'Оболочка державки пересекает оболочку патрона/кулачков.'));
          break;
        }
        const insidePartZ = point.z <= EPS && point.z >= -plan.input.blankLength - EPS;
        const outwardRetraction = /(?:radial_retract|drill_safe_retract)/.test(move.role)
          && (move.to.x || 0) >= (move.from.x || 0) && Math.abs((move.to.z || 0) - (move.from.z || 0)) < EPS;
        const rapidInsideClearedHole = /(?:drill_return_to_peck|drill_chip_retract|radial_drill_return_to_peck|radial_drill_chip_retract|pocket_radial_retract|face_pocket_axial_retract)/.test(move.role);
        if (move.motion === 'rapid' && insidePartZ && radial < outerRadiusAt(plan, point.z) - clearance && !rapidInsideClearedHole && !outwardRetraction) {
          collisions.push(collisionRecord('RAPID_STOCK', 'tool_tip', 'stock', move, point, 'Быстрое перемещение входит в оболочку заготовки.'));
          break;
        }
        const liveCuttingTool = ['drilling','radialDrilling','millingAf','millingPocket'].includes(move.toolKind);
        if (insidePartZ && point.z < -clearance && holderCenterRadius - holderRadius < outerRadiusAt(plan, point.z) && !liveCuttingTool) {
          collisions.push(collisionRecord('HOLDER_STOCK', 'tool_holder', 'stock', move, point, 'Оболочка державки пересекает наружную оболочку детали.'));
          break;
        }
        for (const zone of machine.restrictedZones) {
          if (pointInExpandedZone({ ...point, x: holderCenterRadius * 2 }, zone, holderRadius)) {
            collisions.push(collisionRecord('HOLDER_RESTRICTED_ZONE', 'tool_holder', zone.id, move, point, `Державка входит в ограниченную зону «${zone.name}».`));
            break;
          }
        }
        if (collisions.at(-1)?.moveId === move.id) break;
      }
      trace.push({ moveId: move.id, operationId: move.operationId, samples: samples.length, result: collisions.at(-1)?.moveId === move.id ? 'COLLISION' : 'CLEAR' });
    }
    const unique = [];
    const keys = new Set();
    for (const collision of collisions) {
      const key = `${collision.code}:${collision.moveId}`;
      if (!keys.has(key)) { keys.add(key); unique.push(collision); }
    }
    return {
      status: unique.length ? CAM_STATUS.BLOCKED : CAM_STATUS.EVALUATED_LIMITED,
      safe: unique.length === 0,
      provider: 'BoundedCollisionProvider', model: 'CK52PT_Y_CONFIGURED_ENVELOPES_V2',
      checkedBodies: ['stock', 'chuck', 'jaws_envelope', 'tool_tip', 'tool_holder', 'axis_limits', ...machine.restrictedZones.map(zone => zone.id)],
      collisions: unique, errors: unique.map(item => issue(item.code, item.message, 'error', 'collision')),
      samplesChecked, trace,
      assumptions: [
        'Проверка выполняется по подтверждённым пользователем ограничивающим оболочкам, а не по полной CAD-модели станка.',
        'Гибкость, биение, стружка, зажимные силы и динамика приводов не моделируются.',
      ],
      message: unique.length ? `Обнаружено коллизий: ${unique.length}. Экспорт заблокирован.` : `Проверено ${samplesChecked} положений по ограничивающим оболочкам; пересечений не обнаружено.`,
    };
  }
}
