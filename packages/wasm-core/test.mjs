// node self-test (track C stage 3): cube (binary + ASCII) + table (overhang) -> slice() -> invariant checks.
//   Run: node reverse_engineering/wasm-core/test.mjs   (final judgement still comes from the browser / vite preview)
import createSlicer from '../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// --- Box geometry ---
function boxFaces(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]]
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  return { v, f }
}
export function makeBoxSTL(sx, sy, sz) {              // binary cube
  const { v, f } = boxFaces(sx, sy, sz)
  const buf = Buffer.alloc(84 + f.length * 50)
  buf.writeUInt32LE(f.length, 80)
  let off = 84
  for (const face of f) {
    off += 12
    for (const idx of face) { buf.writeFloatLE(v[idx][0], off); buf.writeFloatLE(v[idx][1], off + 4); buf.writeFloatLE(v[idx][2], off + 8); off += 12 }
    buf.writeUInt16LE(0, off); off += 2
  }
  return buf
}
export function makeAsciiBoxSTL(sx, sy, sz) {         // ASCII cube
  const { v, f } = boxFaces(sx, sy, sz)
  let s = 'solid cube\n'
  for (const face of f) {
    s += ' facet normal 0 0 0\n  outer loop\n'
    for (const idx of face) s += `   vertex ${v[idx][0]} ${v[idx][1]} ${v[idx][2]}\n`
    s += '  endloop\n endfacet\n'
  }
  s += 'endsolid cube\n'
  return Buffer.from(s, 'utf8')
}
// Box triangles in absolute coordinates (for assembling the overhang table)
function boxTris(ox, oy, oz, sx, sy, sz) {
  const { v, f } = boxFaces(sx, sy, sz)
  return f.map(fc => fc.map(i => [v[i][0] + ox, v[i][1] + oy, v[i][2] + oz]))
}
// Table / T shape (overhang): a wide 20x20x4 cap on a narrow 6x6x10 column -> the cap's underside overhangs into thin air
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0], off); buf.writeFloatLE(p[1], off + 4); buf.writeFloatLE(p[2], off + 8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
  return buf
}
export function makeTableSTL() {
  return trisToSTL([...boxTris(7, 7, 0, 6, 6, 10), ...boxTris(0, 0, 10, 20, 20, 4)])
}
// Cylinder (for arc fitting checks) — with the side split into segments the wall becomes an arc
export function makeCylinderSTL(r, h, seg) {
  const tris = [], top = h, bot = 0
  for (let i = 0; i < seg; i++) {
    const a0 = 2 * Math.PI * i / seg, a1 = 2 * Math.PI * (i + 1) / seg
    const x0 = r * Math.cos(a0), y0 = r * Math.sin(a0), x1 = r * Math.cos(a1), y1 = r * Math.sin(a1)
    tris.push([[x0, y0, bot], [x1, y1, bot], [x1, y1, top]])
    tris.push([[x0, y0, bot], [x1, y1, top], [x0, y0, top]])
    tris.push([[0, 0, bot], [x1, y1, bot], [x0, y0, bot]])
    tris.push([[0, 0, top], [x0, y0, top], [x1, y1, top]])
  }
  return trisToSTL(tris)
}
// Models for stage 5 -------------------------------------------------------------
// Thin cross (thin wall): a thick hub (3x3, >=2w) with 4 thin arms (0.6mm ≈ 1.5w). Hub = 2 wall loops, arms = a single center line.
export function makeCrossSTL() {
  const hub = 3, arm = 0.6, len = 5, h = 3
  return trisToSTL([
    ...boxTris(-hub / 2, -hub / 2, 0, hub, hub, h),
    ...boxTris(hub / 2, -arm / 2, 0, len, arm, h),
    ...boxTris(-hub / 2 - len, -arm / 2, 0, len, arm, h),
    ...boxTris(-arm / 2, hub / 2, 0, arm, len, h),
    ...boxTris(-arm / 2, -hub / 2 - len, 0, arm, len, h),
  ])
}
// Thin ring/tube (gap fill): a square frame with 2.5w (≈1.05mm) walls -> 1 wall loop + a 0.5w leftover gap.
export function makeRingSTL() {
  const w = 0.42, th = 2.5 * w, outer = 10, h = 3
  return trisToSTL([
    ...boxTris(-outer / 2, -outer / 2, 0, outer, th, h),
    ...boxTris(-outer / 2, outer / 2 - th, 0, outer, th, h),
    ...boxTris(-outer / 2, -outer / 2 + th, 0, th, outer - 2 * th, h),
    ...boxTris(outer / 2 - th, -outer / 2 + th, 0, th, outer - 2 * th, h),
  ])
}
// L shape (wall-avoiding travel): a concave notch -> a straight travel between the arms crosses the outer wall.
export function makeLShapeSTL() {
  return trisToSTL([...boxTris(0, 0, 0, 24, 8, 4), ...boxTris(0, 0, 0, 8, 24, 4)])
}
// Two boxes side by side (multi-material): the first 12 triangles = group 0, the next 12 = group 1 (split=12).
export function makeTwoBoxSTL() {
  const A = boxTris(0, 0, 0, 10, 10, 6), B = boxTris(16, 0, 0, 10, 10, 6)
  return { stl: trisToSTL([...A, ...B]), split: A.length }
}

// Three boxes in triangle order, one per extruder — the N-way grouping fixture.
export function makeThreeBoxSTL() {
  const A = boxTris(0, 0, 0, 10, 10, 6), B = boxTris(16, 0, 0, 10, 10, 6), C = boxTris(32, 0, 0, 10, 10, 6)
  return { stl: trisToSTL([...A, ...B, ...C]), splits: [A.length, A.length + B.length] }
}

const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0,
  print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60,
  top_shell_layers: 4, bottom_shell_layers: 3, skirt_loops: 1, skirt_distance: 2, brim_width: 0,
  retract_length: 0.8, retract_speed: 30, z_hop: 0.4, infill_angle: 45,
}

let failed = 0
function ok(cond, msg) { if (!cond) { console.error('  FAIL:', msg); failed++ } else console.log('  ok:', msg) }
function countByType(paths) { const c = {0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0,11:0}; for (let i = 0; i < paths.length; i += 8) c[paths[i+3]]++; return c }
const typeTotal = (r, t) => r.layers.reduce((a, Ly) => a + countByType(Ly.paths)[t], 0)
const topLayerWithType = (r, t) => { let top = -1; r.layers.forEach((Ly, i) => { if (countByType(Ly.paths)[t] > 0) top = i }); return top }

