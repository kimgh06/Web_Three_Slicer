// 28단계 검증(node): P1 안착 · P2 좌표계약(툴패스↔모델 겹침) · over_bed · P4 서포트∩솔리드=0 불변식.
import createSlicer from '../packages/engine/src/slicer_core.js'
import { readFileSync } from 'node:fs'
const M = await createSlicer()
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok: ' : '  FAIL: ') + m); if (!c) fail++ }

function stlTris(buf) {
  const dv = new DataView(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  const n = dv.getUint32(80, true); const tris = []; let off = 84
  for (let t = 0; t < n; t++) { off += 12; const v = []; for (let k = 0; k < 3; k++) { v.push([dv.getFloat32(off, true), dv.getFloat32(off + 4, true), dv.getFloat32(off + 8, true)]); off += 12 } tris.push(v); off += 2 }
  return tris
}
function trisToSTL(tris) { const b = Buffer.alloc(84 + tris.length * 50); b.writeUInt32LE(tris.length, 80); let o = 84; for (const t of tris) { o += 12; for (const p of t) { b.writeFloatLE(p[0], o); b.writeFloatLE(p[1], o + 4); b.writeFloatLE(p[2], o + 8); o += 12 } b.writeUInt16LE(0, o); o += 2 } return b }
function bbox(tris) { let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; for (const t of tris) for (const v of t) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]) } return { mn, mx } }
// 뷰어처럼: XY-bbox 중심을 원점에, minz=0 안착. dx,dy 로 재배치.
function place(tris, dx = 0, dy = 0) { const b = bbox(tris); const cx = (b.mn[0] + b.mx[0]) / 2, cy = (b.mn[1] + b.mx[1]) / 2, mz = b.mn[2]; return tris.map(t => t.map(v => [v[0] - cx + dx, v[1] - cy + dy, v[2] - mz])) }
const slice = (tris, extra = {}) => M.slice(new Uint8Array(trisToSTL(tris)), JSON.stringify({ layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0, print_speed: 60, first_layer_speed: 20, travel_speed: 150, nozzle_temp: 210, bed_temp: 60, top_shell_layers: 3, bottom_shell_layers: 3, skirt_loops: 0, brim_width: 0, infill_angle: 45, bed_width: 256, bed_depth: 256, ...extra }), () => {})
// 압출(비트래블) 툴패스 XY bbox
function extrBBox(r) { let mn = [1e9, 1e9], mx = [-1e9, -1e9], mnz = 1e9; for (const L of r.layers) for (let i = 0; i < L.paths.length; i += 8) { if (L.paths[i + 3] === 0) continue; for (const [a, b] of [[0, 1], [4, 5]]) { mn[0] = Math.min(mn[0], L.paths[i + a]); mx[0] = Math.max(mx[0], L.paths[i + a]); mn[1] = Math.min(mn[1], L.paths[i + b]); mx[1] = Math.max(mx[1], L.paths[i + b]) } mnz = Math.min(mnz, L.paths[i + 2]) } return { mn, mx, mnz } }
// 점(x,y)이 레이어 벽(type1) 폴리곤 내부인지 — 수평 레이 교차수(홀수=내부). 벽 세그먼트=폴리곤 에지.
function insideWalls(L, x, y) { let cnt = 0; for (let i = 0; i < L.paths.length; i += 8) { if (L.paths[i + 3] !== 1) continue; const x0 = L.paths[i], y0 = L.paths[i + 1], x1 = L.paths[i + 4], y1 = L.paths[i + 5]; if ((y0 > y) !== (y1 > y)) { const xc = x0 + (y - y0) / (y1 - y0) * (x1 - x0); if (xc > x) cnt++ } } return (cnt & 1) === 1 }

const benchy = stlTris(readFileSync('fixtures/pseudo_benchy.stl'))

// ① P1 안착 + P2 겹침 — 뷰어처럼 배치(중앙, seated), 슬라이스 후 툴패스 XY ≈ 입력 XY, z 안착
const placed = place(benchy)   // 중앙+안착
const bIn = bbox(placed)
const r1 = slice(placed)
const e1 = extrBBox(r1)
console.log(`  centered: model X[${bIn.mn[0].toFixed(1)},${bIn.mx[0].toFixed(1)}] Y[${bIn.mn[1].toFixed(1)},${bIn.mx[1].toFixed(1)}]  toolpath X[${e1.mn[0].toFixed(1)},${e1.mx[0].toFixed(1)}] Y[${e1.mn[1].toFixed(1)},${e1.mx[1].toFixed(1)}]`)
ok(Math.abs(e1.mn[0] - bIn.mn[0]) < 1 && Math.abs(e1.mx[0] - bIn.mx[0]) < 1 && Math.abs(e1.mn[1] - bIn.mn[1]) < 1 && Math.abs(e1.mx[1] - bIn.mx[1]) < 1, 'P2: toolpath XY bbox ≈ model XY bbox (<1mm) — 화면 위치와 겹침')
ok(bIn.mn[2] < 1e-4, 'P1: model seated minz=0 (place() -min_z)')
ok(e1.mnz < 0.25, `P1/P2: toolpath bottom z≈0 (${e1.mnz.toFixed(3)})`)

// ② P2 off-center 배치도 그대로 추종 (재정렬 없음)
const off = place(benchy, 40, -25)
const bOff = bbox(off), r2 = slice(off), e2 = extrBBox(r2)
ok(Math.abs(e2.mx[0] - bOff.mx[0]) < 1 && Math.abs(e2.mn[1] - bOff.mn[1]) < 1, 'P2: off-center(+40,-25) 배치를 툴패스가 그대로 추종(재정렬 없음)')

// ③ over_bed: 베드 밖 배치
const overs = slice(place(benchy, 130, 0))   // x 를 베드 절반(128) 밖으로
ok(!!overs.stats.over_bed, 'over_bed: 베드 밖 배치 시 true 유지')

// ④ auto_center=true 하위호환: 재정렬(원점 중심)
const legacy = slice(off, { auto_center: true }), el = extrBBox(legacy)
ok(Math.abs((el.mn[0] + el.mx[0]) / 2) < 2 && Math.abs((el.mn[1] + el.mx[1]) / 2) < 2, 'auto_center=true: 레거시 원점 재정렬 보존')

// ⑤ P4 불변식: 서포트(type5) 중점이 모델 솔리드(벽 내부) 안에 없음 (∩ = 0). arm 오버행 서포트 생성.
const rs = slice(placed, { enable_support: true, support_threshold_angle: 40, support_density: 0.15, support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2, support_style: 'grid' })
let supCount = 0, inside = 0
for (const L of rs.layers) for (let i = 0; i < L.paths.length; i += 8) { if (L.paths[i + 3] !== 5) continue; supCount++; const mx = (L.paths[i] + L.paths[i + 4]) / 2, my = (L.paths[i + 1] + L.paths[i + 5]) / 2; if (insideWalls(L, mx, my)) inside++ }
console.log(`  support segments=${supCount}  inside-model-solid=${inside}`)
ok(supCount > 0, 'P4: arm 오버행에 서포트 생성됨')
ok(inside === 0, 'P4 불변식: 서포트 ∩ 모델 솔리드(벽 내부) = 0 (공동 내부 서포트는 정상, 솔리드 관통만 금지)')

console.log(fail === 0 ? '\nCOORDS/SUPPORT TEST PASSED' : `\n${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
