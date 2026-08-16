// Smoke test for the design-to-print loop: the geometry contracts, the STL bytes, one real slice, and
// the two rules that make the loop behave — debounce coalescing and the generation guard.
import assert from 'node:assert/strict'
import { createSlicer } from 'three-slicer'
import { deriveKernelParams } from 'three-slicer/settings'
import { DEFAULTS, makeBracket, trianglesOf, validate } from './src/bracket.js'
import { loadSettings, bedOf, toBinarySTL, toFeedback, disabledControls, createFeedbackLoop } from './src/print_feedback.js'

// --- CAD domain
assert.equal(validate(DEFAULTS), null)
assert.match(validate({ ...DEFAULTS, holeDiameter: 60 }), /leaves less than/)

const positions = trianglesOf(makeBracket(DEFAULTS))
assert.equal(positions.length % 9, 0, 'triangle soup must be whole triangles')
assert.ok(positions.length / 9 > 100, 'a plate with a 48-segment hole has plenty of facets')

// --- settings + bed
const { settings, processName, filamentName } = await loadSettings('Bambu Lab P1S 0.4 nozzle')
assert.ok(processName && filamentName, 'a printer must resolve a process and a material')
const bed = bedOf(settings)
assert.deepEqual([bed.width, bed.depth, bed.centerX], [256, 256, 128])
assert.equal(typeof disabledControls(settings, ['sparse_infill_density']), 'object')

// --- STL bytes land on the bed
const stl = toBinarySTL(positions)
const view = new DataView(stl.buffer)
const triangles = view.getUint32(80, true)
assert.equal(triangles, positions.length / 9)
let minZ = Infinity, minX = Infinity, maxX = -Infinity
for (let t = 0; t < triangles; t++) {
  for (let v = 0; v < 3; v++) {
    const o = 84 + t * 50 + 12 + v * 12
    minX = Math.min(minX, view.getFloat32(o, true))
    maxX = Math.max(maxX, view.getFloat32(o, true))
    minZ = Math.min(minZ, view.getFloat32(o + 8, true))
  }
}
assert.ok(Math.abs(minZ) < 1e-3, 'the part must sit on the plate')
assert.ok(Math.abs((minX + maxX) / 2) < 1e-3, 'the part must be centred on the ORIGIN, not the bed centre')

// --- a real slice, and thicker means more material
const slicer = await createSlicer()
const sliceOf = params => {
  const result = slicer.slice(toBinarySTL(trianglesOf(makeBracket(params))), deriveKernelParams(settings), {})
  assert.equal(result.error ?? '', '')
  assert.equal(result.stats.over_bed_model, false, 'plate-local input must slice inside the printable area')
  return toFeedback(result.stats, settings)
}
const thin = sliceOf(DEFAULTS)
assert.ok(thin.seconds > 0 && thin.grams > 0, 'the bracket must produce a real estimate')
const thick = sliceOf({ ...DEFAULTS, thickness: DEFAULTS.thickness * 2 })
assert.ok(thick.grams > thin.grams, `doubling thickness must use more material (${thin.grams} -> ${thick.grams})`)

// --- the loop's own rules, against a fake worker (no kernel needed)
class FakeWorker {
  constructor() { this.listeners = {}; this.slices = 0; this.delay = 20 }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  postMessage(message) {
    const reply = data => this.listeners.message?.forEach(fn => fn({ data }))
    if (message.cmd === 'warmup') { setTimeout(() => reply({ type: 'warm' }), 0); return }
    const answer = ++this.slices * 100   // 100 for the first slice, 200 for the second, …
    // The worker's own shape: `done` carries a `result`, and the client hands that back (client.js:88).
    setTimeout(() => reply({
      type: 'done',
      result: { stats: { time_estimate: answer, filament_mm: 1000, layers: 10 } },
    }), this.delay)
  }
  terminate() {}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// (1) debounce coalesces a burst into one slice, of the LAST geometry
{
  const worker = new FakeWorker()
  const ready = []
  const loop = createFeedbackLoop({
    makeWorker: () => worker,
    debounceMs: 30,
    onState: state => { if (state.status === 'ready') ready.push(state.feedback.seconds) },
  })
  for (let i = 0; i < 5; i++) loop.request(positions, settings)
  await sleep(200)
  assert.equal(worker.slices, 1, `5 rapid changes must slice once, sliced ${worker.slices}`)
  assert.deepEqual(ready, [100])
  loop.close()
}

// (2) a superseded slice must not overwrite a newer answer
{
  const worker = new FakeWorker()
  worker.delay = 80
  const ready = []
  const loop = createFeedbackLoop({
    makeWorker: () => worker,
    debounceMs: 0,
    onState: state => { if (state.status === 'ready') ready.push(state.feedback.seconds) },
  })
  loop.requestNow(positions, settings)   // generation 1 — in flight
  await sleep(10)
  loop.request(positions, settings)      // generation 2 — supersedes it
  await sleep(400)
  assert.deepEqual(ready, [200], `only the newest answer may reach the UI, got ${JSON.stringify(ready)}`)
  loop.close()
}

// (3) an invalidated design's slice must not land on top of the error the user is looking at
{
  const worker = new FakeWorker()
  worker.delay = 80
  const ready = []
  const loop = createFeedbackLoop({
    makeWorker: () => worker,
    debounceMs: 0,
    onState: state => { if (state.status === 'ready') ready.push(state.feedback.seconds) },
  })
  loop.requestNow(positions, settings)   // a valid change, in flight
  await sleep(10)
  loop.invalidate()                      // the next slider position is not sliceable
  await sleep(400)
  assert.deepEqual(ready, [], `an invalidated slice must be discarded, got ${JSON.stringify(ready)}`)
  loop.close()
}

console.log(`ok — ${(positions.length / 9).toLocaleString()} facets, ${Math.round(thin.seconds)}s/${thin.grams.toFixed(1)}g thin vs ${Math.round(thick.seconds)}s/${thick.grams.toFixed(1)}g thick`)
