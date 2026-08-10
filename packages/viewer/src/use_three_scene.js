import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { plateStep, plateCols } from './plate_layout.js'
import { buildOverhangGeometry } from './overhang_view.js'

// Model loading (STL/OBJ/3MF/AMF/PLY) moved to model_loaders.js (stage 26). Only the model->three local transform remains here.
// model -> three-local (R=RotX(-90°)), centered in XZ, minY=0
function bakeLocal(modelPos) {
  const n = modelPos.length, p = new Float32Array(n)
  for (let i = 0; i < n; i += 3) { p[i] = modelPos[i]; p[i + 1] = modelPos[i + 2]; p[i + 2] = -modelPos[i + 1] }
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < n; i += 3) { minx = Math.min(minx, p[i]); maxx = Math.max(maxx, p[i]); miny = Math.min(miny, p[i + 1]); maxy = Math.max(maxy, p[i + 1]); minz = Math.min(minz, p[i + 2]); maxz = Math.max(maxz, p[i + 2]) }
  const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2
  for (let i = 0; i < n; i += 3) { p[i] -= cx; p[i + 1] -= miny; p[i + 2] -= cz }
  return { localPos: p, size: { w: maxx - minx, d: maxz - minz, h: maxy - miny } }
}

// Toolpath colors/geometry/shaders moved to toolpath_gpu.js (port of the upstream libvgcode) — the CPU ribbon builder is gone (stage 24).
// The renderer/scene/camera/OrbitControls/TransformControls, the pointer/key handlers and the imperative apiRef surface.
//  A real hook: it owns the refs nobody else touches (mount/three/paint drag/bed size) and receives the refs shared with
//  the other concerns (apiRef, objectsRef, plate selection, paint mode, …). The effect runs once, exactly as before.
export function useThreeScene(deps) {
  const {
    apiRef, objectsRef, keyRef, workerRef, selectedPlateRef, placeXRef, plateCountRef,
    canvasModeRef, paintModeRef, brushRadiusRef, paintXformRef, extruderColorsRef,
    setOk, setStatus, setGmode, setCtxMenu, setBrushRadius,
  } = deps

  const mountRef = useRef(null)
  const three = useRef({})
  const paintDrawingRef = useRef(false)
  const plateBWRef = useRef(200)        // plate (bed) width/depth — used for PX_i and membership calculations
  const plateBDRef = useRef(200)

  // three world offset of plate i (square grid layout)
  function platePos(i) {
    const cols = plateCols(plateCountRef.current)
    return { x: (i % cols) * plateStep(plateBWRef.current), z: Math.floor(i / cols) * plateStep(plateBDRef.current) }
  }
  // world (x,z) -> nearest plate index
  function plateOfXZ(wx, wz) {
    const n = plateCountRef.current, cols = plateCols(n)
    const col = Math.max(0, Math.min(cols - 1, Math.round(wx / plateStep(plateBWRef.current))))
    const row = Math.max(0, Math.round(wz / plateStep(plateBDRef.current)))
    return Math.max(0, Math.min(n - 1, row * cols + col))
  }

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const probe = document.createElement('canvas')
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) {
      setOk(false); setStatus('Cannot create a WebGL context in this environment (headless / no GPU).'); return
    }
    let w = mount.clientWidth || 800, h = mount.clientHeight || 480
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h); renderer.setClearColor(0x161a1e, 1)
    renderer.domElement.setAttribute('data-webgl', renderer.getContext() ? 'ok' : 'fail')
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    // 22-fix(H3): depth range shrunk drastically (was 0.1/6000 -> now 1/3000). far/near ratio 60000 -> 3000 gives ~20x better 24-bit depth precision
    //  -> removes the z-fighting where sub-surface infill pokes through the surface ("giant diagonal polygons"). Measured depth resolution: 0.08mm@d974, 0.13mm@d1500
    //  (within the 0.2mm layer height). logarithmicDepthBuffer was rejected: gl_FragDepth disables early-Z -> 3x fps drop at 489k overdraw.
    const camera = new THREE.PerspectiveCamera(50, w / h, 1, 3000)
    camera.position.set(210, 180, 260)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2f36, 1.0))
    const dir = new THREE.DirectionalLight(0xffffff, 1.1); dir.position.set(120, 220, 160); scene.add(dir)

    // Stage 29-2: bed (plate) rendering is managed by apiRef.setPlates (the bed useEffect initializes it). The initial single grid was removed.

    // Stage 26: the hardcoded demo meshes (cube/cylinder/torus) were removed — an empty scene plus the drop overlay guides the user instead.
    const objectsGroup = new THREE.Group(); scene.add(objectsGroup)
    // Toolpath root (an unrotated container, the target of mode visibility gating). Each plate's subgroup carries its own
    //  rotation.x=-90° (shader-local z-up) + position(offX,0,offZ), so all plates render simultaneously.
    const toolpathGroup = new THREE.Group(); scene.add(toolpathGroup)

    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.target.set(0, 22, 0); orbit.enableDamping = false; orbit.update()   // no inertia — desktop slicer convention (stops on release, kills the glide-tail stutter at the source)
    orbit.rotateSpeed = 1.6; orbit.panSpeed = 1.6   // mouse rotate/pan responsiveness (the default 1.0 felt sluggish)
    const transform = new TransformControls(camera, renderer.domElement)
    transform.setMode('translate'); transform.setSize(0.8)
    // Stage 29-1: re-seat on the bed after every transform commit (drag end) — measured from the desktop GLCanvas3D::do_move/rotate/scale
    //  "snaps object to buildplate" (ensure_on_bed). Applies to move/rotate/scale, only on commit (no need for it live during rotation).
    //  Upstream: flying (minZ>0) snaps to the bed, sinking (minZ<0) is kept down to SINKING_Z_THRESHOLD. **Difference (documented)**: our kernel
    //  cannot slice negative z, so sinking is unsupported -> any minZ≠0 snaps to 0 in either direction. World bbox minY (three height) -> 0.
    const _seatBox = new THREE.Box3()
    const seatMesh = (m) => { if (!m) return; m.updateMatrixWorld(true); _seatBox.setFromObject(m); const minY = _seatBox.min.y; if (Number.isFinite(minY) && Math.abs(minY) > 1e-4) { m.position.y -= minY; m.updateMatrixWorld(true) } }
    transform.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; if (!e.value) seatMesh(transform.object); three.current.invalidate?.() })
    scene.add(transform)

    three.current = { scene, camera, renderer, orbit, transform, objectsGroup, toolpathGroup, plateBeds: [] }
    if (typeof window !== 'undefined') { window.__vpThree = three.current; window.__vpApi = () => apiRef.current }   // dev/test aid

    // Render on demand (upstream desktop convention) — a static frame is not redrawn every frame, removing constant GPU load and thermal throttling.
    //  Every path that can change the scene calls invalidate(): orbit/gizmo change, pointer, keys, resize, React re-render.
    //  ponytail: a 500ms heartbeat render (2fps) as a safety net against a missed path leaving a stale frame.
    let renderPending = true
    const invalidate = () => { renderPending = true }
    three.current.invalidate = invalidate
    orbit.addEventListener('change', invalidate)
    transform.addEventListener('change', invalidate)
    renderer.domElement.addEventListener('pointermove', invalidate)

    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2()
    let hovered = null, selected = null, objIdCounter = 0   // the placement cursor is placeXRef (plate-relative)
    const activeMeshes = () => objectsRef.current.map(o => o.mesh)
    const paint = () => { for (const m of activeMeshes()) m.material.emissive.setHex(m === selected ? 0x00ae42 : m === hovered ? 0x1f5c34 : 0x000000) }
    const statusText = () => objectsRef.current.length
      ? `${objectsRef.current.length} object(s) · selected: ${selected ? selected.userData.name : '—'} | M/R/S · left-drag to orbit · ? for shortcuts`
      : `hover: ${hovered ? hovered.userData.name : '—'} · selected: ${selected ? selected.userData.name : '—'} | left-drag to orbit · ? for shortcuts`
    const toPointer = ev => { const r = renderer.domElement.getBoundingClientRect(); pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1; pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1 }
    const pick = () => { raycaster.setFromCamera(pointer, camera); const hits = raycaster.intersectObjects(activeMeshes(), false); return hits.length ? hits[0].object : null }
    // Stage 20: painting — converts the raycast hit (faceIndex + world point) into kernel coordinates and sends a paint command to the worker.
    const pickHit = () => { raycaster.setFromCamera(pointer, camera); const hits = raycaster.intersectObjects(activeMeshes(), false); return hits.length ? hits[0] : null }
    const paintAt = ev => {
      const X = paintXformRef.current; if (!X) return
      toPointer(ev); const hit = pickHit(); if (!hit || hit.faceIndex == null) return
      const toK = v => [v.x - X.cx, -v.z - X.cy, v.y - X.minz]   // viewer(Y-up) -> STL(Z-up) -> kernel
      const hk = toK(hit.point), ck = toK(camera.position)
      workerRef.current?.postMessage({ cmd:'paint', facet:hit.faceIndex, hx:hk[0],hy:hk[1],hz:hk[2],
        cx:ck[0],cy:ck[1],cz:ck[2], radius:brushRadiusRef.current, enforcer: paintModeRef.current === 'enforcer' })
    }
    // Cursor hints: crosshair in paint mode, pointer when hovering an object, default otherwise (camera control).
    const applyCursor = () => {
      const el = renderer.domElement
      el.style.cursor = canvasModeRef.current === 'preview' ? ''
        : paintModeRef.current !== 'off' ? 'crosshair'
        : hovered ? 'pointer' : ''
    }
    const onMove = ev => {
      if (canvasModeRef.current === 'preview') return   // S2: no hover/selection in preview
      if (paintModeRef.current !== 'off') { if (paintDrawingRef.current) paintAt(ev); return }
      if (transform.dragging || transform.axis) return; toPointer(ev); const hit = pick(); if (hit !== hovered) { hovered = hit; paint(); applyCursor(); setStatus(statusText()) } }
    const onDown = ev => {
      if (ev.button !== 0) return                       // left click only — right/middle clicks belong to OrbitControls pan/zoom (prevents stray selection/painting)
      if (canvasModeRef.current === 'preview') return   // S2: no gizmo/painting in preview
      if (paintModeRef.current !== 'off') { paintDrawingRef.current = true; orbit.enabled = false; paintAt(ev); return }
      if (transform.dragging || transform.axis) return; toPointer(ev); const hit = pick(); if (hit) { selected = hit; transform.attach(hit) } else { selected = null; transform.detach() } paint(); setStatus(statusText()) }
    // Paint release is handled on window — so releasing the button outside the canvas cannot leave paintDrawing/orbit.enabled stuck.
    const onUp = () => { if (paintDrawingRef.current) { paintDrawingRef.current = false; orbit.enabled = true } }
    // Double click: on an object = zoom to it, on empty space = clear the selection (3D app convention)
    const onDblClick = ev => {
      if (ev.button !== 0 || canvasModeRef.current === 'preview' || paintModeRef.current !== 'off') return
      toPointer(ev)
      if (pick()) frameObjects()
      else { selected = null; transform.detach(); paint(); setStatus(statusText()) }
    }
    // Wheel: adjusts the brush radius in paint mode (upstream GLGizmoPainterBase convention) — otherwise plain OrbitControls zoom.
    const onWheel = ev => {
      if (paintModeRef.current === 'off' || canvasModeRef.current === 'preview') return
      ev.preventDefault(); ev.stopPropagation()
      const v = Math.min(15, Math.max(1, brushRadiusRef.current + (ev.deltaY < 0 ? 0.5 : -0.5)))
      brushRadiusRef.current = v; setBrushRadius(v)
    }
    // Right-click context menu — selects the object under the press, then hands the menu coordinates to the component.
    //  (OrbitControls calls preventDefault on contextmenu, so there is no clash with the native menu.)
    //  Note: distinguish from a right-drag pan — if the pointer moved 4px or more since pointerdown, the menu does not open.
    let rmbDown = null
    const onRmbDown = ev => { if (ev.button === 2) rmbDown = { x: ev.clientX, y: ev.clientY } }
    const onCtxMenu = ev => {
      ev.preventDefault()
      if (canvasModeRef.current === 'preview' || paintModeRef.current !== 'off') return
      if (rmbDown && Math.hypot(ev.clientX - rmbDown.x, ev.clientY - rmbDown.y) > 4) return   // that was a pan drag
      toPointer(ev); const hit = pick()
      if (hit) { selected = hit; transform.attach(hit) } else { selected = null; transform.detach() }
      paint(); setStatus(statusText())
      const r = renderer.domElement.getBoundingClientRect()
      setCtxMenu({ x: ev.clientX - r.left, y: ev.clientY - r.top, onObject: !!hit })
    }
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerdown', onRmbDown)
    renderer.domElement.addEventListener('contextmenu', onCtxMenu)
    renderer.domElement.addEventListener('dblclick', onDblClick)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false, capture: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)

    const setMode = m => { transform.setMode(m); setGmode(m) }
    const frameObjects = () => {
      const arr = objectsRef.current
      const box = new THREE.Box3()
      if (arr.length) arr.forEach(o => box.expandByObject(o.mesh)); else box.setFromCenterAndSize(new THREE.Vector3(0, 25, 0), new THREE.Vector3(100, 50, 100))
      const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3())
      const d = Math.max(s.x, s.y, s.z, 20) * 1.9 + 40
      orbit.target.copy(c); camera.position.set(c.x + d * 0.7, c.y + d * 0.55 + s.y * 0.3, c.z + d); camera.updateProjectionMatrix(); orbit.update()
    }

    // Shared path for registering an object mesh — used by addObject (fresh load) and spawnSnapshot (duplicate/paste).
    //  Stage 26 R4 + 29-2: places them side by side on the selected plate (placeXRef = plate-relative cursor, PX = plate offset).
    //  When pos is given, the object goes there instead of the placement cursor (split: parts must stay where they were).
    const spawnMesh = (name, localPos, rot = null, scale = null, pos = null) => {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(localPos, 3)); geo.computeVertexNormals()
      geo.computeBoundingBox()
      const col0 = extruderColorsRef.current[0] || '#6aa0dc'   // apply the T1 filament color
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(col0), roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide }))
      if (rot) mesh.rotation.copy(rot)
      if (scale) mesh.scale.copy(scale)
      if (pos) {
        mesh.position.copy(pos)                       // split and friends: keep the original position (no placement cursor)
      } else {
        const w = (geo.boundingBox.max.x - geo.boundingBox.min.x) * (scale ? Math.abs(scale.x) : 1)
        if (objectsRef.current.length === 0) placeXRef.current = 0
        const pp = platePos(selectedPlateRef.current)
        mesh.position.set(pp.x + placeXRef.current + w / 2, 0, pp.z)
        placeXRef.current += w + 8
      }
      mesh.userData = { name }
      objectsGroup.add(mesh)
      const id = ++objIdCounter
      objectsRef.current.push({ id, name, mesh, localPos, extruder: 1, visible: true })   // MM: extruder 1 by default
      objectsGroup.visible = true
      if (overhangDeg != null) rebuildOverhang()      // a newly added object gets shaded too
      setStatus(statusText()); frameObjects()
      return { id, name }
    }

    // Overhang shading: an overlay child per object holding just the facets that will need support. Being a child
    //  means it inherits the object's transform for free; only the facet test itself has to be redone after a
    //  rotation, which is what the dragging-changed hook below covers.
    let overhangDeg = null
    function rebuildOverhang() {
      for (const o of objectsRef.current) {
        const prev = o.mesh.children.find(c => c.userData?.overhang)
        if (prev) { o.mesh.remove(prev); prev.geometry.dispose(); prev.material.dispose() }
        if (overhangDeg == null) continue
        o.mesh.updateWorldMatrix(true, false)
        const geo = buildOverhangGeometry(o.mesh, overhangDeg)
        if (!geo) continue
        const overlay = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0xff4433, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        }))
        overlay.userData.overhang = true
        o.mesh.add(overlay)
      }
      invalidate()
    }
    transform.addEventListener('dragging-changed', e => { if (!e.value && overhangDeg != null) rebuildOverhang() })

    apiRef.current = {
      setMode,
      /** Highlight facets below `thresholdDeg` (the support threshold angle); null turns the shading off. */
      setOverhang: (thresholdDeg) => { overhangDeg = thresholdDeg; rebuildOverhang() },
      refreshCursor: () => applyCursor(),                                        // keeps the cursor hint in sync when the paint mode changes
      detachTransform: () => { selected = null; transform.detach(); paint() },   // stage 20: release the gizmo when entering painting
      addObject: (name, modelPos) => spawnMesh(name, bakeLocal(modelPos).localPos),
      // ---- Shortcut support (duplicate/nudge/rotate/zoom-to) ----
      getSnapshot: (id) => {           // snapshot for copy/duplicate — localPos is immutable, so the reference is shared
        const o = objectsRef.current.find(x => x.id === id); if (!o) return null
        return { name: o.name, localPos: o.localPos, rot: o.mesh.rotation.clone(), scale: o.mesh.scale.clone(), pos: o.mesh.position.clone() }
      },
      // keepPos=true keeps the snapshot's original position (split). false (default) places it beside via the placement cursor (duplicate/paste).
      spawnSnapshot: (snap, keepPos = false) => snap ? spawnMesh(snap.name, snap.localPos, snap.rot, snap.scale, keepPos ? (snap.pos || null) : null) : null,
      nudgeSelected: (dx, dz) => { if (!selected) return; selected.position.x += dx; selected.position.z += dz },
      rotateSelectedY: (rad) => { if (!selected) return; selected.rotation.y += rad },
      frame: () => frameObjects(),                                   // Z: zoom to all objects
      frameBed: () => {                                              // B: zoom to the selected plate
        const pp = platePos(selectedPlateRef.current)
        const d = Math.max(plateBWRef.current, plateBDRef.current) * 1.1 + 40
        orbit.target.set(pp.x, 0, pp.z); camera.position.set(pp.x + d * 0.55, d * 0.8, pp.z + d); orbit.update()
      },
      removeObject: (id) => {
        const arr = objectsRef.current
        const k = arr.findIndex(o => o.id === id); if (k < 0) return
        const o = arr[k]
        if (selected === o.mesh) { selected = null; transform.detach() }
        if (hovered === o.mesh) hovered = null
        for (const child of [...o.mesh.children]) {      // the overhang overlay rides along as a child
          o.mesh.remove(child); child.geometry?.dispose(); child.material?.dispose()
        }
        objectsGroup.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose()
        arr.splice(k, 1)
        if (arr.length === 0) placeXRef.current = 0
        paint(); setStatus(statusText())
      },
      // MM: merges triangles sorted by ascending extruder -> group0 (ext1) followed by group1 (ext2); returns split.
      platePos: (i) => platePos(i),   // three (x,z) offset of plate i
      plateOfObject: (o) => {                                // membership by position = nearest plate center
        o.mesh.updateMatrixWorld(true)
        const wp = new THREE.Vector3().setFromMatrixPosition(o.mesh.matrixWorld)
        return plateOfXZ(wp.x, wp.z)
      },
      // When plateIdx != null, only objects on that plate are used and coordinates are converted to plate-local (three-x -= PX) (keeps the stage-28 contract).
      buildMergedSTL: (plateIdx = null) => {
        let arr = objectsRef.current.filter(o => o.visible !== false)
        if (plateIdx != null) arr = arr.filter(o => { o.mesh.updateMatrixWorld(true); const wp = new THREE.Vector3().setFromMatrixPosition(o.mesh.matrixWorld); return plateOfXZ(wp.x, wp.z) === plateIdx })
        if (!arr.length) return null
        const sorted = [...arr].sort((a, b) => (a.extruder || 1) - (b.extruder || 1))
        const usedExtruders = new Set(sorted.map(o => o.extruder || 1))
        const tmp = new THREE.Vector3(); const out = []
        // One boundary per extruder change, not just the first: with objects on T1/T2/T3 a single boundary would
        //  fold T3's triangles into T2's group and print them with T2's material. `tools` carries the real
        //  extruder number of each group, because assignments can skip one (T1 and T3 with nothing on T2).
        let triCount = 0, split = 0
        const splits = [], tools = []
        for (const o of sorted) {
          const ext = o.extruder || 1
          if (tools.length === 0) tools.push(ext - 1)
          else if (ext - 1 !== tools[tools.length - 1]) { splits.push(triCount); tools.push(ext - 1) }
          if (ext >= 2 && split === 0) split = triCount   // start boundary of ext2 (the pre-N-way scalar form)
          o.mesh.updateMatrixWorld(true)
          const M = o.mesh.matrixWorld, lp = o.localPos
          for (let i = 0; i < lp.length; i += 3) { tmp.set(lp[i], lp[i + 1], lp[i + 2]).applyMatrix4(M); out.push(tmp.x, -tmp.z, tmp.y) }  // Rinv -> model (world)
          triCount += lp.length / 9
        }
        // Stage 29: center the slice input on the XY origin (symmetric coordinates). The upstream desktop also centers via m_plate_origin before slicing.
        //  Why: after stage 28 P2 (removing the re-alignment), some asymmetric/negative coordinates (e.g. x[0,20], y[-10,10]) triggered
        //  memory OOB in the kernel skirt/infill paths (symmetric coordinates were fine — golden was fine too). Centering avoids it, and the toolpath is offset by the same amount so it still overlaps the on-screen model.
        let mnx = 1e18, mny = 1e18, mxx = -1e18, mxy = -1e18
        for (let i = 0; i < out.length; i += 3) { if (out[i] < mnx) mnx = out[i]; if (out[i] > mxx) mxx = out[i]; if (out[i + 1] < mny) mny = out[i + 1]; if (out[i + 1] > mxy) mxy = out[i + 1] }
        const Cmx = (mnx + mxx) / 2, Cmy = (mny + mxy) / 2   // XY center of the world content (includes the plate offset PX)
        for (let i = 0; i < out.length; i += 3) { out[i] -= Cmx; out[i + 1] -= Cmy }
        // Toolpath display offset (three): content world center model(Cmx,Cmy) -> three(x=Cmx, z=-Cmy). Cmx already includes the plate PX -> it renders on that plate.
        const offX3 = Cmx, offZ3 = -Cmy
        const buf = new ArrayBuffer(84 + triCount * 50), dvw = new DataView(buf)
        dvw.setUint32(80, triCount, true)
        let off = 84, vi = 0
        for (let t = 0; t < triCount; t++) {
          off += 12
          for (let k = 0; k < 3; k++) { dvw.setFloat32(off, out[vi++], true); dvw.setFloat32(off + 4, out[vi++], true); dvw.setFloat32(off + 8, out[vi++], true); off += 12 }
          dvw.setUint16(off, 0, true); off += 2
        }
        return { buf, split, splits, tools, extruders: usedExtruders.size, offX: offX3, offZ: offZ3 }
      },
      setObjectExtruder: (id, e) => { const o = objectsRef.current.find(x => x.id === id); if (o) { o.extruder = e; const c = extruderColorsRef.current[e - 1]; if (c) o.mesh.material.color.set(c) } },
      setObjectVisible: (id, v) => { const o = objectsRef.current.find(x => x.id === id); if (o) { o.visible = v; o.mesh.visible = v } },   // stage 27: print toggle (eye icon)
      recolorObjects: () => { for (const o of objectsRef.current) { const c = extruderColorsRef.current[(o.extruder || 1) - 1]; if (c) o.mesh.material.color.set(c) } },   // reflect filament color changes
      selectedObjectId: () => selected ? (objectsRef.current.find(o => o.mesh === selected)?.id ?? null) : null,   // stage 27: viewport toolbar "delete selected"
      selectObject: (id) => {   // stage 33: select the object clicked in the list (for selection-driven actions such as split)
        const o = objectsRef.current.find(x => x.id === id); if (!o) return
        selected = o.mesh; transform.attach(o.mesh); paint(); setStatus(statusText())
      },
      // Stage 28 P1: seat on the bed — local geometry is baked to minZ->0 by bakeLocal (once on load). Re-seat after a gizmo Z move.
      //  (The upstream ensure_on_bed sinking allowance [allow_negative_z] is out of scope — we only seat by -min_z.)
      placeOnBed: () => { for (const o of objectsRef.current) o.mesh.position.y = 0; if (selected) transform.update?.() },
      onSliced: () => { objectsGroup.visible = false; transform.detach(); selected = null; paint() },
      showObjects: () => { objectsGroup.visible = true },
      // Stage 29-2: render N plates — each plate = grid + border, offset by PX_i, with the selected plate's border highlighted.
      setPlates: (n, bw, bd, sel) => {
        const t = three.current
        plateBWRef.current = bw; plateBDRef.current = bd; plateCountRef.current = n; selectedPlateRef.current = sel
        for (const p of (t.plateBeds || [])) for (const m of [p.gridThin, p.gridBold, p.border]) { t.scene.remove(m); m.geometry.dispose(); m.material.dispose() }
        t.plateBeds = []
        const cols = plateCols(n), sx = plateStep(bw), sz = plateStep(bd)
        // Grid: upstream Bed_2D rules — a rectangular grid that fits the bed rectangle exactly, cell spacing based on the shorter side
        //  (<600mm -> 10mm, …), laid out from the corner origin with a bold line every 5 cells (main grid 50mm).
        const minEdge = Math.min(bw, bd)
        const cell = minEdge >= 6000 ? 100 : minEdge >= 1200 ? 50 : minEdge >= 600 ? 20 : 10
        const thin = [], bold = []
        const x0 = -bw / 2, z0 = -bd / 2
        for (let i = 0, x = x0; x <= bw / 2 + 1e-6; x = x0 + ++i * cell) (i % 5 ? thin : bold).push(x, 0, z0, x, 0, bd / 2)
        for (let j = 0, z = z0; z <= bd / 2 + 1e-6; z = z0 + ++j * cell) (j % 5 ? thin : bold).push(x0, 0, z, bw / 2, 0, z)
        const lineGeo = (a) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); return g }
        for (let i = 0; i < n; i++) {
          const px = (i % cols) * sx, pz = Math.floor(i / cols) * sz
          const gt = new THREE.LineSegments(lineGeo(thin), new THREE.LineBasicMaterial({ color: 0x232a31 }))
          const gb = new THREE.LineSegments(lineGeo(bold), new THREE.LineBasicMaterial({ color: 0x39434d }))
          gt.position.set(px, 0, pz); gb.position.set(px, 0, pz); t.scene.add(gt); t.scene.add(gb)
          const sel_ = i === sel
          const b = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(bw, bd)), new THREE.LineBasicMaterial({ color: sel_ ? 0x00ae42 : 0x4a5560, linewidth: sel_ ? 2 : 1 }))
          b.rotation.x = -Math.PI / 2; b.position.set(px, 0, pz); t.scene.add(b)
          t.plateBeds.push({ gridThin: gt, gridBold: gb, border: b })
        }
      },
      setBed: (bw, bd) => { apiRef.current?.setPlates(plateCountRef.current, bw, bd, selectedPlateRef.current) },   // backwards compatible
    }

    // The shortcut body lives in component scope (keyRef — captures the latest state/functions each render). The effect only forwards.
    const onKey = e => { keyRef.current?.(e); invalidate() }
    window.addEventListener('keydown', onKey)
    const ro = new ResizeObserver(() => { w = mount.clientWidth || w; h = mount.clientHeight || h; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); invalidate() })
    ro.observe(mount)
    setStatus(statusText())
    let raf = 0, lastRender = 0
    const loop = (now = 0) => {
      raf = requestAnimationFrame(loop); orbit.update()
      if (renderPending || now - lastRender > 500) { renderPending = false; lastRender = now; renderer.render(scene, camera) }
    }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect(); window.removeEventListener('keydown', onKey)
      renderer.domElement.removeEventListener('pointermove', onMove); renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerdown', onRmbDown); renderer.domElement.removeEventListener('contextmenu', onCtxMenu)
      renderer.domElement.removeEventListener('dblclick', onDblClick); renderer.domElement.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp)
      apiRef.current = null
      transform.detach(); transform.dispose(); orbit.dispose()
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose() })
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }, [])

  return { mountRef, three }
}
