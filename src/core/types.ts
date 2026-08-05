export type MachineMode = 'turning' | 'drilling' | 'milling';
export type MotionMode = 'rapid' | 'feed';
export type CameraView = 'iso' | 'front' | 'top' | 'sinumerik';
export interface AxisState { x:number; z:number; y:number; c:number; }
export interface StockSettings { diameter:number; length:number; }
export interface MachineLimits { x:[number,number]; z:[number,number]; y:[number,number]; c:[number,number]; }
