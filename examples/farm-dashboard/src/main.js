// Dashboard chrome: printer cards, the queue, and a toolpath preview of whatever is printing.
// The integration is src/submit_job.js; the toolpath here is re-parsed from the G-code the SERVER holds,
// which is the point — the server stored text it never looked inside.
import { parseGcode } from 'three-slicer/viewer/gcode'
import { createFarmSlicer, readModel, prepareJob, describePayload } from './submit_job.js'
import { createFarm } from './farm_store.js'
import { createToolpathView } from './toolpath_view.js'
// Vite builds the kernel worker: the package's own `new URL(...)` copy 404s after `vite build`.
import SlicerWorker from 'three-slicer/worker?worker'

const $ = id => document.getElementById(id)

// Two different "farms": the slicer that does the work, and the queue this page keeps in memory.
const slicer = createFarmSlicer(() => new SlicerWorker())
const farm = createFarm()
let state = { printers: [], jobs: [] }
let model = null
let selectedJobId = null
let slicedHere = 0

// ---------------------------------------------------------------- toolpath preview
// Everything that turns the server's stored text back into geometry runs here, in the browser.
const toolpathView = createToolpathView($('preview'))

/** Off by default: the whole toolpath is shown, not just the part the printer has reached. */
const followProgress = () => $('follow-progress').checked

async function showJobToolpath(jobId) {
  selectedJobId = jobId
  const job = state.jobs.find(j => j.id === jobId)
  $('preview-title').textContent = job ? `${job.name} — ${printerOf(job)?.name ?? ''}` : 'Toolpath'
  if (!job) return

  const text = farm.gcodeOf(jobId)          // a real farm: GET /api/jobs/:id/gcode
  if (!text) return

  const parsed = parseGcode(text)
  const info = toolpathView.show(parsed.layers)

  const range = $('layer-range')
  range.max = String(info.layerCount)
  range.value = String(info.layerCount)
  $('layer-readout').textContent = `${info.layerCount} / ${info.layerCount}`
  $('show-travel').checked = true
  toolpathView.setTravel(true)

  $('preview-meta').textContent =
    `${parsed.stats.layers} layers · ${parsed.stats.path_segments.toLocaleString()} segments · parsed in this browser`

  $('preview-legend').replaceChildren(...info.roles.filter(role => role.pct >= 1).map(role => {
    const chip = document.createElement('span')
    chip.className = 'legend-chip'
    chip.style.setProperty('--chip', `rgb(${role.color.slice(0, 3).map(c => Math.round(c * 255)).join(',')})`)
    chip.textContent = `${role.label} ${role.pct.toFixed(0)}%`
    return chip
  }))

  if (followProgress()) applyLayerRange(job)
}

/** Clip the view to the layer the printer is on — only while the operator asked to follow along. */
function applyLayerRange(job) {
  if (!job || !toolpathView.layerCount) return
  const top = job.state === 'completed'
    ? toolpathView.layerCount
    : Math.max(1, Math.round(job.layer / job.layers * toolpathView.layerCount))
  toolpathView.setTopLayer(top)
  $('layer-range').value = String(top)
  $('layer-readout').textContent = `${top} / ${toolpathView.layerCount}`
}

$('layer-range').addEventListener('input', event => {
  $('follow-progress').checked = false          // scrubbing means the operator is driving
  const top = Number(event.target.value)
  toolpathView.setTopLayer(top)
  $('layer-readout').textContent = `${top} / ${event.target.max}`
})
$('show-travel').addEventListener('change', event => toolpathView.setTravel(event.target.checked))
$('follow-progress').addEventListener('change', () => {
  const job = state.jobs.find(j => j.id === selectedJobId)
  if (followProgress()) applyLayerRange(job)
  else {
    toolpathView.setTopLayer(toolpathView.layerCount)
    $('layer-range').value = String(toolpathView.layerCount)
    $('layer-readout').textContent = `${toolpathView.layerCount} / ${toolpathView.layerCount}`
  }
})

