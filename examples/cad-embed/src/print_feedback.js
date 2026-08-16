// cad-embed — the integration file.
//
// A design tool's side of three-slicer: hand it geometry, get manufacturing numbers back. It imports
// nothing but the package, so it drops into any CAD/configurator app as-is.
//
// The whole point is the loop: a parameter moves, the geometry is rebuilt, and the estimate follows —
// without the user ever exporting a file. Two things make that loop behave:
//   * a debounce, so dragging a slider does not queue one slice per pixel, and
//   * a generation counter, so a slice that is already obsolete cannot overwrite a newer answer.
// Both live here rather than in the UI, because getting them wrong is what makes an integration feel broken.

import { createSlicerClient } from 'three-slicer/client'
import {
  printerKeys, printerSettings, printerDefaultPreset,
  processPresets, filamentPresets, deriveKernelParams, settingScalar,
} from 'three-slicer/settings'
import { makeCfg, disabledKeys } from 'three-slicer/toggle'

export const RESLICE_DEBOUNCE_MS = 700

const without = (source, keys) => {
  const next = { ...source }
  for (const key of keys) delete next[key]
  return next
}

/** printer -> its default process -> a compatible material, each catalog's keys cleared first. */
export async function loadSettings(profile) {
  const [processApi, filamentApi] = await Promise.all([processPresets(), filamentPresets()])
  const machine = printerSettings(profile)
  if (!machine) throw new Error(`unknown printer profile: ${profile}`)

  let settings = { ...machine }
  const processName = printerDefaultPreset(profile) || processApi.listFor(profile)[0]
  const processSettings = processName ? processApi.settingsFor(processName) : null
  if (processSettings) settings = { ...without(settings, processApi.keys), ...processSettings }

  const materials = filamentApi.recommendedFor(profile).length
    ? filamentApi.recommendedFor(profile)
    : filamentApi.listFor(profile)
  const filamentSettings = materials[0] ? filamentApi.settingsFor(materials[0].name) : null
  if (filamentSettings) settings = { ...without(settings, filamentApi.keys), ...filamentSettings }

  return { settings, processName, filamentName: materials[0]?.name ?? '' }
}

/**
 * Which of the host's own controls the current settings make meaningless — the same rules the slicer's
 * settings UI uses. `disabledKeys` only reports rules that are unambiguously false; an expression it
 * cannot translate stays enabled (fail-open), which is why a missing key here means "leave it alone".
 */
export function disabledControls(settings, keys) {
  const disabled = disabledKeys(makeCfg(settings))
  return Object.fromEntries(keys.filter(key => key in disabled).map(key => [key, disabled[key]]))
}

/** Bed rectangle, for placing the design on the plate. `printable_area` is a list of [x, y] corners. */
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

/**
 * Binary STL from raw triangle coordinates (N*9): centred on the ORIGIN in x/y, lowest point at z=0.
 *
 * Not on the bed centre. The kernel takes plate-local coordinates and places the part on the bed itself,
 * so pre-moving the design to the bed centre shifts it twice and it slices off the plate — measured on a
 * 250 × 210 mm bed, a cube handed in at (125, 105) sliced to X 234.7–265.4 with `stats.over_bed_model`
 * the only sign.
 *
 * Facet normals are computed here because a design's vertex buffer carries none.
 *
 * ~25 lines that every demo needs. Deliberately copied rather than shared: a shared helper would make
 * this folder impossible to lift out on its own.
 */
