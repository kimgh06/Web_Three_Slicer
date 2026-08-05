// node 자체 테스트 (트랙 C 3단계): 큐브(바이너리+ASCII) + 테이블(오버행) → slice() → 불변식 검증.
//   실행: node reverse_engineering/wasm-core/test.mjs   (최종 판정은 브라우저/vite preview)
import createSlicer from '../engine/src/slicer_core.js'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// --- 박스 지오메트리 ---
function boxFaces(sx, sy, sz) {
  const v = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]]
  const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  return { v, f }
}
export function makeBoxSTL(sx, sy, sz) {              // 바이너리 큐브
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
export function makeAsciiBoxSTL(sx, sy, sz) {         // ASCII 큐브
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
// 절대좌표 박스 삼각형 (오버행 테이블 조립용)
function boxTris(ox, oy, oz, sx, sy, sz) {
  const { v, f } = boxFaces(sx, sy, sz)
  return f.map(fc => fc.map(i => [v[i][0] + ox, v[i][1] + oy, v[i][2] + oz]))
}
// 테이블/T (오버행): 좁은 기둥 6×6×10 위에 넓은 캡 20×20×4 → 캡 밑면이 공중 오버행
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0], off); buf.writeFloatLE(p[1], off + 4); buf.writeFloatLE(p[2], off + 8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
  return buf
}
export function makeTableSTL() {
  return trisToSTL([...boxTris(7, 7, 0, 6, 6, 10), ...boxTris(0, 0, 10, 20, 20, 4)])
}
// 원기둥 (아크 피팅 검증용) — 옆면 seg 분할이면 벽이 원호가 됨
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
// 5단계용 모델 ------------------------------------------------------------------
// 얇은 십자(씬월): 두꺼운 허브(3×3, ≥2w) + 얇은 팔 4개(0.6mm≈1.5w). 허브=벽2줄, 팔=중심선1줄.
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
// 얇은 링/튜브(갭필): 벽 두께 2.5w(≈1.05mm) 정사각 프레임 → 벽1줄 + 0.5w 갭 잔여.
export function makeRingSTL() {
  const w = 0.42, th = 2.5 * w, outer = 10, h = 3
  return trisToSTL([
    ...boxTris(-outer / 2, -outer / 2, 0, outer, th, h),
    ...boxTris(-outer / 2, outer / 2 - th, 0, outer, th, h),
    ...boxTris(-outer / 2, -outer / 2 + th, 0, th, outer - 2 * th, h),
    ...boxTris(outer / 2 - th, -outer / 2 + th, 0, th, outer - 2 * th, h),
  ])
}
// L자(벽 회피 트래블): 오목 노치 → 팔 사이 직선 트래블이 외벽 횡단.
export function makeLShapeSTL() {
  return trisToSTL([...boxTris(0, 0, 0, 24, 8, 4), ...boxTris(0, 0, 0, 8, 24, 4)])
}
// 나란한 두 박스(멀티머티리얼): 앞 12삼각형=그룹0, 뒤 12=그룹1 (split=12).
export function makeTwoBoxSTL() {
  const A = boxTris(0, 0, 0, 10, 10, 6), B = boxTris(16, 0, 0, 10, 10, 6)
  return { stl: trisToSTL([...A, ...B]), split: A.length }
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

// ===== 기존 22개 (2단계) — 유지 =====
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

// ===== 3단계 신규 =====
console.log('\n[stage3]')
// 큐브는 수직벽 → 서포트 0 (기본 enable_support=false, raft=0, bed=256)
ok(typeTotal(r, 5) === 0, `cube (default) has no support (type5=0)`)

// --- 서포트: 오버행 테이블 ---
const supP = { ...params, enable_support: true, support_threshold_angle: 30, support_density: 0.15, support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2 }
const rSup = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(supP), () => {})
const rNo  = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, enable_support: false }), () => {})
if (rSup.error) { console.error('FAIL: table slice error', rSup.error); process.exit(1) }
console.log(`  table layers=${rSup.stats.layers}, support(type5) total=${typeTotal(rSup, 5)}, topSupLayer=${topLayerWithType(rSup, 5)}`)
// ① 오버행 아래 z구간(캡=z10, 층~49)에 서포트 존재, 캡 내부/상단엔 없음
ok(typeTotal(rSup, 5) > 0, `overhang model generates support (type5=${typeTotal(rSup, 5)})`)
const belowCap = rSup.layers.filter(L => L.z > 2 && L.z < 9.5).some(L => countByType(L.paths)[5] > 0)
ok(belowCap, 'support present in layers below the overhang (2<z<9.5)')
const topCapNoSup = [rSup.layers.length-1, rSup.layers.length-2].every(i => countByType(rSup.layers[i].paths)[5] === 0)
ok(topCapNoSup, 'no support inside the solid cap (top layers type5=0)')
ok(/^; support/m.test(rSup.gcode), 'G-code has "; support" marker')
// ② support_top_z_distance ↑ → 접촉면 z 간격 ↑ → 서포트 상단이 더 아래
const rGap = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_top_z_distance: 0.6 }), () => {})
ok(topLayerWithType(rGap, 5) < topLayerWithType(rSup, 5),
   `larger top_z_distance lowers support top (gap0.6 top=${topLayerWithType(rGap, 5)} < gap0.2 top=${topLayerWithType(rSup, 5)})`)
