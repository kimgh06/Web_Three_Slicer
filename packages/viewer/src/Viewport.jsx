import React, { useEffect, useRef, useState } from 'react'
import { deriveKernelParams, settingRaw, settingScalar } from 'three-slicer/settings'
import { schema } from 'three-slicer/data'
import ShadowHost from './shadow_host.jsx'
import shadowCss from '../styles.css?inline'   // Shadow DOM isolation — inlined as a string at build time
import { SUPPORTED_EXT } from './scene/model_loaders.js'
import { MAX_PLATES, platePosition } from './core/plate_layout.js'
import { parseGcode } from './core/gcode_parse.js'
import { objectTools } from './core/toolbar_items.js'
import { makeKeyHandler } from './core/shortcut_keymap.js'
import { setLogging } from './core/log.js'
import { useStateRef } from './use_state_ref.js'
import { useHostEvents } from './use_host_events.js'
import { useViewportHistory, undoRedoDirection } from './use_viewport_history.js'
import { useThreeScene } from './scene/use_three_scene.js'
import {
  makeToolpathView, useSlicer, makeSupportPaint, MAX_PAINT_EXTRUDERS,
  makePlateActions, makeModelLoad, makeExportActions, makePresetActions, PRESET_ACCEPT, makeObjectActions,
} from './actions/index.js'
import { bedOverflow, overflowText } from './core/bed_bounds.js'
import { towerBoxes } from './core/tower_layout.js'
import {
  TopBar, GizmoRail, ObjectToolbar, ContextMenu, HelpOverlay, PaintPanel, MaterialPaintPanel, PlateBar,
  PreviewControls, StatsCard, PrinterCard, FilamentCard, ObjectList, SliceBar, TowerCard, writeTowerPosition,
} from './ui/index.js'

// 3D viewport + browser-only slicing (WASM, track C stage 4).
//  - Slice parameters are derived from the right-hand editor panel values (deriveKernelParams) — no duplicate form.
//  - Multiple objects (cumulative upload + merged TransformControls transforms), support/raft/bed/pattern/cooling/arc/seam.
//  - Toolpaths: stage 24 — the upstream libvgcode approach (GPU instancing, toolpath_gpu.js). The CPU geometry builder is gone.
//    Coordinates: kernel z-up -> toolpathGroup rotation.x=-90° (the shader computes in local z-up, view_matrix compensates).

// Default colour per extruder slot, up to the selector's own ceiling of 16 (support_paint.js). A literal table
//  rather than a generated hue ramp because <input type="color"> only accepts hex, so a generated colour would
//  need an hsl->hex conversion written for a value the user immediately overrides anyway. The first two entries
//  are the long-standing T1/T2 defaults — an existing project must not change colour because the list grew.
const DEFAULT_FILAMENT_COLORS = [
  '#6aa0dc', '#e08a2b', '#e0473b', '#3bb0e0', '#7ad14a', '#b06ad1', '#d1c34a', '#4ad1a8',
  '#d16a9a', '#6a7ad1', '#8fd16a', '#d18f6a', '#6ad1d1', '#c74ad1', '#a8a8a8', '#4a6ad1',
]

