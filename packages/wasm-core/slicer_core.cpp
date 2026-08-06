// =============================================================================
// slicer_core.cpp — the browser-only slicing mini kernel (track C, stage 3)
//
//  stage 1 (hollow shell) -> stage 2 (solid shell, skirt/brim, ASCII, z_hop, seam, worker progress)
//  -> stage 3 (support, raft, bed, multiple objects, monotonic)
//  -> stage 4 (path and G-code level):
//    · infill patterns: rectilinear/grid/triangles/zigzag (continuous path)/gyroid (sine approximation, z phase)
//    · cooling: fan ramp (M106 close -> full, linear) + slowdown for small layers (slow_down_layer_time)
//    · arc fitting: approximate consecutive segments with arcs -> G2/G3 (enable_arc_fitting)
//    · seam position: back/nearest/aligned/random (deterministic LCG)
//    · spiral (vase): a single outer wall rising continuously in z (spiral_mode)
//
//  -> stage 5 (quality / approximation features):
//    · gap fill (type7): the leftover of fill's morphological open (thin gaps) -> single-width center line approximation
//    · thin wall, Arachne-lite (type8): regions narrower than 2w -> one center line instead of walls + local width flow correction
//    · scarf seam (seam_slope_type=external/all): outer wall start z/flow ramp-up + end overlap ramp-down, ; scarf
//    · pressure advance (enable_pressure_advance): M900 K<v> in the preamble (noted as a comment for Klipper)
//    · tree-lite support (support_style=tree_lite): downward taper (-0.5mm per layer, minimum pillar r1.5mm) + union
//    · bridge (type9): unsupported bottom solid -> fan 100% + bridge_speed slowdown
//  -> stage 6 (closing the parity gap):
//    · ironing (type10, ironing_type): a low-flow second pass over exposed top solid (spacing/flow%/speed)
//    · wall-avoiding travel (reduce_crossing_wall): route around island boundaries + the stats.wall_crossings cross-check
//    · PressureEqualizer-lite (max_volumetric_extrusion_rate_slope): limits the flow change rate between adjacent segments (speed only)
//    · multi-material basics (extruder_count/mm_group_split): sliced per group + T0/T1 + prime tower (type11)
//  -> stage 7 (real port): wall_generator=arachne -> variable-width walls from the real ported OrcaSlicer Arachne WallToolPaths
//    (via arachne_bridge). Per-segment width -> E calculation (set_e_per_mm_width) + the widths[] toolpath array.
//    classic remains the default (backwards compatible). ⚠ Only the CGAL planarity recovery is stubbed; the rest of Arachne is upstream.
//  -> stage 8 (more real ports): the real OrcaSlicer Fill patterns (gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/
//    concentric, via fill_bridge — gyroid is replaced by the real TPMS and the old sine approximation is preserved as gyroid_approx) +
//    the real PressureEqualizer (pe_bridge, opt-in via pe_lite=false).
//  -> stage 9 (full integration): the real PE fully working — with emit_pe_tags the kernel emits the OrcaSlicer tags (;_EXTRUSION_ROLE/
//    ;_EXTRUDE_SET_SPEED/;_EXTRUDE_END) so the real PE inserts per-segment F ramps (more G1 lines, E preserved), and pe_strip_tags
//    removes the tags at the end. + the TreeSupport core MST (tree_bridge, branch merging) ported — the full pipeline's PrintObject coupling is not.
//  -> stage 10 (upstream time estimate): the ported GCodeProcessor trapezoidal planner (gcode_time.{h,cpp} — the upstream algorithm transcribed
//    verbatim + machine limit parameters injected) parses the emitted g-code to produce stats.time_estimate (total/per layer/per role). The viewer
//    shows the estimate. The full GCodeProcessor and WipeTower are gated on the config subsystem (the real PrintConfig.hpp) — noted in the README.
//
//  ⚠ It is still a mini kernel. Unimplemented/approximate limits -> would need a full libslic3r port:
//    the complete Arachne skeleton (variable width), organic tree support, a proper wipe tower, precise PressureEqualizer,
//    complete wall avoidance, non-planar.
//
//  Pipeline (multi-pass): STL -> [p1] intersect, chain, union, walls, surface detection -> [p1.6] support
//    -> [p2] solid/sparse (patterns) split -> raft -> cooling/slowdown/seam/arc -> G-code (SPECS §6.2)
//  Coordinates: the model is moved so XY is centered on the origin and minZ=0. The G-code is shifted by +(bed/2) to stay positive.
// =============================================================================
#include "clipper.hpp"
#include "arachne_bridge.h"   // stage 7: bridge to the real ported OrcaSlicer Arachne (variable-width walls)
#include "fill_bridge.h"      // stage 8: bridge to the real ported OrcaSlicer Fill patterns (gyroid TPMS, …)
#include "pe_bridge.h"        // stage 8: bridge to the real ported OrcaSlicer PressureEqualizer (segment splitting)
#include "gcode_time.h"       // stage 10: the ported GCodeProcessor time estimation algorithm (upstream trapezoidal planner)
#include "config_bridge.h"    // stage 12: boundary bridge to the real config subsystem (print_config_def)
#include "gcodeproc_bridge.h" // stage 13: boundary bridge to the real ported GCodeProcessor itself (time_engine=full)
#include "treesupport_bridge.h" // stages 17/18: boundary bridge to the real organic TreeSupport (generate_tree_support_3D)
#include "selector_bridge.h"    // stage 20: boundary bridge for manual support painting (TriangleSelector enforcer/blocker)
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <emscripten/heap.h>   // stage 30: emscripten_get_heap_size() — heap peak benchmarking (monotonic under ALLOW_MEMORY_GROWTH)
#include <emscripten/emscripten.h>  // emscripten_get_now() — phase timing
#include <thread>    // (mt) PASS 1 layers in parallel — only used in __EMSCRIPTEN_PTHREADS__ builds
#include <atomic>
#include <mutex>     // (mt) time estimate overlap queue — only used in __EMSCRIPTEN_PTHREADS__ builds
#include <condition_variable>
#include <deque>
#include <vector>
#include <string>
#include <unordered_map>
#include <map>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cctype>
#include <algorithm>

using namespace ClipperLib;
namespace em = emscripten;

static const double SCALE  = 1e6;          // mm -> clipper integer coordinates
static const double INV    = 1.0 / SCALE;
static const double PI     = 3.14159265358979323846;
// Stage 33: BED_CENTER (=128.0, assuming a 256mm bed) removed — it was declared and never referenced (measured).
//  The bed center is actually computed as gw.offX/offY = bed_width/depth * 0.5.
// TRAVEL_RETRACT_MIN was removed too — wired to p.retraction_minimum_travel instead.

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
static size_t jfind_val(const std::string& s, const char* key) {
  std::string k = std::string("\"") + key + "\"";
  size_t p = s.find(k);
  if (p == std::string::npos) return std::string::npos;
  p = s.find(':', p + k.size());
  if (p == std::string::npos) return std::string::npos;
  ++p;
  while (p < s.size() && (s[p]==' '||s[p]=='\t'||s[p]=='\n')) ++p;
  return p;
}
static double jget(const std::string& s, const char* key, double d) {
  size_t p = jfind_val(s, key);
  return (p == std::string::npos) ? d : std::strtod(s.c_str() + p, nullptr);
}
static bool jbool(const std::string& s, const char* key, bool d) {
  size_t p = jfind_val(s, key);
  if (p == std::string::npos) return d;
  if (s.compare(p, 4, "true") == 0)  return true;
  if (s.compare(p, 5, "false") == 0) return false;
  return std::strtod(s.c_str() + p, nullptr) != 0.0;   // 1/0 accepted too
}
static std::string jstr(const std::string& s, const char* key, const std::string& d) {
  size_t p = jfind_val(s, key);
  if (p == std::string::npos || p >= s.size() || s[p] != '"') return d;
  ++p; std::string out;
  while (p < s.size() && s[p] != '"') { out += s[p]; ++p; }
  return out.empty() ? d : out;
}
// Stage 21: reading a coFloatOrPercent width — "120%" -> nozzle*1.2; a number -> as-is; absent -> 0 (the auto-derive marker).
static double jwidth_raw(const std::string& s, const char* key, double nozzle) {
  size_t p = jfind_val(s, key);
  if (p == std::string::npos) return 0.0;
  if (s[p] == '"') { std::string v; size_t q = p + 1; while (q < s.size() && s[q] != '"') { v += s[q]; ++q; }
    if (!v.empty() && v.back() == '%') return std::strtod(v.c_str(), nullptr) * 0.01 * nozzle;
    return std::strtod(v.c_str(), nullptr); }
  return std::strtod(s.c_str() + p, nullptr);
}
// Upstream Flow::auto_extrusion_width (src/libslic3r/Flow.cpp:21): top-surface/support = nozzle_diameter,
//  everything else (outer/inner wall, sparse, solid) = 1.125 * nozzle_diameter.
static double auto_lw(double nozzle, bool top_or_support) { return top_or_support ? nozzle : 1.125 * nozzle; }
// Feature width resolution: value>0 -> as-is · 0 -> line_width (>0) · line_width also 0 -> the upstream auto. (default line_width=0.42 -> default behavior unchanged)
static double resolve_lw(double raw, double nozzle, double base_lw, bool top_or_support) {
  if (raw > 0) return raw;
  if (base_lw > 0) return base_lw;
  return auto_lw(nozzle, top_or_support);
}

static Params parse_params(const std::string& j) {
  Params p;
  p.layer_height       = jget(j,"layer_height",p.layer_height);
  p.first_layer_height = jget(j,"first_layer_height",p.first_layer_height);
  p.line_width         = jget(j,"line_width",p.line_width);
  p.wall_loops         = (int)jget(j,"wall_loops",p.wall_loops);
  p.infill_density     = jget(j,"infill_density",p.infill_density);
  p.nozzle_diameter    = jget(j,"nozzle_diameter",p.nozzle_diameter);
  p.filament_diameter  = jget(j,"filament_diameter",p.filament_diameter);
  p.flow_ratio         = jget(j,"flow_ratio",p.flow_ratio);
  p.print_speed        = jget(j,"print_speed",p.print_speed);
  p.first_layer_speed  = jget(j,"first_layer_speed",p.first_layer_speed);
  p.travel_speed       = jget(j,"travel_speed",p.travel_speed);
  p.nozzle_temp        = jget(j,"nozzle_temp",p.nozzle_temp);
  p.bed_temp           = jget(j,"bed_temp",p.bed_temp);
  p.top_shell_layers   = (int)jget(j,"top_shell_layers",p.top_shell_layers);
  p.bottom_shell_layers= (int)jget(j,"bottom_shell_layers",p.bottom_shell_layers);
  p.skirt_loops        = (int)jget(j,"skirt_loops",p.skirt_loops);
  p.skirt_distance     = jget(j,"skirt_distance",p.skirt_distance);
  p.brim_width         = jget(j,"brim_width",p.brim_width);
  p.retract_length     = jget(j,"retract_length",p.retract_length);
  p.retract_speed      = jget(j,"retract_speed",p.retract_speed);
  p.z_hop              = jget(j,"z_hop",p.z_hop);
  p.infill_angle       = jget(j,"infill_angle",p.infill_angle);
  p.enable_support     = jbool(j,"enable_support",p.enable_support);
  p.support_threshold_angle       = jget(j,"support_threshold_angle",p.support_threshold_angle);
  p.support_density               = jget(j,"support_density",p.support_density);
  p.support_top_z_distance        = jget(j,"support_top_z_distance",p.support_top_z_distance);
  p.support_bottom_z_distance     = jget(j,"support_bottom_z_distance",p.support_bottom_z_distance);
  p.support_xy_distance           = jget(j,"support_xy_distance",p.support_xy_distance);
  p.support_interface_top_layers  = (int)jget(j,"support_interface_top_layers",p.support_interface_top_layers);
  p.support_line_width            = jget(j,"support_line_width",p.support_line_width);
  p.support_auto                  = jbool(j,"support_auto",p.support_auto);
  // Keys added in stage 33 when the hardcoding was removed
  p.support_angle                 = jget(j,"support_angle",p.support_angle);
  p.support_base_pattern          = jstr(j,"support_base_pattern",p.support_base_pattern);
  p.support_interface_pattern     = jstr(j,"support_interface_pattern",p.support_interface_pattern);
  p.support_interface_spacing     = jget(j,"support_interface_spacing",p.support_interface_spacing);
  p.support_base_pattern_spacing  = jget(j,"support_base_pattern_spacing",p.support_base_pattern_spacing);
  p.support_overhang_min_area     = jget(j,"support_overhang_min_area",p.support_overhang_min_area);
  p.support_remove_small_overhang = jbool(j,"support_remove_small_overhang",p.support_remove_small_overhang);
  p.bridge_no_support             = jbool(j,"bridge_no_support",p.bridge_no_support);
  p.support_expansion             = jget(j,"support_expansion",p.support_expansion);
  p.support_threshold_overlap     = jget(j,"support_threshold_overlap",p.support_threshold_overlap);
  p.support_on_build_plate_only   = jbool(j,"support_on_build_plate_only",p.support_on_build_plate_only);
  p.support_interface_bottom_layers = (int)jget(j,"support_interface_bottom_layers",p.support_interface_bottom_layers);
  p.support_grid_snap             = jbool(j,"support_grid_snap",p.support_grid_snap);
  p.tree_lite_shrink              = jget(j,"tree_lite_shrink",p.tree_lite_shrink);
  p.tree_lite_min_radius          = jget(j,"tree_lite_min_radius",p.tree_lite_min_radius);
  // WP1: parsing the real tree support shape keys — the upstream UI keys (with the organic suffix) win, falling back to the suffix-less keys
  p.tree_style                    = jstr(j,"tree_style",p.tree_style);
  p.tree_support_branch_angle     = jget(j,"tree_support_branch_angle_organic",jget(j,"tree_support_branch_angle",p.tree_support_branch_angle));
  p.tree_support_angle_slow       = jget(j,"tree_support_angle_slow",p.tree_support_angle_slow);
  p.tree_support_branch_diameter  = jget(j,"tree_support_branch_diameter_organic",jget(j,"tree_support_branch_diameter",p.tree_support_branch_diameter));
  p.tree_support_branch_distance  = jget(j,"tree_support_branch_distance_organic",jget(j,"tree_support_branch_distance",p.tree_support_branch_distance));
  p.tree_support_branch_diameter_angle = jget(j,"tree_support_branch_diameter_angle",p.tree_support_branch_diameter_angle);
  p.tree_support_tip_diameter     = jget(j,"tree_support_tip_diameter",p.tree_support_tip_diameter);
  p.tree_support_top_rate         = jget(j,"tree_support_top_rate",p.tree_support_top_rate);
  p.tree_support_wall_count       = (int)jget(j,"tree_support_wall_count",p.tree_support_wall_count);
  p.printable_height              = jget(j,"printable_height",p.printable_height);
  p.independent_support_layer_height = jbool(j,"independent_support_layer_height",p.independent_support_layer_height);
  p.support_object_first_layer_gap= jget(j,"support_object_first_layer_gap",p.support_object_first_layer_gap);
  p.raft_expansion                = jget(j,"raft_expansion",p.raft_expansion);
  p.raft_contact_distance         = jget(j,"raft_contact_distance",p.raft_contact_distance);
  p.raft_first_layer_height       = jget(j,"raft_first_layer_height",p.raft_first_layer_height);
  p.skirt_height        = (int)jget(j,"skirt_height",p.skirt_height);
  p.brim_object_gap               = jget(j,"brim_object_gap",p.brim_object_gap);
  p.retraction_minimum_travel     = jget(j,"retraction_minimum_travel",p.retraction_minimum_travel);
  p.gcode_resolution              = jget(j,"gcode_resolution",p.gcode_resolution);
  p.prime_tower_x                 = jget(j,"prime_tower_x",p.prime_tower_x);
  p.prime_tower_y                 = jget(j,"prime_tower_y",p.prime_tower_y);
  p.prime_tower_ring_size         = jget(j,"prime_tower_ring_size",p.prime_tower_ring_size);
  p.raft_layers        = (int)jget(j,"raft_layers",p.raft_layers);
  p.bed_width          = jget(j,"bed_width",p.bed_width);
  p.bed_depth          = jget(j,"bed_depth",p.bed_depth);
  p.sparse_infill_pattern         = jstr(j,"sparse_infill_pattern",p.sparse_infill_pattern);
  p.fan_speed                     = jget(j,"fan_speed",p.fan_speed);
  p.close_fan_the_first_x_layers  = (int)jget(j,"close_fan_the_first_x_layers",p.close_fan_the_first_x_layers);
  p.full_fan_speed_layer          = (int)jget(j,"full_fan_speed_layer",p.full_fan_speed_layer);
  p.slow_down_layer_time          = jget(j,"slow_down_layer_time",p.slow_down_layer_time);
  p.enable_arc_fitting            = jbool(j,"enable_arc_fitting",p.enable_arc_fitting);
  p.seam_position                 = jstr(j,"seam_position",p.seam_position);
  p.spiral_mode                   = jbool(j,"spiral_mode",p.spiral_mode);
  p.seam_slope_type               = jstr(j,"seam_slope_type",p.seam_slope_type);
  p.scarf_length                  = jget(j,"scarf_length",p.scarf_length);
  p.enable_pressure_advance       = jbool(j,"enable_pressure_advance",p.enable_pressure_advance);
  p.pressure_advance              = jget(j,"pressure_advance",p.pressure_advance);
  p.support_style                 = jstr(j,"support_style",p.support_style);
  p.bridge_speed                  = jget(j,"bridge_speed",p.bridge_speed);
  p.ironing_type                  = jstr(j,"ironing_type",p.ironing_type);
  p.ironing_spacing               = jget(j,"ironing_spacing",p.ironing_spacing);
  p.ironing_flow                  = jget(j,"ironing_flow",p.ironing_flow);
  p.ironing_speed                 = jget(j,"ironing_speed",p.ironing_speed);
  p.reduce_crossing_wall          = jbool(j,"reduce_crossing_wall",p.reduce_crossing_wall);
  p.max_volumetric_extrusion_rate_slope = jget(j,"max_volumetric_extrusion_rate_slope",p.max_volumetric_extrusion_rate_slope);
  p.extruder_count                = (int)jget(j,"extruder_count",p.extruder_count);
  p.mm_group_split                = (int)jget(j,"mm_group_split",p.mm_group_split);
  p.auto_center                   = jbool(j,"auto_center",p.auto_center);   // stage 28
  p.wipe_tower_real               = jbool(j,"wipe_tower_real",p.wipe_tower_real);
  p.prime_tower_width             = jget(j,"prime_tower_width",p.prime_tower_width);
  p.wall_generator                = jstr(j,"wall_generator",p.wall_generator);
  p.pe_lite                       = jbool(j,"pe_lite",p.pe_lite);
  p.extrusion_rate_slope_segment_length = jget(j,"extrusion_rate_slope_segment_length",p.extrusion_rate_slope_segment_length);
  p.pe_external_perimeter_only    = jbool(j,"pe_external_perimeter_only",p.pe_external_perimeter_only);
  p.emit_pe_tags                  = jbool(j,"emit_pe_tags",p.emit_pe_tags);
  p.pe_strip_tags                 = jbool(j,"pe_strip_tags",p.pe_strip_tags);
  p.machine_accel_print           = jget(j,"machine_accel_print",p.machine_accel_print);
  p.machine_accel_travel          = jget(j,"machine_accel_travel",p.machine_accel_travel);
  p.machine_accel_retract         = jget(j,"machine_accel_retract",p.machine_accel_retract);
  p.machine_jerk_xy               = jget(j,"machine_jerk_xy",p.machine_jerk_xy);
  p.machine_jerk_z                = jget(j,"machine_jerk_z",p.machine_jerk_z);
  p.machine_jerk_e                = jget(j,"machine_jerk_e",p.machine_jerk_e);
  p.machine_max_speed_xy          = jget(j,"machine_max_speed_xy",p.machine_max_speed_xy);
  p.machine_max_speed_z           = jget(j,"machine_max_speed_z",p.machine_max_speed_z);
  p.machine_max_speed_e           = jget(j,"machine_max_speed_e",p.machine_max_speed_e);
  p.time_engine                   = jstr(j,"time_engine",p.time_engine);
  p.economy                       = jbool(j,"economy",p.economy);
  p.reuse_stages                  = (int)jget(j,"reuse_stages",p.reuse_stages);
  p.keep_stages                   = jbool(j,"keep_stages",p.keep_stages);
  p.arachne_dump                  = jbool(j,"arachne_dump",p.arachne_dump);
  // Stage 21: resolve per-feature widths (after nozzle parsing). When line_width is 0 it is promoted to the upstream auto (the viewer sends 0.42 by default -> unchanged).
  {
    const double noz = p.nozzle_diameter;
    if (p.line_width <= 0) p.line_width = auto_lw(noz, false);
    p.outer_wall_line_width            = resolve_lw(jwidth_raw(j,"outer_wall_line_width",noz),            noz, p.line_width, false);
    p.inner_wall_line_width            = resolve_lw(jwidth_raw(j,"inner_wall_line_width",noz),            noz, p.line_width, false);
    p.top_surface_line_width           = resolve_lw(jwidth_raw(j,"top_surface_line_width",noz),           noz, p.line_width, true);   // top surface → nozzle auto
    p.sparse_infill_line_width         = resolve_lw(jwidth_raw(j,"sparse_infill_line_width",noz),         noz, p.line_width, false);
    p.internal_solid_infill_line_width = resolve_lw(jwidth_raw(j,"internal_solid_infill_line_width",noz), noz, p.line_width, false);
    p.initial_layer_line_width         = resolve_lw(jwidth_raw(j,"initial_layer_line_width",noz),         noz, p.line_width, false);
  }
  return p;
}