// ③ enable_support=false → type5 == 0
ok(typeTotal(rNo, 5) === 0, `enable_support=false → no support (type5=${typeTotal(rNo, 5)})`)

// --- 래프트 ---
const rRaft = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, raft_layers: 2 }), () => {})
ok(rRaft.stats.raft_layers === 2 && rRaft.stats.model_layers === r.stats.model_layers,
   `raft_layers=2, model_layers=${rRaft.stats.model_layers} (== no-raft ${r.stats.model_layers})`)
ok(countByType(rRaft.layers[0].paths)[6] > 0 && countByType(rRaft.layers[1].paths)[6] > 0,
   `first 2 layers are raft (type6): ${countByType(rRaft.layers[0].paths)[6]}, ${countByType(rRaft.layers[1].paths)[6]}`)
ok(/^; raft/m.test(rRaft.gcode), 'G-code has "; raft" marker')
ok(rRaft.layers[2].z > 0.5 && r.layers[0].z < 0.5,
   `model z shifted up by raft (raft model layer0 z=${rRaft.layers[2].z.toFixed(2)} vs no-raft ${r.layers[0].z.toFixed(2)})`)
ok(rRaft.layers.length === rRaft.stats.layers, `raft: layers array (${rRaft.layers.length}) == stats.layers (${rRaft.stats.layers})`)

// --- 베드 파라미터화 ---
const rBed = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, bed_width: 200, bed_depth: 200 }), () => {})
ok(/off=100\.0,100\.0/.test(rBed.gcode), 'bed 200 → offset 100 (header off=100.0,100.0)')
ok(/off=128\.0,128\.0/.test(r.gcode), 'default bed 256 → offset 128')
// bed200 좌표는 100 부근, bed256 은 128 부근
const firstX = (g) => { const m = g.match(/^G1 X([\d.]+)/m); return m ? parseFloat(m[1]) : NaN }
ok(firstX(rBed.gcode) < 115 && firstX(r.gcode) > 115, `X offset applied (bed200 X=${firstX(rBed.gcode).toFixed(1)} < bed256 X=${firstX(r.gcode).toFixed(1)})`)

// ===== 4단계 신규 (경로·G-code 레벨) =====
console.log('\n[stage4]')
const g0count = (g) => (g.match(/^G0 /gm) || []).length
// ① 인필 패턴별 슬라이스 성공 + 세그먼트>0
for (const pat of ['rectilinear', 'grid', 'triangles', 'zigzag', 'gyroid']) {
  const rp = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, sparse_infill_pattern: pat }), () => {})
  ok(!rp.error && rp.stats.path_segments > 0, `pattern ${pat}: slices ok, segments=${rp.error ? 'ERR' : rp.stats.path_segments}`)
}
// ② zigzag 트래블 < rectilinear
const rRect = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, sparse_infill_pattern: 'rectilinear' }), () => {})
const rZig  = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, sparse_infill_pattern: 'zigzag' }), () => {})
ok(g0count(rZig.gcode) < g0count(rRect.gcode), `zigzag travels (${g0count(rZig.gcode)}) < rectilinear (${g0count(rRect.gcode)})`)

// ③ 냉각 팬: 첫 레이어 0, 램프, M107
const fanS = [...r.gcode.matchAll(/^M106 S(\d+)$/gm)].map(m => +m[1])
ok(fanS.length > 0 && fanS[0] === 0, `first layer fan = 0 (first M106 S${fanS[0]})`)
ok(fanS.includes(255), `fan ramps to full 255 (distinct: ${[...new Set(fanS)].join(',')})`)
ok(fanS[0] < fanS[fanS.length - 1], `fan monotonic ramp ${fanS[0]}→${fanS[fanS.length - 1]}`)
ok(/^M107$/m.test(r.gcode), 'M107 present (fan off at end)')

