// Stage 26 verification (node): load STL/OBJ/PLY -> modelPos -> binary STL -> kernel slice -> G-code.
//  3MF/AMF depend on DOMParser (browser) -> verified under playwright.
import { readFileSync } from 'node:fs'
import createSlicer from '../engine/src/slicer_core.js'
import { loadModel, SUPPORTED_EXT, fileExt } from '../viewer/src/model_loaders.js'

function modelToSTL(pos) {   // N*9 z-up model -> binary STL
  const nTri = pos.length / 9
  const buf = Buffer.alloc(84 + nTri * 50); buf.writeUInt32LE(nTri, 80)
  let off = 84, vi = 0
  for (let t = 0; t < nTri; t++) { off += 12; for (let k = 0; k < 3; k++) { buf.writeFloatLE(pos[vi++], off); buf.writeFloatLE(pos[vi++], off + 4); buf.writeFloatLE(pos[vi++], off + 8); off += 12 } buf.writeUInt16LE(0, off); off += 2 }
  return buf
}
const params = { layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  nozzle_diameter: 0.4, filament_diameter: 1.75, flow_ratio: 1.0, print_speed: 60, first_layer_speed: 20, travel_speed: 150,
  nozzle_temp: 210, bed_temp: 60, top_shell_layers: 3, bottom_shell_layers: 3, skirt_loops: 0, brim_width: 0, infill_angle: 45 }
const M = await createSlicer()
let fail = 0; const ok = (c, m) => { console.log((c ? '  ok: ' : '  FAIL: ') + m); if (!c) fail++ }

ok(SUPPORTED_EXT.join(',') === 'stl,obj,3mf,amf,ply', `supported: ${SUPPORTED_EXT.join(',')}`)

const cases = [
  ['stl', 'cube20.stl', readFileSync('cube20.stl')],
  ['obj', 'cube.obj', readFileSync('testing_files/cube.obj')],
  ['ply', 'cube.ply', readFileSync('testing_files/cube.ply')],
]
for (const [ext, name, data] of cases) {
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  const objs = await loadModel(name, ab)
  const pos = objs[0]?.modelPos
  const nTri = pos ? pos.length / 9 : 0
  // bbox (z-up)
  let mnz = 1e9, mxz = -1e9, mnx = 1e9, mxx = -1e9
  for (let i = 0; i < pos.length; i += 3) { const x = pos[i], z = pos[i + 2]; if (z < mnz) mnz = z; if (z > mxz) mxz = z; if (x < mnx) mnx = x; if (x > mxx) mxx = x }
  const r = M.slice(new Uint8Array(modelToSTL(pos)), JSON.stringify(params), () => {})
  const layers = r.layers?.length || 0, gclen = (r.gcode || '').length
  console.log(`  [${ext}] objs=${objs.length} tris=${nTri} bbox x:${(mxx-mnx).toFixed(0)} z:${(mxz-mnz).toFixed(0)} → layers=${layers} gcode=${gclen}B`)
  ok(nTri === 12, `${ext}: 12 triangles (cube)`)
  ok(Math.abs((mxz - mnz) - 20) < 0.1 && Math.abs((mxx - mnx) - 20) < 0.1, `${ext}: 20mm cube bbox (z-up preserved)`)
  ok(layers >= 90 && layers <= 105 && gclen > 1000, `${ext}: slices to ~99 layers + real G-code`)
}
console.log(fail === 0 ? '\nLOADERS TEST PASSED (STL/OBJ/PLY; 3MF/AMF = browser)' : `\n${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
