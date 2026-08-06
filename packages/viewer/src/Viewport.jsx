import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { deriveKernelParams, settingRaw } from 'three-slicer/settings'
import { makeSlicerWorker } from './make_worker.js'
import ShadowHost from './shadow_host.jsx'
import shadowCss from '../styles.css?inline'   // Shadow DOM isolation — inlined as a string at build time
import { buildSegmentData, makeToolpath, computeColors, roleRatios, VIEW_TYPES, DEFAULT_RANGES_COLORS, TYPE_COLOR } from './toolpath_gpu.js'
import { loadModel, SUPPORTED_EXT, fileExt, splitConnectedComponents } from './model_loaders.js'
// Stage 27: reuses the upstream desktop toolbar icons (resources/images -> assets, same project license).
import {
  moveIcon, rotateIcon, scaleIcon, paintIcon, openIcon, addIcon, deleteIcon, arrangeIcon, orientIcon,
  onbedIcon, duplicateIcon, splitIcon, deleteallIcon, cutIcon, booleanIcon, negativeIcon,
  seamIcon, mmuIcon, textmarkIcon, measureIcon, varlayerIcon,
} from './icons.js'

// 3D viewport + browser-only slicing (WASM, track C stage 4).
//  - Slice parameters are derived from the right-hand editor panel values (deriveKernelParams) — no duplicate form.
//  - Multiple objects (cumulative upload + merged TransformControls transforms), support/raft/bed/pattern/cooling/arc/seam.
//  - Toolpaths: stage 24 — the upstream libvgcode approach (GPU instancing, toolpath_gpu.js). The CPU geometry builder is gone.
//    Coordinates: kernel z-up -> toolpathGroup rotation.x=-90° (the shader computes in local z-up, view_matrix compensates).

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
// Plate spacing — fixed mm. (Upstream uses 1/5 of the width, but we keep a constant gap regardless of bed size.)
const PLATE_GAP = 40
const plateStep = (edge) => edge + PLATE_GAP
// Square plate layout — upstream PartPlate.hpp compute_colum_count: cols ≈ ceil(sqrt(n)).
//  Plate i = (col=i%cols)*stepX, (row=i/cols)*stepZ (upstream grows along -Y -> +z in three).
const MAX_PLATES = 9
const plateCols = (count) => { const v = Math.sqrt(count), r = Math.round(v); return v > r ? r + 1 : r }