// ④ 슬로다운: 소형 레이어 감속 (기본 8s) vs 비활성(0)
const layerFeed = (g, li) => {   // 레이어의 첫 XY 압출 이동의 F (리트랙션/언리트랙트 E-only 라인 제외)
  const lines = g.split('\n'); const k = lines.findIndex(l => l.startsWith(`; LAYER ${li} `)); if (k < 0) return NaN
  for (let j = k + 1; j < lines.length && !lines[j].startsWith('; LAYER'); j++) { const m = lines[j].match(/^G1 X[\d.-]+ Y[\d.-]+ E[\d.]+ F(\d+)$/); if (m) return +m[1] }
  return NaN
}
const rFast = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, slow_down_layer_time: 0 }), () => {})
ok(layerFeed(rFast.gcode, 10) === 3600, `no-slowdown layer10 feed=${layerFeed(rFast.gcode, 10)} (=print 3600)`)
ok(layerFeed(r.gcode, 10) < 3600 && layerFeed(r.gcode, 10) >= 1200, `slowdown layer10 feed=${layerFeed(r.gcode, 10)} (<3600, >=1200 floor)`)

// ⑤ 아크 피팅: 원기둥 → G2/G3 존재 + 압출량 ±1% 보존
const cyl = makeCylinderSTL(10, 6, 64)
writeFileSync(join(here, 'cylinder.stl'), cyl)
const rArcOff = Module.slice(new Uint8Array(cyl), JSON.stringify({ ...params, enable_arc_fitting: false }), () => {})
const rArcOn  = Module.slice(new Uint8Array(cyl), JSON.stringify({ ...params, enable_arc_fitting: true }), () => {})
ok(/^G[23] /m.test(rArcOn.gcode), `arc fitting on → G2/G3 present (${(rArcOn.gcode.match(/^G[23] /gm) || []).length} arcs)`)
ok(!/^G[23] /m.test(rArcOff.gcode), 'arc fitting off → no G2/G3')
const arcDev = Math.abs(rArcOn.stats.filament_mm - rArcOff.stats.filament_mm) / rArcOff.stats.filament_mm
ok(arcDev < 0.01, `arc extrusion within ±1% (Δ=${(arcDev * 100).toFixed(3)}%)`)

// ⑥ 심 위치: back=고정, random=분산(+결정적)
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

// ⑦ 스파이럴(vase): 슬라이스 성공, Z 가 레이어 내에서 상승
const rSpiral = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, spiral_mode: true }), () => {})
ok(!rSpiral.error && /^G1 X[\d.]+ Y[\d.]+ Z[\d.]+ E/m.test(rSpiral.gcode), 'spiral: extrude moves carry rising Z')

// ===== 5단계 신규 (갭필·씬월·스카프·압력어드밴스·트리라이트·브리지) =====
console.log('\n[stage5]')

// ① 갭필: 2.5w 링(0.5w 잔여 틈) → type7 존재. 솔리드 큐브엔 없음(하위호환).
const rRing = Module.slice(new Uint8Array(makeRingSTL()), JSON.stringify(params), () => {})
ok(!rRing.error && typeTotal(rRing, 7) > 0, `gap-fill on 2.5w ring (type7=${rRing.error ? 'ERR' : typeTotal(rRing, 7)})`)
ok(typeTotal(r, 7) === 0, `solid cube has no gap-fill (type7=${typeTotal(r, 7)})`)

// ② 씬월(Arachne-lite): 얇은 십자 → 팔에 중심선(type8) 존재 + 두꺼운 허브는 벽 2줄.
const rCross = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify(params), () => {})
ok(!rCross.error && typeTotal(rCross, 8) > 0, `thin cross → thin-wall centerline (type8=${rCross.error ? 'ERR' : typeTotal(rCross, 8)})`)
ok(typeTotal(r, 8) === 0, `solid cube has no thin-wall (type8=${typeTotal(r, 8)})`)
// 두꺼운 허브가 2번째 벽을 받는지: wall_loops 2 가 1 보다 벽 세그먼트 많음(허브에서만 추가)
const rCross1 = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify({ ...params, wall_loops: 1 }), () => {})
ok(typeTotal(rCross, 1) > typeTotal(rCross1, 1),
   `thick hub takes 2nd wall (wall2 type1=${typeTotal(rCross, 1)} > wall1 type1=${typeTotal(rCross1, 1)})`)

