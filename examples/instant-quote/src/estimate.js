// instant-quote — the integration file.
//
// This is the whole three-slicer integration: catalog -> settings -> slice -> physical quantities.
// It imports nothing but the package, so it can be copied into any app as-is. Pricing is NOT here;
// turning an estimate into money is your business logic (see src/mock/pricing.js).

import { createSlicerClient } from 'three-slicer/client'
import {
  printerKeys, printerSettings, printerDefaultPreset, printersByVendor,
  processPresets, filamentPresets, deriveKernelParams, settingScalar,
} from 'three-slicer/settings'
import { loadModel } from 'three-slicer/viewer/loaders'

/** Printer/process/material lists. The preset catalogs load lazily, so this is async. */
export async function loadCatalog() {
  const [processApi, filamentApi] = await Promise.all([processPresets(), filamentPresets()])
  const printers = Object.entries(printersByVendor)
    .flatMap(([vendor, entries]) => Object.keys(entries).map(name => ({ vendor, name })))
  return {
    printers,
    processApi,
    filamentApi,
    processesFor: printer => processApi.listFor(printer),
    materialsFor: printer => {
      const recommended = filamentApi.recommendedFor(printer)
      return recommended.length ? recommended : filamentApi.listFor(printer)
    },
    defaultProcessFor: printer => printerDefaultPreset(printer) || processApi.listFor(printer)[0] || '',
  }
}

const without = (source, keys) => {
  const next = { ...source }
  for (const key of keys) delete next[key]
  return next
}

/**
 * Merge the three presets into one settings map. Each catalog's keys are cleared before its preset is
 * applied — a preset only carries the keys it sets, so without the clear the previous machine's or
 * material's values survive into the new selection.
 */
export function buildSettings(catalog, { printer, process, filament }) {
  const machine = printerSettings(printer)
  if (!machine) throw new Error(`unknown printer profile: ${printer}`)
  let settings = { ...without({}, printerKeys), ...machine }

  const processSettings = catalog.processApi.settingsFor(process)
  if (!processSettings) throw new Error(`unknown process preset: ${process}`)
  settings = { ...without(settings, catalog.processApi.keys), ...processSettings }

  const filamentSettings = catalog.filamentApi.settingsFor(filament)
  if (!filamentSettings) throw new Error(`unknown material: ${filament}`)
  settings = { ...without(settings, catalog.filamentApi.keys), ...filamentSettings }

  return settings
}

/** Bed rectangle from a printer profile. `printable_area` is a list of [x, y] corners. */
export function bedOf(settings) {
  const corners = settings.printable_area || []
  const xs = corners.map(p => Number(Array.isArray(p) ? p[0] : String(p).split('x')[0]))
  const ys = corners.map(p => Number(Array.isArray(p) ? p[1] : String(p).split('x')[1]))
  if (!xs.length) return { width: 0, depth: 0, height: 0, centerX: 0, centerY: 0 }
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  return {
    width: maxX - minX,
    depth: maxY - minY,
    height: Number(settingScalar(settings, 'printable_height') ?? 0),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  }
}

/**
 * Read a dropped file into one merged triangle soup. Every supported format goes through the same path —
 * loadModel returns `modelPos` (N*9 vertex coordinates) for STL, OBJ, 3MF, AMF and PLY alike, so nothing
 * downstream has to know which one it was.
 */
export async function prepareModel(file) {
  const objects = await loadModel(file.name, await file.arrayBuffer())
  if (!objects.length) throw new Error('no geometry in this file')

  const total = objects.reduce((sum, object) => sum + object.modelPos.length, 0)
  const modelPos = new Float32Array(total)
  let offset = 0
  for (const object of objects) { modelPos.set(object.modelPos, offset); offset += object.modelPos.length }

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < modelPos.length; i += 3) {
    const x = modelPos[i], y = modelPos[i + 1], z = modelPos[i + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }

  return {
    name: file.name,
    objects: objects.length,
    triangles: modelPos.length / 9,
    modelPos,
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    min: { x: minX, y: minY, z: minZ },
  }
}

/** Does the model fit the selected machine? Returns the axes that do not. */
export function overBed(model, bed) {
  const over = []
  if (model.size.x > bed.width) over.push({ axis: 'X', model: model.size.x, bed: bed.width })
  if (model.size.y > bed.depth) over.push({ axis: 'Y', model: model.size.y, bed: bed.depth })
  if (bed.height && model.size.z > bed.height) over.push({ axis: 'Z', model: model.size.z, bed: bed.height })
  return over
}

