import React from 'react'
import { VIEW_TYPES } from '../toolpath_views.js'
import { DEFAULT_RANGES_COLORS } from '../toolpath_palette.js'

const rgb = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`

// Preview sidebar controls: view type select, the dual layer slider and the legend
// (a gradient for continuous views, role shares for the feature view).
export default function PreviewControls({
  viewType, onViewType, layerCount, layerLo, layerHi, segCount, singleLayer,
  onLayerLo, onLayerHi, onToggleSingle, showTravel, onToggleTravel, colorRange, roleLegend,
}) {
  return (
    <div className="slice-layer" data-testid="preview-controls">
      <label className="view-type-row">View type
        <select value={viewType} onChange={onViewType} data-testid="view-type-select" title="What the toolpath colors represent — feature type, speed, layer height, width, fan, temperature">
          {VIEW_TYPES.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
      </label>
      <label>Layer <b data-testid="layer-range">{singleLayer ? (layerHi + 1) : `${layerLo + 1}..${layerHi + 1}`}</b> / {layerCount}
        <span className="muted"> ({segCount.toLocaleString()} segments)</span></label>
      <div className="dual-slider">
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerLo} onChange={onLayerLo} data-testid="layer-lo" title="Lowest layer to show (also adjustable with ↓/↑)" />
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerHi} onChange={onLayerHi} data-testid="layer-hi" title="Highest layer to show (↓/↑, hold Shift for steps of 10)" />
      </div>
      <div className="layer-ctl">
        <button className={singleLayer ? 'on' : ''} onClick={onToggleSingle} data-testid="single-layer-btn" title="Show only the selected layer (L)">Single layer</button>
        <label className="slice-travel"><input type="checkbox" checked={showTravel} onChange={onToggleTravel} data-testid="travel-toggle" title="Show non-extruding moves as gray lines (T)" /> Travel</label>
      </div>
      {colorRange && colorRange.cont ? (
        <div className="grad-legend" data-testid="view-legend">
          <div className="grad-title">{colorRange.label} <span className="muted">{colorRange.unit}</span></div>
          <div className="grad-bar" data-testid="gradient-bar" style={{ background: `linear-gradient(to right, ${DEFAULT_RANGES_COLORS.map(rgb).join(',')})` }} />
          <div className="grad-minmax"><span data-testid="grad-min">{colorRange.min.toFixed(colorRange.unit === 'mm' ? 2 : 0)}</span><span data-testid="grad-max">{colorRange.max.toFixed(colorRange.unit === 'mm' ? 2 : 0)}</span></div>
        </div>
      ) : (
        <div className="role-legend" data-testid="view-legend">
          {roleLegend.map(r => (
            <span key={r.type} className="role-item">
              <i style={{ background: rgb(r.color) }} />
              {r.label} <b>{r.pct.toFixed(0)}%</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
