// farm-dashboard — the integration file.
//
// One job's life on the client side: read a model, slice it for the printer it is going to, and hand the
// server the G-code. The server never sees the model and never runs a slicer — that is the whole point of
// the architecture this demo exists to show, and it is enforced here by what this function sends.
//
// Imports nothing but the package, so it can be lifted into any queue/farm app as-is.

import { createSlicerClient } from 'three-slicer/client'
import {
  printerSettings, printerDefaultPreset, printerKeys,
  processPresets, filamentPresets, deriveKernelParams, settingScalar,
} from 'three-slicer/settings'
import { loadModel } from 'three-slicer/viewer/loaders'

const without = (source, keys) => {
  const next = { ...source }
  for (const key of keys) delete next[key]
  return next
}

/** Cached per profile: a farm re-slices the same few machines over and over. */
const settingsCache = new Map()

/** printer profile -> its default process -> a compatible material, each catalog's keys cleared first. */
export async function settingsForPrinter(profile) {
  if (settingsCache.has(profile)) return settingsCache.get(profile)

  const [processApi, filamentApi] = await Promise.all([processPresets(), filamentPresets()])
  const machine = printerSettings(profile)
  if (!machine) throw new Error(`unknown printer profile: ${profile}`)

  let settings = { ...without({}, printerKeys), ...machine }
  const processName = printerDefaultPreset(profile) || processApi.listFor(profile)[0]
  const processSettings = processName ? processApi.settingsFor(processName) : null
  if (processSettings) settings = { ...without(settings, processApi.keys), ...processSettings }

  const materials = filamentApi.recommendedFor(profile).length
    ? filamentApi.recommendedFor(profile)
    : filamentApi.listFor(profile)
  const filamentSettings = materials[0] ? filamentApi.settingsFor(materials[0].name) : null
  if (filamentSettings) settings = { ...without(settings, filamentApi.keys), ...filamentSettings }

  settingsCache.set(profile, settings)
  return settings
}

export function bedOf(settings) {
  const corners = settings.printable_area ?? []
  const xs = corners.map(p => Number(Array.isArray(p) ? p[0] : String(p).split('x')[0]))
  const ys = corners.map(p => Number(Array.isArray(p) ? p[1] : String(p).split('x')[1]))
  if (!xs.length) return { width: 0, depth: 0, height: 0, centerX: 0, centerY: 0 }
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  return {
    width: maxX - minX, depth: maxY - minY,
    height: Number(settingScalar(settings, 'printable_height') ?? 0),
    centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2,
  }
}

/** Every supported format collapses to one triangle soup here, so nothing downstream cares which it was. */
export async function readModel(file) {
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
    triangles: modelPos.length / 9,
    modelPos,
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    min: { x: minX, y: minY, z: minZ },
  }
}

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
 * Not on the bed centre. The kernel takes plate-local coordinates and puts the part on the bed itself, so
 * a model pre-moved to the bed centre is shifted twice — measured on a 250 × 210 mm bed, a cube handed in
 * at (125, 105) came out of the slicer at X 234.7–265.4 / Y 194.7–225.3, i.e. off the plate, and only
 * `stats.over_bed_model` said so. Centred on the origin the same cube lands at X 109.7–140.3.
 *
 * Normals are computed here; `modelPos` carries vertices only.
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

/**
 * Slice a model for one printer and build the job payload.
 *
 * This function is the demo's whole argument in one place: the model goes in, and what comes out is
 * `{ name, printerId, gcode, layers, seconds, grams }` — text and numbers. The mesh, its vertex buffer
 * and its original file never leave here, so that payload is also exactly what a queue server would be
 * given (`POST /api/jobs`). This page keeps it in memory instead; see src/farm_store.js.
 */
export async function prepareJob({ client, model, printer, onProgress }) {
  const settings = await settingsForPrinter(printer.model)
  const bed = bedOf(settings)

  const over = overBed(model, bed)
  if (over.length) {
    const axes = over.map(o => `${o.axis} ${o.model.toFixed(1)}mm > ${o.bed.toFixed(0)}mm`).join(', ')
    throw new Error(`${model.name} does not fit ${printer.name} (${axes})`)
  }

  const result = await client.slice(toBinarySTL(model), deriveKernelParams(settings), { onProgress })
  if (result.error) throw new Error(result.error)
  if (!result.gcode) throw new Error('the slice produced no G-code')
  // The kernel's own verdict on placement. It stays false as long as the input was plate-local; if this
  // ever trips, the G-code would print off the plate even though every other number looks reasonable.
  if (result.stats.over_bed_model) throw new Error(`${model.name} slices outside ${printer.name}'s printable area`)

  const lengthMm = result.stats.filament_mm ?? 0
  const diameter = Number(settingScalar(settings, 'filament_diameter') ?? 1.75)
  const density = Number(settingScalar(settings, 'filament_density') ?? 1.24)

  return {
    payload: {
      name: model.name,
      printerId: printer.id,
      gcode: result.gcode,
      layers: result.stats.layers ?? 0,
      seconds: result.stats.time_estimate ?? 0,
      grams: lengthMm * Math.PI * (diameter / 2) ** 2 * density / 1000,
    },
    stats: result.stats,
  }
}

/** What `payload` would look like on the wire, with the G-code summarised rather than inlined. */
export function describePayload(payload) {
  return {
    ...payload,
    gcode: `<${(payload.gcode.length / 1024).toFixed(0)} kB of G-code text>`,
    seconds: Math.round(payload.seconds),
    grams: Number(payload.grams.toFixed(2)),
  }
}

/** One worker for the whole dashboard — jobs are sliced one after another, which is what a farm does. */
export function createFarmSlicer(makeWorker) {
  const client = createSlicerClient(makeWorker?.())
  return {
    client,
    warmup: () => client.warmup(),
    close: () => client.terminate(),
  }
}