const Module = await createSlicer()
const here = dirname(fileURLToPath(import.meta.url))
const stlBin = makeBoxSTL(20, 20, 20)
writeFileSync(join(here, 'cube20.stl'), stlBin)
writeFileSync(join(here, 'cube20_ascii.stl'), makeAsciiBoxSTL(20, 20, 20))
writeFileSync(join(here, 'table.stl'), makeTableSTL())

let progressCalls = 0, lastDone = 0, lastTotal = 0
const onProgress = (done, total) => { progressCalls++; lastDone = done; lastTotal = total }

const r = Module.slice(new Uint8Array(stlBin), JSON.stringify(params), onProgress)
if (r.error) { console.error('FAIL: slice error:', r.error); process.exit(1) }
const expected = Math.round(20 / params.layer_height)
console.log(`[cube] layers=${r.stats.layers}, segments=${r.stats.path_segments}, filament=${r.stats.filament_mm.toFixed(2)}mm, progress=${progressCalls}`)

// ===== The original 22 (stage 2) — kept =====
ok(Math.abs(r.stats.layers - expected) <= 1, `layer count ${r.stats.layers} within ±1 of ${expected}`)
ok(r.stats.path_segments > 0, `path_segments > 0 (${r.stats.path_segments})`)
ok(r.stats.filament_mm > 0, `total filament > 0 (${r.stats.filament_mm.toFixed(2)}mm)`)
ok(/G1 [^\n]*E[0-9]/.test(r.gcode), 'G-code contains G1 ... E<num> extrusion lines')
ok(r.gcode.includes('M83'), 'G-code has relative-E (M83)')
ok(r.layers.length === r.stats.layers, 'layers array length == stats.layers')
let wallFound = false, infillFound = false
for (const Ly of r.layers) { const c = countByType(Ly.paths); if (c[1]) wallFound = true; if (c[2] || c[3]) infillFound = true }
ok(wallFound, 'toolpaths contain wall segments (type=1)')
ok(infillFound, 'toolpaths contain infill segments (type=2/3)')
const nL = r.layers.length
const infillCount = (Ly) => { const c = countByType(Ly.paths); return c[2] + c[3] }
const solidCount = (Ly) => countByType(Ly.paths)[3]
const midMid = Math.floor(nL / 2)
const midInfill = infillCount(r.layers[midMid])
for (const li of [0, 1, 2]) ok(solidCount(r.layers[li]) > 0, `bottom shell layer ${li} solid (type=3): ${solidCount(r.layers[li])}`)
for (const li of [nL-1, nL-2, nL-3]) ok(solidCount(r.layers[li]) > 0, `top shell layer ${li} solid (type=3): ${solidCount(r.layers[li])}`)
ok(infillCount(r.layers[0]) > midInfill * 2, `layer0 infill density (${infillCount(r.layers[0])}) >> mid (${midInfill})`)
ok(solidCount(r.layers[midMid]) === 0, `mid layer ${midMid} sparse only`)
ok(countByType(r.layers[0].paths)[4] > 0, `layer 0 skirt (type=4): ${countByType(r.layers[0].paths)[4]}`)
ok(/^; skirt/m.test(r.gcode), 'G-code has "; skirt" marker')
const glines = r.gcode.split('\n')
ok(glines.some((l, i) => /^G1 Z[\d.]+ F\d+$/.test(l) && /^G0 /.test(glines[i + 1] || '')), 'z_hop: G1 Z lift precedes G0 travel')
ok(progressCalls > 0 && lastDone === lastTotal, `progress 100% (${lastDone}/${lastTotal})`)
const rA = Module.slice(new Uint8Array(makeAsciiBoxSTL(20, 20, 20)), JSON.stringify(params), onProgress)
ok(rA.stats.layers === r.stats.layers, `ASCII same layer count (${rA.stats.layers})`)
ok(Math.abs(rA.stats.filament_mm - r.stats.filament_mm) < 0.5, `ASCII same filament`)

// ===== New in stage 3 =====
console.log('\n[stage3]')
// A cube has vertical walls -> no support (defaults: enable_support=false, raft=0, bed=256)
ok(typeTotal(r, 5) === 0, `cube (default) has no support (type5=0)`)

// --- Support: the overhang table ---
const supP = { ...params, enable_support: true, support_threshold_angle: 30, support_density: 0.15, support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2 }
const rSup = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(supP), () => {})
const rNo  = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, enable_support: false }), () => {})
if (rSup.error) { console.error('FAIL: table slice error', rSup.error); process.exit(1) }
console.log(`  table layers=${rSup.stats.layers}, support(type5) total=${typeTotal(rSup, 5)}, topSupLayer=${topLayerWithType(rSup, 5)}`)
// (1) Support exists in the z band under the overhang (cap = z10, ~layer 49), and never inside or above the cap
ok(typeTotal(rSup, 5) > 0, `overhang model generates support (type5=${typeTotal(rSup, 5)})`)
const belowCap = rSup.layers.filter(L => L.z > 2 && L.z < 9.5).some(L => countByType(L.paths)[5] > 0)
ok(belowCap, 'support present in layers below the overhang (2<z<9.5)')
const topCapNoSup = [rSup.layers.length-1, rSup.layers.length-2].every(i => countByType(rSup.layers[i].paths)[5] === 0)
ok(topCapNoSup, 'no support inside the solid cap (top layers type5=0)')
ok(/^; support/m.test(rSup.gcode), 'G-code has "; support" marker')
// (2) Higher support_top_z_distance -> larger contact z gap -> the support top sits lower
const rGap = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_top_z_distance: 0.6 }), () => {})
ok(topLayerWithType(rGap, 5) < topLayerWithType(rSup, 5),
   `larger top_z_distance lowers support top (gap0.6 top=${topLayerWithType(rGap, 5)} < gap0.2 top=${topLayerWithType(rSup, 5)})`)
// ③ enable_support=false → type5 == 0
ok(typeTotal(rNo, 5) === 0, `enable_support=false → no support (type5=${typeTotal(rNo, 5)})`)

// --- Raft ---
const rRaft = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, raft_layers: 2 }), () => {})
ok(rRaft.stats.raft_layers === 2 && rRaft.stats.model_layers === r.stats.model_layers,
   `raft_layers=2, model_layers=${rRaft.stats.model_layers} (== no-raft ${r.stats.model_layers})`)
