// Demo chrome: DOM wiring around src/estimate.js. Deliberately plain — no framework, no state library.
import {
  loadCatalog, buildSettings, prepareModel, bedOf, overBed, toBinarySTL, createEstimator,
} from './estimate.js'
import { priceOf, quoteConfig } from './mock/pricing.js'
import { createToolpathView } from './toolpath_view.js'
// Vite builds the kernel worker for us. Letting the package build its own works in dev but not after
// `vite build`: the package creates it from `new URL('./src/slicer.worker.js', import.meta.url)`, which
// Vite copies verbatim as an asset, and that copy still imports the unhashed './slicer_core.js' — a 404
// that appears only in the production build. `?worker` bundles it properly, kernel chunks and all.
import SlicerWorker from 'three-slicer/worker?worker'

const $ = id => document.getElementById(id)
const el = {
  fileInput: $('file-input'), dropzone: $('dropzone'), sample: $('sample-button'),
  facts: $('model-facts'), name: $('fact-name'), size: $('fact-size'), triangles: $('fact-triangles'),
  printer: $('printer'), material: $('material'), process: $('process'), quantity: $('quantity'),
  calculate: $('calculate'), cancel: $('cancel'),
  progressRow: $('progress-row'), progress: $('progress'), progressFill: $('progress-fill'), progressText: $('progress-text'),
  error: $('error'), result: $('result'), price: $('price'), timings: $('timings'),
  time: $('fact-time'), filament: $('fact-filament'), layers: $('fact-layers'),
  materialCost: $('fact-material-cost'), machineCost: $('fact-machine-cost'),
  handling: $('fact-handling'), margin: $('fact-margin'),
  toolpath: $('toolpath'), toolpathCanvas: $('toolpath-canvas'), legend: $('toolpath-legend'),
  layerRange: $('layer-range'), layerReadout: $('layer-readout'), showTravel: $('show-travel'),
}

const estimator = createEstimator(() => new SlicerWorker())
const toolpathView = createToolpathView(el.toolpathCanvas)
let catalog = null
let model = null
let state = 'idle'
let warmupMs = 0

