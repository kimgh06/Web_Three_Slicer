import * as THREE from 'three'

// Stage 20: manual support painting (enforcer/blocker).
// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each render.
export function makeSupportPaint(deps) {
  const {
    three, objectsRef, apiRef, getWorker, selectedPlateRef,
    paintXformRef, paintOverlayRef, paintModeRef,
    setError, setPaintModeState, setPaintCounts,
  } = deps

  function rebuildPaintOverlay(enfArr, blkArr) {
    const t = three.current; if (!t.objectsGroup) return
    const X = paintXformRef.current || { cx:0, cy:0, minz:0 }
    const ov = paintOverlayRef.current
    if (ov) { for (const k of ['enf','blk']) if (ov[k]) { t.objectsGroup.remove(ov[k]); ov[k].geometry.dispose(); ov[k].material.dispose() } }
    const mk = (arr, color) => {
      if (!arr || arr.length < 9) return null
      const pos = new Float32Array(arr.length)
      for (let i=0;i<arr.length;i+=3){ const kx=arr[i],ky=arr[i+1],kz=arr[i+2];  // kernel -> STL -> viewer(Y-up)
        pos[i]=kx+X.cx; pos[i+1]=kz+X.minz; pos[i+2]=-(ky+X.cy) }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3)); g.computeVertexNormals()
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent:true, opacity:0.55, side:THREE.DoubleSide, depthTest:false }))
      m.renderOrder = 999; t.objectsGroup.add(m); return m
    }
    paintOverlayRef.current = { enf: mk(enfArr, 0x2b6cff), blk: mk(blkArr, 0xe23b3b) }  // enforcer=blue, blocker=red
    three.current.invalidate?.()   // worker message path (scene changed without a React re-render)
  }
  function clearPaintOverlay() {
    const t = three.current, ov = paintOverlayRef.current
    if (ov && t.objectsGroup) for (const k of ['enf','blk']) if (ov[k]) { t.objectsGroup.remove(ov[k]); ov[k].geometry.dispose(); ov[k].material.dispose() }
    paintOverlayRef.current = null
  }
  function setPaintMode(mode) {
    if (mode !== 'off' && objectsRef.current.length === 0) { setError('Upload an STL first'); return }
    if (mode !== 'off') {
      const merged = apiRef.current?.buildMergedSTL(selectedPlateRef.current); if (!merged) return
      // Stage 29: the merged STL is centered (Cmx,Cmy subtracted) -> the paint raycast (world) must subtract the same amount to match the selector. Cmx=offX, Cmy=-offZ.
      paintXformRef.current = { cx: merged.offX, cy: -merged.offZ, minz: 0 }
      apiRef.current?.detachTransform()
      getWorker().postMessage({ cmd: 'prepare', stl: merged.buf })
    }
    paintModeRef.current = mode; setPaintModeState(mode)
    apiRef.current?.refreshCursor()   // refresh the cursor hint when entering/leaving paint mode
  }
  function clearPaint() { getWorker().postMessage({ cmd: 'clear' }); clearPaintOverlay(); setPaintCounts({ enf:0, blk:0 }) }

  return { rebuildPaintOverlay, clearPaintOverlay, setPaintMode, clearPaint }
}