// ---- STL parser (binary + ASCII) ----------------------------------------------
struct V3 { float x, y, z; };
struct Tri { V3 v[3]; };
static bool is_binary_stl(const std::vector<uint8_t>& b) {
  if (b.size() < 84) return false;
  uint32_t n; std::memcpy(&n, &b[80], 4);
  return b.size() == (size_t)84 + (size_t)n * 50;   // an exact match means binary
}
static std::vector<Tri> parse_binary(const std::vector<uint8_t>& b) {
  std::vector<Tri> tris;
  uint32_t n; std::memcpy(&n, &b[80], 4);
  size_t need = 84 + (size_t)n * 50;
  if (b.size() < need) n = (uint32_t)((b.size() - 84) / 50);
  tris.reserve(n);
  size_t off = 84;
  for (uint32_t i = 0; i < n; ++i) {
    Tri t; off += 12;
    for (int k = 0; k < 3; ++k) { float xyz[3]; std::memcpy(xyz, &b[off], 12); off += 12; t.v[k]={xyz[0],xyz[1],xyz[2]}; }
    off += 2; tris.push_back(t);
  }
  return tris;
}
// ASCII: collect "vertex x y z" in order, three at a time into a triangle (facet/loop/normal ignored)
static std::vector<Tri> parse_ascii(const std::vector<uint8_t>& b) {
  std::vector<Tri> tris;
  std::string s((const char*)b.data(), b.size());
  std::vector<V3> verts;
  size_t pos = 0;
  while ((pos = s.find("vertex", pos)) != std::string::npos) {
    pos += 6;
    char* end = nullptr;
    double x = std::strtod(s.c_str()+pos, &end); if (end==s.c_str()+pos) break; pos = end - s.c_str();
    double y = std::strtod(s.c_str()+pos, &end); pos = end - s.c_str();
    double z = std::strtod(s.c_str()+pos, &end); pos = end - s.c_str();
    verts.push_back({(float)x,(float)y,(float)z});
  }
  for (size_t i = 0; i + 2 < verts.size(); i += 3) { Tri t; t.v[0]=verts[i]; t.v[1]=verts[i+1]; t.v[2]=verts[i+2]; tris.push_back(t); }
  return tris;
}
static std::vector<Tri> parse_stl(const std::vector<uint8_t>& b) {
  if (b.size() < 15) return {};
  return is_binary_stl(b) ? parse_binary(b) : parse_ascii(b);
}

// ---- Triangle-plane intersection -> segments ------------------------------------
struct Seg { double x0, y0, x1, y1; };
static bool tri_plane(const Tri& t, double z, Seg& out) {
  double px[3], py[3]; int c = 0;
  for (int e = 0; e < 3; ++e) {
    const V3& a = t.v[e]; const V3& b = t.v[(e + 1) % 3];
    if ((a.z < z && b.z >= z) || (b.z < z && a.z >= z)) {
      double f = (z - a.z) / (b.z - a.z);
      if (c < 2) { px[c] = a.x + f*(b.x-a.x); py[c] = a.y + f*(b.y-a.y); }
      ++c;
    }
  }
  if (c == 2) { out = { px[0],py[0],px[1],py[1] }; return true; }
  return false;
}
static inline long long qkey(double x, double y) {
  long long qx=(long long)std::llround(x/1e-3), qy=(long long)std::llround(y/1e-3);
  return (qx << 32) ^ (qy & 0xffffffffLL);
}
static Paths chain_polys(std::vector<Seg>& segs) {
  int N=(int)segs.size();
  std::vector<char> used(N,0);
  std::unordered_map<long long,std::vector<int>> m; m.reserve(N*2);
  for (int i=0;i<N;++i){ m[qkey(segs[i].x0,segs[i].y0)].push_back(i*2); m[qkey(segs[i].x1,segs[i].y1)].push_back(i*2+1); }
  Paths out;
  for (int i=0;i<N;++i){
    if (used[i]) continue; used[i]=1;
    double sx=segs[i].x0, sy=segs[i].y0, cx=segs[i].x1, cy=segs[i].y1;
    Path poly;
    poly.push_back(IntPoint((cInt)std::llround(sx*SCALE),(cInt)std::llround(sy*SCALE)));
    poly.push_back(IntPoint((cInt)std::llround(cx*SCALE),(cInt)std::llround(cy*SCALE)));
    for (int g=0;g<N;++g){
      if (qkey(cx,cy)==qkey(sx,sy)) break;
      auto it=m.find(qkey(cx,cy)); int nxt=-1,ne=-1;
      if (it!=m.end()) for (int ref:it->second){ int si=ref/2; if(used[si])continue; nxt=si; ne=ref%2; break; }
      if (nxt<0) break; used[nxt]=1;
      if (ne==0){ cx=segs[nxt].x1; cy=segs[nxt].y1; } else { cx=segs[nxt].x0; cy=segs[nxt].y0; }
      poly.push_back(IntPoint((cInt)std::llround(cx*SCALE),(cInt)std::llround(cy*SCALE)));
    }
    if (poly.size()>=3) out.push_back(std::move(poly));
  }
  return out;
}

// ---- Clipper helpers -----------------------------------------------------------
static Paths offset_paths(const Paths& in, double delta_mm, JoinType jt=jtMiter) {
  Paths out; if (in.empty()) return out;
  ClipperOffset co; co.AddPaths(in, jt, etClosedPolygon); co.Execute(out, delta_mm*SCALE);
  return out;
}
static Paths clip_paths(const Paths& a, const Paths& b, ClipType ct) {
  Paths out;
  if (a.empty()) return (ct==ctUnion) ? b : Paths{};
  Clipper c; c.AddPaths(a, ptSubject, true);
  if (!b.empty()) c.AddPaths(b, ptClip, true);
  else if (ct==ctIntersection) return {};   // ∩ with the empty set = empty
  c.Execute(ct, out, pftNonZero, pftNonZero);
  return out;
}
static Paths union_paths(const Paths& a, const Paths& b) {
  if (a.empty()) return b; if (b.empty()) return a; return clip_paths(a,b,ctUnion);
}
// Generate parallel lines at a given angle, then clip them to a region (open paths)
static void bbox_of(const Paths& ps, double& minx,double& miny,double& maxx,double& maxy){
  minx=miny=1e18; maxx=maxy=-1e18;
  for (const Path& p:ps) for (const IntPoint& pt:p){ double x=pt.x()*INV,y=pt.y()*INV;
    minx=std::min(minx,x);miny=std::min(miny,y);maxx=std::max(maxx,x);maxy=std::max(maxy,y);} }
static Paths infill_lines(const Paths& region, double angleDeg, double spacing) {
  Paths lines; if (region.empty()||spacing<=1e-6) return lines;
  double minx,miny,maxx,maxy; bbox_of(region,minx,miny,maxx,maxy);
  double a=angleDeg*PI/180.0, dx=std::cos(a),dy=std::sin(a), nx=-std::sin(a),ny=std::cos(a);
  double diag=std::hypot(maxx-minx,maxy-miny)+2.0, nmin=1e18,nmax=-1e18;
  double cx[4]={minx,maxx,minx,maxx}, cy[4]={miny,miny,maxy,maxy};
  for (int i=0;i<4;++i){ double pr=cx[i]*nx+cy[i]*ny; nmin=std::min(nmin,pr); nmax=std::max(nmax,pr); }
  for (double o=nmin;o<=nmax;o+=spacing){
    double bx=o*nx,by=o*ny; Path ln;
    ln.push_back(IntPoint((cInt)std::llround((bx-dx*diag)*SCALE),(cInt)std::llround((by-dy*diag)*SCALE)));
    ln.push_back(IntPoint((cInt)std::llround((bx+dx*diag)*SCALE),(cInt)std::llround((by+dy*diag)*SCALE)));
    lines.push_back(std::move(ln));
  }
  return lines;
}
static Paths clip_open(const Paths& lines, const Paths& region) {   // open paths ∩ region
  if (lines.empty()||region.empty()) return {};
  Clipper c; c.AddPaths(lines, ptSubject, false); c.AddPaths(region, ptClip, true);
  PolyTree pt; c.Execute(ctIntersection, pt, pftNonZero, pftNonZero);
  Paths out; OpenPathsFromPolyTree(pt, out); return out;
}
static Paths infill_clipped(const Paths& region, double angleDeg, double spacing) {
  return clip_open(infill_lines(region, angleDeg, spacing), region);
}
static void sort_monotonic(Paths& lines, double angleDeg);   // (defined below) for zigzag ordering

// ---- Stage 5 helpers: area · component split · morphological open · center line · tree shrink ------------------
static double paths_area(const Paths& ps){ double a=0; for (const Path& p:ps) a+=Area(p); return std::fabs(a); }
// morphological open: erode(-r) then dilate(+r) -> a "thick core" with parts thinner than 2r removed
static Paths morph_open(const Paths& in, double r){
  if (in.empty()||r<=1e-6) return in;
  return offset_paths(offset_paths(in, -r), r);
}
// Split connected components recursively via PolyTree (each component = one outline plus its holes)
static void collect_component(PolyNode* n, std::vector<Paths>& out){
  Paths comp; comp.push_back(n->Contour);
  for (PolyNode* hole : n->Childs){
    comp.push_back(hole->Contour);                 // hole
    for (PolyNode* inner : hole->Childs) collect_component(inner, out);  // an island inside a hole = a new component
  }
  out.push_back(std::move(comp));
}
static std::vector<Paths> split_components(const Paths& in){
  std::vector<Paths> out; if (in.empty()) return out;
  Clipper c; c.AddPaths(in, ptSubject, true);
  PolyTree tree; c.Execute(ctUnion, tree, pftNonZero, pftNonZero);
  for (PolyNode* n : tree.Childs) collect_component(n, out);
  return out;
}
// Center line approximation for a component: one straight line along the bbox major axis through the centroid, clipped to the component.
//  Exact for thin straight bars. On failure (curves, …) it falls back to rectilinear along the major axis.
static Paths centerline_of(const Paths& comp, double w){
  if (comp.empty()) return {};
  double minx,miny,maxx,maxy; bbox_of(comp,minx,miny,maxx,maxy);
  double W=maxx-minx, H=maxy-miny, ang=(W>=H)?0.0:90.0;
  double cx=(minx+maxx)/2, cy=(miny+maxy)/2, a=ang*PI/180.0, dx=std::cos(a), dy=std::sin(a);
  double diag=std::hypot(W,H)+2.0;
  Path ln;
  ln.push_back(IntPoint((cInt)std::llround((cx-dx*diag)*SCALE),(cInt)std::llround((cy-dy*diag)*SCALE)));
  ln.push_back(IntPoint((cInt)std::llround((cx+dx*diag)*SCALE),(cInt)std::llround((cy+dy*diag)*SCALE)));
  Paths lns; lns.push_back(ln);
  Paths out = clip_open(lns, comp);
  if (out.empty()) out = infill_clipped(comp, ang, std::max(w, 1e-3));   // fallback
  return out;
}
// One layer of tree-lite shrink: components narrower than 2·minR are kept (minimum pillar), otherwise shrunk by -shrink and merged.
// Stage 33: approximation of the upstream SupportGridPattern (SupportMaterial.cpp:637~) — snaps the support region to a grid.
//  Upstream rasterizes the polygons at extrusion-width resolution and seed-fills macro blocks of support_spacing size, so that
//  any support island touching a block is committed at block granularity (rasterize_polygons + seed_fill_block).
//  Effect: (1) pillars align to a fixed grid and (2) **fragments too thin to fill are inflated to at least one cell and become printable**.
//  Without (2), support for thin-walled shapes (e.g. a real Benchy chimney, a ring cross-section) is detected but receives not a single
//  infill line and effectively disappears (measured: it only appeared once support_expansion was applied).
//  Here the equivalent is implemented with Clipper alone — if a cell overlaps the support region, the whole cell is taken.
//  Because the test is a cell-polygon intersection rather than raster/seed fill, the oversampling details are approximate.
static Paths grid_snap(const Paths& region, double cell) {
  if (region.empty() || cell <= 1e-6) return region;
  double minx,miny,maxx,maxy; bbox_of(region, minx,miny,maxx,maxy);
  const long i0=(long)std::floor(minx/cell), i1=(long)std::ceil(maxx/cell);
  const long j0=(long)std::floor(miny/cell), j1=(long)std::ceil(maxy/cell);
  if ((i1-i0+1) > 2000 || (j1-j0+1) > 2000 || (i1-i0+1)*(j1-j0+1) > 200000) return region;  // guard: return the input when the grid would be too large
  Paths cells;
  for (long i=i0;i<=i1;++i) for (long j=j0;j<=j1;++j) {
    const double x0=i*cell, y0=j*cell, x1=x0+cell, y1=y0+cell;
    Path c;
    c.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y0*SCALE)));
    c.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y0*SCALE)));
    c.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y1*SCALE)));
    c.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y1*SCALE)));
    if (clip_paths(Paths{c}, region, ctIntersection).empty()) continue;   // does support touch this cell
    cells.push_back(std::move(c));
  }
  if (cells.empty()) return region;
  return SimplifyPolygons(cells, pftNonZero);   // merge adjacent cells
}

static Paths tree_taper(const Paths& in, double shrink, double minR){
  if (in.empty()) return in;
  Paths out;
  for (const Paths& comp : split_components(in)){
    Paths minTest = offset_paths(comp, -minR);
    if (minTest.empty()) { for (const Path& pp:comp) out.push_back(pp); continue; }  // minimum pillar: not shrunk
    Paths s = offset_paths(comp, -shrink);
    if (s.empty()) { for (const Path& pp:comp) out.push_back(pp); }
    else           { for (const Path& pp:s) out.push_back(pp); }
  }
  return clip_paths(out, Paths{}, ctUnion);   // union overlapping pillars
}
// gyroid approximation: a sine wave line per spacing, with the phase rotated by z (3D variation per layer)
static Paths gyroid_lines(const Paths& region, double spacing, double z) {
  Paths lines; if (region.empty()||spacing<=1e-6) return lines;
  double minx,miny,maxx,maxy; bbox_of(region,minx,miny,maxx,maxy);
  double A=spacing*0.55, lambda=spacing*2.0, phase=z*(2*PI/lambda), step=lambda/12.0;
  for (double base=miny-A; base<=maxy+A+spacing; base+=spacing) {
    Path ln;
    for (double x=minx-1.0; x<=maxx+1.0; x+=step)
      ln.push_back(IntPoint((cInt)std::llround(x*SCALE),(cInt)std::llround((base+A*std::sin(2*PI*x/lambda+phase))*SCALE)));
    if (ln.size()>=2) lines.push_back(std::move(ln));
  }
  return lines;
}
// Zigzag: connect sorted parallel lines at the boundary (back and forth) -> a single continuous path, fewer travels
static Paths zigzag_connect(Paths lines, double angleDeg) {
  if (lines.size()<2) return lines;
  sort_monotonic(lines, angleDeg);
  Path chain;
  for (size_t i=0;i<lines.size();++i) {
    if (lines[i].size()<2) continue;
    Path ln = lines[i];
    if (i & 1) std::reverse(ln.begin(), ln.end());
    for (auto& q:ln) chain.push_back(q);
  }
  Paths out; if (chain.size()>=2) out.push_back(std::move(chain));
  return out;
}
// Stage 8: call the real ported OrcaSlicer Fill patterns (per component ExPolygon -> fill_bridge -> open paths).
//  region = ClipperLib Paths (scaled by SCALE). density = fraction, lineW = line width (mm), angleDeg, z (mm).
static Paths real_fill(const Paths& region, const std::string& pat, double density, double lineW, double angleDeg, double z, int layerIdx) {
  Paths out;
  for (const Paths& comp : split_components(region)) {   // comp[0] = outline, [1..] = holes
    std::vector<std::vector<std::pair<double,double>>> polys;
    for (const Path& p : comp) {
      std::vector<std::pair<double,double>> poly; poly.reserve(p.size());
      for (const IntPoint& q : p) poly.push_back({ q.x()*INV, q.y()*INV });
      if (poly.size() >= 3) polys.push_back(std::move(poly));
    }
    if (polys.empty() || polys[0].size() < 3) continue;
    auto lines = fill_bridge::generate_fill(polys, pat, density, lineW, angleDeg, z, layerIdx);
    for (const auto& pl : lines) {
      Path path; path.reserve(pl.size());
      for (const auto& xy : pl) path.push_back(IntPoint((cInt)std::llround(xy.first*SCALE),(cInt)std::llround(xy.second*SCALE)));
      if (path.size() >= 2) out.push_back(std::move(path));
    }
  }
  return out;
}
// Sparse pattern dispatch (returns open paths). lineW = line width, density = fraction (for the real ported Fill patterns).
static Paths build_sparse(const Paths& region, const std::string& pat, double base, double spacing, int layerIdx, double z, double lineW, double density) {
  if (region.empty()||spacing<=1e-6) return {};
  if (pat=="grid") {
    Paths l = infill_lines(region, base, spacing*2.0);
    for (auto& q:infill_lines(region, base+90.0, spacing*2.0)) l.push_back(q);
    return clip_open(l, region);
  }
  if (pat=="triangles") {
    Paths l = infill_lines(region, base, spacing*3.0);
    for (auto& q:infill_lines(region, base+60.0,  spacing*3.0)) l.push_back(q);
    for (auto& q:infill_lines(region, base+120.0, spacing*3.0)) l.push_back(q);
    return clip_open(l, region);
  }
  // Stage 8: the real ported Fill patterns (gyroid is replaced by the real TPMS; the old sine approximation is preserved as gyroid_approx)
  if (pat=="gyroid"||pat=="honeycomb"||pat=="3dhoneycomb"||pat=="crosshatch"||pat=="concentric") {
    Paths rf = real_fill(region, pat, density, lineW, base, z, layerIdx);
    if (!rf.empty()) return rf;   // on failure, fall through to rectilinear below
  }
  if (pat=="gyroid_approx") return clip_open(gyroid_lines(region, spacing, z), region);  // backwards compatible: the old sine approximation
  double a = base + (layerIdx%2 ? 90.0 : 0.0);         // alternate per layer
  if (pat=="zigzag")  return zigzag_connect(infill_clipped(region, a, spacing), a);
  return infill_clipped(region, a, spacing);           // rectilinear (default)
}
// Path length (for estimating layer time)
static double path_len(const Path& p, bool closed) {
  double L=0; for (size_t i=1;i<p.size();++i) L+=std::hypot((p[i].x()-p[i-1].x())*INV,(p[i].y()-p[i-1].y())*INV);
  if (closed && p.size()>=2) L+=std::hypot((p[0].x()-p.back().x())*INV,(p[0].y()-p.back().y())*INV);
  return L;
}
static double paths_len(const Paths& ps, bool closed){ double L=0; for (auto& p:ps) L+=path_len(p,closed); return L; }
static double vwalls_len(const std::vector<Paths>& ws){ double L=0; for (auto& w:ws) L+=paths_len(w,true); return L; }
// Cooling fan ramp: [0,close)=0, [full,∞)=target, linear in between
static int fan_S(int i, const Params& p) {
  double target = 255.0 * (p.fan_speed/100.0);
  int close = std::max(0,p.close_fan_the_first_x_layers), full = std::max(close+1,p.full_fan_speed_layer);
  if (i < close) return 0;
  if (i >= full) return (int)std::llround(target);
  return (int)std::llround(target * (double)(i-close+1)/(double)(full-close+1));
}
// Monotonic emission: sort infill lines by their projection onto the fill normal axis (so top solid advances in one direction)
static void sort_monotonic(Paths& lines, double angleDeg) {
  double a = angleDeg*PI/180.0, nx=-std::sin(a), ny=std::cos(a);
  std::stable_sort(lines.begin(), lines.end(), [&](const Path& A, const Path& B){
    if (A.empty()||B.empty()) return false;
    double pa=(A[0].x()*INV)*nx+(A[0].y()*INV)*ny, pb=(B[0].x()*INV)*nx+(B[0].y()*INV)*ny;
    return pa < pb;
  });
}
struct DPt { double x, y; };
// Circumcircle of 3 points (center, r) — for arc fitting
static bool circle_from3(DPt a, DPt b, DPt c, double& cx, double& cy, double& r) {
  double d = 2.0*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));
  if (std::fabs(d) < 1e-9) return false;
  double aa=a.x*a.x+a.y*a.y, bb=b.x*b.x+b.y*b.y, cc=c.x*c.x+c.y*c.y;
  cx = (aa*(b.y-c.y)+bb*(c.y-a.y)+cc*(a.y-b.y))/d;
  cy = (aa*(c.x-b.x)+bb*(a.x-c.x)+cc*(b.x-a.x))/d;
  r  = std::hypot(a.x-cx, a.y-cy);
  return true;
}
// Seam context (aligned = the previous layer's seam, random = a deterministic LCG)
struct SeamCtx { double lastX=0, lastY=0; bool has=false; uint32_t rng=1; };
static uint32_t lcg(uint32_t& s){ s = s*1664525u + 1013904223u; return s; }
// Seam modes: 0=back (max Y) 1=nearest (closest to the nozzle) 2=aligned (previous seam) 3=random, -1=no rotation
static void rotate_seam(Path& p, int mode, SeamCtx& sc, double nozX, double nozY) {
  if (mode < 0 || p.size() < 3) return;
  size_t best = 0;
  if (mode == 0 || (mode == 2 && !sc.has)) {          // back / the first layer of aligned
    cInt by=p[0].y(); for (size_t i=1;i<p.size();++i) if (p[i].y()>by){ by=p[i].y(); best=i; }
  } else if (mode == 1 || mode == 2) {                 // nearest nozzle / aligned to the previous seam
    double tx = (mode==1)?nozX:sc.lastX, ty=(mode==1)?nozY:sc.lastY, bd=1e30;
    for (size_t i=0;i<p.size();++i){ double dd=std::hypot(p[i].x()*INV-tx, p[i].y()*INV-ty); if (dd<bd){bd=dd;best=i;} }
  } else {                                             // random (deterministic)
    best = lcg(sc.rng) % p.size();
  }
  std::rotate(p.begin(), p.begin()+best, p.end());
}

// ---- G-code writer (relative E, z_hop, parameterized retraction) ----------------
// (performance) Fixed-point formatter for the G-code hot path — ~5x faster than snprintf (fmt_bench2 measurements: 2 datasets x 2 runs, 0 mismatches out of 2M).
//  At a rounding boundary (|frac−0.5|<1e-6) it returns nullptr -> the caller falls back to snprintf, guaranteeing byte-identical output.
//  The sign comes from signbit(v) (including −0.0) — matching snprintf's "-0.000" output.
static const long long FMT_P10[] = {1,10,100,1000,10000,100000};
static inline char* fmt_fixed_safe(char* p, double v, int prec) {
  double av = std::fabs(v);
  double t  = av * FMT_P10[prec];
  double fr = t - std::floor(t);
  if (fr > 0.5 - 1e-6 && fr < 0.5 + 1e-6) return nullptr;   // rounding boundary -> snprintf fallback
  long long sc = (long long)llround(t);
  if (std::signbit(v)) *p++ = '-';
  long long ip = sc / FMT_P10[prec], fp = sc % FMT_P10[prec];
  char tmp[24]; int n = 0;
  do { tmp[n++] = (char)('0' + ip % 10); ip /= 10; } while (ip);
  while (n) *p++ = tmp[--n];
  *p++ = '.';
  for (int k = prec - 1; k >= 0; --k) { p[k] = (char)('0' + fp % 10); fp /= 10; }
  return p + prec;
}
static inline char* fmt_i(char* p, int v) {
  if (v < 0) { *p++ = '-'; v = -v; }
  char tmp[12]; int n = 0;
  do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
  while (n) *p++ = tmp[--n];
  return p;
}

