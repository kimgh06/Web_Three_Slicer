// Toolpath color primitives shared by the segment stream, the view-type coloring and the legend.
// Split out of toolpath_gpu.js so each consumer depends on colors alone.

// Toolpath type colors (0=travel,1=wall,2=sparse,3=solid,4=skirt/brim,5=support,6=raft,7=gap,8=thin,9=bridge,10=iron,11=prime)
export const TYPE_COLOR = {
  0: [0.42, 0.45, 0.50], 1: [0.85, 0.51, 0.17], 2: [0.21, 0.45, 0.76],
  3: [0.35, 0.75, 0.85], 4: [0.16, 0.68, 0.40], 5: [0.66, 0.42, 0.85], 6: [0.55, 0.45, 0.35],
  7: [0.95, 0.85, 0.25], 8: [0.90, 0.35, 0.65], 9: [0.90, 0.25, 0.25],
  10: [0.60, 0.82, 0.55], 11: [0.30, 0.72, 0.70],
}
// Per-extruder colors for the Filament view. Positional, not semantic: the toolpath stream carries a tool index and
//  nothing about the material, so this is a categorical palette (distinct in hue *and* lightness, so the regions stay
//  tellable apart on a mono display). Indexed modulo its length — a machine may have more extruders than entries.
export const TOOL_COLOR = [
  [0.85, 0.28, 0.25], [0.20, 0.52, 0.85], [0.25, 0.72, 0.38], [0.96, 0.74, 0.16],
  [0.62, 0.36, 0.82], [0.18, 0.74, 0.74], [0.95, 0.50, 0.15], [0.55, 0.56, 0.60],
]

// '#rgb'/'#rrggbb' -> [r,g,b] in 0..1, or null when it is not a colour at all. The Filament view prefers the user's
//  own filament colours over the categorical palette above — upstream does the same (GCodeViewer.cpp reads
//  `filament_colour` straight into set_tool_colors), and a preview that paints T1 red while the filament chip is
//  blue is the one thing that view must never do. TOOL_COLOR stays as the fallback for a tool with no colour set.
export function hexToRgb(hex) {
  const raw = String(hex ?? '').trim().replace(/^#/, '')
  if (raw.length !== 3 && raw.length !== 6) return null
  const full = raw.length === 3 ? raw.split('').map(d => d + d).join('') : raw
  const channels = [0, 2, 4].map(o => parseInt(full.slice(o, o + 2), 16) / 255)
  return channels.some(Number.isNaN) ? null : channels
}

export function packColor(c) {   // [r,g,b] 0..1 -> r<<16|g<<8|b (inverse of the upstream decode_color; exact in f32 below 2^24)
  const r = Math.round(c[0] * 255), g = Math.round(c[1] * 255), b = Math.round(c[2] * 255)
  return (r << 16) | (g << 8) | b
}

// S6.3: role-share legend data — length % per type (the kernel does not expose time per role -> approximated by length share, documented).
export const TYPE_LABEL = { 1: 'Wall', 2: 'Sparse', 3: 'Solid', 4: 'Skirt', 5: 'Support', 6: 'Raft', 7: 'Gap fill', 8: 'Thin wall', 9: 'Bridge', 10: 'Ironing', 11: 'Prime' }

// ── View-type coloring (upstream libvgcode ColorRange approach) ───────────────
//  DEFAULT_RANGES_COLORS (src/libvgcode/include/ColorRange.hpp:14) — a blue-to-red 11-color heatmap.
export const DEFAULT_RANGES_COLORS = [
  [11, 44, 122], [19, 89, 133], [28, 136, 145], [4, 214, 15], [170, 242, 0], [252, 249, 3],
  [245, 206, 10], [227, 136, 32], [209, 104, 48], [194, 82, 60], [148, 38, 22],
].map(c => [c[0] / 255, c[1] / 255, c[2] / 255])
// Upstream ColorRange::get_color_at (Linear): step=(hi-lo)/(N-1), t=(v-lo)/step, lerp between adjacent palette colors.
export function rangeColorAt(v, lo, hi, pal) {
  const N = pal.length
  if (!(hi > lo)) return pal[0]
  const step = (hi - lo) / (N - 1)
  const gt = (v - lo) / step
  const li = Math.max(0, Math.min(N - 1, Math.floor(gt)))
  const hiI = Math.max(0, Math.min(N - 1, li + 1))
  const f = gt - li
  const a = pal[li], b = pal[hiI]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}
