// bindings.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  The embind block plus the small wrappers it binds (heap/config probes + the stage-20 painting selector wiring).
#include "arachne_bridge.h"
#include "config_bridge.h"
#include "emit.h"
#include "selector_bridge.h"
#include "slice_api.h"
#include "stl_parse.h"
#include "stream_sink.h"
#include "treesupport_bridge.h"

#include <emscripten/bind.h>
#include <emscripten/heap.h>
#include <emscripten/val.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <vector>

// Stage 12: exposes and proves that the real config subsystem is linked into the main module (prevents dead-stripping + used by the node checks).
static double heap_size() { return (double)emscripten_get_heap_size(); }   // stage 30: current WASM heap size in bytes (= the peak)
static int config_option_count() { return config_bridge::option_count(); }
static std::string config_option_default(const std::string& key) { return config_bridge::option_default(key); }

// ---- Stage 20: kernel wiring for manual support painting (TriangleSelector) ----
// The selector is built from a welded mesh under the same transform as slice() (XY bbox centered, minZ=0) -> facet indices and
// coordinates match the slices. The viewer calls selector_prepare(stl) once on load -> selector_paint per drag -> slice().
static bool selector_prepare_impl(em::val stl, bool keep_paint) {
  std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl);
  std::vector<Tri> tris = parse_stl(bytes);
  if (tris.empty()) { selector_bridge::construct({}, {}); return false; }
  double minx=1e18,miny=1e18,minz=1e18,maxx=-1e18,maxy=-1e18,maxz=-1e18;
  for (auto& t:tris) for (int k=0;k<3;++k){
    minx=std::min(minx,(double)t.v[k].x);maxx=std::max(maxx,(double)t.v[k].x);
    miny=std::min(miny,(double)t.v[k].y);maxy=std::max(maxy,(double)t.v[k].y);
    minz=std::min(minz,(double)t.v[k].z);maxz=std::max(maxz,(double)t.v[k].z); }
  // Stage 28 P2: matches the slicing default (auto_center=false) — no XY realignment, only Z seating (trusting the viewer coordinates).
  // weld: dedup vertices (quantized, EXACT tuple key — an XOR hash collides and destroys topology)
  //  preserving triangle order → facet i == parse order i (viewer raycast face index match).
  std::vector<float> verts; std::vector<int> idx; std::map<std::array<long long,3>,int> vmap;
  auto add=[&](double x,double y,double z)->int{
    std::array<long long,3> k{ (long long)std::llround(x*1e4), (long long)std::llround(y*1e4), (long long)std::llround(z*1e4) };
    auto it=vmap.find(k); if(it!=vmap.end()) return it->second;
    int id=(int)(verts.size()/3); verts.push_back((float)x);verts.push_back((float)y);verts.push_back((float)z); vmap[k]=id; return id; };
  for (auto& t:tris) for (int k=0;k<3;++k)
    idx.push_back(add(t.v[k].x, t.v[k].y, t.v[k].z-minz));   // stage 28: XY as-is (viewer coordinates), Z seated
  if (keep_paint) return selector_bridge::reconstruct_keeping_paint(verts, idx);
  selector_bridge::construct(verts, idx);
  return false;
}
static void selector_prepare(em::val stl) { selector_prepare_impl(stl, false); }
// The same registration, except the marks survive it — for the case where the model did not change, only where it is.
static bool selector_reprepare(em::val stl) { return selector_prepare_impl(stl, true); }
// The bridge is addressed by EnforcerBlockerType state (1..16) now that MMU extruders can be painted too, but the
// existing JS API is boolean (enforcer=true / blocker=false). embind coerces a JS boolean to an int as 1/0, so
// keeping the bool wrappers is what makes the old calls mean the same thing — false must stay BLOCKER (2), not
// NONE (0). The *_state twins below are the way to reach Extruder3..16.
static int selector_state_of(bool enforcer) {
  return enforcer ? selector_bridge::STATE_ENFORCER : selector_bridge::STATE_BLOCKER;
}
static void selector_paint_shape(int facet, float hx,float hy,float hz, float cx,float cy,float cz, float radius, int state, int cursor) {
  // The bridge accepts STATE_NONE (it is the eraser), but this entry point deliberately does not pass it through:
  // a JS `false` arrives here as the int 0, so a boolean that leaked into the state argument would ERASE the brushed
  // facets instead of doing nothing. Erasing goes through selector_erase below, whose signature has no state at all.
  if (state == selector_bridge::STATE_NONE) return;
  selector_bridge::paint(facet, hx,hy,hz, cx,cy,cz, radius, state, cursor);
}
static void selector_paint_state(int facet, float hx,float hy,float hz, float cx,float cy,float cz, float radius, int state) {
  selector_paint_shape(facet, hx,hy,hz, cx,cy,cz, radius, state, selector_bridge::CURSOR_SPHERE);
}
// Erase = paint STATE_NONE, returning the brushed facets to the default extruder (upstream's shift+drag eraser).
// It is a separate function rather than "paint with state 0" precisely because of the coercion above: with no state
// parameter there is nothing for a stray boolean to turn into NONE, so the erase can only be reached on purpose.
static void selector_erase(int facet, float hx,float hy,float hz, float cx,float cy,float cz, float radius) {
  selector_bridge::paint(facet, hx,hy,hz, cx,cy,cz, radius, selector_bridge::STATE_NONE, selector_bridge::CURSOR_SPHERE);
}
static void selector_paint(int facet, float hx,float hy,float hz, float cx,float cy,float cz, float radius, bool enforcer) {
  selector_paint_state(facet, hx,hy,hz, cx,cy,cz, radius, selector_state_of(enforcer));
}
// The fill tools. Same NONE rule as the brush: the painting entry point refuses state 0 and each has its own erase
// twin with no state argument, so the eraser keeps working with every tool instead of silently doing nothing.
static void selector_seed_fill(int facet, float hx,float hy,float hz, float angle_deg, int state) {
  if (state == selector_bridge::STATE_NONE) return;
  selector_bridge::seed_fill(facet, hx,hy,hz, angle_deg, state);
}
static void selector_seed_fill_erase(int facet, float hx,float hy,float hz, float angle_deg) {
  selector_bridge::seed_fill(facet, hx,hy,hz, angle_deg, selector_bridge::STATE_NONE);
}
static void selector_bucket_fill(int facet, float hx,float hy,float hz, float angle_deg, bool propagate, int state) {
  if (state == selector_bridge::STATE_NONE) return;
  selector_bridge::bucket_fill(facet, hx,hy,hz, angle_deg, propagate, state);
}
static void selector_bucket_fill_erase(int facet, float hx,float hy,float hz, float angle_deg, bool propagate) {
  selector_bridge::bucket_fill(facet, hx,hy,hz, angle_deg, propagate, selector_bridge::STATE_NONE);
}
static void selector_clear() { selector_bridge::clear(); }
static int  selector_facet_count() { return selector_bridge::facet_count(); }
static int  selector_painted_count_state(int state) { return selector_bridge::painted_count(state); }
static int  selector_painted_count(bool enforcer) { return selector_painted_count_state(selector_state_of(enforcer)); }
static em::val selector_overlay_state(int state) { return to_f32(selector_bridge::overlay(state)); }
static em::val selector_overlay(bool enforcer) { return selector_overlay_state(selector_state_of(enforcer)); }
static em::val selector_project_counts_state(em::val zsVal, int state) {   // debug: #polys per z
  std::vector<double> zs = em::convertJSArrayToNumberVector<double>(zsVal);
  auto pl = selector_bridge::project_layers(zs, state);
  std::vector<float> counts; counts.reserve(pl.size());
  for (auto& layer : pl) counts.push_back((float)layer.size());
  return to_f32(counts);
}
static em::val selector_project_counts(em::val zsVal, bool enforcer) {
  return selector_project_counts_state(zsVal, selector_state_of(enforcer));
}