struct GW {
  bool dry=false;   // G003 E1 dry run: skips strings/toolpaths and only updates position, curF, fan and seam state (to chain the entry state)
  std::string s;
  double px=0, py=0, z=0;
  double e_per_mm=0, filament=0;
  long   segments=0;
  int    curF=-1;
  double retract_len=0.8; int retractF=1800; // mm, mm/min
  double retract_min_travel=2.0;             // stage 33: retraction_minimum_travel (formerly the TRAVEL_RETRACT_MIN constant)
  double z_hop=0.0;
  double offX=128.0, offY=128.0;   // G-code XY offset = bed/2
  int    lastFan=-1;               // current cooling fan value (M106 only on change)
  bool   arc_fitting=false;        // G2/G3 arc fitting
  double scarf_len=10.0;           // length of the scarf seam ramp (mm)
  // Stage 6: PE-lite (limit on the volumetric flow change rate between adjacent extrusions)
  double pe_slope=0.0;             // mm³/s² (0=off)
  double filament_area=2.405;      // π·d²/4 (set in the preamble)
  double last_vol_flow=-1.0;       // previous extrusion volumetric flow in mm³/s (reset at layer start, not reset by travels)
  // Stage 6: wall-avoiding travel
  Paths  island;                   // region travels should stay inside (inside the walls). Empty means no check.
  bool   avoid_walls=false;
  long   wall_crossings=0;         // number of travels that actually crossed a wall (for cross-checking)
  // Stage 9: emitting the real PE tags (OrcaSlicer format)
  bool   emit_pe_tags=false;
  int    pe_cur_role=-1;
  char   buf[200];
  void pe_reset(){ last_vol_flow=-1.0; }
  // Start an extrusion run: ;_EXTRUSION_ROLE on a role change, then G1 F<v> ;_EXTRUDE_SET_SPEED (opening the block)
  //  curF is set to f so later extrusion G1s omit F (inheriting the SET_SPEED speed) — PE adjusts the flow within the block.
  void pe_begin_run(int role, int f){
    if (!emit_pe_tags) return;
    if (role != pe_cur_role) { std::snprintf(buf,sizeof buf,";_EXTRUSION_ROLE:%d",role); raw(buf); pe_cur_role=role; }
    std::snprintf(buf,sizeof buf,"G1 F%d ;_EXTRUDE_SET_SPEED",f); raw(buf); curF=f;
  }
  void pe_end_run(){ if (emit_pe_tags) raw(";_EXTRUDE_END"); }
  // PE-lite: limits the volumetric flow change rate (mm³/s²) between adjacent extrusions. With segment time Δt=d/v_n and v_n=Fn/A,
  //  slope = |Fn−Fl|·Fn/(d·A) ≤ pe_slope, S=pe_slope·d·A.
  //  acceleration (Fn>Fl): the Fn ceiling = (Fl+√(Fl²+4S))/2.  deceleration (Fn<Fl): inside a steep drop band (lo,hi), clamp to hi (the minimum drop).
  //  An approximation that adjusts only the per-segment speed at emission time, without splitting segments.
  int pe_feed(double dist, int fReq){
    double A=e_per_mm*filament_area, vreq=fReq/60.0, desired=A*vreq;
    if (pe_slope<=0.0 || last_vol_flow<0.0 || dist<1e-6 || A<=1e-9) { last_vol_flow=desired; return fReq; }
    double Fl=last_vol_flow, Fn=desired, S=pe_slope*dist*A;
    if (desired > Fl) {                                     // acceleration (more flow)
      double cap=(Fl+std::sqrt(Fl*Fl+4.0*S))/2.0; if (Fn>cap) Fn=cap;
    } else if (desired < Fl) {                              // deceleration (less flow)
      double disc=Fl*Fl-4.0*S;
      if (disc>0) { double sq=std::sqrt(disc), hi=(Fl+sq)/2.0, lo=(Fl-sq)/2.0; if (Fn>lo && Fn<hi) Fn=hi; }
    }
    int fUse=(int)std::llround((Fn/A)*60.0); if (fUse<60) fUse=60;
    last_vol_flow=A*(fUse/60.0);
    return fUse;
  }
  void set_e_per_mm(double h, const Params& p) {
    double A = h * (p.line_width - h * (1.0 - PI/4.0));
    double fa = PI * p.filament_diameter * p.filament_diameter / 4.0;
    e_per_mm = A / fa * p.flow_ratio;
  }
  // Stage 7: sets the flow for an arbitrary width (variable-width Arachne walls). Cross-section A = h·(w − h·(1−π/4)).
  void set_e_per_mm_width(double wseg, double h, const Params& p) {
    double A = h * (wseg - h * (1.0 - PI/4.0)); if (A < 0) A = 0;
    double fa = PI * p.filament_diameter * p.filament_diameter / 4.0;
    e_per_mm = A / fa * p.flow_ratio;
  }
  // WP3: sets the upstream volumetric flow (mm³/mm, ExtrusionPath::mm3_per_mm) directly — lets tree support reproduce the flow
  //  computed by the upstream Flow verbatim (including cases where it differs from the rectangular width x height approximation, such as bridging contact layers).
  void set_e_per_mm_vol(double mm3, const Params& p) {
    if (mm3 < 0) mm3 = 0;
    double fa = PI * p.filament_diameter * p.filament_diameter / 4.0;
    e_per_mm = mm3 / fa * p.flow_ratio;
  }
  void raw(const char* c){ if (dry) return; s += c; s += '\n'; }
  // Hot-path line emission — when the fast path (fixed point) fails, fall back to the original snprintf format (byte-identical).
  inline void line_xyf(const char* head, double a, double b, int f, const char* fbfmt) {
    char* q = buf; size_t hl = strlen(head); memcpy(q, head, hl); q += hl;
    char* r = fmt_fixed_safe(q, a, 3);
    if (r) { memcpy(r, " Y", 2); r = fmt_fixed_safe(r+2, b, 3); }
    if (r) { memcpy(r, " F", 2); r = fmt_i(r+2, f); *r = '\0'; raw(buf); return; }
    std::snprintf(buf, sizeof buf, fbfmt, a, b, f); raw(buf);
  }
  inline void line_vf(const char* head, double v, int prec, int f, const char* fbfmt) {
    char* q = buf; size_t hl = strlen(head); memcpy(q, head, hl); q += hl;
    char* r = fmt_fixed_safe(q, v, prec);
    if (r) { memcpy(r, " F", 2); r = fmt_i(r+2, f); *r = '\0'; raw(buf); return; }
    std::snprintf(buf, sizeof buf, fbfmt, v, f); raw(buf);
  }
  // Straight travel including retraction (upstream behavior)
  void travel_raw(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    bool retract = d > retract_min_travel && retract_len > 0;
    if (retract) {
      line_vf("G1 E-", retract_len, 4, retractF, "G1 E-%.4f F%d");
      if (z_hop > 0) line_vf("G1 Z", z + z_hop, 3, fTravel, "G1 Z%.3f F%d");
    }
    line_xyf("G0 X", x+offX, y+offY, fTravel, "G0 X%.3f Y%.3f F%d");
    if (retract) {
      if (z_hop > 0) line_vf("G1 Z", z, 3, fTravel, "G1 Z%.3f F%d");
      line_vf("G1 E", retract_len, 4, retractF, "G1 E%.4f F%d");
    }
    px=x; py=y; curF=-1;
  }
  // Detour move inside the material (no retraction — stays inside the material, the §6.5 desktop behavior)
  void travel_hop(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    line_xyf("G0 X", x+offX, y+offY, fTravel, "G0 X%.3f Y%.3f F%d");
    px=x; py=y; curF=-1;
  }
  // True when the straight line A->B lies (almost) entirely inside the island (inside the walls)
  bool seg_inside(double ax,double ay,double bx,double by){
    if (island.empty()) return true;
    Path seg; seg.push_back(IntPoint((cInt)std::llround(ax*SCALE),(cInt)std::llround(ay*SCALE)));
    seg.push_back(IntPoint((cInt)std::llround(bx*SCALE),(cInt)std::llround(by*SCALE)));
    Paths one; one.push_back(seg);
    double full=std::hypot(bx-ax,by-ay), got=paths_len(clip_open(one, island), false);
    return got >= full - 0.05;
  }
  // Detour along the island boundary: walk the boundary of the polygon nearest A from the vertex nearest A to the vertex nearest B (the shorter way)
  std::vector<DPt> detour_path(double ax,double ay,double bx,double by){
    const Path* best=nullptr; double bestD=1e30;
    IntPoint pa((cInt)std::llround(ax*SCALE),(cInt)std::llround(ay*SCALE));
    for (const Path& poly : island){
      if (poly.size()<3 || Area(poly)<=0) continue;                 // outlines only (positive area)
      if (PointInPolygon(pa, poly)!=0){ best=&poly; break; }
      for (const IntPoint& q:poly){ double dd=std::hypot(q.x()*INV-ax,q.y()*INV-ay); if(dd<bestD){bestD=dd;best=&poly;} }
    }
    if (!best) return {};
    const Path& poly=*best; int n=(int)poly.size();
    auto nearestIdx=[&](double x,double y){ int bi=0; double bd=1e30; for(int i=0;i<n;++i){double dd=std::hypot(poly[i].x()*INV-x,poly[i].y()*INV-y); if(dd<bd){bd=dd;bi=i;}} return bi; };
    int ia=nearestIdx(ax,ay), ib=nearestIdx(bx,by);
    if (ia==ib) return {};
    auto arcLen=[&](int dir){ double L=0; int i=ia; while(i!=ib){ int nx=(i+dir+n)%n; L+=std::hypot((poly[nx].x()-poly[i].x())*INV,(poly[nx].y()-poly[i].y())*INV); i=nx; } return L; };
    int dir = (arcLen(+1)<=arcLen(-1))?+1:-1;
    std::vector<DPt> way; way.push_back({poly[ia].x()*INV, poly[ia].y()*INV});
    int i=ia; while(i!=ib){ i=(i+dir+n)%n; way.push_back({poly[i].x()*INV, poly[i].y()*INV}); }
    return way;
  }
  // Smart travel: detect wall crossings -> detour along the boundary (when avoiding), otherwise a straight line and a crossing count
  // Fast guard (statistics only) — with avoid_walls=false the verdict only feeds the wall_crossings counter (no effect on G-code).
  //  Replaces Clipper clip_open (measured at ~20µs per travel, the single largest cost in the serial emission section) with an integer
  //  orientation intersection test plus an even-odd PIP on the midpoint. Only boundary cases (tangency, collinearity) may disagree with the clip verdict (counter error accepted).
  //  With avoid_walls=true the detour path (G-code) depends on the verdict -> the existing seg_inside (clip_open) is kept.
  bool seg_inside_fast(double ax,double ay,double bx,double by){
    const cInt x1=(cInt)std::llround(ax*SCALE), y1=(cInt)std::llround(ay*SCALE);
    const cInt x2=(cInt)std::llround(bx*SCALE), y2=(cInt)std::llround(by*SCALE);
    auto orient=[](cInt ox,cInt oy,cInt px_,cInt py_,cInt qx,cInt qy)->int{
      long long v=(long long)(px_-ox)*(long long)(qy-oy)-(long long)(py_-oy)*(long long)(qx-ox);
      return v>0?1:(v<0?-1:0); };
    for (const Path& poly : island){
      size_t n=poly.size(); if (n<3) continue;
      for (size_t i=0;i<n;++i){
        const IntPoint& c=poly[i]; const IntPoint& d=poly[(i+1)%n];
        int o1=orient(x1,y1,x2,y2,c.x(),c.y()), o2=orient(x1,y1,x2,y2,d.x(),d.y());
        if (o1*o2>=0) continue;
        int o3=orient(c.x(),c.y(),d.x(),d.y(),x1,y1), o4=orient(c.x(),c.y(),d.x(),d.y(),x2,y2);
        if (o3*o4<0) return false;               // proper intersection -> crosses the boundary
      }
    }
    IntPoint m((x1+x2)/2,(y1+y2)/2);             // no crossing -> decide by whether the midpoint is inside
    int cnt=0;
    for (const Path& poly : island){ int r=PointInPolygon(m,poly); if (r==-1) return true; if (r!=0) ++cnt; }
    return (cnt&1)==1;
  }
  void travel(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    if (dry) { px=x; py=y; curF=-1; return; }   // G003: a detour ends at the same point -> position only
    if (!island.empty() && !(avoid_walls ? seg_inside(px,py,x,y) : seg_inside_fast(px,py,x,y))) {
      if (avoid_walls) {
        std::vector<DPt> way = detour_path(px,py,x,y);
        if (!way.empty()) { for (auto& wp:way) travel_hop(wp.x,wp.y,fTravel); travel_hop(x,y,fTravel); return; }
      }
      ++wall_crossings;                          // no detour / detour failed -> a real crossing
    }
    travel_raw(x, y, fTravel);
  }
  void extrude(double x, double y, int fPrint) {
    double d = std::hypot(x-px, y-py); if (d < 1e-9) return;
    if (dry) { px=x; py=y; curF=fPrint; return; }   // G003 dry run (assumes pe off — guarded in parallel mode)
    int fUse = pe_feed(d, fPrint);               // PE-lite: apply the flow change rate limit (fPrint when off)
    double dE = e_per_mm * d; filament += dE; ++segments;
    char* r = buf; memcpy(r, "G1 X", 4); r += 4;
    r = fmt_fixed_safe(r, x+offX, 3);
    if (r) { memcpy(r, " Y", 2); r = fmt_fixed_safe(r+2, y+offY, 3); }
    if (r) { memcpy(r, " E", 2); r = fmt_fixed_safe(r+2, dE, 5); }
    if (r) {                                     // fast path succeeded — F only when it changes
      if (fUse != curF) { memcpy(r, " F", 2); r = fmt_i(r+2, fUse); }
      *r = '\0';
    } else if (fUse != curF) std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f F%d", x+offX,y+offY,dE,fUse);
    else                     std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f",     x+offX,y+offY,dE);
    curF = fUse;
    raw(buf); px=x; py=y;
  }
  // For spiral mode: extrusion that raises Z as it goes
  void extrude_z(double x, double y, double zz, int fPrint) {
    double d = std::hypot(x-px, y-py); if (d < 1e-9) { z=zz; return; }
    double dE = e_per_mm * d; filament += dE; ++segments;
    if (fPrint != curF) { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f F%d", x+offX,y+offY,zz,dE,fPrint); curF=fPrint; }
    else                { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f",     x+offX,y+offY,zz,dE); }
    raw(buf); px=x; py=y; z=zz;
  }
  // For the scarf seam: extrusion applying both Z and flow (an E multiplier) (Z always written)
  void extrude_zf(double x, double y, double zz, double flowMul, int fPrint) {
    double d = std::hypot(x-px, y-py); if (d < 1e-9) { z=zz; return; }
    double dE = e_per_mm * d * flowMul; filament += dE; ++segments;
    if (fPrint != curF) { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f F%d", x+offX,y+offY,zz,dE,fPrint); curF=fPrint; }
    else                { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f",     x+offX,y+offY,zz,dE); }
    raw(buf); px=x; py=y; z=zz;
  }
  // Cooling fan (M106 emitted only on change)
  void set_fan(int S) { if (S==lastFan) return; lastFan=S; if (dry) return; std::snprintf(buf,sizeof buf,"M106 S%d",S); raw(buf); }
  // Emit a continuous polyline (pts[0] = current position). G2/G3 with arc_fitting, otherwise G1.
  void extrude_run(const std::vector<DPt>& pts, int fPrint) {
    if (dry) { if (pts.size()>1) { px=pts.back().x; py=pts.back().y; curF=fPrint; } return; }
    if (!arc_fitting) { for (size_t i=1;i<pts.size();++i) extrude(pts[i].x,pts[i].y,fPrint); return; }
    size_t i=0, n=pts.size();
    while (i+1<n) { size_t j=try_arc(pts,i,fPrint); if (j>i) i=j; else { extrude(pts[i+1].x,pts[i+1].y,fPrint); ++i; } }
  }
  // Approximate an arc starting at pts[i] (>=5 points, deviation <=0.05mm, r 0.1~200, <=~155°) -> on success emit G2/G3 and return the end index
  size_t try_arc(const std::vector<DPt>& pts, size_t i, int fPrint) {
    const double RMIN=0.1, RMAX=200.0, MAXDEV=0.05;
    size_t n=pts.size(); if (i+4>=n) return i;
    size_t bestE=i; double bcx=0,bcy=0,br=0;
    for (size_t e=i+4; e<n; ++e) {
      size_t mid=i+(e-i)/2; double cx,cy,r;
      if (!circle_from3(pts[i],pts[mid],pts[e],cx,cy,r)) break;
      if (r<RMIN||r>RMAX) break;
      bool okAll=true;
      for (size_t k=i;k<=e;++k){ if (std::fabs(std::hypot(pts[k].x-cx,pts[k].y-cy)-r)>MAXDEV){okAll=false;break;} }
      if (!okAll) break;
      double a0=std::atan2(pts[i].y-cy,pts[i].x-cx), a1=std::atan2(pts[e].y-cy,pts[e].x-cx), sw=a1-a0;
      while(sw>PI)sw-=2*PI; while(sw<-PI)sw+=2*PI;
      if (std::fabs(sw)>2.7) break;                 // avoid full-circle (360°) arcs
      bestE=e; bcx=cx; bcy=cy; br=r;
    }
    if (bestE < i+4) return i;
    DPt a=pts[i], c=pts[bestE];
    double a0=std::atan2(a.y-bcy,a.x-bcx), a1=std::atan2(c.y-bcy,c.x-bcx), sw=a1-a0;
    while(sw>PI)sw-=2*PI; while(sw<-PI)sw+=2*PI;
    bool ccw = sw>0;                                 // CCW → G3, CW → G2
    double arcLen=std::fabs(sw)*br, dE=e_per_mm*arcLen; filament+=dE; ++segments;
    double I=bcx-a.x, J=bcy-a.y;
    if (fPrint!=curF){ std::snprintf(buf,sizeof buf,"%s X%.3f Y%.3f I%.3f J%.3f E%.5f F%d",ccw?"G3":"G2",c.x+offX,c.y+offY,I,J,dE,fPrint); curF=fPrint; }
    else            { std::snprintf(buf,sizeof buf,"%s X%.3f Y%.3f I%.3f J%.3f E%.5f",   ccw?"G3":"G2",c.x+offX,c.y+offY,I,J,dE); }
    raw(buf); px=c.x; py=c.y;
    return bestE;
  }
};

// Toolpath types: 0=travel,1=wall,2=sparse,3=solid,4=skirt/brim,5=support,6=raft,7=gap-fill,8=thin-wall,9=bridge,10=ironing,11=prime-tower
// Per-segment width tracking (for the stage-7 variable-width walls). When g_seg_w is set, every push_seg records the current width into a parallel array.
//  (The existing paths format keeps stride 8 -> the 88 tests are unaffected. widths is one optional extra array with one entry per segment.)
// G003: thread_local so parallel writers (a GW per layer) record their own widths — semantics unchanged on the st/serial path.
static bool g_keep_island = false;   // G003: when the cache is kept, emit copies island instead of moving it (so the cache can be reused repeatedly)
static thread_local std::vector<float>* g_seg_w = nullptr;
static thread_local float g_seg_w_cur = 0.42f;
static inline void push_seg(std::vector<float>& v,double x0,double y0,double x1,double y1,double z,float type){
  v.push_back((float)x0);v.push_back((float)y0);v.push_back((float)z);v.push_back(type);
  v.push_back((float)x1);v.push_back((float)y1);v.push_back((float)z);v.push_back(type);
  if (g_seg_w) g_seg_w->push_back(g_seg_w_cur);
}
static em::val to_f32(const std::vector<float>& v){
  return em::val(em::typed_memory_view(v.size(), v.data())).call<em::val>("slice");
}
// Stage 9: toolpath type -> OrcaSlicer ExtrusionRole integer (for the PressureEqualizer tags, the ExtrusionEntity.hpp enum)
//  0none 1perim 2extperim 4internalinfill 5solidinfill 8ironing 9bridge 11gapfill 12skirt 14support 17wipetower
static int pe_role_of(float type){
  switch ((int)type) {
    case 1: return 2;   // wall → erExternalPerimeter
    case 2: return 4;   // sparse → erInternalInfill
    case 3: return 5;   // solid → erSolidInfill
    case 4: return 12;  // skirt/brim → erSkirt
    case 5: return 14;  // support → erSupportMaterial
    case 6: return 14;  // raft → erSupportMaterial
    case 7: return 11;  // gap-fill → erGapFill
    case 8: return 1;   // thin-wall → erPerimeter
    case 9: return 9;   // bridge → erBridgeInfill
    case 10:return 8;   // ironing → erIroning
    case 11:return 17;  // prime-tower → erWipeTower
    default:return 0;   // erNone
  }
}
// Closed loops (walls/skirt/raft). seamMode: -1 = no rotation, 0 = back, 1 = nearest, 2 = aligned, 3 = random.
// With updateSeam=true the start point is recorded into SeamCtx (for the next layer of aligned).
static void emit_loops(GW& gw, std::vector<float>& tp, Paths loops, double z, float type, int fPrint, int fTravel,
                       int seamMode, SeamCtx& sc, bool updateSeam=false){
  if (gw.dry) {   // G003 E1: seam rotation, position and curF only — the writer pass reproduces the bytes from an identical entry state
    for (Path wp : loops) {
      if (wp.size() < 2) continue;
      rotate_seam(wp, seamMode, sc, gw.px, gw.py);
      gw.px = wp[0].x()*INV; gw.py = wp[0].y()*INV; gw.curF = fPrint;
      if (updateSeam) { sc.lastX=gw.px; sc.lastY=gw.py; sc.has=true; }
    }
    return;
  }
  bool anyRun=false;
  for (Path wp : loops) {
    if (wp.size() < 2) continue;
    if (!anyRun) { gw.pe_begin_run(pe_role_of(type), fPrint); anyRun=true; }
    rotate_seam(wp, seamMode, sc, gw.px, gw.py);
    std::vector<DPt> pts; pts.reserve(wp.size()+1);
    for (auto& q:wp) pts.push_back({q.x()*INV, q.y()*INV});
    pts.push_back(pts.front());                                   // close the loop
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    gw.extrude_run(pts, fPrint);
    if (updateSeam) { sc.lastX=pts[0].x; sc.lastY=pts[0].y; sc.has=true; }
  }
  if (anyRun) gw.pe_end_run();
}
// Open lines (infill/support). Arc fitting applies.
static void emit_lines(GW& gw, std::vector<float>& tp, const Paths& lines, double z, float type, int fPrint, int fTravel){
  if (gw.dry) {
    for (const Path& ln : lines) if (ln.size() >= 2) { gw.px = ln.back().x()*INV; gw.py = ln.back().y()*INV; gw.curF = fPrint; }
    return;
  }
  bool anyRun=false;
  for (const Path& ln : lines) {
    if (ln.size() < 2) continue;
    if (!anyRun) { gw.pe_begin_run(pe_role_of(type), fPrint); anyRun=true; }
    std::vector<DPt> pts; pts.reserve(ln.size());
    for (auto& q:ln) pts.push_back({q.x()*INV, q.y()*INV});
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    gw.extrude_run(pts, fPrint);
  }
  if (anyRun) gw.pe_end_run();
}
// Stage 19 -> WP3: one real tree support toolpath — per-path width plus the upstream ExtrusionPath's role/height/mm3_per_mm.
struct TreePath { Path pl; float w; int role; float h; float mm3; };
// Stage 19 -> WP3: tree support emission — open polylines with per-path width. E uses the upstream mm3_per_mm when present
//  (set_e_per_mm_vol — reproducing the upstream Flow rate, e.g. on bridging contact layers), otherwise the old width x height rectangular approximation.
//  The PE role splits runs by each path's upstream role (base 14 / interface 15), preserving the upstream role distinction.
static void emit_lines_vw(GW& gw, std::vector<float>& tp, const std::vector<TreePath>& lines,
                          double z, double h, const Params& p, float type, int fPrint, int fTravel){
  if (gw.dry) {   // G003 E1: position and curF only (E/flow state is reset at every layer start, so it does not chain)
    for (const auto& lw : lines) if (lw.pl.size() >= 2) { gw.px = lw.pl.back().x()*INV; gw.py = lw.pl.back().y()*INV; gw.curF = fPrint; }
    return;
  }
  int curRole = -1;
  for (const auto& lw : lines) {
    const Path& ln = lw.pl;
    if (ln.size() < 2) continue;
    const int role = (lw.role > 0) ? lw.role : pe_role_of(type);
    if (role != curRole) { if (curRole >= 0) gw.pe_end_run(); gw.pe_begin_run(role, fPrint); curRole = role; }
    const double ph = (lw.h > 1e-6) ? lw.h : h;
    if (lw.mm3 > 1e-9) gw.set_e_per_mm_vol(lw.mm3, p);
    else               gw.set_e_per_mm_width(lw.w, ph, p);
    g_seg_w_cur = lw.w;
    std::vector<DPt> pts; pts.reserve(ln.size());
    for (auto& q:ln) pts.push_back({q.x()*INV, q.y()*INV});
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    gw.extrude_run(pts, fPrint);
  }
  if (curRole >= 0) gw.pe_end_run();
  g_seg_w_cur = (float)p.line_width; gw.set_e_per_mm(h, p);   // restore the default width/E
}
// Stage 7: emit the real ported Arachne variable-width walls. E is computed from the per-segment width (set_e_per_mm_width) and widths is recorded.
static void emit_arachne_walls(GW& gw, std::vector<float>& tp, const std::vector<arachne_bridge::WLine>& walls,
                               double z, double h, const Params& p, int fPrint, int fTravel){
  bool anyRun=false;
  for (const auto& wl : walls) {
    if (wl.pts.size() < 2) continue;
    if (!anyRun) { gw.pe_begin_run(2 /*erExternalPerimeter*/, fPrint); anyRun=true; }
    push_seg(tp, gw.px, gw.py, wl.pts[0].x, wl.pts[0].y, z, 0.0f);
    gw.travel(wl.pts[0].x, wl.pts[0].y, fTravel);
    size_t n = wl.pts.size();
    for (size_t i=1;i<n;++i) {
      double sw = 0.5*(wl.pts[i-1].w + wl.pts[i].w);
      gw.set_e_per_mm_width(sw, h, p); g_seg_w_cur = (float)sw;
      push_seg(tp, wl.pts[i-1].x, wl.pts[i-1].y, wl.pts[i].x, wl.pts[i].y, z, 1.0f);
      gw.extrude(wl.pts[i].x, wl.pts[i].y, fPrint);
    }
    if (wl.closed) {
      double sw = 0.5*(wl.pts[n-1].w + wl.pts[0].w);
      gw.set_e_per_mm_width(sw, h, p); g_seg_w_cur = (float)sw;
      push_seg(tp, wl.pts[n-1].x, wl.pts[n-1].y, wl.pts[0].x, wl.pts[0].y, z, 1.0f);
      gw.extrude(wl.pts[0].x, wl.pts[0].y, fPrint);
    }
  }
  if (anyRun) gw.pe_end_run();
  g_seg_w_cur = (float)p.line_width;
}
// Spiral (vase): a single outer wall rising continuously from z0 to z0+h around the perimeter
static void emit_spiral(GW& gw, std::vector<float>& tp, const Paths& outerWall, double z0, double h, int fPrint, int fTravel){
  if (outerWall.empty() || outerWall[0].size()<2) return;
  const Path& wp = outerWall[0];
  std::vector<DPt> pts; for (auto& q:wp) pts.push_back({q.x()*INV, q.y()*INV}); pts.push_back(pts.front());
  push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z0, 0.0f);
  gw.travel(pts[0].x, pts[0].y, fTravel);
  double total=0; for (size_t i=1;i<pts.size();++i) total+=std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  double acc=0;
  for (size_t i=1;i<pts.size();++i){
    acc += std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
    double zz = z0 + h*(total>1e-9 ? acc/total : 0.0);
    gw.extrude_z(pts[i].x, pts[i].y, zz, fPrint);
    push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, zz, 1.0f);
  }
}
// Scarf joint seam (outer wall loop): ramp z (z-h -> z) and flow (0 -> 1) up at the start, then ramp down over the same length at the end with an overlap (flow 1 -> 0).
//  ⚠ An approximation — a gentle sloped joint instead of a z-seam blob. Applied to the outer wall only when seam_slope_type=external/all.
static void emit_scarf_loop(GW& gw, std::vector<float>& tp, Path wp, double z, double h,
                            int fPrint, int fTravel, int seamMode, SeamCtx& sc){
  if (wp.size() < 3) return;
  rotate_seam(wp, seamMode, sc, gw.px, gw.py);
  std::vector<DPt> pts; pts.reserve(wp.size()+1);
  for (auto& q:wp) pts.push_back({q.x()*INV, q.y()*INV});
  pts.push_back(pts.front());
  double L=0; for (size_t i=1;i<pts.size();++i) L+=std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  double slen = std::min(gw.scarf_len, 0.45*L); if (slen < 1e-3) slen = 0.45*L;
  push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
  gw.travel(pts[0].x, pts[0].y, fTravel);
  gw.raw("; scarf");
  double startZ = z - h;
  double sub = std::max(0.2, slen/8.0);   // ramp subdivision step (so long straight walls also rise continuously in z)
  // Ramp up: over the first slen, z goes (z-h) -> z and flow 0 -> 1 (subdivided into segments)
  double s=0; size_t i=1;
  for (; i<pts.size(); ++i){
    double segx=pts[i].x-pts[i-1].x, segy=pts[i].y-pts[i-1].y, seg=std::hypot(segx,segy);
    int steps = std::max(1, (int)std::ceil(seg/sub));
    for (int st=1; st<=steps; ++st){
      double f=(double)st/steps, x=pts[i-1].x+segx*f, y=pts[i-1].y+segy*f;
      double t=std::min(1.0, (s+seg*f)/slen), zz=startZ + h*t, flow=std::max(0.05, t);
      double ax=gw.px, ay=gw.py;
      gw.extrude_zf(x, y, zz, flow, fPrint);
      push_seg(tp, ax,ay, x,y, zz, 1.0f);
    }
    s+=seg; if (s>=slen) { ++i; break; }
  }
  // Flat middle: z, flow 1
  for (; i<pts.size(); ++i){
    double ax=gw.px, ay=gw.py;
    gw.extrude(pts[i].x, pts[i].y, fPrint);
    push_seg(tp, ax,ay, pts[i].x,pts[i].y, z, 1.0f);
  }
  // Overlapping ramp down: retrace slen from the start, keeping z and taking flow 1 -> 0 (finishing over the ramp-up)
  double s2=0;
  for (size_t k=1;k<pts.size();++k){
    double segx=pts[k].x-pts[k-1].x, segy=pts[k].y-pts[k-1].y, seg=std::hypot(segx,segy);
    int steps = std::max(1, (int)std::ceil(seg/sub));
    for (int st=1; st<=steps; ++st){
      double f=(double)st/steps, x=pts[k-1].x+segx*f, y=pts[k-1].y+segy*f;
      double t=std::min(1.0,(s2+seg*f)/slen), flow=std::max(0.05, 1.0-t);
      double ax=gw.px, ay=gw.py;
      gw.extrude_zf(x, y, z, flow, fPrint);
      push_seg(tp, ax,ay, x,y, z, 1.0f);
    }
    s2+=seg; if (s2>=slen) break;
  }
  sc.lastX=pts[0].x; sc.lastY=pts[0].y; sc.has=true;
}

// Layer data (2-pass)
struct LayerData {
  double z=0; int idx=0; double h=0;
  Paths contour;                 // outer contour (holes included)
  std::vector<Paths> walls;      // wall loops (outermost to innermost)
  Paths fill;                    // infill region (innermost wall -w/2)
  Paths topSurf, botSurf;        // exposed surfaces (difference with the neighbors)
  Paths supBase, supIface;       // support body (sparse) / interface (solid)
  // Stages 18/19 -> WP3: real tree support toolpaths (TreePath: width + the upstream role/height/mm3_per_mm)
  std::vector<TreePath> supTree;
  Paths thin;                    // thin-wall (narrower than 2w) regions — handled with a single center line
  Paths island;                  // region travels stay inside (contour −w/2) — precomputed in PASS1 (parallel), moved at emission
  std::vector<arachne_bridge::WLine> arachneWalls;  // stage 7: the real Arachne variable-width walls (arachne mode)
};

// Slice the triangle subset [lo,hi) at a z plane -> contour
static Paths slice_group(const std::vector<Tri>& tris, int lo, int hi, double z){
  std::vector<Seg> segs; Seg sg;
  for (int ti=lo; ti<hi; ++ti){ const Tri& t=tris[ti];
    double zmin=std::min({t.v[0].z,t.v[1].z,t.v[2].z}), zmax=std::max({t.v[0].z,t.v[1].z,t.v[2].z});
    if (z<zmin||z>=zmax) continue; if (tri_plane(t,z,sg)) segs.push_back(sg); }
  return SimplifyPolygons(chain_polys(segs), pftEvenOdd);
}
// =============================================================================
// Multi-material basics (a stretch goal): two triangle groups (mm_group_split) are sliced separately within a layer,
//  and a group switch emits T0/T1 plus a simple prime tower (a 15x15 square ring in the bed corner, only on switching layers).
//  ⚠ Not a proper wipe tower — no purge/ramming/wipe volume calculation and no tower density optimization. Walls + sparse infill only.
// =============================================================================
static em::val slice_multimaterial(std::vector<Tri>& tris, const Params& p, em::val onProgress,
                                   double height, bool over_bed){
  auto report=[&](int d,int t){ if(!onProgress.isUndefined()&&!onProgress.isNull()) onProgress(d,t); };
  const double w=p.line_width;
  int split=p.mm_group_split, NT=(int)tris.size();
  int N=0; for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) ++N;

  GW gw; gw.s.reserve(1<<16);
  gw.retract_len=p.retract_length; gw.retractF=(int)std::llround(p.retract_speed*60); gw.z_hop=p.z_hop;
  gw.retract_min_travel=p.retraction_minimum_travel;
  gw.offX=p.bed_width*0.5; gw.offY=p.bed_depth*0.5;
  gw.filament_area=PI*p.filament_diameter*p.filament_diameter/4.0;
  SeamCtx seamCtx;
  gw.raw("; OrcaSlicer RE mini-kernel (Track C stage 6) — MULTIMATERIAL (basic, NOT a real wipe tower)");
  { char h[200];
    std::snprintf(h,sizeof h,"; MM extruders=%d group_split=%d/%d  lh=%.3f lw=%.3f walls=%d infill=%.2f",
      p.extruder_count,split,NT,p.layer_height,w,p.wall_loops,p.infill_density); gw.raw(h);
    std::snprintf(h,sizeof h,"M140 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M104 S%.0f",p.nozzle_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M190 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M109 S%.0f",p.nozzle_temp); gw.raw(h); }
  gw.raw("G21 ; mm"); gw.raw("G90 ; absolute XYZ"); gw.raw("M83 ; relative E");
  gw.raw("T0 ; start extruder"); gw.raw("G92 E0");

  int fTravel=(int)std::llround(p.travel_speed*60);
  double sparse_sp=(p.infill_density>1e-4)?(w/p.infill_density):(w*3.0);
  // Prime tower fallback (square ring). Stage 33: position (10,10) and size 15 were hardcoded -> now wired to prime_tower_x/y/ring_size.
  //  Note: the default path is wipe_tower_real (the real WipeTower) and this ring is the fallback when that fails.
  double ptx=p.prime_tower_x-gw.offX, pty=p.prime_tower_y-gw.offY;
  const double ptSize=p.prime_tower_ring_size;
  auto primeRings=[&](){ Paths ps; for(int k=0;k<3;++k){ double o=k*w; double x0=ptx+o,y0=pty+o,x1=ptx+ptSize-o,y1=pty+ptSize-o;
    Path r; r.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y0*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y0*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y1*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y1*SCALE))); ps.push_back(r);} return ps; };

