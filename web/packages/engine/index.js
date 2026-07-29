// @three-slicer/engine — browser/WASM 3D-slicing SDK (reverse-engineered from OrcaSlicer).
// Public API. Node-safe (imports only the pure-JS WASM factory; no JSON so it loads in plain Node ESM).
// Schema-driven helpers (deriveKernelParams etc.) live in the "@three-slicer/engine/settings" subpath because
// they import JSON — use them in a bundler (vite) or with Node JSON import attributes.
import createModule from './src/slicer_core.js'

const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b))

// Off-main-thread worker URL for the browser: `new Worker(engineWorkerURL(), { type: 'module' })`.
// The worker speaks the 30단계 streaming protocol ({type:'layer'|'done'|'error'|'progress'}).
export const engineWorkerURL = () => new URL('./src/slicer.worker.js', import.meta.url)

// createSlicer(): load the WASM kernel and return a handle. Works in Node and the browser main thread.
//  slice(stl, params, { onProgress, onLayer }):
//    - stl: ArrayBuffer|Uint8Array (binary STL)
//    - params: kernel-params object OR JSON string (see web/GUIDE.md; use deriveKernelParams to build from UI settings)
//    - onProgress(done,total): per-layer progress
//    - onLayer({z,idx,gcode,paths,widths}): 30단계 streaming — emits + frees each layer; when set, the
//      returned result carries stats only (assemble gcode/layers from the callbacks). When omitted, the
//      result carries the whole { gcode, stats, layers }.
//  paintPrepare/paint/paintClear/overlay: manual support enforcer/blocker painting (TriangleSelector).
//  heapSize(): current WASM heap bytes (peak, monotonic). module: escape hatch. dispose(): drop the module.
export async function createSlicer() {
  const M = await createModule()
  return {
    slice(stl, params, { onProgress, onLayer } = {}) {
      const p = typeof params === 'string' ? params : JSON.stringify(params || {})
      if (onLayer) M.set_layer_sink((z, idx, gcode, paths, widths) => onLayer({ z, idx, gcode, paths, widths }))
      try { return M.slice(u8(stl), p, onProgress || (() => {})) }
      finally { if (onLayer) M.clear_layer_sink() }
    },
    paintPrepare(stl) { M.selector_prepare(u8(stl)); return M.selector_facet_count() },
    paint(a) {
      M.selector_paint(a.facet, a.hx, a.hy, a.hz, a.cx, a.cy, a.cz, a.radius, a.enforcer)
      return { enf: M.selector_painted_count(true), blk: M.selector_painted_count(false) }
    },
    paintClear() { M.selector_clear() },
    overlay(enforcer) { return Array.from(M.selector_overlay(!!enforcer)) },
    heapSize() { return M.heap_size() },
    module: M,
    dispose() { /* emscripten module is GC'd when dropped; no explicit teardown required */ },
  }
}

export default createSlicer
