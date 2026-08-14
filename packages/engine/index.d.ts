// Type definitions for three-slicer (engine entry point)
export type { SlicerSettings, SettingKey, Point } from '../types/settings-keys.d.ts'

export interface SliceLayer { z: number; idx: number; gcode: string; paths: Float32Array; widths: Float32Array }
export interface SliceCallbacks {
  onProgress?: (done: number, total: number) => void
  onLayer?: (layer: SliceLayer) => void
}
/** The estimator's machine limits, as they were actually applied (`stats.machine_limits`). */
export interface SliceMachineLimits {
  max_speed_xy: number; max_speed_z: number; max_speed_e: number
  max_accel_xy: number; max_accel_z: number; max_accel_e: number
  jerk_xy: number; jerk_z: number; jerk_e: number
  accel_print: number; accel_travel: number; accel_retract: number
}

export interface SliceStats {
  /** Emitted layers, raft included — the length of `result.layers` */
  layers: number
  /** Layers belonging to the model itself */
  model_layers: number
  raft_layers: number
  path_segments: number
  /** Filament consumed, mm of input filament */
  filament_mm: number
  /** Wall-crossing travels — the cross-check for `reduce_crossing_wall` */
  wall_crossings: number

  /** Seconds. `0` in economy mode, which skips the estimate */
  time_estimate: number
  first_layer_time: number
  time_extrude: number
  time_travel: number
  /** Filament total the estimator parsed back out of the G-code — compare against `filament_mm` */
  time_filament_mm: number
  time_moves: number
  /** Seconds per layer index */
  layer_times: Record<string, number>
  /** Seconds per extrusion role, keyed by the role number (the low nibble of `paths[k+3]`) */
  role_times: Record<string, number>
  /** Which estimator ran: the ported GCodeProcessor, the transcription, or neither */
  time_engine: 'full' | 'transcribed' | 'fallback' | string
  machine_limits: SliceMachineLimits

  /** True when anything printed leaves the bed — support, skirt, brim and raft included */
  over_bed: boolean
  /** True when the MODEL itself is off the bed, not just what was printed around it */
  over_bed_model: boolean
  /** How far past the bed the toolpaths reach, mm. `0` = inside */
  over_bed_x: number; over_bed_y: number
  /** Emitted top layer past `printable_height`, mm */
  over_bed_z: number

  /** True when G-code and layers were delivered through `onLayer` and are NOT on the result */
  streamed: boolean
  /** True when it finished in economy mode: no preview toolpaths and no time estimate */
  economy: boolean

  // ---- multi-material only (absent from a single-material slice) ----
  /** Indexed by tool number; sums to `filament_mm` */
  filament_mm_by_tool?: number[]
  /** The prime/wipe tower's share — already counted inside the per-tool figures above */
  filament_mm_purge?: number
  filament_mm_purge_by_tool?: number[]

  // ---- phase timings, present when the kernel was built with them ----
  t_pass1_ms?: number; t_surface_ms?: number; t_support_ms?: number; t_emit_ms?: number
  /** The JS boundary's share during emit */
  t_flush_ms?: number

  [k: string]: unknown
}

export interface SliceResult {
  /** Absent when `onLayer` was set — assemble it from the callback instead */
  gcode?: string
  stats: SliceStats
  /** Absent when `onLayer` was set */
  layers?: unknown[]
  /** Set instead of a result when the slice failed or was cancelled (`'canceled'`) */
  error?: string
}
export interface PaintArgs {
  facet: number; hx: number; hy: number; hz: number;
  cx: number; cy: number; cz: number; radius: number; enforcer: boolean
}
export interface Slicer {
  slice(stl: ArrayBuffer | Uint8Array, params: object | string, cb?: SliceCallbacks): SliceResult
  paintPrepare(stl: ArrayBuffer | Uint8Array): number
  paint(args: PaintArgs): { enf: number; blk: number }
  paintClear(): void
  /** The painted overlay triangles for one state, as the kernel's own detached copy. */
  overlay(enforcer: boolean): Float32Array
  heapSize(): number
  module: unknown
  dispose(): void
}
export function createSlicer(): Promise<Slicer>
export function engineWorkerURL(): URL
export default createSlicer
