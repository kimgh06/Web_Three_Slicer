// Stage-20 bridge: plain-type interface to the ported TriangleSelector (manual support painting).
// slicer_core.cpp includes ONLY this header and embind-exports the functions; the Slic3r/facade types
// live in the port-world impl (treesupport_port/libslic3r/selector_bridge_impl.cpp), which shares the
// painted enforcer/blocker its with treesupport_bridge (both port world). Mesh coords are the kernel's
// transformed coords (XY-centered, z-min=0) so facet indices + hit points line up with the kernel slice.
#pragma once
#include <vector>
#include <utility>

namespace selector_bridge {

// Build the selector from a WELDED mesh in kernel coords: verts = flat x,y,z; tris = flat 3 indices/face.
// Face order must match the kernel's triangle order so a viewer raycast face index == selector facet.
void construct(const std::vector<float>& verts, const std::vector<int>& tris);
void clear();
int  facet_count();
bool has_paint();

// Paint a Sphere-cursor patch anchored at facet `facet` around world hit point (hx,hy,hz), camera at
// (cx,cy,cz), radius mm. enforcer=true paints ENFORCER, false paints BLOCKER.
void paint(int facet, float hx, float hy, float hz, float cx, float cy, float cz, float radius, bool enforcer);
int  painted_count(bool enforcer);   // number of painted facets of that state (UI feedback)

// Overlay triangles for the painted state: flat x,y,z per vertex, 3 vertices per triangle (three.js render).
std::vector<float> overlay(bool enforcer);

// Project the painted enforcer/blocker facets to per-layer polygons (mm rings) at the given slice-z's,
// via slice_mesh_slabs — the grid/tree_lite kernel path consumes these. one entry per z.
std::vector<std::vector<std::vector<std::pair<double,double>>>>
project_layers(const std::vector<double>& slice_zs_mm, bool enforcer);

} // namespace selector_bridge
