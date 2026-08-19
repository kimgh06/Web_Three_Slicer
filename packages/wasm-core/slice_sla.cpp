// =============================================================================
// slice_sla.cpp — the SLA (resin) slicing entry point.
//
//  A resin slice is per-layer solid cross-sections, not toolpaths: no walls, no infill, no G-code. What it
//  reuses from the FFF kernel is exactly the machinery that is technology-neutral — parse_stl, prepare_model
//  (centre/seat/over-bed), tri_plane + chain_polys (facet-major, like pass1), Clipper, and the layer-sink
//  streaming protocol — so the worker drives it with the same 'progress'/'layer'/'done' messages a kernel
//  slice produces, and the viewer preview consumes the stream unmodified.
//
//  SUPPORTS are upstream end to end: the ported SupportPointGenerator/SupportIslands sampler produces the
//  contact points (slasupport_bridge::generate_support_points), and the ported PrusaSlicer DefaultSupportTree
//  (slasupport_port/ — pinhead pose search, classify, ground routing, cross-bracing, pillar feet, raycast
//  against the actual mesh via libigl) turns them into the tree. The bridge returns the merged support tree
//  as a triangle MESH; its raster view is produced by slicing that mesh with the same sweep the model goes
//  through, so the preview solid and the SL1 masks cannot disagree.
//  The PAD is the ported Pad.cpp (blueprint over the foot band -> walls/brim/wings), standing on the plate
//  with everything above lifted by its height; pad_around_object stays a typed unsupported error.
//  All support/pad regions stay DISJOINT from the model contour (Clipper diff) because the SL1 rasterizer
//  fills even-odd — an overlap would punch a hole.
// =============================================================================
#include "clip_util.h"
#include "params.h"
#include "slasupport_bridge.h"
#include "slice_api.h"
#include "slice_ctx.h"
#include "slice_planes.h"
#include "stl_parse.h"
#include "stream_sink.h"
#include "treesupport_bridge.h"
#include "emit.h"                 // to_f32

#include <emscripten/val.h>
#include <emscripten/emscripten.h>   // emscripten_get_now — phase timing (stats only)
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace em = emscripten;
using namespace ClipperLib;

// ---- Local flat-JSON readers ---------------------------------------------------------------------------------
//  NOT params.cpp's readers on purpose: the kernel parameter reference is GENERATED from the j*(j,"…") call
//  sites in params.cpp, and every row must be classified. The SLA keys live in their own derive
//  (deriveSlaParams) and their own entry point — adding them to params.cpp would put unclassified rows into the
//  FFF table. The quote-prefixed search cannot suffix-collide (initial_layer_height never matches layer_height).
static double sla_jd(const std::string& j, const char* key, double dflt) {
  std::string pat = std::string("\"") + key + "\":";
  size_t p = j.find(pat);
  if (p == std::string::npos) return dflt;
  const char* s = j.c_str() + p + pat.size();
  char* end = nullptr;
  double v = std::strtod(s, &end);
  return end == s ? dflt : v;
}
static bool sla_jb(const std::string& j, const char* key, bool dflt) {
  std::string pat = std::string("\"") + key + "\":";
  size_t p = j.find(pat);
  if (p == std::string::npos) return dflt;
  const char* s = j.c_str() + p + pat.size();
  if (!std::strncmp(s, "true", 4))  return true;
  if (!std::strncmp(s, "false", 5)) return false;
  return *s == '1' ? true : *s == '0' ? false : dflt;
}
static std::string sla_jstr(const std::string& j, const char* key, const char* dflt) {
  std::string pat = std::string("\"") + key + "\":\"";
  size_t p = j.find(pat);
  if (p == std::string::npos) return dflt;
  size_t s = p + pat.size(), e = j.find('"', s);
  return e == std::string::npos ? dflt : j.substr(s, e - s);
}

