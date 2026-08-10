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
static void selector_prepare(em::val stl) {
  std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl);
  std::vector<Tri> tris = parse_stl(bytes);
  if (tris.empty()) { selector_bridge::construct({}, {}); return; }
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
  selector_bridge::construct(verts, idx);
}
static void selector_paint(int facet, float hx,float hy,float hz, float cx,float cy,float cz, float radius, bool enforcer) {
  selector_bridge::paint(facet, hx,hy,hz, cx,cy,cz, radius, enforcer);
}
static void selector_clear() { selector_bridge::clear(); }
static int  selector_facet_count() { return selector_bridge::facet_count(); }
static int  selector_painted_count(bool enforcer) { return selector_bridge::painted_count(enforcer); }
static em::val selector_overlay(bool enforcer) { return to_f32(selector_bridge::overlay(enforcer)); }
static em::val selector_project_counts(em::val zsVal, bool enforcer) {   // debug: #polys per z
  std::vector<double> zs = em::convertJSArrayToNumberVector<double>(zsVal);
  auto pl = selector_bridge::project_layers(zs, enforcer);
  std::vector<float> counts; counts.reserve(pl.size());
  for (auto& layer : pl) counts.push_back((float)layer.size());
  return to_f32(counts);
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
  em::function("selector_paint", &selector_paint);           //  paint with the sphere cursor on every drag
  em::function("selector_clear", &selector_clear);
  em::function("selector_facet_count", &selector_facet_count);
  em::function("selector_painted_count", &selector_painted_count);
  em::function("selector_overlay", &selector_overlay);       //  overlay triangles (enforcer=blue / blocker=red)
  em::function("selector_project_counts", &selector_project_counts); // debug: number of projected polygons per z
}
