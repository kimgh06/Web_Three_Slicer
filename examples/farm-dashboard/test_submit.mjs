// Smoke test for the farm's client side, plus the architectural claim the demo makes: the queue holds
// G-code it never inspects, and what a job submission would put on the wire is text and numbers.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSlicer } from 'three-slicer'
import { deriveKernelParams } from 'three-slicer/settings'
import { parseGcode } from 'three-slicer/viewer/gcode'
import { settingsForPrinter, bedOf, overBed, toBinarySTL, prepareJob, describePayload } from './src/submit_job.js'
import { createFarm } from './src/farm_store.js'

// --- the queue has no slicer in it: it imports nothing at all
const storeSource = readFileSync(new URL('./src/farm_store.js', import.meta.url), 'utf8')
const imports = [...storeSource.matchAll(/^\s*import\s.*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]/gm)]
  .map(match => match[1] ?? match[2])
assert.deepEqual(imports, [], `the queue must import nothing, got ${imports}`)

// --- settings per printer, and the bed each one has
const p1s = await settingsForPrinter('Bambu Lab P1S 0.4 nozzle')
const mk4 = await settingsForPrinter('Prusa MK4 0.4 nozzle')
assert.deepEqual([bedOf(p1s).width, bedOf(p1s).depth], [256, 256])
assert.deepEqual([bedOf(mk4).width, bedOf(mk4).depth], [250, 210])

// --- the fixture, as readModel would hand it on
const bytes = new Uint8Array(readFileSync(new URL('./public/calibration-cube.stl', import.meta.url)))
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const triangles = view.getUint32(80, true)
const modelPos = new Float32Array(triangles * 9)
for (let t = 0; t < triangles; t++) {
  for (let v = 0; v < 9; v++) modelPos[t * 9 + v] = view.getFloat32(84 + t * 50 + 12 + v * 4, true)
}
const model = {
  name: 'calibration-cube.stl', triangles, modelPos,
  size: { x: 20, y: 20, z: 20 }, min: { x: -10, y: -10, z: 0 },
}

// --- build volume is checked against the TARGET printer, not the operator's default
assert.deepEqual(overBed(model, bedOf(mk4)), [])
assert.equal(overBed({ ...model, size: { x: 260, y: 20, z: 20 } }, bedOf(mk4))[0].axis, 'X')

// --- a real slice, then read the G-code back the way the dashboard does
const slicer = await createSlicer()
const result = slicer.slice(toBinarySTL(model), deriveKernelParams(p1s), {})
assert.equal(result.error ?? '', '')
assert.ok(result.gcode.length > 1000, 'a batch slice must return G-code text')
assert.equal(result.stats.over_bed_model, false, 'plate-local input must slice inside the printable area')
const parsed = parseGcode(result.gcode)
assert.ok(parsed.stats.layers > 10, `the G-code must re-parse into layers, got ${parsed.stats.layers}`)
assert.ok(parsed.stats.path_segments > 100, 'the re-parsed G-code must carry printable segments')

// --- what a submission would send
{
  const fakeClient = { slice: async () => ({ gcode: result.gcode, stats: result.stats }) }
  const printer = { id: 'p3', name: 'Printer 03', model: 'Prusa MK4 0.4 nozzle' }
  const { payload: sent } = await prepareJob({ client: fakeClient, model, printer })
  assert.deepEqual(
    Object.keys(sent).sort(),
    ['gcode', 'grams', 'layers', 'name', 'printerId', 'seconds'],
    'the wire payload must carry nothing but G-code text and numbers',
  )
  assert.equal(typeof sent.gcode, 'string')
  assert.ok(sent.grams > 0 && sent.seconds > 0 && sent.layers > 0)
  // The model never goes with it — no vertex buffer, under any key.
  for (const [key, value] of Object.entries(sent)) {
    assert.ok(!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer), `${key} must not be binary`)
  }

  // The inspector never inlines the G-code, so a 300 kB job stays readable on screen.
  assert.match(describePayload(sent).gcode, /kB of G-code text/)

  // …and a model that does not fit is rejected before anything is built.
  const tooBig = { ...model, size: { x: 260, y: 20, z: 20 } }
  await assert.rejects(() => prepareJob({ client: fakeClient, model: tooBig, printer }), /does not fit/)
}

// --- the queue itself: a job runs only on an online printer, and finishes
{
  const farm = createFarm({ tickMs: 5 })
  const before = farm.snapshot()
  assert.equal(before.jobs.length, 0, 'the farm starts empty — nothing can create a job but a slice')
  assert.equal(before.printers.filter(p => p.online).length, 3)

  const payload = { name: 'cube.stl', printerId: 'p4', gcode: result.gcode, layers: 20, seconds: 600, grams: 4 }
  farm.addJob(payload)                       // p4 is offline
  await new Promise(r => setTimeout(r, 80))
  assert.equal(farm.snapshot().jobs[0].state, 'queued', 'an offline printer must not start the job')

  farm.setOnline('p4', true)
  await new Promise(r => setTimeout(r, 600))
  const done = farm.snapshot().jobs[0]
  assert.equal(done.state, 'completed', `the job must finish once the printer is online, got ${done.state}`)
  assert.equal(done.layer, done.layers)

  assert.equal(farm.gcodeOf(done.id), result.gcode, 'the queue stores the G-code verbatim')
  assert.ok(!('gcode' in done), 'a snapshot must not carry the G-code around')
  farm.stop()
}

console.log(`ok — ${parsed.stats.layers} layers re-parsed, ${(result.gcode.length / 1024).toFixed(0)} kB of G-code, queue imports: none`)
