// G-code -> kernel-shaped layer stream. Lets the GPU toolpath renderer draw an external .gcode file
//  (or the kernel's own output) without slicing: parseGcode(text) returns layers[{z, paths, widths}] in the
//  exact contract buildSegmentData consumes (paths stride 8: [x0,y0,z0,enc, x1,y1,z1,enc], enc = role + tool*16,
//  widths one entry per segment — see toolpath_segments.js).
// Recognized input: G0/G1 linear moves, G2/G3 I/J arcs, G90/G91, M82/M83, G92, T<n> tool changes,
//  and the role/layer comment conventions of OrcaSlicer/PrusaSlicer (;TYPE: ;WIDTH: ;LAYER_CHANGE ;Z:),
//  Cura (;TYPE: ;LAYER:) and this kernel ("; LAYER n Zx.xxx", "; walls"-style feature markers).
// Roles the stream cannot state are recovered lossily: unknown ;TYPE: names fall back to wall(1), and when no
//  ;WIDTH: comment is present the bead width is derived from E (filament cross-section · ΔE = width · height · length).
// ponytail: no R-form arcs (I/J only — neither Orca, Prusa, Cura nor this kernel emits R), no G10/G11
//  firmware retract, no vase-mode layer splitting for comment-less files; extend when such a file actually shows up.

const EPS = 1e-6
const ROLE = {
  // OrcaSlicer / PrusaSlicer ;TYPE: names
  'outer wall': 1, 'external perimeter': 1, 'inner wall': 1, 'perimeter': 1, 'internal perimeter': 1,
  'overhang wall': 1, 'overhang perimeter': 1, 'sparse infill': 2, 'internal infill': 2,
  'solid infill': 3, 'internal solid infill': 3, 'top solid infill': 3, 'top surface': 3, 'bottom surface': 3,
  'skirt': 4, 'brim': 4, 'skirt/brim': 4,
  'support': 5, 'support material': 5, 'support material interface': 5, 'support interface': 5, 'support transition': 5,
  'raft': 6, 'gap fill': 7, 'gap infill': 7, 'thin wall': 8,
  'bridge': 9, 'bridge infill': 9, 'internal bridge': 9, 'internal bridge infill': 9,
  'ironing': 10, 'prime tower': 11, 'wipe tower': 11, 'custom': 1,
  // Cura ;TYPE: names
  'wall-outer': 1, 'wall-inner': 1, 'fill': 2, 'skin': 3, 'support-interface': 5, 'prime-tower': 11,
}
// This kernel's own free-form feature comments ("; walls (Arachne — ...)"), longest key first.
const KERNEL_MARK = [
  ['skirt/brim', 4], ['skirt', 4], ['walls', 1], ['thin-wall', 8], ['gap-fill', 7],
  ['bridge', 9], ['ironing', 10], ['support', 5], ['prime tower', 11], ['wipe_tower_real', 11],
]
// The key must be the whole comment or end at a word boundary. A plain prefix test is wrong: this kernel's header
//  carries "; skirt=1@2.0mm brim=0.0mm …", which starts with "skirt" while describing settings, not a feature —
//  measured, it stamped every segment in the file as skirt because the header runs before the first layer.
const markMatches = (comment, key) =>
  comment === key || key.length < comment.length && ' (:/'.includes(comment[key.length]) && comment.startsWith(key)
// PrusaSlicer's `;_EXTRUSION_ROLE:<n>` tag (GCodeExtrusionRole), which this kernel emits too when tag mode is on
//  (gcode_writer.h pe_begin_run). Exact and per-run, unlike the free-form comments above — so it wins when present.
const PE_ROLE = {
  1: 1, 2: 1, 3: 1, 4: 2, 5: 3, 6: 3, 7: 3, 8: 10, 9: 9, 10: 9, 11: 7,
  12: 4, 13: 4, 14: 5, 15: 5, 16: 5, 17: 11,
}

