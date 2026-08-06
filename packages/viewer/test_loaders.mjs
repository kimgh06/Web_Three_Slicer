// 3MF 파서 자체검증 — 실제 3mf 파일들(코어 스펙 + production extension)을 읽어 삼각형이 나오는지.
//   실행: node packages/viewer/test_3mf.mjs
import { readFileSync, existsSync } from 'node:fs'
import assert from 'node:assert'
import { parse3MF } from './src/parse_3mf.js'

const cases = [
  // [경로, 최소 오브젝트 수, 최소 삼각형 수]
  ['packages/wasm-core/testing_files/cube.3mf', 1, 12],                    // 코어 스펙 (mesh 인라인)
  ['slicer/resources/handy_models/OrcaBadge.3mf', 1, 1000],           // production ext (p:path 외부 파트)
  ['slicer/resources/calib/filament_flow/pass1.3mf', 1, 100],
  ['slicer/tests/data/test_3mf/Geräte/Büchse.3mf', 1, 10],
]

let ran = 0
for (const [path, minObjs, minTris] of cases) {
  if (!existsSync(path)) { console.log(`skip (없음): ${path}`); continue }
  const objs = parse3MF(readFileSync(path), 'x')
  const tris = objs.reduce((a, o) => a + o.tris.length / 9, 0)
  assert.ok(objs.length >= minObjs, `${path}: 오브젝트 ${objs.length} < ${minObjs}`)
  assert.ok(tris >= minTris, `${path}: 삼각형 ${tris} < ${minTris}`)
  for (const o of objs) {
    assert.ok(o.tris.length % 9 === 0, `${path}: 삼각형 스트림 길이 불량`)
    assert.ok(o.tris.every(Number.isFinite), `${path}: NaN 좌표`)
  }
  // z-up mm: 빌드플레이트 위 모델이면 좌표가 상식 범위(±10m)
  let max = 0
  for (const o of objs) for (const v of o.tris) if (Math.abs(v) > max) max = Math.abs(v)
  assert.ok(max < 10000, `${path}: 좌표 범위 이상 ${max}`)
  console.log(`ok  ${path}  objs=${objs.length} tris=${tris} max=${max.toFixed(1)}mm`)
  ran++
}
assert.ok(ran >= 2, '검증한 파일이 너무 적다')
console.log(`\n3MF 파서 ${ran}개 파일 통과`)

// ---- 나머지 포맷 (STL/OBJ/PLY). AMF 는 three AMFLoader 가 DOMParser 를 써서 브라우저에서만 검증된다. ----
const { loadModel } = await import('./src/model_loaders.js')
for (const [file, minTris] of [['cube.obj', 12], ['cube.ply', 12], ['pseudo_benchy.stl', 12]]) {
  const p = `packages/wasm-core/testing_files/${file}`
  const b = readFileSync(p)
  const objs = await loadModel(file, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  const tris = objs.reduce((a, o) => a + o.modelPos.length / 9, 0)
  assert.ok(tris >= minTris, `${p}: 삼각형 ${tris} < ${minTris}`)
  assert.ok(objs.every(o => o.modelPos.every(Number.isFinite)), `${p}: NaN 좌표`)
  console.log(`ok  ${p}  objs=${objs.length} tris=${tris}`)
}
