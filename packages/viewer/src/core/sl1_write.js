// SL1 (Prusa mSLA) archive writer: SLA slice layers -> a zip of per-layer PNG masks + config.ini.
//  The layer input is the same stride-8 segment stream every preview consumer reads; each layer's closed loops are
//  reconstructed from segment continuity (a loop is a run of segments whose start is the previous end) and filled
//  even-odd, so hole orientation cannot matter here even though sla_core orients it correctly anyway.
//
// Split the way write_3mf.js is: everything mm->px and text is pure and node-tested; only the actual PNG encode
//  needs a canvas, which the caller INJECTS (`makeCanvas`) — the browser passes OffscreenCanvas, a test passes a
//  recorder stub. Nothing here touches the DOM at import time, which is what keeps core/ under the layer guard.
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js'

/** mm -> px mapping of the resin display. Model coordinates are plate-local (origin at the plate centre); the
 *  display's origin is its own centre, so the transform is scale + half-display offset. `mirrorX` is the default
 *  because an mSLA display projects through the vat floor — upstream mirrors X for the SL1 family.
 *  `display_orientation` defaults to PORTRAIT — the whole SL1 family (SL1 and SL1S SPEED vendor profiles) is
 *  portrait, and upstream's SL1 writer then swaps the image axes (SL1.cpp create_raster: swap(w,h)+swap(pw,ph)
 *  with the rotation in the raster trafo). Measured on a real 2.9.6 archive: image is pixels_y WIDE by
 *  pixels_x TALL, columns run along the display's y axis, rows along the (mirrored) x axis. `px`/`py` on the
 *  returned object are CANVAS dimensions (already swapped in portrait); toX/toY produce canvas coordinates. */
export function slaRasterTransform(params) {
  const width = Number(params.display_width) > 0 ? Number(params.display_width) : 120.96
  const height = Number(params.display_height) > 0 ? Number(params.display_height) : 68.04
  const resX = Number(params.display_pixels_x) > 0 ? Math.round(Number(params.display_pixels_x)) : 2560
  const resY = Number(params.display_pixels_y) > 0 ? Math.round(Number(params.display_pixels_y)) : 1440
  const mirrorX = params.display_mirror_x !== false
  const mirrorY = params.display_mirror_y === true
  const portrait = (params.display_orientation ?? 'portrait') !== 'landscape'
  const sx = resX / width, sy = resY / height
  const mmX = (x) => (mirrorX ? (width / 2 - x) : (x + width / 2)) * sx   // along the display x axis, in px
  const mmY = (y) => (mirrorY ? (height / 2 - y) : (y + height / 2)) * sy // along the display y axis, in px
  return portrait ? {
    px: resY, py: resX, mirrorX, portrait,
    // canvas columns run along the display's y axis, rows along the (mirrored) x axis
    map: (x, y) => [mmY(y), mmX(x)],
  } : {
    px: resX, py: resY, mirrorX, portrait,
    map: (x, y) => [mmX(x), mmY(y)],
  }
}

/** One layer's segment stream -> the canvas ctx, as even-odd-filled white loops on the black already there.
 *  A new subpath starts wherever the stream breaks continuity — that break is how sla_core delimits loops. */
export function drawLayer(ctx, paths, transform) {
  const segCount = paths.length / 8
  if (!segCount) return 0
  let loops = 0
  ctx.beginPath()
  let lastX = NaN, lastY = NaN
  for (let s = 0; s < segCount; s++) {
    const x0 = paths[s * 8], y0 = paths[s * 8 + 1], x1 = paths[s * 8 + 4], y1 = paths[s * 8 + 5]
    if (x0 !== lastX || y0 !== lastY) { ctx.moveTo(...transform.map(x0, y0)); loops++ }
    ctx.lineTo(...transform.map(x1, y1))
    lastX = x1; lastY = y1
  }
  ctx.fill('evenodd')
  return loops
}

const iniEscape = (v) => String(v ?? '')

/** The SL1 job description (config.ini), upstream SL1.cpp fill_iniconf: the same field set, ALPHABETICAL
 *  order (upstream's ConfMap is a std::map — the sort is part of the bytes), and std::to_string's fixed
 *  6-decimal format for the two floats. Identity fields (printerModel, profiles) come from the params and
 *  default to empty — exactly what upstream produces without named profiles. Deterministic: the timestamp
 *  comes in as data, never from the clock. */
export function sl1ConfigIni({ params, stats, jobName, timestamp }) {
  // material_print_speed -> expUserProfile (upstream: slow=1, fast=0, user=2). Every Prusa vendor SL1
  //  material is "fast", so absent defaults to fast rather than upstream's unknown->2.
  const speed = String(params.material_print_speed ?? 'fast')
  const entries = {
    action: 'print',
    jobDir: jobName,
    expTime: params.exposure_time,
    expTimeFirst: params.initial_exposure_time,
    expUserProfile: speed === 'slow' ? 1 : speed === 'fast' ? 0 : 2,
    fileCreationTimestamp: timestamp ?? '',
    hollow: params.hollowing_enable ? 1 : 0,
    layerHeight: params.layer_height,
    materialName: params.sla_material_settings_id ?? '',
    numFade: params.faded_layers,
    numFast: stats.layers,
    numSlow: 0,
    printProfile: params.sla_print_settings_id ?? '',
    printTime: Number(stats.time_estimate ?? 0).toFixed(6),
    printerModel: params.printer_model ?? '',
    printerProfile: params.printer_settings_id ?? '',
    printerVariant: params.printer_variant ?? '',
    prusaSlicerVersion: 'three-slicer',
    usedMaterial: Number(stats.resin_ml ?? 0).toFixed(6),
  }
  return Object.keys(entries).sort().map(k => `${k} = ${iniEscape(entries[k])}`).join('\n') + '\n'
}

export const sl1LayerName = (jobName, index) => `${jobName}${String(index).padStart(5, '0')}.png`

/**
 * Build the .sl1 bytes. `layers` is the slice result's layer list ({paths} per layer), `makeCanvas(px, py)`
 * returns an OffscreenCanvas-compatible object (2d ctx + convertToBlob). Returns a Uint8Array of the archive.
 */
export async function makeSL1({ layers, params, stats, jobName = 'plate', timestamp, makeCanvas }) {
  const canvasFactory = makeCanvas
    ?? (typeof OffscreenCanvas !== 'undefined' ? (w, h) => new OffscreenCanvas(w, h) : null)
  if (!canvasFactory) throw new Error('SL1 export needs a canvas (OffscreenCanvas or an injected factory)')
  const transform = slaRasterTransform(params)
  const files = {}
  for (let i = 0; i < layers.length; i++) {
    const canvas = canvasFactory(transform.px, transform.py)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, transform.px, transform.py)
    ctx.fillStyle = '#fff'
    drawLayer(ctx, layers[i].paths, transform)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    // PNGs are already deflate-compressed — storing them beats re-deflating, same reasoning as write_3mf's level 3.
    files[sl1LayerName(jobName, i)] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }]
  }
  files['config.ini'] = strToU8(sl1ConfigIni({ params, stats, jobName, timestamp }))
  return zipSync(files)
}