// ③ Scarf 심: seam_slope_type=external → ; scarf 마커 + 심 구간 z 중간값(zE-h < z < zE).
const rScarf = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, seam_slope_type: 'external' }), () => {})
ok(/^; scarf$/m.test(rScarf.gcode), 'scarf: "; scarf" marker present')
ok(!/^; scarf$/m.test(r.gcode), 'no scarf marker when seam_slope_type=none (default)')
const scarfLayerZ = (g, li) => {   // 레이어 li 의 압출 Z 값들
  const lines = g.split('\n'); const k = lines.findIndex(l => l.startsWith(`; LAYER ${li} `)); if (k < 0) return []
  const out = []; for (let j = k + 1; j < lines.length && !lines[j].startsWith('; LAYER'); j++) { const m = lines[j].match(/Z([\d.]+) E/); if (m) out.push(+m[1]) }
  return out
}
const z5 = scarfLayerZ(rScarf.gcode, 5)   // layer5 zE=1.2, h=0.2 → 중간값 (1.0, 1.2)
ok(z5.some(z => z > 1.0 + 1e-6 && z < 1.2 - 1e-6), `scarf ramp has intermediate z in (1.0,1.2): ${[...new Set(z5)].filter(z => z > 1.0 && z < 1.2).map(z => z.toFixed(3)).slice(0, 3).join(',')}`)

// ④ 압력 어드밴스: enable → 프리앰블 M900 K<v>; 비활성 → 없음.
const rPA = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, enable_pressure_advance: true, pressure_advance: 0.045 }), () => {})
ok(/^M900 K0\.045/m.test(rPA.gcode), 'pressure advance: M900 K0.045 present when enabled')
ok(!/^M900/m.test(r.gcode), 'no M900 when pressure advance disabled (default)')

// ⑤ 트리라이트: 하강 테이퍼 → 아래 서포트 span < 위, grid 대비 아래 좁음, 접지. (오버행 테이블)
const supSpan = (Ly) => { let a = 1e9, b = -1e9, c = 1e9, d = -1e9, n = 0; const p = Ly.paths; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 5) { a = Math.min(a, p[i]); b = Math.max(b, p[i]); c = Math.min(c, p[i + 1]); d = Math.max(d, p[i + 1]); n++ } return n ? Math.max(b - a, d - c) : 0 }
const supLayers = (res) => res.layers.map(Ly => ({ z: Ly.z, span: supSpan(Ly) })).filter(x => x.span > 0)
const rTree = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_style: 'tree_lite' }), () => {})
const rGridS = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...supP, support_style: 'grid' }), () => {})
const tL = supLayers(rTree), gL = supLayers(rGridS)
const treeTop = tL[tL.length - 1].span, treeBot = tL[0].span, gridBot = gL[0].span
console.log(`  tree spans: top=${treeTop.toFixed(1)} bot=${treeBot.toFixed(1)}  grid bot=${gridBot.toFixed(1)}  tree grounds z=${tL[0].z.toFixed(2)}`)
ok(treeTop > treeBot + 1.0, `tree_lite tapers: top span ${treeTop.toFixed(1)} > bottom span ${treeBot.toFixed(1)} (위>아래)`)
ok(treeBot < gridBot - 0.5, `tree_lite narrower than grid at bottom (${treeBot.toFixed(1)} < ${gridBot.toFixed(1)})`)
ok(tL[0].z < 1.0, `tree_lite grounds near bed (lowest support z=${tL[0].z.toFixed(2)})`)
// 33단계: 재료량 비교를 "세그먼트 개수" → "실 경로 길이"로 교정.
//  개수는 대리 지표로 부정확하다 — 좁은 영역일수록 방향 전환이 잦아 짧은 세그먼트가 늘어,
//  테이퍼로 재료가 줄어도 개수는 오히려 늘 수 있다(실측: 705 vs 704 로 역전). 길이가 진짜 재료량이다.
const supPathLen = (r) => (r.layers || []).reduce((a, Ly) => {
  const p = Ly.paths; if (!p) return a
  let s = 0
  for (let i = 0; i < p.length; i += 8) if (p[i+3] === 5 || p[i+3] === 6) s += Math.hypot(p[i+4]-p[i], p[i+5]-p[i+1])
  return a + s
}, 0)
const tLen = supPathLen(rTree), gLen = supPathLen(rGridS)
ok(tLen <= gLen, `tree_lite uses <= grid support material (경로길이 ${tLen.toFixed(0)}mm <= ${gLen.toFixed(0)}mm)`)

// ⑥ 브리지: 무지지 bottom(오버행 캡 밑면) → type9 + ; bridge. 서포트 없이 테이블. 솔리드 큐브엔 없음.
const rBridge = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
ok(typeTotal(rBridge, 9) > 0 && /^; bridge/m.test(rBridge.gcode), `unsupported overhang bottom → bridge (type9=${typeTotal(rBridge, 9)})`)
ok(typeTotal(r, 9) === 0, `solid cube has no bridge (type9=${typeTotal(r, 9)})`)

// 하위호환: 5단계 파라미터 전부 기본값이면 큐브 결과 불변(레이어수·필라멘트)
const rCompat = Module.slice(new Uint8Array(stlBin), JSON.stringify({
  ...params, seam_slope_type: 'none', enable_pressure_advance: false, support_style: 'grid',
}), () => {})
ok(rCompat.stats.layers === r.stats.layers && Math.abs(rCompat.stats.filament_mm - r.stats.filament_mm) < 1e-6,
   'stage-5 defaults keep cube result unchanged (backward compatible)')

