export type MachineMode = 'turning' | 'drilling' | 'milling';
export type MotionMode = 'rapid' | 'feed';
export interface AxisState { x:number; z:number; y:number; c:number; }
export interface StockSettings { diameter:number; length:number; }
