import React from 'react'

// The sidebar's fixed bottom bar: auto-slice toggle, the slice button (with the per-plate dropdown)
// and the G-code export link. While a slice runs the button cancels it.
export default function SliceBar({
  autoSlice, onAutoSlice, slicing, progress, plateCount, selectedPlate, sliceMenuOpen, onSliceMenu,
  slicedPlateCount, canSlice, onSlice, onCancel, onExportAll, gcodeUrl, bedWarning,
  slaResult = false, onExportSl1 = null, exporting = null,
}) {
  const title = slicing ? 'Click to cancel the slice'
    : plateCount > 1 ? 'Choose what to slice (Ctrl+R = current plate)' : 'Slice the current plate (Ctrl+R)'
  return (
    <div className="side-bottom">
      <label className="auto-slice" data-testid="auto-slice" title="Re-slice automatically 0.8s after a settings change (the first slice is manual; a running slice is canceled and restarted)">
        <input type="checkbox" checked={autoSlice} onChange={e => onAutoSlice(e.target.checked)} /> Auto slice
      </label>
      <div className="slice-dd">
        <button className="slice-btn" title={title}
          onClick={() => (slicing ? onCancel() : (plateCount > 1 ? onSliceMenu() : onSlice('current')))}
          disabled={!canSlice} data-testid="slice-btn">
          {slicing ? `Slicing… ${Math.round(progress * 100)}%` : (plateCount > 1 ? 'Slice ▾' : 'Slice')}
        </button>
        {sliceMenuOpen && plateCount > 1 && (
          <div className="slice-menu" data-testid="slice-menu">
            <button onClick={() => onSlice('current')} data-testid="slice-current" title="Slice only the selected plate (Ctrl+R)">Current plate (P{selectedPlate + 1})</button>
            <button onClick={() => onSlice('all')} data-testid="slice-all" title="Slice every plate in turn — switch tabs to inspect the results">All plates ({plateCount})</button>
            {slicedPlateCount > 0 && (
              <button onClick={onExportAll} data-testid="export-all" title="Save the G-code of every sliced plate as its own file">Export all G-code ({slicedPlateCount})</button>
            )}
          </div>
        )}
      </div>
      {/* Slicing something that hangs off the bed is fine — inspecting it is how you see the problem. Saving the
          file is not: those coordinates drive a machine that cannot reach them, so export is where this stops.
          A resin slice exports an .sl1 archive instead of G-code, and it is BUILT on click (a click handler, not
          a prefilled href) — rasterizing hundreds of layer PNGs eagerly on every plate focus would freeze the tab
          for a file the user may never save. */}
      {slaResult
        ? <button className="export-btn" disabled={!!bedWarning || !!exporting} onClick={onExportSl1} data-testid="sl1-dl"
            title={bedWarning ? `Export blocked — ${bedWarning}. Move or rescale the model to fit the bed.`
              : 'Save the SL1 archive (per-layer PNG masks + config) of the plate you are viewing'}>
            {exporting || 'Export SL1'}
          </button>
        : gcodeUrl && !bedWarning
        ? <a className="export-btn" href={gcodeUrl} download={`plate_${selectedPlate + 1}.gcode`} title="Save the G-code of the plate you are viewing" data-testid="gcode-dl">Export G-code</a>
        : <button className="export-btn" disabled data-testid="gcode-dl-blocked"
            title={bedWarning ? `Export blocked — ${bedWarning}. Move or rescale the model to fit the bed.` : 'Export G-code — enabled after slicing'}>
            Export G-code
          </button>}
    </div>
  )
}
