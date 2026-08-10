// params.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#pragma once
#include <string>
#include <vector>

// ---- Parameters (stage-1 names unchanged + stage-2 additions) ------------------
struct Params {
  double layer_height=0.2, first_layer_height=0.2, line_width=0.42;
  // Stage 21: per-feature extrusion width (0 = derive automatically). 0 resolves at parse time to line_width (>0) or the upstream Flow auto (nozzle based).
  double outer_wall_line_width=0, inner_wall_line_width=0, top_surface_line_width=0;
  double sparse_infill_line_width=0, internal_solid_infill_line_width=0, initial_layer_line_width=0;
  int    wall_loops=2;
  double infill_density=0.15, nozzle_diameter=0.4, filament_diameter=1.75, flow_ratio=1.0;
  double print_speed=60, first_layer_speed=20, travel_speed=150;
  double nozzle_temp=210, bed_temp=60;
  // New in stage 2 (defaults follow the matching config-schema.json keys)
  int    top_shell_layers=4, bottom_shell_layers=3;   // top_shell_layers/bottom_shell_layers
  int    skirt_loops=1;                                // skirt_loops
  double skirt_distance=2.0, brim_width=0.0;           // skirt_distance / brim_width
  double retract_length=0.8, retract_speed=30.0, z_hop=0.4; // retraction_length/speed[0], z_hop[0]
  double infill_angle=45.0;                            // infill_direction
  // New in stage 3 (defaults follow the matching config-schema.json keys / coordinate adjustment directives)
  bool   enable_support=false;                         // enable_support
  double support_threshold_angle=30.0;                 // support_threshold_angle
  double support_density=0.15;                         // density of the support body
  double support_top_z_distance=0.2;                   // support_top_z_distance
  double support_bottom_z_distance=0.2;                // stage 32: z gap under support resting on a model top surface (default 0.2 = equivalent to today's 1 layer -> default behavior and golden unchanged)
  double support_xy_distance=0.35;                     // support_object_xy_distance
  int    support_interface_top_layers=2;               // support_interface_top_layers
  bool   support_auto=true;                             // stage 20: true = automatic overhang detection, false = manual (painted enforcers only)
  double support_line_width=0.0;                        // support_line_width (0=auto; the real tree support extrusion width)
  // Stage 33: hardcoding removed — wired to the upstream setting keys (defaults match the upstream config-schema defaults)
  double support_angle=0.0;                             // support_angle: base angle of the support body (°). Upstream SupportParameters::base_angle
  std::string support_base_pattern="default";           // support_base_pattern: default|rectilinear|rectilinear-grid|honeycomb|...
  std::string support_interface_pattern="auto";         // support_interface_pattern: auto|rectilinear|concentric|rectilinear_interlaced|grid
  double support_interface_spacing=0.5;                 // support_interface_spacing (mm, 0=solid). Upstream default 0.5
  double support_base_pattern_spacing=2.5;              // support_base_pattern_spacing (mm). Determines spacing together with density
  double support_overhang_min_area=0.0;                 // minimum overhang area (mm², 0 = auto w²). Replaces the morphological opening filter
  bool   support_remove_small_overhang=true;            // support_remove_small_overhang (upstream default true)
  bool   bridge_no_support=false;                       // bridge_no_support: no support under bridge regions
  double support_expansion=0.0;                         // support_expansion (mm): expands the overhang region
  double support_threshold_overlap=0.5;                 // support_threshold_overlap: the overlap criterion when θ=0 (as a fraction of extrusion width)
  bool   support_on_build_plate_only=false;             // support_on_build_plate_only: only support reaching the bed
  int    support_interface_bottom_layers=0;             // support_interface_bottom_layers (0 = none)
  bool   support_grid_snap=true;                        // equivalent of the upstream SupportGridPattern (default behavior of the grid style)
  double tree_lite_shrink=0.5, tree_lite_min_radius=1.5;// tree_lite taper constants (our own approximation — no matching upstream key)
  // WP1: shape keys for the real tree support (support_style=tree) — defaults identical to the upstream PrintConfig defaults
  std::string tree_style="organic";                     // organic|slim|strong|hybrid (upstream support_style smsTree*)
  double tree_support_branch_angle=40.0;                // tree_support_branch_angle_organic (deg)
  double tree_support_angle_slow=25.0;                  // tree_support_angle_slow (deg)
  double tree_support_branch_diameter=2.0;              // tree_support_branch_diameter_organic (mm)
  double tree_support_branch_distance=1.0;              // tree_support_branch_distance_organic (mm)
  double tree_support_branch_diameter_angle=5.0;        // tree_support_branch_diameter_angle (deg)
  double tree_support_tip_diameter=0.8;                 // tree_support_tip_diameter (mm)
  double tree_support_top_rate=30.0;                    // tree_support_top_rate (%)
  int    tree_support_wall_count=0;                     // tree_support_wall_count (organic applies max(1,·) internally)
  double printable_height=250.0;                        // printable_height (mm) — the tree BuildVolume height
  bool   independent_support_layer_height=false;        // false by default because of the kernel z grid constraint (gap quantized to layers)
  double support_object_first_layer_gap=0.2;            // support_object_first_layer_gap (mm)
  int    raft_layers=0;                                // raft_layers
  double raft_expansion=1.5;                           // raft_expansion (mm). Upstream default 1.5 (previously hardcoded to 3.0)
  double raft_contact_distance=0.1;                    // raft_contact_distance (mm)
  double raft_first_layer_height=0.30;                 // raft first layer height (mm)
  int    skirt_height=1;                               // skirt_height: how many layers the skirt is drawn on
  double brim_object_gap=0.0;                          // brim_object_gap (mm): gap between brim and object
  double retraction_minimum_travel=2.0;                // retraction_minimum_travel (mm): minimum travel that triggers a retraction
  double gcode_resolution=0.01;                        // resolution (mm): path simplification tolerance. Upstream PrintConfig default 0.01
  // wipe_tower_x/y (G-code coordinates, mm). The upstream schema default is (15, 220), but that assumes a 256mm bed and
  //  falls off a 200mm bed. The kernel default stays at a corner safe on any bed (10,10), and the upstream coordinates
  //  are used only when the UI/consumer passes them explicitly (preserving existing behavior).
  double prime_tower_x=10.0, prime_tower_y=10.0;
  double prime_tower_ring_size=15.0;                   // side length of the fallback square ring (mm)
  double bed_width=256.0, bed_depth=256.0;             // bed size (offset = bed/2)
  double bed_height=0.0;                                // printable_height (mm). 0 = no ceiling (backwards compatible)
  std::string machine_start_gcode, machine_end_gcode;   // printer profile custom G-code. Empty = the mini-kernel's own preamble/footer only
  // New in stage 4 (path and G-code level)
  std::string sparse_infill_pattern="rectilinear";     // rectilinear|grid|triangles|zigzag|gyroid
  double fan_speed=100.0;                               // fan_speed (%)
  int    close_fan_the_first_x_layers=1;               // close_fan_the_first_x_layers
  int    full_fan_speed_layer=3;                        // full_fan_speed_layer
  double slow_down_layer_time=8.0;                      // slow_down_layer_time (s)
  bool   enable_arc_fitting=false;                      // enable_arc_fitting
  std::string seam_position="back";                     // nearest|aligned|back|random
  bool   spiral_mode=false;                             // spiral_mode (vase)
  // New in stage 5 (gap fill · thin wall · scarf · pressure advance · tree-lite · bridge)
  std::string seam_slope_type="none";                   // none|external|all -> scarf seam (external/all = on)
  double scarf_length=10.0;                              // length of the scarf z/flow ramp (mm)
  bool   enable_pressure_advance=false;                 // enable_pressure_advance[0]
  double pressure_advance=0.02;                          // pressure_advance[0]
  std::string support_style="grid";                     // grid|tree_lite
  double bridge_speed=25.0;                              // bridge_speed[0] (slowdown for unsupported bottoms)
  // New in stage 6 (ironing · wall avoidance · PE-lite · multi-material)
  std::string ironing_type="none";                      // none|top|topmost|solid (the top family = on)
  double ironing_spacing=0.1;                           // ironing line spacing (mm)
  double ironing_flow=10.0;                             // ironing flow (%)
  double ironing_speed=30.0;                            // ironing speed (mm/s)
  bool   reduce_crossing_wall=false;                    // wall-avoiding travel
  double max_volumetric_extrusion_rate_slope=0.0;       // PE-lite flow change rate limit (mm³/s², 0=off)
  int    extruder_count=1;                              // multi-material: how many extruders are used (1|2)
  // Per-extruder filament values, indexed by tool: a two-material print wants ABS at 270 on T0 and PLA at 220 on
  //  T1, which the scalars above cannot express. Empty (the default) means every tool uses the scalar, so a
  //  single-material slice — and any host that never sends these — behaves exactly as before.
  std::vector<double> extruder_nozzle_temp, extruder_filament_diameter, extruder_flow_ratio,
                      extruder_retract_length, extruder_retract_speed, extruder_z_hop;
  static double forTool(const std::vector<double>& per, int tool, double fallback) {
    return (tool >= 0 && tool < (int)per.size()) ? per[tool] : fallback;
  }
  int    mm_group_split=0;                              // triangle group boundary index ([0,split)=T0, [split,N)=T1)
  bool   auto_center=false;                             // stage 28: true = realign the combined bbox to the origin (stage-3 legacy). false (default) = trust the viewer coordinates (no realignment, only Z seating) -> the toolpath overlaps the on-screen model exactly. Upstream = only the plate origin offset (GCode.cpp:932).
  // Stage 33: the default switched to true. Evidence (compare_wipetower.mjs measurements, 2-box MM):
  //  the real path succeeded on 49/49 layers without a fallback, purge volumes are actually computed (filament 1098 -> 4902mm),
  //  the upstream G-code structure is emitted (343 CP TOOLCHANGE/WIPE_TOWER markers), and there is no performance penalty (25ms vs 31ms).
  //  The old false path (three 15mm square rings) is decoration with no notion of purging and unfit for real G-code — kept only as a fallback.
  bool   wipe_tower_real=true;                          // stage 12: use the real WipeTower.generate() on MM changes instead of the stage-6 square ring
  double prime_tower_width=30.0;                        //  width of the real WipeTower (mm). Separate from the square ring width (15).
  // New in stage 7 (the real Arachne port)
  std::string wall_generator="classic";                // classic|arachne (arachne = the real ported WallToolPaths)
  // New in stage 8 (the real PressureEqualizer port)
  //  ⚠ pe_lite=true by default: the real PE only adjusts flow in g-code carrying OrcaSlicer's ;_EXTRUDE_SET_SPEED tags, and
  //    this mini kernel emits plain g-code, so the real PE passes through (no-op). Hence the effective PE-lite is
  //    the default and the real PE is opt-in via pe_lite=false (port/link/run/E-preservation verified; the tag requirement is recorded as a limitation).
  bool   pe_lite=true;                                  // true = the effective PE-lite (default), false = the ported real PE (tagged g-code)
  double extrusion_rate_slope_segment_length=1.0;       // segment split length for the real PE (mm)
  bool   pe_external_perimeter_only=false;              // real PE: smooth outer walls only
  // Stage 9: full real PE integration — the kernel emits the OrcaSlicer tags (;_EXTRUDE_SET_SPEED/;_EXTRUDE_END/;_EXTRUSION_ROLE)
  bool   emit_pe_tags=false;                            // emit PE tags on extrusion runs (enabled automatically when the real PE is used). Default false (backwards compatible)
  bool   pe_strip_tags=true;                            // strip the tags from the final output after real PE post-processing
  // Stage 10: machine limits for the time estimate (upstream machine_max_*/machine_min_*, defaulting to representative profile values). Tunable.
  double machine_accel_print=5000, machine_accel_travel=5000, machine_accel_retract=5000; // mm/s²
  double machine_jerk_xy=9.0, machine_jerk_z=0.4, machine_jerk_e=2.5;                       // mm/s
  double machine_max_speed_xy=500, machine_max_speed_z=12, machine_max_speed_e=30;          // mm/s
  double machine_max_accel_xy=5000, machine_max_accel_z=500, machine_max_accel_e=5000;      // mm/s² (machine_max_acceleration_*) — per-axis ceiling, distinct from the accel_* feedrates above
  // Stage 13: time estimation engine. full = the real ported GCodeProcessor itself (the new default), transcribed = the stage-10 gcode_time transcription.
  std::string time_engine="full";
  // Stage 30: economy mode — the last rung of the OOM retry ladder that still finishes. Skips emitting preview toolpaths (empty arrays)
  //  and the time estimate (r.moves would stay resident in bulk) -> only G-code is streamed out to the end. Effective only on the
  //  streaming path with a layer sink installed (default false — no effect on the batch path).
  bool   economy=false;
  // G003 incremental: decided and requested by the viewer (invalidation-map). 0 = full, 1 = reuse geometry (tris), 2 = reuse through support (L[]).
  int    reuse_stages=0;
  bool   keep_stages=false;                             // keep the stages cached after slicing (skips the early release — a memory trade-off)
  bool   arachne_dump=false;   // temporary diagnostic: dump the PASS1 arachne input polygons to stderr
};

Params parse_params(const std::string& j);
