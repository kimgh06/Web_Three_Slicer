// View-type coloring: kernel/derived per-vertex values -> the packed color texture the shader reads.
import { TYPE_COLOR, DEFAULT_RANGES_COLORS, packColor, rangeColorAt } from './toolpath_palette.js'

// View type list (the 6 highest-priority EViewType entries from the desktop app). value(i)=view value of vertex i, cont=continuous (heatmap) / false=fixed color.
export const VIEW_TYPES = [
  { key: 'feature', label: 'Feature type', cont: false, unit: '' },
  { key: 'speed',   label: 'Speed',        cont: true,  unit: 'mm/s' },
  { key: 'height',  label: 'Layer Height', cont: true,  unit: 'mm' },
  { key: 'width',   label: 'Line Width',   cont: true,  unit: 'mm' },
  { key: 'fan',     label: 'Fan Speed',    cont: true,  unit: '%' },
  { key: 'temp',    label: 'Temperature',  cont: true,  unit: '°C' },
]
// Per-vertex view value. speed/fan/temp are absent from the kernel toolpath, so they are derived from settings (the cheap option, kernel unchanged).
//  ctx: { speedByType:{type:val}, firstLayerSpeed, fanByType or fanFirstLayers, tempNormal, tempFirst, closeFanLayers }
function viewValue(viewType, meta, i, ctx) {
  const t = meta.vType[i], layer = meta.vLayer[i], first = layer === 0
  switch (viewType) {
    case 'height': return meta.vHeight[i]
    case 'width':  return meta.vWidth[i]
    case 'speed':  return first ? ctx.firstLayerSpeed : (ctx.speedByType[t] ?? ctx.speedByType[1])
    case 'fan':    return (layer < ctx.closeFanLayers) ? 0 : (t === 9 ? 100 : ctx.fanNormal)   // bridge(9)=100%, first N layers=0
    case 'temp':   return first ? ctx.tempFirst : ctx.tempNormal
    default:       return 0
  }
}
// View type -> per-vertex colors, Float32Array(nV*4, .r=packed) + range min/max. feature uses fixed colors.
export function computeColors(data, viewType, ctx) {
  const { meta, nV } = data
  const color = new Float32Array(nV * 4)
  const vt = VIEW_TYPES.find(v => v.key === viewType) || VIEW_TYPES[0]
  if (!vt.cont) {   // Feature type: fixed color per type
    for (let i = 0; i < nV; i++) color[i * 4] = packColor(TYPE_COLOR[meta.vType[i]] || TYPE_COLOR[1])
    return { color, min: 0, max: 0, viewType, label: vt.label, unit: vt.unit, cont: false }
  }
  // Continuous views: value range (extrusion vertices only) -> heatmap
  let lo = Infinity, hi = -Infinity
  const vals = new Float32Array(nV)
  for (let i = 0; i < nV; i++) { const v = viewValue(viewType, meta, i, ctx); vals[i] = v; if (v < lo) lo = v; if (v > hi) hi = v }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
  for (let i = 0; i < nV; i++) { const c = rangeColorAt(vals[i], lo, hi, DEFAULT_RANGES_COLORS); color[i * 4] = packColor(c) }
  return { color, min: lo, max: hi, viewType, label: vt.label, unit: vt.unit, cont: true }
}
