// Stage-8 bridge: plain-type interface to the ported OrcaSlicer Fill/ framework (real FillGyroid,
// FillHoneycomb, Fill3DHoneycomb, FillCrossHatch, FillConcentric). slicer_core.cpp includes ONLY
// this header (no Slic3r types), same isolation pattern as arachne_bridge.
#pragma once
#include <vector>
#include <utility>
#include <string>

namespace fill_bridge {
using Poly = std::vector<std::pair<double,double>>;   // polygon/polyline as (x,y) mm

// region_mm[0] = outer contour, [1..] = holes (mm, kernel coords).
// pattern: "gyroid" | "honeycomb" | "3dhoneycomb" | "crosshatch" | "concentric".
// density in <0,1>, spacing_mm = base line width, angle_deg, z_mm (unscaled), layer_id.
// Returns infill polylines (each = (x,y) mm). Empty on unknown pattern / empty region.
std::vector<Poly> generate_fill(const std::vector<Poly>& region_mm, const std::string& pattern,
                                double density, double spacing_mm, double angle_deg,
                                double z_mm, int layer_id);
} // namespace fill_bridge