// Embedding surface (all optional — omitting every one of them is the standalone app this component has always been):
//  · panels    — per-panel visibility, {name: false} hides. Everything defaults to visible, so a host opts OUT only.
//  · gcode     — G-code text rendered instead of a slice result (no kernel run). See the injection effect below.
//  · default*  — initial value for state this component owns; the host reads changes back through onEvent.
//  · onEvent   — one channel for every value change ({type, value}), rather than a prop per value.
//  · onSliced  — the finished slice ({plate, stats, gcode}), the one payload too big to belong on onEvent.
export default function Viewport({
  settings = {}, setSettings = () => {}, processPanel = null, motionPanel = null, filamentPanel = null,
  panels = null, features = null, gcode = null, defaultExtruderColors = null, defaultAutoSlice = false,
  onEvent = null, onSliced = null, onExport = null,
}) {
  // A panel is shown unless the host explicitly said false — an unknown key is therefore visible, so a panel added
  //  later does not silently disappear for hosts that listed the ones they wanted.
  const showPanel = (name) => panels?.[name] !== false
  // A sidebar panel can also be shown but not editable (`panels={{ printerCard: 'readonly' }}`) — the case a host
  //  that presets printer/process/filament itself actually wants, and which hiding the card does not cover.
  //  One inert wrapper per card, rather than a `disabled` prop threaded through five card components and every
  //  input inside them. That also locks the host's OWN nodes (motionPanel, filamentPanel, processPanel) for free,
  //  which is the right reading: a read-only printer card with a live motion panel inside it would be strange.
  //  `inert=''` and not `inert={true}` — React only learned `inert` as a real boolean prop in 19, and the peer
  //  range here starts at 18, where a boolean is dropped and the empty string is what gets through.
  //  Only the sidebar panels are lockable (types/viewer.d.ts LockablePanel); elsewhere 'readonly' reads as visible.
  const Panel = ({ name, children }) => (panels?.[name] === 'readonly'
    ? <div className="vp-readonly" inert="">{children}</div>
    : children)
  // Opening the file dialog goes through here from all three entry points (top bar, empty hint, object toolbar),
  //  so features.filePicker cannot be honoured in two of them and forgotten in the third.
  const openFilePicker = () => { if (feature('filePicker')) fileInputRef.current?.click() }
  // `features` is the same contract for BEHAVIOUR that `panels` is for visibility: opt-out only, everything on by
  //  default, an unknown key enabled. Two axes rather than one because "is this panel drawn" and "does this
  //  component take over the page's keyboard" are different questions, and a host usually has an opinion on one
  //  without having one on the other.
  const feature = (name) => features?.[name] !== false
  // Console output is module-level (log.js) rather than threaded through every factory — see the note there.
  useEffect(() => { setLogging(feature('logs')) }, [features])   // eslint-disable-line react-hooks/exhaustive-deps
  // Read through refs: both are called from effects and from callbacks built in other modules, which capture the
  //  props of the render they were created in. The ref is always the latest one the host passed.
  const onEventRef = useRef(onEvent); onEventRef.current = onEvent
  const onSlicedRef = useRef(onSliced); onSlicedRef.current = onSliced

  const apiRef = useRef(null)
  const workerRef = useRef(null)
  const objectsRef = useRef([])        // [{id,name,mesh,localPos}]
  const layersDataRef = useRef(null)   // layer data of the focused (selected) plate — alias
  const toolpathRef = useRef(null)     // stage 24: the makeToolpath() controller — alias for the focused plate (slider/travel target)
  const segDataRef = useRef(null)      // stage 25: buildSegmentData result — alias for the focused plate (for recomputing view-type colors)
  const plateTpRef = useRef({})        // the real per-plate toolpaths {idx: {group, ctl, seg}} — all plates render at once
  const keyRef = useRef(null)          // shortcut handler (component scope — captures the latest state). The effect only forwards.
  const clipboardRef = useRef(null)    // in-app copy buffer (object snapshot) — the OS clipboard is not used
  const canvasModeRef = useRef('prepare')  // S2: interaction gating (gizmo/painting disabled in preview)
  const lineWidthRef = useRef(0.42)    // line_width of the last slice (default width; layer height is derived from the z increment by buildSegmentData)
  // Stage 20: manual support painting (enforcer/blocker), extended to material painting (paint a region onto
  //  another extruder). One mode variable, because one facet carries one selector state — see support_paint.js.
  const paintModeRef = useRef('off')   // 'off' | 'enforcer' | 'blocker' | 'material'
  const paintXformRef = useRef(null)    // {cx,cy,minz} kernel transform (object STL bbox)
  const paintOverlayRef = useRef(null)  // Mesh[] — one per painted selector state (1..16)
  const selectorGeomRef = useRef(null)  // {identity, topology} of the mesh the kernel's selector holds (null = none)
  const registerSelectorRef = useRef(null)  // set below, from makeSupportPaint — the scene hook is built first
  const selectPlateRef = useRef(null)       // set below, from makePlateActions — same reason
  const recordHistoryRef = useRef(null)     // set below, from the undo history — the scene hook is installed first
  // Stage 29-2: multiple plates (minimal S7). Plate i sits at three-x offset PX_i = i*(bedW+GAP).
  const plateResultsRef = useRef({})    // {plateIdx: sliceResult} cache
  const plateOffsetsRef = useRef({})    // {plateIdx: {offX, offZ}} toolpath display offset (the plate's own origin)
  const selectedPlateRef = useRef(0)
  const plateCountRef = useRef(1)
  const placeXRef = useRef(0)           // object placement cursor within the selected plate (plate-relative)

  const [ok, setOk] = useState(true)
  const [gmode, setGmode] = useState('translate')
  const [status, setStatus] = useState('Initializing…')
  const [objects, setObjects] = useState([])
  const [triWarn, setTriWarn] = useState('')
  const [slicing, setSlicing] = useState(false)
  // The label an export is currently showing, or null when idle. A string rather than a boolean because the two
  //  export buttons say different things, and the one that is running is the one that has to say it.
  const [exporting, setExporting] = useState(null)
  const [autoSlice, setAutoSlice] = useState(!!defaultAutoSlice)   // G004: debounced auto re-slice on settings change
  const autoTimerRef = useRef(0)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [stats, setStats] = useState(null)
  const [overBed, setOverBed] = useState(false)
  // The same verdict as overBed, but reached without slicing: recomputed whenever the plate's contents move, so a
  //  model dragged off the bed says so immediately instead of after the next slice. Null = everything fits.
  const [bedOver, setBedOver] = useState(null)
  const [layerCount, setLayerCount] = useState(0)
  const [segCount, setSegCount] = useState(0)   // stage 24: number of rendered segments (instances)
  const [plateCount, setPlateCount] = useState(1)       // stage 29-2: plate count
  const [selectedPlate, setSelectedPlate] = useState(0) // selected plate (0-based)
  const [sliceMenu, setSliceMenu] = useState(false)     // whether the [Slice ▾] dropdown is open
  const [showHelp, setShowHelp] = useState(false)       // '?' shortcut help overlay
  const [slicedPlateCount, setSlicedPlateCount] = useState(0)   // number of plates holding a result (drives the export-all button)
  const [ctxMenu, setCtxMenu] = useState(null)          // right-click context menu {x, y, onObject}
  // The scene owns the selection; this is a read-only mirror so the object list and the context menu can render
  //  from it. Pushed by the scene through onSelectionChanged rather than polled, because a click has to repaint
  //  the list in the same frame it repaints the highlight.
  const [selectedIds, setSelectedIds] = useState([])
  // Stage 25 S6: view type + dual slider + gradient legend
  const [viewType, setViewType, viewTypeRef] = useStateRef('feature')   // stage 25: view type (feature/speed/height/width/fan/temp)
  const [colorRange, setColorRange] = useState(null)   // {min,max,label,unit,cont}
  const [layerLo, setLayerLo, layerLoRef] = useStateRef(0)   // stage 25: dual slider lower/upper bound (0-based layer)
  const [layerHi, setLayerHi, layerHiRef] = useStateRef(0)
  const [singleLayer, setSingleLayer] = useState(false)
  const [roleLegend, setRoleLegend] = useState([])          // S6.3: length share per role
  const [canvasMode, setCanvasMode] = useState('prepare')   // S2: 'prepare' (model+gizmo+painting) | 'preview' (toolpaths)
  const [dragOver, setDragOver] = useState(false)           // stage 26 R4: drag-and-drop highlight
  const fileInputRef = useRef(null)
  const presetInputRef = useRef(null)     // its own picker: the model picker's accept list is model formats
  const settingsForPresetRef = useRef(settings); settingsForPresetRef.current = settings
  // Stage 27 S4: filament (extruder) colors — applied to object meshes and the prime tower. Defaults to T1/T2.
  const initialColors = (Array.isArray(defaultExtruderColors) && defaultExtruderColors.length)
    ? defaultExtruderColors.slice(0, MAX_PAINT_EXTRUDERS) : DEFAULT_FILAMENT_COLORS.slice(0, 2)
  const [extruderColors, setExtruderColors, extruderColorsRef] = useStateRef(initialColors)
  const [gcodeUrl, setGcodeUrl] = useState('')
  const [showTravel, setShowTravel, showTravelRef] = useStateRef(false)
  // Off until the ported WipeTower is deterministic. It was briefly the default here on the grounds that the
  //  fallback ring purges nothing — true, but the real tower emits F0 feedrates and produces a different file on
  //  every run of the same input (see params.h), and shipping unreproducible G-code by default is the worse of the
  //  two. The checkbox still offers it.
  const [wipeTowerReal, setWipeTowerReal] = useState(false)   // stage 12: real WipeTower.generate() (MM only)
  const [paintMode, setPaintModeState] = useState('off')      // stage 20: painting mode (support brush or material brush)
  const [materialExtruder, setMaterialExtruder, materialExtruderRef] = useStateRef(0)   // 0-based extruder the material brush writes (null = eraser)
  const [brushRadius, setBrushRadius, brushRadiusRef] = useStateRef(5)
  // Painting tool selection, shared by both brushes (they drive one selector — see support_paint.js). The pointer
  //  handler reads it through a ref because it lives in an effect that must not be rebuilt on every slider move.
  const [paintTool, setPaintTool] = useState('brush')      // 'brush' | 'smart' | 'bucket' | 'triangle'
  const [brushCursor, setBrushCursor] = useState('sphere') // 'sphere' | 'circle' — brush only
  const [fillAngle, setFillAngle] = useState(30)           // smart/bucket fill angle limit, degrees
  const paintToolRef = useRef({ tool: 'brush', cursor: 'sphere', angle: 30 })
  useEffect(() => { paintToolRef.current = { tool: paintTool, cursor: brushCursor, angle: fillAngle } }, [paintTool, brushCursor, fillAngle])
  const [paintCounts, setPaintCounts] = useState({ enf: 0, blk: 0 })
  // Painted facets per selector state (1..16) as the worker reports them, kept apart from the enf/blk pair above
  //  because the two arrive through different worker listeners — see support_paint.js. Empty until a stroke lands.
  const [paintStateCounts, setPaintStateCounts] = useState({})
  // buildParams reads the painted states at slice time, which is a user action and so always follows a render —
  //  but it runs inside useSlicer's closure, so it needs a ref rather than the value captured when that hook ran.
  const paintStateCountsRef = useRef({})
  useEffect(() => { paintStateCountsRef.current = paintStateCounts }, [paintStateCounts])
  // Stage 30 OOM ladder UI: economy-mode completion notice + downgrade offer (simplified retry)
  const [sliceNotice, setSliceNotice] = useState('')       // e.g. "Memory pressure — finished in economy mode (no preview)"
  const [downgradeOffer, setDowngradeOffer] = useState(null) // {scope} — even economy mode failed -> offer a simplified retry

  // ---- Host change notifications (onEvent) — the effects live in use_host_events.js ----
  useHostEvents(onEventRef, {
    canvasMode, objects, selectedPlate, plateCount, extruderColors, autoSlice, slicing, progress,
    viewType, paintMode, layerCount, error, notice: sliceNotice, layerLo, layerHi,
  })

  // ---- The shared wiring: every ref and setter that more than one module needs, written down ONCE ----
  //  Measured before this existed: 13 factory calls listing 124 names across 137 lines, of which 43 names were
  //  being spelled out again in a second, third or seventh call (`setError` and `apiRef` seven times each). The
  //  factories destructure only the names they use, so handing each one the whole set costs nothing at runtime and
  //  loses no documentation — the destructuring block at the top of every actions/ file is still the list of what
  //  that module actually touches, and it is the one worth reading.
  //  Rebuilt every render, exactly as the individual literals were: the factories are rebuilt every render too.
  //  Not in here: `fileInputRef`/`presetInputRef` (one picker each, and makePresetActions takes the OTHER one under
  //  the same key — a spread would make that a silent ordering question), and anything produced by a factory
  //  further down, which cannot exist yet.
  const wiring = {
    settings, setSettings,
    apiRef, workerRef, objectsRef, keyRef, clipboardRef, onSlicedRef,
    layersDataRef, toolpathRef, segDataRef, plateTpRef, lineWidthRef, plateResultsRef, plateOffsetsRef,
    selectedPlateRef, plateCountRef, placeXRef, canvasModeRef, selectorGeomRef, registerSelectorRef,
    paintXformRef, paintOverlayRef, paintModeRef, paintToolRef, paintStateCountsRef,
    brushRadiusRef, materialExtruderRef, extruderColorsRef, showTravelRef, viewTypeRef, layerLoRef, layerHiRef,
    setOk, setStatus, setGmode, setCtxMenu, setBrushRadius, setObjects, setTriWarn, setDragOver, setExporting,
    setProgress, setSlicing, setError, setStats, setOverBed, setLayerCount, setLayerLo, setLayerHi,
    setSegCount, setColorRange, setRoleLegend, setGcodeUrl, setCanvasMode, setSliceNotice, setDowngradeOffer,
    setPaintCounts, setPaintModeState, setPaintStateCounts,
    setSlicedPlateCount, setSliceMenu, setPlateCount, setSelectedPlate,
  }

  // ---- three.js scene (renderer/camera/controls/pointer handlers + the imperative apiRef surface) ----
  const { mountRef, three } = useThreeScene({
    ...wiring,
    contextMenu: feature('contextMenu'),
    // Dragging the tower box is how a position becomes chosen: it writes the same wipe_tower_x/y the card edits,
    //  so the two controls are one setting seen two ways.
    //  The drop lands in world coordinates and the setting is a bed coordinate, so the plate's origin comes back
    //  off — the same conversion the box's placement makes going the other way.
    // A move/rotate/scale changes the coordinates the kernel's selector holds, so it has to be handed the new
    //  ones — otherwise the overlay stays where the model was and a slice projects the paint there too. Gated on
    //  the selector EXISTING, not on paint mode being on: in paint mode the gizmo is detached, so every real move
    //  happens with the panel closed — a paint-mode gate would never fire. Through a ref because the paint module
    //  is built further down and this handler is installed once.
    onTransformCommitted: () => { if (selectorGeomRef.current) registerSelectorRef.current?.(); checkBed() },
    // A gizmo/corner drag reports only that it ENDED, and by then the mesh already holds the new pose — so the
    //  undo entry is taken at the start of the drag, where the old one is still readable.
    onTransformStarted: () => recordHistoryRef.current?.('drag'),
    // Clicking a plate in the viewport selects it, so the tab bar is no longer the only way to switch. Through a
    //  ref because the scene installs its handlers once and makePlateActions is built further down.
    onPlateClicked: (i) => { if (i !== selectedPlateRef.current) selectPlateRef.current?.(i) },
    onSelectionChanged: () => setSelectedIds(apiRef.current?.selectedObjectIds?.() ?? []),
    //  The drag can land on any plate's box, and each plate's position is its own array entry — the origin
    //  subtracted is the dragged box's own plate, and only that plate's entry is written, so the other plates'
    //  towers stand still (writeTowerPosition owns the array/legacy-scalar mechanics).
    onTowerMoved: (x, y, plate) => {
      const idx = plate ?? selectedPlateRef.current
      const o = apiRef.current?.platePos?.(idx) ?? { x: 0, z: 0 }
      setSettings(s => writeTowerPosition(s, idx, plateCountRef.current,
        Math.round((x - o.x + kpRef.current.bedW / 2) * 10) / 10,
        Math.round((y + o.z + kpRef.current.bedD / 2) * 10) / 10))
    },
  })

  // Refresh the bed grid from the value derived from settings (printable_area)
  const kp = deriveKernelParams(settings)
  // The bed size the tower drag needs, in a ref because the handler is installed once by the scene effect.
  const kpRef = useRef({ bedW: 200, bedD: 200, bedH: 0 })
  kpRef.current = { bedW: kp.bed_width, bedD: kp.bed_depth, bedH: kp.bed_height }
  useEffect(() => { apiRef.current?.setPlates(plateCount, kp.bed_width, kp.bed_depth, selectedPlate) }, [kp.bed_width, kp.bed_depth, plateCount, selectedPlate])

  // Re-answer "does this fit on the bed?" for the plate on screen. Called from every path that can move, add or
  //  remove something — a gizmo drop, a keyboard nudge, a load/delete, a plate switch, a bed resize. Reads refs
  //  only, because the scene installs its handlers once and would otherwise capture the first render's values.
  function checkBed() {
    const api = apiRef.current; if (!api) { setBedOver(null); return }
    const plate = selectedPlateRef.current
    const { bedW, bedD, bedH } = kpRef.current
    const origin = api.platePos?.(plate) ?? { x: 0, z: 0 }
    setBedOver(bedOverflow(api.modelBounds?.(plate), origin, bedW, bedD, bedH))
  }
  useEffect(checkBed, [objects.length, selectedPlate, kp.bed_width, kp.bed_depth, kp.bed_height])   // eslint-disable-line react-hooks/exhaustive-deps

  // The tower stand-in follows the same rules the slicer applies: a tower exists with two filaments, its footprint
  //  is the real tower's width or the ring's 15mm, and an unset position means "beside the model". Recomputed here
  //  rather than in the scene so both the box and the slice read one source.
  useEffect(() => {
    const api = apiRef.current; if (!api) return
    const multi = extruderColors.length > 1
    // No box when there is no tower: a single filament, the preview, an empty plate, or the tower switched off.
    const towerOff = settings?.enable_prime_tower === false
    if (!multi || towerOff || canvasMode !== 'prepare' || objects.length === 0) { api.setPrimeTower?.(null); return }
    // The map, not the schema — same reason deriveKernelParams reads it directly (the schema default is off-bed).
    api.setPrimeTower?.(towerBoxes({
      plateCount, settings, bedWidth: kp.bed_width, bedDepth: kp.bed_depth,
      size: wipeTowerReal ? (Number(settingRaw(settings, 'prime_tower_width')) || 30) : 15,
      modelBounds: (plate) => api.modelBounds?.(plate),
      plateOrigin: (plate) => api.platePos?.(plate),
    }))
  }, [extruderColors.length, canvasMode, objects.length, wipeTowerReal, settings, selectedPlate, plateCount, kp.bed_width, kp.bed_depth])   // eslint-disable-line react-hooks/exhaustive-deps

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
  } = makeToolpathView({ ...wiring, three })

  // ---- Worker lifecycle + progress (SAB polling) + streaming/watchdog/OOM ladder (stage 30) ----
  const { getWorker, cancelSlice, runSlice, pendingSliceRef, downgradeRef } = useSlicer({
    ...wiring, wipeTowerReal, rebuildToolpaths,
    // Deferred through a lambda: makeSupportPaint is built below and cannot be in `wiring` yet.
    rebuildPaintOverlay: (enf, blk, overlays) => rebuildPaintOverlay(enf, blk, overlays),
    warmup: feature('warmup'), quiet: !feature('logs'),
  })

  // ---- Stage 20: manual painting — the support brush (enforcer/blocker) and the material brush ----
  const { rebuildPaintOverlay, setPaintMode, clearPaint, registerSelector } = makeSupportPaint({
    ...wiring, three, getWorker,
  })
  registerSelectorRef.current = registerSelector

  // ---- Per-plate slicing/caching/export + the plate tabs (stage 29-2) ----
  const {
    showPlateResult, refreshSlicedCount, exportAllGcode, onSlice, retryDowngrade, addPlate, deletePlate, selectPlate,
  } = makePlateActions({
    ...wiring, canvasMode, downgradeOffer, onExport, downgradeRef,
    runSlice, ensurePlateToolpaths, buildPlateToolpath, applyViewColors, disposePlateToolpath,
    // Belt to the commit hook's braces: a move can reach a slice without a gizmo commit (keyboard nudge, plate
    //  re-arrange), so the slice itself hands the selector the mesh it is about to cut. Only for the selected
    //  plate — that is the mesh the brush painted — and only when a selector exists at all.
    syncPaintSelector: (merged) => { if (selectorGeomRef.current) registerSelectorRef.current?.(merged) },
  })
  selectPlateRef.current = selectPlate

  // Adopt an imported project's filament list. This has to run BEFORE the per-object extruder assignment: a real
  //  MakerWorld project routinely uses six or eight of them, and setObjectExtruder colours an object by looking its
  //  extruder up in this array — with the default two cards, every object above T2 would stay T1-coloured and the
  //  filament panel would not show the materials the project actually names.
  const applyProjectFilaments = (colors) => {
    const next = colors.slice(0, MAX_PAINT_EXTRUDERS)
    if (!next.length) return
    setExtruderColors(next)
    apiRef.current?.recolorObjects()
    applyViewColors()
  }

  // Grow the bed to the plate count an imported 3mf project needs, then let it place its objects. setPlates is
  //  called directly as well as through setPlateCount because it writes plateCountRef and plateBWRef/plateBDRef
  //  SYNCHRONOUSLY, and those are what the plate origins are computed from — going through React state alone would
  //  place every object against the OLD grid and let the effect below re-lay the plates underneath them.
  // The bed must come from the PROJECT, not from `kp`: kp is derived from the settings of the render this callback
  //  was created in, and setSettings has not landed yet. Getting that wrong is not a rounding error — the default
  //  bed is 200mm and a Bambu project is 256mm, so the grid step moved 240 -> 296 right after placement and every
  //  plate past the first drifted by 56mm per column (plate 2 by 112mm), which is exactly what it looked like.
  const applyProjectPlates = (needed, bedWidth, bedDepth, place) => {
    const n = Math.min(MAX_PLATES, Math.max(plateCountRef.current, needed))
    const width = bedWidth > 0 ? bedWidth : kp.bed_width
    const depth = bedDepth > 0 ? bedDepth : kp.bed_depth
    apiRef.current?.setPlates(n, width, depth, selectedPlateRef.current)
    setPlateCount(n)
    place(n)
  }

  // ---- Stage 26: model loading (STL/OBJ/3MF/AMF/PLY, cumulative) — shared by the file picker and drag-and-drop ----
  const { onFiles, removeObject, onDrop, onDragOver, onDragLeave } = makeModelLoad({
    ...wiring, dragOver, clearToolpaths, refreshSlicedCount, applyProjectPlates, applyProjectFilaments,
  })

  // ---- Project export: "save as" a 3mf project, or the plain geometry as an STL ----
  //  settings/bed are read through refs because the actions are async (the painting comes back from the worker) and
  //  must use the values in effect when they FINISH, not when the button was bound.
  const settingsRef = useRef(settings); settingsRef.current = settings
  const { exportPrinterPreset, loadPresetFile, openPresetPicker } = makePresetActions({
    ...wiring, onExport, settingsRef: settingsForPresetRef, fileInputRef: presetInputRef,
  })
  const { exportProject, exportSTL, exportSelectedProject, exportSelectedSTL } = makeExportActions({
    ...wiring, onExport, getWorker, settingsRef, bedRef: kpRef,
  })

  // G004: auto re-slice — 0.8s debounce after a settings or model change, for the current plate.
  //  If a slice is running it is canceled (G002) and the re-slice waits for it to finish. Thanks to incremental slicing (G003) it usually just re-runs emit (~1s).
  //  The first slice used to stay manual (it required a cached plate result). That gate is gone because it made
  //  autoSlice unusable without the slice bar: a host that hides the panels has no other way to start one, so
  //  "auto" that cannot perform the first slice is just off. Turning it on with a model loaded now slices.
  useEffect(() => {
    if (!autoSlice || !objects.length || gcode != null) return   // an injected G-code plate is not ours to overwrite
    clearTimeout(autoTimerRef.current)
    const fire = () => {
      if (pendingSliceRef.current) { cancelSlice(); autoTimerRef.current = setTimeout(fire, 300); return }
      onSlice('current')
    }
    autoTimerRef.current = setTimeout(fire, 800)
    return () => clearTimeout(autoTimerRef.current)
  }, [settings, autoSlice, objects.length])   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- G-code injection (the `gcode` prop) ----
  // Renders G-code without slicing: the parser produces the very layer stream the kernel produces, so the result
  //  goes into the plate cache and showPlateResult draws it exactly like a slice. The kernel is never started.
  // Coordinates: a slice is centred on the origin and offset back by its own centre (use_three_scene buildMergedSTL),
  //  but G-code is already in absolute bed millimetres — so the offset is the bed's own corner, per the plate grid
  //  laid out by setPlates (plate i sits at (i%cols)*step, floor(i/cols)*step; model y maps to three -z).
  useEffect(() => {
    if (gcode == null) return
    const idx = selectedPlateRef.current
    try {
      const parsed = parseGcode(String(gcode), { filamentDiameter: Number(kp.filament_diameter) || 1.75 })
      if (!parsed.layers.length) { setError('No printable moves found in the G-code'); return }
      const bw = kp.bed_width, bd = kp.bed_depth
      const origin = platePosition(idx, plateCountRef.current, bw, bd)
      plateOffsetsRef.current[idx] = { offX: origin.x - bw / 2, offZ: origin.z + bd / 2 }
      lineWidthRef.current = kp.line_width || 0.42
      plateResultsRef.current[idx] = { stats: parsed.stats, layers: parsed.layers, gcode: String(gcode) }
      refreshSlicedCount()
      setError(''); setSliceNotice('')
      showPlateResult(idx)
    } catch (e) { setError('G-code parse failed: ' + (e?.message || e)) }
  }, [gcode])   // eslint-disable-line react-hooks/exhaustive-deps

  // Editing bed width x depth on the printer card — reduced to a printable_area rectangle (origin preserved). Circular/custom shapes belong to the panel editor.
  function setBedSize(w, d) {
    if (!(w > 0) || !(d > 0)) return
    const pa = settingRaw(settings, 'printable_area')
    const ok = Array.isArray(pa) && pa.length >= 3
    const x0 = ok ? Math.min(...pa.map(p => p[0])) : 0, y0 = ok ? Math.min(...pa.map(p => p[1])) : 0
    setSettings(s => ({ ...s, printable_area: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]] }))
  }
  function setObjExtruder(id, e) { recordHistoryRef.current?.(); apiRef.current?.setObjectExtruder(id, e); setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false }))) }

  // Stage 25 S6: dual slider (lo/hi) — in single-layer mode both thumbs move together.
  function setRange(lo, hi) {
    const max = Math.max(0, layerCount - 1)
    lo = Math.max(0, Math.min(max, lo)); hi = Math.max(0, Math.min(max, hi))
    if (lo > hi) { const t = lo; lo = hi; hi = t }
    setLayerLo(lo); setLayerHi(hi); applyLayerRange()
  }
  function onLo(e) { const v = parseInt(e.target.value, 10); if (singleLayer) setRange(v, v); else setRange(v, layerHiRef.current) }
  function onHi(e) { const v = parseInt(e.target.value, 10); if (singleLayer) setRange(v, v); else setRange(layerLoRef.current, v) }
  function toggleSingle() {
    const next = !singleLayer; setSingleLayer(next)
    if (next) setRange(layerHiRef.current, layerHiRef.current)   // single layer = the upper-bound layer only
  }
  function onViewType(e) { setViewType(e.target.value); applyViewColors() }
  // A multi-tool slice landing on the Feature type view paints walls orange and infill blue — which reads as "my
  //  filaments are gone", when the data has them (measured complaint: painted model, by-tool split present, screen
  //  all orange). Land on the Filament view instead. Only from the untouched default: a view the user picked stays.
  useEffect(() => {
    if (!stats) return
    const perTool = plateResultsRef.current[selectedPlateRef.current]?.stats?.filament_mm_by_tool
    const usedTools = Array.isArray(perTool) ? perTool.filter(mm => mm > 0).length : 0
    if (usedTools > 1 && viewTypeRef.current === 'feature') {
      setViewType('filament'); applyViewColors()
    }
  }, [stats])   // eslint-disable-line react-hooks/exhaustive-deps
  function onToggleTravel(e) { const v = e.target.checked; setShowTravel(v); for (const p of Object.values(plateTpRef.current)) p.ctl.setTravelVisible(v) }
  function onToggleSupport(e) { const v = e.target.checked; setSettings(s => ({ ...s, enable_support: v })) }
  const supportOn = !!settingRaw(settings, 'enable_support')
  // Overhang shading — driven by the same threshold the kernel slices with, so the shading and the generated
  //  support agree. Re-applied whenever the angle changes so the slider gives immediate feedback.
  // Support style options come from the schema enum, so the list stays whatever upstream defines
  const supportStyles = (schema.support_style?.enum_values ?? [])
    .map((value, i) => ({ value, label: schema.support_style?.enum_labels?.[i] ?? value }))
  const supportStyle = String(settingRaw(settings, 'support_style') ?? 'default')
  // Which extruder prints the support body and the support interface. Both are upstream coInt keys where 0 means
  //  "Default — keep whatever tool is loaded"; deriveKernelParams (engine/src/settings.js) omits them entirely at 0,
  //  so leaving the selects alone produces the very same kernel params as before these keys existed.
  const supportFilament = Number(settingRaw(settings, 'support_filament')) || 0
  const supportInterfaceFilament = Number(settingRaw(settings, 'support_interface_filament')) || 0
  const [overhangOn, setOverhangOn] = useState(false)
  const overhangAngle = Number(settingRaw(settings, 'support_threshold_angle')) || 30
  useEffect(() => {
    apiRef.current?.setOverhang(overhangOn && canvasMode === 'prepare' ? overhangAngle : null)
  }, [overhangOn, overhangAngle, canvasMode, objects.length])   // eslint-disable-line react-hooks/exhaustive-deps
  // Stage 27 S4: filament colors/count + per-object print toggle + painting gizmo mode
  function refreshObjects() { setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false }))); checkBed() }

  // ---- Undo/redo, viewport scope (use_viewport_history.js; history.js holds the reasoning and the boundary) ----
  const { depth: historyDepth, record: recordHistory, travel: travelHistory } = useViewportHistory({
    capture: () => apiRef.current?.sceneSnapshot() ?? [],
    //  Restoring is a move like any other, so it has to do a move's commit work: hand the kernel's selector the
    //  new coordinates and re-run the bed check, or the paint overlay stays where the model used to be.
    onRestore: (snapshot) => {
      apiRef.current?.restoreScene(snapshot)
      refreshObjects()
      if (selectorGeomRef.current) registerSelectorRef.current?.()
    },
    isPreview: () => canvasModeRef.current === 'preview',
  })
  recordHistoryRef.current = recordHistory
  //  Bound to the component root (see the JSX), so it never reaches the host application's own Ctrl+Z.
  function onShellKey(e) {
    if (!feature('shortcuts')) return
    const direction = undoRedoDirection(e)
    if (!direction) return
    e.preventDefault(); e.stopPropagation()
    travelHistory(direction)
  }
  function setExtColor(i, hex) { setExtruderColors(cs => { const n = [...cs]; n[i] = hex; return n }); apiRef.current?.recolorObjects(); applyViewColors() }
  function addFilament() { setExtruderColors(cs => (cs.length >= MAX_PAINT_EXTRUDERS ? cs : [...cs, DEFAULT_FILAMENT_COLORS[cs.length] || '#888888'])) }
  function removeFilament(index) {
    setExtruderColors(cs => {
      if (cs.length <= 1) return cs
      // The card passes the SELECTED extruder's index; a bare call (older hosts) still removes the last one.
      const idx = Number.isInteger(index) ? Math.min(Math.max(index, 0), cs.length - 1) : cs.length - 1
      const n = cs.filter((_, k) => k !== idx)
      objectsRef.current.forEach(o => {
        const e = o.extruder || 1
        if (e === idx + 1) apiRef.current?.setObjectExtruder(o.id, 1)           // its filament is gone -> back to T1
        else if (e > idx + 1) apiRef.current?.setObjectExtruder(o.id, e - 1)   // later tools shift down one slot
      })
      apiRef.current?.recolorObjects(); refreshObjects(); return n
    })
  }
  function toggleObjVisible(id) { recordHistoryRef.current?.(); const o = objectsRef.current.find(x => x.id === id); apiRef.current?.setObjectVisible(id, !(o?.visible !== false)); refreshObjects() }
  // Both brushes take the pointer away from the gizmos, so the rail/object-card toggle reads "a brush is active"
  //  rather than "the support brush is active": while material painting, the move gizmo must not look selected.
  //  Which brush is active is what the two floating panels below say.
  const supportPainting = paintMode === 'enforcer' || paintMode === 'blocker'
  // The rail button and the object card's button are the SUPPORT brush's entry point, so pressing them always ends
  //  up in support painting — from material painting that means switching, which is what "entering one leaves the
  //  other" has to look like from the user's side. Only pressing it while already support painting turns it off.
  function togglePaintGizmo() { setPaintMode(supportPainting ? 'off' : 'enforcer') }
  // Entering material painting from a filament chip: pick the extruder first, then switch the brush, so the first
  //  stroke after the click already carries the right selector state (support_paint stamps it from these refs).
  function startMaterialPaint(extruderIndex) {
    const index = Number.isInteger(extruderIndex) ? extruderIndex : null
    setMaterialExtruder(index)
    if (paintModeRef.current !== 'material') setPaintMode('material')
  }
  // Painted facets per extruder chip (0-based) — the panel and the filament rows both read this by index.
  //  The worker's per-state `counts` is the real source: measured, a T3 stroke replies {enf:0, blk:0, counts:{3:3762}},
  //  so reading enf/blk alone (which ARE states 1 and 2, and nothing else) pinned every tool above T2 at zero.
  //  enf/blk stay as the fallback for the slot they do describe, so a worker predating `counts` shows T1/T2 exactly
  //  as it does today instead of collapsing to nothing.
  const materialPaintCounts = extruderColors.map((_color, extruderIndex) => {
    const perStateCount = paintStateCounts[extruderIndex + 1]
    if (Number.isFinite(perStateCount)) return perStateCount
    if (extruderIndex === 0) return paintCounts.enf
    if (extruderIndex === 1) return paintCounts.blk
    return 0
  })

  // Object actions (duplicate/copy/paste/delete/split + gizmo mode) — the bodies live in object_actions.js.
  const {
    duplicateSelected, copySelected, pasteClipboard, deleteSelected, deleteAllObjects, splitSelected, setGizmo,
  } = makeObjectActions({ ...wiring, setPaintMode, removeObject, refreshObjects, recordHistory })

  // Object toolbar — the button list lives in toolbar_items.js; only the actions are bound here.
  const OBJECT_TOOLS = objectTools({
    add: openFilePicker,
    remove: deleteSelected,
    removeAll: deleteAllObjects,
    duplicate: duplicateSelected,
    split: splitSelected,
    placeOnBed: () => { recordHistory(); apiRef.current?.placeOnBed() },
    objectCount: () => objects.length,
  })

  // ---- Keyboard shortcuts (upstream SPECS §4 + PrusaSlicer/Cura conventions) ----
  //  Which keys are live depends on Prepare/Preview. All are ignored while an input widget has focus.
  // features.shortcuts === false leaves keyRef null. The window listener in use_three_scene calls keyRef.current?.(e),
  //  so nothing is matched and nothing is preventDefault'd — which is the point: these bindings are global while the
  //  viewer is mounted, and Ctrl+C in particular would otherwise swallow a host page's own copy.
  keyRef.current = !feature('shortcuts') ? null : makeKeyHandler({
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
    selectAll: () => apiRef.current?.selectAllObjects(),
    // Both repeat while the key is held, so they record under a kind: history.js folds a run of them into the one
    //  entry that takes the object back to where it stood before the run started.
    rotateSelected: (rad) => { recordHistory('rotate'); apiRef.current?.rotateSelectedY(rad) },
    nudgeSelected: (dx, dy) => { recordHistory('nudge'); apiRef.current?.nudgeSelected(dx, dy); checkBed() },
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
      colorRange={colorRange} roleLegend={roleLegend} extruderColors={extruderColors} />
  )
  // The per-tool filament split and the purge total are kernel stats of the focused plate's cached result
  //  (`filament_mm_by_tool` / `filament_mm_purge` — the names wasm-core/test.mjs asserts). The `stats` state was
  //  reduced in use_slicer/plate_actions before those fields existed, so they are picked up from the raw result here
  //  instead of reshaping that reduction. A kernel that reports neither leaves both undefined, and StatsCard then
  //  renders exactly the single Filament line it always has.
  const kernelStats = plateResultsRef.current[selectedPlateRef.current]?.stats
  const statsWithTools = stats && {
    ...stats,
    filamentPerTool: Array.isArray(kernelStats?.filament_mm_by_tool) ? kernelStats.filament_mm_by_tool : undefined,
    filamentPurge: Number.isFinite(kernelStats?.filament_mm_purge) ? kernelStats.filament_mm_purge : undefined,
    filamentPurgePerTool: Array.isArray(kernelStats?.filament_mm_purge_by_tool) ? kernelStats.filament_mm_purge_by_tool : undefined,
  }
  // The material each filament is, read from the same settings map the filament card writes — so the legend says
  //  "T2 ABS 203.6 mm" rather than leaving the colour swatch to carry the whole identity.
  const asList = (key) => { const raw = settingRaw(settings, key); return Array.isArray(raw) ? raw : (raw ? [raw] : []) }
  // The tower's own outcome, so the card can show settings and result together. Tool changes are counted from the
  //  G-code because the kernel reports them only in the (opt-in) stats block, and the card must not depend on that.
  const lastResult = plateResultsRef.current[selectedPlateRef.current]
  const towerStats = lastResult?.stats && Number.isFinite(lastResult.stats.filament_mm_purge) ? {
    purge: lastResult.stats.filament_mm_purge,
    changes: (lastResult.gcode?.match(/^T\d+$/gm) ?? []).length,
    x: window.__vpParams?.prime_tower_x, y: window.__vpParams?.prime_tower_y,
  } : null
  // Once a slice exists the kernel's measurement is the better one — it was taken on the toolpaths that were
  //  actually emitted, so it counts support/skirt/brim, which the viewer's model-bbox check cannot see. Before the
  //  first slice there is nothing to read, and the viewer's own pre-slice measure is all there is.
  const slicedOver = stats?.overBedBy && (stats.overBedBy.x > 0 || stats.overBedBy.y > 0 || stats.overBedBy.z > 0)
    ? stats.overBedBy : null
  const bedOverShown = slicedOver ?? bedOver
  const bedOverText = overflowText(bedOverShown)

  const statsBlock = <StatsCard stats={statsWithTools} overBed={overBed} overBedText={bedOverText}
    overBedModel={stats?.overBedModel !== false} extruderColors={extruderColors}
    filamentTypes={asList('filament_type')} filamentIds={asList('filament_settings_id')} />

  // registerLoader() can add formats, so this is computed at render time.
  const EXT_LABEL = SUPPORTED_EXT.map(e => e.toUpperCase()).join(' · ')

  return (
    <ShadowHost css={shadowCss}>
    {/* Ctrl+Z is bound HERE, on the component's own root, not on window like the other shortcuts. It is the one
        shortcut a host application is likely to own as well (text fields, its own editor), so it must not leak out
        of the viewer — an element listener only fires when focus is inside, which is exactly the rule wanted. The
        canvas is given a tabIndex below so that clicking it counts as being inside. */}
    <div className="app-shell" onKeyDown={onShellKey}>
      {/* Shared hidden file input */}
      <input ref={fileInputRef} type="file" accept={SUPPORTED_EXT.map(e => '.' + e).join(',')} multiple onChange={e => { recordHistory(); onFiles(e) }} title={`${EXT_LABEL} (multiple files allowed)`} data-testid="stl-input" style={{ display: 'none' }} />
      <input ref={presetInputRef} type="file" accept={PRESET_ACCEPT}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) loadPresetFile(f) }}
        data-testid="preset-input" style={{ display: 'none' }} />

      {showPanel('topBar') && (
        <TopBar showTabs={ok} canvasMode={canvasMode} onCanvasMode={setCanvasMode}
          previewEnabled={layerCount > 0} onOpen={openFilePicker}
          onSaveProject={exportProject} onExportSTL={exportSTL} canSave={objects.length > 0} exporting={exporting}
          onUndo={() => travelHistory('undo')} onRedo={() => travelHistory('redo')}
          canUndo={historyDepth.undo > 0 && canvasMode === 'prepare'}
          canRedo={historyDepth.redo > 0 && canvasMode === 'prepare'} />
      )}

      <div className="app-body">
        {ok && canvasMode === 'prepare' && showPanel('gizmoRail') && (
          <GizmoRail gizmoMode={gmode} paintMode={paintMode}
            onGizmo={m => { setPaintMode('off'); apiRef.current?.setMode(m) }}
            onTogglePaint={togglePaintGizmo} />
        )}

        {/* Center viewport */}
        <div className="viewport-col">
          {/* tabIndex + focus on press: a plain div cannot receive key events, which is why every other shortcut
              had to live on window. Ctrl+Z is scoped to this component instead, and this is what lets a click on
              the 3D view count as "inside" it. */}
          <div className={(ok ? 'vp-canvas' : 'vp-canvas fail') + (dragOver ? ' drag-over' : '')} ref={mountRef}
            tabIndex={0} onPointerDown={() => mountRef.current?.focus({ preventScroll: true })}
            {...(feature('drop') ? { onDrop: e => { recordHistory(); onDrop(e) }, onDragOver, onDragLeave } : {})} data-testid="drop-zone">
            {!ok && <div className="vp-fallback">⚠ {status}</div>}
            {ok && objects.length === 0 && canvasMode !== 'preview' && showPanel('emptyHint') && (
              <div className="empty-hint" data-testid="empty-hint">
                <div className="eh-icon">📦</div>
                <div className="eh-title">Drag in a file or pick one</div>
                <div className="eh-sub">{EXT_LABEL}</div>
                <button className="eh-btn" onClick={openFilePicker} data-testid="empty-pick" title={`Pick a ${EXT_LABEL} file (multiple allowed)`}>Choose file</button>
              </div>
            )}
            {dragOver && <div className="drop-overlay" data-testid="drop-overlay">Drop here (STL/OBJ/3MF/AMF/PLY)</div>}
            {ctxMenu && (
              <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} canPaste={!!clipboardRef.current}
                selectedCount={selectedIds.length}
                actions={{
                  duplicate: duplicateSelected, copy: copySelected, split: splitSelected,
                  placeOnBed: () => apiRef.current?.placeOnBed(), remove: deleteSelected,
                  openFile: openFilePicker, paste: pasteClipboard,
                  zoomAll: () => apiRef.current?.frame(), zoomBed: () => apiRef.current?.frameBed(),
                  exportSelectedSTL, exportSelectedProject,
                }} />
            )}
            {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
          </div>

          {ok && canvasMode === 'prepare' && showPanel('objectToolbar') && <ObjectToolbar tools={OBJECT_TOOLS} />}

          {/* One brush, two targets — the panels are exclusive because the mode is. */}
          {ok && canvasMode === 'prepare' && supportPainting && showPanel('paintPanel') && (
            <PaintPanel paintMode={paintMode} onPaintMode={setPaintMode} onClear={clearPaint}
              brushRadius={brushRadius} paintCounts={paintCounts}
              paintTool={paintTool} onPaintTool={setPaintTool} brushCursor={brushCursor} onBrushCursor={setBrushCursor}
              fillAngle={fillAngle} onFillAngle={setFillAngle}
              onBrushRadius={setBrushRadius} />
          )}

          {ok && canvasMode === 'prepare' && paintMode === 'material' && showPanel('paintPanel') && (
            <MaterialPaintPanel colors={extruderColors} activeExtruder={materialExtruder}
              onSelectExtruder={startMaterialPaint} onClear={clearPaint} onClose={() => setPaintMode('off')}
              brushRadius={brushRadius} paintCounts={materialPaintCounts}
              paintTool={paintTool} onPaintTool={setPaintTool} brushCursor={brushCursor} onBrushCursor={setBrushCursor}
              fillAngle={fillAngle} onFillAngle={setFillAngle}
              onBrushRadius={setBrushRadius} />
          )}

          {/* Over-bed warning while arranging — the answer the stats card only gives after a slice */}
          {ok && canvasMode === 'prepare' && bedOver && showPanel('bedWarn') && (
            <div className="bed-warn" data-testid="bed-warn"
                 title="The printer cannot reach outside its printable volume. Move or rescale the model to export its G-code.">
              ⚠ Beyond the bed by {overflowText(bedOver)}
            </div>
          )}

          {/* Preview stats card, bottom left */}
          {ok && canvasMode === 'preview' && stats && showPanel('statsCard') && (
            <div className="stats-card" data-testid="slice-stats">{statsBlock}</div>
          )}

          {ok && showPanel('plateBar') && (
            <PlateBar plateCount={plateCount} selectedPlate={selectedPlate} maxPlates={MAX_PLATES}
              onSelect={selectPlate} onAdd={addPlate} onDelete={deletePlate} />
          )}

          {ok && showPanel('status') && <div className="vp-status" data-testid="vp-status">{status}</div>}
        </div>

        {/* S4 right sidebar */}
        {ok && showPanel('sidebar') && (
          <Panel name="sidebar"><aside className="sidebar">
            <div className="sidebar-scroll">
              {showPanel('printerCard') && (
                <Panel name="printerCard">
                  <PrinterCard bedWidth={kp.bed_width} bedDepth={kp.bed_depth} nozzleDia={nozzleDia} onBedSize={setBedSize}
                    settings={settings} setSettings={setSettings} motionPanel={motionPanel}
                    onExportPreset={exportPrinterPreset}
                    onImportPreset={feature('filePicker') ? openPresetPicker : null} />
                </Panel>
              )}

              {showPanel('filamentCard') && (
                <Panel name="filamentCard">
                  <FilamentCard colors={extruderColors} onColor={setExtColor} onAdd={addFilament} onRemove={removeFilament}
                    settings={settings} setSettings={setSettings} filamentPanel={filamentPanel}
                    paintMode={paintMode} onPaintExtruder={startMaterialPaint} paintCounts={materialPaintCounts} />
                </Panel>
              )}

              {objects.length > 0 && showPanel('objectList') && (
                <Panel name="objectList">
                <ObjectList objects={objects} extruderColors={extruderColors}
                  selectedIds={selectedIds}
                  onSelect={(id, additive) => apiRef.current?.selectObjects([id], additive)}
                  onToggleVisible={toggleObjVisible} onExtruder={setObjExtruder}
                  onSplit={id => { apiRef.current?.selectObject(id); splitSelected() }}
                  onRemove={id => { recordHistory(); removeObject(id) }}
                  supportOn={supportOn} onToggleSupport={onToggleSupport}
                  overhangOn={overhangOn} onToggleOverhang={e => setOverhangOn(e.target.checked)}
                  overhangAngle={overhangAngle} paintMode={paintMode} onTogglePaint={togglePaintGizmo}
                  supportStyle={supportStyle} supportStyles={supportStyles}
                  onSupportStyle={v => setSettings(s => ({ ...s, support_style: v }))}
                  supportFilament={supportFilament}
                  onSupportFilament={v => setSettings(s => ({ ...s, support_filament: v }))}
                  supportInterfaceFilament={supportInterfaceFilament}
                  onSupportInterfaceFilament={v => setSettings(s => ({ ...s, support_interface_filament: v }))} />
                </Panel>
)}

              {/* A prime tower only exists with a second filament, so the card appears with one. */}
              {extruderColors.length > 1 && showPanel('towerCard') && (
                <Panel name="towerCard">
                <TowerCard settings={settings} setSettings={setSettings} extruderColors={extruderColors}
                  wipeTowerReal={wipeTowerReal} onToggleWipeTower={e => setWipeTowerReal(e.target.checked)}
                  towerStats={towerStats} selectedPlate={selectedPlate} plateCount={plateCount} />
                </Panel>
)}
              {triWarn && <div className="slice-warn side-warn">⚠ {triWarn}</div>}
              {sliceNotice && <div className="slice-warn side-warn" data-testid="slice-notice">ℹ {sliceNotice}</div>}
              {error && <div className="slice-err side-warn" data-testid="slice-err">{error}</div>}
              {downgradeOffer && <button className="slice-btn" data-testid="downgrade-retry" onClick={retryDowngrade} title="Simplify the infill and lower its density to reduce memory pressure, then retry">Simplified retry (simple infill, economy mode)</button>}

              {/* Preview controls (view type / slider / legend) */}
              {canvasMode === 'preview' && previewControls && showPanel('previewControls') && (
                <Panel name="previewControls">
                <section className="side-card">
                  <div className="sc-head">🎚 Preview</div>
                  {previewControls}
                </section>
                </Panel>
)}

              {/* (3) Process (settings panel) */}
              {showPanel('processCard') && (
                <Panel name="processCard">
                <section className="side-card process-card" data-testid="process-section">
                  <div className="sc-head">⚙ Process</div>
                  {processPanel}
                </section>
                </Panel>
)}
            </div>

            {showPanel('sliceBar') && (
              <Panel name="sliceBar">
              <SliceBar autoSlice={autoSlice} onAutoSlice={setAutoSlice} slicing={slicing} progress={progress}
                plateCount={plateCount} selectedPlate={selectedPlate} sliceMenuOpen={sliceMenu}
                onSliceMenu={() => setSliceMenu(v => !v)} slicedPlateCount={slicedPlateCount}
                canSlice={objects.length > 0} onSlice={onSlice} onCancel={cancelSlice}
                onExportAll={exportAllGcode} gcodeUrl={gcodeUrl}
                bedWarning={bedOver || overBed
                  ? `${stats?.overBedModel === false ? 'the toolpaths extend' : 'the model extends'} beyond the bed`
                    + (bedOverText ? ` by ${bedOverText}` : '')
                  : ''} />
              </Panel>
)}
          </aside></Panel>
        )}
      </div>
    </div>
    </ShadowHost>
  )
}
