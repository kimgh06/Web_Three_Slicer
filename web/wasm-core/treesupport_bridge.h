// Stage-17 bridge: plain-type interface to the REAL organic TreeSupport pipeline (stage-16 port).
// slicer_core.cpp includes ONLY this header (no Slic3r/facade types), so the kernel's world and the
// treesupport_port world meet in exactly one translation unit (treesupport_bridge.cpp), keeping their
// (ABI-identical but separately compiled) Slic3r symbols from leaking type definitions into the kernel.
#pragma once
#include <vector>
#include <utility>

namespace treesupport_bridge {

// One closed ring in mm (kernel-centered coords). Winding is preserved; holes are inferred by union.
using Ring = std::vector<std::pair<double,double>>;

// One support extrusion polyline (mm) with its extrusion width (mm).
struct Line { std::vector<std::pair<double,double>> pts; double width; };

// Support toolpaths at one support layer (its print_z in mm + the polylines).
struct LayerOut { double print_z_mm; std::vector<Line> lines; };

struct Params {
    double layer_height_mm      = 0.2;
    double nozzle_mm            = 0.4;
    double support_threshold_angle = 30.0; // deg (0 => auto)
    double support_top_z_distance  = 0.2;  // mm
    double support_xy_distance     = 0.35; // mm
    int    interface_top_layers    = 2;
    bool   support_auto            = true; // true=auto overhang detect (stTreeAuto); false=manual (only painted enforcers)
    double support_line_width_mm   = 0.0;  // 0 => auto (line_width); >0 => explicit support extrusion width
    double bed_width_mm            = 200.0;
    double bed_depth_mm            = 200.0;
    double printable_height_mm     = 250.0;
};

// object_slices_mm[layer] = the object's slice rings at that layer (mm). layer_print_z_mm[layer] = its print_z.
// Runs TreeSupport::generate() (smsTreeOrganic / stTreeAuto) on a facade PrintObject built from these slices
// and returns the generated support extrusion toolpaths per support layer. Empty vector => no support.
//
// The treesupport group is compiled fully self-contained with -fvisibility=hidden and then run through
// llvm-objcopy --localize-hidden, so every internal Slic3r symbol becomes local and cannot collide with
// (or borrow the trimmed behavior of) the main build's stubbed copies. This ONE entry point must stay
// exported (default visibility) so slicer_core.cpp can call across the boundary.
__attribute__((visibility("default")))
std::vector<LayerOut> generate(const std::vector<std::vector<Ring>>& object_slices_mm,
                               const std::vector<double>&            layer_print_z_mm,
                               const Params&                         params);

} // namespace treesupport_bridge