export default function Viewport({ settings = {}, setSettings = () => {}, processPanel = null }) {
  const mountRef = useRef(null)
  const apiRef = useRef(null)
  const three = useRef({})
  const workerRef = useRef(null)
  const objectsRef = useRef([])        // [{id,name,mesh,localPos}]
  const layersDataRef = useRef(null)   // layer data of the focused (selected) plate — alias
  const toolpathRef = useRef(null)     // stage 24: the makeToolpath() controller — alias for the focused plate (slider/travel target)
  const segDataRef = useRef(null)      // stage 25: buildSegmentData result — alias for the focused plate (for recomputing view-type colors)
  const plateTpRef = useRef({})        // the real per-plate toolpaths {idx: {group, ctl, seg}} — all plates render at once
  const keyRef = useRef(null)          // shortcut handler (component scope — captures the latest state). The effect only forwards.
  const clipboardRef = useRef(null)    // in-app copy buffer (object snapshot) — the OS clipboard is not used
  const showTravelRef = useRef(false)
  const viewTypeRef = useRef('feature')  // stage 25: view type (feature/speed/height/width/fan/temp)
  const layerLoRef = useRef(0)         // stage 25: dual slider lower/upper bound (0-based layer)
  const layerHiRef = useRef(0)
  const canvasModeRef = useRef('prepare')  // S2: interaction gating (gizmo/painting disabled in preview)
  const lineWidthRef = useRef(0.42)    // line_width of the last slice (default width; layer height is derived from the z increment by buildSegmentData)
  // Stage 20: manual support painting (enforcer/blocker)
  const paintModeRef = useRef('off')   // 'off' | 'enforcer' | 'blocker'
  const brushRadiusRef = useRef(5)
  const paintXformRef = useRef(null)    // {cx,cy,minz} kernel transform (object STL bbox)
  const paintOverlayRef = useRef(null)  // {enf: Mesh, blk: Mesh}
  const paintDrawingRef = useRef(false)
  // Stage 29-2: multiple plates (minimal S7). Plate i sits at three-x offset PX_i = i*(bedW+GAP).
  const plateResultsRef = useRef({})    // {plateIdx: sliceResult} cache
  const plateOffsetsRef = useRef({})    // {plateIdx: {offX, offZ}} toolpath display offset (compensates the centered slice)
  const pendingSliceRef = useRef(null)  // promise-based slice (for the sequential all-plates run) + the stage-30 watchdog timer
  const streamAccumRef = useRef(null)   // stage 30: streamed layer accumulator {layers:[{z,paths,widths}], gcode:[chunk]}
  const downgradeRef = useRef(false)    // stage 30: a downgrade (simplified) retry is in progress — buildParams simplifies infill + economy
  const lastGeomRef = useRef(null)      // G003 incremental: geometry digest of the last successful slice (plate-agnostic — a different plate yields a different digest)
  const selectedPlateRef = useRef(0)
  const plateCountRef = useRef(1)
  const placeXRef = useRef(0)           // object placement cursor within the selected plate (plate-relative)
  const plateBWRef = useRef(200)        // plate (bed) width/depth — used for PX_i and membership calculations
  const plateBDRef = useRef(200)

  const [ok, setOk] = useState(true)
  const [gmode, setGmode] = useState('translate')
  const [status, setStatus] = useState('Initializing…')
  const [objects, setObjects] = useState([])
  const [triWarn, setTriWarn] = useState('')
  const [slicing, setSlicing] = useState(false)
  const [autoSlice, setAutoSlice] = useState(false)     // G004: debounced auto re-slice on settings change (after the first manual slice)
  const autoTimerRef = useRef(0)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [stats, setStats] = useState(null)
  const [overBed, setOverBed] = useState(false)
  const [layerCount, setLayerCount] = useState(0)
  const [segCount, setSegCount] = useState(0)   // stage 24: number of rendered segments (instances)
  const [plateCount, setPlateCount] = useState(1)       // stage 29-2: plate count
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
  const [selectedPlate, setSelectedPlate] = useState(0) // selected plate (0-based)
  const [sliceMenu, setSliceMenu] = useState(false)     // whether the [Slice ▾] dropdown is open
  const [showHelp, setShowHelp] = useState(false)       // '?' shortcut help overlay
  const [slicedPlateCount, setSlicedPlateCount] = useState(0)   // number of plates holding a result (drives the export-all button)
  const [ctxMenu, setCtxMenu] = useState(null)          // right-click context menu {x, y, onObject}
  // Stage 25 S6: view type + dual slider + gradient legend
  const [viewType, setViewType] = useState('feature')
  const [colorRange, setColorRange] = useState(null)   // {min,max,label,unit,cont}
  const [layerLo, setLayerLo] = useState(0)            // 0-based lower bound
  const [layerHi, setLayerHi] = useState(0)            // 0-based upper bound
  const [singleLayer, setSingleLayer] = useState(false)
  const [roleLegend, setRoleLegend] = useState([])          // S6.3: length share per role
  const [canvasMode, setCanvasMode] = useState('prepare')   // S2: 'prepare' (model+gizmo+painting) | 'preview' (toolpaths)
  const [dragOver, setDragOver] = useState(false)           // stage 26 R4: drag-and-drop highlight
  const fileInputRef = useRef(null)
  // Stage 27 S4: filament (extruder) colors — applied to object meshes and the prime tower. Defaults to T1/T2.
  const [extruderColors, setExtruderColors] = useState(['#6aa0dc', '#e08a2b'])
  const extruderColorsRef = useRef(['#6aa0dc', '#e08a2b'])
  const [gcodeUrl, setGcodeUrl] = useState('')
  const [showTravel, setShowTravel] = useState(false)
  const [wipeTowerReal, setWipeTowerReal] = useState(false)   // stage 12: real WipeTower.generate() (MM only)
  const [paintMode, setPaintModeState] = useState('off')      // stage 20: support painting mode
  const [brushRadius, setBrushRadius] = useState(5)
  const [paintCounts, setPaintCounts] = useState({ enf: 0, blk: 0 })
  // Stage 30 OOM ladder UI: economy-mode completion notice + downgrade offer (simplified retry)
  const [sliceNotice, setSliceNotice] = useState('')       // e.g. "Memory pressure — finished in economy mode (no preview)"
  const [downgradeOffer, setDowngradeOffer] = useState(null) // {scope} — even economy mode failed -> offer a simplified retry

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
      setStatus(statusText()); frameObjects()
      return { id, name }
    }

    apiRef.current = {
      setMode,
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
        let triCount = 0, split = 0
        for (const o of sorted) {
          if ((o.extruder || 1) >= 2 && split === 0) split = triCount   // start boundary of ext2
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
        return { buf, split, extruders: usedExtruders.size, offX: offX3, offZ: offZ3 }
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

  useEffect(() => () => { if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null } }, [])

  // Warmup: right after mount, create the worker and load the kernel (3.4MB parse, wasm compile, mt pthread pool) ahead of time.
  //  It finishes while the user picks and arranges models, so the first slice click no longer feels like a load.
  useEffect(() => { try { getWorker().postMessage({ cmd: 'warmup' }) } catch { /* a load failure is reported properly on the first slice */ } }, [])

  // Refresh the bed grid from the value derived from settings (printable_area)
  const kp = deriveKernelParams(settings)
  useEffect(() => { apiRef.current?.setPlates(plateCount, kp.bed_width, kp.bed_depth, selectedPlate) }, [kp.bed_width, kp.bed_depth, plateCount, selectedPlate])

  // S2: Prepare|Preview modes — group visibility + interaction gating
  useEffect(() => {
    canvasModeRef.current = canvasMode
    const t = three.current; if (!t.toolpathGroup) return
    const preview = canvasMode === 'preview'
    t.toolpathGroup.visible = preview
    if (t.objectsGroup) t.objectsGroup.visible = !preview && objectsRef.current.length > 0
    if (preview) {                                   // Preview: force gizmo/painting off
      apiRef.current?.detachTransform()
      if (paintModeRef.current !== 'off') setPaintMode('off')
    }
  }, [canvasMode])

  // ---- Toolpath build (stage 24: upstream libvgcode GPU instancing / all plates rendered at once) ----
  function disposePlateToolpath(idx) {
    const e = plateTpRef.current[idx]
    if (!e) return
    e.group.remove(e.ctl.mesh); e.group.remove(e.ctl.travLines); e.ctl.dispose()
    three.current.toolpathGroup?.remove(e.group)
    delete plateTpRef.current[idx]
    if (toolpathRef.current === e.ctl) { toolpathRef.current = null; segDataRef.current = null }
  }
  function clearToolpaths() {
    for (const k of Object.keys(plateTpRef.current)) disposePlateToolpath(Number(k))
    toolpathRef.current = null; segDataRef.current = null
  }
  // (Re)builds the real toolpath for plate idx — the subgroup carries its own offset, so it shows alongside other plates.
  function buildPlateToolpath(idx, layers) {
    const { toolpathGroup } = three.current
    if (!toolpathGroup) return null
    disposePlateToolpath(idx)
    if (!layers || !layers.length) return null
    const seg = buildSegmentData(layers, lineWidthRef.current)
    if (import.meta.env?.DEV && seg.hasNaN) console.error('[toolpath] non-finite vertex data')   // dev regression detection
    const ctl = makeToolpath(THREE, seg)
    const off = plateOffsetsRef.current[idx] || { offX: 0, offZ: 0 }
    const group = new THREE.Group()
    group.rotation.x = -Math.PI / 2
    group.position.set(off.offX || 0, 0, off.offZ || 0)
    group.add(ctl.mesh); group.add(ctl.travLines)
    toolpathGroup.add(group)
    ctl.setTravelVisible(showTravelRef.current)
    ctl.setLayerRange(0, Math.max(0, layers.length - 1))            // unfocused default: full range
    const cc = computeColors(seg, viewTypeRef.current, viewCtx())   // apply the current view type colors
    ctl.setColors(cc.color)
    const entry = { group, ctl, seg, layers }   // layers = source reference (used to detect a re-slice)
    plateTpRef.current[idx] = entry
    return entry
  }
  // Ensures a real toolpath exists for every cached plate result — so all plates can be inspected after slice-all.
  //  If the source layer reference changed (re-slice), the stale object is rebuilt.
  function ensurePlateToolpaths() {
    for (const [k, r] of Object.entries(plateResultsRef.current)) {
      const idx = Number(k)
      if (!r || r.error || !r.layers || !r.layers.length) continue
      const e = plateTpRef.current[idx]
      if (!e || e.layers !== r.layers) buildPlateToolpath(idx, r.layers)
    }
  }
  // The CPU builds no geometry — buildSegmentData only prepares the texture stream -> makeToolpath creates the instanced mesh.
  //  Even 1.77M+ segments render in one go with O(1) geometry (a 24-vertex template) + O(n) textures (no chunking or fallback needed).
  // Stage 25: context for view-type coloring — speed/fan/temperature are absent from the kernel toolpath and derived from settings (kernel unchanged).
  //  Type -> feature speed mapping (same as the desktop settings for outer wall, infill, …). Schema values are read directly via settingRaw.
  function viewCtx() {
    const S = (k, def) => { const v = settingRaw(settings, k); const n = parseFloat(v); return Number.isFinite(n) ? n : def }
    const ow = S('outer_wall_speed', 60)
    return {
      speedByType: {
        1: ow, 2: S('sparse_infill_speed', 40), 3: S('internal_solid_infill_speed', 45),
        4: ow, 5: S('support_speed', 35), 6: S('support_speed', 35), 7: S('gap_infill_speed', 30),
        8: ow, 9: S('bridge_speed', 25), 10: S('ironing_speed', 20), 11: ow,
      },
      firstLayerSpeed: S('initial_layer_speed', 30),
      closeFanLayers: S('close_fan_the_first_x_layers', 1),
      fanNormal: S('fan_max_speed', 100),
      tempNormal: S('nozzle_temperature', 210),
      tempFirst: S('nozzle_temperature_initial_layer', S('nozzle_temperature', 210)),
    }
  }
  // Recomputes the color texture for the current view type — applied to every plate; legend/range follow the focused plate.
  function applyViewColors() {
    const ctx = viewCtx()
    for (const e of Object.values(plateTpRef.current)) {
      const cc = computeColors(e.seg, viewTypeRef.current, ctx)
      e.ctl.setColors(cc.color)
      if (e.ctl === toolpathRef.current)
        setColorRange({ min: cc.min, max: cc.max, label: cc.label, unit: cc.unit, cont: cc.cont })
    }
  }
  // Rebuilds the focused plate's (selectedPlateRef) toolpath and refreshes aliases/stats. Other plates' objects are kept.
  function rebuildToolpaths() {
    const idx = selectedPlateRef.current
    const data = layersDataRef.current || []
    if (!data.length) {
      disposePlateToolpath(idx)
      setSegCount(0); toolpathRef.current = null; segDataRef.current = null
      return
    }
    const entry = buildPlateToolpath(idx, data)
    if (!entry) { setSegCount(0); return }
    toolpathRef.current = entry.ctl
    segDataRef.current = entry.seg
    entry.ctl.setLayerRange(layerLoRef.current, layerHiRef.current)
    applyViewColors()
    setSegCount(entry.seg.nSeg)
    setRoleLegend(roleRatios(entry.seg.typeLengths))   // S6.3: share per role
  }
  function applyLayerRange() { toolpathRef.current?.setLayerRange(layerLoRef.current, layerHiRef.current) }

  // ---- Progress: time-weighted mapping + real support progress (SAB polling) ----
  //  Measured time share per phase (774k tri): PASS1 7% · surfaces 6% · support 48% · emission 38% -> budget 15/5/40/40.
  const supSabRef = useRef(null)     // { arr: Uint32Array(SAB, ptr, 1) } — shared once by the mt worker
  const supPollRef = useRef(0)
  const stopSupPoll = () => { if (supPollRef.current) { clearInterval(supPollRef.current); supPollRef.current = 0 } }
  // G002: cancel an in-flight slice — written straight into the SAB flag (the kernel loop observes it even while the worker is blocked in wasm)
  const cancelSlice = () => { const sab = supSabRef.current; console.info('[vp-cancel] cancelSlice, hasView=', !!sab?.cancel); if (sab?.cancel) { try { Atomics.store(sab.cancel, 0, 1) } catch { sab.cancel[0] = 1 } } }
  const mapProgress = (done, total) => {
    const N = total > 2 ? (total - 2) / 2 : 0
    if (!N) return total ? done / total : 0
    if (done <= N) return 0.35 * (done / N)          // PASS1: 0 -> 35% (measured 2.8s/7.8s — real progress via SAB polling)
    if (done === N + 1) return 0.36                  // surfaces done -> entering support
    if (done === N + 2) return 0.87                  // support done (measured 4.0s)
    return 0.87 + 0.13 * ((done - N - 2) / N)        // emission: 87 -> 100% (measured 1.1s)
  }
  const startSupPoll = (N) => {
    const sab = supSabRef.current; if (!sab) return
    stopSupPoll()
    // Total work ≈ 3.5xN (measurement-corrected constant) — capped at 95%, then snapped on the completion tick
    supPollRef.current = setInterval(() => {
      const ticks = sab.arr[0]
      setProgress(0.36 + 0.51 * Math.min(0.95, ticks / (3.5 * N)))
    }, 150)
  }
  // Real PASS1 progress (0 -> 35%): the kernel writes per-mille (0..1000) into the SAB counter — starts right after the slice is sent, ends on the first progress message
  const startP1Poll = () => {
    const sab = supSabRef.current; if (!sab) return
    stopSupPoll()
    supPollRef.current = setInterval(() => {
      setProgress(0.35 * Math.min(1, sab.arr[0] / 1000))
    }, 150)
  }
  function getWorker() {
    if (!workerRef.current) {
      const wk = makeSlicerWorker()   // the static worker pattern is isolated in make_worker.js (shipped unbundled, verbatim)
      wk.onmessage = (e) => {
        const d = e.data
        const pnd = pendingSliceRef.current
        if (d.type === 'progress') {   // stage 30: reset the watchdog (+record the phase) + weighted mapping + per-band polling control
          const N = d.total > 2 ? (d.total - 2) / 2 : 0
          if (N && d.done <= N) stopSupPoll()          // first progress = PASS1 done -> stop P1 polling
          if (N && d.done === N + 1) startSupPoll(N)
          if (N && d.done >= N + 2) stopSupPoll()
          setProgress(mapProgress(d.done, d.total)); pnd?.note?.(d.done, d.total); pnd?.kick?.()
        }
        else if (d.type === 'supsab') { try { supSabRef.current = { arr: new Uint32Array(d.buf, d.ptr, 1), cancel: d.cancelPtr ? new Uint32Array(d.buf, d.cancelPtr, 1) : null }; console.info('[vp-cancel] supsab cancelPtr=', d.cancelPtr) } catch (e) { console.info('[vp-cancel] supsab view fail', e) } }
        else if (d.type === 'layer') {   // stage-30 streaming: receive each layer immediately (transfer) -> accumulate, reset the watchdog
          pnd?.kick?.()
          const a = streamAccumRef.current
          if (a) { a.layers.push({ z: d.z, paths: d.paths, widths: d.widths }); if (d.gcode) a.gcode.push(d.gcode) }
        }
        else if (d.type === 'done') { stopSupPoll(); if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.resolve(assembleResult(d.result)) } else { handleResult(assembleResult(d.result)); setSlicing(false) } }
        else if (d.type === 'error') { stopSupPoll(); if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.reject(new Error(d.error)) } else { setError('Slice failed: ' + d.error); setSlicing(false) } }
        else if (d.type === 'prepared') { /* selector mesh registered */ }
        else if (d.type === 'painted') { setPaintCounts({ enf: d.enf, blk: d.blk }); wk.postMessage({ cmd: 'overlay' }) }
        else if (d.type === 'overlay') { rebuildPaintOverlay(d.enf, d.blk) }
      }
      // Stage-30 OOM detection: worker error/messageerror -> reject the in-flight slice (the ladder decides on an economy retry).
      // Late errors from an already-discarded worker are ignored. An emscripten abort raises an error event per pthread, so
      //  the same worker fires onerror several times — the first rejected the pending slice and swapped the worker, and
      //  the rest used to overwrite the banner via setError, leaving a failure message even when the ladder succeeded.
      const killPending = (msg) => {
        if (workerRef.current !== wk) return
        stopSupPoll(); supSabRef.current = null
        const pnd = pendingSliceRef.current
        if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); try { wk.terminate() } catch {} workerRef.current = null; pnd.reject(new Error(msg)) }
        else { setError(msg); setSlicing(false) }
      }
      wk.onerror = (ev) => killPending('Worker terminated (likely out of memory): ' + (ev.message || 'worker error'))
      wk.onmessageerror = () => killPending('Worker message error (structured clone failed)')
      workerRef.current = wk
      if (typeof window !== 'undefined') window.__vpWorker = wk   // dev/test aid: drive selector cmds directly
    }
    return workerRef.current
  }
  // Stage 30: assemble the streamed result — when streamed, g-code/layers already arrived as 'layer', so they are built from the accumulator.
  //  batch/MM keep gcode+layers in result as before. Economy mode yields an empty layers array (no toolpath) and g-code only.
  function assembleResult(result) {
    if (result && result.stats && result.stats.streamed) {
      const a = streamAccumRef.current || { layers: [], gcode: [] }
      return { stats: result.stats, layers: a.layers, gcode: a.gcode.join('') }
    }
    return result
  }
  function handleResult(result) {
    if (result.error) { setError(String(result.error)); return }
    layersDataRef.current = result.layers
    const n = result.layers.length
    layerLoRef.current = 0; layerHiRef.current = n - 1; setLayerLo(0); setLayerHi(n - 1)   // dual slider covers the full range
    rebuildToolpaths()
    apiRef.current?.onSliced()
    setCanvasMode('preview')   // S2: switch to Preview automatically once slicing finishes
    setStats({ layers: result.stats.layers, segments: result.stats.path_segments, filament: result.stats.filament_mm, timeSec: result.stats.time_estimate })
    setOverBed(!!result.stats.over_bed)
    setLayerCount(n)
    setGcodeUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(new Blob([result.gcode], { type: 'text/plain' })) })
  }

  // ---- Stage 26: model loading (STL/OBJ/3MF/AMF/PLY, cumulative) — shared by the file picker and drag-and-drop ----
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

  // ---- Stage 20: manual support painting (enforcer/blocker) ----
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

  // ---- Slicing (derived from the right panel settings) — per plate (stage 29-2) + streaming/watchdog/OOM ladder (stage 30) ----
  const WATCHDOG_MS = 60000   // stage-30 hang watchdog: no progress/layer news for 60s -> declared dead
  const SILENT_STAGE_MS = 300000   // surface/support window (around 50% progress): the kernel is structurally silent — minutes are normal on large models. A relaxed limit to avoid false positives.
  function sliceOne(buf, paramsStr) {
    return new Promise((resolve, reject) => {
      // dev/test hooks (not set in production): __vpFail(n)=force a failure (ladder verification) · __vpStallNext=unresponsive worker (watchdog) · __vpWatchdogOnce=short watchdog (ms).
      if (typeof window !== 'undefined' && window.__vpFail && window.__vpFail(window.__vpSliceN = (window.__vpSliceN || 0) + 1)) { reject(new Error('forced failure (test hook)')); return }
      const stall = (typeof window !== 'undefined' && window.__vpStallNext) ? (window.__vpStallNext = false, true) : false
      const wdMs = (typeof window !== 'undefined' && window.__vpWatchdogOnce) ? ((v) => (window.__vpWatchdogOnce = 0, v))(window.__vpWatchdogOnce) : WATCHDOG_MS
      streamAccumRef.current = { layers: [], gcode: [] }   // reset the streaming accumulator (layers arrive one by one)
      let t = 0
      let lastD = 0, lastT = 0
      const __ts = performance.now(); let __stage = ''   // [vp-prof] phase arrival timestamps (temporary)
      const note = (done, total) => {
        lastD = done; lastT = total
        const N = total > 2 ? (total - 2) / 2 : 0
        const st = !N ? '' : done < N ? 'PASS1…' : done === N ? 'PASS1-done' : done === N + 1 ? 'surf-done' : done === N + 2 ? 'support-done' : done === total ? 'emit-done' : 'emit…'
        if (st && st !== __stage) { console.info(`[vp-prof] ${st} +${((performance.now() - __ts) / 1000).toFixed(1)}s`); __stage = st }
      }
      // If the last progress was inside the surface/support window (d ∈ [N, N+2), N=(t−2)/2), use the relaxed limit — silence is normal there, so
      //  the 60s watchdog would kill a healthy slice (measured: 774k tri support takes 19s+, and over 60s on slow or loaded machines).
      const curWd = () => {
        const N = lastT > 2 ? (lastT - 2) / 2 : 0
        return (N && lastD >= N && lastD < N + 2) ? SILENT_STAGE_MS : wdMs
      }
      const stop = () => { if (t) { clearTimeout(t); t = 0 } }
      const kick = () => { stop(); const ms = curWd(); t = setTimeout(() => {
        pendingSliceRef.current = null
        stopSupPoll(); supSabRef.current = null   // worker gone -> drop the SAB polling/reference
        try { workerRef.current?.terminate() } catch {} ; workerRef.current = null   // force-terminate the stalled worker
        reject(new Error(`watchdog: no progress for ${ms}ms — assuming memory pressure`))
      }, ms) }
      pendingSliceRef.current = { resolve, reject, kick, stop, note }
      kick()
      getWorker().postMessage({ stl: buf, params: paramsStr, stall })
      startP1Poll()   // real PASS1 progress (0 -> 35%) — a no-op when SAB is unsupported (st)
    })
  }
  function recreateWorker() { try { workerRef.current?.terminate() } catch {} ; workerRef.current = null; getWorker() }
  // OOM retry ladder: (1) normal (streaming) -> on failure (error/abort/watchdog) (2) recreate the worker + retry with **classic walls**
  //  -> (3) recreate the worker + finish in economy mode (no toolpaths or time estimate, g-code only). If everything fails it throws -> the caller
  //  offers a downgrade (simplified) retry. Partial g-code is never handed out.
  //
  // Why (2) exists (measured): Arachne wall generation builds a Voronoi diagram, and meshes like CAD tessellations (STEP/OCCT) — whose
  //  vertices are unwelded and which contain sliver triangles — produce degenerate cells in the sliced polygons, killing the worker with
  //  "memory access out of bounds" (an assert at Voronoi.cpp:334 in upstream debug builds).
  //  The same model finishes fine with wall_generator=classic -> this rung comes before economy mode
  //  (economy only reduces infill, which does nothing for an Arachne crash).
  async function sliceLadder(buf, params) {
    const isCancel = (e) => String(e?.message || e).includes('canceled')
    try { const r = await sliceOne(buf, JSON.stringify(params)); return { r, economy: !!(r.stats && r.stats.economy) } }
    catch (e1) {
      if (isCancel(e1)) throw e1   // G002: cancellation propagates without retrying
      if (params.wall_generator !== 'classic') {
        recreateWorker()
        try {
          const r = await sliceOne(buf, JSON.stringify({ ...params, wall_generator: 'classic', keep_stages: false, reuse_stages: 0 }))
          return { r, economy: !!(r.stats && r.stats.economy), classicWalls: true }
        } catch (e2) { if (isCancel(e2)) throw e2 }
      }
      recreateWorker()
      // Economy retry: do not keep the stage cache (minimize the heap) and disable reuse (a new worker has no cache anyway)
      const r = await sliceOne(buf, JSON.stringify({ ...params, economy: true, keep_stages: false, reuse_stages: 0 }))   // a failure propagates as a throw
      return { r, economy: true, recovered: true }
    }
  }
  // G003 incremental: geometry digest (SHA-256, native — 37MB ≈ 0.1s). When it matches the last successful slice,
  //  the kernel stage cache is reused (reuse_stages=2) — if a parameter affects layers, the kernel's layerKey is the second line of defense.
  async function geomDigest(buf) {
    try { const d = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(d, 0, 8)).map(b => b.toString(16).padStart(2, '0')).join('') }
    catch { return null }   // non-secure context and friends — incremental disabled (always a full slice)
  }
  function applyIncremental(params, dig) {
    if (params.economy) return   // economy mode: keeping the cache adds heap pressure — no incremental
    params.keep_stages = true
    params.reuse_stages = dig && dig === lastGeomRef.current ? 2 : 0
  }
  function buildParams(merged) {
    const params = deriveKernelParams(settings)
    if (merged.extruders >= 2 && merged.split > 0) { params.extruder_count = merged.extruders; params.mm_group_split = merged.split; params.wipe_tower_real = wipeTowerReal }
    if (downgradeRef.current) { params.sparse_infill_pattern = 'rectilinear'; params.infill_density = Math.min(params.infill_density ?? 0.15, 0.08); params.economy = true }  // downgrade retry
    if (typeof window !== 'undefined' && window.__vpForceTree) { params.enable_support = true; params.support_style = 'tree'; params.support_threshold_angle = 40 }  // stage-31 test hook: force tree support (not set in production)
    return params
  }
  // Shows a cached result in Preview — every cached plate's toolpath renders at its own offset simultaneously,
  //  and idx becomes the focus (target of the slider/stats/G-code). Focusing a plate with no cache = empty state (leftovers cleared).
  function showPlateResult(idx) {
    ensurePlateToolpaths()                                   // all plates viewable at once
    const prev = toolpathRef.current
    if (prev) prev.setLayerRange(0, 1e9)                     // the previous focus goes back to its full range
    const r = plateResultsRef.current[idx]
    if (!r || r.error || !r.layers || !r.layers.length) {    // plate without a result: clear the focus UI
      layersDataRef.current = null; toolpathRef.current = null; segDataRef.current = null
      setStats(null); setOverBed(false); setLayerCount(0); setSegCount(0); setColorRange(null); setRoleLegend([])
      setGcodeUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return '' })
      return
    }
    layersDataRef.current = r.layers
    const n = r.layers.length
    layerLoRef.current = 0; layerHiRef.current = n - 1; setLayerLo(0); setLayerHi(n - 1)
    const cached = plateTpRef.current[idx]
    const entry = (cached && cached.layers === r.layers) ? cached : buildPlateToolpath(idx, r.layers)
    if (entry) {
      toolpathRef.current = entry.ctl; segDataRef.current = entry.seg
      entry.ctl.setLayerRange(0, n - 1)
      applyViewColors()
      setSegCount(entry.seg.nSeg); setRoleLegend(roleRatios(entry.seg.typeLengths))
    }
    apiRef.current?.onSliced()
    setCanvasMode('preview')
    setStats({ layers: r.stats.layers, segments: r.stats.path_segments, filament: r.stats.filament_mm, timeSec: r.stats.time_estimate })
    setOverBed(!!r.stats.over_bed); setLayerCount(n)
    setGcodeUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return URL.createObjectURL(new Blob([r.gcode], { type: 'text/plain' })) })
  }
  function downloadGcode(gcode, name) { const url = URL.createObjectURL(new Blob([gcode], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(url) }, 4000) }
  const _sleep = (ms) => new Promise(r => setTimeout(r, ms))
  // plateResultsRef is a ref, so the UI does not refresh on its own — mirror the count into state wherever it changes.
  function refreshSlicedCount() {
    setSlicedPlateCount(Object.values(plateResultsRef.current).filter(r => r && !r.error && r.gcode).length)
  }
  // Saves the G-code of every sliced plate at once — only when the user explicitly asks (never automatically).
  //  Browsers throttle back-to-back downloads, so the files are spaced out.
  async function exportAllGcode() {
    setSliceMenu(false)
    const done = Object.entries(plateResultsRef.current)
      .filter(([, r]) => r && !r.error && r.gcode)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
    if (!done.length) { setError('No slice results to export — slice first'); return }
    for (const [i, r] of done) { downloadGcode(r.gcode, `plate_${Number(i) + 1}.gcode`); await _sleep(350) }
    setSliceNotice(`Exported G-code for ${done.length} plate(s)`)
  }
  async function onSlice(scope = 'current') {
    setSliceMenu(false); setError(''); setSliceNotice(''); setDowngradeOffer(null)
    const idx0 = selectedPlateRef.current
    lineWidthRef.current = deriveKernelParams(settings).line_width
    if (scope === 'all') {
      setSlicing(true); setProgress(0)
      let sliced = 0, anyEconomy = false, anyClassic = false; const failed = []
      for (let i = 0; i < plateCountRef.current; i++) {
        const merged = apiRef.current?.buildMergedSTL(i); if (!merged) continue
        plateOffsetsRef.current[i] = { offX: merged.offX, offZ: merged.offZ }
        try {
          const params = buildParams(merged)
          const dig = await geomDigest(merged.buf); applyIncremental(params, dig)
          const { r, economy, classicWalls } = await sliceLadder(merged.buf, params)   // on a normal failure: classic walls -> economy retry
          lastGeomRef.current = (economy || classicWalls) ? null : dig   // finishing via economy/classic used different parameters, so the cache cannot be reused
          plateResultsRef.current[i] = r; refreshSlicedCount(); sliced++   // no automatic download — switch tabs to inspect, save via an explicit export
          if (economy) anyEconomy = true
          if (classicWalls) anyClassic = true
        } catch (e) { lastGeomRef.current = null; failed.push(i + 1) }   // E1: even on failure, g-code from plates that already finished is preserved and available
      }
      setSlicing(false)
      if (!sliced) { setDowngradeOffer({ scope: 'all' }); setError('All plates failed to slice (economy mode included) — try the simplified retry'); return }
      if (failed.length) setError(`Plate ${failed.join(', ')} failed — the ${sliced} finished result(s) are kept (inspect/export from the tabs)`)
      else { setError(''); setDowngradeOffer(null) }
      if (anyEconomy) setSliceNotice('Memory pressure — some plates finished in economy mode (no preview, G-code is fine)')
      else if (anyClassic) setSliceNotice('Arachne wall generation failed (degenerate geometry) — finished with classic walls (G-code is fine)')
      showPlateResult(plateResultsRef.current[idx0] ? idx0 : Object.keys(plateResultsRef.current).map(Number)[0])
    } else {
      const __tm0 = performance.now()   // [vp-prof] preprocessing timing (temporary)
      const merged = apiRef.current?.buildMergedSTL(idx0)
      if (!merged) { setError(`Plate ${idx0 + 1} has no objects`); return }
      console.info(`[vp-prof] buildMergedSTL ${(performance.now() - __tm0).toFixed(0)}ms (${(merged.buf.byteLength / 1048576).toFixed(1)}MB)`)
      plateOffsetsRef.current[idx0] = { offX: merged.offX, offZ: merged.offZ }
      setSlicing(true); setProgress(0)
      try {
        const params = buildParams(merged)
        const dig = await geomDigest(merged.buf); applyIncremental(params, dig)
        const { r, economy, classicWalls } = await sliceLadder(merged.buf, params)
        lastGeomRef.current = (economy || classicWalls) ? null : dig
        if (r?.stats) console.info(`[vp-prof] kernel stages p1=${(r.stats.t_pass1_ms/1000).toFixed(1)}s surf=${(r.stats.t_surface_ms/1000).toFixed(1)}s sup=${(r.stats.t_support_ms/1000).toFixed(1)}s emit=${(r.stats.t_emit_ms/1000).toFixed(1)}s reuse=${params.reuse_stages}`)
        plateResultsRef.current[idx0] = r; refreshSlicedCount(); setSlicing(false); showPlateResult(idx0)
        setError(''); setDowngradeOffer(null)   // a lower rung of the ladder succeeded — do not leave the failed first attempt's banner up
        if (economy) setSliceNotice('Memory pressure — finished in economy mode (no preview, G-code can still be downloaded)')
        else if (classicWalls) setSliceNotice('Arachne wall generation failed (degenerate geometry) — finished with classic walls (G-code is fine)')
      } catch (e) {
        setSlicing(false); lastGeomRef.current = null
        if (String(e?.message || e).includes('canceled')) { setSliceNotice('Slice canceled'); return }
        setDowngradeOffer({ scope: 'current' }); setError('Slice failed (economy mode failed too): ' + e.message)
      }
    }
  }
  // G004: auto re-slice — 0.8s debounce after a settings change. Only for the current plate when it has been sliced before;
  //  if a slice is running it is canceled (G002) and the re-slice waits for it to finish. Thanks to incremental slicing (G003) it usually just re-runs emit (~1s).
  useEffect(() => {
    if (!autoSlice || !objects.length) return
    if (!plateResultsRef.current[selectedPlateRef.current]) return   // the first slice stays manual
    clearTimeout(autoTimerRef.current)
    const fire = () => {
      if (pendingSliceRef.current) { cancelSlice(); autoTimerRef.current = setTimeout(fire, 300); return }
      onSlice('current')
    }
    autoTimerRef.current = setTimeout(fire, 800)
    return () => clearTimeout(autoTimerRef.current)
  }, [settings, autoSlice])   // eslint-disable-line react-hooks/exhaustive-deps
  // Downgrade retry: simplify the infill pattern (rectilinear) + lower density + economy mode, run again (user's choice). buildParams applies it.
  async function retryDowngrade() {
    const off = downgradeOffer; setDowngradeOffer(null); if (!off) return
    downgradeRef.current = true
    try { await onSlice(off.scope) } finally { downgradeRef.current = false }
  }
  // Add/remove/select plates
  function addPlate() { setPlateCount(n => Math.min(MAX_PLATES, n + 1)) }
  function deletePlate() {
    setPlateCount(n => { if (n <= 1) return n; const last = n - 1; delete plateResultsRef.current[last]; disposePlateToolpath(last); refreshSlicedCount(); if (selectedPlateRef.current >= last) selectPlate(last - 1); return last })
  }
  function selectPlate(i) {
    selectedPlateRef.current = i; setSelectedPlate(i); placeXRef.current = 0
    if (canvasMode === 'preview') showPlateResult(i)   // switching plates in Preview -> show that plate's cached result
  }
  // Editing bed width x depth on the printer card — reduced to a printable_area rectangle (origin preserved). Circular/custom shapes belong to the panel editor.
  function setBedSize(w, d) {
    if (!(w > 0) || !(d > 0)) return
    const pa = settingRaw(settings, 'printable_area')
    const ok = Array.isArray(pa) && pa.length >= 3
    const x0 = ok ? Math.min(...pa.map(p => p[0])) : 0, y0 = ok ? Math.min(...pa.map(p => p[1])) : 0
    setSettings(s => ({ ...s, printable_area: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]] }))
  }
  function setObjExtruder(id, e) { apiRef.current?.setObjectExtruder(id, e); setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false }))) }

  // Stage 25 S6: dual slider (lo/hi) — in single-layer mode both thumbs move together.
  function setRange(lo, hi) {
    const max = Math.max(0, layerCount - 1)
    lo = Math.max(0, Math.min(max, lo)); hi = Math.max(0, Math.min(max, hi))
    if (lo > hi) { const t = lo; lo = hi; hi = t }
    layerLoRef.current = lo; layerHiRef.current = hi; setLayerLo(lo); setLayerHi(hi); applyLayerRange()
  }
  function onLo(e) { const v = parseInt(e.target.value, 10); if (singleLayer) setRange(v, v); else setRange(v, layerHiRef.current) }
  function onHi(e) { const v = parseInt(e.target.value, 10); if (singleLayer) setRange(v, v); else setRange(layerLoRef.current, v) }
  function toggleSingle() {
    const next = !singleLayer; setSingleLayer(next)
    if (next) setRange(layerHiRef.current, layerHiRef.current)   // single layer = the upper-bound layer only
  }
  function onViewType(e) { const v = e.target.value; setViewType(v); viewTypeRef.current = v; applyViewColors() }
  function onToggleTravel(e) { const v = e.target.checked; setShowTravel(v); showTravelRef.current = v; for (const p of Object.values(plateTpRef.current)) p.ctl.setTravelVisible(v) }
  function onToggleSupport(e) { const v = e.target.checked; setSettings(s => ({ ...s, enable_support: v })) }
  const supportOn = !!settingRaw(settings, 'enable_support')
  // Stage 27 S4: filament colors/count + per-object print toggle + painting gizmo mode
  function refreshObjects() { setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false }))) }
  function setExtColor(i, hex) { setExtruderColors(cs => { const n = [...cs]; n[i] = hex; extruderColorsRef.current = n; apiRef.current?.recolorObjects(); return n }) }
  function addFilament() { setExtruderColors(cs => { if (cs.length >= 4) return cs; const pal = ['#e0473b', '#3bb0e0', '#7ad14a']; const n = [...cs, pal[cs.length - 1] || '#888888']; extruderColorsRef.current = n; return n }) }
  function removeFilament() {
    setExtruderColors(cs => {
      if (cs.length <= 1) return cs
      const n = cs.slice(0, -1); extruderColorsRef.current = n
      objectsRef.current.forEach(o => { if ((o.extruder || 1) > n.length) apiRef.current?.setObjectExtruder(o.id, n.length) })
      apiRef.current?.recolorObjects(); refreshObjects(); return n
    })
  }
  function toggleObjVisible(id) { const o = objectsRef.current.find(x => x.id === id); apiRef.current?.setObjectVisible(id, !(o?.visible !== false)); refreshObjects() }
  function togglePaintGizmo() { setPaintMode(paintMode === 'off' ? 'enforcer' : 'off') }

  // ---- Object toolbar definition ----
  //  Follows the upstream toolbar (GLToolbar) layout. Entries without run render as disabled, and the tooltip says what it is and why it is unavailable.
  //  When adding buttons, edit this array instead of duplicating JSX.
  const OBJECT_TOOLS = [
    { id: 'add', icon: addIcon, label: 'Add', tip: 'Add a model file to the current plate (existing objects are kept)', run: () => fileInputRef.current?.click() },
    { id: 'delete', icon: deleteIcon, label: 'Delete', tip: 'Delete the selected object (Del)', run: deleteSelected },
    { id: 'delete-all', icon: deleteallIcon, label: 'Delete all', tip: 'Delete every object on the plate', run: deleteAllObjects, disabled: () => objects.length === 0 },
    { sep: true },
    { id: 'duplicate', icon: duplicateIcon, label: 'Duplicate', tip: 'Duplicate the selected object (Ctrl+K)', run: duplicateSelected },
    { id: 'split', icon: splitIcon, label: 'Split', tip: 'Split to objects — every disconnected part (connected component) becomes its own object. Split to parts is not implemented (no part concept)', run: splitSelected },
    { id: 'onbed', icon: onbedIcon, label: 'Place on bed', tip: 'Drop every object onto the bed (Z=0) — to re-seat after lifting with the gizmo', run: () => apiRef.current?.placeOnBed() },
    { sep: true },
    { id: 'arrange', icon: arrangeIcon, label: 'Arrange', tip: 'Auto arrange — lay objects out on the bed without overlap. Not implemented (needs the libslic3r Arrange port)' },
    { id: 'orient', icon: orientIcon, label: 'Orient', tip: 'Auto orient — rotate to the orientation needing the least support. Not implemented (needs the libslic3r Orient port)' },
    { sep: true },
    { id: 'cut', icon: cutIcon, label: 'Cut', tip: 'Cut — slice the model with a plane into two pieces. Not implemented (needs cut-surface re-stitching)' },
    { id: 'boolean', icon: booleanIcon, label: 'Boolean', tip: 'Mesh boolean — union/difference/intersection of two objects. Not implemented (needs the CGAL boolean port)' },
    { id: 'negative', icon: negativeIcon, label: 'Negative part', tip: 'Add a negative/modifier part — put a part with different properties inside one object. Not implemented (no part concept)' },
    { sep: true },
    { id: 'seam', icon: seamIcon, label: 'Seam painting', tip: 'Seam painting — brush where the layer seam goes. Not implemented (needs kernel seam wiring)' },
    { id: 'mmu', icon: mmuIcon, label: 'Color painting', tip: 'Color painting — assign multi-material colors per facet. Not implemented (needs the MMU paint codec wiring)' },
    { id: 'text', icon: textmarkIcon, label: 'Text', tip: 'Text/SVG emboss — engrave letters or shapes onto the model surface. Not implemented (needs font rasterization)' },
    { id: 'measure', icon: measureIcon, label: 'Measure', tip: 'Measure — distance and angle between two points or faces. Not implemented' },
    { id: 'varlayer', icon: varlayerIcon, label: 'Variable layers', tip: 'Variable layer height — different layer heights per band. Not implemented (the kernel has no variable z)' },
  ]

  // ---- Keyboard shortcuts (upstream SPECS §4 + PrusaSlicer/Cura conventions) ----
  //  Which keys are live depends on Prepare/Preview. All are ignored while an input widget has focus.
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

  keyRef.current = (e) => {
    // Shadow DOM: at window level e.target is retargeted to the shadow host -> use composedPath to find the real target
    const t = e.composedPath ? e.composedPath()[0] : e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    const k = e.key, low = typeof k === 'string' ? k.toLowerCase() : ''
    const mod = e.ctrlKey || e.metaKey
    const preview = canvasModeRef.current === 'preview'
    const stop = () => { e.preventDefault(); e.stopPropagation() }

    if (mod) {                                            // ---- Ctrl/⌘ combinations (both modes) ----
      if (low === 'r') { stop(); if (!slicing) onSlice('current') }        // slice (upstream Ctrl+R)
      else if (low === 'c') { stop(); copySelected() }
      else if (low === 'v') { stop(); pasteClipboard() }
      else if (low === 'x') { stop(); copySelected(); deleteSelected() }
      else if (low === 'k' || low === 'd') { stop(); duplicateSelected() }  // Ctrl+K (upstream) / ⌘D (macOS convention)
      return
    }

    if (preview) {                                        // ---- Preview: layer inspection ----
      const step = e.shiftKey ? 10 : 1
      if (k === 'ArrowUp')        { stop(); const v = layerHiRef.current + step; singleLayer ? setRange(v, v) : setRange(layerLoRef.current, v) }
      else if (k === 'ArrowDown') { stop(); const v = layerHiRef.current - step; singleLayer ? setRange(v, v) : setRange(layerLoRef.current, v) }
      else if (low === 'l')       { stop(); toggleSingle() }
      else if (low === 't')       { stop(); onToggleTravel({ target: { checked: !showTravelRef.current } }) }
      else if (low === 'z')       { stop(); apiRef.current?.frame() }
      else if (low === 'b')       { stop(); apiRef.current?.frameBed() }
      else if (k === 'Escape')    { stop(); setCanvasMode('prepare') }
      return
    }

    // ---- Prepare: object manipulation ----
    if (low === 'm' || low === 'g') { stop(); setGizmo('translate') }       // M = upstream, G = Blender convention (kept)
    else if (low === 'r')           { stop(); setGizmo('rotate') }
    else if (low === 's')           { stop(); setGizmo('scale') }
    else if (low === 'z')           { stop(); apiRef.current?.frame() }
    else if (low === 'b')           { stop(); apiRef.current?.frameBed() }
    else if (k === 'Delete' || k === 'Backspace') { stop(); deleteSelected() }
    else if (k === 'Escape')        { stop(); if (paintModeRef.current !== 'off') setPaintMode('off'); apiRef.current?.detachTransform() }
    else if (k === 'PageUp')        { stop(); apiRef.current?.rotateSelectedY(Math.PI / 4) }
    else if (k === 'PageDown')      { stop(); apiRef.current?.rotateSelectedY(-Math.PI / 4) }
    else if (k.startsWith?.('Arrow')) {                                     // nudge: 10mm, Shift = 1mm (Prusa convention)
      stop(); const d = e.shiftKey ? 1 : 10
      apiRef.current?.nudgeSelected(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0,
                                    k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0)
    }
    else if (k === '?')             { stop(); setShowHelp(v => !v) }
  }
  const nozzleDia = kp.nozzle_diameter || settingRaw(settings, 'nozzle_diameter') || '0.4'
  three.current.invalidate?.()   // render on demand: invalidate one frame per React re-render (slider/toggle/state change)

  // Preview controls (view type + dual slider + legend) — placed in the sidebar
  const previewControls = layerCount > 0 && (
    <div className="slice-layer" data-testid="preview-controls">
      <label className="view-type-row">View type
        <select value={viewType} onChange={onViewType} data-testid="view-type-select" title="What the toolpath colors represent — feature type, speed, layer height, width, fan, temperature">
          {VIEW_TYPES.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
      </label>
      <label>Layer <b data-testid="layer-range">{singleLayer ? (layerHi + 1) : `${layerLo + 1}..${layerHi + 1}`}</b> / {layerCount}
        <span className="muted"> ({segCount.toLocaleString()} segments)</span></label>
      <div className="dual-slider">
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerLo} onChange={onLo} data-testid="layer-lo" title="Lowest layer to show (also adjustable with ↓/↑)" />
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerHi} onChange={onHi} data-testid="layer-hi" title="Highest layer to show (↓/↑, hold Shift for steps of 10)" />
      </div>
      <div className="layer-ctl">
        <button className={singleLayer ? 'on' : ''} onClick={toggleSingle} data-testid="single-layer-btn" title="Show only the selected layer (L)">Single layer</button>
        <label className="slice-travel"><input type="checkbox" checked={showTravel} onChange={onToggleTravel} data-testid="travel-toggle" title="Show non-extruding moves as gray lines (T)" /> Travel</label>
      </div>
      {colorRange && colorRange.cont ? (
        <div className="grad-legend" data-testid="view-legend">
          <div className="grad-title">{colorRange.label} <span className="muted">{colorRange.unit}</span></div>
          <div className="grad-bar" data-testid="gradient-bar" style={{ background: `linear-gradient(to right, ${DEFAULT_RANGES_COLORS.map(c => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`).join(',')})` }} />
          <div className="grad-minmax"><span data-testid="grad-min">{colorRange.min.toFixed(colorRange.unit === 'mm' ? 2 : 0)}</span><span data-testid="grad-max">{colorRange.max.toFixed(colorRange.unit === 'mm' ? 2 : 0)}</span></div>
        </div>
      ) : (
        <div className="role-legend" data-testid="view-legend">
          {roleLegend.map(r => (
            <span key={r.type} className="role-item">
              <i style={{ background: `rgb(${Math.round(r.color[0] * 255)},${Math.round(r.color[1] * 255)},${Math.round(r.color[2] * 255)})` }} />
              {r.label} <b>{r.pct.toFixed(0)}%</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
  const statsBlock = stats && (
    <>
      <div><b>{stats.layers}</b> layers · <b>{stats.segments}</b> segments</div>
      <div>Filament <b>{stats.filament.toFixed(1)}</b> mm</div>
      {typeof stats.timeSec === 'number' && stats.timeSec > 0 && (() => {
        const s = Math.round(stats.timeSec)
        const t = `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`
        return <div data-testid="print-time">⏱ Estimated print <b>{t}</b></div>
      })()}
      {overBed && <div className="slice-warn" data-testid="over-bed">⚠ Model extends beyond the bed</div>}
    </>
  )

  // registerLoader() can add formats, so this is computed at render time.
  const EXT_LABEL = SUPPORTED_EXT.map(e => e.toUpperCase()).join(' · ')

  return (
    <ShadowHost css={shadowCss}>
    <div className="app-shell">
      {/* Shared hidden file input */}
      <input ref={fileInputRef} type="file" accept={SUPPORTED_EXT.map(e => '.' + e).join(',')} multiple onChange={onFiles} title={`${EXT_LABEL} (multiple files allowed)`} data-testid="stl-input" style={{ display: 'none' }} />

      {/* S1 top bar */}
      <header className="topbar">
        <div className="tb-left">
          <a href="/" className="tb-logo"><b>Three</b>Slicer <span className="tb-re">RE</span></a>
          <button className="tb-btn" onClick={() => fileInputRef.current?.click()} title="Open a model file — every existing object is cleared" data-testid="open-file"><img src={openIcon} alt="" /><span>Open</span></button>
        </div>
        {ok && (
          <div className="tb-tabs" role="tablist" aria-label="Canvas mode">
            <button role="tab" className={canvasMode === 'prepare' ? 'on' : ''} onClick={() => setCanvasMode('prepare')} data-testid="mode-prepare" title="Arrange, transform and paint supports">Prepare</button>
            <button role="tab" className={canvasMode === 'preview' ? 'on' : ''} onClick={() => setCanvasMode('preview')} disabled={layerCount === 0} data-testid="mode-preview" title="Preview the sliced toolpaths (enabled after slicing)">Preview</button>
          </div>
        )}
        <div className="tb-right">
          <button className="tb-icon" disabled title="Undo — not implemented (needs an action history stack)">↶</button>
          <button className="tb-icon" disabled title="Redo — not implemented (needs an action history stack)">↷</button>
        </div>
      </header>

      <div className="app-body">
        {/* S3 left gizmo toolbar */}
        {ok && canvasMode === 'prepare' && (
          <nav className="left-rail" role="toolbar" aria-label="Gizmo tools">
            <button className={gmode === 'translate' && paintMode === 'off' ? 'on' : ''} onClick={() => { setPaintMode('off'); apiRef.current?.setMode('translate') }} title="Move the object — drag a gizmo axis or use arrow keys for 10mm (Shift 1mm) (M/G)" data-testid="gizmo-move"><img src={moveIcon} alt="Move" /></button>
            <button className={gmode === 'rotate' && paintMode === 'off' ? 'on' : ''} onClick={() => { setPaintMode('off'); apiRef.current?.setMode('rotate') }} title="Rotate the object — PageUp/PageDown rotates in 45° steps (R)" data-testid="gizmo-rotate"><img src={rotateIcon} alt="Rotate" /></button>
            <button className={gmode === 'scale' && paintMode === 'off' ? 'on' : ''} onClick={() => { setPaintMode('off'); apiRef.current?.setMode('scale') }} title="Scale the object (S)" data-testid="gizmo-scale"><img src={scaleIcon} alt="Scale" /></button>
            <div className="rail-sep" />
            <button className={paintMode !== 'off' ? 'on' : ''} onClick={togglePaintGizmo} title="Brush facets to enforce or block support — the wheel changes the brush size" data-testid="gizmo-paint"><img src={paintIcon} alt="Support painting" /></button>
          </nav>
        )}

        {/* Center viewport */}
        <div className="viewport-col">
          <div className={(ok ? 'vp-canvas' : 'vp-canvas fail') + (dragOver ? ' drag-over' : '')} ref={mountRef}
            onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave} data-testid="drop-zone">
            {!ok && <div className="vp-fallback">⚠ {status}</div>}
            {ok && objects.length === 0 && canvasMode !== 'preview' && (
              <div className="empty-hint" data-testid="empty-hint">
                <div className="eh-icon">📦</div>
                <div className="eh-title">Drag in a file or pick one</div>
                <div className="eh-sub">{EXT_LABEL}</div>
                <button className="eh-btn" onClick={() => fileInputRef.current?.click()} data-testid="empty-pick" title={`Pick a ${EXT_LABEL} file (multiple allowed)`}>Choose file</button>
              </div>
            )}
            {dragOver && <div className="drop-overlay" data-testid="drop-overlay">Drop here (STL/OBJ/3MF/AMF/PLY)</div>}
            {ctxMenu && (
              <>
                <div className="ctx-scrim" onPointerDown={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null) }} />
                <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} data-testid="ctx-menu">
                  {ctxMenu.onObject ? (<>
                    <button onClick={() => { setCtxMenu(null); duplicateSelected() }} data-testid="ctx-duplicate" title="Duplicate the selected object at the same scale and rotation, placed beside it">Duplicate <span className="ctx-key">Ctrl+K</span></button>
                    <button onClick={() => { setCtxMenu(null); copySelected() }} data-testid="ctx-copy" title="Copy the selected object to the buffer (paste to add it)">Copy <span className="ctx-key">Ctrl+C</span></button>
                    <button onClick={() => { setCtxMenu(null); splitSelected() }} data-testid="ctx-split" title="Split to objects — every disconnected part (connected component) becomes its own object. Split to parts is not implemented (no part concept)">Split</button>
                    <button onClick={() => { setCtxMenu(null); apiRef.current?.placeOnBed() }} data-testid="ctx-seat" title="Drop every object onto the bed (Z=0)">Place on bed</button>
                    <hr />
                    <button className="danger" onClick={() => { setCtxMenu(null); deleteSelected() }} data-testid="ctx-delete" title="Remove the selected object from the scene">Delete <span className="ctx-key">Del</span></button>
                  </>) : (<>
                    <button onClick={() => { setCtxMenu(null); fileInputRef.current?.click() }} data-testid="ctx-open" title="Open a model file and add it to the current plate">Open model…</button>
                    <button disabled={!clipboardRef.current} onClick={() => { setCtxMenu(null); pasteClipboard() }} data-testid="ctx-paste" title="Add the copied object to the current plate">Paste <span className="ctx-key">Ctrl+V</span></button>
                    <hr />
                    <button onClick={() => { setCtxMenu(null); apiRef.current?.frame() }} data-testid="ctx-zoom-all" title="Fit the camera so every object is visible">Zoom all <span className="ctx-key">Z</span></button>
                    <button onClick={() => { setCtxMenu(null); apiRef.current?.frameBed() }} data-testid="ctx-zoom-bed" title="Fit the camera to the whole selected plate">Zoom bed <span className="ctx-key">B</span></button>
                  </>)}
                </div>
              </>
            )}
            {showHelp && (
              <div className="help-overlay" data-testid="help-overlay" onClick={() => setShowHelp(false)}>
                <div className="help-card" onClick={e => e.stopPropagation()}>
                  <h3>Shortcuts <span className="muted">(press ? to close)</span></h3>
                  <div className="help-cols">
                    <section>
                      <h4>Prepare</h4>
                      <dl>
                        <dt>M / G</dt><dd>Move</dd><dt>R</dt><dd>Rotate</dd><dt>S</dt><dd>Scale</dd>
                        <dt>Arrow keys</dt><dd>Move 10mm (Shift 1mm)</dd>
                        <dt>PageUp/Down</dt><dd>Rotate 45°</dd>
                        <dt>Del</dt><dd>Delete selection</dd><dt>Esc</dt><dd>Clear selection / leave paint</dd>
                      </dl>
                    </section>
                    <section>
                      <h4>Preview</h4>
                      <dl>
                        <dt>↑ / ↓</dt><dd>Layer (Shift steps of 10)</dd>
                        <dt>L</dt><dd>Single layer</dd><dt>T</dt><dd>Travel</dd>
                        <dt>Esc</dt><dd>Back to Prepare</dd>
                      </dl>
                    </section>
                    <section>
                      <h4>Common</h4>
                      <dl>
                        <dt>Ctrl+R</dt><dd>Slice</dd>
                        <dt>Ctrl+K / ⌘D</dt><dd>Duplicate</dd>
                        <dt>Ctrl+C/V/X</dt><dd>Copy / paste / cut</dd>
                        <dt>Z / B</dt><dd>Zoom all / zoom bed</dd>
                      </dl>
                    </section>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Object toolbar at the top of the viewport */}
          {ok && canvasMode === 'prepare' && (
            <div className="vp-top-toolbar" role="toolbar" aria-label="Object tools">
              {OBJECT_TOOLS.map((t, i) => t.sep
                ? <span key={'sep' + i} className="vtt-sep" />
                : <button key={t.id} onClick={t.run} disabled={t.disabled?.() ?? !t.run}
                    title={t.tip} data-testid={`tool-${t.id}`}><img src={t.icon} alt={t.label} /></button>)}
            </div>
          )}

          {/* Floating painting panel */}
          {ok && canvasMode === 'prepare' && paintMode !== 'off' && (
            <div className="brush-panel" data-testid="paint-tools">
              <div className="bp-title">Support painting</div>
              <div className="bp-modes">
                <button className={paintMode === 'enforcer' ? 'on enf' : 'enf'} onClick={() => setPaintMode('enforcer')} title="Force support under the painted facets" data-testid="paint-enforcer">enforcer</button>
                <button className={paintMode === 'blocker' ? 'on blk' : 'blk'} onClick={() => setPaintMode('blocker')} title="Block support under the painted facets" data-testid="paint-blocker">blocker</button>
                <button onClick={clearPaint} data-testid="paint-clear" title="Clear every painted enforcer/blocker area">Clear</button>
                <button onClick={() => setPaintMode('off')} data-testid="paint-off" title="Leave painting mode (Esc)">Close</button>
              </div>
              <label className="bp-radius">Brush radius {brushRadius}mm
                <input type="range" min="1" max="15" step="0.5" value={brushRadius}
                  onChange={e => { const v = parseFloat(e.target.value); setBrushRadius(v); brushRadiusRef.current = v }} data-testid="brush-radius" />
              </label>
              <div className="muted bp-counts" data-testid="paint-counts">enforcer {paintCounts.enf} · blocker {paintCounts.blk} · drag over the model to paint</div>
            </div>
          )}

          {/* Preview stats card, bottom left */}
          {ok && canvasMode === 'preview' && stats && (
            <div className="stats-card" data-testid="slice-stats">{statsBlock}</div>
          )}

          {/* Stage 29-2: plate tab bar (selection/labels + add/remove) */}
          {ok && (
            <div className="plate-bar" data-testid="plate-bar" role="tablist" aria-label="Plates">
              {Array.from({ length: plateCount }, (_, i) => (
                <button key={i} role="tab" className={'plate-tab' + (i === selectedPlate ? ' on' : '')} onClick={() => selectPlate(i)} title={`Select plate ${i + 1} — in Preview this switches to that plate's result`} data-testid={`plate-${i}`}>{i + 1}</button>
              ))}
              <button className="plate-add" onClick={addPlate} disabled={plateCount >= MAX_PLATES} title="Add an empty plate (max 9) — each plate slices and exports separately" data-testid="plate-add">+</button>
              {plateCount > 1 && <button className="plate-del" onClick={deletePlate} title="Delete the last plate and its slice result" data-testid="plate-del">−</button>}
            </div>
          )}

          {ok && <div className="vp-status" data-testid="vp-status">{status}</div>}
        </div>

        {/* S4 right sidebar */}
        {ok && (
          <aside className="sidebar">
            <div className="sidebar-scroll">
              {/* (1) Printer */}
              <section className="side-card">
                <div className="sc-head">🖨 Printer</div>
                <div className="sc-info"><span>Bed</span>
                  {/* Direct width x depth editing (rectangular). Origin, circular and custom shapes live in the process panel's printable_area editor. */}
                  <span className="sc-bed" title="Plate size — applied on Enter or blur. Circular/custom shapes come from the printable_area option">
                    <input type="number" min="1" key={`w${Math.round(kp.bed_width)}`} defaultValue={Math.round(kp.bed_width)}
                      onBlur={e => setBedSize(+e.target.value, kp.bed_depth)}
                      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }} data-testid="bed-w-card" />
                    ×
                    <input type="number" min="1" key={`d${Math.round(kp.bed_depth)}`} defaultValue={Math.round(kp.bed_depth)}
                      onBlur={e => setBedSize(kp.bed_width, +e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }} data-testid="bed-d-card" />
                    mm
                  </span>
                </div>
                <div className="sc-info"><span>Nozzle Ø</span><b>{nozzleDia} mm</b></div>
              </section>

              {/* (2) Filament */}
              <section className="side-card" data-testid="filament-section">
                <div className="sc-head">🧵 Filament <span className="sc-count">{extruderColors.length}</span>
                  <span className="sc-head-btns">
                    <button onClick={addFilament} disabled={extruderColors.length >= 4} title="Add a filament (extruder) — up to 4, assignable per object" data-testid="filament-add">+</button>
                    <button onClick={removeFilament} disabled={extruderColors.length <= 1} title="Remove the last filament — objects using it are reassigned to a remaining number" data-testid="filament-del">−</button>
                  </span>
                </div>
                {extruderColors.map((c, i) => (
                  <div className="filament-row" key={i}>
                    <input type="color" value={c} onChange={e => setExtColor(i, e.target.value)} title={`T${i + 1} filament color`} data-testid={`filament-color-${i}`} />
                    <span className="fil-t">T{i + 1}</span>
                    <span className="fil-swatch" style={{ background: c }} />
                    <span className="fil-hex muted">{c}</span>
                  </div>
                ))}
              </section>

              {/* (4) Object list */}
              {objects.length > 0 && (
                <section className="side-card" data-testid="object-section">
                  <div className="sc-head">📦 Objects <span className="sc-count">{objects.length}</span></div>
                  <ul className="obj-list2" data-testid="obj-list">
                    {objects.map(o => (
                      <li key={o.id} className={o.visible === false ? 'obj-hidden' : ''}>
                        <button className="obj-eye" onClick={() => toggleObjVisible(o.id)} title="Include/exclude this object from printing — excluding it keeps it in the scene" data-testid={`eye-${o.id}`}>{o.visible === false ? '🚫' : '👁'}</button>
                        <span className="obj-name" title={o.name}>{o.name}</span>
                        <select className="obj-ext" value={o.extruder ?? 1} onChange={e => setObjExtruder(o.id, +e.target.value)} title="Which filament (extruder) prints this object" data-testid={`ext-${o.id}`}>
                          {extruderColors.map((c, i) => <option key={i} value={i + 1}>T{i + 1}</option>)}
                        </select>
                        <button className="obj-split" onClick={() => { apiRef.current?.selectObject(o.id); splitSelected() }} title="Split to objects — every disconnected part (connected component) becomes its own object. Split to parts is not implemented (no part concept)" data-testid={`split-${o.id}`}><img src={splitIcon} alt="Split" /></button>
                        <button className="obj-del" onClick={() => removeObject(o.id)} title="Remove this object from the scene">✕</button>
                      </li>
                    ))}
                  </ul>
                  <label className="slice-support"><input type="checkbox" checked={supportOn} onChange={onToggleSupport} title="Generate support structures under overhangs (same as enable_support in the settings panel)" data-testid="support-toggle" /> Generate support</label>
                  <label className="slice-support"><input type="checkbox" checked={wipeTowerReal} onChange={e => setWipeTowerReal(e.target.checked)} title="Use the upstream WipeTower to compute purge volumes on multi-material tool changes (off = a simple square ring)" data-testid="wipe-tower-real-toggle" /> Real wipe tower <span className="muted">(MM)</span></label>
                </section>
              )}
              {triWarn && <div className="slice-warn side-warn">⚠ {triWarn}</div>}
              {sliceNotice && <div className="slice-warn side-warn" data-testid="slice-notice">ℹ {sliceNotice}</div>}
              {error && <div className="slice-err side-warn" data-testid="slice-err">{error}</div>}
              {downgradeOffer && <button className="slice-btn" data-testid="downgrade-retry" onClick={retryDowngrade} title="Simplify the infill and lower its density to reduce memory pressure, then retry">Simplified retry (simple infill, economy mode)</button>}

              {/* Preview controls (view type / slider / legend) */}
              {canvasMode === 'preview' && previewControls && (
                <section className="side-card">
                  <div className="sc-head">🎚 Preview</div>
                  {previewControls}
                </section>
              )}

              {/* (3) Process (settings panel) */}
              <section className="side-card process-card" data-testid="process-section">
                <div className="sc-head">⚙ Process</div>
                {processPanel}
              </section>
            </div>

            {/* (5) Fixed bottom button bar */}
            <div className="side-bottom">
              <label className="auto-slice" data-testid="auto-slice" title="Re-slice automatically 0.8s after a settings change (the first slice is manual; a running slice is canceled and restarted)">
                <input type="checkbox" checked={autoSlice} onChange={e => setAutoSlice(e.target.checked)} /> Auto slice
              </label>
              <div className="slice-dd">
                <button className="slice-btn" title={slicing ? 'Click to cancel the slice' : (plateCount > 1 ? 'Choose what to slice (Ctrl+R = current plate)' : 'Slice the current plate (Ctrl+R)')} onClick={() => (slicing ? cancelSlice() : (plateCount > 1 ? setSliceMenu(v => !v) : onSlice('current')))} disabled={objects.length === 0} data-testid="slice-btn">
                  {slicing ? `Slicing… ${Math.round(progress * 100)}%` : (plateCount > 1 ? 'Slice ▾' : 'Slice')}
                </button>
                {sliceMenu && plateCount > 1 && (
                  <div className="slice-menu" data-testid="slice-menu">
                    <button onClick={() => onSlice('current')} data-testid="slice-current" title="Slice only the selected plate (Ctrl+R)">Current plate (P{selectedPlate + 1})</button>
                    <button onClick={() => onSlice('all')} data-testid="slice-all" title="Slice every plate in turn — switch tabs to inspect the results">All plates ({plateCount})</button>
                    {slicedPlateCount > 0 && (
                      <button onClick={exportAllGcode} data-testid="export-all" title="Save the G-code of every sliced plate as its own file">Export all G-code ({slicedPlateCount})</button>
                    )}
                  </div>
                )}
              </div>
              {gcodeUrl
                ? <a className="export-btn" href={gcodeUrl} download={`plate_${selectedPlate + 1}.gcode`} title="Save the G-code of the plate you are viewing" data-testid="gcode-dl">Export G-code</a>
                : <button className="export-btn" disabled title="Export G-code — enabled after slicing">Export G-code</button>}
            </div>
          </aside>
        )}
      </div>
    </div>
    </ShadowHost>
  )
}