// ===== 6단계 신규 (아이어닝·벽회피·PE-lite·멀티머티리얼) =====
console.log('\n[stage6]')

// ① 아이어닝: 큐브 최상층에 type10 존재 + flow ~10%(E/mm 비교) + off 시 부재.
const rIron = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, ironing_type: 'top' }), () => {})
ok(typeTotal(rIron, 10) > 0, `ironing on → top-surface re-pass (type10=${typeTotal(rIron, 10)})`)
ok(typeTotal(r, 10) === 0, `ironing off (default) → no type10 (${typeTotal(r, 10)})`)
const blockEperMM = (g, marker) => {   // marker 블록 첫 장거리 압출의 E/mm (G0로 위치추적)
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

// ② 벽 회피 트래블: L자에서 reduce_crossing_wall=true 시 외벽 횡단 트래블 수 감소.
const rWoff = Module.slice(new Uint8Array(makeLShapeSTL()), JSON.stringify({ ...params, reduce_crossing_wall: false }), () => {})
const rWon = Module.slice(new Uint8Array(makeLShapeSTL()), JSON.stringify({ ...params, reduce_crossing_wall: true }), () => {})
console.log(`  L-shape wall crossings: off=${rWoff.stats.wall_crossings} on=${rWon.stats.wall_crossings}`)
ok(rWoff.stats.wall_crossings > 0, `L-shape has wall-crossing travels without avoidance (${rWoff.stats.wall_crossings})`)
ok(rWon.stats.wall_crossings < rWoff.stats.wall_crossings, `reduce_crossing_wall lowers crossings (${rWon.stats.wall_crossings} < ${rWoff.stats.wall_crossings})`)

// ③ PE-lite: slope 설정 시 인접 압출 체적유량 변화율이 한도 이내. (오버행 테이블: 브리지 속도차)
const maxPEslope = (g) => {   // 레이어별 인접 압출 체적유량 변화율(mm³/s²) 최대. 트래블 넘어 추적, ; LAYER 리셋.
  const lines = g.split('\n'); let maxS = 0, curF = null, px = null, py = null, lastFlow = null
  const Adep = 0.2 * (0.42 - 0.2 * (1 - Math.PI / 4))   // h0.2 증착 단면적(mm²)
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

// ④ 멀티머티리얼: T0/T1 + 프라임 타워(type11). 단일재질 경로는 불변.
const { stl: mmStl, split: mmSplit } = makeTwoBoxSTL()
const rMM = Module.slice(new Uint8Array(mmStl), JSON.stringify({ ...params, extruder_count: 2, mm_group_split: mmSplit }), () => {})
ok(!rMM.error, `multimaterial slices ok (layers=${rMM.error ? 'ERR' : rMM.stats.layers})`)
ok(/^T0$/m.test(rMM.gcode) && /^T1$/m.test(rMM.gcode), `MM has tool changes T0 and T1`)
ok(typeTotal(rMM, 11) > 0, `MM prime tower emitted (type11=${typeTotal(rMM, 11)})`)
// 33단계: 기본값이 실 WipeTower 로 전환 — 실 경로 마커를 기대하고, 폴백(사각링) 마커도 허용하지 않는다.
ok(/wipe_tower_real: real ported WipeTower/.test(rMM.gcode), `MM uses real WipeTower by default`)
ok(!/prime tower \(basic/.test(rMM.gcode), `MM does not fall back to the decorative ring`)
// 명시적 옵트아웃(wipe_tower_real=false)이면 기존 사각링 경로 유지
const rMMring = Module.slice(new Uint8Array(mmStl), JSON.stringify({ ...params, extruder_count: 2, mm_group_split: mmSplit, wipe_tower_real: false }), () => {})
ok(/; prime tower \(basic/.test(rMMring.gcode) && typeTotal(rMMring, 11) > 0, `wipe_tower_real=false keeps the ring fallback`)
const rSingle = Module.slice(new Uint8Array(mmStl), JSON.stringify(params), () => {})
ok(!/^T[01]$/m.test(rSingle.gcode) && typeTotal(rSingle, 11) === 0, `single-material path unchanged (no T0/T1, no prime tower)`)

// 하위호환: 6단계 파라미터 전부 기본값이면 큐브 결과 불변
const rCompat6 = Module.slice(new Uint8Array(stlBin), JSON.stringify({
  ...params, ironing_type: 'no ironing', reduce_crossing_wall: false, max_volumetric_extrusion_rate_slope: 0, extruder_count: 1,
}), () => {})
ok(rCompat6.stats.layers === r.stats.layers && Math.abs(rCompat6.stats.filament_mm - r.stats.filament_mm) < 1e-6,
   'stage-6 defaults keep cube result unchanged (backward compatible)')

// ===== 7단계 신규 (실제 OrcaSlicer Arachne 이식 — 가변폭 벽) =====
console.log('\n[stage7]')
// 세그먼트별 폭(widths 병렬 배열) — 벽(type1) 세그먼트만 수집
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

// ① arachne 큐브: 슬라이스 정상 + 벽 폭 균일 ≈ w (두꺼운 형상)
const rArCube = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const acw = wspan(wallWidths(rArCube))
ok(!rArCube.error && acw.n > 0, `arachne cube slices ok (${rArCube.error ? 'ERR' : 'wall segs ' + acw.n})`)
ok(Math.abs(acw.min - 0.42) < 0.03 && Math.abs(acw.max - 0.42) < 0.03, `arachne cube walls ~uniform w (min=${acw.min.toFixed(3)} max=${acw.max.toFixed(3)})`)

// ② arachne 얇은 십자: 벽 폭 가변(min<max) + 얇은 팔은 w 초과(50~150% 범위)
const rArCross = Module.slice(new Uint8Array(makeCrossSTL()), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const axw = wspan(wallWidths(rArCross))
console.log(`  arachne cross wall width mm: min=${axw.min.toFixed(3)} max=${axw.max.toFixed(3)} n=${axw.n}`)
ok(!rArCross.error && axw.max - axw.min > 0.05, `arachne thin cross → VARIABLE bead width (min=${axw.min.toFixed(3)} < max=${axw.max.toFixed(3)})`)
ok(axw.min >= 0.42 * 0.5 - 1e-3 && axw.max <= 0.42 * 1.5 + 1e-3, `arachne widths within 50–150% of w (${axw.min.toFixed(3)}..${axw.max.toFixed(3)})`)

// ③ E 가 세그먼트 폭 기반 — arachne 벽 G-code 의 E/mm 이 폭 따라 분산(넓은 세그먼트가 단위길이당 E↑)
const wallEperMM = (g) => {
  const lines = g.split('\n'); const out = []; let px = null, py = null, inWall = false
  for (const l of lines) {
    if (l.includes('; walls (Arachne')) { inWall = true; px = null; continue }
    if (l.startsWith(';')) { inWall = false }   // 다음 피처 주석에서 종료 (z-hop G1 Z 는 트래블이라 유지)
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

// ④ 하위호환: 기본(classic)은 6단계 결과와 동일 + widths 는 w 균일
ok(typeTotal(rArCube, 1) > 0 && typeTotal(r, 1) > 0, `both classic & arachne emit walls (type1)`)
const rClassicCube = Module.slice(new Uint8Array(stlBin), JSON.stringify({ ...params, wall_generator: 'classic' }), () => {})
ok(rClassicCube.stats.layers === r.stats.layers && Math.abs(rClassicCube.stats.filament_mm - r.stats.filament_mm) < 1e-6,
   'stage-7 default (classic) keeps cube result unchanged (backward compatible)')
const ccw = wspan(wallWidths(rClassicCube))
ok(Math.abs(ccw.min - 0.42) < 1e-2 && Math.abs(ccw.max - 0.42) < 1e-2, `classic widths array = uniform line_width (${ccw.min.toFixed(3)})`)

// ===== 8단계 신규 (실제 OrcaSlicer Fill 패턴 이식 — gyroid TPMS 등) =====
console.log('\n[stage8]')
const fillCube = makeBoxSTL(30, 30, 20)
const fparams = { ...params, infill_density: 0.20 }
const sparseSegs = (res) => res.layers.reduce((a, Ly) => { const p = Ly.paths; let c = 0; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 2) c++; return a + c }, 0)
// ① 이식 패턴 슬라이스 성공 + 세그먼트>0 (gyroid/honeycomb/3dhoneycomb/crosshatch/concentric)
for (const pat of ['gyroid', 'honeycomb', '3dhoneycomb', 'crosshatch', 'concentric']) {
  const rp = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fparams, sparse_infill_pattern: pat }), () => {})
  ok(!rp.error && sparseSegs(rp) > 0, `ported Fill '${pat}': slices ok, sparse segs=${rp.error ? 'ERR' : sparseSegs(rp)}`)
}
// ② 원본 gyroid(TPMS) vs 근사 gyroid: 세그먼트 구조가 다름
const rGyR = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fparams, sparse_infill_pattern: 'gyroid' }), () => {})
const rGyA = Module.slice(new Uint8Array(fillCube), JSON.stringify({ ...fparams, sparse_infill_pattern: 'gyroid_approx' }), () => {})
console.log(`  gyroid real segs=${sparseSegs(rGyR)} vs approx segs=${sparseSegs(rGyA)}`)
ok(sparseSegs(rGyR) > 0 && sparseSegs(rGyA) > 0 && sparseSegs(rGyR) !== sparseSegs(rGyA),
   `real gyroid (TPMS) differs from sine-approx (real=${sparseSegs(rGyR)} != approx=${sparseSegs(rGyA)})`)