  em::val layersArr=em::val::array();
  int curTool=0;
  double zShift=0.0;
  for (int i=0;i<N;++i){
    double z=p.first_layer_height + (i>0? i*p.layer_height : 0.0);   // approximate z
    double zE=z+zShift, h=(i==0)?p.first_layer_height:p.layer_height;
    gw.set_e_per_mm(h,p); gw.z=zE; gw.pe_reset();
    std::vector<float> tp, widths; g_seg_w = &widths; g_seg_w_cur = (float)p.line_width;   // stage 21: record MM widths
    char cm[64]; std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.raw(cm);
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
    int fPr=(int)std::llround(((i==0)?p.first_layer_speed:p.print_speed)*60);

    Paths c0=slice_group(tris,0,split,z), c1=slice_group(tris,split,NT,z);
    gw.island = Paths{};
    auto emitGroup=[&](const Paths& contour){
      if (contour.empty()) return;
      Paths last=contour; std::vector<Paths> walls;
      for (int wl=0; wl<p.wall_loops; ++wl){ Paths wp=offset_paths(contour,-(w*0.5+wl*w)); if(wp.empty())break; walls.push_back(wp); last=wp; }
      for (auto& wpz:walls) emit_loops(gw,tp,wpz,zE,1.0f,fPr,fTravel,-1,seamCtx);
      Paths fill = last.empty()?Paths{}:offset_paths(last,-w*0.5);
      if (!fill.empty()){ Paths lines=infill_clipped(fill,(i%2?135.0:45.0),sparse_sp); if(!lines.empty()) emit_lines(gw,tp,lines,zE,2.0f,fPr,fTravel); }
    };
    auto toolTo=[&](int t){ if(curTool!=t){ gw.raw(t==0?"T0":"T1"); curTool=t; } };

    if (!c0.empty()){ toolTo(0); emitGroup(c0); }
    if (!c1.empty()){
      if (!c0.empty()){                                   // a switch within the layer -> prime tower
        toolTo(1);
        if (p.wipe_tower_real) {                          // stage 12: the real WipeTower.generate()
          auto wt = config_bridge::wipe_tower_block(p.bed_width,p.bed_depth,p.first_layer_height,
                        p.layer_height, zE, i==0, 0, 1, p.prime_tower_x, p.prime_tower_y,   // stage 33: the 10,10 constants -> wipe_tower_x/y
                        p.prime_tower_width, p.filament_diameter);
          if (wt.ok) {
            gw.raw("; wipe_tower_real: real ported WipeTower.generate()");
            gw.raw(wt.gcode.c_str());
            gw.filament += wt.filament_mm;
            for (float f : wt.toolpath) tp.push_back(f);
          } else {                                        // square ring fallback on failure
            gw.raw("; prime tower (fallback square ring)");
            emit_loops(gw,tp,primeRings(),zE,11.0f,fPr,fTravel,-1,seamCtx);
          }
        } else {
          gw.raw("; prime tower (basic — NOT a real wipe tower)");
          emit_loops(gw,tp,primeRings(),zE,11.0f,fPr,fTravel,-1,seamCtx);
        }
      } else toolTo(1);
      emitGroup(c1);
    }
    em::val Lo=em::val::object(); Lo.set("z",zE); Lo.set("paths",to_f32(tp)); Lo.set("widths",to_f32(widths)); layersArr.call<void>("push",Lo);
    report(i+1,N);
  }
  g_seg_w = nullptr;   // stage 21: the local MM widths goes out of scope here
  gw.raw("; end"); gw.raw("M104 S0"); gw.raw("M140 S0"); gw.raw("M107");
  { char h[64]; std::snprintf(h,sizeof h,"; filament used: %.2f mm",gw.filament); gw.raw(h); }
  em::val result=em::val::object(), stats=em::val::object();
  stats.set("layers",N); stats.set("model_layers",N); stats.set("raft_layers",0);
  stats.set("path_segments",(double)gw.segments); stats.set("filament_mm",gw.filament);
  stats.set("over_bed",over_bed); stats.set("wall_crossings",(double)gw.wall_crossings);
  stats.set("extruders",p.extruder_count);
  result.set("gcode",gw.s); result.set("stats",stats); result.set("layers",layersArr);
  return result;
}

// =============================================================================
// Stage 30: layer streaming sink. When the viewer (worker) registers one with set_layer_sink(cb), slice() emits each layer via
//  cb(z, layerIndex, gcodeChunk, pathsF32, widthsF32) and frees that layer's buffers from the heap instead of keeping them resident
//  (the §6.8 output streaming round). With no sink registered the old batch path runs (byte-identical). It is a function-local static so it is
//  initialized safely on the first call after runtime startup (avoiding global em::val static initialization order issues). Only one slice at a time is assumed.
static em::val& layer_sink() { static em::val s = em::val::undefined(); return s; }
static void set_layer_sink(em::val cb) { layer_sink() = cb; }
static void clear_layer_sink() { layer_sink() = em::val::undefined(); }

// PE tag stripping (a stateless line filter) — applied to the whole g-code in batch mode and per chunk when streaming (chunks end on '\n',
//  so no line is cut and the result is the same). Deletes ;_EXTRUSION_ROLE/;_EXTRUDE_END lines and strips the trailing
//  ;_EXTRUDE_SET_SPEED/;_EXTERNAL_PERIMETER comments (the G1 F lines are kept).
static void strip_pe_tags(std::string& g) {
  std::string out; out.reserve(g.size());
  size_t i=0, n=g.size();
  while (i<n) {
    size_t e=g.find('\n', i); if (e==std::string::npos) e=n;
    std::string line=g.substr(i, e-i);
    bool drop=false;
    if (line.compare(0,17,";_EXTRUSION_ROLE:")==0) drop=true;
    else if (line.compare(0,13,";_EXTRUDE_END")==0) drop=true;
    if (!drop) {
      size_t t;
      if ((t=line.find(" ;_EXTRUDE_SET_SPEED"))!=std::string::npos) line.erase(t);
      else if ((t=line.find(";_EXTRUDE_SET_SPEED"))!=std::string::npos) line.erase(t);
      if ((t=line.find(";_EXTERNAL_PERIMETER"))!=std::string::npos) line.erase(t);
      while (!line.empty() && (line.back()==' '||line.back()=='\t')) line.pop_back();
      out += line; out += '\n';
    }
    i = e+1;
  }
  g.swap(out);
}

#ifdef __EMSCRIPTEN_PTHREADS__
// (mt) Time estimate overlap — the emitting thread (producer) queues chunks on '\n' boundaries and a single worker (consumer)
//  exclusively runs gcodeproc_bridge::estimate_begin/feed. The bridge state (the file-static g_gp) is touched only by the worker between
//  begin and feed; finish()'s join establishes happens-before, after which estimate_end() runs on the caller's thread.
//  Chunk contents and order are unchanged -> identical estimates and no effect on G-code (golden-safe). Only wall-clock shrinks as emission and parsing overlap.
struct TimeFeeder {
  std::thread th; std::mutex mu; std::condition_variable cv;
  std::deque<std::string> q; bool done = false;
  void begin(const gcodeproc_bridge::Limits& gl) {
    th = std::thread([this, gl]{
      gcodeproc_bridge::estimate_begin(gl);
      for (;;) {
        std::string c;
        { std::unique_lock<std::mutex> lk(mu);
          cv.wait(lk, [&]{ return !q.empty() || done; });
          if (q.empty()) break;                       // done && queue drained -> exit
          c = std::move(q.front()); q.pop_front(); }
        gcodeproc_bridge::estimate_feed(c);
      }
    });
  }
  void feed(std::string c) {
    if (c.empty()) return;
    { std::lock_guard<std::mutex> lk(mu); q.push_back(std::move(c)); }
    cv.notify_one();
  }
  gcodeproc_bridge::Result finish() {
    { std::lock_guard<std::mutex> lk(mu); done = true; }
    cv.notify_one(); th.join();
    return gcodeproc_bridge::estimate_end();
  }
};
#endif

// Per-layer precomputation for PASS2 (geometry separation, infill line generation) — kept apart from emission (serial, gw/seam state).
//  It holds only deterministic per-layer independent work, so mt builds can precompute it on workers (identical results, verified with golden).
struct ThinRun { Paths line; double flow; };
struct EmitPre {
  Paths gapLines, solidLines, topLines, bridgeLines, sparseLines, supI, supB, flExtra, ironLines;
  std::vector<ThinRun> thinRuns;
  bool brim=false; int fPrint=0, fBridge=0, fSup=0;
};

