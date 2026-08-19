// SL1 writer invariants (core/sl1_write.js): the mm->px transform (incl. the display mirror), loop
//  reconstruction from the segment stream, the deterministic config.ini, and the archive layout — all under
//  plain node, with the canvas injected as a recorder stub (the PNG encode is the one browser-only piece).
import { strict as assert } from 'node:assert'
import { slaRasterTransform, drawLayer, sl1ConfigIni, sl1LayerName, makeSL1 } from './src/core/sl1_write.js'
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js'

let passed = 0
const ok = (name) => { passed++; console.log('  ok', name) }

const params = { display_width: 100, display_height: 50, display_pixels_x: 1000, display_pixels_y: 500 }

// [transform] centre-origin mm -> pixel. PORTRAIT is the default (the whole SL1 family is portrait): the
//  canvas is pixels_y wide by pixels_x tall, columns run along the display's y axis and rows along the
//  X-mirrored x axis (the display projects through the vat floor) — upstream SL1.cpp create_raster.
{
  const t = slaRasterTransform(params)
  assert.equal(t.portrait, true)
  assert.equal(t.px, 500); assert.equal(t.py, 1000)      // canvas dims swapped
  assert.deepEqual(t.map(0, 0), [250, 500])              // centre lands mid-canvas
  assert.deepEqual(t.map(10, 0), [250, 400])             // +x runs UP the image when mirrored
  assert.deepEqual(t.map(0, 10), [350, 500])             // +y runs right, no flip (mirror_y default off)
  const flipped = slaRasterTransform({ ...params, display_mirror_y: true })
  assert.deepEqual(flipped.map(0, 10), [150, 500])
  ok('transform portrait: swapped canvas, y->columns, mirrored x->rows')
}

// [transform] explicit landscape keeps the unswapped mapping
{
  const t = slaRasterTransform({ ...params, display_orientation: 'landscape' })
  assert.equal(t.portrait, false)
  assert.equal(t.px, 1000); assert.equal(t.py, 500)
  assert.deepEqual(t.map(0, 0), [500, 250])
  assert.deepEqual(t.map(10, 0), [400, 250])             // +x runs left when mirrored
  assert.deepEqual(t.map(0, 10), [500, 350])
  const plain = slaRasterTransform({ ...params, display_orientation: 'landscape', display_mirror_x: false })
  assert.deepEqual(plain.map(10, 0), [600, 250])
  ok('transform landscape: centre origin, scale, mirror')
}

// [transform] the SL1 reference panel with NO params at all — the shape a real 2.9.6 archive holds
//  (measured: masks are 1440x2560 portrait; a centred model sits at column 720, row 1280).
{
  const t = slaRasterTransform({})
  assert.equal(t.px, 1440); assert.equal(t.py, 2560)
  assert.deepEqual(t.map(0, 0), [720, 1280])
  ok('transform defaults: SL1 panel, portrait 1440x2560')
}

// [loops] a break in segment continuity starts a new subpath — that is how sla_core delimits loops
{
  const calls = []
  const ctx = {
    beginPath: () => calls.push(['begin']), moveTo: (x, y) => calls.push(['move', x, y]),
    lineTo: (x, y) => calls.push(['line', x, y]), fill: (rule) => calls.push(['fill', rule]),
  }
  // two loops: a 2-segment run (0,0 -> 10,0 -> 0,0) and a separate 1-segment degenerate run
  const paths = Float32Array.from([
    0, 0, 1, 1, 10, 0, 1, 1,
    10, 0, 1, 1, 0, 0, 1, 1,     // continues the first loop
    30, 30, 1, 1, 31, 30, 1, 1,  // discontinuity -> second loop
  ])
  const loops = drawLayer(ctx, paths, slaRasterTransform(params))
  assert.equal(loops, 2)
  assert.equal(calls.filter(c => c[0] === 'move').length, 2)
  assert.equal(calls.filter(c => c[0] === 'line').length, 3)
  assert.deepEqual(calls[calls.length - 1], ['fill', 'evenodd'])
  ok('loops: continuity breaks open subpaths, even-odd fill')
}

// [config] the exact upstream shape (fill_iniconf): field set, alphabetical order, 6-decimal floats.
//  Pinned as the WHOLE text — the byte layout is the contract, and it is deterministic by construction.
{
  const ini = sl1ConfigIni({
    params: { exposure_time: 7, initial_exposure_time: 35, layer_height: 0.05, faded_layers: 10 },
    stats: { layers: 42, time_estimate: 500, resin_ml: 1.23456 },
    jobName: 'plate_1', timestamp: '2026-01-01T00:00:00Z',
  })
  assert.equal(ini, [
    'action = print',
    'expTime = 7',
    'expTimeFirst = 35',
    'expUserProfile = 0',
    'fileCreationTimestamp = 2026-01-01T00:00:00Z',
    'hollow = 0',
    'jobDir = plate_1',
    'layerHeight = 0.05',
    'materialName = ',
    'numFade = 10',
    'numFast = 42',
    'numSlow = 0',
    'printProfile = ',
    'printTime = 500.000000',
    'printerModel = ',
    'printerProfile = ',
    'printerVariant = ',
    'prusaSlicerVersion = three-slicer',
    'usedMaterial = 1.234560',
  ].join('\n') + '\n')
  // Identity fields flow from the params; expUserProfile follows upstream's speed mapping (slow=1, user=2).
  const named = sl1ConfigIni({
    params: { printer_model: 'SL1S', printer_variant: 'default', sla_material_settings_id: 'resin A',
              material_print_speed: 'slow', hollowing_enable: true },
    stats: {}, jobName: 'x', timestamp: 't',
  })
  assert.ok(named.includes('printerModel = SL1S\n'))
  assert.ok(named.includes('materialName = resin A\n'))
  assert.ok(named.includes('expUserProfile = 1\n'))
  assert.ok(named.includes('hollow = 1\n'))
  assert.equal(sl1ConfigIni({ params: {}, stats: {}, jobName: 'x', timestamp: 't' }),
               sl1ConfigIni({ params: {}, stats: {}, jobName: 'x', timestamp: 't' }))
  ok('config.ini: fields present, deterministic')
}

// [archive] one PNG per layer named jobname%05d.png + config.ini, PNGs stored uncompressed
{
  const fakePng = Uint8Array.from([137, 80, 78, 71, 1, 2, 3])
  const makeCanvas = (w, h) => ({
    getContext: () => ({ beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, fillRect() {}, set fillStyle(_) {}, get fillStyle() { return '' } }),
    convertToBlob: async () => new Blob([fakePng]),
    width: w, height: h,
  })
  const layers = [{ paths: new Float32Array(0) }, { paths: new Float32Array(0) }, { paths: new Float32Array(0) }]
  const bytes = await makeSL1({
    layers, params, stats: { layers: 3, time_estimate: 60, resin_ml: 0.5 },
    jobName: 'plate_2', timestamp: '2026-01-01T00:00:00Z', makeCanvas,
  })
  const files = unzipSync(bytes)
  const names = Object.keys(files).sort()
  assert.deepEqual(names, ['config.ini', 'plate_200000.png', 'plate_200001.png', 'plate_200002.png'])
  assert.deepEqual(Array.from(files['plate_200001.png']), Array.from(fakePng))
  assert.ok(strFromU8(files['config.ini']).includes('jobDir = plate_2'))
  assert.equal(sl1LayerName('plate_2', 1), 'plate_200001.png')
  ok('archive: layer naming, config member, byte-exact PNG payload')
}

console.log(`test_sl1: ${passed} checks passed`)
