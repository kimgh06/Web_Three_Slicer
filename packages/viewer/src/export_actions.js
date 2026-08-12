// "Save project as" / "Export as STL" — the write half of the 3mf project support (parse_3mf.js is the read half).
// The kernel's painting only exists inside the worker's TriangleSelector, so a 3mf save has to ASK for it and wait:
//  that is the one asynchronous step here, and it is why this is a module rather than two lines in the toolbar.
import { write3MFProject, writeSTL } from './write_3mf.js'

// The kernel is not guaranteed to answer (an old build has no selector_export_paint binding, and a worker that is
//  busy slicing replies late), so the wait is bounded. On timeout the save proceeds with whatever painting was
//  IMPORTED — losing the brush strokes is bad, losing the whole file because a worker was slow is worse.
const PAINT_EXPORT_TIMEOUT_MS = 4000

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.style.display = 'none'
  document.body.appendChild(anchor); anchor.click()
  setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url) }, 4000)
}

function requestPaintExport(worker) {
  if (!worker) return Promise.resolve(null)
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => { if (!done) { done = true; worker.removeEventListener('message', onMessage); resolve(value) } }
    const onMessage = (event) => { if (event.data?.type === 'paintExport') finish(event.data.supported ? event.data : null) }
    worker.addEventListener('message', onMessage)
    setTimeout(() => finish(null), PAINT_EXPORT_TIMEOUT_MS)
    worker.postMessage({ cmd: 'exportPaint' })
  })
}

// Show the busy label BEFORE doing the work. Setting React state does not paint — the browser only does that on
//  the next frame, and the synchronous half of a save (the geometry gather, the STL buffer) would otherwise run
//  first and the label would appear only in time to disappear. One rAF hands the paint over before the work
//  starts, which is the whole difference between "the button says Saving…" and "the button did nothing".
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))

export function makeExportActions(deps) {
  const { apiRef, getWorker, settingsRef, plateCountRef, bedRef, setError, setSliceNotice, setExporting } = deps

  const baseName = () => {
    const first = apiRef.current?.exportObjects?.()[0]?.name ?? 'project'
    return String(first).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'project'
  }

  // Every export runs through here so the busy flag can never be left on by an early return or a throw.
  //  `which` names the export, not what the button should say — the wording belongs to the UI, and having the two
  //  agree on a display string would mean the same sentence living in two files.
  async function busy(which, work) {
    setExporting?.(which)
    try {
      await nextFrame()                        // let the busy label paint before anything blocks
      apiRef.current?.suspendRendering?.(true)  // ...and only then stop drawing, so the label is the last frame
      await work()
    }
    finally { apiRef.current?.suspendRendering?.(false); setExporting?.(null) }
  }

  /** Everything currently on the bed as one .3mf project — geometry, settings, plate layout and painting. */
  async function runProjectExport() {
    const started = performance.now()
    const objects = apiRef.current?.exportObjects?.() ?? []
    if (!objects.length) { setError?.('Nothing to export — load a model first'); return }
    const gathered = performance.now()
    // The kernel's marks are in MERGED facet numbering over the objects of ONE plate, while a project spans every
    //  plate. Rebasing across plates would be guesswork, so the kernel's painting is only taken when the whole
    //  project is on the plate the selector holds; otherwise each object keeps the paint it was imported with.
    const singlePlate = new Set(objects.map(o => o.plate)).size <= 1
    const exported = singlePlate ? await requestPaintExport(getWorker?.()) : null
    const gotPaint = performance.now()
    try {
      const bytes = await write3MFProject(objects, settingsRef.current, {
        paintExport: exported,
        paintKind: getWorker?.()?.__paintImportKind === 'supports' ? 'supports' : 'color',
        bedWidth: bedRef.current?.bedW ?? 200,
        bedDepth: bedRef.current?.bedD ?? 200,
        plateCount: plateCountRef.current ?? 1,
      })
      // Same [vp-prof] channel the model load uses — the three stages have very different cost profiles (the
      //  geometry gather is per vertex, the paint fetch is a worker round trip, the write is deflate-bound), so a
      //  single total would say nothing about which one a slow save was.
      const facets = objects.reduce((sum, o) => sum + o.faceCount, 0)
      console.info(`[vp-prof] export 3mf: ${facets} facets, gather ${(gathered - started).toFixed(0)}ms,`
        + ` paint ${(gotPaint - gathered).toFixed(0)}ms, write ${(performance.now() - gotPaint).toFixed(0)}ms`
        + ` -> ${(bytes.byteLength / 1e6).toFixed(2)}MB`)
      download(bytes, `${baseName()}.3mf`, 'model/3mf')
      const painted = exported?.facets?.length ?? 0
      setSliceNotice?.(`Saved ${objects.length} object(s) as a 3mf project`
        + (painted ? ` with ${painted} painted facets.` : '.')
        + (!singlePlate ? ' Brush strokes are exported only for a single-plate project — this one kept the painting it was imported with.' : ''))
    } catch (err) { setError?.(`Export failed: ${err?.message || err}`) }
  }

  /** The visible objects as one binary STL, in the same world frame the 3mf uses (geometry only — no settings). */
  function runSTLExport() {
    const objects = apiRef.current?.exportObjects?.() ?? []
    if (!objects.length) { setError?.('Nothing to export — load a model first'); return }
    const total = objects.reduce((sum, o) => sum + o.tris.length, 0)
    const merged = new Float32Array(total)
    let at = 0
    for (const object of objects) { merged.set(object.tris, at); at += object.tris.length }
    download(writeSTL(merged), `${baseName()}.stl`, 'model/stl')
    setSliceNotice?.(`Exported ${objects.length} object(s) as STL (${(total / 9) | 0} triangles).`)
  }

  return {
    exportProject: () => busy('project', runProjectExport),
    // The STL path is fully synchronous, so without the frame the busy() helper yields it would freeze with the
    //  button still unchanged — the same reason, just more visible because nothing else is async to break it up.
    exportSTL: () => busy('stl', runSTLExport),
  }
}
