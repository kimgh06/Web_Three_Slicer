// three-slicer SLA (resin) headless example: slice a cube with supports + pad through the public API,
// then show the typed capability refusal — an unsupported request errors, it never approximates.
//   run: node packages/engine/examples/sla_headless.mjs
import { createSlicer } from 'three-slicer'
import { deriveSlaParams, printerTechnology } from 'three-slicer/settings'

// minimal binary-STL writer for a 10mm cube. Winding matters here, unlike the FFF example: the SLA
//  support generator reads facet normals to find downward faces, so every face is CCW seen from outside.
function boxSTL() {
  const vertices = [[-5,-5,0],[5,-5,0],[5,5,0],[-5,5,0],[-5,-5,10],[5,-5,10],[5,5,10],[-5,5,10]]
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  const buf = Buffer.alloc(84 + faces.length * 50)
  buf.writeUInt32LE(faces.length, 80)
  faces.forEach((face, i) => {
    let off = 84 + i * 50 + 12
    for (const vi of face) for (const v of vertices[vi]) { buf.writeFloatLE(v, off); off += 4 }
  })
  return buf
}
const cube = boxSTL()

// A sparse settings map, the same shape the UI holds. printer_technology is what routes to slice_sla.
const settings = {
  printer_technology: 'SLA',
  layer_height: 0.05,
  exposure_time: 7,
  supports_enable: true,
  support_object_elevation: 5,
  pad_enable: true,
}
console.log(`technology: ${printerTechnology(settings)}`)

const slicer = await createSlicer()
const params = deriveSlaParams(settings)     // fills display/support/pad defaults (SL1 reference machine)

// (a) SLA slice — no G-code; masks, meshes and resin stats instead.
const r = slicer.sliceSla(cube, params)
if (r.error) { console.error('FAIL', r.error); process.exit(1) }
console.log(`sla   : layers=${r.stats.layers} (lift=${r.stats.lift_layers}) points=${r.stats.support_points}`
  + ` pad_layers=${r.stats.pad_layers} resin=${r.stats.resin_ml.toFixed(2)}ml`)
console.log(`meshes: support=${r.support_mesh.length / 9} tris, pad=${r.pad_mesh.length / 9} tris`)

// (b) the capability gate: hollowing is not ported, so the request is REFUSED with a stable code —
//     a solid slice answered to a hollow request would be a mislabeled print.
const refused = slicer.sliceSla(cube, deriveSlaParams({ ...settings, hollowing_enable: true }))
console.log(`gate  : ${refused.error}`)

if (r.stats.support_points > 0 && r.stats.pad_layers > 0 && /^SLA_UNSUPPORTED_HOLLOWING/.test(refused.error ?? ''))
  console.log('OK — SLA slices headlessly via the public API')
else { console.error('FAIL'); process.exit(1) }
slicer.dispose()
