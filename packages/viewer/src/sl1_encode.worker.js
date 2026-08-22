// SL1 encode worker: one strided subset of layers -> PNG mask bytes. The whole SL1 build is convertToBlob
//  (measured 88% of 7.8s on a 960-layer Benchy), and it refuses to parallelize INSIDE a thread (batching 8
//  on the main thread bought 12%) while parallelizing cleanly ACROSS them: 4 workers 5.6x, 8 workers 9.3x
//  on the same archive. One canvas is created per worker and reused — creating one per layer is what the
//  sequential path's 597ms "clear" stage actually was.
import { slaRasterTransform, drawLayer } from './core/sl1_write.js'

// In: { indices: number[] (absolute layer numbers this worker owns), paths: Float32Array[] (same order,
//       structured-clone copies — the main thread keeps its own for the sidecars), params }
// Out: { progress } every 8 layers, then one { indices, pngs: Uint8Array[] } with the buffers transferred.
self.onmessage = async ({ data: { indices, paths, params } }) => {
  const transform = slaRasterTransform(params)
  const canvas = new OffscreenCanvas(transform.px, transform.py)
  const ctx = canvas.getContext('2d')
  const pngs = []
  for (let k = 0; k < indices.length; k++) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, transform.px, transform.py)
    ctx.fillStyle = '#fff'
    drawLayer(ctx, paths[k], transform)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    pngs.push(new Uint8Array(await blob.arrayBuffer()))
    if ((k & 7) === 7) self.postMessage({ progress: k + 1 })
  }
  self.postMessage({ indices, pngs }, pngs.map(png => png.buffer))
}
