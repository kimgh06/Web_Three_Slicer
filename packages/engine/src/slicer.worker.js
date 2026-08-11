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

// Stage 20 painting states = upstream's EnforcerBlockerType (see packages/wasm-core/selector_bridge.h):
//  0=NONE, 1=ENFORCER(==Extruder1), 2=BLOCKER(==Extruder2), 3..16=Extruder3..Extruder16.
// The kernel exposes both a boolean pair (selector_paint/…_count/…_overlay) and integer-state twins (…_state);
//  the boolean wrappers are NOT redundant, they are what maps false -> BLOCKER(2) on the C++ side.
const PAINT_STATE_ENFORCER = 1
const PAINT_STATE_BLOCKER = 2
const PAINT_STATE_MAX = 16

// A state is only a state when it is literally an integer in [1,16]. This predicate is the hazard guard: embind
//  coerces a JS `false` to the int 0 == NONE, so a boolean that leaked into the state path would paint nothing and
//  silently turn blocker painting into a no-op. `Number.isInteger(false)` is false, so a boolean can never pass here
//  and never reaches the *_state entry points — it stays on the boolean binding that means BLOCKER.
const isPaintState = (value) => Number.isInteger(value) && value >= PAINT_STATE_ENFORCER && value <= PAINT_STATE_MAX

// Stands in for an overlay the request did not ask for. Shared and never transferred (the transfer list drops
//  zero-length buffers), so the one instance stays valid for every reply that needs a placeholder.
const EMPTY_OVERLAY = new Float32Array(0)

// Throws (-> the catch below posts {type:'error'}) rather than clamping: a bad state is a caller bug, and silently
//  substituting one would paint the wrong extruder, which is far harder to notice than an error banner.
const validatedPaintStates = (states) => {
  for (const state of states)
    if (!isPaintState(state)) throw new Error(`paint state must be an integer 1..${PAINT_STATE_MAX} (got ${JSON.stringify(state)})`)
  return states
}

// Which states a message wants reported per-state. null == a legacy message (no `state`/`states` field) -> the reply
//  must stay exactly {enf, blk} / {enf, blk} as it was before the protocol was widened, because the in-app support
//  flow (viewer use_slicer.js) reads those two fields and nothing else.
const reportedPaintStates = (message, paintedState) => {
  if (Array.isArray(message.states)) return validatedPaintStates(message.states)
  return paintedState === null ? null : [paintedState]
}

// The state a paint message asks for: an explicit `state` wins, otherwise null meaning "use the legacy boolean path".
//  Note the check is on presence-and-integerness, never on truthiness — see isPaintState above.
const explicitPaintState = (message) => {
  if (message.state === undefined || message.state === null) return null
  validatedPaintStates([message.state])
  return message.state
}

// Brush cursor shape (selector_bridge.h CURSOR_*). Sent as a name because the message is a protocol a host writes
//  by hand; the integer stays on this side of it. Anything unknown is the sphere the brush has always used.
const cursorShapeOf = (message) => (message.cursor === 'circle' ? 1 : 0)

// The tools that are not the radius brush: upstream's Smart fill and Bucket fill, plus its single-triangle POINTER
//  cursor — which is literally bucket fill with propagation off, so the three share one dispatch. None of them takes
//  a radius or a camera: what they select comes from the mesh's own topology, which is why they are a branch rather
//  than more optional fields on the brush call. `state === null` means erase (the entry points with no state
//  argument), matching how the brush splits paint from erase.
const FILL_TOOLS = new Set(['smart', 'bucket', 'triangle'])
const applyFill = (Module, message, state) => {
  const angle = Number.isFinite(message.angle) ? message.angle : 30
  if (message.tool === 'smart') {
    if (state === null) Module.selector_seed_fill_erase(message.facet, message.hx, message.hy, message.hz, angle)
    else Module.selector_seed_fill(message.facet, message.hx, message.hy, message.hz, angle, state)
    return
  }
  // Upstream passes -1 as the angle when it is not propagating (GLGizmoPainterBase.cpp ~861): with a single facet
  //  there is no neighbour to measure an angle against, and -1 is how that call says "no angle limit".
  const propagate = message.tool === 'bucket'
  const bucketAngle = propagate ? angle : -1
  if (state === null) Module.selector_bucket_fill_erase(message.facet, message.hx, message.hy, message.hz, bucketAngle, propagate)
  else Module.selector_bucket_fill(message.facet, message.hx, message.hy, message.hz, bucketAngle, propagate, state)
}

// paint and erase both mutate the same selector, so both have to re-read every count the caller asked about: an
//  erase over a T3 region lowers T3 exactly the way overpainting it with T2 would, and a reply carrying only the
//  state that was written would leave the other chips showing stale numbers. `enf`/`blk` stay unconditional so a
//  listener predating the per-state map keeps working; `counts` appears only when the message asked for states,
//  which is what keeps a legacy paint reply byte-identical to what it was before the protocol was widened.
const paintedReply = (Module, message, paintedState) => {
  const reply = { type: 'painted', enf: Module.selector_painted_count(true), blk: Module.selector_painted_count(false) }
  const states = reportedPaintStates(message, paintedState)
  if (states) reply.counts = Object.fromEntries(states.map(state => [state, Module.selector_painted_count_state(state)]))
  return reply
}

