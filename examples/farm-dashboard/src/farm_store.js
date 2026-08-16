// The farm's state, in the browser. This file stands in for the queue server.
//
// It is deliberately shaped like one: a snapshot, an append, a state toggle, and an event stream. Every
// method here maps to one HTTP call, and the mapping is written next to it — swapping this file for a
// real backend is a find-and-replace, not a redesign.
//
//   snapshot()          GET  /api/state
//   addJob(payload)     POST /api/jobs           <- the only write that carries data
//   setOnline(id, on)   POST /api/printers/:id/online
//   gcodeOf(jobId)      GET  /api/jobs/:id/gcode
//   subscribe(fn)       GET  /api/events         (SSE / WebSocket)
//
// What a real server would NOT gain by existing: a slicer. It stores the G-code this browser produced
// and never looks inside it — which is the whole point of the demo, and is why `addJob` takes a payload
// of text and numbers rather than a model.

const TICK_MS = 400

const DEFAULT_PRINTERS = [
  { id: 'p1', name: 'Printer 01', model: 'Bambu Lab P1S 0.4 nozzle', online: true, jobId: null },
  { id: 'p2', name: 'Printer 02', model: 'Bambu Lab P1S 0.4 nozzle', online: true, jobId: null },
  { id: 'p3', name: 'Printer 03', model: 'Prusa MK4 0.4 nozzle', online: true, jobId: null },
  { id: 'p4', name: 'Printer 04', model: 'Prusa MK4 0.4 nozzle', online: false, jobId: null },
]

export function createFarm({ tickMs = TICK_MS } = {}) {
  const printers = DEFAULT_PRINTERS.map(printer => ({ ...printer }))
  const jobs = new Map()
  const gcode = new Map()          // held apart from the job records so a snapshot stays small
  const listeners = new Set()
  let nextJobId = 1
  let revision = 0

  const emit = (type, payload = {}) => {
    revision++
    for (const listener of listeners) listener({ type, revision, ...payload })
  }

  // The mock printers. A real adapter (Moonraker/OctoPrint/Bambu) reports the same three things:
  // it took the job, it is on layer N, it finished.
  const timer = setInterval(() => {
    for (const printer of printers) {
      if (!printer.online) continue

      if (printer.jobId) {
        const job = jobs.get(printer.jobId)
        if (!job) { printer.jobId = null; continue }
        job.layer = Math.min(job.layers, job.layer + Math.max(1, Math.round(job.layers / 60)))
        if (job.layer >= job.layers) {
          job.state = 'completed'
          printer.jobId = null
          emit('job.completed', { jobId: job.id })
        } else {
          emit('job.progress', { jobId: job.id, layer: job.layer })
        }
        continue
      }

      const next = [...jobs.values()].find(job => job.state === 'queued' && job.printerId === printer.id)
      if (next) {
        next.state = 'printing'
        printer.jobId = next.id
        emit('job.started', { jobId: next.id, printerId: printer.id })
      }
    }
  }, tickMs)

  return {
    /** GET /api/state */
    snapshot: () => ({
      revision,
      printers: printers.map(printer => ({ ...printer })),
      jobs: [...jobs.values()].map(job => ({ ...job })),
    }),

    /**
     * POST /api/jobs — the one call that carries data, and all it carries is the payload built by
     * `prepareJob()`: G-code text plus three numbers. No model, no vertex buffer, no file path.
     */
    addJob(payload) {
      const printer = printers.find(p => p.id === payload.printerId)
      if (!printer) throw new Error(`unknown printer: ${payload.printerId}`)
      if (typeof payload.gcode !== 'string' || !payload.gcode.length) throw new Error('no gcode')

      const job = {
        id: `j${nextJobId++}`,
        name: String(payload.name ?? 'job'),
        printerId: printer.id,
        state: 'queued',
        layers: Math.max(1, Number(payload.layers) || 1),
        layer: 0,
        seconds: Number(payload.seconds) || 0,
        grams: Number(payload.grams) || 0,
        bytes: payload.gcode.length,
      }
      jobs.set(job.id, job)
      gcode.set(job.id, payload.gcode)
      emit('job.created', { jobId: job.id })
      return { ...job }
    },

    /** POST /api/printers/:id/online */
    setOnline(printerId, online) {
      const printer = printers.find(p => p.id === printerId)
      if (!printer) return null
      printer.online = online ?? !printer.online
      emit('printer.state', { printerId, online: printer.online })
      return { ...printer }
    },

    /** GET /api/jobs/:id/gcode — text, exactly as it was stored. */
    gcodeOf: jobId => gcode.get(jobId) ?? null,

    /** GET /api/events */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    stop() { clearInterval(timer); listeners.clear() },
  }
}
