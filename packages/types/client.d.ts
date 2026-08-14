// three-slicer/client — promise wrapper over the worker protocol in three-slicer/worker.
import type { SliceLayer, SliceResult } from '../engine/index.d.ts'
import type { BrushArgs, PaintState, PaintTool } from './worker.d.ts'

export type { BrushArgs, PaintState, PaintTool }

export interface ClientSliceCallbacks {
  onProgress?: (done: number, total: number) => void
  /** Takes the layers yourself. With it set, the result carries stats only and nothing is buffered here. */
  onLayer?: (layer: SliceLayer) => void
}

/** Painted facet counts. `counts` is present only when the call named states. */
export interface PaintCounts {
  /** State 1 — the support enforcer, and Extruder 1 */
  enforcer: number
  /** State 2 — the support blocker, and Extruder 2 */
  blocker: number
  counts?: Record<number, number>
  /** Facets an importPaint actually applied */
  applied?: number
}

export interface PaintOverlays {
  enforcer: Float32Array
  blocker: Float32Array
  overlays?: Record<number, Float32Array>
}

export interface SlicerClient {
  /** The worker being driven — for a host that also wants to listen in. */
  worker: Worker

  /** Load the kernel ahead of the first slice. */
  warmup(): Promise<void>

  /** `params` may be an object; it is stringified for you, which the raw protocol does not do. */
  slice(stl: ArrayBuffer | Uint8Array, params: object | string, cb?: ClientSliceCallbacks): Promise<SliceResult>

  /** Register a mesh for painting. `keepPaint` carries existing marks across a move; `kept` says whether they survived. */
  prepare(stl: ArrayBuffer | Uint8Array, opts?: { keepPaint?: boolean }): Promise<{ facets: number; kept: boolean }>

  paint(args: BrushArgs & {
    state?: PaintState; enforcer?: boolean; tool?: PaintTool
    angle?: number; cursor?: 'sphere' | 'circle'; states?: PaintState[]
  }): Promise<PaintCounts>

  /** Back to the default extruder. A separate call, not `paint` with state 0 — see three-slicer/worker. */
  erase(args: BrushArgs & { tool?: PaintTool; angle?: number; states?: PaintState[] }): Promise<PaintCounts>

  clear(states?: PaintState[]): Promise<PaintCounts>
  overlay(states?: PaintState[]): Promise<PaintOverlays>

  /** Load a 3mf's painting. Replaces every mark, so run it directly after `prepare`. */
  importPaint(facets: Int32Array | number[], hex: string, states?: PaintState[]): Promise<PaintCounts>
  exportPaint(): Promise<{ supported: boolean; facets: number[]; hex: string }>

  /**
   * Stop the running slice. Works while the worker is blocked in WASM, but the flag lives in a SharedArrayBuffer,
   * so it exists only on the multithreaded kernel — a cross-origin-isolated page. Returns false when there is no
   * flag to write; terminate the worker instead.
   */
  cancel(): boolean

  /** Kill the worker and reject everything still in flight. */
  terminate(): void
}

/**
 * @param worker an existing worker to drive. Omitted, one is created — browser only, since Node has no global
 *   `Worker`; in Node use `createSlicer()` from the root entry instead.
 */
export function createSlicerClient(worker?: Worker): SlicerClient
export default createSlicerClient