EMSCRIPTEN_BINDINGS(slicer) {
  em::function("slice", &slice);
  em::function("set_layer_sink", &set_layer_sink);           // stage 30: register cb(z,idx,gcodeChunk,pathsF32,widthsF32) -> streaming
  em::function("clear_layer_sink", &clear_layer_sink);       //  unregister it (the next slice runs in batch mode)
  em::function("heap_size", &heap_size);                     // stage 30: for measuring the WASM heap peak (bytes)
  em::function("sup_progress_ptr", +[]() -> double {         // heap address of the real support progress counter (u32) — for SAB polling under mt
    return (double)treesupport_bridge::progress_addr(); });
  em::function("sup_progress_view", +[]() -> em::val {       // a Uint32Array view of the same counter — .buffer yields the SAB
    return em::val(em::typed_memory_view((size_t)1, (const unsigned int*)(uintptr_t)treesupport_bridge::progress_addr())); });
  em::function("cancel_flag_view", +[]() -> em::val {        // G002: a view of the cancel flag (u32) — the UI writes it directly via SAB
    return em::val(em::typed_memory_view((size_t)1, (const unsigned int*)(uintptr_t)treesupport_bridge::cancel_addr())); });
  em::function("config_option_count", &config_option_count);
  em::function("config_option_default", &config_option_default);
  em::function("cgal_planar_check_count", &arachne_bridge::cgal_planar_check_count); // stage 14: number of real CGAL planarity check calls
  em::function("selector_prepare", &selector_prepare);       // stage 20: register the mesh on load
  em::function("selector_reprepare", &selector_reprepare);   // re-register after a transform, keeping the paint
  em::function("selector_paint", &selector_paint);           //  paint with the sphere cursor on every drag
  em::function("selector_clear", &selector_clear);
  em::function("selector_facet_count", &selector_facet_count);
  em::function("selector_painted_count", &selector_painted_count);
  em::function("selector_overlay", &selector_overlay);       //  overlay triangles (enforcer=blue / blocker=red)
  em::function("selector_project_counts", &selector_project_counts); // debug: number of projected polygons per z
  // State-addressed twins: 1=ENFORCER(Extruder1), 2=BLOCKER(Extruder2), 3..16=Extruder3..16 — MMU painting.
  em::function("selector_paint_state", &selector_paint_state);
  em::function("selector_erase", &selector_erase);            //  the eraser: writes NONE, no state argument to coerce
  em::function("selector_painted_count_state", &selector_painted_count_state);
  em::function("selector_overlay_state", &selector_overlay_state);
  em::function("selector_project_counts_state", &selector_project_counts_state);
  // The other painting tools upstream offers next to the radius brush (GLGizmoMmuSegmentation's tool_type).
  em::function("selector_paint_shape", &selector_paint_shape);         //  brush with a chosen cursor (0=sphere, 1=circle)
  em::function("selector_seed_fill", &selector_seed_fill);             //  "smart fill": flood the smooth feature under the click
  em::function("selector_seed_fill_erase", &selector_seed_fill_erase);
  em::function("selector_bucket_fill", &selector_bucket_fill);         //  "bucket fill" / with propagate=false, "triangles"
  em::function("selector_bucket_fill_erase", &selector_bucket_fill_erase);
}
