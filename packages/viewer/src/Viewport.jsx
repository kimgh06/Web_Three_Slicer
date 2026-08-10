import React, { useEffect, useRef, useState } from 'react'
import { deriveKernelParams, settingRaw } from 'three-slicer/settings'
import { schema } from 'three-slicer/data'
import ShadowHost from './shadow_host.jsx'
import shadowCss from '../styles.css?inline'   // Shadow DOM isolation — inlined as a string at build time
import { SUPPORTED_EXT } from './model_loaders.js'
import { MAX_PLATES } from './plate_layout.js'
import { objectTools } from './toolbar_items.js'
import { makeKeyHandler } from './shortcut_keymap.js'
import { useThreeScene } from './use_three_scene.js'
import { useSlicer } from './use_slicer.js'
import { makeToolpathView } from './toolpath_view.js'
import { makePlateActions } from './plate_actions.js'
import { makeModelLoad } from './model_load.js'
import { makeSupportPaint } from './support_paint.js'
import { makeObjectActions } from './object_actions.js'
// Stage 27: the desktop-style shell, split into presentational components (one file per panel).
import TopBar from './ui/TopBar.jsx'
import GizmoRail from './ui/GizmoRail.jsx'
import ObjectToolbar from './ui/ObjectToolbar.jsx'
import ContextMenu from './ui/ContextMenu.jsx'
import HelpOverlay from './ui/HelpOverlay.jsx'
import PaintPanel from './ui/PaintPanel.jsx'
import PlateBar from './ui/PlateBar.jsx'
import PreviewControls from './ui/PreviewControls.jsx'
import StatsCard from './ui/StatsCard.jsx'
import PrinterCard from './ui/PrinterCard.jsx'
import FilamentCard from './ui/FilamentCard.jsx'
import ObjectList from './ui/ObjectList.jsx'
import SliceBar from './ui/SliceBar.jsx'

// 3D viewport + browser-only slicing (WASM, track C stage 4).
//  - Slice parameters are derived from the right-hand editor panel values (deriveKernelParams) — no duplicate form.
//  - Multiple objects (cumulative upload + merged TransformControls transforms), support/raft/bed/pattern/cooling/arc/seam.
//  - Toolpaths: stage 24 — the upstream libvgcode approach (GPU instancing, toolpath_gpu.js). The CPU geometry builder is gone.
//    Coordinates: kernel z-up -> toolpathGroup rotation.x=-90° (the shader computes in local z-up, view_matrix compensates).