ok(countByType(rRaft.layers[0].paths)[6] > 0 && countByType(rRaft.layers[1].paths)[6] > 0,
   `first 2 layers are raft (type6): ${countByType(rRaft.layers[0].paths)[6]}, ${countByType(rRaft.layers[1].paths)[6]}`)
ok(/^; raft/m.test(rRaft.gcode), 'G-code has "; raft" marker')
ok(rRaft.layers[2].z > 0.5 && r.layers[0].z < 0.5,
   `model z shifted up by raft (raft model layer0 z=${rRaft.layers[2].z.toFixed(2)} vs no-raft ${r.layers[0].z.toFixed(2)})`)
ok(rRaft.layers.length === rRaft.stats.layers, `raft: layers array (${rRaft.layers.length}) == stats.layers (${rRaft.stats.layers})`)

// --- Bed parameterization ---
const rBed = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, bed_width: 200, bed_depth: 200 }), () => {})
ok(/off=100\.0,100\.0/.test(rBed.gcode), 'bed 200 → offset 100 (header off=100.0,100.0)')
ok(/off=128\.0,128\.0/.test(r.gcode), 'default bed 256 → offset 128')
// bed200 coordinates sit around 100, bed256 around 128
const firstX = (g) => { const m = g.match(/^G1 X([\d.]+)/m); return m ? parseFloat(m[1]) : NaN }
ok(firstX(rBed.gcode) < 115 && firstX(r.gcode) > 115, `X offset applied (bed200 X=${firstX(rBed.gcode).toFixed(1)} < bed256 X=${firstX(r.gcode).toFixed(1)})`)

// ===== New in stage 4 (path and G-code level) =====
console.log('\n[stage4]')
const g0count = (g) => (g.match(/^G0 /gm) || []).length
// (1) Every infill pattern slices successfully with segments > 0
for (const pat of ['rectilinear', 'grid', 'triangles', 'zigzag', 'gyroid']) {
  const rp = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, sparse_infill_pattern: pat }), () => {})
  ok(!rp.error && rp.stats.path_segments > 0, `pattern ${pat}: slices ok, segments=${rp.error ? 'ERR' : rp.stats.path_segments}`)
}
// (2) zigzag travel < rectilinear
const rRect = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, sparse_infill_pattern: 'rectilinear' }), () => {})
const rZig  = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, sparse_infill_pattern: 'zigzag' }), () => {})
ok(g0count(rZig.gcode) < g0count(rRect.gcode), `zigzag travels (${g0count(rZig.gcode)}) < rectilinear (${g0count(rRect.gcode)})`)

// (3) Cooling fan: 0 on the first layer, then a ramp, then M107
const fanS = [...r.gcode.matchAll(/^M106 S(\d+)$/gm)].map(m => +m[1])
ok(fanS.length > 0 && fanS[0] === 0, `first layer fan = 0 (first M106 S${fanS[0]})`)
ok(fanS.includes(255), `fan ramps to full 255 (distinct: ${[...new Set(fanS)].join(',')})`)
ok(fanS[0] < fanS[fanS.length - 1], `fan monotonic ramp ${fanS[0]}→${fanS[fanS.length - 1]}`)
ok(/^M107$/m.test(r.gcode), 'M107 present (fan off at end)')

// (4) Slowdown: small layers are slowed (default 8s) vs disabled (0)
const layerFeed = (g, li) => {   // F of the layer's first XY extrusion move (skipping retract/unretract E-only lines)
  const lines = g.split('\n'); const k = lines.findIndex(l => l.startsWith(`; LAYER ${li} `)); if (k < 0) return NaN
  for (let j = k + 1; j < lines.length && !lines[j].startsWith('; LAYER'); j++) { const m = lines[j].match(/^G1 X[\d.-]+ Y[\d.-]+ E[\d.]+ F(\d+)$/); if (m) return +m[1] }
  return NaN
}
const rFast = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, slow_down_layer_time: 0 }), () => {})
ok(layerFeed(rFast.gcode, 10) === 3600, `no-slowdown layer10 feed=${layerFeed(rFast.gcode, 10)} (=print 3600)`)
ok(layerFeed(r.gcode, 10) < 3600 && layerFeed(r.gcode, 10) >= 1200, `slowdown layer10 feed=${layerFeed(r.gcode, 10)} (<3600, >=1200 floor)`)

// (5) Arc fitting: cylinder -> G2/G3 present + extrusion volume preserved within ±1%
const cyl = makeCylinderSTL(10, 6, 64)
writeFileSync(join(here, 'cylinder.stl'), cyl)
const rArcOff = Module.slice(new Uint8Array(cyl), JSON.stringify({ ...params, enable_arc_fitting: false }), () => {})
const rArcOn  = Module.slice(new Uint8Array(cyl), JSON.stringify({ ...params, enable_arc_fitting: true }), () => {})
ok(/^G[23] /m.test(rArcOn.gcode), `arc fitting on → G2/G3 present (${(rArcOn.gcode.match(/^G[23] /gm) || []).length} arcs)`)
ok(!/^G[23] /m.test(rArcOff.gcode), 'arc fitting off → no G2/G3')
const arcDev = Math.abs(rArcOn.stats.filament_mm - rArcOff.stats.filament_mm) / rArcOff.stats.filament_mm
ok(arcDev < 0.01, `arc extrusion within ±1% (Δ=${(arcDev * 100).toFixed(3)}%)`)

// (6) Seam position: back = fixed, random = scattered (and deterministic)
const firstWallStart = (layer) => { const p = layer.paths; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 1) return [p[i], p[i + 1]]; return null }
const seamSpread = (res) => {
  const xs = [], ys = []
  for (let li = 5; li < res.layers.length - 5; li++) { const s = firstWallStart(res.layers[li]); if (s) { xs.push(s[0]); ys.push(s[1]) } }
  const sp = a => a.length ? Math.max(...a) - Math.min(...a) : 0
  return sp(xs) + sp(ys)
}
const rBack = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, seam_position: 'back' }), () => {})
const rRand = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, seam_position: 'random' }), () => {})
const rRand2 = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, seam_position: 'random' }), () => {})
ok(seamSpread(rBack) < 1.0, `seam back fixed (spread ${seamSpread(rBack).toFixed(2)}mm)`)
ok(seamSpread(rRand) > 5.0, `seam random dispersed (spread ${seamSpread(rRand).toFixed(2)}mm)`)
ok(rRand.gcode === rRand2.gcode, 'seam random deterministic (identical gcode on rerun)')
ok(/seam=back/.test(r.gcode) && /pattern=rectilinear/.test(r.gcode), 'G-code header carries pattern/seam')

