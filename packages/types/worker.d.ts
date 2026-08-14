// three-slicer/worker — the slice worker script. Not a module you import, but the target of
// `new Worker(new URL('three-slicer/worker', import.meta.url), { type: 'module' })`.
//
// The protocol below is the raw message contract. `createSlicerClient()` from `three-slicer/client` wraps it in
// promises and is the easier way in; these types are here for hosts driving the worker directly, and because the
// shape has traps that only a written-down contract makes visible — see the slice request and `erase`.
import type { SliceResult } from '../engine/index.d.ts'

/** Brush geometry shared by paint and erase: the hit facet, the hit point, the camera, the radius. */
export interface BrushArgs {
  facet: number
  hx: number; hy: number; hz: number
  cx: number; cy: number; cz: number
  radius: number
}

/**
 * Painting state, following OrcaSlicer's own `EnforcerBlockerType`: one enum serving two jobs.
 * `1` is both the support ENFORCER and Extruder 1, `2` is both the BLOCKER and Extruder 2, `3..16` are
 * Extruders 3 to 16. `0` (NONE) is deliberately not a value here — see the `erase` command.
 */
export type PaintState = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16

/** Selection tools that are not the radius brush. All three take the mesh's own topology instead of a radius. */
export type PaintTool = 'smart' | 'bucket' | 'triangle'

export type SlicerRequest =
  /** Load the kernel (and spawn the mt thread pool) ahead of the first slice. Reply: `warm`. */
  | { cmd: 'warmup' }
  /**
   * Register a mesh for painting. `keepPaint` says this is the same model in a new place, so the marks carry
   * over — the reply reports whether they actually did. Reply: `prepared`.
   */
  | { cmd: 'prepare'; stl: ArrayBuffer; keepPaint?: boolean }
  /**
   * Paint. With `state` it addresses any extruder; with `enforcer` it stays on the original boolean pair, where
   * `false` means BLOCKER. `states` asks for those states' counts back. Reply: `painted`.
   */
  | (BrushArgs & { cmd: 'paint'; state?: PaintState; enforcer?: boolean; tool?: PaintTool
                   angle?: number; cursor?: 'sphere' | 'circle'; states?: PaintState[] })
  /**
   * Return the brushed facets to the default extruder. Its OWN command rather than `{cmd:'paint', state:0}`:
   * embind coerces a JS `false` to the int `0` == NONE, and the legacy blocker brush sends exactly that `false`,
   * so admitting `0` on the state path would let a stray boolean erase silently. Reply: `painted`.
   */
  | (BrushArgs & { cmd: 'erase'; tool?: PaintTool; angle?: number; states?: PaintState[] })
  /**
   * Load painting out of a 3mf. REPLACES every mark (the kernel's deserialize resets first), so it belongs
   * immediately after a `prepare` and nowhere else. Reply: `painted`, with `applied`.
   */
  | { cmd: 'importPaint'; facets: Int32Array | number[]; hex: string; states?: PaintState[] }
  /** Every marked facet's split tree, in the CURRENT selector's numbering. Reply: `paintExport`. */
  | { cmd: 'exportPaint' }
  /** Wipe every state at once. Reply: `painted`, all zero. */
  | { cmd: 'clear'; states?: PaintState[] }
  /** The painted overlay triangles. `enf`/`blk` always; `states` adds those states. Reply: `overlay`. */
  | { cmd: 'overlay'; states?: PaintState[] }
  /**
   * Slice — and note it carries **no `cmd`**: slicing is the worker's default action, and leaving the field off
   * is what selects it. `params` must be a JSON **string**; the worker hands it straight to the kernel, which
   * parses JSON text. (`createSlicer().slice()` on the direct handle also accepts an object and stringifies it.)
   * Replies: `progress` and `layer` while it runs, then `done` — or `error`.
   */
  | { stl: ArrayBuffer; params: string }

export type SlicerResponse =
  | { type: 'warm' }
  | { type: 'prepared'; facets: number; kept: boolean }
  /**
   * `enf`/`blk` are the counts for states 1 and 2 and are always present, so a listener predating the
   * state-addressed protocol keeps working. `counts` appears only when the request named `states`.
   */
  | { type: 'painted'; enf: number; blk: number; counts?: Record<number, number>; applied?: number }
  /** `supported: false` from a kernel built before the export binding existed — it does not throw. */
  | { type: 'paintExport'; supported: boolean; facets: number[]; hex: string }
  | { type: 'overlay'; enf: Float32Array; blk: Float32Array; overlays?: Record<number, Float32Array> }
  /**
   * Sent once, unprompted, by the multithreaded kernel only: the address of the support-progress counter and of
   * the cancel flag, inside a SharedArrayBuffer. Writing 1 to the cancel flag stops a slice the worker is
   * currently blocked inside. A single-threaded kernel has no shared buffer and never sends this.
   */
  | { type: 'supsab'; buf: SharedArrayBuffer; ptr: number; cancelPtr: number }
  | { type: 'progress'; done: number; total: number }
  /** One sliced layer, its typed arrays transferred rather than copied. */
  | { type: 'layer'; z: number; idx: number; gcode: string; paths: Float32Array; widths: Float32Array }
  /** `result.stats.streamed` says whether the G-code came through `layer` messages or is on the result. */
  | { type: 'done'; result: SliceResult }
  | { type: 'error'; error: string }

export {}