// G003 step 1: the normal layer emission body extracted — a single implementation shared by the serial path and (in step 2) the parallel writer.
//  Behavior unchanged (a pure move) — equivalence verified by the golden and st vs mt gates.
static void emit_layer_full(GW& gw, std::vector<float>& tp, std::vector<float>& widths,
                            int i, LayerData& ld, EmitPre& pre, const Params& p,
                            double zE, double w, int N, int nraft, int fTravel,
                            int seamMode, bool scarfOn, bool ironOn, SeamCtx& seamCtx) {
    char cm[72]; (void)cm; (void)widths; (void)N;
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);

    // --- Emission path: unpack the compute_pre results (aliases so the emission code stays untouched) ---
    Paths& gapLines = pre.gapLines;       std::vector<ThinRun>& thinRuns = pre.thinRuns;
    Paths& solidLines = pre.solidLines;   Paths& topLines = pre.topLines;
    Paths& bridgeLines = pre.bridgeLines; Paths& sparseLines = pre.sparseLines;
    Paths& supI = pre.supI; Paths& supB = pre.supB; Paths& flExtra = pre.flExtra;
    const bool brim = pre.brim; const int fPrint = pre.fPrint, fBridge = pre.fBridge;
    // Stage 21: per-feature widths (the first layer uses the initial_layer values throughout) — scalars, so they are recomputed at emission (same formula).
    bool firstL = (i==0 && nraft==0);
    double wOuter  = firstL ? p.initial_layer_line_width : p.outer_wall_line_width;
    double wInner  = firstL ? p.initial_layer_line_width : p.inner_wall_line_width;
    double wSolid  = firstL ? p.initial_layer_line_width : p.internal_solid_infill_line_width;
    double wTop    = firstL ? p.initial_layer_line_width : p.top_surface_line_width;
    double wSparse = firstL ? p.initial_layer_line_width : p.sparse_infill_line_width;

    // Stage 21: helper that applies a feature width — set_e_per_mm_width (E) and g_seg_w_cur (the ribbon) together. With the default (0.42) the values are unchanged.
    auto setW = [&](double ww){ gw.set_e_per_mm_width(ww, ld.h, p); g_seg_w_cur = (float)ww; };

    // --- Emission: support -> skirt/brim -> walls (seam/scarf) -> thin walls -> gap fill -> bridge -> solid -> sparse ---
    if (!supI.empty() || !supB.empty()) {
      gw.raw("; support");
      if (!supI.empty()) emit_lines(gw, tp, supI, zE, 5.0f, fPrint, fTravel);
      if (!supB.empty()) emit_lines(gw, tp, supB, zE, 5.0f, fPrint, fTravel);
    }
    if (p.enable_support && !ld.supTree.empty()) {                    // stages 18/19: the real organic tree support (per-path width)
      gw.raw("; support (organic tree — real ported TreeSupport)");
      emit_lines_vw(gw, tp, ld.supTree, zE, ld.h, p, 5.0f, fPrint, fTravel);
    }
    if (!flExtra.empty()) { gw.raw(brim ? "; skirt/brim" : "; skirt"); emit_loops(gw, tp, flExtra, zE, 4.0f, fPrint, fTravel, -1, seamCtx); }
    if (p.wall_generator=="arachne" && !ld.arachneWalls.empty()) {
      gw.raw("; walls (Arachne — real ported WallToolPaths, variable width)");
      emit_arachne_walls(gw, tp, ld.arachneWalls, zE, ld.h, p, fPrint, fTravel);
      gw.set_e_per_mm(ld.h, p); g_seg_w_cur=(float)w;   // restore the default width/flow (for the infill that follows)
    } else {
      for (size_t wi=0; wi<ld.walls.size(); ++wi) {
        setW(wi==0 ? wOuter : wInner);   // stage 21: outer wall (wi==0) = outer_wall_line_width, inner walls = inner_wall_line_width
        if (wi==0 && scarfOn) { for (Path wp : ld.walls[wi]) emit_scarf_loop(gw, tp, wp, zE, ld.h, fPrint, fTravel, seamMode, seamCtx); }
        else                    emit_loops(gw, tp, ld.walls[wi], zE, 1.0f, fPrint, fTravel, seamMode, seamCtx, wi==0);  // record the seam only for the outer wall (wi==0)
      }
    }
    if (!thinRuns.empty()) {
      gw.raw("; thin-wall (Arachne-lite: single centerline, NOT full Arachne)");
      gw.pe_reset();                                 // low-flow thin walls are excluded from PE flow matching (avoids abrupt cross-section changes)
      double saved = gw.e_per_mm;
      for (auto& tr : thinRuns) { gw.e_per_mm = saved * tr.flow; emit_lines(gw, tp, tr.line, zE, 8.0f, fPrint, fTravel); }
      gw.e_per_mm = saved; gw.pe_reset();
    }
    setW(firstL ? p.initial_layer_line_width : p.line_width);   // stage 21: gap/bridge use the default width
    if (!gapLines.empty()) { gw.raw("; gap-fill"); emit_lines(gw, tp, gapLines, zE, 7.0f, fPrint, fTravel); }
    if (!bridgeLines.empty()) {
      gw.raw("; bridge (unsupported bottom: fan 100% + bridge_speed)");
      int savedFan = gw.lastFan; gw.set_fan(255);
      emit_lines(gw, tp, bridgeLines, zE, 9.0f, fBridge, fTravel);
      gw.set_fan(savedFan < 0 ? 0 : savedFan);
    }
    if (!solidLines.empty()) { setW(wSolid); emit_lines(gw, tp, solidLines, zE, 3.0f, fPrint, fTravel); }   // stage 21: internal solid width
    if (!topLines.empty())   { setW(wTop);   emit_lines(gw, tp, topLines,   zE, 3.0f, fPrint, fTravel); }   // stage 21: top-surface width
    if (!sparseLines.empty()){ setW(wSparse);emit_lines(gw, tp, sparseLines,zE, 2.0f, fPrint, fTravel); }   // stage 21: sparse infill width

    // Ironing (type10): a low-flow second pass at the same z over exposed top solid (the lines come from compute_pre).
    {
      Paths& ironLines = pre.ironLines;
      if (!ironLines.empty()) {
        gw.raw("; ironing");
        gw.pe_reset();                               // low-flow ironing is excluded from PE flow matching
        int fIron = (int)std::llround(std::max(5.0, p.ironing_speed)*60);
        double saved = gw.e_per_mm; gw.e_per_mm = saved * std::max(0.0, p.ironing_flow/100.0);
        emit_lines(gw, tp, ironLines, zE, 10.0f, fIron, fTravel);
        gw.e_per_mm = saved; gw.pe_reset();
      }
    }

}

// G003 step 2: full emission of one layer (setup + the empty/normal branches) — a single implementation shared by the serial path and the parallel writer.
//  Spiral mode is inlined at the call site (guarded out of parallelism), and scarf/PE tags/PE-lite/arachne/real PE also fall back to serial via the parEmit guard.
static void emit_layer_any(GW& gw, std::vector<float>& tp, std::vector<float>& widths,
                           int i, LayerData& ld, EmitPre& pre, const Params& p,
                           double zE, double w, int N, int nraft, int fTravel,
                           int seamMode, bool scarfOn, bool ironOn, SeamCtx& seamCtx) {
  gw.set_e_per_mm(ld.h, p);
  gw.z = zE;
  gw.pe_reset();
  if (!gw.dry) gw.island = g_keep_island ? ld.island : std::move(ld.island);   // G003: copy when the cache is kept
  seamCtx.rng = 2654435761u * (uint32_t)(i+1);
  g_seg_w = gw.dry ? nullptr : &widths; g_seg_w_cur = (float)w;
  char cm[72];
  if (ld.contour.empty()) {
    // Stage 33 [floating model fix] Support must be emitted even on layers with no model.
    std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f (no model)",i,zE); gw.raw(cm);
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
    gw.z = zE; gw.set_e_per_mm(ld.h, p); gw.pe_reset();
    gw.set_fan(fan_S(i, p));
    const int fSup = pre.fSup;
    Paths& eI = pre.supI;
    Paths& eB = pre.supB;
    if (!eI.empty() || !eB.empty()) {
      gw.raw("; support");
      if (!eI.empty()) emit_lines(gw, tp, eI, zE, 5.0f, fSup, fTravel);
      if (!eB.empty()) emit_lines(gw, tp, eB, zE, 5.0f, fSup, fTravel);
    }
    if (p.enable_support && !ld.supTree.empty()) {
      gw.raw("; support (organic tree — real ported TreeSupport)");
      emit_lines_vw(gw, tp, ld.supTree, zE, ld.h, p, 5.0f, fSup, fTravel);
    }
    return;
  }
  std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.raw(cm);
  gw.set_fan(fan_S(i, p));
  emit_layer_full(gw, tp, widths, i, ld, pre, p, zE, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, seamCtx);
}

// G003 incremental re-slice: a stage cache between slices. Filled via keep_stages and reused via reuse_stages.
//  Validity is decided first by the viewer (geometry digest + invalidation-map); the kernel adds layerKey (layering/support
//  parameter snapshot) as a second line of defense, refusing reuse on a mismatch. Keeping the cache resident is a memory trade-off (tens of MB after the simplification).
static struct StageCache {
  bool valid = false;
  std::vector<Tri> tris; double height = 0, cx = 0, cy = 0; bool over_bed = false;
  int N = 0; std::string layerKey;
  int treeSupLayers = 0; double treeZMaxResid = -1.0;   // for reproducing the preamble diagnostic lines
  std::vector<LayerData> L;
} g_scache;
static std::string make_layer_key(const Params& p) {
  char k[512];
  std::snprintf(k, sizeof k, "%.6f|%.6f|%.6f|%d|%d|%s|%d|%.3f|%.3f|%.3f|%.3f|%d|%d|%s|%s|%.3f|%d|%.4f|%d",
    p.layer_height, p.first_layer_height, p.line_width, p.wall_loops, (int)p.enable_support,
    p.support_style.c_str(), (int)p.support_auto, p.support_threshold_angle, p.support_top_z_distance,
    p.support_xy_distance, p.support_density, p.support_interface_top_layers, p.raft_layers,
    p.wall_generator.c_str(), p.sparse_infill_pattern.c_str(), p.infill_density,
    (int)p.auto_center, p.gcode_resolution, (int)p.spiral_mode);
  return std::string(k);
}

