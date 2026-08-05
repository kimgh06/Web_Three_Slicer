// 24단계 검증(CPU 측): buildSegmentData 가 원본 libvgcode 데이터 모델을 올바로 생성하는지.
//  NaN/거대좌표 없음 · 폭 차이 보존 · 마이터 각도(연결 벽) 존재 · 레이어 프리픽스 == 총합.
import createSlicer from '../engine/src/slicer_core.js'
import { buildSegmentData } from '../viewer/src/toolpath_gpu.js'
function boxTris(ox,oy,oz,sx,sy,sz){const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz]);const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]];return[...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]}
function cylTris(cx,cy,r,h,n){const t=[];const top=[],bot=[];for(let i=0;i<n;i++){const A=2*Math.PI*i/n;top.push([cx+r*Math.cos(A),cy+r*Math.sin(A),h]);bot.push([cx+r*Math.cos(A),cy+r*Math.sin(A),0])}for(let i=0;i<n;i++){const j=(i+1)%n;t.push([bot[i],bot[j],top[j]],[bot[i],top[j],top[i]]);t.push([[cx,cy,h],top[i],top[j]]);t.push([[cx,cy,0],bot[j],bot[i]])}return t}
function trisToSTL(tris){const buf=Buffer.alloc(84+tris.length*50);buf.writeUInt32LE(tris.length,80);let off=84;for(const t of tris){off+=12;for(const p of t){buf.writeFloatLE(p[0],off);buf.writeFloatLE(p[1],off+4);buf.writeFloatLE(p[2],off+8);off+=12}buf.writeUInt16LE(0,off);off+=2}return buf}
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:3,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,skirt_distance:2,brim_width:0,retract_length:0.8,retract_speed:30,z_hop:0.4,infill_angle:45,wall_generator:'classic'}
const M=await createSlicer()
const slice=(stl,p)=>M.slice(new Uint8Array(stl),JSON.stringify(p),()=>{})
let fail=0; const ok=(c,m)=>{console.log((c?'  ok: ':'  FAIL: ')+m);if(!c)fail++}

// ① cube — 무결성 + 프리픽스
const rc=slice(trisToSTL(boxTris(0,0,0,20,20,20)),base)
const dc=buildSegmentData(rc.layers, base.line_width)
console.log(`  cube: layers=${dc.layerCount} nV=${dc.nV} nSeg=${dc.nSeg} nTrav=${dc.nTrav} maxAbs=${dc.maxAbs.toFixed(1)}`)
ok(!dc.hasNaN, 'no NaN in position/hwa/angle')
ok(dc.maxAbs < 60, 'no huge coords (cube within ~bbox, maxAbs<60)')
ok(dc.layerSegPrefix[dc.layerCount] === dc.nSeg, 'layerSegPrefix[L] == nSeg (visible-range O(1) consistent)')
let mono=true; for(let i=1;i<=dc.layerCount;i++) if(dc.layerSegPrefix[i]<dc.layerSegPrefix[i-1]) mono=false
ok(mono, 'layerSegPrefix monotonic non-decreasing')
ok(dc.travelPrefix[dc.layerCount] === dc.nTrav, 'travelPrefix[L] == nTrav')
// id_a+1 valid for every segment
let idOk=true; for(let s=0;s<dc.nSeg;s++){const a=dc.segIndex[s*4]; if(a+1>=dc.nV) idOk=false}
ok(idOk, 'every segment id_a+1 within vertex range (shader id_b=id_a+1 safe)')

// ② 마이터 조인: 연결된 벽에서 non-zero 각도 존재
let nzAngle=0, maxAngle=0; for(let i=0;i<dc.nV;i++){const a=Math.abs(dc.hwa[i*4+2]); if(a>1e-3)nzAngle++; if(a>maxAngle)maxAngle=a}
ok(nzAngle>0, `miter join angles present (${nzAngle} vertices with |angle|>0, max=${maxAngle.toFixed(3)}rad)`)
ok(maxAngle<=Math.PI+1e-3, 'angles within [-pi,pi]')

// ③ 폭 차이 보존 (외벽 0.6 / 내벽 0.42) → hwa.width 에 두 값 공존
const rw=slice(trisToSTL(boxTris(0,0,0,20,20,20)),{...base,outer_wall_line_width:0.6,inner_wall_line_width:0.42})
const dw=buildSegmentData(rw.layers, 0.42)
const ws=new Set(); for(let i=0;i<dw.nV;i++) ws.add(Math.round(dw.hwa[i*4+1]*100)/100)
console.log(`  wall-width set (outer0.6/inner0.42): [${[...ws].sort((a,b)=>a-b)}]`)
ok(ws.has(0.6)&&ws.has(0.42), 'per-feature widths preserved in hwa (0.6 AND 0.42)')

// ④ 대형 원기둥(고세그먼트) — 무결성 + z 센터링
const rb=slice(trisToSTL(cylTris(0,0,60,40,256)),base)
const db=buildSegmentData(rb.layers, 0.42)
console.log(`  big cyl: layers=${db.layerCount} nV=${db.nV} nSeg=${db.nSeg} maxAbs=${db.maxAbs.toFixed(1)}`)
ok(!db.hasNaN && db.nSeg>100000, `large model integrity (nSeg=${db.nSeg}, no NaN)`)
// z 센터링: 첫 레이어 정점 z = z0-0.5h 여야(원본 position.z -= 0.5*height). 첫 압출 세그먼트 확인
const firstZ = db.position[2], firstH = db.hwa[0]
ok(firstZ < rb.layers[0].z, `position.z pushed down by ~0.5*height (center ${firstZ.toFixed(3)} < layerTop ${rb.layers[0].z})`)

console.log(fail===0?'\nGPU TOOLPATH (CPU DATA) TEST PASSED':`\n${fail} FAIL`)
process.exit(fail===0?0:1)