// ③ gyroid TPMS z-위상: 두 z 레벨의 스파스 기하가 다름 (z 에 따라 곡면 위상 변화)
const gyLayers = rGyR.layers.filter(L => { const p = L.paths; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 2) return true; return false })
const sigOf = (L) => { const p = L.paths; let s = 0, n = 0; for (let i = 0; i < p.length; i += 8) if (p[i + 3] === 2) { s += p[i] * 7.3 + p[i + 1] * 3.1; n++ } return n ? s / n : 0 }
const sLo = sigOf(gyLayers[Math.floor(gyLayers.length * 0.3)]).toFixed(3)
const sHi = sigOf(gyLayers[Math.floor(gyLayers.length * 0.7)]).toFixed(3)
console.log(`  gyroid TPMS z-phase: loLayer sig=${sLo} hiLayer sig=${sHi}`)
ok(sLo !== sHi, `real gyroid has TPMS z-phase (geometry varies with z: ${sLo} != ${sHi})`)
// ④ 하위호환: gyroid_approx 는 여전히 구 사인 근사(존재) + rectilinear 기본 불변
ok(sparseSegs(rGyA) > 0, `gyroid_approx (legacy sine) still available (segs=${sparseSegs(rGyA)})`)

// ⑤ 실제 PressureEqualizer 이식(pe_lite:false): 크래시/맹글 없이 실행 + E 총량 보존 + 구조 유지.
//  ⚠ 실제 PE 는 OrcaSlicer ;_EXTRUDE_SET_SPEED 태그 g-code 에서만 유량 조정 → 평문 미니커널 g-code 엔 통과.
//  여기선 "이식본이 링크·실행되고 결과 g-code 를 망가뜨리지 않음"을 검증(태그 필요는 README 한계로 기록).
const eSumOf = (g) => { let s = 0; for (const m of g.matchAll(/ E(-?[\d.]+)/g)) s += parseFloat(m[1]); return s }
const rRealPEoff = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify(params), () => {})
const rRealPE = Module.slice(new Uint8Array(makeTableSTL()), JSON.stringify({ ...params, max_volumetric_extrusion_rate_slope: 2.0, pe_lite: false }), () => {})
ok(!rRealPE.error && /^; LAYER/m.test(rRealPE.gcode) && /^M104/m.test(rRealPE.gcode), `real PE port runs + preserves g-code structure (; LAYER, M104)`)
ok(Math.abs(eSumOf(rRealPE.gcode) - eSumOf(rRealPEoff.gcode)) < 0.01, `real PE conserves total E (${eSumOf(rRealPE.gcode).toFixed(2)} ≈ ${eSumOf(rRealPEoff.gcode).toFixed(2)})`)
ok(Math.abs(rRealPE.stats.filament_mm - rRealPEoff.stats.filament_mm) < 1e-6, `real PE: filament stat unchanged (speed-only)`)

