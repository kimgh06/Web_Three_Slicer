import * as THREE from 'three'
import { settingRaw } from 'three-slicer/settings'
import { buildSegmentData, roleRatios } from './toolpath_segments.js'
import { makeToolpath } from './toolpath_mesh.js'
import { computeColors } from './toolpath_views.js'

// Toolpath build (stage 24: upstream libvgcode GPU instancing / all plates rendered at once).
// The component keeps owning the refs/state; this factory only receives what it uses and is rebuilt each
//  render so the values it closes over (settings) stay fresh.
export function makeToolpathView(deps) {
  const {
    three, plateTpRef, toolpathRef, segDataRef, layersDataRef, plateResultsRef, plateOffsetsRef,
    lineWidthRef, showTravelRef, viewTypeRef, layerLoRef, layerHiRef, selectedPlateRef, extruderColorsRef,
    settings, setSegCount, setColorRange, setRoleLegend,
  } = deps

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
      // The filament palette, so the Filament view can paint each tool in its own colour rather than a stand-in.
      toolColors: extruderColorsRef?.current ?? [],
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

  return { disposePlateToolpath, clearToolpaths, buildPlateToolpath, ensurePlateToolpaths, viewCtx, applyViewColors, rebuildToolpaths, applyLayerRange }
}
