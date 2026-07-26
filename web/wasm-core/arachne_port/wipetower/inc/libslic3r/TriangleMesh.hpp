// STUB (stage 11 WipeTower port): the real TriangleMesh.hpp pulls admesh/stl.h + Format/STL.hpp +
// the whole mesh-repair/slicer subsystem. WipeTower.cpp uses TriangleMesh ONLY as the return type of
// its_make_rib_tower / its_make_rib_brim (called from Print.cpp, NOT from the wipe-tower g-code
// path), touching just `mesh.its.vertices` / `mesh.its.indices` (an indexed_triangle_set). Minimal
// definition sufficient for those two bodies to compile.
#ifndef slic3r_TriangleMesh_stub_hpp_
#define slic3r_TriangleMesh_stub_hpp_

#include "libslic3r.h"
#include "Point.hpp"
// The real TriangleMesh.hpp transitively provides these; WipeTower.hpp's inline get_bbx() depends on
// BoundingBox/BoundingBoxf + Polygon being complete, so mirror those includes here.
#include "BoundingBox.hpp"
#include "Line.hpp"
#include "Polygon.hpp"
#include "ExPolygon.hpp"
#include <vector>

namespace Slic3r {

// admesh indexed_triangle_set: vertices are Vec3f (stl_vertex), indices are Vec3i32
// (stl_triangle_vertex_indices).
struct indexed_triangle_set {
    std::vector<Vec3f>   vertices;
    std::vector<Vec3i32> indices;
    void clear() { vertices.clear(); indices.clear(); }
    bool empty() const { return indices.empty(); }
};

class TriangleMesh {
public:
    indexed_triangle_set its;
    TriangleMesh() = default;
    explicit TriangleMesh(indexed_triangle_set &&M) : its(std::move(M)) {}
    bool empty() const { return its.indices.empty(); }
};

} // namespace Slic3r
#endif
