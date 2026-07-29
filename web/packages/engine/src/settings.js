// 우측 설정 패널(편집 가능)의 실제 값 → 커널 슬라이스 파라미터 매핑.
//  - 설정 상태는 sparse 맵(key→value): 편집한 키만 저장, 없으면 config-schema default.
//  - 벡터형(coFloats/coInts 등)은 첫 원소만 사용/편집(단순화).
import schema from '@orca-re/data/config-schema.json'

export function schemaDefault(key) { return schema[key]?.default }
export function settingRaw(settings, key) { return (settings && key in settings) ? settings[key] : schemaDefault(key) }
// 스칼라(벡터면 [0]) 로 정규화
export function settingScalar(settings, key) { const v = settingRaw(settings, key); return Array.isArray(v) ? v[0] : v }

// 8단계: 이식된 실제 Fill 패턴(gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/concentric) + 기존 근사 패턴
const KERNEL_PATTERNS = ['rectilinear', 'grid', 'triangles', 'zigzag', 'gyroid', 'gyroid_approx',
  'honeycomb', '3dhoneycomb', 'crosshatch', 'concentric']
const KERNEL_SEAMS = ['nearest', 'aligned', 'back', 'random']

// 우측 패널 설정값 → 커널 파라미터 (스키마 키에서 유도)
export function deriveKernelParams(settings) {
  const S = k => settingScalar(settings, k)
  const num = (k, d) => { const v = Number(S(k)); return Number.isFinite(v) ? v : d }
  const bool = (k, d) => { const v = settingRaw(settings, k); return typeof v === 'boolean' ? v : (Array.isArray(v) ? !!v[0] : (v == null ? d : !!v)) }

  let line_width = num('line_width', 0); if (!line_width) line_width = 0.42   // 0=auto → 기본 0.42

  let pat = String(S('sparse_infill_pattern') ?? 'rectilinear')
  if (!KERNEL_PATTERNS.includes(pat)) pat = 'rectilinear'                     // 커널 미지원 패턴 → rectilinear

  let seam = String(S('seam_position') ?? 'back')
  if (seam === 'aligned_back') seam = 'back'
  if (!KERNEL_SEAMS.includes(seam)) seam = 'back'

  // 서포트 스타일: 스키마 enum(default/grid/snug/organic/tree_slim/tree_strong/tree_hybrid)
  //  → 커널 grid|tree|tree_lite. 18단계부터 tree/organic 계열은 실 오가닉 TreeSupport('tree',
  //  generate_tree_support_3D → 실 type5 브랜치 툴패스)로 매핑, 그 외 grid.
  const styleRaw = String(S('support_style') ?? 'default')
  const support_style = /tree|organic/i.test(styleRaw) ? 'tree' : 'grid'

  // 베드: printable_area 첫 사각형의 바운딩박스
  const pa = settingRaw(settings, 'printable_area')
  let bed_width = 256, bed_depth = 256
  if (Array.isArray(pa) && pa.length) {
    const xs = pa.map(p => p[0]), ys = pa.map(p => p[1])
    bed_width = Math.max(...xs) - Math.min(...xs); bed_depth = Math.max(...ys) - Math.min(...ys)
  }

  // 21단계: 피처별 폭 — 원본(문자열 "120%" 포함) 그대로 커널로 전달. 미편집 키는 생략 → 커널이 auto(=line_width) 유도.
  //  0=자동 시맨틱은 커널 resolve_lw(원본 Flow 산식)이 처리. 기본값 불변(모든 피처 미설정 → line_width).
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
    brim_width: num('brim_width', 0),
    retract_length: num('retraction_length', 0.8),              // 벡터[0]
    retract_speed: num('retraction_speed', 30),
    z_hop: num('z_hop', 0.4),
    travel_speed: num('travel_speed', 120),
    first_layer_speed: num('initial_layer_speed', 30),
    print_speed: num('outer_wall_speed', 60),
    nozzle_diameter: num('nozzle_diameter', 0.4),
    filament_diameter: num('filament_diameter', 1.75),
    flow_ratio: num('filament_flow_ratio', 1.0),
    nozzle_temp: num('nozzle_temperature', 200),
    bed_temp: num('hot_plate_temp', 45),                        // bed_temperature 키 없음 → hot_plate_temp
    bed_width, bed_depth,
    enable_support: bool('enable_support', false),
    support_threshold_angle: num('support_threshold_angle', 30),
    support_top_z_distance: num('support_top_z_distance', 0.2),
    support_bottom_z_distance: num('support_bottom_z_distance', 0.2),   // 32단계: 서포트 바닥 z-gap(기본 0.2=현행 등가)
    support_xy_distance: num('support_object_xy_distance', 0.35),
    support_interface_top_layers: num('support_interface_top_layers', 2),
    raft_layers: num('raft_layers', 0),
    fan_speed: num('fan_max_speed', 100),                       // fan_speed 키 없음 → fan_max_speed
    close_fan_the_first_x_layers: num('close_fan_the_first_x_layers', 1),
    full_fan_speed_layer: num('full_fan_speed_layer', 0),
    slow_down_layer_time: num('slow_down_layer_time', 5),
    enable_arc_fitting: bool('enable_arc_fitting', false),
    spiral_mode: bool('spiral_mode', false),
    // 5단계 신규 (스키마 대응 키에서 유도)
    seam_slope_type: String(S('seam_slope_type') ?? 'none'),      // none|external|all → scarf 심
    enable_pressure_advance: bool('enable_pressure_advance', false),
    pressure_advance: num('pressure_advance', 0.02),
    support_style,                                                 // grid|tree_lite (위에서 매핑)
    bridge_speed: num('bridge_speed', 25),
    // 6단계 신규 (스키마 대응 키에서 유도). MM 파라미터(extruder_count/mm_group_split)는
    //  뷰어 오브젝트별 익스트루더 지정에서 onSlice 시 주입(여기선 미포함).
    ironing_type: String(S('ironing_type') ?? 'no ironing'),       // no ironing|top|topmost|solid (top류=on)
    ironing_spacing: num('ironing_spacing', 0.1),
    ironing_flow: num('ironing_flow', 10),
    ironing_speed: num('ironing_speed', 20),
    reduce_crossing_wall: bool('reduce_crossing_wall', false),
    max_volumetric_extrusion_rate_slope: num('max_volumetric_extrusion_rate_slope', 0),
    // 7단계: 벽 생성기 classic|arachne (arachne = 이식된 실제 OrcaSlicer WallToolPaths, 가변폭)
    wall_generator: (String(S('wall_generator') ?? 'classic') === 'arachne') ? 'arachne' : 'classic',
    // support_density 는 스키마에 대응 키가 없어 커널 기본(0.15), scarf_length 도 커널 기본(10mm) 사용
  }
}
