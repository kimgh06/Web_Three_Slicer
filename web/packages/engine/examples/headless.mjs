// @orca-re/engine headless SDK example + independence proof: drive the engine from Node using ONLY the
// public API (no UI, no viewer). Generates a 20mm cube STL, slices it, prints stats + G-code length.
//   run: node web/packages/engine/examples/headless.mjs
import { createSlicer } from '../index.js'   // external consumers: import { createSlicer } from '@orca-re/engine'

// minimal binary-STL writer for a box (public API takes a binary-STL ArrayBuffer)
function boxTris(ox, oy, oz, sx, sy, sz) {
  const c = [[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v => [v[0]+ox, v[1]+oy, v[2]+oz])
  const q = (a,b,cc,d) => [[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]]
  return [...q(0,1,2,3), ...q(4,5,6,7), ...q(0,1,5,4), ...q(1,2,6,5), ...q(2,3,7,6), ...q(3,0,4,7)]
}
function trisToSTL(tris) {
  const buf = Buffer.alloc(84 + tris.length*50); buf.writeUInt32LE(tris.length, 80); let off = 84
  for (const t of tris) { off += 12; for (const p of t){ buf.writeFloatLE(p[0],off); buf.writeFloatLE(p[1],off+4); buf.writeFloatLE(p[2],off+8); off += 12 } buf.writeUInt16LE(0,off); off += 2 }
  return buf
}
const cube = trisToSTL(boxTris(-10,-10,0, 20,20,20))
const params = {
  layer_height: 0.2, first_layer_height: 0.2, line_width: 0.42, wall_loops: 2, infill_density: 0.15,
  nozzle_diameter: 0.4, filament_diameter: 1.75, print_speed: 60, first_layer_speed: 20, travel_speed: 150,
  nozzle_temp: 210, bed_temp: 60, top_shell_layers: 3, bottom_shell_layers: 3, skirt_loops: 1,
}

const slicer = await createSlicer()

// (a) batch slice
const r = slicer.slice(cube, params)
console.log(`batch : layers=${r.stats.layers} segments=${r.stats.path_segments} filament=${r.stats.filament_mm.toFixed(1)}mm gcode=${r.gcode.length} chars`)

// (b) streaming slice via onLayer (30단계) — assemble G-code from per-layer chunks
let chunks = 0, gbytes = 0
const rs = slicer.slice(cube, params, { onLayer: ({ gcode }) => { chunks++; gbytes += gcode.length } })
console.log(`stream: layers=${chunks} streamed=${rs.stats.streamed} assembled-gcode=${gbytes} chars`)

if (r.gcode.length > 0 && chunks > 0) console.log('OK — @orca-re/engine drives headlessly via the public API')
else { console.error('FAIL'); process.exit(1) }
slicer.dispose()