self.onmessage = async (e) => {
  const d = e.data
  try {
    if (!modPromise) modPromise = loadCore()
    const Module = await modPromise
    // Warmup: only load the kernel (+ spawn the mt pthread pool) ahead of time — removes the perceived load on the first slice
    if (d.cmd === 'warmup') { self.postMessage({ type: 'warm' }); return }
    // Stage 20: manual support painting — selector state persists in this worker Module (slicing uses the same Module).
    // `keepPaint` says the mesh is the same model in a new place, so the marks carry over — the reply reports whether
    //  they actually did, since a face-count change makes the kernel fall back to a clean registration.
    if (d.cmd === 'prepare') {
      const kept = d.keepPaint ? Module.selector_reprepare(new Uint8Array(d.stl)) : (Module.selector_prepare(new Uint8Array(d.stl)), false)
      self.postMessage({ type: 'prepared', facets: Module.selector_facet_count(), kept })
      return
    }
    // paint: legacy {enforcer:boolean} stays on the boolean binding (false == BLOCKER); {state:1..16} reaches any
    //  extruder through the state binding. `enf`/`blk` are always reported so an old listener keeps working, and the
    //  per-state `counts` map is added ONLY when the message asked for states (keeps the legacy reply byte-identical).
    if (d.cmd === 'paint')   {
      const paintedState = explicitPaintState(d)
      if (FILL_TOOLS.has(d.tool)) {
        // The fills are newer than the boolean protocol, so there is no legacy reading to fall back to — a fill
        //  without an explicit integer state is a malformed message, not an enforcer stroke.
        if (paintedState === null) throw new Error(`a '${d.tool}' fill needs an explicit integer state`)
        applyFill(Module, d, paintedState)
      }
      else if (paintedState === null) Module.selector_paint(d.facet, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius, d.enforcer)
      else Module.selector_paint_shape(d.facet, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius, paintedState, cursorShapeOf(d))
      self.postMessage(paintedReply(Module, d, paintedState)); return
    }
    // erase: the brush writes NONE, returning the brushed facets to the default extruder (upstream's shift+drag).
    //  It is its OWN command and NOT `{cmd:'paint', state:0}`, because 0 is the one integer a boolean can become:
    //  embind coerces a JS `false` to 0 == NONE, so widening isPaintState to admit 0 would let a stray boolean on
    //  the state path erase silently — the exact failure that guard was written to stop (see isPaintState above).
    //  A boolean cannot forge the string 'erase', and the kernel binding it reaches takes no state argument at all,
    //  so there is nothing left for a coercion to slip through. The reply is a normal 'painted' one: an erase is a
    //  change to the same counts, and the viewer's listeners must not need to know which brush produced it.
    if (d.cmd === 'erase')   {
      if (FILL_TOOLS.has(d.tool)) applyFill(Module, d, null)
      else Module.selector_erase(d.facet, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius)
      self.postMessage(paintedReply(Module, d, null)); return
    }
    // clear wipes every state at once, so each requested count is 0 by construction — no need to ask the kernel back.
    if (d.cmd === 'clear')   {
      Module.selector_clear()
      const reply = { type: 'painted', enf: 0, blk: 0 }
      const states = reportedPaintStates(d, null)
      if (states) reply.counts = Object.fromEntries(states.map(state => [state, 0]))
      self.postMessage(reply); return
    }
    // overlay: `enf`/`blk` (states 1/2) are always sent because the viewer's overlay rebuild consumes exactly those two;
    //  `overlays` adds the requested states, so an MMU caller can ask for 3..16 without losing the support overlays.
    //  The kernel already hands back a detached Float32Array (bindings.cpp to_f32 does typed_memory_view().slice()),
    //  so the arrays are posted as they are and their buffers TRANSFERRED. The previous Array.from() turned each one
    //  into a plain JS Array, which the structured clone then had to copy element by element — measured at 1.1 ms of
    //  a 3.6 ms stroke sample on a 40k-triangle mesh, and growing with the painted area because the whole overlay is
    //  resent every sample. Transferring costs nothing and the arrays are this worker's own copies, so nothing here
    //  can observe them being neutered.
    if (d.cmd === 'overlay')  {
      const states = reportedPaintStates(d, null)
      // enf/blk stay unconditional for the listener that predates the per-state map. When the request names states,
      //  they are the ONLY ones read, so building the other two would be pure waste on the hot path.
      const wanted = states && !states.includes(PAINT_STATE_ENFORCER) && !states.includes(PAINT_STATE_BLOCKER)
      const reply = { type: 'overlay',
        enf: wanted ? EMPTY_OVERLAY : Module.selector_overlay(true),
        blk: wanted ? EMPTY_OVERLAY : Module.selector_overlay(false) }
      if (states) reply.overlays = Object.fromEntries(states.map(state => [state, Module.selector_overlay_state(state)]))
      const transfer = [reply.enf, reply.blk, ...Object.values(reply.overlays ?? {})]
        .filter(a => a?.buffer && a.byteLength > 0).map(a => a.buffer)
      self.postMessage(reply, transfer); return
    }

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
