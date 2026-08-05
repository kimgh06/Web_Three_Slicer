// Stage-9 bridge: plain-type interface to the ported OrcaSlicer TreeSupport CORE geometry routine
// MinimumSpanningTree (branch placement/merging over support points). The full TreeSupport pipeline
// is PrintObject-coupled (blocked — see README); this exposes its portable core driven by kernel points.
#pragma once
#include <vector>
#include <utility>
namespace tree_bridge {
struct Edge { double x0, y0, x1, y1; };   // a branch connection (mm)
// Given support/overhang points (mm), build the minimum spanning tree and return its branch edges.
std::vector<Edge> branch_mst(const std::vector<std::pair<double,double>>& points_mm);
}
