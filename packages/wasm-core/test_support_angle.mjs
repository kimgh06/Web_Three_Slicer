// S1 검증: support_threshold_angle 의 방향이 원본과 같은가.
//  원본 detect_overhangs(SupportMaterial.cpp:1439): lower_layer_offset = layer_height / tan(threshold)
//  툴팁: "값이 작을수록 서포트 없이 출력 가능한 오버행이 가팔라진다" = 임계각↑ → 서포트↑
//  ※ 33단계 이전 버그판은 tan 이 분자라 방향이 반대였고 45°(tan=1)에서만 우연히 일치했다.
//
// 픽스처 선정 근거(실측):
//  - table.stl 은 오버행이 완전 수평(0°)이라 어떤 임계각에서도 걸려 판별력이 0.
//  - 층당 오버행 띠가 슬리버 제거 열림(openR=line_width*0.6)보다 얇으면 지워진다 →
//    경사 25° 이상은 임계각 80° 에서도 서포트가 생기지 않는다(현 커널 특성).
//  - 그래서 완만한 경사 3종(8°/16°/20°)을 쓴다.
//  33단계: 형태학 열림을 면적 필터로 교체한 뒤 발동 임계각이 **실제 경사각과 일치**하게 됐다
//    (이전엔 열림이 얇은 띠를 지워 16° 원뿔이 θ=60°, 20° 원뿔이 θ=80° 에서야 발동 — 임계각 왜곡).
//    이제 오버행 조건 θ > 경사각 이 그대로 성립하므로, 각 경사각을 사이에 두고 샘플링한다.
import createSlicer from '../engine/src/slicer_core.js'

// 역원뿔: 꼭짓점(z=0) → 반지름 R 밑면(z=H). 측면 경사각 = atan(H/R) (90°=수직).
function coneTris(cx, cy, R, slopeDeg, seg = 64) {
  const H = R * Math.tan(slopeDeg * Math.PI / 180)
  const apex = [cx, cy, 0], topC = [cx, cy, H]
  const p = i => { const a = 2 * Math.PI * i / seg; return [cx + R * Math.cos(a), cy + R * Math.sin(a), H] }
  const t = []
  for (let i = 0; i < seg; i++) { const a = p(i), b = p((i + 1) % seg); t.push([apex, b, a]); t.push([topC, a, b]) }
  return t
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50); buf.writeUInt32LE(tris.length, 80)
  let off = 84
  for (const tr of tris) { off += 12; for (const v of tr) { buf.writeFloatLE(v[0], off); buf.writeFloatLE(v[1], off + 4); buf.writeFloatLE(v[2], off + 8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
  return buf
}
const stl = new Uint8Array(trisToSTL([
  ...coneTris(-40, 0, 14, 8), ...coneTris(0, 0, 14, 16), ...coneTris(40, 0, 14, 20),
]))

const base = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2,
  infill_density: 0.15, nozzle_diameter: 0.4, filament_diameter: 1.75,
  enable_support: true, support_style: 'grid', support_density: 0.15,
  support_top_z_distance: 0.2, support_xy_distance: 0.35, support_interface_top_layers: 2,
  bed_width: 220, bed_depth: 220,
  // 이 테스트는 "임계각 → 오버행 검출" 의미론만 본다. 원본 default true 인 작은-오버행 제거는
  //  매끄러운 원뿔의 층당 얇은 띠를 걸러내 각도 판별을 가리므로 끈다(제거 로직 자체는 별도 확인).
  support_remove_small_overhang: false,
}
const M = await createSlicer()

// 툴패스 stride 8, 타입 오프셋 +3 (toolpath_gpu.js buildSegmentData 계약). type 5=서포트 base, 6=interface.
const supportSegments = (angle) => {
  const r = M.slice(stl, JSON.stringify({ ...base, support_threshold_angle: angle }), () => {})
  if (r.error) throw new Error(String(r.error))
  let seg = 0
  for (const L of r.layers || []) {
    const p = L.paths; if (!p) continue
    for (let i = 0; i < p.length; i += 8) { const t = p[i + 3]; if (t === 5 || t === 6) seg++ }
  }
  return seg
}

// 각 원뿔(8°/16°/20°)의 발동 임계각 사이를 고른 지점 — 단계마다 대상이 하나씩 늘어야 한다.
const ANGLES = [5, 12, 18, 25]
const rows = ANGLES.map(a => ({ a, seg: supportSegments(a) }))
for (const r of rows) console.log(`  θ=${String(r.a).padStart(2)}°  서포트 세그먼트 ${String(r.seg).padStart(6)}`)

let fail = 0
for (let i = 1; i < rows.length; i++) {
  if (rows[i].seg <= rows[i - 1].seg) {
    console.log(`FAIL 계단 증가 위반: θ=${rows[i - 1].a}°(${rows[i - 1].seg}) → θ=${rows[i].a}°(${rows[i].seg})`)
    fail++
  }
}
if (rows[0].seg !== 0) { console.log(`FAIL 최저 임계각(10°)에서 서포트가 생성됨(${rows[0].seg}) — 과다 검출`); fail++ }

console.log(fail ? `\nSUPPORT ANGLE TEST FAILED (${fail})` : '\nSUPPORT ANGLE TEST PASSED — 임계각↑ = 서포트↑ (원본 방향 정합)')
process.exit(fail ? 1 : 0)