// (7) Spiral (vase): slices successfully and Z rises within a layer
const rSpiral = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, spiral_mode: true }), () => {})
ok(!rSpiral.error && /^G1 X[\d.]+ Y[\d.]+ Z[\d.]+ E/m.test(rSpiral.gcode), 'spiral: extrude moves carry rising Z')

// ===== New in stage 5 (gap fill · thin wall · scarf · pressure advance · tree-lite · bridge) =====
console.log('\n[stage5]')

// (1) Gap fill: a 2.5w ring (0.5w leftover gap) -> type7 present. Absent on a solid cube (backwards compatible).
const rRing = Module.slice(new Uint8Array(makeRingSTL()), JSON.stringify(params), () => {})
ok(!rRing.error && typeTotal(rRing, 7) > 0, `gap-fill on 2.5w ring (type7=${rRing.error ? 'ERR' : typeTotal(rRing, 7)})`)
ok(typeTotal(r, 7) === 0, `solid cube has no gap-fill (type7=${typeTotal(r, 7)})`)

// (2) Thin wall (Arachne-lite): a thin cross -> the arms carry a center line (type8), and the thick hub keeps 2 wall loops.
const rCross = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify(params), () => {})
ok(!rCross.error && typeTotal(rCross, 8) > 0, `thin cross → thin-wall centerline (type8=${rCross.error ? 'ERR' : typeTotal(rCross, 8)})`)
ok(typeTotal(r, 8) === 0, `solid cube has no thin-wall (type8=${typeTotal(r, 8)})`)
// Does the thick hub get a second wall: wall_loops 2 yields more wall segments than 1 (added only on the hub)
const rCross1 = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify({ ...params, wall_loops: 1 }), () => {})
ok(typeTotal(rCross, 1) > typeTotal(rCross1, 1),
   `thick hub takes 2nd wall (wall2 type1=${typeTotal(rCross, 1)} > wall1 type1=${typeTotal(rCross1, 1)})`)

// (3) Scarf seam: seam_slope_type=external -> a ; scarf marker + the seam's z is midway (zE-h < z < zE).
const rScarf = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, seam_slope_type: 'external' }), () => {})
ok(/^; scarf$/m.test(rScarf.gcode), 'scarf: "; scarf" marker present')
ok(!/^; scarf$/m.test(r.gcode), 'no scarf marker when seam_slope_type=none (default)')
const scarfLayerZ = (g, li) => {   // extrusion Z values of layer li
  const lines = g.split('\n'); const k = lines.findIndex(l => l.startsWith(`; LAYER ${li} `)); if (k < 0) return []
  const out = []; for (let j = k + 1; j < lines.length && !lines[j].startsWith('; LAYER'); j++) { const m = lines[j].match(/Z([\d.]+) E/); if (m) out.push(+m[1]) }
  return out
}
const z5 = scarfLayerZ(rScarf.gcode, 5)   // layer5 zE=1.2, h=0.2 -> midway between (1.0, 1.2)
ok(z5.some(z => z > 1.0 + 1e-6 && z < 1.2 - 1e-6), `scarf ramp has intermediate z in (1.0,1.2): ${[...new Set(z5)].filter(z => z > 1.0 && z < 1.2).map(z => z.toFixed(3)).slice(0, 3).join(',')}`)

// (4) Pressure advance: enabled -> M900 K<v> in the preamble; disabled -> absent.
const rPA = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, enable_pressure_advance: true, pressure_advance: 0.045 }), () => {})
ok(/^M900 K0\.045/m.test(rPA.gcode), 'pressure advance: M900 K0.045 present when enabled')
ok(!/^M900/m.test(r.gcode), 'no M900 when pressure advance disabled (default)')

// (5) Tree-lite: tapers downward -> the lower support span < the upper one, narrower at the bottom than grid, and touches down. (overhang table)
const supSpan = (Ly) => { let a = 1e9, b = -1e9, c = 1e9, d = -1e9, n = 0; const p = Ly.paths; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 5) { a = Math.min(a, p[i]); b = Math.max(b, p[i]); c = Math.min(c, p[i + 1]); d = Math.max(d, p[i + 1]); n++ } return n ? Math.max(b - a, d - c) : 0 }
const supLayers = (res) => res.layers.map(Ly => ({ z: Ly.z, span: supSpan(Ly) })).filter(x => x.span > 0)
const rTree = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_style: 'tree_lite' }), () => {})
const rGridS = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_style: 'grid' }), () => {})
const tL = supLayers(rTree), gL = supLayers(rGridS)
const treeTop = tL[tL.length - 1].span, treeBot = tL[0].span, gridBot = gL[0].span
console.log(`  tree spans: top=${treeTop.toFixed(1)} bot=${treeBot.toFixed(1)}  grid bot=${gridBot.toFixed(1)}  tree grounds z=${tL[0].z.toFixed(2)}`)
ok(treeTop > treeBot + 1.0, `tree_lite tapers: top span ${treeTop.toFixed(1)} > bottom span ${treeBot.toFixed(1)} (top > bottom)`)
ok(treeBot < gridBot - 0.5, `tree_lite narrower than grid at bottom (${treeBot.toFixed(1)} < ${gridBot.toFixed(1)})`)
ok(tL[0].z < 1.0, `tree_lite grounds near bed (lowest support z=${tL[0].z.toFixed(2)})`)
// Stage 33: the material comparison was corrected from "segment count" to "real path length".
//  The count is an inaccurate proxy — the narrower the region, the more direction changes and short segments,
//  so the count can rise even when tapering uses less material (measured: 705 vs 704, an inversion). Length is the real material usage.
const supPathLen = (r) => (r.layers || []).reduce((a, Ly) => {
  const p = Ly.paths; if (!p) return a
  let s = 0
  for (let i = 0; i < p.length; i += 8) if (p[i+3] === 5 || p[i+3] === 6) s += Math.hypot(p[i+4]-p[i], p[i+5]-p[i+1])
  return a + s
}, 0)
const tLen = supPathLen(rTree), gLen = supPathLen(rGridS)
ok(tLen <= gLen, `tree_lite uses <= grid support material (path length ${tLen.toFixed(0)}mm <= ${gLen.toFixed(0)}mm)`)

// (6) Bridge: an unsupported bottom (the overhang cap's underside) -> type9 + ; bridge. Table without support. Absent on a solid cube.
const rBridge = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
ok(typeTotal(rBridge, 9) > 0 && /^; bridge/m.test(rBridge.gcode), `unsupported overhang bottom → bridge (type9=${typeTotal(rBridge, 9)})`)
ok(typeTotal(r, 9) === 0, `solid cube has no bridge (type9=${typeTotal(r, 9)})`)

