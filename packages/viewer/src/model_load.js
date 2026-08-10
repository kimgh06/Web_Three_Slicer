import { loadModel, SUPPORTED_EXT, fileExt } from './model_loaders.js'

// Stage 26: model loading (STL/OBJ/3MF/AMF/PLY, cumulative) — shared by the file picker and drag-and-drop.
// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each
//  render so the values it closes over (dragOver) stay fresh.
export function makeModelLoad(deps) {
  const {
    apiRef, objectsRef, layersDataRef, segDataRef, plateResultsRef, plateOffsetsRef,
    clearToolpaths, refreshSlicedCount, dragOver,
    setError, setTriWarn, setProgress, setStats, setOverBed, setLayerCount, setSegCount,
    setColorRange, setSliceNotice, setDowngradeOffer, setGcodeUrl, setCanvasMode, setObjects, setDragOver,
  } = deps

  async function loadFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => SUPPORTED_EXT.includes(fileExt(f.name)))
    const rejected = Array.from(fileList || []).length - files.length
    if (!files.length) { if (rejected) setError('Supported formats: STL/OBJ/3MF/AMF/PLY'); return }
    setError(''); setTriWarn(''); setProgress(0)
    layersDataRef.current = null; segDataRef.current = null; plateResultsRef.current = {}; plateOffsetsRef.current = {}
    clearToolpaths(); refreshSlicedCount()
    setStats(null); setOverBed(false); setLayerCount(0); setSegCount(0); setColorRange(null); setSliceNotice(''); setDowngradeOffer(null)
    setGcodeUrl(prev => { if (prev) URL.revokeObjectURL(prev); return '' })
    setCanvasMode('prepare')   // S2: a new model goes back to Prepare
    apiRef.current?.showObjects()
    let totalTri = 0
    for (const f of files) {
      try {
        const __tl0 = performance.now()   // [vp-prof] load timing (temporary)
        const buf = await f.arrayBuffer()
        const __tl1 = performance.now()
        const objs = await loadModel(f.name, buf)          // [{name, modelPos}] (3MF/AMF may return several)
        const __tl2 = performance.now()
        for (const ob of objs) { apiRef.current?.addObject(ob.name, ob.modelPos); totalTri += ob.modelPos.length / 9 }
        console.info(`[vp-prof] load ${f.name}: read ${(__tl1-__tl0).toFixed(0)}ms, parse ${(__tl2-__tl1).toFixed(0)}ms, scene ${(performance.now()-__tl2).toFixed(0)}ms`)
      } catch (err) { setError(`Failed to load ${f.name}: ${(err && err.message) || err}`) }
    }
    setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false })))
    if (totalTri > 100000) setTriWarn(`${Math.round(totalTri).toLocaleString()} triangles — slicing may take a while`)
  }
  function onFiles(e) { loadFiles(e.target.files); e.target.value = '' }
  function removeObject(id) { apiRef.current?.removeObject(id); setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false }))) }
  // Stage 26 R4: the whole viewport is a drop zone
  function onDrop(e) { e.preventDefault(); setDragOver(false); loadFiles(e.dataTransfer?.files) }
  function onDragOver(e) { e.preventDefault(); e.dataTransfer && (e.dataTransfer.dropEffect = 'copy'); if (!dragOver) setDragOver(true) }
  function onDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }

  return { loadFiles, onFiles, removeObject, onDrop, onDragOver, onDragLeave }
}
