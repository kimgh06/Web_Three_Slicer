import { useEffect, useRef } from 'react'
import { sameSettings, survivesSettingsChange } from './core/slice_staleness.js'

// A settings change invalidates every result on screen.
//
// Everything shown after a slice — the toolpaths, the stats card, the layer slider, the G-code export — describes
// the settings it was sliced with. Change one and the picture stops matching the panel next to it, silently: the
// preview still renders, the estimate still reads plausibly, and the Export button still hands out G-code the
// current settings would not produce. With auto-slice on, that window is the 0.8s debounce; with it off, it lasts
// until the user happens to slice again.
//
// So the result is dropped and the viewer goes back to Prepare. Auto-slice then re-slices into the empty preview,
// which is the honest sequence: the old picture is gone before the new one exists.
//
// Two kinds of plate are NOT invalidated, because neither claims to be a slice of these settings:
//  · an INJECTED plate (the `gcode` / `sl1` props) — the same guard autoSlice and sliceRequest use; it is the
//    host's content, not ours to discard.
//  · an OPENED `.sl1` archive (`stats.sla_raster`) — and this one is not merely allowed but required. The import
//    applies the archive's own settings through setSettings (plate_actions.js) and then populates the plate, so
//    invalidating on that write would erase the very result the file was opened to show.
//
// An in-flight slice is deliberately left running: it was asked for, and cancelling it would make a settings nudge
// silently discard work in progress. Its result lands under the new settings and is invalidated on the NEXT change.

// Both decisions — "did the values actually change" and "does this result survive" — live in
// core/slice_staleness.js, where they are node-testable.
export function useStaleSlice({
  settings, gcode, sl1,
  plateResultsRef, selectedPlateRef, canvasModeRef,
  clearToolpaths, showPlateResult, refreshSlicedCount, setCanvasMode,
}) {
  const seenRef = useRef(settings)
  useEffect(() => {
    const previous = seenRef.current
    seenRef.current = settings
    if (gcode != null || sl1 != null) return
    if (sameSettings(previous, settings)) return

    const results = plateResultsRef.current
    let dropped = 0
    for (const key of Object.keys(results)) {
      if (survivesSettingsChange(results[key])) continue
      delete results[key]
      dropped++
    }
    if (!dropped) return
    // showPlateResult's own "plate without a result" branch is what clears the stats, the layer range, the SLA
    //  preview meshes and the G-code URL — reached here by having just removed the entry it looks for.
    clearToolpaths()
    refreshSlicedCount()
    showPlateResult(selectedPlateRef.current)
    // Leaving the user on a Preview tab that has nothing left to preview: the tab disables itself once the layer
    //  count drops to 0, but the canvas would stay on it.
    if (canvasModeRef.current === 'preview') setCanvasMode('prepare')
  }, [settings])   // eslint-disable-line react-hooks/exhaustive-deps
}
