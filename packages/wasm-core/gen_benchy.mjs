// 28단계 픽스처: 프로그램 생성 "유사 벤치"(3DBenchy 는 CC-BY-ND·저장소엔 .drc 뿐 → 재배포 회피).
//  특성: ① 원점 오프셋(off-center) ② minz≠0(바닥 안착 테스트) ③ 비대칭 세로 형상(자세 테스트)
//        ④ 외부 오버행 arm(서포트 필요) ⑤ 밀폐 내부 공동(reversed box → 서포트 침투 금지 테스트).
import { writeFileSync } from 'node:fs'

const tris = []
// outward box
function box(ox, oy, oz, sx, sy, sz, rev = false) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d) => rev ? [[c[a],c[cc],c[b]],[c[a],c[d],c[cc]]] : [[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  tris.push(...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7))
}
// 선체(hull)
box(0, 0, 0, 40, 24, 8)
// 밀폐 내부 공동(hull 내부, reversed → 씰드 보이드). 천장 z=6 (위 2mm 솔리드) = 닫힌 오버행.
box(10, 6, 2, 14, 12, 4, true)
// 캐빈(cabin, 위에)
box(6, 4, 8, 22, 16, 14)
// 굴뚝(chimney, 세로 길쭉)
box(28, 9, 22, 5, 5, 12)
// 외부 오버행 arm (x=40.. 밖으로, 아래 공기 → 서포트 필요)
box(40, 7, 15, 12, 10, 4)

// 오프셋(쓰기 시점에만 적용 — box 정점은 삼각형 간 공유라 배열 변형 시 중복 가산됨): minz=+5(부양) + off-center XY.
const OFF = [62, 46, 5]

// 바이너리 STL
const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
let off = 84
for (const t of tris) { off += 12; for (const p of t) { buf.writeFloatLE(p[0]+OFF[0], off); buf.writeFloatLE(p[1]+OFF[1], off+4); buf.writeFloatLE(p[2]+OFF[2], off+8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
writeFileSync('fixtures/pseudo_benchy.stl', buf)

// bbox 요약
let mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9]
for (const t of tris) for (const v of t) for (let k=0;k<3;k++){ mn[k]=Math.min(mn[k],v[k]+OFF[k]); mx[k]=Math.max(mx[k],v[k]+OFF[k]) }
console.log(`pseudo_benchy.stl: ${tris.length} tris  bbox min=[${mn.map(x=>x.toFixed(0))}] max=[${mx.map(x=>x.toFixed(0))}]  (minz=${mn[2]}, off-center)`)