// ---------------------------------------------------------------- rendering
const printerOf = job => state.printers.find(p => p.id === job.printerId)
const jobOf = printer => state.jobs.find(j => j.id === printer.jobId)
const duration = seconds => {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600), m = Math.round((total % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

function printerState(printer) {
  if (!printer.online) return 'offline'
  if (printer.jobId) return 'printing'
  return state.jobs.some(j => j.state === 'queued' && j.printerId === printer.id) ? 'queued' : 'idle'
}

function render() {
  const counts = { printing: 0, idle: 0, queued: 0, offline: 0 }
  $('printers').replaceChildren(...state.printers.map(printer => {
    const status = printerState(printer)
    counts[status]++
    const job = jobOf(printer)

    const card = document.createElement('article')
    card.className = `card is-${status}`
    card.innerHTML = `
      <header><h3>${printer.name}</h3><span class="pill">${status}</span></header>
      <p class="model">${printer.model}</p>
      ${job ? `
        <p class="job">${job.name}</p>
        <div class="bar"><span style="width:${Math.round(job.layer / job.layers * 100)}%"></span></div>
        <p class="muted">Layer ${job.layer} / ${job.layers}</p>
      ` : `<p class="muted">${printer.online ? 'No job' : 'Offline'}</p>`}
    `
    const actions = document.createElement('div')
    actions.className = 'card-actions'

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.textContent = printer.online ? 'Take offline' : 'Bring online'
    toggle.addEventListener('click', () => { farm.setOnline(printer.id); pullState() })
    actions.append(toggle)

    if (job) {
      const view = document.createElement('button')
      view.type = 'button'
      view.textContent = 'View toolpath'
      view.addEventListener('click', () => showJobToolpath(job.id))
      actions.append(view)
    }
    card.append(actions)
    return card
  }))

  $('summary').textContent =
    `${state.printers.length} printers · ${counts.printing} printing · ${counts.idle} idle · ${counts.queued} queued · ${counts.offline} offline`

  // Completed jobs stay in the list: a farm keeps its history, and the G-code is still held —
  // dropping the row would make the toolpath of a finished print unreachable.
  const queue = state.jobs
  $('queue').replaceChildren(...queue.map(job => {
    const row = document.createElement('li')
    row.className = [job.id === selectedJobId && 'is-selected', job.state === 'completed' && 'is-done']
      .filter(Boolean).join(' ')
    row.innerHTML = `
      <span class="q-name">${job.name}</span>
      <span class="q-printer">${printerOf(job)?.name ?? '—'}</span>
      <span class="q-state">${job.state}</span>
      <span class="q-meta">${duration(job.seconds)} · ${job.grams.toFixed(1)} g · ${(job.bytes / 1024).toFixed(0)} kB</span>
    `
    row.addEventListener('click', () => showJobToolpath(job.id))
    return row
  }))
  $('queue-empty').hidden = queue.length > 0

  $('sliced-here').textContent = String(slicedHere)
  $('printer-select').replaceChildren(...state.printers.map(printer => {
    const option = document.createElement('option')
    option.value = printer.id
    option.textContent = `${printer.name} — ${printer.model}`
    return option
  }))
}

// ---------------------------------------------------------------- farm state
// Same two calls a server-backed dashboard makes, against src/farm_store.js instead of the network.
function pullState() {
  state = farm.snapshot()                   // a real farm: GET /api/state
  render()
}

function subscribe() {
  farm.subscribe(() => {                    // a real farm: SSE or WebSocket on /api/events
    // Cheap and correct: re-read the snapshot on every event. A dashboard talking to a server would
    // apply the event to local state and use `revision` to notice it had fallen behind.
    pullState()
    const job = state.jobs.find(j => j.id === selectedJobId)
    if (job && followProgress()) applyLayerRange(job)
  })
}

// ---------------------------------------------------------------- add job
$('file').addEventListener('change', async event => {
  const [file] = event.target.files
  if (!file) return
  $('add-status').textContent = 'Reading…'
  try {
    model = await readModel(file)
    $('add-status').textContent = `${model.name} · ${model.size.x.toFixed(0)}×${model.size.y.toFixed(0)}×${model.size.z.toFixed(0)} mm · ${model.triangles.toLocaleString()} triangles`
    $('add').disabled = false
  } catch (cause) {
    model = null
    $('add').disabled = true
    $('add-status').textContent = `Could not read ${file.name}: ${cause.message}`
  }
})

$('sample').addEventListener('click', async () => {
  const response = await fetch('calibration-cube.stl')
  const blob = await response.blob()
  const file = new File([blob], 'calibration-cube.stl')
  model = await readModel(file)
  $('add-status').textContent = `${model.name} · 20×20×20 mm · ${model.triangles} triangles`
  $('add').disabled = false
})

$('add').addEventListener('click', async () => {
  const printer = state.printers.find(p => p.id === $('printer-select').value)
  if (!model || !printer) return

  $('add').disabled = true
  try {
    const { payload } = await prepareJob({
      client: slicer.client,
      model,
      printer,
      onProgress: (done, total) => {
        $('add-status').textContent = total > 0
          ? `Slicing for ${printer.name}… ${Math.round(done / total * 100)}% (in this browser)`
          : `Preparing slicer…`
      },
    })
    farm.addJob(payload)
    slicedHere++
    showWirePayload(payload)
    $('add-status').textContent = `Queued on ${printer.name}. Everything above happened in this tab.`
    pullState()
  } catch (cause) {
    $('add-status').textContent = cause.message
  } finally {
    $('add').disabled = !model
  }
})

// ---------------------------------------------------------------- start
function showWirePayload(payload) {
  // The demo's claim, made inspectable: this is the whole of what a queue server would ever receive.
  $('wire').hidden = false
  $('wire-json').textContent = JSON.stringify(describePayload(payload), null, 2)
  $('wire-size').textContent =
    `${(payload.gcode.length / 1024).toFixed(0)} kB of text · the ${model?.triangles.toLocaleString() ?? '—'} triangle model stayed here`
}

;(async () => {
  pullState()
  subscribe()
  toolpathView.resize()
  await slicer.warmup()
})()
