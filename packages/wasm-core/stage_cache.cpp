// stage_cache.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  `static` dropped: the struct/definition moved to stage_cache.h/.cpp so slice() and the phase files share one instance.
#include "stage_cache.h"

#include <cstdio>

StageCache g_scache;
std::string make_layer_key(const Params& p) {
  char k[512];
  std::snprintf(k, sizeof k, "%.6f|%.6f|%.6f|%d|%d|%s|%d|%.3f|%.3f|%.3f|%.3f|%d|%d|%s|%s|%.3f|%d|%.4f|%d",
    p.layer_height, p.first_layer_height, p.line_width, p.wall_loops, (int)p.enable_support,
    p.support_style.c_str(), (int)p.support_auto, p.support_threshold_angle, p.support_top_z_distance,
    p.support_xy_distance, p.support_density, p.support_interface_top_layers, p.raft_layers,
    p.wall_generator.c_str(), p.sparse_infill_pattern.c_str(), p.infill_density,
    (int)p.auto_center, p.gcode_resolution, (int)p.spiral_mode);
  return std::string(k);
}
