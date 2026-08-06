import React from 'react'

// The sidebar's fixed bottom bar: auto-slice toggle, the slice button (with the per-plate dropdown)
// and the G-code export link. While a slice runs the button cancels it.
export default function SliceBar({
  autoSlice, onAutoSlice, slicing, progress, plateCount, selectedPlate, sliceMenuOpen, onSliceMenu,
  slicedPlateCount, canSlice, onSlice, onCancel, onExportAll, gcodeUrl,
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
      {gcodeUrl
        ? <a className="export-btn" href={gcodeUrl} download={`plate_${selectedPlate + 1}.gcode`} title="Save the G-code of the plate you are viewing" data-testid="gcode-dl">Export G-code</a>
        : <button className="export-btn" disabled title="Export G-code — enabled after slicing">Export G-code</button>}
    </div>
  )
}
