import { CAM_STATUS } from './contracts.mjs';

export class KinematicsProvider {
  describe() {
    throw new Error('KinematicsProvider.describe() must be implemented');
  }

  toMachinePoint(point) {
    throw new Error(`KinematicsProvider.toMachinePoint() is not implemented for ${JSON.stringify(point)}`);
  }
}

export class LatheXZKinematics extends KinematicsProvider {
  describe() {
    return {
      status: CAM_STATUS.SUPPORTED,
      axes: { X: CAM_STATUS.SUPPORTED, Z: CAM_STATUS.SUPPORTED, C: CAM_STATUS.NOT_IMPLEMENTED, Y: CAM_STATUS.NOT_IMPLEMENTED },
      xMode: 'diameter',
      zZero: 'right_face',
    };
  }

  toMachinePoint(point) {
    return { X: Number(point.x), Z: Number(point.z) };
  }
}

export class CollisionProvider {
  evaluate(_context) {
    throw new Error('CollisionProvider.evaluate() must be implemented');
  }
}

export class InterfaceOnlyCollisionProvider extends CollisionProvider {
  evaluate(context = {}) {
    return {
      status: CAM_STATUS.NOT_EVALUATED,
      provider: 'InterfaceOnlyCollisionProvider',
      checkedBodies: [],
      collisions: [],
      message: 'Коллизии не вычислялись. Требуется геометрия станка, патрона, державки и инструмента.',
      contextVersion: context.schemaVersion || null,
    };
  }
}

export class MillingPlannerProvider {
  plan(_context) {
    return {
      status: CAM_STATUS.NOT_IMPLEMENTED,
      operations: [],
      message: 'Фрезерный планировщик не подключён. C/Y/AF операции исключены из исполнения.',
    };
  }
}