/**
 * Binary STL for the kernel: centred on the ORIGIN in x/y, lowest point at z=0.
 *
 * Not on the bed centre. The kernel takes plate-local coordinates and places the part on the bed itself,
 * so a model pre-moved to the bed centre is shifted twice — measured on a 250 × 210 mm bed, a cube handed
 * in at (125, 105) came out of the slicer at X 234.7–265.4, off the plate, with `stats.over_bed_model`
 * the only sign. Centred on the origin it lands at X 109.7–140.3.
 *
 * Facet normals are computed rather than copied: `modelPos` carries vertices only.
 */
export function toBinarySTL(model) {
  const { modelPos, size, min } = model
  const dx = -(min.x + size.x / 2)
  const dy = -(min.y + size.y / 2)
  const dz = -min.z

  const triangles = modelPos.length / 9
  const view = new DataView(new ArrayBuffer(84 + triangles * 50))
  view.setUint32(80, triangles, true)

  for (let t = 0; t < triangles; t++) {
    const i = t * 9, o = 84 + t * 50
    const ax = modelPos[i] + dx, ay = modelPos[i + 1] + dy, az = modelPos[i + 2] + dz
    const bx = modelPos[i + 3] + dx, by = modelPos[i + 4] + dy, bz = modelPos[i + 5] + dz
    const cx = modelPos[i + 6] + dx, cy = modelPos[i + 7] + dy, cz = modelPos[i + 8] + dz
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz) || 1
    view.setFloat32(o, nx / length, true)
    view.setFloat32(o + 4, ny / length, true)
    view.setFloat32(o + 8, nz / length, true)
    const vertices = [ax, ay, az, bx, by, bz, cx, cy, cz]
    for (let v = 0; v < 9; v++) view.setFloat32(o + 12 + v * 4, vertices[v], true)
  }
  return new Uint8Array(view.buffer)
}

/** Kernel stats -> the physical quantities a quote is priced on. */
export function toEstimate(stats, settings) {
  const lengthMm = stats.filament_mm ?? 0
  const diameter = Number(settingScalar(settings, 'filament_diameter') ?? 1.75)
  const density = Number(settingScalar(settings, 'filament_density') ?? 1.24)
  return {
    seconds: stats.time_estimate ?? 0,
    filamentMm: lengthMm,
    // mm * mm² = mm³; g/cm³ / 1000 = g/mm³
    grams: lengthMm * Math.PI * (diameter / 2) ** 2 * density / 1000,
    layers: stats.layers ?? 0,
  }
}

/**
 * One slicer worker, reused across quotes.
 *
 * `makeWorker` is the caller's, because how a worker is built is a bundler question, not a slicing one —
 * see src/main.js for the Vite answer. Omit it and the package builds its own, which works in dev and in
 * bundlers that follow `new URL(..., import.meta.url)` into node_modules.
 *
 * `cancel()` writes a flag the kernel polls from inside its C++ loop, which lives in a SharedArrayBuffer
 * and therefore exists only on a cross-origin-isolated page. On plain static hosting it returns false, so
 * the fallback is to kill the worker and build a new one — the next quote pays the warmup again.
 */
export function createEstimator(makeWorker) {
  let client = createSlicerClient(makeWorker?.())

  return {
    warmup: () => client.warmup(),

    async run(stlBytes, settings, onProgress) {
      // The worker takes ownership of the buffer, so hand it a copy — the caller may re-quote the same model.
      const result = await client.slice(stlBytes.slice(0), deriveKernelParams(settings), { onProgress })
      if (result.error) throw new Error(result.error)
      // The kernel's own placement verdict. It only trips if the input was not plate-local, or if the
      // model is genuinely too big — either way the G-code would print off the plate.
      if (result.stats.over_bed_model) throw new Error('this model slices outside the printable area')
      // `layers` rides along because no onLayer callback was passed: the client assembles the streamed
      // layers into the same shape a batch slice returns ([{z, paths, widths}]), which is exactly what
      // three-slicer/viewer/toolpath consumes. Nothing has to re-parse the G-code to draw the result.
      // NOT `layers` — that key is the layer COUNT from toEstimate(), and spreading the array over it
      // makes the UI print "[object Object],[object Object],…" where a number belongs.
      return { ...toEstimate(result.stats, settings), layerStream: result.layers ?? [] }
    },

    cancel() {
      if (client.cancel()) return 'flag'
      client.terminate()
      client = createSlicerClient(makeWorker?.())
      return 'restarted'
    },

    close() { client.terminate() },
  }
}