// Backwards compatible: with every stage-5 parameter at its default, the cube result is unchanged (layer count, filament)
const rCompat = Module.slice(new Uint8Array(stlBin), JSON.stringify({
  ...params, seam_slope_type: 'none', enable_pressure_advance: false, support_style: 'grid',
}), () => {})
ok(rCompat.stats.layers === r.stats.layers && Math.abs(rCompat.stats.filament_mm - r.stats.filament_mm) < 1e-6,
   'stage-5 defaults keep cube result unchanged (backward compatible)')

// ===== New in stage 6 (ironing · wall avoidance · PE-lite · multi-material) =====
console.log('\n[stage6]')

// (1) Ironing: type10 exists on the cube's top layer with flow ~10% (comparing E/mm), and is absent when off.
const rIron = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, ironing_type: 'top' }), () => {})
ok(typeTotal(rIron, 10) > 0, `ironing on → top-surface re-pass (type10=${typeTotal(rIron, 10)})`)
ok(typeTotal(r, 10) === 0, `ironing off (default) → no type10 (${typeTotal(r, 10)})`)
const blockEperMM = (g, marker) => {   // E/mm of the first long extrusion in the marker block (position tracked via G0)
  const lines = g.split('\n'); const k = lines.findIndex(l => l.trim() === marker); if (k < 0) return null
  let px = null, py = null
  for (let j = k + 1; j < lines.length && !lines[j].startsWith('; LAYER') && lines[j].trim() !== '; end'; j++) {
    const g0 = lines[j].match(/^G0 X([\d.-]+) Y([\d.-]+)/); if (g0) { px = +g0[1]; py = +g0[2]; continue }
    const m = lines[j].match(/^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/)
    if (m) { const x = +m[1], y = +m[2], e = +m[3]; if (px !== null) { const d = Math.hypot(x - px, y - py); if (d > 1) return e / d } px = x; py = y }
  }
  return null
}
const firstBigE = (g) => { const lines = g.split('\n'); let px = null, py = null; for (const l of lines) { const g0 = l.match(/^G0 X([\d.-]+) Y([\d.-]+)/); if (g0) { px = +g0[1]; py = +g0[2]; continue } const m = l.match(/^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/); if (m) { const x = +m[1], y = +m[2], e = +m[3]; if (px !== null) { const d = Math.hypot(x - px, y - py); if (d > 1) return e / d } px = x; py = y } } return null }
const ironE = blockEperMM(rIron.gcode, '; ironing'), normalE = firstBigE(r.gcode)
ok(ironE && normalE && Math.abs(ironE / normalE - 0.1) < 0.02, `ironing flow ~10% of normal (ratio=${(ironE / normalE).toFixed(3)})`)

// (2) Wall-avoiding travel: on the L shape, reduce_crossing_wall=true lowers the number of travels crossing the outer wall.
const rWoff = Module.slice(new Uint8Array(makeLShapeSTL()), JSON.stringify({ ...params, reduce_crossing_wall: false }), () => {})
const rWon = Module.slice(new Uint8Array(makeLShapeSTL()), JSON.stringify({ ...params, reduce_crossing_wall: true }), () => {})
console.log(`  L-shape wall crossings: off=${rWoff.stats.wall_crossings} on=${rWon.stats.wall_crossings}`)
ok(rWoff.stats.wall_crossings > 0, `L-shape has wall-crossing travels without avoidance (${rWoff.stats.wall_crossings})`)
ok(rWon.stats.wall_crossings < rWoff.stats.wall_crossings, `reduce_crossing_wall lowers crossings (${rWon.stats.wall_crossings} < ${rWoff.stats.wall_crossings})`)

// (3) PE-lite: with slope set, the rate of change in volumetric flow between adjacent extrusions stays within the limit. (overhang table: bridge speed difference)
const maxPEslope = (g) => {   // maximum per-layer rate of change in volumetric flow (mm³/s²) between adjacent extrusions. Tracked across travels, reset at ; LAYER.
  const lines = g.split('\n'); let maxS = 0, curF = null, px = null, py = null, lastFlow = null
  const Adep = 0.2 * (0.42 - 0.2 * (1 - Math.PI / 4))   // deposited cross-section at h0.2 (mm²)
  for (const l of lines) {
    if (l.startsWith('; LAYER')) { lastFlow = null; px = null; py = null; curF = null; continue }
    const g0 = l.match(/^G0 X([\d.-]+) Y([\d.-]+)/); if (g0) { px = +g0[1]; py = +g0[2]; continue }
    const m = l.match(/^G1 X([\d.-]+) Y([\d.-]+) E[\d.]+/); if (!m) continue
    const fm = l.match(/F(\d+)/); if (fm) curF = +fm[1]
    const x = +m[1], y = +m[2]
    if (px !== null && curF) { const d = Math.hypot(x - px, y - py); if (d > 0.05) { const v = curF / 60, flow = Adep * v, t = d / v; if (lastFlow !== null && t > 0) { const s = Math.abs(flow - lastFlow) / t; if (s > maxS) maxS = s } lastFlow = flow } }
    px = x; py = y
  }
  return maxS
}
const rPEoff = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
const rPEon = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...params, max_volumetric_extrusion_rate_slope: 40 }), () => {})
const peOff = maxPEslope(rPEoff.gcode), peOn = maxPEslope(rPEon.gcode)
console.log(`  PE flow-slope (mm³/s²): off=${peOff.toFixed(1)} on(limit40)=${peOn.toFixed(1)}`)
ok(peOff > 40, `without PE the flow-slope exceeds limit (${peOff.toFixed(1)} > 40)`)
ok(peOn <= 40 + 1.0, `PE-lite caps flow-slope to limit (${peOn.toFixed(1)} ≤ 40)`)
ok(Math.abs(rPEon.stats.filament_mm - rPEoff.stats.filament_mm) < 1e-6, `PE changes speed not E (filament identical)`)