// ===== 9단계 신규 (실제 PE 완전 통합 — OrcaSlicer 태그 방출 + 세그먼트 분할) =====
console.log('\n[stage9]')
const g9cube = makeBoxSTL(20, 20, 10)
const g1count = (g) => (g.match(/^G1 /gm) || []).length
const hasTag = (g) => /;_EXTRUDE_SET_SPEED/.test(g) || /;_EXTRUSION_ROLE:/.test(g) || /;_EXTRUDE_END/.test(g)
// ① emit_pe_tags=true + strip off → 3종 태그 모두 존재 (OrcaSlicer 형식)
const r9tags = Module.slice(new Uint8Array(g9cube), JSON.stringify({ ...params, emit_pe_tags: true, pe_strip_tags: false }), () => {})
ok(/;_EXTRUDE_SET_SPEED/.test(r9tags.gcode) && /;_EXTRUSION_ROLE:/.test(r9tags.gcode) && /;_EXTRUDE_END/.test(r9tags.gcode),
   `emit_pe_tags → ;_EXTRUDE_SET_SPEED/;_EXTRUSION_ROLE/;_EXTRUDE_END all present`)
// ② 기본값 → 태그 부재 (하위호환)
const r9def = Module.slice(new Uint8Array(g9cube), JSON.stringify(params), () => {})
ok(!hasTag(r9def.gcode), `default: no PE tags emitted (backward compatible)`)
// ③ 실제 PE (arachne 벽 = 가변 유량 → 분할) : G1 라인 수 증가 + E 총량 보존 + 최종 태그 제거(기본 strip)
const r9off = Module.slice(new Uint8Array(g9cube), JSON.stringify({ ...params, wall_generator: 'arachne' }), () => {})
const r9pe = Module.slice(new Uint8Array(g9cube), JSON.stringify({ ...params, wall_generator: 'arachne', max_volumetric_extrusion_rate_slope: 1.0, pe_lite: false }), () => {})
console.log(`  real PE: G1 off=${g1count(r9off.gcode)} on=${g1count(r9pe.gcode)}, E off=${eSumOf(r9off.gcode).toFixed(2)} on=${eSumOf(r9pe.gcode).toFixed(2)}`)
ok(g1count(r9pe.gcode) > g1count(r9off.gcode), `real PE splits/ramps → G1 line count increases (${g1count(r9off.gcode)}→${g1count(r9pe.gcode)})`)
ok(Math.abs(eSumOf(r9pe.gcode) - eSumOf(r9off.gcode)) < 0.05, `real PE conserves total E (${eSumOf(r9pe.gcode).toFixed(2)} ≈ ${eSumOf(r9off.gcode).toFixed(2)})`)
ok(!hasTag(r9pe.gcode), `real PE output: tags stripped by default (clean g-code)`)
// ④ F 램프 계단: 분할된 G1 F 마커가 실제로 삽입됨
const fRamp = (g) => (g.match(/^G1 F\d+\s*$/gm) || []).length
ok(fRamp(r9pe.gcode) > 0, `real PE inserts feedrate ramp steps (G1 F markers: ${fRamp(r9pe.gcode)})`)