// slice(Uint8Array stl, string paramsJson, function onProgress) → { gcode, stats, layers[] }
// =============================================================================
em::val slice(em::val stl_bytes, std::string params_json, em::val onProgress) {
  auto report = [&](int done, int total){ if (!onProgress.isUndefined() && !onProgress.isNull()) onProgress(done, total); };
  Params p = parse_params(params_json);
  if (p.spiral_mode) p.wall_loops = 1;                 // vase: a single outer wall
  // G002: cancel flag — the UI writes 1 via SAB. Reset to 0 on entry; the loops poll it per iteration.
  auto* cxp = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::cancel_addr();
  cxp->store(0);
  auto CX = [cxp]{ return cxp->load(std::memory_order_relaxed) != 0; };
  // G003 incremental: reuse decision (viewer first, layerKey as the second line of defense). Not supported for MM.
  const std::string lk = make_layer_key(p);
  const bool reuseGeom = p.reuse_stages >= 1 && g_scache.valid && p.extruder_count < 2;
  const bool reuseSup  = p.reuse_stages >= 2 && g_scache.valid && g_scache.layerKey == lk && p.extruder_count < 2;
  std::vector<Tri> trisOwn;
  if (!reuseGeom) {
    std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl_bytes);
    trisOwn = parse_stl(bytes);
  }
  std::vector<Tri>& tris = reuseGeom ? g_scache.tris : trisOwn;

  em::val result = em::val::object();
  if (tris.empty()) { result.set("error", std::string("STL parse failed or 0 triangles")); return result; }

  // Move the model so XY is centered on the origin and minZ=0 (with reuseGeom the cached copy is already normalized)
  double minx=1e18,miny=1e18,minz=1e18,maxx=-1e18,maxy=-1e18,maxz=-1e18;
  if (reuseGeom) { minx=miny=minz=0; maxx=maxy=maxz=0; }
  else
  for (auto& t:tris) for (int k=0;k<3;++k){
    minx=std::min(minx,(double)t.v[k].x);maxx=std::max(maxx,(double)t.v[k].x);
    miny=std::min(miny,(double)t.v[k].y);maxy=std::max(maxy,(double)t.v[k].y);
    minz=std::min(minz,(double)t.v[k].z);maxz=std::max(maxz,(double)t.v[k].z); }
  double cx=(minx+maxx)/2, cy=(miny+maxy)/2;
  if (reuseGeom) { cx = g_scache.cx; cy = g_scache.cy; }
  // Stage 28 P2: with auto_center=true the combined bbox is realigned to the origin (legacy). false (default) = keep the viewer XY coordinates and only seat Z.
  //  G003: with reuseGeom the cached tris are already normalized — do not move again (avoids a double shift).
  if (!reuseGeom) {
    if (p.auto_center) { for (auto& t:tris) for (int k=0;k<3;++k){ t.v[k].x-=cx; t.v[k].y-=cy; t.v[k].z-=minz; } }
    else               { for (auto& t:tris) for (int k=0;k<3;++k){ t.v[k].z-=minz; } }
  }
  double height = reuseGeom ? g_scache.height : (maxz - minz);
  double modelW = maxx - minx, modelD = maxy - miny;
  // over_bed: too large || (viewer coordinate mode) the G-code position (+bed/2) leaves the bed [0,bed] (i.e. outside [-bed/2,bed/2] in raw coordinates)
  bool over_bed = (modelW > p.bed_width) || (modelD > p.bed_depth);
  if (!p.auto_center) over_bed = over_bed || maxx > p.bed_width*0.5 || minx < -p.bed_width*0.5
                                          || maxy > p.bed_depth*0.5 || miny < -p.bed_depth*0.5;
  if (reuseGeom) over_bed = g_scache.over_bed;

  const double w = p.line_width;
  const double sparse_spacing  = (p.infill_density > 1e-4) ? (w / p.infill_density) : 0.0;
  const double solid_spacing   = w;   // solid = 100% fill
  const double support_spacing = (p.support_density > 1e-4) ? (w / p.support_density) : (w*3.0);

  // Multi-material (stretch goal): with two groups, branch to the separate-slice + T0/T1 + prime tower path
  if (p.extruder_count >= 2 && p.mm_group_split > 0 && p.mm_group_split < (int)tris.size())
    return slice_multimaterial(tris, p, onProgress, height, over_bed);

  // Count the z levels (the progress total)
  int N = 0; for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) ++N;
  int total = 2*N + 2;   // +2 = the surface and support completion ticks. Previously nothing was reported between PASS1 (50%) and the end of support -> it looked "stuck at 50%".

  // Phase timing (exposed only through stats — no effect on g-code, golden-safe)
  double tw0 = emscripten_get_now(), tw_p1 = 0, tw_p15 = 0, tw_sup = 0;
  double t_flush = 0;          // accumulated flush_layer time (the JS boundary: to_f32/layersArr/sink + feeding the estimator) — the rest is G1 formatting

  // ---- PASS 1: per-layer contours, walls and infill regions ----
  //  No inter-layer dependencies (reads: the shared immutable tris/p, writes: an independent L[i]) -> layers run in parallel in -pthread builds.
  //  z is precomputed serially exactly like the old accumulating loop (z+=layer_height) — preserving FP accumulation order (golden-safe).
  const bool keepStages = (p.keep_stages || reuseSup) && p.extruder_count < 2;
  g_keep_island = keepStages;
  double treeZMaxResid = -1.0; int treeSupLayers = 0;   // stage 19: tree support z alignment diagnostics (G003: hoisted)
  std::vector<LayerData> Lown;
  if (!reuseSup) Lown.resize(N);
  std::vector<LayerData>& L = reuseSup ? g_scache.L : Lown;
  if (reuseSup) {
    // G003: geometry and support settings unchanged — PASS1, surfaces and support all come from the cache; only emission re-runs.
    tw_p1 = tw_p15 = emscripten_get_now();
    treeSupLayers = g_scache.treeSupLayers; treeZMaxResid = g_scache.treeZMaxResid;
    report(N, total); report(N+1, total);
  } else {
  { std::vector<double> zsv; zsv.reserve(N);
    for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) zsv.push_back(z);
    // [facet-major segment collection — matching upstream] Like the upstream slice_facet_at_zs (TriangleMeshSlicer.cpp:476),
    //  each triangle binary-searches and visits "only the layers it spans" (work = the number of real intersections). The old layer x full-scan was 657 x 775k
    //  ≈ 500M visits. The inclusion condition is unchanged (zmin<=z<zmax -> lower_bound + *it<zmax) and the tri_plane
    //  input is identical -> segment values are unchanged. Per-thread 'contiguous triangle ranges' merged in range order keep the in-layer segment
    //  order in ascending triangle index (same as the old full scan) -> the chain_polys input is unchanged = byte-identical.
    std::vector<std::vector<Seg>> layerSegs(N);
    if (N > 0) {
      auto collect = [&](size_t a, size_t b, std::vector<std::vector<Seg>>& out){
        Seg sg;
        for (size_t ti = a; ti < b; ++ti) {
          const Tri& t = tris[ti];
          double zmin=std::min({t.v[0].z,t.v[1].z,t.v[2].z}), zmax=std::max({t.v[0].z,t.v[1].z,t.v[2].z});
          for (auto it = std::lower_bound(zsv.begin(), zsv.end(), zmin); it != zsv.end() && *it < zmax; ++it)
            if (tri_plane(t, *it, sg)) out[(size_t)(it - zsv.begin())].push_back(sg);
        }
      };
#ifdef __EMSCRIPTEN_PTHREADS__
      unsigned shw = std::thread::hardware_concurrency(); if (!shw) shw = 4;
      unsigned snt = (unsigned)std::min<size_t>(shw, std::max<size_t>(1, tris.size() / 4096));
      if (snt > 1) {
        std::vector<std::vector<std::vector<Seg>>> tb(snt, std::vector<std::vector<Seg>>(N));
        size_t schunk = (tris.size() + snt - 1) / snt;
        std::vector<std::thread> sths; sths.reserve(snt);
        for (unsigned t2 = 0; t2 < snt; ++t2) {
          size_t a = t2*schunk, b = std::min(tris.size(), a+schunk);
          if (a >= b) break;
          sths.emplace_back([&, a, b, t2]{ collect(a, b, tb[t2]); });
        }
        for (auto& th : sths) th.join();
        for (int li = 0; li < N; ++li) {
          size_t tot = 0; for (auto& tbt : tb) tot += tbt[li].size();
          layerSegs[li].reserve(tot);
          for (auto& tbt : tb) { layerSegs[li].insert(layerSegs[li].end(), tbt[li].begin(), tbt[li].end()); std::vector<Seg>().swap(tbt[li]); }
        }
      } else
#endif
      collect(0, tris.size(), layerSegs);
    }
    auto computeLayer = [&](int i) {
      const double z = zsv[i];
      LayerData ld; ld.z=z; ld.idx=i; ld.h=(i==0)?p.first_layer_height:p.layer_height;
      std::vector<Seg> segs; segs.swap(layerSegs[i]);
      Paths loops = chain_polys(segs);
      ld.contour = SimplifyPolygons(loops, pftEvenOdd);
      // [early simplification — matching upstream] Upstream simplifies every contour to resolution right after slicing the mesh
      //  (TriangleMeshSlicer.cpp:2042 ex.simplify). The kernel passed raw contours straight through, so everything downstream (walls, infill,
      //  support, emission clipping) paid for high-density polygons. CleanPolygons (removal by perpendicular distance) gives an equivalent reduction —
      //  a different algorithm from DP but the same purpose. Low-density fixtures (golden) have corner spacing >> resolution, so nothing changes.
      if (p.gcode_resolution > 1e-9) {
        CleanPolygons(ld.contour, SCALE * p.gcode_resolution);
        ld.contour.erase(std::remove_if(ld.contour.begin(), ld.contour.end(),
                                        [](const Path& q){ return q.size() < 3; }), ld.contour.end());
      }
      if (!ld.contour.empty()) {
        ld.island = offset_paths(ld.contour, -w*0.5);   // travel guard region — moved here (parallel) from the serial offset in the emission loop
        // Thin wall (Arachne-lite): detect regions narrower than 2w where the wall offset would vanish -> one center line instead of walls.
        //  Walls are generated only from the thick core (morph_open, width >= 2w) -> prevents double extrusion on thin parts.
        //  ⚠ Not full Arachne (a variable-width skeleton) — a single center line approximation.
        Paths wallBase = ld.contour;
        Paths core = morph_open(ld.contour, w);
        Paths thin = clip_paths(ld.contour, core, ctDifference);
        thin = offset_paths(offset_paths(thin, -w*0.15), w*0.15);   // remove sliver noise below 0.3w
        if (!thin.empty() && paths_area(thin) > w*w) { ld.thin = thin; wallBase = core; }
        Paths last = wallBase;
        for (int wl=0; wl<p.wall_loops; ++wl) {
          Paths wpaths = offset_paths(wallBase, -(w*0.5 + wl*w));
          if (wpaths.empty()) break;
          ld.walls.push_back(wpaths); last = wpaths;
        }
        if (!last.empty()) ld.fill = offset_paths(last, -(w*0.5));
        // Stage 7: in arachne mode -> generate variable-width walls with the real ported WallToolPaths (walls only; fill stays classic).
        if (p.wall_generator == "arachne") {
          // [Ultra-dense contour guard] Feeding the raw slice contours of a 3M-triangle model (tens of thousands of points per layer) directly
          //  kills the ported Arachne (SkeletalTrapezoidation) with a wild pointer trap (measured: immediately on layer 0,
          //  a raw OOB with no ASAN report; classic finishes the same model). Upstream OrcaSlicer passes contours that went through resolution
          //  simplification, but the kernel's PASS1 skips it, so a 5µm tolerance reduction is applied only above a point-count threshold.
          //  Below the threshold (including the golden fixtures) nothing changes -> golden stays byte-identical.
          // [Arachne input hygiene] Upstream feeds strictly-simple contours simplified to resolution (0.012mm), but
          //  the kernel's PASS1 passes raw slice contours straight through. On non-manifold models (overlapping shells, self-contact),
          //  layers retain µm edges, self-intersections and slivers, and the ported SkeletalTrapezoidation dies instantly on a wild pointer
          //  (measured: a 3M-triangle model, whose crashing layer's input had 10 edges of 1µm plus a self-intersecting polygon).
          //  Matching the upstream rules, hygiene runs in 3 steps: (1) a 10µm Clean (collapsing µm edges) (2) a re-Simplify (resolving
          //  self-intersections Clean can create, re-establishing strict simplicity) (3) removal of sub-nozzle slivers (<0.02mm²).
          //  Normal contours (including the golden fixtures) pass all 3 steps unchanged.
          Paths arachneSrc = ld.contour;
          CleanPolygons(arachneSrc, SCALE * 0.01);
          arachneSrc = SimplifyPolygons(arachneSrc, pftEvenOdd);
          { const double minA = 0.02 * SCALE * SCALE;
            arachneSrc.erase(std::remove_if(arachneSrc.begin(), arachneSrc.end(),
              [&](const Path& q){ return q.size() < 3 || std::fabs(Area(q)) < minA; }), arachneSrc.end()); }
          std::vector<std::vector<std::pair<double,double>>> polys;
          for (const Path& pth : arachneSrc) {
            std::vector<std::pair<double,double>> poly; poly.reserve(pth.size());
            for (const IntPoint& q : pth) poly.push_back({q.x()*INV, q.y()*INV});
            if (poly.size() >= 3) polys.push_back(std::move(poly));
          }
          if (p.arachne_dump) {   // temporary diagnostic: capture the input right before a crash (the last output = the dying layer)
            fprintf(stderr, "ARACHNE_IN L=%d npolys=%d\n", i, (int)polys.size());
            for (size_t pi=0; pi<polys.size(); ++pi) {
              fprintf(stderr, "P%d[%d]:", (int)pi, (int)polys[pi].size());
              for (auto& q : polys[pi]) fprintf(stderr, " %.6f,%.6f", q.first, q.second);
              fprintf(stderr, "\n");
            }
            fflush(stderr);
          }
          ld.arachneWalls = arachne_bridge::generate_walls(polys, w, p.wall_loops, ld.h);
          ld.thin.clear();   // arachne handles thin regions directly as variable-width walls -> the classic thin-wall path is disabled
        }
      }
      L[i] = std::move(ld);
    };
#ifdef __EMSCRIPTEN_PTHREADS__
    { unsigned hw = std::thread::hardware_concurrency();
      unsigned nt = std::max(1u, std::min<unsigned>(hw ? hw : 4, (unsigned)N));
      std::atomic<int> nextIdx{0};
      // [Real PASS1 progress] mt reported PASS1 in one go, so the browser sat at 0% for a measured 2.8s.
      //  The worker updates the same SAB counter as support (progress per mille, 0..1000) -> the UI thread polls it and shows the 0 -> 35% band.
      std::atomic<unsigned> p1done{0};
      auto* p1prog = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::progress_addr();
      p1prog->store(0);
      auto workfn = [&]{ int i; while (!CX() && (i = nextIdx.fetch_add(1)) < N) { computeLayer(i);
        unsigned d = p1done.fetch_add(1) + 1; p1prog->store((unsigned)((unsigned long long)d * 1000u / (unsigned)N)); } };
      std::vector<std::thread> ths; ths.reserve(nt-1);
      for (unsigned t=1; t<nt; ++t) ths.emplace_back(workfn);
      workfn();                                  // the main thread joins in too
      for (auto& th : ths) th.join();
      p1prog->store(0);                          // avoid polluting the support band (clear the leftover value before ParallelScope resets it)
      if (CX()) { em::val r=em::val::object(); r.set("error", std::string("canceled")); return r; }   // G002
      report(N, total);                          // JS callbacks are main-thread only -> report at coarse granularity
    }
#else
    for (int i=0;i<N;++i){ if (CX()) { em::val r=em::val::object(); r.set("error", std::string("canceled")); return r; } computeLayer(i); report(i+1, total); }
#endif
  }

  tw_p1 = emscripten_get_now();

  // ---- PASS 1.5: surface detection (this layer's fill − the neighboring contour) ----
  //  Per-layer independent (reads: immutable neighboring contours, writes: its own topSurf/botSurf) -> the same layer parallelism as PASS1.
  {
    auto surfOne = [&](int i){
      if (L[i].fill.empty()) return;
      Paths above = (i+1<N) ? L[i+1].contour : Paths{};
      Paths below = (i-1>=0) ? L[i-1].contour : Paths{};
      L[i].topSurf = clip_paths(L[i].fill, above, ctDifference);  // nothing above -> a top surface
      L[i].botSurf = clip_paths(L[i].fill, below, ctDifference);  // nothing below -> a bottom surface
    };
#ifdef __EMSCRIPTEN_PTHREADS__
    { unsigned hw = std::thread::hardware_concurrency();
      unsigned nt = std::max(1u, std::min<unsigned>(hw ? hw : 4, (unsigned)std::max(1, N)));
      std::atomic<int> nextIdx{0};
      auto workfn = [&]{ int i; while ((i = nextIdx.fetch_add(1)) < N) surfOne(i); };
      std::vector<std::thread> ths; ths.reserve(nt-1);
      for (unsigned t=1; t<nt; ++t) { try { ths.emplace_back(workfn); } catch (...) { break; } }
      workfn();
      for (auto& th : ths) th.join(); }
#else
    for (int i=0;i<N;++i) surfOne(i);
#endif
  }

  tw_p15 = emscripten_get_now();
  report(N+1, total);                            // surface detection completion tick (signals entering support generation)

  // ---- PASS 1.6: support (overhang detection -> vertical projection -> interface/base) ----
  // (G003: used in the preamble outside the skip block -> hoisted above)
  if (p.enable_support) {
   // WP2: "grid"/"snug" now also go through the upstream port (PrintObjectSupportMaterial) — our own reimplementation is used only by tree_lite
   //  (and the explicit "grid_kernel" fallback). It shares the same facade, coordinate transform and rebinding as tree.
   const bool portNormal = (p.support_style == "grid" || p.support_style == "snug");
   if (p.support_style == "tree" || portNormal) {
    // Stage 18: the real organic TreeSupport (generate_tree_support_3D) — build the facade PrintObject graph from the kernel lslices (mm)
    //  -> TreeSupport::generate() -> emit SupportLayer::support_fills (the branch toolpaths) as type5.
    //  A separate path from grid/tree_lite (the simple descending approximation). treesupport_bridge is the ODR boundary (isolating port types).
    // Stage 28 P2: with viewer coordinates (auto_center=false) the model sits away from the origin -> the tree bridge (the generate_tree_support_3D port)
    //  hits a memory access violation at off-origin coordinates. The rings are shifted to the origin by the model's XY center before being handed to the bridge, and the branch output is shifted
    //  back by the same amount (to the model position) before emission -> avoids the crash and preserves the P2 overlap (round trip: input −tcx, output +tcx). With auto_center=true it is already at the origin.
    // Stage 31: the model stays centered on the origin (small coordinates = the safe zone). The bug where support appeared on one side only came from the bridge's
    //  printable_area (= machine_border) being the positive quadrant [0,bed], so intersection_ex clipped away the support on the origin-centered model's
    //  negative X/Y half -> fixed in treesupport_bridge_impl.cpp by making the border **origin-centered** ([-bed/2,bed/2])
    //  (model coordinates stay small -> this also avoids the cross-slice OOB that reappeared at large coordinates).
    const double tcx = p.auto_center ? 0.0 : cx, tcy = p.auto_center ? 0.0 : cy;
    std::vector<std::vector<treesupport_bridge::Ring>> slices(N);
    std::vector<double> zs(N);
    // [Ultra-dense contour guard] Same rule as the arachne guard: a 5µm reduction only above 20k points per layer.
    //  Upstream OrcaSlicer hands support contours that went through resolution simplification, but the kernel's PASS1 skips it, so on
    //  large models (measured at 774k tri) the ported support cost explodes in proportion to the point count. Below the threshold (the golden fixtures) nothing changes.
    auto sanitized = [&](const Paths& src) -> Paths {
      size_t npts = 0; for (const Path& q : src) npts += q.size();
      if (npts <= 20000) return src;
      Paths out = src; CleanPolygons(out, SCALE * 0.005); return out;
    };
    for (int j=0;j<N;++j) {
      zs[j] = L[j].z;
      for (const Path& ring : sanitized(L[j].contour)) {
        treesupport_bridge::Ring r; r.reserve(ring.size());
        for (const IntPoint& pt : ring) r.emplace_back(pt.x()*INV - tcx, pt.y()*INV - tcy);
        if (r.size()>=3) slices[j].push_back(std::move(r));
      }
    }
    treesupport_bridge::Params tsp;
    tsp.layer_height_mm=p.layer_height; tsp.nozzle_mm=p.nozzle_diameter;
    tsp.first_layer_height_mm=p.first_layer_height;                 // WP1: matches upstream initial_layer_print_height
    tsp.line_width_mm=p.line_width;                                 // WP1: the lslices_extrudable filter + auto-threshold flow
    tsp.support_threshold_angle=p.support_threshold_angle;
    tsp.support_top_z_distance=p.support_top_z_distance;
    tsp.support_bottom_z_distance=p.support_bottom_z_distance;      // WP1: → gap_object_support
    tsp.support_xy_distance=p.support_xy_distance;
    tsp.first_layer_gap_mm=p.support_object_first_layer_gap;        // WP1
    tsp.interface_top_layers=p.support_interface_top_layers;
    tsp.interface_bottom_layers=p.support_interface_bottom_layers;  // WP1: -1 => same as top
    tsp.independent_support_layer_height=p.independent_support_layer_height; // WP1: gap quantization switch
    tsp.support_auto=p.support_auto;                                // stage 20: automatic/manual (painted enforcers only)
    tsp.support_line_width_mm=p.support_line_width;                 // stage 19: the real support extrusion width (config -> flow -> per-path)
    tsp.support_angle_deg=p.support_angle;                          // WP1: SupportParameters::base_angle
    tsp.on_build_plate_only=p.support_on_build_plate_only;          // WP1
    tsp.tree_style=p.tree_style;                                    // WP1: organic|slim|strong|hybrid
    tsp.branch_angle_deg=p.tree_support_branch_angle;               // WP1: wiring up the tree shape keys
    tsp.angle_slow_deg=p.tree_support_angle_slow;
    tsp.branch_diameter_mm=p.tree_support_branch_diameter;
    tsp.branch_distance_mm=p.tree_support_branch_distance;
    tsp.branch_diameter_angle_deg=p.tree_support_branch_diameter_angle;
    tsp.tip_diameter_mm=p.tree_support_tip_diameter;
    tsp.top_rate_pct=p.tree_support_top_rate;
    tsp.wall_count=p.tree_support_wall_count;
    tsp.interface_pattern=p.support_interface_pattern;              // WP1: interface/base patterns and spacing
    tsp.base_pattern=p.support_base_pattern;
    tsp.interface_spacing_mm=p.support_interface_spacing;
    tsp.base_pattern_spacing_mm=p.support_base_pattern_spacing;
    tsp.bed_width_mm=p.bed_width; tsp.bed_depth_mm=p.bed_depth;
    tsp.printable_height_mm=p.printable_height;                     // WP1: BuildVolume height (previously hardcoded to 100mm)
    tsp.resolution_mm=p.gcode_resolution;   // stage 33: path simplification tolerance for the tree path (the upstream print_config "resolution")
    std::vector<treesupport_bridge::LayerOut> tlayers;
    if (portNormal) {
      // WP2: the upstream normal (grid/snug) support — supplies the PASS 1.5 surfaces (topSurf/botSurf) as stTop/stBottom
      //  (so upstream bottom-contact detection and sharp-tail handling work as-is). Coordinates are shifted by −tcx/−tcy exactly like the slices.
      tsp.normal_style = p.support_style;                           // grid|snug → smsGrid|smsSnug
      tsp.support_expansion_mm = p.support_expansion;
      tsp.bridge_no_support    = p.bridge_no_support;
      tsp.remove_small_overhang= p.support_remove_small_overhang;
      tsp.threshold_overlap_pct= p.support_threshold_overlap * 100.0; // kernel fraction (0.5) -> upstream percentage (50)
      std::vector<treesupport_bridge::LayerSurf> surfs(N);
      auto toRings=[&](const Paths& psRaw, std::vector<treesupport_bridge::Ring>& out){
        Paths ps = sanitized(psRaw);               // surfaces get the same guard (reduction on large models only)
        for (const Path& ring : ps) {
          treesupport_bridge::Ring r; r.reserve(ring.size());
          for (const IntPoint& pt : ring) r.emplace_back(pt.x()*INV - tcx, pt.y()*INV - tcy);
          if (r.size()>=3) out.push_back(std::move(r));
        }
      };
      for (int j=0;j<N;++j) { toRings(L[j].topSurf, surfs[j].top); toRings(L[j].botSurf, surfs[j].bottom); }
      tlayers = treesupport_bridge::generate_normal(slices, zs, surfs, tsp);
    } else {
      tlayers = treesupport_bridge::generate(slices, zs, tsp);
    }
    for (const treesupport_bridge::LayerOut& lo : tlayers) {
      // Stage 19 z alignment: support layers are synchronized with the object layers (layer_z uses the same slicing_params), so
      //  print_z lands exactly on the object z grid. Each is bound to the object layer with the smallest residual and the residual is recorded
      //  -> treeZMaxResid≈0 proves that "nearest" is in fact "exact" (zero error). The emitted Z is that object layer's print_z.
      int best=-1; double bestd=1e18;
      for (int j=0;j<N;++j){ double d=std::fabs(L[j].z - lo.print_z_mm); if(d<bestd){bestd=d;best=j;} }
      if (best<0) continue;
      treeZMaxResid = std::max(treeZMaxResid, bestd); ++treeSupLayers;
      for (const treesupport_bridge::Line& ln : lo.lines) {
        Path pl; pl.reserve(ln.pts.size());
        for (const auto& xy : ln.pts)
          pl.push_back(IntPoint((cInt)std::llround((xy.first+tcx)*SCALE),(cInt)std::llround((xy.second+tcy)*SCALE)));  // stage 28: shift back to the model position
        if (pl.size()>=2) L[best].supTree.push_back({std::move(pl), (float)ln.width,
                              ln.role, (float)ln.height, (float)ln.mm3_per_mm});  // WP3: preserve role/height/mm3
      }
    }
   } else {
    // Allowed horizontal step per layer = layer_height / tan(θ). Identical to upstream detect_overhangs (SupportMaterial.cpp:1439)
    //  lower_layer_offset = scale_(lower_layer.height / tan(threshold_rad)).
    //  θ is the "slope angle" (90° = vertical), so a smaller θ means a gentler slope -> a larger expansion and less support (matching the upstream tooltip).
    //  Note: before stage 33, tan was in the numerator and the direction was inverted (3x over-detection at 30°). It matched only by coincidence at 45°.
    //  Bounds: clamped at 89° like upstream (avoiding tan -> ∞), and θ<=0 is treated as "support everywhere" (zero expansion).
    const double thrDeg = std::min(89.0, p.support_threshold_angle);
    // Stage 33: θ=0 means "auto" — upstream uses an overlap criterion instead of an angle (detect_overhangs):
    //   lower_layer_offset = fw - scale_(support_threshold_overlap.get_abs_value(fw))
    //  Previously 0 was used literally, making the lower-layer expansion 0 (= every increase in the upper layer counted as an overhang), which over-detected.
    double maxStep = (thrDeg > 0.0) ? (p.layer_height / std::tan(thrDeg * PI/180.0))
                                    : std::max(0.0, w - p.support_threshold_overlap * w);
    int gap = std::max(1, (int)std::llround(p.support_top_z_distance / p.layer_height)); // contact z gap (in layers)
    int ifaceN = std::max(1, p.support_interface_top_layers);
    // Stage 20: painted enforcers/blockers -> per-layer polygons (slice_mesh_slabs projection, the same slice_z as the facade)
    std::vector<double> sliceZs(N); for (int j=0;j<N;++j) sliceZs[j]=L[j].z - p.layer_height*0.5;
    auto projToPaths=[&](bool enf)->std::vector<Paths>{
      auto pl = selector_bridge::project_layers(sliceZs, enf);
      std::vector<Paths> out(N);
      for (int j=0;j<N && j<(int)pl.size();++j) for (auto& ring:pl[j]) {
        Path pa; pa.reserve(ring.size());
        for (auto& xy:ring) pa.push_back(IntPoint((cInt)std::llround(xy.first*SCALE),(cInt)std::llround(xy.second*SCALE)));
        if (pa.size()>=3) out[j].push_back(std::move(pa));
      }
      return out;
    };
    std::vector<Paths> enfL = projToPaths(true), blkL = projToPaths(false);
    // Overhang: contour_i − offset(contour_{i-1}, +maxStep)
    // Stage 33: the old morphological opening (offset -openR -> +openR) is removed. The opening erased whole bands narrower than
    //  2*openR (=1.26w), so on gentle slopes (measured from 25°) no support was generated at all
    //  (effectively neutralizing support_threshold_angle). Upstream detect_overhangs does not erode the overhang result; instead it
    //  (1) first filters out islands in the lower slice narrower than the extrusion width (excluded when offset(-fw/2) is empty; "Do not use offset2()") and
    //  (2) cleans up the result by area. The same is done here.
    const double minOhArea = (p.support_overhang_min_area > 1e-9) ? p.support_overhang_min_area : (w*w);
    std::vector<Paths> overhang(N);
    if (p.support_auto) for (int i=1;i<N;++i) {
      // Stage 32 Fix A: do not skip when the lower layer is empty (a floating part, above a full z gap) — with no lower layer
      //  offset(empty)=empty, so the clip result is the whole contour_i = a full overhang -> support is generated beneath it.
      if (L[i].contour.empty()) continue;
      // (1) Lower-island filter: lower-layer fragments thinner than the extrusion width cannot support anything, so they are excluded from the lower layer (the upstream rule)
      Paths lower;
      for (const Path& isl : L[i-1].contour) {
        Paths one{isl};
        if (!offset_paths(one, -w*0.5).empty()) lower.push_back(isl);
      }
      Paths oh = clip_paths(L[i].contour, offset_paths(lower, maxStep), ctDifference);
      if (oh.empty()) continue;
      // Stage 33: bridge_no_support — no support is created under regions that will be bridged (the upstream option of the same name).
      //  Bridge candidates = this layer's exposed bottom surfaces (botSurf, from PASS 1.5). The kernel already handled the opposite direction
      //  (a support contact surface is not a bridge); this direction was missing.
      if (p.bridge_no_support && !L[i].botSurf.empty()) {
        oh = clip_paths(oh, L[i].botSurf, ctDifference);
        if (oh.empty()) continue;
      }
      // Stage 33: support_expansion — widens the overhang region to enlarge the contact area (upstream xy_expansion).
      if (p.support_expansion > 1e-9) oh = offset_paths(oh, p.support_expansion);
      // (2) Per-component selection (a verdict, not an erosion — components that pass are preserved in their original shape)
      //   (a) area: below the minimum area it is numerical noise
      //   (b) support_remove_small_overhang (upstream default true, SupportMaterial.cpp:2244):
      //      Upstream clusters overhangs across layers, erodes by 1x the extrusion width and discards them when the bbox is under 2x the extrusion width.
      //      Here it is approximated per component — if offset(-w) is empty the fragment "cannot fit even two lines" and is discarded.
      //      Note: this does not carve the shape (verdict only). The old openR opening eroded the shape itself and erased the bands.
      // Floating island exemption: when the lower layer is entirely empty, this layer is an island starting in mid-air.
      //  Regardless of size it cannot be printed without support, so it is exempt from small-overhang removal.
      //  Upstream saves the same situation with its cantilever/sharp-tail exceptions (around SupportMaterial.cpp:2270) —
      //  lacking those detectors, we approximate with "is the layer below empty".
      //  Note (measured): without this exemption, a real Benchy chimney (a thin-walled ring, z40.4) vanished at offset(-w) and
      //    got no support at all, leaving it floating.
      const bool floatingIsland = lower.empty();
      Paths keep;
      for (const Paths& comp : split_components(oh)) {
        if (paths_area(comp) < minOhArea) continue;
        if (p.support_remove_small_overhang && !floatingIsland) {
          // Implements the two categories upstream exempts from small-overhang removal (around SupportMaterial.cpp:2270).
          //  (a) sharp tail: a thin pointed island with area < 36mm² (=6x6, area_thresh_well_supported) that survives a 0.1x fw erosion.
          //     It collapses without support, so it is kept.  (upstream :1484)
          const bool sharpTail = paths_area(comp) < 36.0 && !offset_paths(comp, -0.1*w).empty();
          //  (b) cantilever: attached to the lower layer but extending more than 3mm beyond that attachment. (upstream :1524-1542)
          //     Upstream measures the maximum distance to the attachment; here an equivalent set operation is used —
          //     if anything remains after expanding the attachment by 3mm, it extends more than 3mm.
          bool cantilever = false;
          {
            Paths base = clip_paths(comp, offset_paths(lower, std::max(w, maxStep) + 0.1), ctIntersection);
            if (!base.empty()) cantilever = !clip_paths(comp, offset_paths(base, 3.0), ctDifference).empty();
          }
          if (!sharpTail && !cantilever && offset_paths(comp, -w).empty()) continue;
        }
        for (const Path& q : comp) keep.push_back(q);
      }
      if (!keep.empty()) overhang[i] = keep;
    }
    // enforcer: painted regions are forcibly added as overhangs (projecting a support column downward). blocker: subtracted from the overhangs (no
    //  column beneath them) — the same meaning as tree's generate_overhangs (overhangs -= blockers).
    for (int i=0;i<N;++i) if (!enfL[i].empty()) overhang[i] = union_paths(overhang[i], enfL[i]);
    for (int i=0;i<N;++i) if (!blkL[i].empty()) overhang[i] = clip_paths(overhang[i], blkL[i], ctDifference);
    // Downward projection: top to bottom.
    // Stage 33 [floating support fix] Follows the upstream project_support_to_grid (SupportMaterial.cpp) rule:
    //   Polygons trimming = offset(layer.lslices, EPS);
    //   overhangs_projection = diff(overhangs, trimming);   // <- the projection itself is carved before being passed down
    //   ...  out.second (the carved projection) becomes the next (lower) layer's overhangs_projection
    // So a projection that touches the model dies there permanently (= that point is a bottom contact, where support lands on the model).
    // The old implementation only accumulated into accum without subtracting the model and clipped "per layer afterwards", so
    //  a region erased behind the model on layer j came back on j-1 where the model disappears, producing **support floating in mid-air**.
    // Note: upstream's "stop propagating thinned columns" (an opening by column_propagation_filtering_radius) is in fact
    //   commented out and inactive (SupportMaterial.cpp:2701). We do not do it either —
    //   erasing a column on layer j robs the support above it on j+1 of its base and actually creates floating parts (confirmed by measurement).
    bool treeLite = (p.support_style == "tree_lite");
    // Stage 33: support_on_build_plate_only — when this option is on, upstream's project_support_to_grid switches trimming
    //  from "this layer's model" to buildplate_covered (the model footprint accumulated from below).
    //  As a result no projection survives at any XY the model ever occupied, leaving only columns that run straight down to the bed.
    std::vector<Paths> covered;
    if (p.support_on_build_plate_only) {
      covered.resize(N); Paths cov;
      for (int j=0;j<N;++j) { if (!L[j].contour.empty()) cov = union_paths(cov, L[j].contour); covered[j]=cov; }
    }
    std::vector<Paths> column(N);
    Paths accum;
    for (int j=N-1;j>=0;--j) {
      if (treeLite) accum = tree_taper(accum, p.tree_lite_shrink, p.tree_lite_min_radius);  // per-layer taper (keeping the minimum pillar)
      int src=j+gap; if (src<N) accum = union_paths(accum, overhang[src]);
      // * Upstream diff(overhangs, trimming): subtract this layer's model from the projection, and the result continues downward.
      //   This one line is what makes "support that lands on the model ends there" (bottom contact).
      const Paths& trim = p.support_on_build_plate_only ? covered[j] : L[j].contour;
      if (!trim.empty()) accum = clip_paths(accum, offset_paths(trim, p.support_xy_distance), ctDifference);
      column[j]=accum;
    }
    // Stage 32 Fix B: bottom z gap (support_bottom_z_distance) — the gap between a model top surface and the support bottom resting on it.
    //  botGap layers = round(dist/lh). With the default 0.2/0.2=1 the extra clip loop below does not run -> identical to today (golden byte-identical).
    int botGap = std::max(1, (int)std::llround(p.support_bottom_z_distance / p.layer_height));
    // Per-layer interface (solid) / base (sparse) split + model avoidance
    for (int j=0;j<N;++j) {
      if (column[j].empty()) continue;
      Paths modelClear = offset_paths(L[j].contour, p.support_xy_distance);
      // Bottom z gap: also remove support above the model top surface on the (botGap-1) layers directly below -> the support starts botGap above the model top surface.
      for (int k=1;k<botGap;++k){ int b=j-k; if (b>=0 && !L[b].contour.empty()) modelClear = union_paths(modelClear, offset_paths(L[b].contour, p.support_xy_distance)); }
      Paths col = clip_paths(column[j], modelClear, ctDifference);
      if (col.empty()) continue;
      // Stage 33: grid snapping (the upstream SupportGridPattern). After snapping it is trimmed back against the model region —
      //  upstream also passes both arguments together as support_grid_pattern(support_polygons, trimming_polygons).
      //  Applied to the grid style only (tree_lite exists for its taper shape, which snapping would destroy).
      if (!treeLite && p.support_grid_snap) {
        Paths snapped = grid_snap(col, support_spacing);
        snapped = clip_paths(snapped, modelClear, ctDifference);   // keep the parts inflated by snapping from intruding into the model
        if (!snapped.empty()) col = snapped;
      }
      Paths iface;
      for (int k=0;k<ifaceN;++k){ int s=j+gap+k; if (s<N) iface = union_paths(iface, overhang[s]); }
      iface = clip_paths(iface, col, ctIntersection);
      // Stage 33: support_interface_bottom_layers — the interface on the side where support rests on a model top surface
      //  (bottom contact). Upstream generate_interface_layers builds top and bottom interfaces separately
      //  (SupportParameters.hpp:37 num_bottom_interface_layers). We only had top.
      //  Test: if there is model near the point directly below this layer's support (botGap down), that part is a bottom contact surface.
      if (p.support_interface_bottom_layers > 0) {
        Paths under;
        for (int k=botGap;k<botGap+p.support_interface_bottom_layers;++k) {
          int b=j-k; if (b>=0 && !L[b].contour.empty()) under = union_paths(under, offset_paths(L[b].contour, p.support_xy_distance));
        }
        if (!under.empty()) {
          Paths botIface = clip_paths(col, under, ctIntersection);
          if (!botIface.empty()) iface = union_paths(iface, botIface);
        }
      }
      L[j].supIface = iface;
      L[j].supBase  = clip_paths(col, iface, ctDifference);
    }
   }
  }

  // ---- Preamble ----
  }                                              // G003: end of the reuseSup skip block (only PASS1~1.6 is skipped — preamble, raft and emission are shared)

  GW gw; gw.s.reserve(1<<17);
  gw.retract_len = p.retract_length;
  gw.retract_min_travel = p.retraction_minimum_travel;
  gw.retractF    = (int)std::llround(p.retract_speed * 60);
  gw.z_hop       = p.z_hop;
  gw.offX        = p.bed_width  * 0.5;
  gw.offY        = p.bed_depth  * 0.5;
  gw.arc_fitting = p.enable_arc_fitting;
  gw.scarf_len   = p.scarf_length;
  gw.pe_slope    = (p.pe_lite ? std::max(0.0, p.max_volumetric_extrusion_rate_slope) : 0.0);   // in-kernel PE-lite only when pe_lite; else real PE post-processes
  gw.filament_area = PI * p.filament_diameter * p.filament_diameter / 4.0;
  gw.avoid_walls = p.reduce_crossing_wall;                                 // wall-avoiding travel
  bool realPE    = (!p.pe_lite && p.max_volumetric_extrusion_rate_slope > 0);
  gw.emit_pe_tags = p.emit_pe_tags || realPE;                             // tags are emitted automatically when the real PE is used
  bool ironOn    = (p.ironing_type=="top" || p.ironing_type=="topmost" || p.ironing_type=="solid");
  bool scarfOn   = (p.seam_slope_type=="external" || p.seam_slope_type=="all");
  int seamMode = (p.seam_position=="nearest")?1 : (p.seam_position=="aligned")?2 : (p.seam_position=="random")?3 : 0; // back by default
  SeamCtx seamCtx;
  gw.raw("; OrcaSlicer RE mini-kernel (Track C stage 6) — NOT full libslic3r");
  { char h[320];
    std::snprintf(h,sizeof h,"; params: lh=%.3f flh=%.3f lw=%.3f walls=%d infill=%.2f@%.0fdeg top=%d bottom=%d",
      p.layer_height,p.first_layer_height,p.line_width,p.wall_loops,p.infill_density,p.infill_angle,p.top_shell_layers,p.bottom_shell_layers); gw.raw(h);
    std::snprintf(h,sizeof h,"; skirt=%d@%.1fmm brim=%.1fmm retract=%.2fmm@%.0fmm/s zhop=%.2fmm",
      p.skirt_loops,p.skirt_distance,p.brim_width,p.retract_length,p.retract_speed,p.z_hop); gw.raw(h);
    std::snprintf(h,sizeof h,"; support=%d angle=%.0f density=%.2f topz=%.2f xy=%.2f iface=%d  raft=%d  bed=%.0fx%.0f off=%.1f,%.1f",
      p.enable_support?1:0,p.support_threshold_angle,p.support_density,p.support_top_z_distance,p.support_xy_distance,
      p.support_interface_top_layers,p.raft_layers,p.bed_width,p.bed_depth,gw.offX,gw.offY); gw.raw(h);
    if (treeSupLayers > 0) {   // stage 19: tree support z alignment diagnostics (max residual against the object z grid, mm)
      std::snprintf(h,sizeof h,"; tree_support layers=%d z_resid_max=%.6fmm", treeSupLayers, treeZMaxResid); gw.raw(h);
    }
    std::snprintf(h,sizeof h,"; pattern=%s fan=%.0f%% closeFan=%d fullFan=%d slowT=%.0fs arc=%d seam=%s spiral=%d",
      p.sparse_infill_pattern.c_str(),p.fan_speed,p.close_fan_the_first_x_layers,p.full_fan_speed_layer,
      p.slow_down_layer_time,p.enable_arc_fitting?1:0,p.seam_position.c_str(),p.spiral_mode?1:0); gw.raw(h);
    std::snprintf(h,sizeof h,"; speeds(mm/s): print=%.0f first=%.0f travel=%.0f  temps: nozzle=%.0f bed=%.0f",
      p.print_speed,p.first_layer_speed,p.travel_speed,p.nozzle_temp,p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"; scarf=%s@%.0fmm support_style=%s bridge=%.0fmm/s PA=%d@%.3f",
      p.seam_slope_type.c_str(),p.scarf_length,p.support_style.c_str(),p.bridge_speed,
      p.enable_pressure_advance?1:0,p.pressure_advance); gw.raw(h);
    std::snprintf(h,sizeof h,"; ironing=%s@%.2fmm flow=%.0f%% spd=%.0f  reduce_crossing_wall=%d  PE_slope=%.1f  extruders=%d",
      p.ironing_type.c_str(),p.ironing_spacing,p.ironing_flow,p.ironing_speed,
      p.reduce_crossing_wall?1:0,p.max_volumetric_extrusion_rate_slope,p.extruder_count); gw.raw(h);
    std::snprintf(h,sizeof h,"M140 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M104 S%.0f",p.nozzle_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M190 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M109 S%.0f",p.nozzle_temp); gw.raw(h);
  }
  gw.raw("G21 ; mm"); gw.raw("G90 ; absolute XYZ"); gw.raw("M83 ; relative E");
  // Pressure advance: Marlin M900 K<v>. Klipper uses SET_PRESSURE_ADVANCE, noted here only as a comment.
  if (p.enable_pressure_advance) {
    char h[96];
    std::snprintf(h,sizeof h,"M900 K%.3f ; pressure advance (Marlin/RRF)",p.pressure_advance); gw.raw(h);
    std::snprintf(h,sizeof h,"; SET_PRESSURE_ADVANCE ADVANCE=%.3f  ; (Klipper equivalent — comment only)",p.pressure_advance); gw.raw(h);
  }
  gw.raw("; (no G28 homing — mini-kernel preamble)"); gw.raw("G92 E0");

  int fTravel = (int)std::llround(p.travel_speed*60);
  int fFirst  = (int)std::llround(p.first_layer_speed*60);
  em::val layersArr = em::val::array();

  // Stage 30: streaming setup — streaming (release gw.s after emitting each chunk) only when a layer sink is registered and the real PE
  //  (whole-string cross-layer smoothing) is not in use. realPE needs the entire g-code, so it falls back to batch (opt-in, outside the golden path).
  em::val& sink = layer_sink();
  bool streaming = (!sink.isUndefined() && !sink.isNull() && !realPE);
  bool economy   = streaming && p.economy;      // economy: skip toolpaths and the time estimate (r.moves would stay resident in bulk), G-code only
  bool streamTime = streaming && !economy;      // streamed time estimate (chunk feeding) — skipped in economy mode
  // Machine limits for the time estimate (shared by streaming and batch) — depends only on p, so it is built once before the loop.
  gcode_time::Limits glim;
  glim.max_speed[0]=glim.max_speed[1]=(float)p.machine_max_speed_xy;
  glim.max_speed[2]=(float)p.machine_max_speed_z; glim.max_speed[3]=(float)p.machine_max_speed_e;
  glim.max_jerk[0]=glim.max_jerk[1]=(float)p.machine_jerk_xy;
  glim.max_jerk[2]=(float)p.machine_jerk_z; glim.max_jerk[3]=(float)p.machine_jerk_e;
  glim.accel_print=(float)p.machine_accel_print; glim.accel_travel=(float)p.machine_accel_travel; glim.accel_retract=(float)p.machine_accel_retract;
  gcodeproc_bridge::Limits gl;
  for (int k=0;k<4;++k){ gl.max_speed[k]=glim.max_speed[k]; gl.max_accel[k]=glim.max_accel[k]; gl.max_jerk[k]=glim.max_jerk[k]; }
  gl.accel_print=glim.accel_print; gl.accel_travel=glim.accel_travel; gl.accel_retract=glim.accel_retract;
  gl.min_extrude_rate=glim.min_extrude_rate; gl.min_travel_rate=glim.min_travel_rate;
#ifdef __EMSCRIPTEN_PTHREADS__
  // (mt) Overlap targets: streamed full estimates and batch full estimates (realPE is excluded because it needs whole-string post-processing,
  //  and transcribed is a different engine so it keeps the old path). In batch mode the accumulated gw.s is sliced and fed at each flush.
  TimeFeeder feeder;
  const bool overlapBatch = !streaming && !realPE && p.time_engine != "transcribed";
  size_t fedOff = 0;                            // batch overlap: how much of gw.s has already been fed
  if (streamTime || overlapBatch) feeder.begin(gl);
  auto feed_batch_tail = [&]{                   // feed everything after the last flush (including the footer)
    std::string c = gw.s.substr(fedOff); fedOff = gw.s.size();
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(c);   // batch feeds the estimator the same tag-stripped input as streaming
    feeder.feed(std::move(c));
  };
#else
  if (streamTime) gcodeproc_bridge::estimate_begin(gl);
#endif
  // Layer emission: batch accumulates into layersArr; streaming emits a chunk (everything in gw.s since the last flush) plus the toolpaths, then releases gw.s.
  //  The preamble goes into the first flush chunk and the footer into the last -> concatenating the chunks is byte-identical to the batch gw.s.
  auto flush_layer = [&](double z, int idx, std::vector<float>& tp, std::vector<float>& widths) {
    double tf0 = emscripten_get_now();
    struct TF { double& acc, t0; ~TF(){ acc += emscripten_get_now() - t0; } } tf{t_flush, tf0};
    if (!streaming) {
      em::val Lo=em::val::object(); Lo.set("z",z); Lo.set("paths",to_f32(tp)); Lo.set("widths",to_f32(widths));
      layersArr.call<void>("push", Lo);
#ifdef __EMSCRIPTEN_PTHREADS__
      if (overlapBatch) feed_batch_tail();               // feed the estimator worker incrementally at each layer boundary (aligned to '\n')
#endif
      return;
    }
    std::string chunk; chunk.swap(gw.s);                 // take the accumulated text and empty gw.s (freeing the heap)
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(chunk);   // stateless line filter (chunked == batch)
#ifdef __EMSCRIPTEN_PTHREADS__
    if (streamTime) feeder.feed(chunk);                  // fed as a copy — chunk is also handed to the sink afterwards
#else
    if (streamTime) gcodeproc_bridge::estimate_feed(chunk);
#endif
    em::val paths = economy ? em::val::array() : to_f32(tp);
    em::val wid   = economy ? em::val::array() : to_f32(widths);
    sink(z, idx, chunk, paths, wid);
  };

  // ---- Raft (inserted below the model, shifting the model in z) ----
  double zShift = 0.0;
  int nraft = std::max(0, p.raft_layers);
  if (nraft > 0 && !L.empty() && !L[0].contour.empty()) {
    const double raftFirstH = p.raft_first_layer_height;   // stage 33: the 0.30 constant -> a parameter
    Paths base = L[0].contour;
    base = union_paths(base, L[0].supIface);
    base = union_paths(base, L[0].supBase);
    Paths raftArea = offset_paths(base, p.raft_expansion); // stage 33: the +3.0 constant -> raft_expansion (upstream default 1.5)
    double rz = raftFirstH;
    gw.set_fan(0);                               // fan off for the raft (the first layers)
    for (int k=0;k<nraft;++k) {
      double rh = (k==0) ? raftFirstH : p.layer_height;
      gw.set_e_per_mm(rh, p); gw.z = rz;
      std::vector<float> tp, widths; g_seg_w = &widths; g_seg_w_cur = (float)w;   // stage 21: record raft widths
      char cm[64]; std::snprintf(cm,sizeof cm,"; raft %d Z%.3f",k,rz); gw.raw(cm);
      std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",rz,fTravel); gw.raw(cm);
      if (k==0) {
        for (int s=0;s<p.skirt_loops;++s){ Paths r=offset_paths(raftArea,(p.skirt_distance+w*0.5+s*w)); emit_loops(gw,tp,r,rz,4.0f,fFirst,fTravel,-1,seamCtx); }
        emit_lines(gw, tp, infill_clipped(raftArea, 0.0, w), rz, 6.0f, fFirst, fTravel);        // first raft layer: solid
      } else {
        emit_lines(gw, tp, infill_clipped(raftArea, (k%2)?90.0:0.0, w/0.5), rz, 6.0f, fFirst, fTravel); // afterwards: sparse
      }
      flush_layer(rz, k, tp, widths);
      rz += p.layer_height;
    }
    g_seg_w = nullptr;   // stage 21: the local raft widths goes out of scope here -> prevents dangling
    // Stage 33: wiring up raft_contact_distance — the gap between the raft top surface and the model's first layer (an air gap for separation).
    zShift = raftFirstH + (nraft-1)*p.layer_height + p.raft_contact_distance;   // the model's first layer Z = zShift + first_layer_height
  }

  tw_sup = emscripten_get_now();
  if (CX()) { em::val r=em::val::object(); r.set("error", std::string("canceled")); return r; }   // G002 (no threads up to this point)
  report(N+2, total);                            // support generation completion tick

  // ---- PASS 2 precomputation: per-layer geometry separation and infill line generation (split out of the emission loop below) ----
  //  A verbatim move of the computation block from inside the old emission loop — formulas and call order unchanged (verified byte-identical against golden).
  auto compute_pre = [&](int i) -> EmitPre {
    EmitPre ep;
    LayerData& ld = L[i];
    const double zE = ld.z + zShift;
    ep.fSup = (int)std::llround(((i==0)?p.first_layer_speed:p.print_speed)*60);
    // Support lines — shared whether or not there is a model (same formulas as the empty-layer branch: angB==supBaseAng, ifSp==ifaceSp)
    const double supBaseAng  = p.support_angle + (i % 2 ? -45.0 : 45.0);
    const double supIfaceAng = supBaseAng + 90.0;
    auto resolvePat = [](const std::string& s) { return (s=="default"||s=="auto"||s=="rectilinear-grid") ? std::string("rectilinear") : s; };
    const double ifaceSp = (p.support_interface_spacing > 1e-6) ? (w + p.support_interface_spacing) : solid_spacing;
    ep.supI = (p.enable_support && !ld.supIface.empty())
      ? build_sparse(ld.supIface, resolvePat(p.support_interface_pattern), supIfaceAng, ifaceSp, i, zE, w, 1.0) : Paths{};
    ep.supB = (p.enable_support && !ld.supBase.empty())
      ? build_sparse(ld.supBase, resolvePat(p.support_base_pattern), supBaseAng, support_spacing, i, zE, w, p.support_density) : Paths{};
    if (ld.contour.empty() || p.spiral_mode) return ep;   // empty layer = support only, spiral = ep unused

    // Gap fill: the morphological-open leftover of the fill inside the innermost wall (gaps narrower than w) -> a center line approximation (single-width lines).
    //  ⚠ An approximation — not a medial axis or variable width. open(X)=dilate(erode(X)), leftover = X−open. Excluded from fillCore to prevent double extrusion.
    Paths gap, fillCore = ld.fill;
    if (!ld.fill.empty()) {
      Paths opened = morph_open(ld.fill, w*0.5);
      gap = clip_paths(ld.fill, opened, ctDifference);
      gap = offset_paths(offset_paths(gap, -w*0.1), w*0.1);            // remove noise below 0.2w
      if (!gap.empty()) fillCore = clip_paths(ld.fill, gap, ctDifference);
    }
    ep.gapLines = gap.empty() ? Paths{} : infill_clipped(gap, p.infill_angle, w);

    // Thin wall center lines (regions narrower than 2w) — one major-axis center line per component + a local width flow correction
    if (!ld.thin.empty()) {
      for (const Paths& comp : split_components(ld.thin)) {
        Paths line = centerline_of(comp, w);
        if (line.empty()) continue;
        double A = paths_area(comp), Ln = paths_len(line,false);
        double width = (Ln>1e-3) ? A/Ln : w;
        ep.thinRuns.push_back({std::move(line), std::min(2.0, std::max(0.4, width/w))});
      }
    }

    Paths topSolid, botSolid;
    for (int j=i; j<=std::min(N-1, i + p.top_shell_layers - 1); ++j) topSolid = union_paths(topSolid, L[j].topSurf);
    for (int j=std::max(0, i - p.bottom_shell_layers + 1); j<=i; ++j) botSolid = union_paths(botSolid, L[j].botSurf);
    Paths solid  = clip_paths(union_paths(topSolid, botSolid), fillCore, ctIntersection);
    // Bridge: the part of this layer's (i>0) exposed bottom ∩ solid that is not held up by support -> fan 100% + bridge_speed slowdown
    Paths bridge;
    if (i>0 && !ld.botSurf.empty()) {
      bridge = clip_paths(solid, ld.botSurf, ctIntersection);
      if (p.enable_support && !L[i-1].supIface.empty())
        bridge = clip_paths(bridge, offset_paths(L[i-1].supIface, w), ctDifference);   // a support contact surface is not a bridge
      if (!bridge.empty()) solid = clip_paths(solid, bridge, ctDifference);            // split it out of the regular solid
    }
    Paths sparse = clip_paths(fillCore, solid, ctDifference);
    double sa = (i%2==0) ? 45.0 : 135.0;
    // Stage 21: per-feature widths (the first layer uses the initial_layer values throughout). With the defaults (every feature 0 -> line_width) the values are identical -> no regression.
    bool firstL = (i==0 && nraft==0);
    double wSolid  = firstL ? p.initial_layer_line_width : p.internal_solid_infill_line_width;
    double wTop    = firstL ? p.initial_layer_line_width : p.top_surface_line_width;
    // Splitting the top surface out of solid (applying top_surface_line_width) happens only when the widths differ — otherwise it stays one solid (no regression).
    Paths topPart, restSolid = solid;
    if (!topSolid.empty() && std::abs(wTop - wSolid) > 1e-6) {
      topPart   = clip_paths(solid, topSolid, ctIntersection);
      restSolid = clip_paths(solid, topPart, ctDifference);
    }
    ep.solidLines = restSolid.empty() ? Paths{} : infill_clipped(restSolid, sa, solid_spacing);
    if (!ep.solidLines.empty()) sort_monotonic(ep.solidLines, sa);
    ep.topLines  = topPart.empty() ? Paths{} : infill_clipped(topPart, sa, solid_spacing);
    if (!ep.topLines.empty()) sort_monotonic(ep.topLines, sa);
    ep.bridgeLines = bridge.empty() ? Paths{} : infill_clipped(bridge, sa, solid_spacing);
    ep.sparseLines = (sparse_spacing>0 && !sparse.empty())
        ? build_sparse(sparse, p.sparse_infill_pattern, p.infill_angle, sparse_spacing, i, zE, w, p.infill_density) : Paths{};
    // Skirt/brim — stage 33: wiring up skirt_height and brim_object_gap
    if (i < std::max(1, p.skirt_height) && nraft==0) {
      int brimRings = (int)std::llround(p.brim_width / w); ep.brim = brimRings>0 && i==0;   // the brim is on the first layer only
      for (int k=0; k<p.skirt_loops; ++k) { Paths r=offset_paths(ld.contour,(p.skirt_distance+w*0.5+k*w)); for (auto& q:r) ep.flExtra.push_back(q); }
      if (i==0) for (int k=1; k<=brimRings; ++k) { Paths r=offset_paths(ld.contour,(p.brim_object_gap+w*0.5+k*w)); for (auto& q:r) ep.flExtra.push_back(q); }
    }

    double thinLen=0; for (auto& tr:ep.thinRuns) thinLen += paths_len(tr.line,false);
    double layerLen = vwalls_len(ld.walls) + paths_len(ep.solidLines,false) + paths_len(ep.sparseLines,false)
                    + paths_len(ep.supI,false) + paths_len(ep.supB,false) + paths_len(ep.flExtra,true)
                    + paths_len(ep.gapLines,false) + paths_len(ep.bridgeLines,false) + thinLen;
    double baseSpeed = (i==0 && nraft==0) ? p.first_layer_speed : p.print_speed;
    double useSpeed = baseSpeed;
    if (p.slow_down_layer_time > 0 && layerLen > 1e-6 && layerLen/baseSpeed < p.slow_down_layer_time)
      useSpeed = std::min(baseSpeed, std::max(20.0, layerLen / p.slow_down_layer_time));   // slow down small layers (floor 20mm/s)
    ep.fPrint = (int)std::llround(useSpeed*60);
    ep.fBridge = (int)std::llround(std::max(5.0, p.bridge_speed)*60);

    // Precompute the ironing (type10) lines — emission uses pre.ironLines
    if (ironOn && !ld.topSurf.empty()) {
      Paths ironArea = clip_paths(ld.topSurf, fillCore, ctIntersection);
      ep.ironLines = ironArea.empty() ? Paths{} : infill_clipped(ironArea, sa+45.0, std::max(0.05, p.ironing_spacing));
    }
    return ep;
  };

#ifdef __EMSCRIPTEN_PTHREADS__
  // (mt) The PASS2 computation runs in parallel — workers precompute up to PRE_WINDOW layers ahead of the consumer (emission).
  //  Safety: while the consumer is on i, in-flight workers are always on k>i (they complete in the order they were claimed), and
  //  the L[j] a worker reads satisfies j >= k−bottom_shell+1 > the early-release point old=i−max(bsl,1)−1 -> no conflict with the release.
  //  The window bounds resident memory (W layers' worth of lines) — keeping the early-release OOM mitigation.
  std::vector<EmitPre> preBuf(N);
  std::vector<uint8_t> preDone(N, 0);
  std::mutex pmu; std::condition_variable cv_done, cv_room;
  int preNext = 0, preConsumed = -1;
  unsigned preHW = std::thread::hardware_concurrency(); if (!preHW) preHW = 4;
  const bool parEmit = !p.spiral_mode && !scarfOn && gw.pe_slope <= 0.0 && !gw.emit_pe_tags
                       && p.wall_generator != "arachne" && !realPE;   // conditions under which G003 parallel emission is possible (otherwise serial fallback)
  unsigned preNT = std::min<unsigned>(std::max(1u, parEmit ? preHW / 2 : preHW - 1), (unsigned)std::max(1, N));
  const int PRE_WINDOW = (int)preNT * 2 + 4;
  auto preWork = [&]{
    for (;;) {
      int k = -1;
      { std::unique_lock<std::mutex> lk(pmu);
        cv_room.wait(lk, [&]{ return preNext >= N || preNext <= preConsumed + PRE_WINDOW; });
        if (preNext >= N) break;
        k = preNext++;
      }
      EmitPre ep = compute_pre(k);
      { std::lock_guard<std::mutex> lk(pmu); preBuf[k] = std::move(ep); preDone[k] = 1; }
      cv_done.notify_all();
    }
  };
  std::vector<std::thread> preThs; preThs.reserve(preNT);
  for (unsigned t=0; t<preNT; ++t) preThs.emplace_back(preWork);
#endif

  // ---- PASS 2: solid/sparse infill separation + support + emission ----
#ifdef __EMSCRIPTEN_PTHREADS__
  if (parEmit) {
    // G003: E1 (a serial dry run — chaining the seam, position, curF and fan entry state) -> a writer pool (per-layer G-code/toolpath generation)
    //  -> an ordered flush. E is relative (M83) so it is layer-local, and cross-layer state is fully captured by the entry cursor -> byte-identical to st (serial)
    //  (gates: golden + a large-model cmp). filament is the ordered sum of per-layer partials (only the association order differs — the theoretical %.2f rounding
    //  boundary risk in the footer is covered by golden). The window (FW) bounds residency -> keeping the streaming OOM mitigation.
    struct Cursor { double px, py; int curF, lastFan; SeamCtx sc; };
    struct EmitJob {
      EmitPre pre; Cursor entry; Paths island;
      std::string gcode; std::vector<float> tp, widths;
      double filament = 0; long segments = 0, crossings = 0;
      std::atomic<int> jst{0};   // 0=ready 1=dispatched 2=done
    };
    std::vector<std::unique_ptr<EmitJob>> jobs(N);
    for (int k = 0; k < N; ++k) jobs[k] = std::make_unique<EmitJob>();
    std::mutex emu; std::condition_variable ecv;
    int wNext = 0, dispatched = 0;
    GW base = gw; base.s.clear(); base.island.clear(); base.dry = false;   // the template GW for writers
    unsigned wHW = std::thread::hardware_concurrency(); if (!wHW) wHW = 4;
    unsigned WN = std::max(1u, wHW / 2);
    auto writerFn = [&]{
      for (;;) {
        int k = -1;
        { std::unique_lock<std::mutex> lk(emu);
          ecv.wait(lk, [&]{ return wNext < dispatched || wNext >= N; });
          if (wNext >= N) break;
          k = wNext++; }
        EmitJob& J = *jobs[k];
        GW g = base;
        g.px = J.entry.px; g.py = J.entry.py; g.curF = J.entry.curF; g.lastFan = J.entry.lastFan;
        g.island = std::move(J.island);
        SeamCtx sc = J.entry.sc;
        LayerData& ldk = L[k];
        emit_layer_any(g, J.tp, J.widths, k, ldk, J.pre, p, ldk.z + zShift, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, sc);
        J.gcode.swap(g.s); J.filament = g.filament; J.segments = g.segments; J.crossings = g.wall_crossings;
        J.jst.store(2, std::memory_order_release);
        ecv.notify_all();
      }
    };
    std::vector<std::thread> wths; wths.reserve(WN);
    for (unsigned t = 0; t < WN; ++t) { try { wths.emplace_back(writerFn); } catch (...) { break; } }
    const int FW = (int)std::max<size_t>(1, wths.size()) * 2 + 2;
    int fl = 0;
    auto flushJob = [&](int k){
      EmitJob& J = *jobs[k];
      if (wths.empty()) {   // fallback when no writer could be spawned (pool exhausted): the main thread generates it itself
        GW g = base; g.px=J.entry.px; g.py=J.entry.py; g.curF=J.entry.curF; g.lastFan=J.entry.lastFan;
        g.island = std::move(J.island); SeamCtx sc = J.entry.sc; LayerData& ldk = L[k];
        emit_layer_any(g, J.tp, J.widths, k, ldk, J.pre, p, ldk.z + zShift, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, sc);
        J.gcode.swap(g.s); J.filament = g.filament; J.segments = g.segments; J.crossings = g.wall_crossings;
        J.jst.store(2);
      }
      { std::unique_lock<std::mutex> lk(emu); ecv.wait(lk, [&]{ return J.jst.load(std::memory_order_acquire) == 2; }); }
      double zk = L[k].z + zShift;
      gw.filament += J.filament; gw.segments += J.segments; gw.wall_crossings += J.crossings;
      if (!streaming) {
        em::val Lo = em::val::object(); Lo.set("z", zk); Lo.set("paths", to_f32(J.tp)); Lo.set("widths", to_f32(J.widths));
        layersArr.call<void>("push", Lo);
        gw.s += J.gcode;
        if (overlapBatch) feed_batch_tail();
      } else {
        if (streamTime) feeder.feed(J.gcode);
        em::val paths = economy ? em::val::array() : to_f32(J.tp);
        em::val wid   = economy ? em::val::array() : to_f32(J.widths);
        sink(zk, k, J.gcode, paths, wid);
      }
      J.gcode = std::string(); J.tp = {}; J.widths = {}; J.pre = EmitPre{};
      if (!keepStages) { int old = k - std::max(p.bottom_shell_layers, 1) - 1 - FW;   // release only outside the writer/dry reference window
        if (old >= 0) L[old] = LayerData{}; }
      report(N+2+k+1, total);
    };
    gw.dry = true;
    bool __cxAborted = false;
    std::vector<float> dtp, dwv;   // dry-run dummies (not recorded)
    for (int i = 0; i < N; ++i) {
      if (CX()) { __cxAborted = true; break; }   // G002: stop dispatching new work -> join the existing shutdown path
      EmitPre pre;
      { std::unique_lock<std::mutex> lk(pmu);
        cv_done.wait(lk, [&]{ return preDone[i] != 0; });
        pre = std::move(preBuf[i]);
        preConsumed = i; }
      cv_room.notify_all();
      LayerData& ld = L[i];
      EmitJob& J = *jobs[i];
      J.entry = { gw.px, gw.py, gw.curF, gw.lastFan, seamCtx };
      J.island = g_keep_island ? ld.island : std::move(ld.island);   // G003
      emit_layer_any(gw, dtp, dwv, i, ld, pre, p, ld.z + zShift, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, seamCtx);
      J.pre = std::move(pre);
      { std::lock_guard<std::mutex> lk(emu); dispatched = i + 1; J.jst.store(1); }
      ecv.notify_all();
      if (i - FW >= fl) { flushJob(fl); ++fl; }
    }
    gw.dry = false;
    while (!__cxAborted && fl < N) { flushJob(fl); ++fl; }   // G002: on cancel, never wait for undispatched jobs (avoids a deadlock)
    { std::lock_guard<std::mutex> lk(emu); wNext = std::max(wNext, N); dispatched = N; }
    ecv.notify_all();
    for (auto& th : wths) th.join();
  } else
#endif
  for (int i=0;i<N;++i) {
    if (CX()) break;   // G002
    if (!keepStages) { int old = i - std::max(p.bottom_shell_layers, 1) - 1;
      if (old >= 0) L[old] = LayerData{}; }
    EmitPre pre;
#ifdef __EMSCRIPTEN_PTHREADS__
    { std::unique_lock<std::mutex> lk(pmu);
      cv_done.wait(lk, [&]{ return preDone[i] != 0; });
      pre = std::move(preBuf[i]);
      preConsumed = i; }
    cv_room.notify_all();
#else
    pre = compute_pre(i);
#endif
    LayerData& ld = L[i];
    double zE = ld.z + zShift;
    std::vector<float> tp;
    std::vector<float> widths;
    if (p.spiral_mode && !ld.contour.empty()) {
      // ===== Spiral (vase): a single outer wall with a z ramp — excluded from parallelism, kept inline as before =====
      gw.set_e_per_mm(ld.h, p); gw.z = zE; gw.pe_reset();
      gw.island = g_keep_island ? ld.island : std::move(ld.island);   // G003
      seamCtx.rng = 2654435761u * (uint32_t)(i+1);
      g_seg_w = &widths; g_seg_w_cur = (float)w;
      char cm[72];
      std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.raw(cm);
      gw.set_fan(fan_S(i, p));
      std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
      int fSp = (int)std::llround(((i==0&&nraft==0)?p.first_layer_speed:p.print_speed)*60);
      emit_spiral(gw, tp, ld.walls.empty()?Paths{}:ld.walls[0], zE, ld.h, fSp, fTravel);
    } else {
      emit_layer_any(gw, tp, widths, i, ld, pre, p, zE, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, seamCtx);
    }
    flush_layer(zE, i, tp, widths);
    report(N+2+i+1, total);
  }
#ifdef __EMSCRIPTEN_PTHREADS__
  { std::lock_guard<std::mutex> lk(pmu); preNext = std::max(preNext, N); }   // wake the remaining workers -> they exit
  cv_room.notify_all();
  for (auto& th : preThs) th.join();
#endif
  g_seg_w = nullptr;   // stage 7: stop width tracking (the local widths goes out of scope)
  if (CX()) {          // G002: all threads joined — just clean up the feeder and return canceled
#ifdef __EMSCRIPTEN_PTHREADS__
    if (streamTime || overlapBatch) (void)feeder.finish();
#else
    if (streamTime) (void)gcodeproc_bridge::estimate_end();
#endif
    em::val r = em::val::object(); r.set("error", std::string("canceled")); return r;
  }

  // ---- Finish ----
  gw.raw("; end"); gw.raw("M104 S0"); gw.raw("M140 S0"); gw.raw("M107");
  { char h[64]; std::snprintf(h,sizeof h,"; filament used: %.2f mm", gw.filament); gw.raw(h); }

  gcode_time::Result te; std::string engine_used;
  auto absorb = [&](const gcodeproc_bridge::Result& fr){
    te.total_s=fr.total_s; te.first_layer_s=fr.first_layer_s; te.extrude_s=fr.extrude_s; te.travel_s=fr.travel_s;
    te.filament_mm=fr.filament_mm; te.moves=fr.moves; te.layer_s=fr.layer_s; te.role_s=fr.role_s;
  };
  if (streaming) {
    // Stage 30: after emitting the closing chunk (; end … filament comments), end the streamed time estimate. The G-code and layers have
    //  already been emitted through the callback and gw.s is empty (released per layer). Economy mode skips the time estimate entirely.
    { std::vector<float> empty; flush_layer(gw.z, N + nraft, empty, empty); }
    if (streamTime) {
#ifdef __EMSCRIPTEN_PTHREADS__
      gcodeproc_bridge::Result fr = feeder.finish();   // (mt) waits for the queue to drain (join) then ends — the result matches a synchronous feed
#else
      gcodeproc_bridge::Result fr = gcodeproc_bridge::estimate_end();
#endif
      if (fr.ok) { absorb(fr); engine_used = "full-stream"; } else engine_used = "stream-notime";
    } else engine_used = "economy";
  } else {
    // Batch: the real PressureEqualizer (opt-in) -> strip tags -> estimate the time over the whole g-code (the byte-identical path is unchanged).
#ifdef __EMSCRIPTEN_PTHREADS__
    if (overlapBatch) feed_batch_tail();   // feed the footer — fedOff is an offset into the unmodified gw.s, so this must happen before the strip below
#endif
    if (realPE)
      gw.s = pe_bridge::equalize(gw.s, p.filament_diameter, p.max_volumetric_extrusion_rate_slope,
                                 p.extrusion_rate_slope_segment_length, /*relative_e*/true, p.pe_external_perimeter_only);
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(gw.s);
    if (p.time_engine == "transcribed") {
      te = gcode_time::estimate(gw.s, glim); engine_used = "transcribed";
    } else {
#ifdef __EMSCRIPTEN_PTHREADS__
      // (mt) With overlapBatch, finish with what has been fed (parsing already overlapped emission). Non-targets such as realPE keep the old one-shot estimate.
      gcodeproc_bridge::Result fr = overlapBatch ? feeder.finish() : gcodeproc_bridge::estimate(gw.s, gl);
#else
      gcodeproc_bridge::Result fr = gcodeproc_bridge::estimate(gw.s, gl);
#endif
      if (fr.ok) { absorb(fr); engine_used = "full"; }
      else { te = gcode_time::estimate(gw.s, glim); engine_used = "full-fallback-transcribed"; }
    }
  }

  em::val stats = em::val::object();
  stats.set("layers", N + nraft);          // total emitted layers (raft included) = the length of the layers array
  stats.set("model_layers", N);
  stats.set("raft_layers", nraft);
  stats.set("path_segments", (double)gw.segments);
  stats.set("filament_mm", gw.filament);
  stats.set("wall_crossings", (double)gw.wall_crossings);   // number of wall-crossing travels (cross-check for reduce_crossing_wall)
  { double tw_end = emscripten_get_now();                    // phase timing (ms) — for deciding what to parallelize
    stats.set("t_pass1_ms",   tw_p1  - tw0);
    stats.set("t_surface_ms", tw_p15 - tw_p1);
    stats.set("t_support_ms", tw_sup - tw_p15);
    stats.set("t_emit_ms",    tw_end - tw_sup);
    stats.set("t_flush_ms", t_flush);                    // the JS boundary's share during emit (to_f32/sink/feed)
    }
  stats.set("over_bed", over_bed);
  // Upstream time estimate results
  stats.set("time_estimate", te.total_s);                   // total estimated print time (seconds)
  stats.set("first_layer_time", te.first_layer_s);
  stats.set("time_extrude", te.extrude_s);
  stats.set("time_travel", te.travel_s);
  stats.set("time_filament_mm", te.filament_mm);            // filament usage from parsing (to compare against gw.filament)
  stats.set("time_moves", (double)te.moves);
  { em::val lt=em::val::array(); for (size_t k=0;k<te.layer_s.size();++k) lt.call<void>("push", te.layer_s[k]);
    stats.set("layer_times", lt); }
  { em::val rt=em::val::object(); for (auto& kv:te.role_s) rt.set(std::to_string(kv.first), kv.second);
    stats.set("role_times", rt); }
  stats.set("time_engine", engine_used);                    // stage 13: which time estimation engine ran (full|transcribed|fallback)
  stats.set("streamed", streaming);                          // stage 30: when true, g-code/layers were emitted via the callback (not in result)
  stats.set("economy", economy);                             // stage 30: whether it finished in economy mode (no toolpaths, no time estimate)
  result.set("stats", stats);
  // G003: update the stage cache — keep it when requested (for reuse by the next slice), otherwise invalidate the stale cache with the new geometry.
  if (keepStages && !CX()) {
    if (!reuseSup) {
      if (!reuseGeom) g_scache.tris = std::move(trisOwn);
      g_scache.height = height; g_scache.cx = cx; g_scache.cy = cy; g_scache.over_bed = over_bed;
      g_scache.N = N; g_scache.layerKey = lk; g_scache.L = std::move(Lown);
      g_scache.treeSupLayers = treeSupLayers; g_scache.treeZMaxResid = treeZMaxResid;
    }
    g_scache.valid = true;
  } else if (!reuseSup && !reuseGeom) g_scache.valid = false;
  if (!streaming) { result.set("gcode", gw.s); result.set("layers", layersArr); }  // streaming does not emit resident copies
  return result;
}

