// Maps the actual values of the (editable) right-hand settings panel -> kernel slice parameters.
//  - Settings state is a sparse map (key->value): only edited keys are stored, otherwise the config-schema default.
//  - For vector types (coFloats/coInts, …) only the first element is used/edited (simplification).
import { schema } from './data.js'

export function schemaDefault(key) { return schema[key]?.default }
export function settingRaw(settings, key) { return (settings && key in settings) ? settings[key] : schemaDefault(key) }
// Normalize to a scalar ([0] for vectors)
export function settingScalar(settings, key) { const v = settingRaw(settings, key); return Array.isArray(v) ? v[0] : v }

// Stage 8: real ported Fill patterns (gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/concentric) + the older approximations
const KERNEL_PATTERNS = ['rectilinear', 'grid', 'triangles', 'zigzag', 'gyroid', 'gyroid_approx',
  'honeycomb', '3dhoneycomb', 'crosshatch', 'concentric']
const KERNEL_SEAMS = ['nearest', 'aligned', 'back', 'random']

// Right-panel settings values -> kernel parameters (derived from schema keys)
export function deriveKernelParams(settings) {
  const S = k => settingScalar(settings, k)
  const num = (k, d) => { const v = Number(S(k)); return Number.isFinite(v) ? v : d }
  const bool = (k, d) => { const v = settingRaw(settings, k); return typeof v === 'boolean' ? v : (Array.isArray(v) ? !!v[0] : (v == null ? d : !!v)) }

  let line_width = num('line_width', 0); if (!line_width) line_width = 0.42   // 0=auto -> default 0.42

  let pat = String(S('sparse_infill_pattern') ?? 'rectilinear')
  if (!KERNEL_PATTERNS.includes(pat)) pat = 'rectilinear'                     // pattern unsupported by the kernel -> rectilinear

  let seam = String(S('seam_position') ?? 'back')
  if (seam === 'aligned_back') seam = 'back'
  if (!KERNEL_SEAMS.includes(seam)) seam = 'back'

  // Support style: schema enum (default/grid/snug/organic/tree_slim/tree_strong/tree_hybrid)
  //  -> kernel grid|tree|tree_lite. Since stage 18 the tree/organic family maps to the real organic TreeSupport ('tree',
  //  generate_tree_support_3D -> real type5 branch toolpaths); everything else maps to grid.
  const styleRaw = String(S('support_style') ?? 'default')
  const support_style = /tree|organic/i.test(styleRaw) ? 'tree' : 'grid'

  // Bed: bounding box of the first rectangle in printable_area
  const pa = settingRaw(settings, 'printable_area')
  let bed_width = 256, bed_depth = 256
  if (Array.isArray(pa) && pa.length) {
    const xs = pa.map(p => p[0]), ys = pa.map(p => p[1])
    bed_width = Math.max(...xs) - Math.min(...xs); bed_depth = Math.max(...ys) - Math.min(...ys)
  }

  // Stage 21: per-feature widths — passed to the kernel verbatim (including strings like "120%"). Unedited keys are omitted -> the kernel derives auto(=line_width).
  //  The 0=auto semantics are handled by the kernel's resolve_lw (upstream Flow formula). Defaults unchanged (no feature set -> line_width).
  const widths = {}
  for (const k of ['outer_wall_line_width','inner_wall_line_width','top_surface_line_width',
                   'sparse_infill_line_width','internal_solid_infill_line_width','initial_layer_line_width']) {
    const v = S(k); if (v != null && v !== '') widths[k] = v
  }
  return {
    ...widths,
    layer_height: num('layer_height', 0.2),
    first_layer_height: num('initial_layer_print_height', 0.2),
    line_width,
    wall_loops: num('wall_loops', 2),
    infill_density: num('sparse_infill_density', 20) / 100,      // % → 0~1
    sparse_infill_pattern: pat,
    infill_angle: num('infill_direction', 45),
    top_shell_layers: num('top_shell_layers', 4),
    bottom_shell_layers: num('bottom_shell_layers', 3),
    seam_position: seam,
    skirt_loops: num('skirt_loops', 1),
    skirt_distance: num('skirt_distance', 2),
    skirt_height: num('skirt_height', 1),                       // stage 33: the kernel used to hardcode the first layer
    brim_width: num('brim_width', 0),
    brim_object_gap: num('brim_object_gap', 0),                 // stage 33: the kernel used to hardcode w*0.5
    retract_length: num('retraction_length', 0.8),              // vector[0]
    retraction_minimum_travel: num('retraction_minimum_travel', 2),  // stage 33: used to be the kernel constant 2.0
    gcode_resolution: num('resolution', 0.01),                  // stage 33: tree-support path simplification tolerance
    retract_speed: num('retraction_speed', 30),
    z_hop: num('z_hop', 0.4),
    travel_speed: num('travel_speed', 120),
    first_layer_speed: num('initial_layer_speed', 30),
    print_speed: num('outer_wall_speed', 60),
    nozzle_diameter: num('nozzle_diameter', 0.4),
    filament_diameter: num('filament_diameter', 1.75),
    flow_ratio: num('filament_flow_ratio', 1.0),
    nozzle_temp: num('nozzle_temperature', 200),
    bed_temp: num('hot_plate_temp', 45),                        // no bed_temperature key -> hot_plate_temp
    bed_width, bed_depth,
    enable_support: bool('enable_support', false),
    support_threshold_angle: num('support_threshold_angle', 30),
    support_top_z_distance: num('support_top_z_distance', 0.2),
    support_bottom_z_distance: num('support_bottom_z_distance', 0.2),   // stage 32: support bottom z-gap (default 0.2 = equivalent to current behavior)
    support_xy_distance: num('support_object_xy_distance', 0.35),
    support_interface_top_layers: num('support_interface_top_layers', 2),
    // Stage 33: support keys added when the kernel hardcoding was removed (upstream schema key names kept)
    support_angle: num('support_angle', 0),
    support_base_pattern: String(S('support_base_pattern') ?? 'default'),
    support_interface_pattern: String(S('support_interface_pattern') ?? 'auto'),
    support_interface_spacing: num('support_interface_spacing', 0.5),
    support_base_pattern_spacing: num('support_base_pattern_spacing', 2.5),
    support_remove_small_overhang: bool('support_remove_small_overhang', true),
    bridge_no_support: bool('bridge_no_support', false),
    support_expansion: num('support_expansion', 0),
    support_threshold_overlap: (() => { const v = settingRaw(settings, 'support_threshold_overlap')
      if (typeof v === 'string' && v.trim().endsWith('%')) return parseFloat(v) / 100
      const n = Number(v); return Number.isFinite(n) ? n : 0.5 })(),   // "50%" -> 0.5 (ratio of extrusion width)
    support_on_build_plate_only: bool('support_on_build_plate_only', false),
    support_interface_bottom_layers: num('support_interface_bottom_layers', 0),
    raft_layers: num('raft_layers', 0),
    raft_expansion: num('raft_expansion', 1.5),                 // stage 33: the kernel used to hardcode +3.0
    raft_contact_distance: num('raft_contact_distance', 0.1),   // stage 33: previously ignored by the kernel
    fan_speed: num('fan_max_speed', 100),                       // no fan_speed key -> fan_max_speed
    close_fan_the_first_x_layers: num('close_fan_the_first_x_layers', 1),
    full_fan_speed_layer: num('full_fan_speed_layer', 0),
    slow_down_layer_time: num('slow_down_layer_time', 5),
    enable_arc_fitting: bool('enable_arc_fitting', false),
    spiral_mode: bool('spiral_mode', false),
    // New in stage 5 (derived from the matching schema keys)
    seam_slope_type: String(S('seam_slope_type') ?? 'none'),      // none|external|all -> scarf seam
    enable_pressure_advance: bool('enable_pressure_advance', false),
    pressure_advance: num('pressure_advance', 0.02),
    support_style,                                                 // grid|tree_lite (mapped above)
    bridge_speed: num('bridge_speed', 25),
    // New in stage 6 (derived from the matching schema keys). The MM parameters (extruder_count/mm_group_split) are
    //  injected at onSlice time from the viewer's per-object extruder assignment (not included here).
    ironing_type: String(S('ironing_type') ?? 'no ironing'),       // no ironing|top|topmost|solid (the top family = on)
    ironing_spacing: num('ironing_spacing', 0.1),
    ironing_flow: num('ironing_flow', 10),
    ironing_speed: num('ironing_speed', 20),
    reduce_crossing_wall: bool('reduce_crossing_wall', false),
    max_volumetric_extrusion_rate_slope: num('max_volumetric_extrusion_rate_slope', 0),
    // Stage 7: wall generator classic|arachne (arachne = the real ported OrcaSlicer WallToolPaths, variable width)
    wall_generator: (String(S('wall_generator') ?? 'classic') === 'arachne') ? 'arachne' : 'classic',
    // support_density has no matching schema key, so the kernel default (0.15) is used; scarf_length likewise uses the kernel default (10mm)
  }
}
