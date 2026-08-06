// Runs slicing off the main thread (non-blocking UI) plus stage-30 layer streaming.
// Vite module worker: new Worker(new URL('./slicer.worker.js', import.meta.url), { type: 'module' }).
// SINGLE_FILE means the wasm is inlined into slicer_core.js -> no external fetch from the worker either.
//
// Stage 30 (OOM tolerance): set_layer_sink lets the kernel emit layers as it produces them; each is transferred to main
//  immediately (Float32Array buffers moved -> the worker copy is released at once) and the kernel frees that layer buffer
//  from the heap. The resident result (the full gw.s + the full layersArr) disappears, so the WASM heap peak drops sharply
//  -> large models avoid OOM. The final 'done' carries stats only.
//  In economy mode (params.economy) only G-code chunks are emitted, without toolpaths (finishes without a preview).
//  The MM / real-PE paths fall back to batch mode.
// Automatic multithreaded kernel selection: with crossOriginIsolated (sites serving COOP/COEP) it uses mt (-pthread, PASS1
//  layers in parallel — measured 2.2x), otherwise st (zero-config). The dynamic import makes bundlers emit both as chunks,
//  but only one is loaded at runtime. On mt init failure (SAB blocked, …) it falls back to st.
const loadCore = async () => {
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
  if (isolated) {
    try {
      const M = await (await import('./slicer_core.mt.js')).default()
      console.info('[slicer.worker] core: mt (threads)')
      return M
    } catch (e) { console.warn('[slicer.worker] mt load failed — falling back to st:', e) }
  }
  const M = await (await import('./slicer_core.js')).default()
  console.info('[slicer.worker] core: st')
  return M
}

let modPromise = null

self.onmessage = async (e) => {
  const d = e.data
  try {
    if (!modPromise) modPromise = loadCore()
    const Module = await modPromise
    // Warmup: only load the kernel (+ spawn the mt pthread pool) ahead of time — removes the perceived load on the first slice
    if (d.cmd === 'warmup') { self.postMessage({ type: 'warm' }); return }
    // Stage 20: manual support painting — selector state persists in this worker Module (slicing uses the same Module).
    if (d.cmd === 'prepare') { Module.selector_prepare(new Uint8Array(d.stl)); self.postMessage({ type: 'prepared', facets: Module.selector_facet_count() }); return }
    if (d.cmd === 'paint')   { Module.selector_paint(d.facet, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius, d.enforcer);
                               self.postMessage({ type: 'painted', enf: Module.selector_painted_count(true), blk: Module.selector_painted_count(false) }); return }
    if (d.cmd === 'clear')   { Module.selector_clear(); self.postMessage({ type: 'painted', enf: 0, blk: 0 }); return }
    if (d.cmd === 'overlay')  { self.postMessage({ type: 'overlay', enf: Array.from(Module.selector_overlay(true)), blk: Array.from(Module.selector_overlay(false)) }); return }

    if (d.stall) return   // stage-30 test hook: simulate a hang -> verifies the main-thread watchdog fires (not set in production)
    // mt (SAB): share the address of the real support progress counter (u32) with main once — even while the kernel is
    //  blocked inside C++, the UI thread polls the SAB directly to show support progress. st (non-shared buffer) is unsupported -> not sent.
    if (!self.__supSabSent) {
      self.__supSabSent = true
      try {
        // Module.HEAPU8 is not exposed by the emscripten 6.x glue — obtain the buffer via embind typed_memory_view
        const v = Module.sup_progress_view && Module.sup_progress_view()
        const c = Module.cancel_flag_view && Module.cancel_flag_view()
        if (v && v.buffer instanceof SharedArrayBuffer)
          self.postMessage({ type: 'supsab', buf: v.buffer, ptr: v.byteOffset, cancelPtr: c ? c.byteOffset : 0 })
      } catch {}
    }
    // Default: slice. Register the layer sink -> the kernel calls back per layer (z, idx, gcodeChunk, pathsF32, widthsF32).
    //  Each layer is transferred to main immediately (toolpath buffers moved) -> the worker copy is freed -> heap headroom before the next layer.
    const onProgress = (done, total) => self.postMessage({ type: 'progress', done, total })
    Module.set_layer_sink((z, idx, gcode, paths, widths) => {
      const transfer = []
      if (paths && paths.buffer) transfer.push(paths.buffer)     // economy mode yields empty arrays (no .buffer) -> nothing to transfer
      if (widths && widths.buffer) transfer.push(widths.buffer)
      self.postMessage({ type: 'layer', z, idx, gcode, paths, widths }, transfer)
    })
    let r
    try { r = Module.slice(new Uint8Array(d.stl), d.params, onProgress) }
    finally { Module.clear_layer_sink() }
    if (r && r.error) { self.postMessage({ type: 'error', error: String(r.error) }); return }
    // streamed=true -> g-code/layers were already emitted as 'layer' (result holds stats only). batch/MM keep them in result.
    self.postMessage({ type: 'done', result: r })
  } catch (err) {
    // Includes the WASM abort("memory access out of bounds") — the main thread's OOM ladder decides on re-creation / economy retry.
    self.postMessage({ type: 'error', error: String((err && err.message) || err) })
  }
}
