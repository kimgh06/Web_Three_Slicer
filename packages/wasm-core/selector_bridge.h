// Stage-20 bridge: plain-type interface to the ported TriangleSelector (manual support painting).
// slicer_core.cpp includes ONLY this header and embind-exports the functions; the Slic3r/facade types
// live in the port-world impl (treesupport_port/libslic3r/selector_bridge_impl.cpp), which shares the
// painted enforcer/blocker its with treesupport_bridge (both port world). Mesh coords are the kernel's
// transformed coords (XY-centered, z-min=0) so facet indices + hit points line up with the kernel slice.
#pragma once
#include <vector>
#include <utility>

namespace selector_bridge {

// Painting state = the upstream EnforcerBlockerType (slicer/src/libslic3r/TriangleSelector.hpp), which is one enum
// serving both jobs: NONE=0, ENFORCER=1 (== Extruder1), BLOCKER=2 (== Extruder2), Extruder3..Extruder16 = 3..16.
// So a single int addresses the support enforcer/blocker pair AND every MMU extruder — hence the bridge takes the
// state number rather than a bool. Every QUERY (painted_count/overlay/project_layers) rejects anything outside
// [1,16] and answers "nothing painted"; paint() additionally accepts STATE_NONE, which is the erase — see below.
enum : int {
  STATE_NONE      = 0,
  STATE_ENFORCER  = 1,   // == Extruder1
  STATE_BLOCKER   = 2,   // == Extruder2
  STATE_EXTRUDER_MAX = 16,
};

// Build the selector from a WELDED mesh in kernel coords: verts = flat x,y,z; tris = flat 3 indices/face.
// Face order must match the kernel's triangle order so a viewer raycast face index == selector facet.
void construct(const std::vector<float>& verts, const std::vector<int>& tris);
void clear();
int  facet_count();
bool has_paint();                    // true when ANY state (1..16) has painted facets

// Brush shape for paint(). Upstream's CursorType has five entries but its own cursor_factory asserts on all but
// these two — the other three are separate tools (seed/bucket fill below), not cursors. SPHERE is 0 so a caller
// that sends nothing keeps the brush the support painting has always used.
enum : int {
  CURSOR_SPHERE = 0,   // a ball around the hit: also catches the far wall of a thin part
  CURSOR_CIRCLE = 1,   // a disc facing the camera: only the surface being looked at
};

// Paint a brush patch anchored at facet `facet` around world hit point (hx,hy,hz), camera at
// (cx,cy,cz), radius mm, in the given state (STATE_ENFORCER / STATE_BLOCKER / an extruder 3..16).
// STATE_NONE is a legal state HERE and only here: it is the eraser, writing NONE over the brushed facets so they
// return to the default extruder — the same thing upstream's shift+drag does (GLGizmoPainterBase.cpp ~732-748).
// The embind layer does NOT let a state argument carry NONE (bindings.cpp): erasing has its own entry point there,
// because embind coerces a JS `false` to the int 0 == NONE and a boolean must never be able to erase.
void paint(int facet, float hx, float hy, float hz, float cx, float cy, float cz, float radius, int state, int cursor);
int  painted_count(int state);       // number of painted facets of that state (UI feedback)

// The two fill tools, upstream's Smart fill and Bucket fill (GLGizmoPainterBase.cpp ~845-865). Both are one click
// rather than a drag, so neither takes a radius or a camera: what they select comes from the mesh's own topology.
//  · seed_fill  — flood outward from the hit facet while the angle between neighbouring facets stays under
//    `angle_deg`, i.e. paint the smooth feature the user clicked. This is the one a radius brush cannot do:
//    covering a whole curved face by dragging leaves gaps and spills over the edges.
//  · bucket_fill — flood across facets that share the hit facet's CURRENT state, stopping where the state changes
//    or the edge is sharper than `angle_deg`. With `propagate` false it marks only the facet under the cursor,
//    which is exactly upstream's "Triangles" (POINTER) cursor — the same call with propagation off.
// STATE_NONE is accepted by both, on the same reasoning as paint(): it is the eraser.
void seed_fill(int facet, float hx, float hy, float hz, float angle_deg, int state);
void bucket_fill(int facet, float hx, float hy, float hz, float angle_deg, bool propagate, int state);

// Overlay triangles for the painted state: flat x,y,z per vertex, 3 vertices per triangle (three.js render).
std::vector<float> overlay(int state);

// Project the painted facets of one state to per-layer polygons (mm rings) at the given slice-z's,
// via slice_mesh_slabs — the grid/tree_lite kernel path consumes these. one entry per z.
std::vector<std::vector<std::vector<std::pair<double,double>>>>
project_layers(const std::vector<double>& slice_zs_mm, int state);


// Rings in mm: [layer][ring][point] — the shape project_layers above already returns. A hole is a ring wound the
// other way, which is what clipper reads a hole as.
using LayerRings = std::vector<std::vector<std::vector<std::pair<double,double>>>>;

// Exact per-layer multi-material segmentation: upstream's MultiMaterialSegmentation.cpp, which partitions the LAYER
// CONTOUR against the painted facets rather than approximating the volume behind them. That is the whole difference
// in the result — a patch keeps its own outline instead of becoming the band of layers it spans.
//  `layer_rings` is the caller's own sliced contour, one entry per z in `slice_zs_mm`, handed over as it came out of
//  the slicer. The run is cached because it costs one Voronoi diagram per layer, which must not be paid again per
//  extruder; segment_regions() then reads one extruder's share out of it.
//  Returns false when there is nothing to segment (no paint, no layers, no selector) — the caller keeps its own path.
bool segment_prepare(const std::vector<double>& slice_zs_mm, const LayerRings& layer_rings,
                     int extruder_count, int top_shell_layers, int bottom_shell_layers,
                     double layer_height, double outer_wall_line_width, double segmented_region_max_width);
// The area extruder `state` owns on every layer (state s == Extruder s == tool s-1), from the cached run above.
LayerRings segment_regions(int state);
void segment_clear();

} // namespace selector_bridge
