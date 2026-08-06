import React from 'react'

// Floating brush panel shown while support painting is active.
export default function PaintPanel({ paintMode, onPaintMode, onClear, brushRadius, onBrushRadius, paintCounts }) {
  return (
    <div className="brush-panel" data-testid="paint-tools">
      <div className="bp-title">Support painting</div>
      <div className="bp-modes">
        <button className={paintMode === 'enforcer' ? 'on enf' : 'enf'} onClick={() => onPaintMode('enforcer')} title="Force support under the painted facets" data-testid="paint-enforcer">enforcer</button>
        <button className={paintMode === 'blocker' ? 'on blk' : 'blk'} onClick={() => onPaintMode('blocker')} title="Block support under the painted facets" data-testid="paint-blocker">blocker</button>
        <button onClick={onClear} data-testid="paint-clear" title="Clear every painted enforcer/blocker area">Clear</button>
        <button onClick={() => onPaintMode('off')} data-testid="paint-off" title="Leave painting mode (Esc)">Close</button>
      </div>
      <label className="bp-radius">Brush radius {brushRadius}mm
        <input type="range" min="1" max="15" step="0.5" value={brushRadius}
          onChange={e => onBrushRadius(parseFloat(e.target.value))} data-testid="brush-radius" />
      </label>
      <div className="muted bp-counts" data-testid="paint-counts">enforcer {paintCounts.enf} · blocker {paintCounts.blk} · drag over the model to paint</div>
    </div>
  )
}