// Stage 12: exposes and proves that the real config subsystem is linked into the main module (prevents dead-stripping + used by the node checks).
static double heap_size() { return (double)emscripten_get_heap_size(); }   // stage 30: current WASM heap size in bytes (= the peak)
static int config_option_count() { return config_bridge::option_count(); }
static std::string config_option_default(const std::string& key) { return config_bridge::option_default(key); }

// ---- Stage 20: kernel wiring for manual support painting (TriangleSelector) ----
// The selector is built from a welded mesh under the same transform as slice() (XY bbox centered, minZ=0) -> facet indices and
// coordinates match the slices. The viewer calls selector_prepare(stl) once on load -> selector_paint per drag -> slice().
static void selector_prepare(em::val stl) {
  std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl);
  std::vector<Tri> tris = parse_stl(bytes);
  if (tris.empty()) { selector_bridge::construct({}, {}); return; }
  double minx=1e18,miny=1e18,minz=1e18,maxx=-1e18,maxy=-1e18,maxz=-1e18;
  for (auto& t:tris) for (int k=0;k<3;++k){
    minx=std::min(minx,(double)t.v[k].x);maxx=std::max(maxx,(double)t.v[k].x);
    miny=std::min(miny,(double)t.v[k].y);maxy=std::max(maxy,(double)t.v[k].y);
    minz=std::min(minz,(double)t.v[k].z);maxz=std::max(maxz,(double)t.v[k].z); }
  // Stage 28 P2: matches the slicing default (auto_center=false) — no XY realignment, only Z seating (trusting the viewer coordinates).
  // weld: dedup vertices (quantized, EXACT tuple key — an XOR hash collides and destroys topology)
  //  preserving triangle order → facet i == parse order i (viewer raycast face index match).
  std::vector<float> verts; std::vector<int> idx; std::map<std::array<long long,3>,int> vmap;
  auto add=[&](double x,double y,double z)->int{
    std::array<long long,3> k{ (long long)std::llround(x*1e4), (long long)std::llround(y*1e4), (long long)std::llround(z*1e4) };
    auto it=vmap.find(k); if(it!=vmap.end()) return it->second;
    int id=(int)(verts.size()/3); verts.push_back((float)x);verts.push_back((float)y);verts.push_back((float)z); vmap[k]=id; return id; };
  for (auto& t:tris) for (int k=0;k<3;++k)
    idx.push_back(add(t.v[k].x, t.v[k].y, t.v[k].z-minz));   // stage 28: XY as-is (viewer coordinates), Z seated
  selector_bridge::construct(verts, idx);
}
static void selector_paint(int facet, float hx,float hy,float hz, float cx,float cy,float cz, float radius, bool enforcer) {
  selector_bridge::paint(facet, hx,hy,hz, cx,cy,cz, radius, enforcer);
}
static void selector_clear() { selector_bridge::clear(); }
static int  selector_facet_count() { return selector_bridge::facet_count(); }
static int  selector_painted_count(bool enforcer) { return selector_bridge::painted_count(enforcer); }
static em::val selector_overlay(bool enforcer) { return to_f32(selector_bridge::overlay(enforcer)); }
static em::val selector_project_counts(em::val zsVal, bool enforcer) {   // debug: #polys per z
  std::vector<double> zs = em::convertJSArrayToNumberVector<double>(zsVal);
  auto pl = selector_bridge::project_layers(zs, enforcer);
  std::vector<float> counts; counts.reserve(pl.size());
  for (auto& layer : pl) counts.push_back((float)layer.size());
  return to_f32(counts);
}

