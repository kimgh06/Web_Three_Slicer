// STUB (stage 11 WipeTower port): the real Triangulation.hpp pulls the constrained-Delaunay mesher.
// WipeTower.cpp calls Triangulation::triangulate(const Polygon&) only inside its_make_rib_tower /
// its_make_rib_brim (mesh generators consumed by Print.cpp, NOT the wipe-tower g-code path). The
// declaration matches the real signature (Indices = std::vector<Vec3i32>); the definition returns an
// empty triangulation. A faithful rib mesh would need the real triangulator (deferred with the mesh
// subsystem). This does NOT affect wipe-tower g-code generation.
#ifndef slic3r_Triangulation_stub_hpp_
#define slic3r_Triangulation_stub_hpp_

#include "libslic3r.h"
#include "Point.hpp"
#include "Polygon.hpp"
#include "ExPolygon.hpp"
#include <vector>

namespace Slic3r {
class Triangulation {
public:
    using Indices = std::vector<Vec3i32>;
    static Indices triangulate(const Polygon&)    { return {}; }
    static Indices triangulate(const Polygons&)   { return {}; }
    static Indices triangulate(const ExPolygon&)  { return {}; }
    static Indices triangulate(const ExPolygons&) { return {}; }
    static Indices triangulate(const Points&)     { return {}; }
};
} // namespace Slic3r
#endif
