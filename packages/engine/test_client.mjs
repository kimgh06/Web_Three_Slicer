// createSlicerClient protocol semantics, driven against a fake worker.
//
// No WASM here on purpose: what this wrapper can get wrong is message correlation — matching a reply to the
// caller that is waiting for it, assembling a streamed slice, failing the right promise — and none of that needs
// a kernel. The kernel side of the same protocol is already covered by wasm-core/test.mjs.
//   run: node packages/engine/test_client.mjs
import { createSlicerClient } from './src/client.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

class FakeWorker {
  constructor() { this.listeners = {}; this.sent = []; this.terminated = false }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  postMessage(message, transfer) { this.sent.push({ message, transfer }) }
  terminate() { this.terminated = true }
  emit(data) { for (const fn of this.listeners.message ?? []) fn({ data }) }
  get last() { return this.sent[this.sent.length - 1].message }
}
const settled = async (promise) => { try { return { value: await promise } } catch (error) { return { error } } }

console.log('\n[client: the slice request shape]')
{
  const worker = new FakeWorker()
  const client = createSlicerClient(worker)
  const stl = new ArrayBuffer(84)
  const promise = client.slice(stl, { layer_height: 0.2 })
  check('carries no cmd — that is what selects slicing', !('cmd' in worker.last))
  check('params is stringified for the caller', worker.last.params === '{"layer_height":0.2}')
  check('an object params is not sent as an object', typeof worker.last.params === 'string')
  check('the STL buffer is transferred, not copied', worker.sent[0].transfer[0] === stl)
  worker.emit({ type: 'done', result: { gcode: 'G1', stats: { layers: 3 } } })
  const { value } = await settled(promise)
  check('resolves with the result', value?.gcode === 'G1' && value?.stats.layers === 3)
  // A JSON string must survive untouched — double-stringifying it would hand the kernel a quoted blob.
  client.slice(stl, '{"raw":1}')
  check('a string params passes through unchanged', worker.last.params === '{"raw":1}')
}

console.log('\n[client: a streamed slice]')
{
  const worker = new FakeWorker()
  const client = createSlicerClient(worker)
  const progress = []
  const promise = client.slice(new ArrayBuffer(84), {}, { onProgress: (d, t) => progress.push([d, t]) })
  worker.emit({ type: 'progress', done: 1, total: 2 })
  worker.emit({ type: 'layer', z: 0.2, idx: 0, gcode: 'A', paths: new Float32Array(0), widths: new Float32Array(0) })
  worker.emit({ type: 'layer', z: 0.4, idx: 1, gcode: 'B', paths: new Float32Array(0), widths: new Float32Array(0) })
  worker.emit({ type: 'done', result: { stats: { layers: 2, streamed: true } } })
  const { value } = await settled(promise)
  check('progress reaches the callback', progress.length === 1 && progress[0][0] === 1)
  check('the layer chunks are assembled into gcode', value?.gcode === 'AB', JSON.stringify(value?.gcode))
  check('the layers come back too', value?.layers?.length === 2)
  check('the stats survive assembly', value?.stats.streamed === true)
}

console.log('\n[client: onLayer takes ownership]')
{
  const worker = new FakeWorker()
  const client = createSlicerClient(worker)
  const taken = []
  const promise = client.slice(new ArrayBuffer(84), {}, { onLayer: (layer) => taken.push(layer) })
  worker.emit({ type: 'layer', z: 0.2, idx: 0, gcode: 'A', paths: new Float32Array(0), widths: new Float32Array(0) })
  worker.emit({ type: 'done', result: { stats: { layers: 1, streamed: true } } })
  const { value } = await settled(promise)
  check('the layer reaches the callback', taken.length === 1 && taken[0].gcode === 'A')
  // The whole point of streaming is not holding the model in memory; buffering behind the caller's back would
  //  defeat it on exactly the large models it exists for.
  check('nothing is buffered when the caller takes the layers', value?.gcode === undefined)
}

console.log('\n[client: replies match callers in order]')
{
  const worker = new FakeWorker()
  const client = createSlicerClient(worker)
  const first = client.prepare(new ArrayBuffer(84))
  const second = client.exportPaint()
  worker.emit({ type: 'prepared', facets: 12, kept: false })
  worker.emit({ type: 'paintExport', supported: true, facets: [1], hex: '0C' })
  const a = await settled(first), b = await settled(second)
  check('the first caller gets the first reply', a.value?.facets === 12)
  check('the second caller gets the second', b.value?.hex === '0C')
}

console.log('\n[client: paint counts and erase]')
{
  const worker = new FakeWorker()
  const client = createSlicerClient(worker)
  const promise = client.paint({ facet: 0, hx: 0, hy: 0, hz: 0, cx: 0, cy: 0, cz: 1, radius: 2, state: 3, states: [1, 2, 3] })
  check('paint is addressed by cmd', worker.last.cmd === 'paint' && worker.last.state === 3)
  worker.emit({ type: 'painted', enf: 4, blk: 5, counts: { 1: 4, 2: 5, 3: 6 } })
  const { value } = await settled(promise)
  check('enf/blk are named on the way out', value?.enforcer === 4 && value?.blocker === 5)
  check('the per-state counts survive', value?.counts?.[3] === 6)
  client.erase({ facet: 0, hx: 0, hy: 0, hz: 0, cx: 0, cy: 0, cz: 1, radius: 2 })
  // Not {cmd:'paint', state:0}: a JS false coerces to 0 == NONE at the WASM boundary, so the state path rejects 0.
  check('erase is its own command', worker.last.cmd === 'erase' && !('state' in worker.last))
}

console.log('\n[client: failure and teardown]')
{
  const worker = new FakeWorker()
  const client = createSlicerClient(worker)
  const promise = client.slice(new ArrayBuffer(84), {})
  worker.emit({ type: 'error', error: 'memory access out of bounds' })
  const { error } = await settled(promise)
  check('an error reply rejects the pending call', /out of bounds/.test(error?.message ?? ''))

  check('cancel is false before the worker shares the flag', client.cancel() === false)
  const shared = new SharedArrayBuffer(8)
  worker.emit({ type: 'supsab', buf: shared, ptr: 0, cancelPtr: 4 })
  check('cancel writes the flag once it is shared', client.cancel() === true)
  check('...and the kernel would see it', new Uint32Array(shared, 4, 1)[0] === 1)

  const orphan = client.slice(new ArrayBuffer(84), {})
  client.terminate()
  const { error: teardown } = await settled(orphan)
  check('terminate rejects what was still in flight', /terminated/.test(teardown?.message ?? ''))
  check('...and kills the worker', worker.terminated === true)
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL CLIENT CHECKS PASSED\n')
process.exit(failures ? 1 : 0)