// (4) Multi-material: T0/T1 + prime tower (type11). The single-material path is unchanged.
const { stl: mmStl, split: mmSplit } = makeTwoBoxSTL()
const rMM = Module.slice(new Uint8Array(mmStl), JSON.stringify({ ...params, extruder_count: 2, mm_group_split: mmSplit }), () => {})
ok(!rMM.error, `multimaterial slices ok (layers=${rMM.error ? 'ERR' : rMM.stats.layers})`)
ok(/^T0$/m.test(rMM.gcode) && /^T1$/m.test(rMM.gcode), `MM has tool changes T0 and T1`)
ok(typeTotal(rMM, 11) > 0, `MM prime tower emitted (type11=${typeTotal(rMM, 11)})`)
// Stage 33: the default switched to the real WipeTower — expect the real path markers and do not accept the fallback (square ring) markers either.
ok(/wipe_tower_real: real ported WipeTower/.test(rMM.gcode), `MM uses real WipeTower by default`)
ok(!/prime tower \(basic/.test(rMM.gcode), `MM does not fall back to the decorative ring`)
// With an explicit opt-out (wipe_tower_real=false) the old square ring path is kept
const rMMring = Module.slice(new Uint8Array(mmStl), JSON.stringify({ ...params, extruder_count: 2, mm_group_split: mmSplit, wipe_tower_real: false }), () => {})
ok(/; prime tower \(basic/.test(rMMring.gcode) && typeTotal(rMMring, 11) > 0, `wipe_tower_real=false keeps the ring fallback`)
const rSingle = Module.slice(new Uint8Array(mmStl), JSON.stringify(params), () => {})
ok(!/^T[01]$/m.test(rSingle.gcode) && typeTotal(rSingle, 11) === 0, `single-material path unchanged (no T0/T1, no prime tower)`)

// Per-extruder filament: two materials mean two temperatures and two flow ratios. Without the arrays the MM
//  output must stay exactly what it was, so the same slice is compared both ways.
const mmBase = { ...params, extruder_count: 2, mm_group_split: mmSplit }
const rMMmat = Module.slice(new Uint8Array(mmStl), JSON.stringify({ ...mmBase,
  extruder_nozzle_temp: [270, 220], extruder_flow_ratio: [0.95, 0.98],
  extruder_retract_length: [0.8, 0.4], extruder_z_hop: [0.4, 0.2] }), () => {})
ok(!rMMmat.error, `per-extruder filament slices ok`)
const startTemp = rMMmat.gcode.match(/^M109 S(\d+)/m)?.[1]
const afterT1 = rMMmat.gcode.split(/^T1$/m)[1] ?? ''
ok(startTemp === '270', `preamble heats to T0's material (M109 S${startTemp}, expected 270)`)
ok(/^M109 S220$/m.test(afterT1), `switching to T1 heats to its own material (M109 S220)`)
ok(/^M109 S270$/m.test(afterT1.split(/^T0$/m)[1] ?? ''), `switching back to T0 restores its temperature`)
ok(Math.abs(rMMmat.stats.filament_mm - rMM.stats.filament_mm) > 1e-6,
   `per-extruder flow ratio changes the extruded amount (${rMMmat.stats.filament_mm.toFixed(2)} vs ${rMM.stats.filament_mm.toFixed(2)} mm)`)
const rMMnoArrays = Module.slice(new Uint8Array(mmStl), JSON.stringify(mmBase), () => {})
ok(rMMnoArrays.gcode === rMM.gcode, `MM without per-extruder arrays is byte-identical to before`)

// N-way grouping: three boxes, one per extruder. A single mm_group_split can only express two groups, so the
//  third box used to be folded into the second and printed with its material.
const { stl: mm3Stl, splits: mm3Splits } = makeThreeBoxSTL()
const r3 = Module.slice(new Uint8Array(mm3Stl), JSON.stringify({ ...params,
  extruder_count: 3, mm_group_splits: mm3Splits, mm_group_tools: [0, 1, 2],
  extruder_nozzle_temp: [270, 220, 240], extruder_flow_ratio: [0.95, 0.98, 1.0] }), () => {})
ok(!r3.error, `three-material slice ok (layers=${r3.error ? 'ERR' : r3.stats.layers})`)
ok(/^T2$/m.test(r3.gcode), `third extruder gets its own tool (T2)`)
ok(/^M109 S240$/m.test(r3.gcode), `third extruder heats to its own material (M109 S240)`)
const temps3 = [...r3.gcode.matchAll(/^M109 S(\d+)$/gm)].map(m => m[1])
ok(new Set(temps3).size === 3, `all three materials reach the G-code (temps: ${[...new Set(temps3)].join(', ')})`)
// The old single-boundary form on the same geometry proves what was broken: T2 never appears.
const r3old = Module.slice(new Uint8Array(mm3Stl), JSON.stringify({ ...params,
  extruder_count: 3, mm_group_split: mm3Splits[0],
  extruder_nozzle_temp: [270, 220, 240] }), () => {})
ok(!/^T2$/m.test(r3old.gcode), `a single boundary still yields two groups only (regression guard)`)

// Backwards compatible: with every stage-6 parameter at its default, the cube result is unchanged
const rCompat6 = Module.slice(new Uint8Array(stlBin), JSON.stringify({
  ...params, ironing_type: 'no ironing', reduce_crossing_wall: false, max_volumetric_extrusion_rate_slope: 0, extruder_count: 1,
}), () => {})
ok(rCompat6.stats.layers === r.stats.layers && Math.abs(rCompat6.stats.filament_mm - r.stats.filament_mm) < 1e-6,
   'stage-6 defaults keep cube result unchanged (backward compatible)')

// ===== New in stage 7 (the real OrcaSlicer Arachne port — variable-width walls) =====
console.log('\n[stage7]')
// Per-segment widths (the parallel widths array) — collecting wall (type1) segments only
const wallWidths = (res) => {
  const out = []
  for (let li = 3; li < res.layers.length - 3; li++) {
    const p = res.layers[li].paths, w = res.layers[li].widths
    if (!w) continue
    let k = 0
    for (let i = 0; i < p.length; i += 8) { if (p[i + 3] === 1 && w[k] > 0) out.push(w[k]); k++ }
  }
  return out
}
const wspan = (a) => a.length ? { min: Math.min(...a), max: Math.max(...a), n: a.length } : { min: 0, max: 0, n: 0 }

// (1) arachne cube: slices fine and the wall width is uniform ≈ w (thick shape)
const rArCube = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const acw = wspan(wallWidths(rArCube))
ok(!rArCube.error && acw.n > 0, `arachne cube slices ok (${rArCube.error ? 'ERR' : 'wall segs ' + acw.n})`)
ok(Math.abs(acw.min - 0.42) < 0.03 && Math.abs(acw.max - 0.42) < 0.03, `arachne cube walls ~uniform w (min=${acw.min.toFixed(3)} max=${acw.max.toFixed(3)})`)

// (2) arachne thin cross: wall width varies (min<max) and the thin arms exceed w (within the 50~150% range)
const rArCross = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const axw = wspan(wallWidths(rArCross))
console.log(`  arachne cross wall width mm: min=${axw.min.toFixed(3)} max=${axw.max.toFixed(3)} n=${axw.n}`)
ok(!rArCross.error && axw.max - axw.min > 0.05, `arachne thin cross → VARIABLE bead width (min=${axw.min.toFixed(3)} < max=${axw.max.toFixed(3)})`)
ok(axw.min >= 0.42 * 0.5 - 1e-3 && axw.max <= 0.42 * 1.5 + 1e-3, `arachne widths within 50–150% of w (${axw.min.toFixed(3)}..${axw.max.toFixed(3)})`)

// (3) E is width-based — E/mm in the arachne wall G-code varies with width (wider segments raise E per unit length)
const wallEperMM = (g) => {
  const lines = g.split('\n'); const out = []; let px = null, py = null, inWall = false
  for (const l of lines) {
    if (l.includes('; walls (Arachne')) { inWall = true; px = null; continue }
    if (l.startsWith(';')) { inWall = false }   // ends at the next feature comment (z-hop G1 Z is a travel, so it is kept)
    const g0 = l.match(/^G0 X([\d.-]+) Y([\d.-]+)/); if (g0) { px = +g0[1]; py = +g0[2]; continue }
    const m = l.match(/^G1 X([\d.-]+) Y([\d.-]+) E([\d.]+)/)
    if (m) { const x = +m[1], y = +m[2], e = +m[3]; if (inWall && px !== null) { const d = Math.hypot(x - px, y - py); if (d > 0.3) out.push(e / d) } px = x; py = y }
  }
  return out
}
const eArr = wallEperMM(rArCross.gcode)
const eSpan = wspan(eArr.filter(x => x > 0))
console.log(`  arachne cross wall E/mm: min=${eSpan.min.toFixed(5)} max=${eSpan.max.toFixed(5)} n=${eSpan.n}`)
ok(eSpan.n > 0 && eSpan.max > eSpan.min * 1.15, `wall E/mm scales with bead width (spread ${eSpan.min.toFixed(4)}→${eSpan.max.toFixed(4)})`)

// (4) Backwards compatible: the default (classic) matches the stage-6 result and widths are uniformly w
ok(typeTotal(rArCube, 1) > 0 && typeTotal(r, 1) > 0, `both classic & arachne emit walls (type1)`)
const rClassicCube = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, wall_generator: 'classic' }), () => {})
ok(rClassicCube.stats.layers === r.stats.layers && Math.abs(rClassicCube.stats.filament_mm - r.stats.filament_mm) < 1e-6,
   'stage-7 default (classic) keeps cube result unchanged (backward compatible)')