export function toBinarySTL(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i])
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1])
    minZ = Math.min(minZ, positions[i + 2])
  }
  const dx = -(minX + maxX) / 2
  const dy = -(minY + maxY) / 2
  const dz = -minZ

  const triangles = positions.length / 9
  const view = new DataView(new ArrayBuffer(84 + triangles * 50))
  view.setUint32(80, triangles, true)
  for (let t = 0; t < triangles; t++) {
    const i = t * 9, o = 84 + t * 50
    const ax = positions[i] + dx, ay = positions[i + 1] + dy, az = positions[i + 2] + dz
    const bx = positions[i + 3] + dx, by = positions[i + 4] + dy, bz = positions[i + 5] + dz
    const cx = positions[i + 6] + dx, cy = positions[i + 7] + dy, cz = positions[i + 8] + dz
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

/** Kernel stats -> the numbers a designer reads. */
export function toFeedback(stats, settings) {
  const lengthMm = stats.filament_mm ?? 0
  const diameter = Number(settingScalar(settings, 'filament_diameter') ?? 1.75)
  const density = Number(settingScalar(settings, 'filament_density') ?? 1.24)
  return {
    seconds: stats.time_estimate ?? 0,
    filamentMm: lengthMm,
    grams: lengthMm * Math.PI * (diameter / 2) ** 2 * density / 1000,
    layers: stats.layers ?? 0,
  }
}

/**
 * The design-to-print loop.
 *
 * `request(positions, settings)` schedules a slice of the latest geometry and resolves nothing — results
 * arrive through the callbacks, because a design loop has no single "the" answer to await: the user is
 * still moving the slider.
 *
 * `makeWorker` is the caller's, because building a worker is a bundler question (see src/main.js for the
 * Vite answer), not a slicing one.
 */
export function createFeedbackLoop({ makeWorker, onState, debounceMs = RESLICE_DEBOUNCE_MS } = {}) {
  let client = createSlicerClient(makeWorker?.())
  let generation = 0
  let timer = null
  let running = false

  const emit = state => onState?.(state)

  const runNow = async (positions, settings, mine) => {
    running = true
    emit({ status: 'slicing', progress: 0 })
    try {
      const stl = toBinarySTL(positions)
      const result = await client.slice(stl, deriveKernelParams(settings), {
        onProgress: (done, total) => {
          if (mine === generation) emit({ status: 'slicing', progress: total > 0 ? done / total : 0 })
        },
      })
      if (mine !== generation) return            // superseded while we waited — drop it silently
      if (result.error) throw new Error(result.error)
      // The kernel's own placement verdict — true would mean the design slices off the plate.
      if (result.stats.over_bed_model) throw new Error('this design does not fit the printable area')
      // `layers` comes back because no onLayer callback was passed — the client assembles the streamed
      // layers into [{z, paths, widths}], which three-slicer/viewer/toolpath draws directly. The design
      // tool can show what the slicer actually produced without re-parsing G-code.
      emit({ status: 'ready', feedback: toFeedback(result.stats, settings), layers: result.layers ?? [] })
    } catch (cause) {
      if (mine === generation) emit({ status: 'error', message: cause.message })
    } finally {
      if (mine === generation) running = false
    }
  }

  return {
    warmup: () => client.warmup(),

    request(positions, settings) {
      const mine = ++generation
      clearTimeout(timer)
      emit({ status: 'stale' })
      timer = setTimeout(() => runNow(positions, settings, mine), debounceMs)
    },

    /** Slice immediately, skipping the debounce — for the first paint. */
    requestNow(positions, settings) {
      const mine = ++generation
      clearTimeout(timer)
      return runNow(positions, settings, mine)
    },

    get busy() { return running },

    /**
     * Drop whatever is scheduled or already in flight, without touching the worker — for a design that
     * cannot be sliced at all (a hole wider than the part, say). Bumping the generation is enough: the
     * running slice still finishes in the worker, but its answer is discarded instead of landing on top
     * of the error the user is looking at. Killing the worker instead would cost a reload on every
     * invalid slider position.
     */
    invalidate() {
      generation++
      clearTimeout(timer)
      running = false
    },

    /**
     * Stop what is running. The kernel polls a cancel flag from inside its C++ loop, but that flag lives
     * in a SharedArrayBuffer and so exists only on a cross-origin-isolated page; elsewhere the worker has
     * to be killed and rebuilt. The debounce means this is rare either way.
     */
    cancel() {
      generation++
      clearTimeout(timer)
      running = false
      if (client.cancel()) return 'flag'
      client.terminate()
      client = createSlicerClient(makeWorker?.())
      return 'restarted'
    },

    close() { clearTimeout(timer); client.terminate() },
  }
}
