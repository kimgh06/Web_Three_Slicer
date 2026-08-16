// Demo chrome: a three.js design canvas on the left, the manufacturing numbers on the right.
// The integration is src/print_feedback.js.
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { DEFAULTS, LIMITS, makeBracket, trianglesOf, validate } from './bracket.js'
import { createFeedbackLoop, loadSettings, disabledControls, RESLICE_DEBOUNCE_MS } from './print_feedback.js'
import { createToolpathView } from './toolpath_view.js'
// Vite builds the kernel worker. Letting the package build its own works in dev but 404s after
// `vite build`: the package's `new URL('./src/slicer.worker.js', import.meta.url)` is copied verbatim as
// an asset and that copy still imports the unhashed './slicer_core.js'. `?worker` bundles it properly.
import SlicerWorker from 'three-slicer/worker?worker'

const PRINTER = 'Bambu Lab P1S 0.4 nozzle'
const $ = id => document.getElementById(id)

// ---------------------------------------------------------------- design canvas (the "CAD" tool)
const canvas = $('design')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x11141b)
const camera = new THREE.PerspectiveCamera(45, 1, 1, 2000)
camera.position.set(120, -140, 110)
camera.up.set(0, 0, 1)

const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true

scene.add(new THREE.AmbientLight(0xffffff, 0.55))
const key = new THREE.DirectionalLight(0xffffff, 1.6)
key.position.set(80, -120, 160)
scene.add(key)
scene.add(new THREE.GridHelper(200, 20, 0x2a3040, 0x1c212c).rotateX(Math.PI / 2))

const material = new THREE.MeshStandardMaterial({ color: 0xd6813a, roughness: 0.55, metalness: 0.05 })
let mesh = null

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas
  if (!w || !h) return
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
new ResizeObserver(resize).observe(canvas)

renderer.setAnimationLoop(() => {
  controls.update()
  renderer.render(scene, camera)
})

// ---------------------------------------------------------------- state
const params = { ...DEFAULTS }
let settings = null
let positions = null

const toolpathView = createToolpathView($('toolpath-canvas'))

const loop = createFeedbackLoop({
  makeWorker: () => new SlicerWorker(),
  onState: render,
})

function showToolpath(layers) {
  const info = toolpathView.show(layers)
  if (!info.layerCount) return

  const range = $('layer-range')
  range.max = String(info.layerCount)
  range.value = String(info.layerCount)          // the whole part, every time
  $('layer-readout').textContent = `${info.layerCount} / ${info.layerCount}`
  $('toolpath-segments').textContent = `${info.segments.toLocaleString()} segments`
  $('show-travel').checked = true
  toolpathView.setTravel(true)

  $('toolpath-legend').replaceChildren(...info.roles.filter(role => role.pct >= 1).map(role => {
    const chip = document.createElement('span')
    chip.className = 'legend-chip'
    chip.style.setProperty('--chip', `rgb(${role.color.slice(0, 3).map(c => Math.round(c * 255)).join(',')})`)
    chip.textContent = `${role.label} ${role.pct.toFixed(0)}%`
    return chip
  }))
}

function rebuildGeometry() {
  const geometry = makeBracket(params)
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose() }
  mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)
  positions = trianglesOf(geometry)
  $('triangles').textContent = `${(positions.length / 9).toLocaleString()} triangles`
}

// ---------------------------------------------------------------- feedback panel
const duration = seconds => {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600), m = Math.round((total % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

let last = null

function render(state) {
  const status = $('status')
  status.className = `status is-${state.status}`

  if (state.status === 'slicing') {
    status.textContent = `Slicing ${Math.round(state.progress * 100)}%`
  } else if (state.status === 'stale') {
    status.textContent = `Updating print estimate… (${RESLICE_DEBOUNCE_MS} ms after you stop)`
  } else if (state.status === 'error') {
    status.textContent = state.message
  } else if (state.status === 'ready') {
    status.textContent = 'Up to date'
  }

  $('feedback').classList.toggle('is-stale', state.status === 'stale' || state.status === 'slicing')

  if (state.status !== 'ready') return
  const { feedback } = state
  showToolpath(state.layers)
  $('time').textContent = duration(feedback.seconds)
  $('material').textContent = `${feedback.grams.toFixed(1)} g`
  $('layers').textContent = feedback.layers.toLocaleString()
  $('delta').textContent = last
    ? `${feedback.seconds >= last.seconds ? '+' : '−'}${duration(Math.abs(feedback.seconds - last.seconds))} · ` +
      `${feedback.grams >= last.grams ? '+' : '−'}${Math.abs(feedback.grams - last.grams).toFixed(1)} g vs previous`
    : ''
  last = feedback
}

// ---------------------------------------------------------------- controls
function onParamChange() {
  const domainError = validate(params)
  if (domainError) {
    // A CAD-domain problem is caught here, before the worker is ever asked — the slicer would happily
    // slice a self-intersecting part and answer with a number that means nothing. `invalidate()` is the
    // other half: without it, a slice scheduled by the previous (valid) change lands a second later and
    // overwrites this error with "Up to date".
    loop.invalidate()
    render({ status: 'error', message: domainError })
    return
  }
  rebuildGeometry()
  loop.request(positions, settings)
}

for (const name of Object.keys(LIMITS)) {
  const input = $(name)
  const limit = LIMITS[name]
  Object.assign(input, { min: limit.min, max: limit.max, step: limit.step, value: params[name] })
  $(`${name}-value`).textContent = `${params[name]} mm`
  input.addEventListener('input', () => {
    params[name] = Number(input.value)
    $(`${name}-value`).textContent = `${params[name]} mm`
    onParamChange()
  })
}

$('layer-range').addEventListener('input', event => {
  const top = Number(event.target.value)
  toolpathView.setTopLayer(top)
  $('layer-readout').textContent = `${top} / ${event.target.max}`
})
$('show-travel').addEventListener('change', event => toolpathView.setTravel(event.target.checked))

$('cancel').addEventListener('click', () => {
  const how = loop.cancel()
  render({
    status: 'error',
    message: how === 'restarted'
      ? 'Cancelled — the page is not cross-origin isolated, so the worker was restarted.'
      : 'Cancelled.',
  })
})

// ---------------------------------------------------------------- start
;(async () => {
  const loaded = await loadSettings(PRINTER)
  settings = loaded.settings
  $('profile').textContent = `${PRINTER} · ${loaded.processName} · ${loaded.filamentName}`

  // The same enable_if rules the slicer's own settings UI uses, applied to the host's controls.
  const off = disabledControls(settings, ['sparse_infill_density', 'layer_height'])
  if (Object.keys(off).length) console.info('[cad-embed] disabled by toggle rules:', off)

  rebuildGeometry()
  resize()
  await loop.warmup()
  await loop.requestNow(positions, settings)
})()
