// Type definitions for three-slicer (engine entry point)
export type { SlicerSettings, SettingKey, Point } from '../types/settings-keys.d.ts'

export interface SliceLayer { z: number; idx: number; gcode: string; paths: Float32Array; widths: Float32Array }
export interface SliceCallbacks {
  onProgress?: (done: number, total: number) => void
  onLayer?: (layer: SliceLayer) => void
}
export interface SliceStats {
  layers: number; model_layers: number; raft_layers: number;
  path_segments: number; filament_mm: number; time_estimate: number;
  streamed?: boolean; economy?: boolean; [k: string]: unknown
}
export interface SliceResult { gcode?: string; stats: SliceStats; layers?: unknown[]; error?: string }
export interface PaintArgs {
  facet: number; hx: number; hy: number; hz: number;
  cx: number; cy: number; cz: number; radius: number; enforcer: boolean
}
export interface Slicer {
  slice(stl: ArrayBuffer | Uint8Array, params: object | string, cb?: SliceCallbacks): SliceResult
  paintPrepare(stl: ArrayBuffer | Uint8Array): number
  paint(args: PaintArgs): { enf: number; blk: number }
  paintClear(): void
  overlay(enforcer: boolean): number[]
  heapSize(): number
  module: unknown
  dispose(): void
}
export function createSlicer(): Promise<Slicer>
export function engineWorkerURL(): URL
export default createSlicer
