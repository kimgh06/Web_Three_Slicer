// Smoke test for src/estimate.js — the integration file's contracts, plus one real slice.
// Node has no `Worker`, so the estimator itself is not exercised here; the kernel is driven through
// the package's Node entry instead, which slices the same bytes with the same params.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSlicer } from 'three-slicer'
import { deriveKernelParams } from 'three-slicer/settings'
import { loadCatalog, buildSettings, bedOf, overBed, toBinarySTL, toEstimate } from './src/estimate.js'
import { priceOf } from './src/mock/pricing.js'

const PRINTER = 'Bambu Lab P1S 0.4 nozzle'
const catalog = await loadCatalog()

// --- settings: the three presets merge, and each catalog's keys are cleared before the next
const process = catalog.defaultProcessFor(PRINTER)
const materials = catalog.materialsFor(PRINTER)
const settings = buildSettings(catalog, { printer: PRINTER, process, filament: materials[0].name })
assert.ok(Object.keys(settings).length > 50, 'merged settings should carry every preset layer')
assert.equal(settings.printable_height, 250)

const other = materials.find(m => m.name !== materials[0].name)
if (other) {
  const swapped = buildSettings(catalog, { printer: PRINTER, process, filament: other.name })
  const leaked = catalog.filamentApi.keys.filter(k => k in swapped && !(k in (catalog.filamentApi.settingsFor(other.name) ?? {})))
  assert.deepEqual(leaked, [], 'switching material must not leave the previous material behind')
}

assert.throws(() => buildSettings(catalog, { printer: 'nope', process, filament: materials[0].name }), /unknown printer/)

// --- bed geometry
const bed = bedOf(settings)
assert.deepEqual(
  { width: bed.width, depth: bed.depth, centerX: bed.centerX, centerY: bed.centerY },
  { width: 256, depth: 256, centerX: 128, centerY: 128 },
)

// --- the fixture, read the way prepareModel would hand it on (STL is already triangle soup)
const stlBytes = new Uint8Array(readFileSync(new URL('./public/calibration-cube.stl', import.meta.url)))
const view = new DataView(stlBytes.buffer, stlBytes.byteOffset, stlBytes.byteLength)
const triangles = view.getUint32(80, true)
const modelPos = new Float32Array(triangles * 9)
for (let t = 0; t < triangles; t++) {
  for (let v = 0; v < 9; v++) modelPos[t * 9 + v] = view.getFloat32(84 + t * 50 + 12 + v * 4, true)
}
const model = {
  name: 'calibration-cube.stl', objects: 1, triangles, modelPos,
  size: { x: 20, y: 20, z: 20 }, min: { x: -10, y: -10, z: 0 },
}

// --- build volume
assert.deepEqual(overBed(model, bed), [], '20mm cube fits a 256mm bed')
const huge = { ...model, size: { x: 300, y: 20, z: 20 } }
assert.equal(overBed(huge, bed)[0].axis, 'X')

// --- STL bytes: same triangle count, centred on the bed, sitting on z=0
const stl = toBinarySTL(model)
const out = new DataView(stl.buffer)
assert.equal(out.getUint32(80, true), triangles)
assert.equal(stl.length, 84 + triangles * 50)
let minX = Infinity, maxX = -Infinity, minZ = Infinity
for (let t = 0; t < triangles; t++) {
  for (let v = 0; v < 3; v++) {
    const o = 84 + t * 50 + 12 + v * 12
    minX = Math.min(minX, out.getFloat32(o, true))
    maxX = Math.max(maxX, out.getFloat32(o, true))
    minZ = Math.min(minZ, out.getFloat32(o + 8, true))
  }
}
assert.ok(Math.abs((minX + maxX) / 2) < 1e-3, 'model must be centred on the ORIGIN, not the bed centre')
assert.ok(Math.abs(minZ) < 1e-3, 'model must sit on the plate')

// --- a real slice
const slicer = await createSlicer()
const result = slicer.slice(stl, deriveKernelParams(settings), {})
assert.equal(result.error ?? '', '', 'slice must not error')
assert.equal(result.stats.over_bed_model, false, 'plate-local input must slice inside the printable area')
const estimate = toEstimate(result.stats, settings)
assert.ok(estimate.seconds > 0, 'print time must be positive')
assert.ok(estimate.filamentMm > 0, 'filament length must be positive')
assert.ok(estimate.grams > 0 && estimate.grams < 50, `20mm cube should weigh a few grams, got ${estimate.grams}`)

// --- price
const price = priceOf(estimate, 2)
assert.ok(price.total > 0)
assert.ok(price.total > priceOf(estimate, 1).total, 'quantity must scale the price')

console.log(`ok — ${estimate.seconds.toFixed(0)}s, ${estimate.filamentMm.toFixed(0)}mm, ${estimate.grams.toFixed(2)}g, ${estimate.layers} layers`)