const ccw = wspan(wallWidths(rClassicCube))
ok(Math.abs(ccw.min - 0.42) < 1e-2 && Math.abs(ccw.max - 0.42) < 1e-2, `classic widths array = uniform line_width (${ccw.min.toFixed(3)})`)

// ===== New in stage 8 (the real OrcaSlicer Fill pattern port — gyroid TPMS and friends) =====
console.log('\n[stage8]')
const fillCube = makeBoxSTL(30, 30, 20)
const fparams = { ...params, infill_density: 0.20 }
const sparseSegs = (res) => res.layers.reduce((a, Ly) => { const p = Ly.paths; let c = 0; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 2) c++; return a + c }, 0)
// (1) The ported patterns slice successfully with segments > 0 (gyroid/honeycomb/3dhoneycomb/crosshatch/concentric)
for (const pat of ['gyroid', 'honeycomb', '3dhoneycomb', 'crosshatch', 'concentric']) {
  const rp = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fparams, sparse_infill_pattern: pat }), () => {})
  ok(!rp.error && sparseSegs(rp) > 0, `ported Fill '${pat}': slices ok, sparse segs=${rp.error ? 'ERR' : sparseSegs(rp)}`)
}
// (2) Upstream gyroid (TPMS) vs the approximated gyroid: different segment structure
const rGyR = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fparams, sparse_infill_pattern: 'gyroid' }), () => {})
const rGyA = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fparams, sparse_infill_pattern: 'gyroid_approx' }), () => {})
console.log(`  gyroid real segs=${sparseSegs(rGyR)} vs approx segs=${sparseSegs(rGyA)}`)
ok(sparseSegs(rGyR) > 0 && sparseSegs(rGyA) > 0 && sparseSegs(rGyR) !== sparseSegs(rGyA),
   `real gyroid (TPMS) differs from sine-approx (real=${sparseSegs(rGyR)} != approx=${sparseSegs(rGyA)})`)
// (3) gyroid TPMS z phase: the sparse geometry differs between two z levels (the surface phase changes with z)
const gyLayers = rGyR.layers.filter(L => { const p = L.paths; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 2) return true; return false })
const sigOf = (L) => { const p = L.paths; let s = 0, n = 0; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 2) { s += p[i] * 7.3 + p[i + 1] * 3.1; n++ } return n ? s / n : 0 }
const sLo = sigOf(gyLayers[Math.floor(gyLayers.length * 0.3)]).toFixed(3)
const sHi = sigOf(gyLayers[Math.floor(gyLayers.length * 0.7)]).toFixed(3)
console.log(`  gyroid TPMS z-phase: loLayer sig=${sLo} hiLayer sig=${sHi}`)
ok(sLo !== sHi, `real gyroid has TPMS z-phase (geometry varies with z: ${sLo} != ${sHi})`)
// (4) Backwards compatible: gyroid_approx still uses the old sine approximation (present) and rectilinear's default is unchanged
ok(sparseSegs(rGyA) > 0, `gyroid_approx (legacy sine) still available (segs=${sparseSegs(rGyA)})`)

// (5) The real PressureEqualizer port (pe_lite:false): runs without crashing or mangling, preserves total E and keeps the structure.
//  ⚠ The real PE only adjusts flow in g-code tagged with OrcaSlicer's ;_EXTRUDE_SET_SPEED -> it passes straight through our plain mini-kernel g-code.
//  Here we verify that "the port links, runs and does not corrupt the resulting g-code" (the need for tags is recorded as a limitation in the README).
const eSumOf = (g) => { let s = 0; for (const m of g.matchAll(/ E(-?[\d.]+)/g)) s += parseFloat(m[1]); return s }
const rRealPEoff = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
const rRealPE = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...params, max_volumetric_extrusion_rate_slope: 2.0, pe_lite: false }), () => {})
ok(!rRealPE.error && /^; LAYER/m.test(rRealPE.gcode) && /^M104/m.test(rRealPE.gcode), `real PE port runs + preserves g-code structure (; LAYER, M104)`)
ok(Math.abs(eSumOf(rRealPE.gcode) - eSumOf(rRealPEoff.gcode)) < 0.01, `real PE conserves total E (${eSumOf(rRealPE.gcode).toFixed(2)} ≈ ${eSumOf(rRealPEoff.gcode).toFixed(2)})`)
ok(Math.abs(rRealPE.stats.filament_mm - rRealPEoff.stats.filament_mm) < 1e-6, `real PE: filament stat unchanged (speed-only)`)

