// Stage-20: project painted enforcer/blocker facets to per-layer polygons by XY footprint.
// slice_mesh_slabs() returns empty for an isolated (non-watertight) painted patch, so we use a direct,
// deterministic footprint: each painted triangle contributes its 2D (XY) projection to every slicing
// plane whose z falls within the triangle's z-span (flat faces -> the nearest plane). The per-layer
// union is the enforced/blocked region, consumed by generate_overhangs (tree) and the grid path.
#pragma once
#include "TriangleMesh.hpp"     // indexed_triangle_set
#include "Polygon.hpp"
#include "ClipperUtils.hpp"     // union_
#include <vector>
#include <algorithm>

namespace Slic3r {

inline std::vector<Polygons> project_custom_facets_footprint(const indexed_triangle_set &its,
                                                             const std::vector<float> &zs)
{
    std::vector<Polygons> out(zs.size());
    if (its.indices.empty() || zs.empty()) return out;
    // half the layer spacing (uniform layers) — tolerance so a flat face lands on its nearest plane.
    float halfgap = zs.size() > 1 ? std::max(1e-4f, 0.5f * std::abs(zs[1] - zs[0])) : 1e-3f;
    for (const auto &f : its.indices) {
        const Vec3f &a = its.vertices[f[0]], &b = its.vertices[f[1]], &c = its.vertices[f[2]];
        float zmin = std::min({a.z(), b.z(), c.z()}), zmax = std::max({a.z(), b.z(), c.z()});
        Point A(scale_(a.x()), scale_(a.y())), B(scale_(b.x()), scale_(b.y())), C(scale_(c.x()), scale_(c.y()));
        // Orientation via double cross product (scaled coords overflow coord_t area math on large facets).
        double cross = double(B.x()-A.x())*double(C.y()-A.y()) - double(B.y()-A.y())*double(C.x()-A.x());
        if (cross == 0.0) continue;   // degenerate (edge-on) projection
        Polygon tri; tri.points = (cross > 0.0) ? Points{A,B,C} : Points{A,C,B};   // ensure CCW
        for (size_t i = 0; i < zs.size(); ++i)
            if (zs[i] >= zmin - halfgap && zs[i] <= zmax + halfgap)
                out[i].push_back(tri);
    }
    for (Polygons &p : out) if (!p.empty()) p = union_(p);
    return out;
}

} // namespace Slic3r
