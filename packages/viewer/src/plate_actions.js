import { deriveKernelParams } from 'three-slicer/settings'
import { roleRatios } from './toolpath_segments.js'
import { MAX_PLATES } from './plate_layout.js'
import { statsFromKernel } from './use_slicer.js'

// Per-plate slicing/caching/export (stage 29-2) + the plate tabs (add/delete/select).
// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each
//  render so the values it closes over (settings, canvasMode, downgradeOffer) stay fresh.
export function makePlateActions(deps) {
  const {
    apiRef, selectedPlateRef, plateCountRef, placeXRef, plateResultsRef, plateOffsetsRef, plateTpRef,
    layersDataRef, toolpathRef, segDataRef, layerLoRef, layerHiRef, lineWidthRef, downgradeRef,
    settings, canvasMode, downgradeOffer,
    runSlice, ensurePlateToolpaths, buildPlateToolpath, applyViewColors, disposePlateToolpath,
    setStats, setOverBed, setLayerCount, setSegCount, setColorRange, setRoleLegend, setGcodeUrl,
    setLayerLo, setLayerHi, setCanvasMode, setSlicedPlateCount, setSliceMenu, setError, setSliceNotice,
    setDowngradeOffer, setSlicing, setProgress, setPlateCount, setSelectedPlate, setSettings, syncPaintSelector,
    onSlicedRef,
  } = deps

  // Hands a finished slice to the host (the Viewport `onSliced` prop). Fired where the result is cached, not where
  //  it is displayed, so switching plate tabs — which re-displays a cached result — does not re-announce it.
  const announceSlice = (plate, r) => { if (r && !r.error) onSlicedRef?.current?.({ plate, stats: r.stats, gcode: r.gcode }) }

  // Shows a cached result in Preview — every cached plate's toolpath renders at its own offset simultaneously,
  //  and idx becomes the focus (target of the slider/stats/G-code). Focusing a plate with no cache = empty state (leftovers cleared).
  function showPlateResult(idx) {
    ensurePlateToolpaths()                                   // all plates viewable at once
    const prev = toolpathRef.current
    if (prev) prev.setLayerRange(0, 1e9)                     // the previous focus goes back to its full range
    const r = plateResultsRef.current[idx]
    if (!r || r.error || !r.layers || !r.layers.length) {    // plate without a result: clear the focus UI
      layersDataRef.current = null; toolpathRef.current = null; segDataRef.current = null
      setStats(null); setOverBed(false); setLayerCount(0); setSegCount(0); setColorRange(null); setRoleLegend([])
      setGcodeUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return '' })
      return
    }
    layersDataRef.current = r.layers
    const n = r.layers.length
    layerLoRef.current = 0; layerHiRef.current = n - 1; setLayerLo(0); setLayerHi(n - 1)
    const cached = plateTpRef.current[idx]
    const entry = (cached && cached.layers === r.layers) ? cached : buildPlateToolpath(idx, r.layers)
    if (entry) {
      toolpathRef.current = entry.ctl; segDataRef.current = entry.seg
      entry.ctl.setLayerRange(0, n - 1)
      applyViewColors()
      setSegCount(entry.seg.nSeg); setRoleLegend(roleRatios(entry.seg.typeLengths))
    }
    apiRef.current?.onSliced()
    setCanvasMode('preview')
    setStats(statsFromKernel(r.stats))
    setOverBed(!!r.stats.over_bed); setLayerCount(n)
    setGcodeUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return URL.createObjectURL(new Blob([r.gcode], { type: 'text/plain' })) })
  }
  function downloadGcode(gcode, name) { const url = URL.createObjectURL(new Blob([gcode], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(url) }, 4000) }
  const _sleep = (ms) => new Promise(r => setTimeout(r, ms))
  // plateResultsRef is a ref, so the UI does not refresh on its own — mirror the count into state wherever it changes.
  function refreshSlicedCount() {
    setSlicedPlateCount(Object.values(plateResultsRef.current).filter(r => r && !r.error && r.gcode).length)
  }
  // Saves the G-code of every sliced plate at once — only when the user explicitly asks (never automatically).
  //  Browsers throttle back-to-back downloads, so the files are spaced out.
  async function exportAllGcode() {
    setSliceMenu(false)
    const sliced = Object.entries(plateResultsRef.current)
      .filter(([, r]) => r && !r.error && r.gcode)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
    // Same rule the single-plate export follows, applied per plate: a plate whose model leaves the printable
    //  volume is skipped rather than silently written, and the notice names it so it is not just missing.
    const done = sliced.filter(([, r]) => !r.stats?.over_bed)
    const skipped = sliced.length - done.length
    if (!done.length) {
      setError(skipped ? 'Every sliced plate extends beyond the bed — nothing exported' : 'No slice results to export — slice first')
      return
    }
    for (const [i, r] of done) { downloadGcode(r.gcode, `plate_${Number(i) + 1}.gcode`); await _sleep(350) }
    setSliceNotice(`Exported G-code for ${done.length} plate(s)`
      + (skipped ? ` — skipped ${skipped} that extend beyond the bed` : ''))
  }
  async function onSlice(scope = 'current') {
    setSliceMenu(false); setError(''); setSliceNotice(''); setDowngradeOffer(null)
    const idx0 = selectedPlateRef.current
    lineWidthRef.current = deriveKernelParams(settings).line_width
    if (scope === 'all') {
      setSlicing(true); setProgress(0)
      let sliced = 0, anyEconomy = false, anyClassic = false; const failed = []
      for (let i = 0; i < plateCountRef.current; i++) {
        const merged = apiRef.current?.buildMergedSTL(i); if (!merged) continue
        // Follow the work: highlighting the plate about to be cut turns its border green, so a run over six plates
        //  shows WHICH one is busy instead of one progress number with no place attached to it.
        //  Deliberately NOT selectPlate(): in Preview that also swaps the result view, which would mean tearing the
        //  toolpaths down and back up once per plate — and showing an empty one for every plate not yet sliced.
        selectedPlateRef.current = i; setSelectedPlate(i)
        //  Compared against the plate selected when the run STARTED, not the one selection now points at — the line
        //  above moves that every iteration, and the brush painted the mesh of the original one.
        if (i === idx0) syncPaintSelector?.(merged)
        plateOffsetsRef.current[i] = { offX: merged.offX, offZ: merged.offZ }
        try {
          const { r, economy, classicWalls } = await runSlice(merged)
          plateResultsRef.current[i] = r; refreshSlicedCount(); announceSlice(i, r); sliced++   // no automatic download — switch tabs to inspect, save via an explicit export
          if (economy) anyEconomy = true
          if (classicWalls) anyClassic = true
        } catch (e) { failed.push(i + 1) }   // E1: even on failure, g-code from plates that already finished is preserved and available
      }
      setSlicing(false)
      if (!sliced) { setDowngradeOffer({ scope: 'all' }); setError('All plates failed to slice (economy mode included) — try the simplified retry'); return }
      if (failed.length) setError(`Plate ${failed.join(', ')} failed — the ${sliced} finished result(s) are kept (inspect/export from the tabs)`)
      else { setError(''); setDowngradeOffer(null) }
      if (anyEconomy) setSliceNotice('Memory pressure — some plates finished in economy mode (no preview, G-code is fine)')
      else if (anyClassic) setSliceNotice('Arachne wall generation failed (degenerate geometry) — finished with classic walls (G-code is fine)')
      // The run walked the selection across every plate; put it back where the user left it (or on the one plate
      //  that actually produced a result, which is what gets shown).
      //  Moved the same way as inside the loop rather than through selectPlate, because in Preview that would run
      //  showPlateResult a second time on top of the call below.
      const landOn = plateResultsRef.current[idx0] ? idx0 : Object.keys(plateResultsRef.current).map(Number)[0]
      selectedPlateRef.current = landOn; setSelectedPlate(landOn); placeXRef.current = 0
      showPlateResult(landOn)
    } else {
      const __tm0 = performance.now()   // [vp-prof] preprocessing timing (temporary)
      const merged = apiRef.current?.buildMergedSTL(idx0)
      if (!merged) { setError(`Plate ${idx0 + 1} has no objects`); return }
      console.info(`[vp-prof] buildMergedSTL ${(performance.now() - __tm0).toFixed(0)}ms (${(merged.buf.byteLength / 1048576).toFixed(1)}MB)`)
      if (idx0 === selectedPlateRef.current) syncPaintSelector?.(merged)
      plateOffsetsRef.current[idx0] = { offX: merged.offX, offZ: merged.offZ }
      setSlicing(true); setProgress(0)
      try {
        const { r, economy, classicWalls, params } = await runSlice(merged)
        if (r?.stats) console.info(`[vp-prof] kernel stages p1=${(r.stats.t_pass1_ms/1000).toFixed(1)}s surf=${(r.stats.t_surface_ms/1000).toFixed(1)}s sup=${(r.stats.t_support_ms/1000).toFixed(1)}s emit=${(r.stats.t_emit_ms/1000).toFixed(1)}s reuse=${params.reuse_stages}`)
        plateResultsRef.current[idx0] = r; refreshSlicedCount(); announceSlice(idx0, r); setSlicing(false); showPlateResult(idx0)
        setError(''); setDowngradeOffer(null)   // a lower rung of the ladder succeeded — do not leave the failed first attempt's banner up
        if (economy) setSliceNotice('Memory pressure — finished in economy mode (no preview, G-code can still be downloaded)')
        else if (classicWalls) setSliceNotice('Arachne wall generation failed (degenerate geometry) — finished with classic walls (G-code is fine)')
      } catch (e) {
        setSlicing(false)
        if (String(e?.message || e).includes('canceled')) { setSliceNotice('Slice canceled'); return }
        setDowngradeOffer({ scope: 'current' }); setError('Slice failed (economy mode failed too): ' + e.message)
      }
    }
  }
  // Downgrade retry: simplify the infill pattern (rectilinear) + lower density + economy mode, run again (user's choice). buildParams applies it.
  async function retryDowngrade() {
    const off = downgradeOffer; setDowngradeOffer(null); if (!off) return
    downgradeRef.current = true
    try { await onSlice(off.scope) } finally { downgradeRef.current = false }
  }
  // Add/remove/select plates
  function addPlate() { setPlateCount(n => Math.min(MAX_PLATES, n + 1)) }
  function deletePlate() {
    setPlateCount(n => {
      if (n <= 1) return n
      const last = n - 1; delete plateResultsRef.current[last]; disposePlateToolpath(last); refreshSlicedCount()
      // Per-plate settings shrink with the plate list (upstream erases the same index, PartPlate.cpp:4722) — a
      //  stale trailing entry would come back as the wrong plate's position the moment a plate is re-added.
      //  Only the LAST plate is ever deletable here, so truncation IS the erase.
      setSettings?.(s => (Array.isArray(s?.wipe_tower_x) || Array.isArray(s?.wipe_tower_y))
        ? { ...s,
            wipe_tower_x: Array.isArray(s.wipe_tower_x) ? s.wipe_tower_x.slice(0, last) : s.wipe_tower_x,
            wipe_tower_y: Array.isArray(s.wipe_tower_y) ? s.wipe_tower_y.slice(0, last) : s.wipe_tower_y }
        : s)
      if (selectedPlateRef.current >= last) selectPlate(last - 1)
      return last
    })
  }
  function selectPlate(i) {
    selectedPlateRef.current = i; setSelectedPlate(i); placeXRef.current = 0
    if (canvasMode === 'preview') showPlateResult(i)   // switching plates in Preview -> show that plate's cached result
  }

  return { showPlateResult, refreshSlicedCount, exportAllGcode, onSlice, retryDowngrade, addPlate, deletePlate, selectPlate }
}
