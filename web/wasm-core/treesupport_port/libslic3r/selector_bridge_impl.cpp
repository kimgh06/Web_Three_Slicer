// Stage-20 selector bridge impl (port world): owns a TriangleSelector over the current mesh, paints
// enforcer/blocker patches, and projects the painted facets to per-layer polygons via slice_mesh_slabs.
// Lives inside treesupport_port/libslic3r/ so every Slic3r include is file-relative (port-local).
#include "../../selector_bridge.h"
#include "selector_state.hpp"
#include "TriangleSelector.hpp"
#include "TriangleMesh.hpp"
#include "custom_facet_project.hpp"   // (stage 20) footprint projection
#include <memory>

using namespace Slic3r;

namespace {
    std::unique_ptr<TriangleMesh>      g_mesh;
    std::unique_ptr<TriangleSelector>  g_sel;
    indexed_triangle_set               g_enforcer, g_blocker;  // cached painted facets (kernel coords)
    bool                               g_dirty = true;

    void refresh() {
        if (!g_dirty) return;
        if (g_sel) { g_enforcer = g_sel->get_facets(EnforcerBlockerType::ENFORCER);
                     g_blocker  = g_sel->get_facets(EnforcerBlockerType::BLOCKER); }
        else { g_enforcer = {}; g_blocker = {}; }
        g_dirty = false;
    }
}

// ---- port-world accessors (selector_state.hpp) ----
namespace Slic3r {
const indexed_triangle_set& selector_enforcer_its() { refresh(); return g_enforcer; }
const indexed_triangle_set& selector_blocker_its()  { refresh(); return g_blocker; }
bool selector_has_paint() { refresh(); return !g_enforcer.indices.empty() || !g_blocker.indices.empty(); }
}

namespace selector_bridge {

void construct(const std::vector<float>& verts, const std::vector<int>& tris) {
    indexed_triangle_set its;
    its.vertices.reserve(verts.size() / 3);
    for (size_t i = 0; i + 2 < verts.size(); i += 3) its.vertices.emplace_back(verts[i], verts[i+1], verts[i+2]);
    its.indices.reserve(tris.size() / 3);
    for (size_t i = 0; i + 2 < tris.size(); i += 3) its.indices.emplace_back(tris[i], tris[i+1], tris[i+2]);
    g_mesh = std::make_unique<TriangleMesh>(its);
    g_sel  = std::make_unique<TriangleSelector>(*g_mesh);
    g_dirty = true;
}

void clear() { if (g_mesh) g_sel = std::make_unique<TriangleSelector>(*g_mesh); g_dirty = true; }

int  facet_count() { return g_mesh ? int(g_mesh->its.indices.size()) : 0; }
bool has_paint()   { return Slic3r::selector_has_paint(); }

void paint(int facet, float hx, float hy, float hz, float cx, float cy, float cz, float radius, bool enforcer) {
    if (!g_sel || facet < 0 || facet >= int(g_mesh->its.indices.size())) return;
    const Vec3f center(hx, hy, hz), camera(cx, cy, cz);
    Transform3d trafo = Transform3d::Identity();
    auto cursor = TriangleSelector::SinglePointCursor::cursor_factory(
        center, camera, radius, TriangleSelector::CursorType::SPHERE, trafo, TriangleSelector::ClippingPlane());
    g_sel->select_patch(facet, std::move(cursor),
        enforcer ? EnforcerBlockerType::ENFORCER : EnforcerBlockerType::BLOCKER, trafo, /*triangle_splitting*/true);
    g_dirty = true;
}

int painted_count(bool enforcer) { refresh(); return int((enforcer ? g_enforcer : g_blocker).indices.size()); }

std::vector<float> overlay(bool enforcer) {
    refresh();
    const indexed_triangle_set& its = enforcer ? g_enforcer : g_blocker;
    std::vector<float> out; out.reserve(its.indices.size() * 9);
    for (const auto& f : its.indices)
        for (int k = 0; k < 3; ++k) { const Vec3f& v = its.vertices[f[k]]; out.push_back(v.x()); out.push_back(v.y()); out.push_back(v.z()); }
    return out;
}

std::vector<std::vector<std::vector<std::pair<double,double>>>>
project_layers(const std::vector<double>& slice_zs_mm, bool enforcer) {
    refresh();
    std::vector<std::vector<std::vector<std::pair<double,double>>>> out(slice_zs_mm.size());
    const indexed_triangle_set& its = enforcer ? g_enforcer : g_blocker;
    if (its.indices.empty() || slice_zs_mm.empty()) return out;
    std::vector<float> zs; zs.reserve(slice_zs_mm.size());
    for (double z : slice_zs_mm) zs.push_back(float(z));
    std::vector<Polygons> projected = project_custom_facets_footprint(its, zs);   // XY footprint per layer
    for (size_t i = 0; i < out.size() && i < projected.size(); ++i)
        for (const Polygon& p : projected[i]) {
            std::vector<std::pair<double,double>> ring; ring.reserve(p.points.size());
            for (const Point& pt : p.points) ring.emplace_back(unscale<double>(pt.x()), unscale<double>(pt.y()));
            if (ring.size() >= 3) out[i].push_back(std::move(ring));
        }
    return out;
}

} // namespace selector_bridge
