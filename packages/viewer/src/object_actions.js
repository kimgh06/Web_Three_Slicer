import { splitConnectedComponents } from './model_loaders.js'

// Object actions (duplicate/copy/paste/delete/split + gizmo mode) — bound to the object toolbar, the
//  context menu and the keyboard shortcuts.
// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each render.
export function makeObjectActions(deps) {
  const {
    apiRef, objectsRef, clipboardRef, paintModeRef,
    setPaintMode, removeObject, refreshObjects, setError, setSliceNotice,
  } = deps

  // Stage 33: instead of silently ignoring an empty selection, say why (pressing the toolbar button used to look like nothing happened).
  function duplicateSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to duplicate first'); return }
    const snap = apiRef.current?.getSnapshot(id)
    if (snap) { apiRef.current?.spawnSnapshot(snap); refreshObjects(); setError('') }
  }
  function copySelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to copy first'); return }
    clipboardRef.current = apiRef.current?.getSnapshot(id); setError('')
    setSliceNotice('Object copied (paste with Ctrl+V)')
  }
  function pasteClipboard() { if (clipboardRef.current) { apiRef.current?.spawnSnapshot(clipboardRef.current); refreshObjects() } }
  function deleteSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to delete first'); return }
    removeObject(id); setError('')
  }
  // Stage 33: delete all (upstream Ctrl+D / Delete all). Empties every object from the scene.
  function deleteAllObjects() {
    const ids = objectsRef.current.map(o => o.id)
    if (!ids.length) return
    for (const id of ids) apiRef.current?.removeObject(id)
    refreshObjects()
    setSliceNotice(`Deleted all ${ids.length} object(s)`)
  }
  // Stage 33: split to objects (upstream Split to objects). Turns every connected component into its own object.
  //  Each component keeps the original coordinates, so it is re-aligned with the same rules as bakeLocal
  //  (centered in XZ, minY=0) before registration, letting spawnMesh's placement cursor position it properly.
  function splitSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('Select an object to split first'); return }
    const snap = apiRef.current?.getSnapshot(id); if (!snap) return
    let parts
    try { parts = splitConnectedComponents(snap.localPos) }
    catch (e) { setError('Split failed: ' + (e?.message || e)); return }
    if (!parts || parts.length < 2) { setError('No separate parts to split — this is a single connected mesh'); return }
    // Each component's coordinates stay in the parent's local frame. Inheriting the parent's position/rotation/scale as-is
    //  keeps the on-screen position unchanged after the split (same as the upstream Split — parts stay put).
    //  Re-aligning them and laying them out with the placement cursor would put 21 pieces in a row, off the bed (measured).
    const base = String(snap.name || 'object').replace(/\.[^.]+$/, '')
    removeObject(id)
    parts.forEach((p, i) => apiRef.current?.spawnSnapshot(
      { name: `${base}_${i + 1}`, localPos: p, rot: snap.rot, scale: snap.scale, pos: snap.pos }, true))
    refreshObjects()
    setError('')
    setSliceNotice(`Split into ${parts.length} objects`)
  }
  function setGizmo(m) { if (paintModeRef.current !== 'off') setPaintMode('off'); apiRef.current?.setMode(m) }   // leave paint mode first (same path as the toolbar)

  return { duplicateSelected, copySelected, pasteClipboard, deleteSelected, deleteAllObjects, splitSelected, setGizmo }
}
