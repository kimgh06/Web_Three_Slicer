// S3 조사: 프라임타워 두 경로 비교 — 기본(사각 링 근사) vs wipe_tower_real(실 WipeTower.generate() 이식본).
//  기본값 전환 판단 근거 수집용. 성공 여부·G-code 타당성 지표를 나란히 출력한다(판정은 사람이).
import createSlicer from '../packages/engine/src/slicer_core.js'

// MM 입력: 두 박스를 나란히 — 앞쪽 tris 는 ext1, split 이후는 ext2 로 커널이 그룹 분리
function boxTris(ox, oy, oz, sx, sy, sz) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d) => [[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7)]
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0], off); buf.writeFloatLE(p[1], off+4); buf.writeFloatLE(p[2], off+8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
  return buf
}
const A = boxTris(-25, -10, 0, 20, 20, 10), B = boxTris(5, -10, 0, 20, 20, 10)
const stl = new Uint8Array(trisToSTL([...A, ...B]))
const SPLIT = A.length   // ext2 시작 삼각형 인덱스

const base = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75,
  extruder_count: 2, mm_group_split: SPLIT, prime_tower_width: 30,
}
const M = await createSlicer()

const probe = (label, extra) => {
  let r, err = null
  const t0 = performance.now()
  try { r = M.slice(stl, JSON.stringify({ ...base, ...extra }), () => {}) } catch (e) { err = String(e && e.message || e) }
  const ms = performance.now() - t0
  if (err || !r || r.error) { console.log(`${label.padEnd(22)} 실패: ${err || r?.error}`); return null }
  const g = r.gcode
  const lines = g.split('\n')
  const toolChanges = lines.filter(l => /^T[01]\b/.test(l)).length
  const towerReal = lines.filter(l => l.includes('wipe_tower_real')).length
  const towerRing = lines.filter(l => l.includes('prime tower')).length
  const cpToolchange = lines.filter(l => l.includes('CP TOOLCHANGE') || l.includes('WIPE_TOWER')).length
  // type 11 = 프라임타워 툴패스 세그먼트
  let towerSeg = 0
  for (const L of r.layers || []) { const p = L.paths; if (!p) continue; for (let i = 0; i < p.length; i += 8) if (p[i+3] === 11) towerSeg++ }
  console.log(`${label.padEnd(22)} 레이어 ${String(r.stats.layers).padStart(3)}  툴체인지 ${String(toolChanges).padStart(3)}  ` +
    `타워세그 ${String(towerSeg).padStart(5)}  필라멘트 ${r.stats.filament_mm.toFixed(1).padStart(8)}mm  ` +
    `gcode ${String(g.length).padStart(7)}B  ${ms.toFixed(0)}ms`)
  console.log(`${''.padEnd(22)}   마커: 실타워 ${towerReal} · 링 ${towerRing} · CP/WIPE ${cpToolchange}`)
  return { r, towerSeg, toolChanges, towerReal, cpToolchange }
}

console.log('=== 프라임타워 경로 비교 (MM 2 extruder) ===')
const ring = probe('기본(사각 링)', { wipe_tower_real: false })
const real = probe('wipe_tower_real', { wipe_tower_real: true })

console.log('\n=== 판단 근거 ===')
if (ring && real) {
  console.log(`실 WipeTower 마커 방출: ${real.towerReal > 0 ? 'O (실 경로 동작)' : 'X (폴백으로 떨어짐)'}`)
  console.log(`링 폴백 마커: 기본 ${ring.towerRing ?? '-'} / 실경로 ${real.towerRing ?? '-'}`)
  console.log(`타워 툴패스 세그먼트: 링 ${ring.towerSeg} vs 실 ${real.towerSeg}`)
}
process.exit(0)
