// Stage-20: port-world accessors to the painted enforcer/blocker facets, shared between
// selector_bridge_impl.cpp (owner) and treesupport_bridge_impl.cpp (consumer) — both compiled in the
// isolated treesupport group, so they exchange real Slic3r::indexed_triangle_set directly.
#pragma once
#include "TriangleMesh.hpp"   // indexed_triangle_set
namespace Slic3r {
// Painted facets in kernel coords (empty if nothing painted / no mesh). Recomputed from the selector.
const indexed_triangle_set& selector_enforcer_its();
const indexed_triangle_set& selector_blocker_its();
bool selector_has_paint();
}