export default function Viewport({ settings = {}, setSettings = () => {}, processPanel = null, motionPanel = null }) {
  const apiRef = useRef(null)
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
  // Stage 29-2: multiple plates (minimal S7). Plate i sits at three-x offset PX_i = i*(bedW+GAP).
  const plateResultsRef = useRef({})    // {plateIdx: sliceResult} cache
  const plateOffsetsRef = useRef({})    // {plateIdx: {offX, offZ}} toolpath display offset (compensates the centered slice)
  const selectedPlateRef = useRef(0)
  const plateCountRef = useRef(1)
  const placeXRef = useRef(0)           // object placement cursor within the selected plate (plate-relative)

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

  // ---- three.js scene (renderer/camera/controls/pointer handlers + the imperative apiRef surface) ----
  const { mountRef, three } = useThreeScene({
    apiRef, objectsRef, keyRef, workerRef, selectedPlateRef, placeXRef, plateCountRef,
    canvasModeRef, paintModeRef, brushRadiusRef, paintXformRef, extruderColorsRef,
    setOk, setStatus, setGmode, setCtxMenu, setBrushRadius,
  })

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
  const {
    disposePlateToolpath, clearToolpaths, buildPlateToolpath, ensurePlateToolpaths,
    applyViewColors, rebuildToolpaths, applyLayerRange,
  } = makeToolpathView({
    three, plateTpRef, toolpathRef, segDataRef, layersDataRef, plateResultsRef, plateOffsetsRef,
    lineWidthRef, showTravelRef, viewTypeRef, layerLoRef, layerHiRef, selectedPlateRef,
    settings, setSegCount, setColorRange, setRoleLegend,
  })

  // ---- Worker lifecycle + progress (SAB polling) + streaming/watchdog/OOM ladder (stage 30) ----
  const { getWorker, cancelSlice, runSlice, pendingSliceRef, downgradeRef } = useSlicer({
    settings, wipeTowerReal, workerRef, apiRef, layersDataRef, layerLoRef, layerHiRef,
    rebuildToolpaths, rebuildPaintOverlay: (enf, blk) => rebuildPaintOverlay(enf, blk),
    setProgress, setSlicing, setError, setStats, setOverBed, setLayerCount,
    setLayerLo, setLayerHi, setGcodeUrl, setCanvasMode, setPaintCounts,
  })

  // ---- Stage 20: manual support painting (enforcer/blocker) ----
  const { rebuildPaintOverlay, setPaintMode, clearPaint } = makeSupportPaint({
    three, objectsRef, apiRef, getWorker, selectedPlateRef,
    paintXformRef, paintOverlayRef, paintModeRef,
    setError, setPaintModeState, setPaintCounts,
  })

  // ---- Per-plate slicing/caching/export + the plate tabs (stage 29-2) ----
  const {
    refreshSlicedCount, exportAllGcode, onSlice, retryDowngrade, addPlate, deletePlate, selectPlate,
  } = makePlateActions({
    apiRef, selectedPlateRef, plateCountRef, placeXRef, plateResultsRef, plateOffsetsRef, plateTpRef,
    layersDataRef, toolpathRef, segDataRef, layerLoRef, layerHiRef, lineWidthRef, downgradeRef,
    settings, canvasMode, downgradeOffer,
    runSlice, ensurePlateToolpaths, buildPlateToolpath, applyViewColors, disposePlateToolpath,
    setStats, setOverBed, setLayerCount, setSegCount, setColorRange, setRoleLegend, setGcodeUrl,
    setLayerLo, setLayerHi, setCanvasMode, setSlicedPlateCount, setSliceMenu, setError, setSliceNotice,
    setDowngradeOffer, setSlicing, setProgress, setPlateCount, setSelectedPlate,
  })

  // ---- Stage 26: model loading (STL/OBJ/3MF/AMF/PLY, cumulative) — shared by the file picker and drag-and-drop ----
  const { onFiles, removeObject, onDrop, onDragOver, onDragLeave } = makeModelLoad({
    apiRef, objectsRef, layersDataRef, segDataRef, plateResultsRef, plateOffsetsRef,
    clearToolpaths, refreshSlicedCount, dragOver,
    setError, setTriWarn, setProgress, setStats, setOverBed, setLayerCount, setSegCount,
    setColorRange, setSliceNotice, setDowngradeOffer, setGcodeUrl, setCanvasMode, setObjects, setDragOver,
  })

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
  // Overhang shading — driven by the same threshold the kernel slices with, so the shading and the generated
  //  support agree. Re-applied whenever the angle changes so the slider gives immediate feedback.
  // Support style options come from the schema enum, so the list stays whatever upstream defines
  const supportStyles = (schema.support_style?.enum_values ?? [])
    .map((value, i) => ({ value, label: schema.support_style?.enum_labels?.[i] ?? value }))
  const supportStyle = String(settingRaw(settings, 'support_style') ?? 'default')
  const [overhangOn, setOverhangOn] = useState(false)
  const overhangAngle = Number(settingRaw(settings, 'support_threshold_angle')) || 30
  useEffect(() => {
    apiRef.current?.setOverhang(overhangOn && canvasMode === 'prepare' ? overhangAngle : null)
  }, [overhangOn, overhangAngle, canvasMode, objects.length])   // eslint-disable-line react-hooks/exhaustive-deps
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

  // Object actions (duplicate/copy/paste/delete/split + gizmo mode) — the bodies live in object_actions.js.
  const {
    duplicateSelected, copySelected, pasteClipboard, deleteSelected, deleteAllObjects, splitSelected, setGizmo,
  } = makeObjectActions({
    apiRef, objectsRef, clipboardRef, paintModeRef,
    setPaintMode, removeObject, refreshObjects, setError, setSliceNotice,
  })

  // Object toolbar — the button list lives in toolbar_items.js; only the actions are bound here.
  const OBJECT_TOOLS = objectTools({
    add: () => fileInputRef.current?.click(),
    remove: deleteSelected,
    removeAll: deleteAllObjects,
    duplicate: duplicateSelected,
    split: splitSelected,
    placeOnBed: () => apiRef.current?.placeOnBed(),
    objectCount: () => objects.length,
  })

  // ---- Keyboard shortcuts (upstream SPECS §4 + PrusaSlicer/Cura conventions) ----
  //  Which keys are live depends on Prepare/Preview. All are ignored while an input widget has focus.
  keyRef.current = makeKeyHandler({
    slicing,
    isPreview: () => canvasModeRef.current === 'preview',
    slice: onSlice, copy: copySelected, paste: pasteClipboard, remove: deleteSelected, duplicate: duplicateSelected,
    stepLayer: (d) => { const v = layerHiRef.current + d; singleLayer ? setRange(v, v) : setRange(layerLoRef.current, v) },
    toggleSingleLayer: toggleSingle,
    toggleTravel: () => onToggleTravel({ target: { checked: !showTravelRef.current } }),
    zoomAll: () => apiRef.current?.frame(), zoomBed: () => apiRef.current?.frameBed(),
    leavePreview: () => setCanvasMode('prepare'),
    setGizmo,
    cancelTool: () => { if (paintModeRef.current !== 'off') setPaintMode('off'); apiRef.current?.detachTransform() },
    rotateSelected: (rad) => apiRef.current?.rotateSelectedY(rad),
    nudgeSelected: (dx, dy) => apiRef.current?.nudgeSelected(dx, dy),
    toggleHelp: () => setShowHelp(v => !v),
  })

  const nozzleDia = kp.nozzle_diameter || settingRaw(settings, 'nozzle_diameter') || '0.4'
  three.current.invalidate?.()   // render on demand: invalidate one frame per React re-render (slider/toggle/state change)

  // Preview controls (view type + dual slider + legend) — placed in the sidebar
  const previewControls = layerCount > 0 && (
    <PreviewControls
      viewType={viewType} onViewType={onViewType} layerCount={layerCount}
      layerLo={layerLo} layerHi={layerHi} segCount={segCount} singleLayer={singleLayer}
      onLayerLo={onLo} onLayerHi={onHi} onToggleSingle={toggleSingle}
      showTravel={showTravel} onToggleTravel={onToggleTravel}
      colorRange={colorRange} roleLegend={roleLegend} />
  )
  const statsBlock = <StatsCard stats={stats} overBed={overBed} />

  // registerLoader() can add formats, so this is computed at render time.
  const EXT_LABEL = SUPPORTED_EXT.map(e => e.toUpperCase()).join(' · ')

  return (
    <ShadowHost css={shadowCss}>
    <div className="app-shell">
      {/* Shared hidden file input */}
      <input ref={fileInputRef} type="file" accept={SUPPORTED_EXT.map(e => '.' + e).join(',')} multiple onChange={onFiles} title={`${EXT_LABEL} (multiple files allowed)`} data-testid="stl-input" style={{ display: 'none' }} />

      <TopBar showTabs={ok} canvasMode={canvasMode} onCanvasMode={setCanvasMode}
        previewEnabled={layerCount > 0} onOpen={() => fileInputRef.current?.click()} />

      <div className="app-body">
        {ok && canvasMode === 'prepare' && (
          <GizmoRail gizmoMode={gmode} paintMode={paintMode}
            onGizmo={m => { setPaintMode('off'); apiRef.current?.setMode(m) }}
            onTogglePaint={togglePaintGizmo} />
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
              <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} canPaste={!!clipboardRef.current}
                actions={{
                  duplicate: duplicateSelected, copy: copySelected, split: splitSelected,
                  placeOnBed: () => apiRef.current?.placeOnBed(), remove: deleteSelected,
                  openFile: () => fileInputRef.current?.click(), paste: pasteClipboard,
                  zoomAll: () => apiRef.current?.frame(), zoomBed: () => apiRef.current?.frameBed(),
                }} />
            )}
            {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
          </div>

          {ok && canvasMode === 'prepare' && <ObjectToolbar tools={OBJECT_TOOLS} />}

          {ok && canvasMode === 'prepare' && paintMode !== 'off' && (
            <PaintPanel paintMode={paintMode} onPaintMode={setPaintMode} onClear={clearPaint}
              brushRadius={brushRadius} paintCounts={paintCounts}
              onBrushRadius={v => { setBrushRadius(v); brushRadiusRef.current = v }} />
          )}

          {/* Preview stats card, bottom left */}
          {ok && canvasMode === 'preview' && stats && (
            <div className="stats-card" data-testid="slice-stats">{statsBlock}</div>
          )}

          {ok && (
            <PlateBar plateCount={plateCount} selectedPlate={selectedPlate} maxPlates={MAX_PLATES}
              onSelect={selectPlate} onAdd={addPlate} onDelete={deletePlate} />
          )}

          {ok && <div className="vp-status" data-testid="vp-status">{status}</div>}
        </div>

        {/* S4 right sidebar */}
        {ok && (
          <aside className="sidebar">
            <div className="sidebar-scroll">
              <PrinterCard bedWidth={kp.bed_width} bedDepth={kp.bed_depth} nozzleDia={nozzleDia} onBedSize={setBedSize}
                settings={settings} setSettings={setSettings} motionPanel={motionPanel} />

              <FilamentCard colors={extruderColors} onColor={setExtColor} onAdd={addFilament} onRemove={removeFilament} />

              {objects.length > 0 && (
                <ObjectList objects={objects} extruderColors={extruderColors}
                  onToggleVisible={toggleObjVisible} onExtruder={setObjExtruder}
                  onSplit={id => { apiRef.current?.selectObject(id); splitSelected() }} onRemove={removeObject}
                  supportOn={supportOn} onToggleSupport={onToggleSupport}
                  overhangOn={overhangOn} onToggleOverhang={e => setOverhangOn(e.target.checked)}
                  overhangAngle={overhangAngle} paintMode={paintMode} onTogglePaint={togglePaintGizmo}
                  supportStyle={supportStyle} supportStyles={supportStyles}
                  onSupportStyle={v => setSettings(s => ({ ...s, support_style: v }))}
                  wipeTowerReal={wipeTowerReal} onToggleWipeTower={e => setWipeTowerReal(e.target.checked)} />
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

            <SliceBar autoSlice={autoSlice} onAutoSlice={setAutoSlice} slicing={slicing} progress={progress}
              plateCount={plateCount} selectedPlate={selectedPlate} sliceMenuOpen={sliceMenu}
              onSliceMenu={() => setSliceMenu(v => !v)} slicedPlateCount={slicedPlateCount}
              canSlice={objects.length > 0} onSlice={onSlice} onCancel={cancelSlice}
              onExportAll={exportAllGcode} gcodeUrl={gcodeUrl} />
          </aside>
        )}
      </div>
    </div>
    </ShadowHost>
  )
}
