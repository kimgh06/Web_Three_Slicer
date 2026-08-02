// 33단계 회귀: "공중에 뜬 서포트" 검출.
//  원본 project_support_to_grid 는 하강 투영에서 모델을 diff 해 아래로 넘긴다 —
//  즉 모델에 닿은 투영은 소멸(bottom contact)하고, 아래에서 되살아나지 않는다.
//  기존 구현은 누적(union)만 하고 클립을 나중에 레이어별로 해서, 모델에 가려 지워진 영역이
//  모델이 사라지는 아래 레이어에서 되살아나 공중에 뜬 서포트가 됐다.
//
// 판정: 서포트는 베드에서 위로 쌓인다. 레이어 j(j>0)의 서포트 셀 중, 바로 **아래** 레이어(j-1)에
//  서포트도 모델(벽/솔리드/인필)도 없는 셀 = 받칠 것이 없는데 존재하는 서포트 = **부유**.
//  j=0 은 베드에 놓이므로 제외. 래스터 격자(0.5mm) 판정 — 폴리곤 재조립 없이 안정적.
import createSlicer from '../packages/engine/src/slicer_core.js'

// 계단형 오버행: 층마다 단면이 들쭉날쭉해 부유 서포트를 유발하기 쉬운 형상.
//  아래 기둥(작음) → 중간 판(큼) → 위 기둥(작음, 오프셋) 3단.
function box(ox,oy,oz,sx,sy,sz){
  const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz])
  const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]
}
function stlOf(t){const b=Buffer.alloc(84+t.length*50);b.writeUInt32LE(t.length,80);let o=84
  for(const tr of t){o+=12;for(const v of tr){b.writeFloatLE(v[0],o);b.writeFloatLE(v[1],o+4);b.writeFloatLE(v[2],o+8);o+=12}b.writeUInt16LE(0,o);o+=2}return b}
// ※ z 경계를 서로 0.5mm 겹치게 둔다. 정확히 맞닿게 하면(판 6~9, 기둥 9~15) 그 평면에서
//   tri_plane 의 [zmin, zmax) 판정상 아무 삼각형도 잡히지 않아 **빈 레이어**가 생기고,
//   그 위 서포트가 전부 "아래에 아무것도 없음"으로 오판된다(실측 확인).
const model = [
  ...box(-4,-4,0, 8,8,6.5),       // 하단 기둥 z 0~6.5
  ...box(-15,-15,6, 30,30,3),     // 중간 판 z 6~9 (전면 오버행 → 그 아래 서포트)
  ...box(6,6,8.5, 8,8,6.5),       // 상단 기둥 z 8.5~15 (판 위, XY 오프셋)
  ...box(-15,-15,14.5, 30,30,3),  // 상단 판 z 14.5~17.5 (다시 전면 오버행)
]
const stl = new Uint8Array(stlOf(model))

const M = await createSlicer()
const params = {
  layer_height:0.2, first_layer_height:0.2, line_width:0.42, wall_loops:2, infill_density:0.15,
  nozzle_diameter:0.4, filament_diameter:1.75, bed_width:220, bed_depth:220,
  enable_support:true, support_style:'grid', support_threshold_angle:45,
  support_top_z_distance:0.2, support_xy_distance:0.35, support_interface_top_layers:2,
}
const r = M.slice(stl, JSON.stringify(params), () => {})
if (r.error) { console.log('FAIL 슬라이스 에러:', r.error); process.exit(1) }

const CELL = 0.5
const key = (x,y) => `${Math.round(x/CELL)},${Math.round(y/CELL)}`
// 레이어별 서포트 셀 / 전체(서포트+모델) 셀
const supCells = [], allCells = []
for (const L of r.layers || []) {
  const s = new Set(), a = new Set()
  const p = L.paths
  if (p) for (let i=0;i<p.length;i+=8) {
    const t = p[i+3]; if (t === 0) continue                     // 트래블 제외
    // 세그먼트를 CELL 간격으로 샘플링
    const x0=p[i], y0=p[i+1], x1=p[i+4], y1=p[i+5]
    const n = Math.max(1, Math.ceil(Math.hypot(x1-x0,y1-y0)/CELL))
    for (let k=0;k<=n;k++) {
      const kk = key(x0+(x1-x0)*k/n, y0+(y1-y0)*k/n)
      a.add(kk); if (t===5||t===6) s.add(kk)
    }
  }
  supCells.push(s); allCells.push(a)
}

// 아래 레이어 판정은 8-이웃까지 허용한다: support_xy_distance(0.35mm) 간극 위의 서포트,
//  그리고 격자 이산화 경계는 한 셀(0.5mm) 이내 돌출이라 물리적으로 정상 출력 범위다.
//  이 허용이 없으면 모델 둘레의 간극 링이 전부 "부유"로 잡혀 지표가 무의미해진다.
const hasBelow = (below, c) => {
  const [cx, cy] = c.split(',').map(Number)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    if (below.has(`${cx+dx},${cy+dy}`)) return true
  return false
}
let floating = 0, totalSup = 0, worstLayer = -1, worstN = 0
for (let j = 1; j < supCells.length; j++) {           // j=0 은 베드 접지 → 제외
  const cur = supCells[j], below = allCells[j-1]      // 아래 레이어의 서포트+모델 전체
  if (!cur.size) continue
  let n = 0
  for (const c of cur) { totalSup++; if (!hasBelow(below, c)) { floating++; n++ } }
  if (n > worstN) { worstN = n; worstLayer = j }
}
const pct = totalSup ? (floating/totalSup*100) : 0
console.log(`서포트 셀 ${totalSup.toLocaleString()}  위가 빈 셀 ${floating.toLocaleString()} (${pct.toFixed(1)}%)  최악 레이어 ${worstLayer}(${worstN})`)

// 임계 5%: 실측 기준선 — 수정 전(하강 투영에서 모델 미차감) 8.0%, 수정 후 3.2%.
//  잔여 3.2% 는 대부분 지표의 알려진 편향이다: 래스터에는 압출 "선"만 담기고 모델 단면의 채워진
//  내부는 담기지 않으므로, 모델 상면에 정상 착지한 서포트(= bottom contact)도 "아래 없음"으로 잡힌다.
//  절대값이 아니라 회귀 감지용 상한으로 쓴다.
const LIMIT = 5
if (pct > LIMIT) { console.log(`\nFLOATING SUPPORT TEST FAILED — ${pct.toFixed(1)}% > ${LIMIT}%`); process.exit(1) }
console.log(`\nFLOATING SUPPORT TEST PASSED — ${pct.toFixed(1)}% ≤ ${LIMIT}%`)
