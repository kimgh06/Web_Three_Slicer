// Stage-9 bridge impl: drives the real ported MinimumSpanningTree (TreeSupport branch-merge core).
#include "tree_bridge.h"
#include "arachne_port/libslic3r/MinimumSpanningTree.hpp"
#include <set>
#include <cmath>
using namespace Slic3r;

namespace tree_bridge {
std::vector<Edge> branch_mst(const std::vector<std::pair<double,double>>& pts_mm)
{
    std::vector<Edge> out;
    if (pts_mm.size() < 2) return out;
    std::vector<Point> verts; verts.reserve(pts_mm.size());
    for (const auto& p : pts_mm)
        verts.emplace_back((coord_t)std::llround(p.first / SCALING_FACTOR),
                           (coord_t)std::llround(p.second / SCALING_FACTOR));
    MinimumSpanningTree mst(verts);
    std::set<std::pair<long long,long long>> seen;
    for (const Point& v : mst.vertices())
        for (const Point& a : mst.adjacent_nodes(v)) {
            long long ka = (long long)v.x() * 1000003LL + v.y();
            long long kb = (long long)a.x() * 1000003LL + a.y();
            auto key = std::minmax(ka, kb);
            if (!seen.insert({key.first, key.second}).second) continue;   // undirected, unique
            out.push_back({ v.x()*SCALING_FACTOR, v.y()*SCALING_FACTOR, a.x()*SCALING_FACTOR, a.y()*SCALING_FACTOR });
        }
    return out;
}
}
