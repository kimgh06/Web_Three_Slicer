import { useEffect, useRef } from 'react'
import { deriveKernelParams, settingRaw } from 'three-slicer/settings'
import { makeSlicerWorker } from './make_worker.js'

// Worker lifecycle + progress mapping (SAB polling) + the stage-30 streaming/watchdog/OOM retry ladder.
// A real hook: it owns the refs nobody else touches (SAB view, poll timer, stream accumulator) and the two
//  worker lifetime effects; the refs shared with the other concerns (workerRef, layer range, apiRef, …) come in as deps.
export function useSlicer(deps) {
  const {
    settings, wipeTowerReal, workerRef, apiRef, layersDataRef, layerLoRef, layerHiRef,
    paintStateCountsRef, rebuildToolpaths, rebuildPaintOverlay,
    setProgress, setSlicing, setError, setStats, setOverBed, setLayerCount,
    setLayerLo, setLayerHi, setGcodeUrl, setCanvasMode, setPaintCounts, setSliceNotice,
  } = deps

  const pendingSliceRef = useRef(null)  // promise-based slice (for the sequential all-plates run) + the stage-30 watchdog timer
  const streamAccumRef = useRef(null)   // stage 30: streamed layer accumulator {layers:[{z,paths,widths}], gcode:[chunk]}
  const downgradeRef = useRef(false)    // stage 30: a downgrade (simplified) retry is in progress — buildParams simplifies infill + economy
  const lastGeomRef = useRef(null)      // G003 incremental: geometry digest of the last successful slice (plate-agnostic — a different plate yields a different digest)

  // ---- Progress: time-weighted mapping + real support progress (SAB polling) ----
  //  Measured time share per phase (774k tri): PASS1 7% · surfaces 6% · support 48% · emission 38% -> budget 15/5/40/40.
  const supSabRef = useRef(null)     // { arr: Uint32Array(SAB, ptr, 1) } — shared once by the mt worker
  const supPollRef = useRef(0)
  const stopSupPoll = () => { if (supPollRef.current) { clearInterval(supPollRef.current); supPollRef.current = 0 } }
  // G002: cancel an in-flight slice — written straight into the SAB flag (the kernel loop observes it even while the worker is blocked in wasm)
  const cancelSlice = () => { const sab = supSabRef.current; console.info('[vp-cancel] cancelSlice, hasView=', !!sab?.cancel); if (sab?.cancel) { try { Atomics.store(sab.cancel, 0, 1) } catch { sab.cancel[0] = 1 } } }
  const mapProgress = (done, total) => {
    const N = total > 2 ? (total - 2) / 2 : 0
    if (!N) return total ? done / total : 0
    if (done <= N) return 0.35 * (done / N)          // PASS1: 0 -> 35% (measured 2.8s/7.8s — real progress via SAB polling)
    if (done === N + 1) return 0.36                  // surfaces done -> entering support
    if (done === N + 2) return 0.87                  // support done (measured 4.0s)
    return 0.87 + 0.13 * ((done - N - 2) / N)        // emission: 87 -> 100% (measured 1.1s)
  }
  const startSupPoll = (N) => {
    const sab = supSabRef.current; if (!sab) return
    stopSupPoll()
    // Total work ≈ 3.5xN (measurement-corrected constant) — capped at 95%, then snapped on the completion tick
    supPollRef.current = setInterval(() => {
      const ticks = sab.arr[0]
      setProgress(0.36 + 0.51 * Math.min(0.95, ticks / (3.5 * N)))
    }, 150)
  }
  // Real PASS1 progress (0 -> 35%): the kernel writes per-mille (0..1000) into the SAB counter — starts right after the slice is sent, ends on the first progress message
  const startP1Poll = () => {
    const sab = supSabRef.current; if (!sab) return
    stopSupPoll()
    supPollRef.current = setInterval(() => {
      setProgress(0.35 * Math.min(1, sab.arr[0] / 1000))
    }, 150)
  }
  function getWorker() {
    if (!workerRef.current) {
      const wk = makeSlicerWorker()   // the static worker pattern is isolated in make_worker.js (shipped unbundled, verbatim)
      wk.onmessage = (e) => {
        const d = e.data
        const pnd = pendingSliceRef.current
        if (d.type === 'progress') {   // stage 30: reset the watchdog (+record the phase) + weighted mapping + per-band polling control
          const N = d.total > 2 ? (d.total - 2) / 2 : 0
          if (N && d.done <= N) stopSupPoll()          // first progress = PASS1 done -> stop P1 polling
          if (N && d.done === N + 1) startSupPoll(N)
          if (N && d.done >= N + 2) stopSupPoll()
          setProgress(mapProgress(d.done, d.total)); pnd?.note?.(d.done, d.total); pnd?.kick?.()
        }
        else if (d.type === 'supsab') { try { supSabRef.current = { arr: new Uint32Array(d.buf, d.ptr, 1), cancel: d.cancelPtr ? new Uint32Array(d.buf, d.cancelPtr, 1) : null }; console.info('[vp-cancel] supsab cancelPtr=', d.cancelPtr) } catch (e) { console.info('[vp-cancel] supsab view fail', e) } }
        else if (d.type === 'layer') {   // stage-30 streaming: receive each layer immediately (transfer) -> accumulate, reset the watchdog
          pnd?.kick?.()
          const a = streamAccumRef.current
          if (a) { a.layers.push({ z: d.z, paths: d.paths, widths: d.widths }); if (d.gcode) a.gcode.push(d.gcode) }
        }
        else if (d.type === 'done') { stopSupPoll(); if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.resolve(assembleResult(d.result)) } else { handleResult(assembleResult(d.result)); setSlicing(false) } }
        else if (d.type === 'error') { stopSupPoll(); if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.reject(new Error(d.error)) } else { setError('Slice failed: ' + d.error); setSlicing(false) } }
        else if (d.type === 'prepared') { /* selector mesh registered */ }
        // The overlay request that follows a stroke is issued by support_paint.js, which is the one place that knows
        //  which states actually changed — asking for all of them on every sample is what made painting slow down as
        //  the painted area grew. This listener keeps only the enf/blk pair it has always kept.
        else if (d.type === 'painted') { setPaintCounts({ enf: d.enf, blk: d.blk }) }
        else if (d.type === 'overlay') { rebuildPaintOverlay(d.enf, d.blk, d.overlays) }
      }
      // Stage-30 OOM detection: worker error/messageerror -> reject the in-flight slice (the ladder decides on an economy retry).
      // Late errors from an already-discarded worker are ignored. An emscripten abort raises an error event per pthread, so
      //  the same worker fires onerror several times — the first rejected the pending slice and swapped the worker, and
      //  the rest used to overwrite the banner via setError, leaving a failure message even when the ladder succeeded.
      const killPending = (msg) => {
        if (workerRef.current !== wk) return
        stopSupPoll(); supSabRef.current = null
        const pnd = pendingSliceRef.current
        if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); try { wk.terminate() } catch {} workerRef.current = null; pnd.reject(new Error(msg)) }
        else { setError(msg); setSlicing(false) }
      }
      wk.onerror = (ev) => killPending('Worker terminated (likely out of memory): ' + (ev.message || 'worker error'))
      wk.onmessageerror = () => killPending('Worker message error (structured clone failed)')
      workerRef.current = wk
      if (typeof window !== 'undefined') window.__vpWorker = wk   // dev/test aid: drive selector cmds directly
    }
    return workerRef.current
  }
  // Stage 30: assemble the streamed result — when streamed, g-code/layers already arrived as 'layer', so they are built from the accumulator.
  //  batch/MM keep gcode+layers in result as before. Economy mode yields an empty layers array (no toolpath) and g-code only.
  function assembleResult(result) {
    if (result && result.stats && result.stats.streamed) {
      const a = streamAccumRef.current || { layers: [], gcode: [] }
      return { stats: result.stats, layers: a.layers, gcode: a.gcode.join('') }
    }
    return result
  }
  function handleResult(result) {
    if (result.error) { setError(String(result.error)); return }
    layersDataRef.current = result.layers
    const n = result.layers.length
    layerLoRef.current = 0; layerHiRef.current = n - 1; setLayerLo(0); setLayerHi(n - 1)   // dual slider covers the full range
    rebuildToolpaths()
    apiRef.current?.onSliced()
    setCanvasMode('preview')   // S2: switch to Preview automatically once slicing finishes
    setStats({ layers: result.stats.layers, segments: result.stats.path_segments, filament: result.stats.filament_mm, timeSec: result.stats.time_estimate,
               engine: result.stats.time_engine, limits: result.stats.machine_limits })
    setOverBed(!!result.stats.over_bed)
    setLayerCount(n)
    setGcodeUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(new Blob([result.gcode], { type: 'text/plain' })) })
  }

  useEffect(() => () => { if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null } }, [])

  // Warmup: right after mount, create the worker and load the kernel (3.4MB parse, wasm compile, mt pthread pool) ahead of time.
  //  It finishes while the user picks and arranges models, so the first slice click no longer feels like a load.
  useEffect(() => { try { getWorker().postMessage({ cmd: 'warmup' }) } catch { /* a load failure is reported properly on the first slice */ } }, [])

  // ---- Slicing (derived from the right panel settings) — per plate (stage 29-2) + streaming/watchdog/OOM ladder (stage 30) ----
  const WATCHDOG_MS = 60000   // stage-30 hang watchdog: no progress/layer news for 60s -> declared dead
  const SILENT_STAGE_MS = 300000   // surface/support window (around 50% progress): the kernel is structurally silent — minutes are normal on large models. A relaxed limit to avoid false positives.
  function sliceOne(buf, paramsStr) {
    return new Promise((resolve, reject) => {
      // dev/test hooks (not set in production): __vpFail(n)=force a failure (ladder verification) · __vpStallNext=unresponsive worker (watchdog) · __vpWatchdogOnce=short watchdog (ms).
      if (typeof window !== 'undefined' && window.__vpFail && window.__vpFail(window.__vpSliceN = (window.__vpSliceN || 0) + 1)) { reject(new Error('forced failure (test hook)')); return }
      const stall = (typeof window !== 'undefined' && window.__vpStallNext) ? (window.__vpStallNext = false, true) : false
      const wdMs = (typeof window !== 'undefined' && window.__vpWatchdogOnce) ? ((v) => (window.__vpWatchdogOnce = 0, v))(window.__vpWatchdogOnce) : WATCHDOG_MS
      streamAccumRef.current = { layers: [], gcode: [] }   // reset the streaming accumulator (layers arrive one by one)
      let t = 0
      let lastD = 0, lastT = 0
      const __ts = performance.now(); let __stage = ''   // [vp-prof] phase arrival timestamps (temporary)
      const note = (done, total) => {
        lastD = done; lastT = total
        const N = total > 2 ? (total - 2) / 2 : 0
        const st = !N ? '' : done < N ? 'PASS1…' : done === N ? 'PASS1-done' : done === N + 1 ? 'surf-done' : done === N + 2 ? 'support-done' : done === total ? 'emit-done' : 'emit…'
        if (st && st !== __stage) { console.info(`[vp-prof] ${st} +${((performance.now() - __ts) / 1000).toFixed(1)}s`); __stage = st }
      }
      // If the last progress was inside the surface/support window (d ∈ [N, N+2), N=(t−2)/2), use the relaxed limit — silence is normal there, so
      //  the 60s watchdog would kill a healthy slice (measured: 774k tri support takes 19s+, and over 60s on slow or loaded machines).
      const curWd = () => {
        const N = lastT > 2 ? (lastT - 2) / 2 : 0
        return (N && lastD >= N && lastD < N + 2) ? SILENT_STAGE_MS : wdMs
      }
      const stop = () => { if (t) { clearTimeout(t); t = 0 } }
      const kick = () => { stop(); const ms = curWd(); t = setTimeout(() => {
        pendingSliceRef.current = null
        stopSupPoll(); supSabRef.current = null   // worker gone -> drop the SAB polling/reference
        try { workerRef.current?.terminate() } catch {} ; workerRef.current = null   // force-terminate the stalled worker
        reject(new Error(`watchdog: no progress for ${ms}ms — assuming memory pressure`))
      }, ms) }
      pendingSliceRef.current = { resolve, reject, kick, stop, note }
      kick()
      getWorker().postMessage({ stl: buf, params: paramsStr, stall })
      startP1Poll()   // real PASS1 progress (0 -> 35%) — a no-op when SAB is unsupported (st)
    })
  }
  function recreateWorker() { try { workerRef.current?.terminate() } catch {} ; workerRef.current = null; getWorker() }
  // OOM retry ladder: (1) normal (streaming) -> on failure (error/abort/watchdog) (2) recreate the worker + retry with **classic walls**
  //  -> (3) recreate the worker + finish in economy mode (no toolpaths or time estimate, g-code only). If everything fails it throws -> the caller
  //  offers a downgrade (simplified) retry. Partial g-code is never handed out.
  //
  // Why (2) exists (measured): Arachne wall generation builds a Voronoi diagram, and meshes like CAD tessellations (STEP/OCCT) — whose
  //  vertices are unwelded and which contain sliver triangles — produce degenerate cells in the sliced polygons, killing the worker with
  //  "memory access out of bounds" (an assert at Voronoi.cpp:334 in upstream debug builds).
  //  The same model finishes fine with wall_generator=classic -> this rung comes before economy mode
  //  (economy only reduces infill, which does nothing for an Arachne crash).
  async function sliceLadder(buf, params) {
    const isCancel = (e) => String(e?.message || e).includes('canceled')
    try { const r = await sliceOne(buf, JSON.stringify(params)); return { r, economy: !!(r.stats && r.stats.economy) } }
    catch (e1) {
      if (isCancel(e1)) throw e1   // G002: cancellation propagates without retrying
      if (params.wall_generator !== 'classic') {
        recreateWorker()
        try {
          const r = await sliceOne(buf, JSON.stringify({ ...params, wall_generator: 'classic', keep_stages: false, reuse_stages: 0 }))
          return { r, economy: !!(r.stats && r.stats.economy), classicWalls: true }
        } catch (e2) { if (isCancel(e2)) throw e2 }
      }
      recreateWorker()
      // Economy retry: do not keep the stage cache (minimize the heap) and disable reuse (a new worker has no cache anyway)
      const r = await sliceOne(buf, JSON.stringify({ ...params, economy: true, keep_stages: false, reuse_stages: 0 }))   // a failure propagates as a throw
      return { r, economy: true, recovered: true }
    }
  }
  // G003 incremental: geometry digest (SHA-256, native — 37MB ≈ 0.1s). When it matches the last successful slice,
  //  the kernel stage cache is reused (reuse_stages=2) — if a parameter affects layers, the kernel's layerKey is the second line of defense.
  async function geomDigest(buf) {
    try { const d = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(d, 0, 8)).map(b => b.toString(16).padStart(2, '0')).join('') }
    catch { return null }   // non-secure context and friends — incremental disabled (always a full slice)
  }
  function applyIncremental(params, dig) {
    if (params.economy) return   // economy mode: keeping the cache adds heap pressure — no incremental
    params.keep_stages = true
    params.reuse_stages = dig && dig === lastGeomRef.current ? 2 : 0
  }
  function buildParams(merged) {
    const params = deriveKernelParams(settings)
    if (merged.extruders >= 2 && merged.split > 0) {
      params.extruder_count = merged.extruders; params.mm_group_split = merged.split
      // One group per extruder run — mm_group_split alone can only express two.
      if (merged.splits?.length) { params.mm_group_splits = merged.splits; params.mm_group_tools = merged.tools }
      params.wipe_tower_real = wipeTowerReal
    }
    // Material painting assigns tools per facet, so `merged` — which reads whole-object assignment only — cannot
    //  see it. The kernel gates its multi-tool path on `extruder_count >= 2 && (groups || painted tools)`, so a
    //  painted-but-unassigned model short-circuits on the FIRST term and the paint is silently ignored: measured
    //  as a painted and an unpainted export coming out byte-identical. Selector state s addresses extruder s
    //  (ENFORCER==Extruder1), so the highest painted state is the extruder count the kernel has to allow for.
    const paintedStates = Object.entries(paintStateCountsRef?.current ?? {})
      .filter(([, facetCount]) => facetCount > 0).map(([state]) => Number(state))
    const highestPaintedState = paintedStates.length ? Math.max(...paintedStates) : 0
    if (highestPaintedState >= 2) {                 // state 1 alone is the default tool — nothing to switch to
      params.extruder_count = Math.max(params.extruder_count ?? 1, highestPaintedState)
      params.wipe_tower_real = wipeTowerReal
    }
    // Filament identity and physical constants, straight from the settings map the filament card writes. Upstream
    //  reports all of these in the G-code footer; without them an export says how much filament it used but not
    //  what the filament was. Also switches on the two footer blocks — the kernel leaves them off so its own
    //  default output stays byte-identical, and the app is the thing that wants to behave like upstream.
    const perFilament = (key) => {
      const raw = settingRaw(settings, key)
      const list = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw])
      return list.length ? list : undefined
    }
    const asNumbers = (list) => list && list.map(v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 })
    const filamentType = perFilament('filament_type')
    const filamentId   = perFilament('filament_settings_id')
    const density      = asNumbers(perFilament('filament_density'))
    const cost         = asNumbers(perFilament('filament_cost'))
    if (filamentType) params.filament_type = filamentType
    if (filamentId)   params.filament_settings_id = filamentId
    if (density)      params.filament_density = density
    if (cost)         params.filament_cost = cost
    params.gcode_stats_block = true
    params.gcode_config_block = true

    // Prime tower next to the model. The kernel's default corner (10,10) is wherever the bed is, not wherever the
    //  model is — measured 90mm of travel per tool change with a centred model. Only when nothing chose a position:
    //  deriveKernelParams already wrote prime_tower_x/y if the card or a drag set wipe_tower_x/y, and this used to
    //  overwrite that on every slice, so a tower dragged in Prepare sliced somewhere else.
    if ((params.extruder_count ?? 1) >= 2 && Number.isFinite(merged.minX) && params.prime_tower_x == null) {
      const towerSide = (params.wipe_tower_real ?? true) ? (params.prime_tower_width ?? 30) : 15
      const gap = 5
      const bedW = params.bed_width ?? 200, bedD = params.bed_depth ?? 200
      // Slice frame -> bed frame is one addition (the kernel's own gw.offX), and both boxes are now in it.
      const modelLeft = merged.minX + bedW / 2, modelMidY = (merged.minY + merged.maxY) / 2 + bedD / 2
      params.prime_tower_x = Math.min(Math.max(modelLeft - gap - towerSide, 1), bedW - towerSide - 1)
      params.prime_tower_y = Math.min(Math.max(modelMidY - towerSide / 2, 1), bedD - towerSide - 1)
    }
    // Two ways a painted model slices exactly like an unpainted one, both of them by design and neither of them
    //  visible in the result — the export just comes out single-material. Said here, at the one place that knows
    //  both the paint and the settings, because the alternative is the user concluding the brush is broken.
    //  · support on: slicer_core.cpp keeps painted models on the single-material path (slice_multimaterial emits
    //    no support, and one selector state cannot say "blocker" and "Extruder2" apart).
    //  · only T1 painted: state 1 IS the default extruder, so there is no second tool to switch to.
    if (paintedStates.length) {
      // Support and material painting now slice together — the multi-material path runs the same support pass the
      //  single-material one does. What survives is the AMBIGUITY: one selector, and upstream's enum makes a support
      //  BLOCKER and Extruder2 the same mark, so a model carrying both reads the blocker as a material.
      if (params.enable_support && paintedStates.includes(2))
        setSliceNotice?.('Support is on and T2 is painted. One facet carries one mark, and a support blocker is ' +
                         'the same mark as T2 — the painted areas were sliced as T2, not as blocked support.')
      else if (highestPaintedState < 2)
        setSliceNotice?.('Only T1 was painted. T1 is the default extruder every unpainted facet already uses, ' +
                         'so the slice is unchanged — paint T2 or higher to get a second material.')
    }
    if (downgradeRef.current) { params.sparse_infill_pattern = 'rectilinear'; params.infill_density = Math.min(params.infill_density ?? 0.15, 0.08); params.economy = true }  // downgrade retry
    if (typeof window !== 'undefined' && window.__vpForceTree) { params.enable_support = true; params.support_style = 'tree'; params.support_threshold_angle = 40 }  // stage-31 test hook: force tree support (not set in production)
    if (typeof window !== 'undefined') window.__vpParams = params   // dev/test aid: the parameters actually handed to the kernel
    return params
  }
  // One merged STL through the whole ladder: parameters + incremental digest + the last-successful-geometry bookkeeping.
  //  Finishing via economy/classic used different parameters, so the cache cannot be reused (lastGeom is cleared).
  async function runSlice(merged) {
    const params = buildParams(merged)
    const dig = await geomDigest(merged.buf); applyIncremental(params, dig)
    try {
      const out = await sliceLadder(merged.buf, params)   // on a normal failure: classic walls -> economy retry
      lastGeomRef.current = (out.economy || out.classicWalls) ? null : dig
      return { ...out, params }
    } catch (e) { lastGeomRef.current = null; throw e }
  }

  return { getWorker, cancelSlice, runSlice, pendingSliceRef, downgradeRef }
}