// Toolpath stream encoding — the same stride-8 contract emit.cpp's push_seg writes, tool fixed at 0.
static inline void sla_push_seg(std::vector<float>& v, std::vector<float>& wd,
                                double x0, double y0, double x1, double y1, double z, float role) {
  v.push_back((float)x0); v.push_back((float)y0); v.push_back((float)z); v.push_back(role);
  v.push_back((float)x1); v.push_back((float)y1); v.push_back((float)z); v.push_back(role);
  wd.push_back(0.2f);
}
static void push_paths(std::vector<float>& v, std::vector<float>& wd, const Paths& ps, double z, float role) {
  for (const Path& q : ps) {
    if (q.size() < 3) continue;
    for (size_t k = 0; k < q.size(); ++k) {
      const IntPoint& a = q[k]; const IntPoint& b = q[(k + 1) % q.size()];
      sla_push_seg(v, wd, a.x() * INV, a.y() * INV, b.x() * INV, b.y() * INV, z, role);
    }
  }
}

static double paths_area_mm2(const Paths& ps) {   // even-odd net area: holes carry negative signed area
  double a = 0;
  for (const Path& q : ps) a += Area(q);
  return std::abs(a) * INV * INV;
}
// Even-odd point test over a whole region (outers and holes together).
static bool point_in_region(const IntPoint& pt, const Paths& ps) {
  int cnt = 0;
  for (const Path& q : ps) if (PointInPolygon(pt, q)) ++cnt;
  return (cnt & 1) != 0;
}
static inline IntPoint ip(double x, double y) {
  return IntPoint((cInt)std::llround(x * SCALE), (cInt)std::llround(y * SCALE));
}

