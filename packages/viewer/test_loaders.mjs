// 3MF parser self-check — reads real 3mf files (core spec + production extension) and verifies triangles come out.
//   Run: node packages/viewer/test_3mf.mjs
import { readFileSync, existsSync } from 'node:fs'
import assert from 'node:assert'
import { parse3MF } from './src/parse_3mf.js'

const cases = [
  // [path, minimum object count, minimum triangle count]
  ['packages/wasm-core/testing_files/cube.3mf', 1, 12],                    // core spec (inline mesh)
  ['slicer/resources/handy_models/OrcaBadge.3mf', 1, 1000],           // production ext (external p:path part)
  ['slicer/resources/calib/filament_flow/pass1.3mf', 1, 100],
  ['slicer/tests/data/test_3mf/Geräte/Büchse.3mf', 1, 10],
]

let ran = 0
for (const [path, minObjs, minTris] of cases) {
  if (!existsSync(path)) { console.log(`skip (missing): ${path}`); continue }
  const objs = await parse3MF(readFileSync(path), 'x')
  const tris = objs.reduce((a, o) => a + o.tris.length / 9, 0)
  assert.ok(objs.length >= minObjs, `${path}: objects ${objs.length} < ${minObjs}`)
  assert.ok(tris >= minTris, `${path}: triangles ${tris} < ${minTris}`)
  for (const o of objs) {
    assert.ok(o.tris.length % 9 === 0, `${path}: bad triangle stream length`)
    assert.ok(o.tris.every(Number.isFinite), `${path}: NaN coordinate`)
  }
  // z-up mm: a model on the build plate should have coordinates within a sane range (±10m)
  let max = 0
  for (const o of objs) for (const v of o.tris) if (Math.abs(v) > max) max = Math.abs(v)
  assert.ok(max < 10000, `${path}: coordinate out of range ${max}`)
  console.log(`ok  ${path}  objs=${objs.length} tris=${tris} max=${max.toFixed(1)}mm`)
  ran++
}
assert.ok(ran >= 2, 'too few files verified')
console.log(`\n3MF parser passed on ${ran} files`)

// ---- Remaining formats (STL/OBJ/PLY). AMF is only verified in the browser because three's AMFLoader uses DOMParser. ----
const { loadModel } = await import('./src/model_loaders.js')
for (const [file, minTris] of [['cube.obj', 12], ['cube.ply', 12], ['pseudo_benchy.stl', 12]]) {
  const p = `packages/wasm-core/testing_files/${file}`
  const b = readFileSync(p)
  const objs = await loadModel(file, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  const tris = objs.reduce((a, o) => a + o.modelPos.length / 9, 0)
  assert.ok(tris >= minTris, `${p}: triangles ${tris} < ${minTris}`)
  assert.ok(objs.every(o => o.modelPos.every(Number.isFinite)), `${p}: NaN coordinate`)
  console.log(`ok  ${p}  objs=${objs.length} tris=${tris}`)
}
