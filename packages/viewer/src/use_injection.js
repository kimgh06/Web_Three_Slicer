import { useEffect } from 'react'
import { parseGcode } from './core/gcode_parse.js'
import { platePosition } from './core/plate_layout.js'
import { asSl1File } from './core/sl1_read.js'
import { log } from './core/log.js'

// The two injection props, `gcode` and `sl1`: an artifact rendered on the selected plate WITHOUT running the
// kernel. They are one contract with two file formats, so they live together — and one plate holds one artifact,
// which is the rule the `sl1` effect enforces below.

/**
 * G-code text -> the plate cache. The parser produces the very layer stream the kernel produces, so the result
 * goes in beside a real slice and showPlateResult draws it the same way.
 * Coordinates: a slice is centred on the origin and offset back by its own centre (use_three_scene
 * buildMergedSTL), but G-code is already in absolute bed millimetres — so the offset is the bed's own corner,
 * per the plate grid setPlates lays out (plate i sits at (i%cols)*step, floor(i/cols)*step; model y -> three -z).
 */
function useGcodeInjection(gcode, deps) {
  const { tech, kp, selectedPlateRef, plateCountRef, plateOffsetsRef, plateResultsRef, lineWidthRef,
          refreshSlicedCount, setError, setSliceNotice, showPlateResult } = deps
  useEffect(() => {
    if (gcode == null || tech === 'SLA') return   // injected G-code is an FFF artifact — a resin profile has no path that renders it
    const idx = selectedPlateRef.current
    try {
      const parsed = parseGcode(String(gcode), { filamentDiameter: Number(kp.filament_diameter) || 1.75 })
      if (!parsed.layers.length) { setError('No printable moves found in the G-code'); return }
      const bw = kp.bed_width, bd = kp.bed_depth
      const origin = platePosition(idx, plateCountRef.current, bw, bd)
      plateOffsetsRef.current[idx] = { offX: origin.x - bw / 2, offZ: origin.z + bd / 2 }
      lineWidthRef.current = kp.line_width || 0.42
      plateResultsRef.current[idx] = { stats: parsed.stats, layers: parsed.layers, gcode: String(gcode) }
      refreshSlicedCount()
      setError(''); setSliceNotice('')
      showPlateResult(idx)
    } catch (e) { setError('G-code parse failed: ' + (e?.message || e)) }
  }, [gcode])   // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * An .sl1 archive -> importSl1, the very function the picker and a drop use, so an injected archive behaves
 * identically: the raster preview, the background mesh reconstruction, and the archive's OWN settings applied to
 * the session. `printer_technology` is among them — an .sl1 opened in an FFF session has to switch it, or the
 * masks sit on a filament bed — and that setSettings is why the auto-re-slice guard names this prop too.
 * No `tech === 'SLA'` gate, unlike the G-code effect above: here the archive is what DECIDES the technology.
 */
function useSl1Injection(sl1, gcode, importSl1) {
  useEffect(() => {
    if (sl1 == null) return
    // One plate, one artifact — and the G-code effect has already claimed it.
    if (gcode != null) { log.warn('[viewport] both `gcode` and `sl1` are set — rendering the G-code, ignoring the archive'); return }
    importSl1(asSl1File(sl1))
  }, [sl1])   // eslint-disable-line react-hooks/exhaustive-deps
}

export function useInjection({ gcode, sl1, importSl1, ...deps }) {
  useGcodeInjection(gcode, deps)
  useSl1Injection(sl1, gcode, importSl1)
}