const money = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: quoteConfig.currency }).format(value)
const duration = seconds => {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600), m = Math.round((total % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

function setState(next, message = '') {
  state = next
  const slicing = next === 'slicing'
  el.progressRow.hidden = !slicing
  el.cancel.hidden = !slicing
  el.calculate.disabled = slicing || !model || !catalog
  el.calculate.textContent = next === 'completed' ? 'Recalculate' : 'Calculate quote'
  el.error.hidden = next !== 'error'
  if (next === 'error') el.error.textContent = message
  if (next !== 'completed') { el.result.hidden = true; el.toolpath.hidden = true }
}

function showToolpath(layers) {
  const info = toolpathView.show(layers)
  el.toolpath.hidden = info.layerCount === 0
  if (!info.layerCount) return

  el.layerRange.max = String(info.layerCount)
  el.layerRange.value = String(info.layerCount)          // everything visible to start with
  el.layerReadout.textContent = `${info.layerCount} / ${info.layerCount} · ${info.segments.toLocaleString()} segments`
  el.showTravel.checked = true
  toolpathView.setTravel(true)

  // Length share per role — the kernel exposes no per-role time, so this is by extruded length.
  el.legend.replaceChildren(...info.roles.filter(role => role.pct >= 1).map(role => {
    const chip = document.createElement('span')
    chip.className = 'legend-chip'
    chip.style.setProperty('--chip', `rgb(${role.color.slice(0, 3).map(c => Math.round(c * 255)).join(',')})`)
    chip.textContent = `${role.label} ${role.pct.toFixed(0)}%`
    return chip
  }))
}

function showProgress(done, total) {
  const ratio = total > 0 ? done / total : 0
  const percent = Math.round(ratio * 100)
  el.progressFill.style.width = `${percent}%`
  el.progress.setAttribute('aria-valuenow', String(percent))
  el.progressText.textContent = total > 0
    ? `Slicing locally… ${percent}% — no model data is being uploaded.`
    : 'Preparing slicer… no model data is being uploaded.'
}

function fillOptions(select, values, selected) {
  select.replaceChildren(...values.map(value => {
    const option = document.createElement('option')
    option.value = typeof value === 'string' ? value : value.name
    option.textContent = typeof value === 'string' ? value : `${value.name}${value.type ? ` (${value.type})` : ''}`
    return option
  }))
  if (selected && values.some(v => (typeof v === 'string' ? v : v.name) === selected)) select.value = selected
}

function refreshPresets() {
  const printer = el.printer.value
  fillOptions(el.process, catalog.processesFor(printer), catalog.defaultProcessFor(printer))
  fillOptions(el.material, catalog.materialsFor(printer))
}

async function useFile(file) {
  setState('loading-model')
  el.error.hidden = true
  try {
    const started = performance.now()
    model = await prepareModel(file)
    const parseMs = Math.round(performance.now() - started)

    el.facts.hidden = false
    el.name.textContent = model.name
    el.size.textContent = `${model.size.x.toFixed(1)} × ${model.size.y.toFixed(1)} × ${model.size.z.toFixed(1)} mm`
    el.triangles.textContent = `${model.triangles.toLocaleString()}${model.objects > 1 ? ` (${model.objects} objects)` : ''}`
    el.timings.dataset.parse = String(parseMs)
    setState('ready')
  } catch (cause) {
    model = null
    el.facts.hidden = true
    setState('error', `Could not read ${file.name}. ${cause.message}`)
  }
}

async function calculate() {
  if (!model || !catalog) return
  let settings
  try {
    settings = buildSettings(catalog, {
      printer: el.printer.value, process: el.process.value, filament: el.material.value,
    })
  } catch (cause) {
    setState('error', `${cause.message} — pick another printer, quality or material.`)
    return
  }

  const bed = bedOf(settings)
  const over = overBed(model, bed)
  if (over.length) {
    const axes = over.map(o => `${o.axis} ${o.model.toFixed(1)}mm > ${o.bed.toFixed(0)}mm`).join(', ')
    setState('error', `This model is larger than the selected printer's build volume (${axes}). Choose another printer.`)
    return
  }

  setState('slicing')
  showProgress(0, 0)
  const started = performance.now()
  try {
    const stl = toBinarySTL(model)
    const estimate = await estimator.run(stl, settings, showProgress)
    if (state !== 'slicing') return // cancelled while we were waiting

    const sliceMs = Math.round(performance.now() - started)
    const quantity = Math.max(1, Number(el.quantity.value) || 1)

    if (!estimate.seconds || estimate.filamentMm <= 0) {
      setState('error', 'The slicer produced no extrusion for this model — it may be empty or below one layer height.')
      return
    }

    const price = priceOf(estimate, quantity)
    el.price.textContent = money(price.total)
    el.time.textContent = duration(estimate.seconds * quantity)
    el.filament.textContent = `${(estimate.grams * quantity).toFixed(1)} g (${(estimate.filamentMm * quantity / 1000).toFixed(2)} m)`
    el.layers.textContent = estimate.layers.toLocaleString()
    el.materialCost.textContent = money(price.materialCost * quantity)
    el.machineCost.textContent = money(price.machineCost * quantity)
    el.handling.textContent = money(price.handlingFee * quantity)
    el.margin.textContent = money(price.margin)

    el.timings.textContent = `Model parse ${el.timings.dataset.parse ?? '—'} ms · Kernel warmup ${warmupMs} ms · Slicing ${sliceMs} ms`
    setState('completed')
    el.result.hidden = false
    showToolpath(estimate.layerStream)
  } catch (cause) {
    if (state === 'cancelled') return
    setState('error', `Slicing failed: ${cause.message}`)
  }
}

el.fileInput.addEventListener('change', () => {
  const [file] = el.fileInput.files
  if (file) useFile(file)
})

el.dropzone.addEventListener('dragover', event => { event.preventDefault(); el.dropzone.classList.add('over') })
el.dropzone.addEventListener('dragleave', () => el.dropzone.classList.remove('over'))
el.dropzone.addEventListener('drop', event => {
  event.preventDefault()
  el.dropzone.classList.remove('over')
  const [file] = event.dataTransfer.files
  if (file) useFile(file)
})

el.sample.addEventListener('click', async () => {
  const response = await fetch('calibration-cube.stl')
  const blob = await response.blob()
  useFile(new File([blob], 'calibration-cube.stl'))
})

el.printer.addEventListener('change', () => {
  refreshPresets()
  if (state === 'completed') setState('ready')
})
for (const input of [el.process, el.material, el.quantity]) {
  input.addEventListener('change', () => { if (state === 'completed') setState('ready') })
}

el.layerRange.addEventListener('input', () => {
  const top = Number(el.layerRange.value)
  toolpathView.setTopLayer(top)
  el.layerReadout.textContent = `${top} / ${el.layerRange.max}`
})
el.showTravel.addEventListener('change', () => toolpathView.setTravel(el.showTravel.checked))

el.calculate.addEventListener('click', calculate)
el.cancel.addEventListener('click', () => {
  const how = estimator.cancel()
  setState('cancelled')
  el.error.hidden = false
  el.error.textContent = how === 'restarted'
    ? 'Cancelled. This page is not cross-origin isolated, so the worker was restarted — the next quote reloads the kernel.'
    : 'Cancelled.'
  el.calculate.disabled = !model
})

;(async () => {
  const started = performance.now()
  catalog = await loadCatalog()
  // 0.4 is the nozzle every vendor ships by default; matching on 'P1S' alone lands on the 0.2 variant.
  const preferred = catalog.printers.find(p => p.name.includes('P1S 0.4'))
    ?? catalog.printers.find(p => p.name.includes('0.4 nozzle'))
    ?? catalog.printers[0]
  fillOptions(el.printer, catalog.printers.map(p => p.name), preferred?.name)
  refreshPresets()
  setState('idle')

  await estimator.warmup()
  warmupMs = Math.round(performance.now() - started)
})()