em::val slice_sla(em::val stl_bytes, std::string params_json, em::val onProgress) {
  auto report = [&](int done, int total){ if (!onProgress.isUndefined() && !onProgress.isNull()) onProgress(done, total); };
  em::val result = em::val::object();

  // Capability gate: hollowing changes the printed geometry itself (inner walls, drain holes), so a request
  //  for it cannot be answered with a solid slice — that output would be mislabeled hollowed. Typed error,
  //  same code the JS request layer uses; the OpenVDB/MeshBoolean chain it needs is not ported.
  if (sla_jb(params_json, "hollowing_enable", false)) {
    result.set("error", std::string("SLA_UNSUPPORTED_HOLLOWING: hollowing is not available in this kernel"));
    return result;
  }

  // Shared keys go through the normal parser (layer_height, bed dims — deriveSlaParams maps the display onto
  //  bed_width/bed_depth); SLA-only keys are read locally, see the note above.
  Params p = parse_params(params_json);
  const double lh  = p.layer_height > 1e-4 ? p.layer_height : 0.05;
  const double ilh0 = sla_jd(params_json, "initial_layer_height", lh);
  const double ilh = ilh0 > 1e-4 ? ilh0 : lh;

  // G002-style cancel: same flag the FFF slice polls, reset on entry.
  auto* cxp = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::cancel_addr();
  cxp->store(0);
  auto CX = [cxp]{ return cxp->load(std::memory_order_relaxed) != 0; };

  std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl_bytes);
  std::vector<Tri> tris = parse_stl(bytes);
  if (tris.empty()) { result.set("error", std::string("STL parse failed or 0 triangles")); return result; }

  ModelPrep MP = prepare_model(tris, p, /*reuseGeom=*/false);
  const double height = MP.height;
  if (!(height > 1e-4)) { result.set("error", std::string("model has no height to slice")); return result; }

  const int N = height <= ilh ? 1 : 1 + (int)std::ceil((height - ilh) / lh);
  double tw0 = emscripten_get_now(), tw_contours = 0, tw_sample = 0, tw_tree = 0, tw_raster = 0;

  // ---- Model contours: facet-major plane sweep at each layer's MID height (volume-faithful), chained +
  //      cleaned the way pass1 does it. Mid planes are ascending, so the lower_bound walk matches pass1's.
  std::vector<double> mids(N);
  for (int i = 0; i < N; ++i) {
    const double th = i == 0 ? ilh : lh;
    mids[i] = (i == 0 ? ilh : ilh + i * lh) - th / 2;
  }
  std::vector<std::vector<Seg>> layerSegs(N);
  { Seg sg;
    for (const Tri& t : tris) {
      double zmin = std::min({t.v[0].z, t.v[1].z, t.v[2].z}), zmax = std::max({t.v[0].z, t.v[1].z, t.v[2].z});
      for (auto it = std::lower_bound(mids.begin(), mids.end(), zmin); it != mids.end() && *it < zmax; ++it)
        if (tri_plane(t, *it, sg)) layerSegs[(size_t)(it - mids.begin())].push_back(sg);
    }
  }
  // The generator no longer eats these contours — the bridge slices the mesh itself through the real
  // slicer (slice_mesh_ex + slice_closing_radius, upstream's own pipeline); this set is display/raster only.
  const double closing_r = std::max(0.0, sla_jd(params_json, "slice_closing_radius", 0.049));
  std::vector<Paths> contours(N);
  for (int i = 0; i < N; ++i) {
    if (CX()) { result.set("error", std::string("canceled")); return result; }
    if ((i & 63) == 0) report(i * 300 / std::max(1, N), 1000);   // contours: 0 -> 30%
    Paths loops = chain_polys(layerSegs[i]);
    contours[i] = SimplifyPolygons(loops, pftEvenOdd);
    if (p.gcode_resolution > 1e-6) CleanPolygons(contours[i], SCALE * p.gcode_resolution);
    contours[i].erase(std::remove_if(contours[i].begin(), contours[i].end(),
                                     [](const Path& q){ return q.size() < 3; }), contours[i].end());
    layerSegs[i].clear(); layerSegs[i].shrink_to_fit();
  }

  tw_contours = emscripten_get_now();
  // ---- Support parameters (upstream SupportTreeConfig names where one exists) --------------------------------
  const bool supports_on = sla_jb(params_json, "supports_enable", false);
  const bool pad_on      = sla_jb(params_json, "pad_enable", false);
  const bool plate_only  = sla_jb(params_json, "support_buildplate_only", false);
  const double pillar_r  = std::max(0.1, sla_jd(params_json, "support_pillar_diameter", 1.0) / 2);
  const double tip_r     = std::max(0.05, sla_jd(params_json, "support_head_front_diameter", 0.4) / 2);
  const double head_len  = std::max(lh, sla_jd(params_json, "support_head_width", 1.0));
  const double head_pen  = std::max(0.0, sla_jd(params_json, "support_head_penetration", 0.2));
  const double density   = sla_jd(params_json, "support_points_density_relative", 100.0);
  const double bridge_len= std::max(1.0, sla_jd(params_json, "support_max_bridge_length", 15.0));
  const double link_dist = std::max(1.0, sla_jd(params_json, "support_max_pillar_link_distance", 10.0));
  const double base_r    = std::max(pillar_r, sla_jd(params_json, "support_base_diameter", 4.0) / 2);
  const double base_h    = std::max(0.0, sla_jd(params_json, "support_base_height", 1.0));
  // The rest of upstream make_support_cfg (SLAPrint.cpp:50): the bridge slope IS the critical angle.
  const double crit_deg  = sla_jd(params_json, "support_critical_angle", 45.0);
  const double small_pillar_pct = sla_jd(params_json, "support_small_pillar_diameter_percent", 50.0);
  const double widening  = std::max(0.0, sla_jd(params_json, "support_pillar_widening_factor", 0.0));
  const double base_safety = std::max(0.0, sla_jd(params_json, "support_base_safety_distance", 1.0));
  const double max_weight = sla_jd(params_json, "support_max_weight_on_model", 10.0);
  const int max_bridges  = (int)sla_jd(params_json, "support_max_bridges_on_pillar", 3.0);
  const double elev_mm   = std::max(0.0, sla_jd(params_json, "support_object_elevation", 0.0));
  const std::string conn = sla_jstr(params_json, "support_pillar_connection_mode", "dynamic");
  const std::string support_strategy = sla_jstr(params_json, "support_tree_type", "default");
  const slasupport_bridge::SupportStrategy bridge_strategy =
    support_strategy == "branching" ? slasupport_bridge::SupportStrategy::branching
    : support_strategy == "organic" ? slasupport_bridge::SupportStrategy::organic
                                     : slasupport_bridge::SupportStrategy::default_tree;
  const slasupport_bridge::StrategyCapability strategy_capability =
    slasupport_bridge::strategy_capability(bridge_strategy);
  const slasupport_bridge::PadCapability pad_capability = slasupport_bridge::pad_capability();

  // Pad (upstream PadConfig, make_pad_cfg SLAPrint.cpp:135): the pad occupies [0, full_height] on the plate
  //  and everything else — support feet included — stands on TOP of it, exactly upstream's rebase at slicing
  //  time. pad_around_object stays a typed unsupported error (see the bridge header).
  const double pad_wall_t   = std::max(0.0, sla_jd(params_json, "pad_wall_thickness", 2.0));
  const double pad_wall_h   = std::max(0.0, sla_jd(params_json, "pad_wall_height", 0.0));
  const double pad_slope    = sla_jd(params_json, "pad_wall_slope", 90.0);
  const double pad_merge    = sla_jd(params_json, "pad_max_merge_distance", 50.0);
  const double pad_brim     = sla_jd(params_json, "pad_brim_size", 1.6);
  const bool   pad_embed    = sla_jb(params_json, "pad_around_object", false);
  const double pad_full_h   = pad_on ? pad_wall_t + pad_wall_h : 0.0;
  const int n_pad = pad_on && !pad_embed ? std::max(1, (int)std::ceil(pad_full_h / lh)) : 0;

  // Elevation: with supports on, the object hangs above the plate — the layer stack grows by the elevation
  //  zone below it and every model contour shifts up. The model's own bottom then reads as one large island,
  //  which is exactly what routes pillars under it (upstream elevates for the same removability reason).
  //  The pad adds its own zone UNDER that: lift = pad layers + elevation layers.
  const int n_elev = supports_on ? (int)std::llround(elev_mm / lh) : 0;
  const int n_lift = n_pad + n_elev;
  const int NN = N + n_lift;
  static const Paths EMPTY_PATHS;
  auto contour_at = [&](int g) -> const Paths& {
    return (g >= n_lift && g - n_lift < N) ? contours[g - n_lift] : EMPTY_PATHS;
  };
  auto top_z = [&](int g) { return g == 0 ? ilh : ilh + g * lh; };

  // ---- 1. Support points: the ported Prusa SupportPointGenerator + SupportIslands (slasupport_bridge).
  //  The prepared layers carry model-space slice_z (elevation zone stripped); the generator returns
  //  object-local, surface-snapped points in that same frame — exactly what the tree call below feeds on.
  slasupport_bridge::PreparedJob prepared;
  std::string support_error = supports_on && strategy_capability.status != slasupport_bridge::StrategyCapabilityStatus::supported
    ? strategy_capability.code : "";
  std::string generator_backend = "disabled";
  prepared.callbacks.is_canceled = [&]() { return CX(); };
  prepared.callbacks.on_progress = [&](const slasupport_bridge::Progress& progress) {
    if (progress.total == 0) return;
    if (progress.phase == slasupport_bridge::ProgressPhase::prepare)           // generation: 30% -> 32%
      report(300 + (int)(progress.completed * 20 / progress.total), 1000);
    else if (progress.phase == slasupport_bridge::ProgressPhase::support_tree) // tree: 32% -> 67%
      report(320 + (int)(progress.completed * 350 / progress.total), 1000);
  };
  if (supports_on && strategy_capability.status == slasupport_bridge::StrategyCapabilityStatus::supported && NN > 0) {
    std::vector<float> model_soup; model_soup.reserve(tris.size() * 9);
    for (const Tri& t : tris) for (int v = 0; v < 3; ++v) {
      model_soup.push_back(t.v[v].x); model_soup.push_back(t.v[v].y); model_soup.push_back(t.v[v].z);
    }
    prepared.support_enforcers_only = sla_jb(params_json, "support_enforcers_only", false);
    prepared.objects.push_back({"legacy-0", std::move(model_soup), {}});
    prepared.layers.reserve(NN);
    for (int g = 0; g < NN; ++g) {
      slasupport_bridge::PreparedLayer layer;
      layer.object_id = "legacy-0";
      layer.index = (size_t)g;
      layer.print_z = top_z(g);
      layer.height = g == 0 ? ilh : lh;
      layer.slice_z = layer.print_z - layer.height / 2 - n_lift * lh;
      for (const Path& path : contour_at(g)) {
        slasupport_bridge::Polygon polygon;
        polygon.reserve(path.size());
        for (const IntPoint& point : path) polygon.push_back({point.x() * INV, point.y() * INV});
        layer.contours.push_back(std::move(polygon));
      }
      prepared.layers.push_back(std::move(layer));
    }
    slasupport_bridge::PointGenConfig generator_config;
    generator_config.density_relative = density / 100.0;   // upstream SLAPrintSteps.cpp:717 (percents -> ratio)
    generator_config.head_diameter = tip_r * 2;
    generator_config.slice_closing_radius = closing_r;
    generator_backend = "prusa_port";
    slasupport_bridge::GeneratedPoints generated =
      slasupport_bridge::generate_support_points(prepared, generator_config);
    if (generated.ok) prepared.points = std::move(generated.points);
    else if (support_error.empty())
      support_error = generated.error.empty() ? "support point generation failed" : generated.error;
  }
  if (CX()) { result.set("error", std::string("canceled")); return result; }

  tw_sample = emscripten_get_now();
  // ---- 2. The real tree (ported DefaultSupportTree via slasupport_bridge): pinhead pose search, classify,
  //         ground routing, cross-bracing, feet — upstream verbatim, raycast against the actual mesh. The
  //         bridge returns the merged support tree as a MESH in GLOBAL z (elevation applied by the config,
  //         upstream semantics).
  std::vector<float> smesh, pmesh;
  size_t pillar_count = 0;
  if (!prepared.points.empty()) {
    slasupport_bridge::Config bc;
    bc.strategy = bridge_strategy;
    bc.head_front_radius = tip_r;      bc.head_back_radius = pillar_r;
    bc.head_width = head_len;          bc.head_penetration = head_pen;
    bc.base_radius = base_r;           bc.base_height = base_h;
    bc.max_bridge_length = bridge_len; bc.max_pillar_link_distance = link_dist;
    bc.object_elevation = n_elev * lh; bc.buildplate_only = plate_only;
    bc.pillar_connection_mode = conn == "zigzag" ? 0 : conn == "cross" ? 1 : 2;
    bc.bridge_slope = crit_deg * PI / 180.0;
    bc.head_fallback_radius = 0.01 * small_pillar_pct * pillar_r;
    bc.pillar_widening_factor = widening;
    bc.pillar_base_safety_distance = base_safety;
    bc.max_weight_on_model = max_weight;
    bc.max_bridges_on_pillar = max_bridges;
    bc.mesh_steps = 45;   // upstream's output-mesh resolution (SupportTreeBuilder::merged_mesh default)
    report(320, 1000);                                            // sampling done -> entering the tree
    slasupport_bridge::Result R = slasupport_bridge::generate(prepared, bc);
    if (R.ok) { smesh = std::move(R.mesh); pillar_count = R.pillars; }
    else support_error = R.error.empty() ? "support tree produced nothing" : R.error;
  }
  if (CX()) { result.set("error", std::string("canceled")); return result; }

  // ---- 2b. Pad (ported Pad.cpp, upstream SupportTree.cpp:71 driver): blueprint over the foot band while
  //          the feet still stand at z=0, then the pad takes [0, full_height] and the scene above it rises
  //          by n_pad layers — upstream's rebase at slicing time. With supports off the model itself is the
  //          blueprint.
  std::string pad_error;
  if (pad_on && NN > 0) {
    slasupport_bridge::PadParams pad_params;
    pad_params.wall_thickness = pad_wall_t;    pad_params.wall_height = pad_wall_h;
    pad_params.max_merge_distance = pad_merge; pad_params.wall_slope_deg = pad_slope;
    pad_params.brim_size = pad_brim;           pad_params.around_object = pad_embed;
    std::vector<float> pad_model_soup;
    if (!supports_on) {
      pad_model_soup.reserve(tris.size() * 9);
      for (const Tri& t : tris) for (int v = 0; v < 3; ++v) {
        pad_model_soup.push_back(t.v[v].x); pad_model_soup.push_back(t.v[v].y); pad_model_soup.push_back(t.v[v].z);
      }
    }
    slasupport_bridge::PadResult P =
      slasupport_bridge::generate_pad(pad_model_soup, smesh, supports_on, pad_params);
    if (P.ok) pmesh = std::move(P.mesh);
    else if (pad_embed) pad_error = P.error;   // capability gate: soft, and n_pad==0 so nothing floats
    else {
      // Upstream semantics (SLAPrintSteps::generate_pad -> SlicingError): a requested pad that cannot be
      // generated FAILS the slice. Degrading softly here would leave the scene lifted by the pad zone with
      // nothing underneath — a print floating pad-height above the plate.
      result.set("error", std::string("pad: ") + (P.error.empty() ? "generation failed" : P.error));
      return result;
    }
  }
  // Everything above the pad rises by the pad zone; the tree stands on the pad top as one piece.
  if (n_pad > 0)
    for (size_t i = 2; i < smesh.size(); i += 3) smesh[i] += float(n_pad * lh);
  tw_tree = emscripten_get_now();

  // ---- 3. Raster view of the tree: slice the support mesh per layer (mid planes, exactly like the model),
  //         kept disjoint from the model contour — the even-odd raster safety every region here observes.
  std::vector<Paths> support(NN);
  slasupport_bridge::SupportSliceCacheStats support_slice_cache;
  std::string support_slicer_error;
  if (!smesh.empty()) {
    std::vector<double> gmids(NN);
    for (int g = 0; g < NN; ++g) gmids[g] = top_z(g) - (g == 0 ? ilh : lh) / 2;
    slasupport_bridge::SupportSliceBatch sliced =
      slasupport_bridge::slice_support_mesh_fallback(smesh, gmids);
    support_slice_cache = sliced.cache;
    support_slicer_error = sliced.error;
    if (sliced.ok) {
      for (int g = 0; g < NN; ++g) {
        if ((g & 63) == 0) report(670 + g * 230 / std::max(1, NN), 1000);
        Paths loops;
        loops.reserve(sliced.slices[g].size());
        for (const slasupport_bridge::Polygon& polygon : sliced.slices[g]) {
          Path loop;
          loop.reserve(polygon.size());
          for (const slasupport_bridge::Vec2& point : polygon) loop.push_back(ip(point.x, point.y));
          loops.push_back(std::move(loop));
        }
        Paths merged = SimplifyPolygons(loops, pftNonZero);
        CleanPolygons(merged, SCALE * 0.005);
        merged.erase(std::remove_if(merged.begin(), merged.end(),
                                    [](const Path& q){ return q.size() < 3; }), merged.end());
        support[g] = clip_paths(merged, contour_at(g), ctDifference);
      }
    }
  }

  tw_raster = emscripten_get_now();
  // ---- Pad raster: slice the ported pad mesh per layer like the supports, disjoint from model + support ------
  std::vector<Paths> pad(NN);
  int pad_layers = 0;
  if (!pmesh.empty()) {
    std::vector<double> pad_mids(NN);
    for (int g = 0; g < NN; ++g) pad_mids[g] = top_z(g) - (g == 0 ? ilh : lh) / 2;
    slasupport_bridge::SupportSliceBatch pad_sliced =
      slasupport_bridge::slice_support_mesh_fallback(pmesh, pad_mids);
    if (pad_sliced.ok) {
      for (int g = 0; g < NN; ++g) {
        Paths loops;
        loops.reserve(pad_sliced.slices[g].size());
        for (const slasupport_bridge::Polygon& polygon : pad_sliced.slices[g]) {
          Path loop;
          loop.reserve(polygon.size());
          for (const slasupport_bridge::Vec2& point : polygon) loop.push_back(ip(point.x, point.y));
          loops.push_back(std::move(loop));
        }
        Paths merged = SimplifyPolygons(loops, pftNonZero);
        CleanPolygons(merged, SCALE * 0.005);
        merged.erase(std::remove_if(merged.begin(), merged.end(),
                                    [](const Path& q){ return q.size() < 3; }), merged.end());
        pad[g] = clip_paths(merged, union_paths(contour_at(g), support[g]), ctDifference);
        if (!pad[g].empty()) pad_layers = g + 1;
      }
    } else if (pad_error.empty()) pad_error = pad_sliced.error;
  }

  // ---- Emission: batch (layers array) or streamed through the registered sink, same as slice(). -----------------
  em::val& sink = layer_sink();
  const bool streaming = !sink.isUndefined() && !sink.isNull();
  em::val layersArr = em::val::array();
  double volume = 0; long segTotal = 0;
  for (int g = 0; g < NN; ++g) {
    if (CX()) { result.set("error", std::string("canceled")); return result; }
    const double th = g == 0 ? ilh : lh;
    const Paths& model = contour_at(g);
    volume += (paths_area_mm2(model) + paths_area_mm2(support[g]) + paths_area_mm2(pad[g])) * th;
    std::vector<float> tp, wd;
    const double z = top_z(g);
    push_paths(tp, wd, model,      z, 1.0f);   // model — role 1 (wall)
    push_paths(tp, wd, support[g], z, 5.0f);   // support — role 5
    push_paths(tp, wd, pad[g],     z, 6.0f);   // pad — role 6 (raft colouring)
    segTotal += (long)wd.size();
    if (streaming) sink(z, g, std::string(), to_f32(tp), to_f32(wd));
    else {
      em::val Lo = em::val::object();
      Lo.set("z", z); Lo.set("paths", to_f32(tp)); Lo.set("widths", to_f32(wd));
      layersArr.call<void>("push", Lo);
    }
    if ((g & 7) == 0 || g == NN - 1) report(900 + (g + 1) * 100 / std::max(1, NN), 1000);   // emission: 90% -> 100%
  }

  // ---- Stats: the resin figures + the exposure-fade time model (identical to the JS core it replaces). ----------
  const double exposure = sla_jd(params_json, "exposure_time", 7.0);
  const double exposure0 = sla_jd(params_json, "initial_exposure_time", 35.0);
  const double faded = std::max(0.0, sla_jd(params_json, "faded_layers", 10.0));
  const double overhead = std::max(0.0, sla_jd(params_json, "sla_layer_overhead", 6.0));
  double time_s = NN * overhead;
  for (int i = 0; i < NN; ++i) {
    const double blend = faded > 0 ? std::min(1.0, i / faded) : 1.0;
    time_s += exposure0 + (exposure - exposure0) * blend;
  }
  em::val stats = em::val::object();
  stats.set("sla", true);
  stats.set("streamed", streaming);
  stats.set("layers", NN);
  stats.set("path_segments", (double)segTotal);
  stats.set("filament_mm", 0.0);
  stats.set("volume_mm3", volume);
  stats.set("resin_ml", volume / 1000.0);
  stats.set("time_estimate", std::round(time_s));
  stats.set("support_points", (double)prepared.points.size());
  stats.set("support_point_generator", supports_on ? generator_backend : std::string("disabled"));
  if (supports_on)
    stats.set("support_point_parity_status", std::string("ported"));
  stats.set("support_pillars", (double)pillar_count);
  if (supports_on) {
    stats.set("support_strategy", support_strategy);
    const char* capability = strategy_capability.status == slasupport_bridge::StrategyCapabilityStatus::supported
      ? "supported"
      : strategy_capability.status == slasupport_bridge::StrategyCapabilityStatus::dependency_unavailable
        ? "dependency_unavailable" : "unsupported_upstream";
    stats.set("support_strategy_capability", std::string(capability));
    stats.set("support_strategy_code", std::string(strategy_capability.code));
  }
  if (!support_error.empty()) stats.set("support_error", support_error);   // supports failed but the slice stands
  if (!support_slicer_error.empty()) stats.set("support_slicer_error", support_slicer_error);
  if (!pad_error.empty()) stats.set("pad_error", pad_error);               // pad failed but the slice stands
  if (supports_on) {
    const slasupport_bridge::SupportSlicerCapability slicer_capability =
      slasupport_bridge::support_slicer_capability();
    stats.set("support_slicer_backend", std::string(slicer_capability.backend));
    stats.set("support_slicer_parity_status", std::string("blocked_dependency"));
    stats.set("support_slicer_code", std::string(slicer_capability.code));
    stats.set("support_slicer_cache_hits", (double)support_slice_cache.hits);
    stats.set("support_slicer_cache_misses", (double)support_slice_cache.misses);
  }
  stats.set("elevation_layers", n_elev);
  // The whole scene (model contours, support mesh) sits lift_layers above the plate: pad zone + elevation.
  // The viewer MUST lift its model overlay by this, not by elevation alone — with a pad the difference is the
  // pad's full height and the preview reads as supports piercing/floating.
  stats.set("lift_layers", n_lift);
  stats.set("pad_layers", pad_layers);
  if (pad_on) {
    const char* capability = pad_capability.status == slasupport_bridge::PadCapabilityStatus::supported
      ? "supported" : "dependency_unavailable";
    stats.set("pad_capability", std::string(capability));
    stats.set("pad_code", std::string(pad_capability.code));
    stats.set("pad_backend", std::string(pad_capability.backend));
    stats.set("pad_parity_status", std::string(
      pad_capability.status == slasupport_bridge::PadCapabilityStatus::supported
        ? "upstream" : "blocked_dependency"));
  }
  stats.set("over_bed", MP.over_bed);
  stats.set("t_contours_ms", tw_contours - tw0);
  stats.set("t_sample_ms", tw_sample - tw_contours);
  stats.set("t_tree_ms", tw_tree - tw_sample);
  stats.set("t_raster_ms", tw_raster - tw_tree);
  stats.set("t_emit_ms", emscripten_get_now() - tw_raster);
  stats.set("layer_height", lh);
  stats.set("initial_layer_height", ilh);
  result.set("stats", stats);
  // The solid meshes ride on the result in BOTH modes — they are what the preview renders (the layer stream
  //  above is the raster's view of the same geometry).
  result.set("support_mesh", to_f32(smesh));
  result.set("pad_mesh", to_f32(pmesh));
  em::val supportPoints = em::val::array();
  for (size_t i = 0; i < prepared.points.size(); ++i) {
    const slasupport_bridge::SupportPoint& sp = prepared.points[i];
    // Model-space z -> the global layer whose mid plane is nearest (the elevation zone shifts the index).
    int g = n_lift;
    if (N > 0) {
      auto it = std::lower_bound(mids.begin(), mids.end(), sp.position.z);
      int nearest = std::min((int)(it - mids.begin()), N - 1);
      if (nearest > 0 && std::abs(mids[nearest - 1] - sp.position.z) <= std::abs(mids[nearest] - sp.position.z))
        --nearest;
      g = nearest + n_lift;
    }
    em::val record = em::val::object();
    record.set("source_id", (double)sp.source_id);
    record.set("object_id", sp.object_id);
    record.set("layer", g);
    record.set("x", sp.position.x);
    record.set("y", sp.position.y);
    record.set("z", sp.position.z);
    record.set("head_front_radius", sp.head_front_radius);
    record.set("type", std::string(
      sp.type == slasupport_bridge::PointType::island ? "island"
      : sp.type == slasupport_bridge::PointType::slope ? "slope" : "manual"));
    supportPoints.call<void>("push", record);
  }
  result.set("support_points", supportPoints);
  if (!streaming) result.set("layers", layersArr);
  return result;
}