// parseGcode(text, {filamentDiameter=1.75, defaultLayerHeight=0.2}) ->
//   { layers: [{z, paths: Float32Array, widths: Float32Array}], stats: {layers, path_segments, travel_segments, tools} }
export function parseGcode(text, opts = {}) {
  const filArea = Math.PI / 4 * (opts.filamentDiameter > 0 ? opts.filamentDiameter : 1.75) ** 2
  const defH = opts.defaultLayerHeight > 0 ? opts.defaultLayerHeight : 0.2

  let x = 0, y = 0, z = 0, e = 0, absXYZ = true, absE = true   // RepRap defaults: G90 + M82
  let tool = 0, role = 1, width = 0                            // width 0 -> derive from E per segment
  let cur = null                                               // open layer {z, p:[], w:[]}
  const layers = []
  let markerMode = false                                       // a layer-change comment was seen -> trust markers only
  let pendingLayer = true                                      // next extrusion (or ;Z:) opens a layer
  let pendingZ = NaN
  let nSeg = 0, nTravel = 0, filament = 0
  const tools = new Set([0])

  // A layer change resets the role and the width back to "unstated". They are per-run markers: this kernel writes
  //  "; skirt" once, for the skirt of layer 0, and nothing afterwards — carrying that across the whole file painted
  //  every layer as skirt. Unstated means wall(1) for the role and E-derived for the width.
  const openLayer = (lz) => {
    cur = { z: lz, p: [], w: [] }; layers.push(cur)
    pendingLayer = false; pendingZ = NaN; role = 1; width = 0
  }
  const prevLayerZ = () => (layers.length > 1 ? layers[layers.length - 2].z : 0)

  const pushSeg = (x0, y0, z0, x1, y1, z1, dE) => {
    const dist = Math.hypot(x1 - x0, y1 - y0, z1 - z0)
    if (dist < EPS) return
    if (dE > EPS) {                                            // extrusion
      filament += dE
      if (pendingLayer) openLayer(Number.isNaN(pendingZ) ? z1 : pendingZ)
      else if (!markerMode && z1 > cur.z + 1e-3) openLayer(z1) // comment-less fallback: new layer on z rise
      const enc = role + tool * 16
      cur.p.push(x0, y0, z0, enc, x1, y1, z1, enc)
      const h = Math.max(0.02, cur.z - prevLayerZ() || defH)
      // Inverse of the upstream rounded-rectangle bead: cross-section = h·(w − h·(1−π/4))  ->  w = A/h + h·(1−π/4)
      const w = width > 0 ? width : dE * filArea / (dist * h) + h * (1 - Math.PI / 4)
      cur.w.push(Math.min(3, Math.max(0.05, w)))
      nSeg++
    } else if (cur) {                                          // travel (drop pre-first-layer homing moves)
      cur.p.push(x0, y0, z0, tool * 16, x1, y1, z1, tool * 16)
      cur.w.push(0)
      nTravel++
    }
  }

  for (const rawLine of text.split('\n')) {
    const ci = rawLine.indexOf(';')
    const code = (ci < 0 ? rawLine : rawLine.slice(0, ci)).trim()
    const comment = ci < 0 ? '' : rawLine.slice(ci + 1).trim()

    if (comment && !code) {
      const cl = comment.toLowerCase()
      if (cl.startsWith('type:')) { role = ROLE[cl.slice(5).trim()] ?? 1; continue }
      if (cl.startsWith('_extrusion_role:')) { role = PE_ROLE[parseInt(cl.slice(16), 10)] ?? 1; continue }
      if (cl.startsWith('width:')) { const v = parseFloat(cl.slice(6)); width = v > 0 ? v : 0; continue }
      if (cl.startsWith('layer_change') || cl.startsWith('layer:')) { markerMode = true; pendingLayer = true; continue }
      if (cl.startsWith('z:')) { const v = parseFloat(cl.slice(2)); if (pendingLayer && v > 0) { markerMode = true; openLayer(v) } continue }
      const km = /^layer \d+ z([-\d.]+)/.exec(cl)              // this kernel: "; LAYER 12 Z2.600"
      if (km) { markerMode = true; openLayer(parseFloat(km[1])); continue }
      const feat = KERNEL_MARK.find(([k]) => markMatches(cl, k))
      if (feat) role = feat[1]
      continue
    }
    if (!code) continue

    const words = code.split(/\s+/)
    const cmd = words[0].toUpperCase()
    if (cmd === 'G90') { absXYZ = true; continue }
    if (cmd === 'G91') { absXYZ = false; continue }
    if (cmd === 'M82') { absE = true; continue }
    if (cmd === 'M83') { absE = false; continue }
    if (/^T\d+$/.test(cmd)) { tool = parseInt(cmd.slice(1), 10); tools.add(tool); continue }

    if (cmd === 'G92' || cmd === 'G0' || cmd === 'G1' || cmd === 'G2' || cmd === 'G3') {
      let nx = NaN, ny = NaN, nz = NaN, ne = NaN, ai = 0, aj = 0
      for (let wi = 1; wi < words.length; wi++) {
        const L = words[wi][0], v = parseFloat(words[wi].slice(1))
        if (Number.isNaN(v)) continue
        if (L === 'X' || L === 'x') nx = v; else if (L === 'Y' || L === 'y') ny = v
        else if (L === 'Z' || L === 'z') nz = v; else if (L === 'E' || L === 'e') ne = v
        else if (L === 'I' || L === 'i') ai = v; else if (L === 'J' || L === 'j') aj = v
      }
      if (cmd === 'G92') {                                     // set position, no motion
        if (!Number.isNaN(nx)) x = nx; if (!Number.isNaN(ny)) y = ny
        if (!Number.isNaN(nz)) z = nz; if (!Number.isNaN(ne)) e = ne
        continue
      }
      const x1 = Number.isNaN(nx) ? x : (absXYZ ? nx : x + nx)
      const y1 = Number.isNaN(ny) ? y : (absXYZ ? ny : y + ny)
      const z1 = Number.isNaN(nz) ? z : (absXYZ ? nz : z + nz)
      const dE = Number.isNaN(ne) ? 0 : (absE ? ne - e : ne)
      if (cmd === 'G2' || cmd === 'G3') {                      // I/J arc -> chords (≈0.3mm, capped)
        const cx = x + ai, cy = y + aj
        const r = Math.hypot(x - cx, y - cy)
        const a0 = Math.atan2(y - cy, x - cx)
        let a1 = Math.atan2(y1 - cy, x1 - cx)
        const ccw = cmd === 'G3'
        if (ccw && a1 <= a0 + EPS) a1 += 2 * Math.PI
        if (!ccw && a1 >= a0 - EPS) a1 -= 2 * Math.PI
        const n = Math.max(1, Math.min(360, Math.ceil(Math.abs(a1 - a0) * r / 0.3)))
        let px = x, py = y, pz = z
        for (let s = 1; s <= n; s++) {
          const a = a0 + (a1 - a0) * s / n
          const qx = s === n ? x1 : cx + r * Math.cos(a), qy = s === n ? y1 : cy + r * Math.sin(a)
          const qz = z + (z1 - z) * s / n
          pushSeg(px, py, pz, qx, qy, qz, dE / n)
          px = qx; py = qy; pz = qz
        }
      } else {
        pushSeg(x, y, z, x1, y1, z1, dE)
      }
      x = x1; y = y1; z = z1; if (!Number.isNaN(ne)) e = absE ? ne : e + ne
    }
  }

  // `filament_mm` / `path_segments` / `layers` carry the kernel's own stat names, so a parsed result drops straight
  //  into the places a slice result goes (StatsCard reads stats.filament_mm). Time is NOT derived: an estimate needs
  //  the machine's acceleration limits, which G-code does not carry.
  return {
    layers: layers.map(L => ({ z: L.z, paths: Float32Array.from(L.p), widths: Float32Array.from(L.w) })),
    stats: {
      layers: layers.length, path_segments: nSeg, travel_segments: nTravel,
      filament_mm: filament, tools: [...tools].sort((a, b) => a - b),
    },
  }
}