// ===== 10단계 신규 (이식된 GCodeProcessor 시간추정 — 원본 사다리꼴 플래너) =====
console.log('\n[stage10]')
const g10 = makeBoxSTL(20, 20, 10)
// ① 큐브 G-code 파싱 성공 + 총 시간 > 0
const t10 = Module.slice(new Uint8Array(g10), JSON.stringify(params), () => {})
ok(!t10.error && typeof t10.stats.time_estimate === 'number' && t10.stats.time_estimate > 0,
   `GCodeProcessor time estimate: total=${t10.stats.time_estimate.toFixed(1)}s (>0)`)
ok(t10.stats.time_moves > 0 && t10.stats.layer_times.length > 0,
   `parsed ${t10.stats.time_moves} moves, ${t10.stats.layer_times.length} layer times`)
// per-layer times sum to total (single write site)
const ltSum = t10.stats.layer_times.reduce((a, b) => a + b, 0)
ok(Math.abs(ltSum - t10.stats.time_estimate) / t10.stats.time_estimate < 0.001,
   `layer_times sum ${ltSum.toFixed(1)} == total ${t10.stats.time_estimate.toFixed(1)}`)
// ② 속도 빠른 파라미터가 시간 단축 (물리 방향성)
const t10slow = Module.slice(new Uint8Array(g10), JSON.stringify({ ...params, print_speed: 30 }), () => {})
const t10fast = Module.slice(new Uint8Array(g10), JSON.stringify({ ...params, print_speed: 120 }), () => {})
ok(t10fast.stats.time_estimate < t10slow.stats.time_estimate,
   `faster print_speed -> less time (30mm/s=${t10slow.stats.time_estimate.toFixed(0)}s > 120mm/s=${t10fast.stats.time_estimate.toFixed(0)}s)`)
// ③ 파싱 필라멘트 == 커널 자체 계산 (±2%)
const fdelta = Math.abs(t10.stats.filament_mm - t10.stats.time_filament_mm) / t10.stats.filament_mm
ok(fdelta <= 0.02, `parsed filament == kernel stat within 2% (${t10.stats.time_filament_mm.toFixed(1)} vs ${t10.stats.filament_mm.toFixed(1)}, ${(fdelta * 100).toFixed(2)}%)`)
// role 시간 분해 (PE 태그 모드)
const t10tag = Module.slice(new Uint8Array(g10), JSON.stringify({ ...params, emit_pe_tags: true, pe_strip_tags: false }), () => {})
ok(Object.keys(t10tag.stats.role_times).length > 0,
   `role time breakdown present in tag mode (roles: ${Object.keys(t10tag.stats.role_times).join(',')})`)
// determinism: identical params -> identical estimate
const t10b = Module.slice(new Uint8Array(g10), JSON.stringify(params), () => {})
ok(t10.stats.time_estimate === t10b.stats.time_estimate, `time estimate is deterministic`)

console.log(failed === 0 ? '\nALL NODE TESTS PASSED' : `\n${failed} TEST(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