// ===== New in stage 9 (full real PE integration — OrcaSlicer tag emission + segment splitting) =====
console.log('\n[stage9]')
const g9cube = makeBoxSTL(20, 20, 10)
const g1count = (g) => (g.match(/^G1 /gm) || []).length
const hasTag = (g) => /;_EXTRUDE_SET_SPEED/.test(g) || /;_EXTRUSION_ROLE:/.test(g) || /;_EXTRUDE_END/.test(g)
// (1) emit_pe_tags=true with strip off -> all 3 tag kinds present (OrcaSlicer format)
const r9tags = Module.slice(new Uint8Array(g9cube), JSON.stringify({ ...params, emit_pe_tags: true, pe_strip_tags: false }), () => {})
ok(/;_EXTRUDE_SET_SPEED/.test(r9tags.gcode) && /;_EXTRUSION_ROLE:/.test(r9tags.gcode) && /;_EXTRUDE_END/.test(r9tags.gcode),
   `emit_pe_tags → ;_EXTRUDE_SET_SPEED/;_EXTRUSION_ROLE/;_EXTRUDE_END all present`)
// (2) Defaults -> no tags (backwards compatible)
const r9def = Module.slice(new Uint8Array(g9cube), JSON.stringify(params), () => {})
ok(!hasTag(r9def.gcode), `default: no PE tags emitted (backward compatible)`)
// (3) Real PE (arachne walls = variable flow -> splitting): more G1 lines + total E preserved + tags stripped at the end (strip by default)
const r9off = Module.slice(new Uint8Array(g9cube), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const r9pe = Module.slice(new Uint8Array(g9cube), JSON.stringify({ ...params, wall_generator: 'arachne', max_volumetric_extrusion_rate_slope: 1.0, pe_lite: false }), () => {})
console.log(`  real PE: G1 off=${g1count(r9off.gcode)} on=${g1count(r9pe.gcode)}, E off=${eSumOf(r9off.gcode).toFixed(2)} on=${eSumOf(r9pe.gcode).toFixed(2)}`)
ok(g1count(r9pe.gcode) > g1count(r9off.gcode), `real PE splits/ramps → G1 line count increases (${g1count(r9off.gcode)}→${g1count(r9pe.gcode)})`)
ok(Math.abs(eSumOf(r9pe.gcode) - eSumOf(r9off.gcode)) < 0.05, `real PE conserves total E (${eSumOf(r9pe.gcode).toFixed(2)} ≈ ${eSumOf(r9off.gcode).toFixed(2)})`)
ok(!hasTag(r9pe.gcode), `real PE output: tags stripped by default (clean g-code)`)
// (4) F ramp steps: the split G1 F markers really are inserted
const fRamp = (g) => (g.match(/^G1 F\d+\s*$/gm) || []).length
ok(fRamp(r9pe.gcode) > 0, `real PE inserts feedrate ramp steps (G1 F markers: ${fRamp(r9pe.gcode)})`)

// ===== New in stage 10 (the ported GCodeProcessor time estimate — the upstream trapezoidal planner) =====
console.log('\n[stage10]')
const g10 = makeBoxSTL(20, 20, 10)
// (1) The cube G-code parses successfully with a total time > 0
const t10 = Module.slice(new Uint8Array(g10), JSON.stringify(params), () => {})
ok(!t10.error && typeof t10.stats.time_estimate === 'number' && t10.stats.time_estimate > 0,
   `GCodeProcessor time estimate: total=${t10.stats.time_estimate.toFixed(1)}s (>0)`)
ok(t10.stats.time_moves > 0 && t10.stats.layer_times.length > 0,
   `parsed ${t10.stats.time_moves} moves, ${t10.stats.layer_times.length} layer times`)
// per-layer times sum to total (single write site)
const ltSum = t10.stats.layer_times.reduce((a, b) => a + b, 0)
ok(Math.abs(ltSum - t10.stats.time_estimate) / t10.stats.time_estimate < 0.001,
   `layer_times sum ${ltSum.toFixed(1)} == total ${t10.stats.time_estimate.toFixed(1)}`)
// (2) Faster speed parameters shorten the time (physically consistent direction)
const t10slow = Module.slice(new Uint8Array(g10), JSON.stringify({ ...params, print_speed: 30 }), () => {})
const t10fast = Module.slice(new Uint8Array(g10), JSON.stringify({ ...params, print_speed: 120 }), () => {})
ok(t10fast.stats.time_estimate < t10slow.stats.time_estimate,
   `faster print_speed -> less time (30mm/s=${t10slow.stats.time_estimate.toFixed(0)}s > 120mm/s=${t10fast.stats.time_estimate.toFixed(0)}s)`)
// (3) Parsed filament == the kernel's own calculation (±2%)
const fdelta = Math.abs(t10.stats.filament_mm - t10.stats.time_filament_mm) / t10.stats.filament_mm
ok(fdelta <= 0.02, `parsed filament == kernel stat within 2% (${t10.stats.time_filament_mm.toFixed(1)} vs ${t10.stats.filament_mm.toFixed(1)}, ${(fdelta * 100).toFixed(2)}%)`)
// Time breakdown per role (PE tag mode)
const t10tag = Module.slice(new Uint8Array(g10), JSON.stringify({ ...params, emit_pe_tags: true, pe_strip_tags: false }), () => {})
ok(Object.keys(t10tag.stats.role_times).length > 0,
   `role time breakdown present in tag mode (roles: ${Object.keys(t10tag.stats.role_times).join(',')})`)
// determinism: identical params -> identical estimate
const t10b = Module.slice(new Uint8Array(g10), JSON.stringify(params), () => {})
ok(t10.stats.time_estimate === t10b.stats.time_estimate, `time estimate is deterministic`)

console.log(failed === 0 ? '\nALL NODE TESTS PASSED' : `\n${failed} TEST(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