EMSCRIPTEN_BINDINGS(slicer) {
  em::function("slice", &slice);
  em::function("set_layer_sink", &set_layer_sink);           // stage 30: register cb(z,idx,gcodeChunk,pathsF32,widthsF32) -> streaming
  em::function("clear_layer_sink", &clear_layer_sink);       //  unregister it (the next slice runs in batch mode)
  em::function("heap_size", &heap_size);                     // stage 30: for measuring the WASM heap peak (bytes)
  em::function("sup_progress_ptr", +[]() -> double {         // heap address of the real support progress counter (u32) — for SAB polling under mt
    return (double)treesupport_bridge::progress_addr(); });
  em::function("sup_progress_view", +[]() -> em::val {       // a Uint32Array view of the same counter — .buffer yields the SAB
    return em::val(em::typed_memory_view((size_t)1, (const unsigned int*)(uintptr_t)treesupport_bridge::progress_addr())); });
  em::function("cancel_flag_view", +[]() -> em::val {        // G002: a view of the cancel flag (u32) — the UI writes it directly via SAB
    return em::val(em::typed_memory_view((size_t)1, (const unsigned int*)(uintptr_t)treesupport_bridge::cancel_addr())); });
  em::function("config_option_count", &config_option_count);
  em::function("config_option_default", &config_option_default);
  em::function("cgal_planar_check_count", &arachne_bridge::cgal_planar_check_count); // stage 14: number of real CGAL planarity check calls
  em::function("selector_prepare", &selector_prepare);       // stage 20: register the mesh on load
  em::function("selector_paint", &selector_paint);           //  paint with the sphere cursor on every drag
  em::function("selector_clear", &selector_clear);
  em::function("selector_facet_count", &selector_facet_count);
  em::function("selector_painted_count", &selector_painted_count);
  em::function("selector_overlay", &selector_overlay);       //  overlay triangles (enforcer=blue / blocker=red)
  em::function("selector_project_counts", &selector_project_counts); // debug: number of projected polygons per z
}
