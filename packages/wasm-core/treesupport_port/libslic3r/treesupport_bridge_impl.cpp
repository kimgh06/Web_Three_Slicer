#include <chrono>
// Stage-17 bridge impl: build a facade PrintObject from kernel slice rings (mm), run the REAL organic
// TreeSupport (stage-16 port), and flatten SupportLayer::support_fills back to plain polylines (mm).
// This is the ONLY TU where the kernel meets the treesupport_port Slic3r/facade world. Compiled with
// the treesupport_port isolation -I set (so "Print.hpp" == the facade, "../*" == port-local copies);
// its objects are linked into the main slicer_core build, resolving shared symbols (Point/Polygon/
// PrintConfig/Arachne/Fill/Geometry/Voronoi/clipper) against the main build's already-compiled copies
// (headers verified ABI-identical: PrintConfig.hpp/Polygon.hpp identical, Point.hpp only differs by an
// include-mechanism change that resolves to the same std::allocator).
// This TU lives INSIDE treesupport_port/libslic3r/ so every Slic3r include below is file-relative
// (resolves to the port-local facade / real headers) exactly like the Support/*.cpp — the em++ FS
// sandbox does not reliably honor -I into the port tree, but file-relative includes always resolve.
// WP2: generate_normal() added — it drives the upstream PrintObjectSupportMaterial (a port of SupportMaterial.cpp)
//  on the same facade. Facade construction is shared via build_facade() (tree/normal differ only in the config type/style).
#include "../../treesupport_bridge.h"   // file-relative -> wasm-core/treesupport_bridge.h (plain types)
#include <tbb/stub_parallel.h>          // (WP-tbb) parallel-capable scope limited to generate_normal + the real progress counter
#include <tbb/parallel_for.h>
#include <tbb/blocked_range.h>
#include <cstdint>

namespace treesupport_bridge {
unsigned long progress_addr() { return (unsigned long)(uintptr_t)&tbb_stub::prog(); }
unsigned long cancel_addr() { return (unsigned long)(uintptr_t)&tbb_stub::cancel(); }
}

#include "Print.hpp"
#include "Layer.hpp"
#include "I18N.hpp"
#include "ClipperUtils.hpp"
#include "ExtrusionEntity.hpp"
#include "ExtrusionEntityCollection.hpp"
#include "Surface.hpp"
#include "selector_state.hpp"   // (stage 20) painted enforcer/blocker its from the selector (port world)
#include "Support/TreeSupport.hpp"
#include "Support/SupportMaterial.hpp"  // WP2: upstream normal (grid/snug) support

using namespace Slic3r;

// The treesupport group references Slic3r::I18N::translate_fn (support status strings). The main build
// does not define it, so the bridge (the group's root TU) provides the single definition (no-op).
namespace Slic3r { namespace I18N { translate_fn_type translate_fn = nullptr; } }

namespace {

// Recursively flatten one ExtrusionEntity into plain polylines (mm) with width.
void flatten_entity(const ExtrusionEntity *ee, std::vector<treesupport_bridge::Line> &out)
{
    if (ee == nullptr) return;
    if (const auto *coll = dynamic_cast<const ExtrusionEntityCollection*>(ee)) {
        for (const ExtrusionEntity *child : coll->entities) flatten_entity(child, out);
        return;
    }
    if (const auto *loop = dynamic_cast<const ExtrusionLoop*>(ee)) {
        for (const ExtrusionPath &p : loop->paths) flatten_entity(&p, out);
        return;
    }
    if (const auto *mp = dynamic_cast<const ExtrusionMultiPath*>(ee)) {
        for (const ExtrusionPath &p : mp->paths) flatten_entity(&p, out);
        return;
    }
    if (const auto *path = dynamic_cast<const ExtrusionPath*>(ee)) {
        treesupport_bridge::Line ln;
        ln.width      = double(path->width);
        ln.role       = int(path->role());        // WP3: preserves the base(14)/interface(15)/ironing(8) distinction
        ln.height     = double(path->height);     // WP3: upstream extrusion height (differs from the layer height on bridging contact layers, etc.)
        ln.mm3_per_mm = path->mm3_per_mm;         // WP3: upstream volumetric flow -> lets the kernel reproduce E exactly as upstream
        ln.pts.reserve(path->polyline.points.size());
        // ExtrusionPath::polyline is a Polyline3 (points carry Z); take X/Y only.
        for (const auto &pt : path->polyline.points) {
            const coord_t px = pt.x(), py = pt.y();
            ln.pts.emplace_back(unscale<double>(px), unscale<double>(py));
        }
        if (ln.pts.size() >= 2) out.push_back(std::move(ln));
        return;
    }
}

// List of mm rings -> scaled Polygons (rings with fewer than 3 points are ignored)
Polygons rings_to_polys(const std::vector<treesupport_bridge::Ring> &rings)
{
    Polygons polys;
    for (const treesupport_bridge::Ring &r : rings) {
        if (r.size() < 3) continue;
        Polygon p; p.points.reserve(r.size());
        for (const auto &xy : r)
            p.points.emplace_back(coord_t(scale_(xy.first)), coord_t(scale_(xy.second)));
        polys.emplace_back(std::move(p));
    }
    return polys;
}

// WP2: shared facade builder — config (common part), slicing_params, the Layer graph and the painted facets.
//  support_type/support_style and the style-specific config are set by each entry point.
void build_facade(Print &pr, PrintRegion &reg, PrintObject &po,
                  const std::vector<std::vector<treesupport_bridge::Ring>> &object_slices_mm,
                  const std::vector<double> &layer_print_z_mm,
                  const treesupport_bridge::Params &P)
{
    const size_t N = object_slices_mm.size();
    po.m_print = &pr; po.m_shared_regions.all_regions = { &reg };
    pr.m_objects = { &po };
    po.m_model_object = new ModelObject();

    po.m_config.enable_support.value = true;
    po.m_config.layer_height.value   = P.layer_height_mm;
    po.m_config.support_threshold_angle.value = int(P.support_threshold_angle);
    if (P.support_line_width_mm > 0) {   // (stage 19) explicit support extrusion width -> support flow -> per-path width
        po.m_config.support_line_width.value = P.support_line_width_mm;
        po.m_config.support_line_width.percent = false;
    }
    if (P.line_width_mm > 0) {           // WP1: enables the lslices_extrudable thin-region filter and the auto-threshold flow fallback
        po.m_config.line_width.value = P.line_width_mm;
        po.m_config.line_width.percent = false;
    }
    // WP1: wires up the 4 parameters that used to be parsed and discarded, plus the z/xy gap family (upstream config key names kept)
    po.m_config.support_top_z_distance.value        = P.support_top_z_distance;
    po.m_config.support_bottom_z_distance.value     = P.support_bottom_z_distance;
    po.m_config.support_object_xy_distance.value    = P.support_xy_distance;
    po.m_config.support_object_first_layer_gap.value= P.first_layer_gap_mm;
    po.m_config.support_interface_top_layers.value  = P.interface_top_layers;
    po.m_config.support_interface_bottom_layers.value = P.interface_bottom_layers; // -1 => same as top (upstream convention)
    po.m_config.support_on_build_plate_only.value   = P.on_build_plate_only;
    po.m_config.support_angle.value                 = P.support_angle_deg;
    po.m_config.support_interface_spacing.value     = P.interface_spacing_mm;
    po.m_config.support_base_pattern_spacing.value  = P.base_pattern_spacing_mm;
    po.m_config.support_interface_pattern.value =
          (P.interface_pattern == "rectilinear")             ? smipRectilinear
        : (P.interface_pattern == "concentric")              ? smipConcentric
        : (P.interface_pattern == "rectilinear_interlaced")  ? smipRectilinearInterlaced
        : (P.interface_pattern == "grid")                    ? smipGrid
        :                                                      smipAuto;
    po.m_config.support_base_pattern.value =
          (P.base_pattern == "rectilinear")      ? smpRectilinear
        : (P.base_pattern == "rectilinear-grid") ? smpRectilinearGrid
        : (P.base_pattern == "honeycomb")        ? smpHoneycomb
        : (P.base_pattern == "lightning")        ? smpLightning
        : (P.base_pattern == "none")             ? smpNone
        :                                          smpDefault;
    // WP1: tree shape keys (consumed by TreeSupportSettings, TreeSupportCommon.hpp:79~95 — harmless on the normal path)
    po.m_config.tree_support_branch_angle_organic.value    = P.branch_angle_deg;
    po.m_config.tree_support_angle_slow.value              = P.angle_slow_deg;
    po.m_config.tree_support_branch_diameter_organic.value = P.branch_diameter_mm;
    po.m_config.tree_support_branch_distance_organic.value = P.branch_distance_mm;
    po.m_config.tree_support_branch_diameter_angle.value   = P.branch_diameter_angle_deg;
    po.m_config.tree_support_tip_diameter.value            = P.tip_diameter_mm;
    po.m_config.tree_support_top_rate.value                = P.top_rate_pct;
    po.m_config.tree_support_wall_count.value              = P.wall_count;
    // The twin keys read by the non-organic (slim/strong/hybrid) path (TreeSupport.cpp:651/2657/3405) get the same values
    po.m_config.tree_support_branch_angle.value    = P.branch_angle_deg;
    po.m_config.tree_support_branch_diameter.value = P.branch_diameter_mm;
    po.m_config.tree_support_branch_distance.value = P.branch_distance_mm;
    // WP2: keys used only by the normal path (harmless for tree — organic never reads them)
    po.m_config.support_expansion.value             = P.support_expansion_mm;
    po.m_config.bridge_no_support.value             = P.bridge_no_support;
    po.m_config.support_remove_small_overhang.value = P.remove_small_overhang;
    po.m_config.support_threshold_overlap.value     = P.threshold_overlap_pct;
    po.m_config.support_threshold_overlap.percent   = true;

    // Stage 31: the kernel hands over a model centered on the origin (bbox center = 0; small coordinates = the safe zone). Leaving printable_area in the
    //  positive quadrant [0,bed] makes TreeSupport's m_machine_border clip (intersection_ex, TreeSupport.cpp:2188/2193/2197)
    //  cut away all support on the model's negative X/Y half — the "support on one side only" bug. So the bed is placed **centered on the origin**
    //  ([-bed/2,bed/2]) and an origin-centered model fits entirely inside (a symmetric model -> symmetric support).
    const double hw = P.bed_width_mm * 0.5, hd = P.bed_depth_mm * 0.5;
    pr.m_config.printable_area.values  = { Vec2d(-hw,-hd), Vec2d(hw,-hd), Vec2d(hw,hd), Vec2d(-hw,hd) };
    pr.m_config.nozzle_diameter.values = { P.nozzle_mm };
    pr.m_config.printable_height.value = P.printable_height_mm;   // WP1: BuildVolume height (previously hardcoded to 100mm)
    pr.m_config.independent_support_layer_height.value = P.independent_support_layer_height; // WP1: gap quantization switch
    // Stage 33: wires up the path simplification tolerance. TreeSupportCommon.hpp:56 takes this as TreeSupportSettings::resolution
    //  and uses it in TreeSupport3D's polygons_simplify. When unset, the PrintConfig default of 0.01 applies.
    if (P.resolution_mm > 0.0) pr.m_config.resolution.value = P.resolution_mm;

    PrintInstance inst; inst.print_object = &po; inst.shift = Point(0,0);
    po.m_instances.push_back(inst);

    const double lh  = P.layer_height_mm;
    const double flh = (P.first_layer_height_mm > 0.0) ? P.first_layer_height_mm : lh;
    po.m_slicing_params.layer_height             = lh;
    po.m_slicing_params.min_layer_height         = lh;
    po.m_slicing_params.max_layer_height         = lh;
    po.m_slicing_params.max_suport_layer_height  = lh;   // upstream create_from_config: max_layer_height when support is enabled
    // (stage-19 z alignment -> extended in WP1) The kernel z grid is first_layer_height + idx*layer_height, so the first layer height is
    // carried over verbatim (matching upstream initial_layer_print_height). With first_layer_height unset (0) it stays lh as before.
    po.m_slicing_params.first_print_layer_height  = flh;
    po.m_slicing_params.first_object_layer_height = flh;
    po.m_slicing_params.object_print_z_min       = 0.0;
    // ---- WP1: port of the gap formulas from upstream SlicingParameters::create_from_config (Slicing.cpp:80~190) ----
    // Previously gap_support_object / gap_object_support stayed 0, giving z_distance_top_layers=0
    // (support glued to the model). Zero-gap interface detection and the layer quantization based on independent mode are ported identically.
    {
        const double top_gap    = P.support_top_z_distance;
        const double bottom_gap = P.support_bottom_z_distance;
        const bool zero_topZ = (top_gap == 0.0);
        const int  bot_iface_layers = (P.interface_bottom_layers < 0) ? P.interface_top_layers
                                                                       : P.interface_bottom_layers;
        po.m_slicing_params.zero_gap_interface_top    = (P.interface_top_layers > 0) && zero_topZ;
        po.m_slicing_params.zero_gap_interface_bottom = (bot_iface_layers > 0) && (bottom_gap == 0.0 || zero_topZ);
        auto quantize = [&](double gap) {
            if (P.independent_support_layer_height) return gap;
            return std::round(gap / lh + EPSILON) * lh;   // upstream: round(gap/layer_height + EPSILON)*layer_height
        };
        po.m_slicing_params.gap_support_object = po.m_slicing_params.zero_gap_interface_top    ? 0.0 : quantize(top_gap);
        po.m_slicing_params.gap_object_support = po.m_slicing_params.zero_gap_interface_bottom ? 0.0 : quantize(bottom_gap);
    }

    coord_t minx = 0, miny = 0, maxx = 0, maxy = 0; bool bbox_init = false;
    Layer *prev = nullptr;
    for (size_t i = 0; i < N; ++i) {
        const double pz = layer_print_z_mm[i];
        Layer *L = po.add_layer(int(i), (i == 0 ? flh : lh), pz, pz - (i == 0 ? flh : lh) * 0.5);
        L->lower_layer = prev;
        if (prev) prev->upper_layer = L;   // WP1: link upward too, exactly like the upstream layer graph
        // WP1: attach one LayerRegion — when support_threshold_angle=0 ("auto"), TreeSupport3D.cpp:251~256 computes the
        //  threshold offset from the outer wall flow of lower_layer.regions(). Previously regions was empty, giving 0/0=NaN.
        //  This is a single-region kernel, so one shared PrintRegion is equivalent to upstream (the outer wall width comes from the line_width fallback).
        L->add_region(&reg);
        Polygons polys = rings_to_polys(object_slices_mm[i]);
        for (const Polygon &p : polys)
            for (const Point &pt : p.points) {
                if (!bbox_init) { minx = maxx = pt.x(); miny = maxy = pt.y(); bbox_init = true; }
                else { minx = std::min(minx, pt.x()); maxx = std::max(maxx, pt.x());
                       miny = std::min(miny, pt.y()); maxy = std::max(maxy, pt.y()); }
            }
        ExPolygons ex = union_ex(polys);   // group rings into contour+holes ExPolygons
        L->lslices = ex;
        L->lslices_extrudable = ex;
        prev = L;
    }
    if (bbox_init) po.m_bbox = BoundingBox(Point(minx, miny), Point(maxx, maxy));
    if (N > 0) {   // WP1: matches object_print_z_max (object height) in upstream create_from_config
        po.m_slicing_params.object_print_z_max = layer_print_z_mm[N-1];
        po.m_slicing_params.valid = true;
    }

    // (stage 20) hand the painted enforcer/blocker facets to the facade so generate_overhangs projects
    // them (project_and_append_custom_facets -> slice_mesh_slabs). No paint => empty its => no-op.
    po.set_custom_facets(selector_enforcer_its(), selector_blocker_its());
}

// SupportLayer::support_fills -> list of LayerOut (shared by tree/normal)
std::vector<treesupport_bridge::LayerOut> collect_output(const PrintObject &po)
{
    std::vector<treesupport_bridge::LayerOut> result;
    for (const SupportLayer *sl : po.support_layers()) {
        if (sl == nullptr) continue;
        treesupport_bridge::LayerOut lo; lo.print_z_mm = sl->print_z;
        for (const ExtrusionEntity *ee : sl->support_fills.entities)
            flatten_entity(ee, lo.lines);
        if (!lo.lines.empty()) result.push_back(std::move(lo));
    }
    return result;
}

} // namespace

namespace treesupport_bridge {

std::vector<LayerOut> generate(const std::vector<std::vector<Ring>>& object_slices_mm,
                               const std::vector<double>&            layer_print_z_mm,
                               const Params&                         P)
{
    const size_t N = object_slices_mm.size();
    if (N == 0 || layer_print_z_mm.size() != N) return {};

    Print pr; PrintRegion reg; PrintObject po;
    build_facade(pr, reg, po, object_slices_mm, layer_print_z_mm, P);
    po.m_config.support_type.value   = P.support_auto ? stTreeAuto : stTree;  // manual => only painted enforcers
    po.m_config.support_style.value  =            // WP1: style is no longer hardcoded (slim/strong/hybrid go down the non-organic path)
          (P.tree_style == "slim")   ? smsTreeSlim
        : (P.tree_style == "strong") ? smsTreeStrong
        : (P.tree_style == "hybrid") ? smsTreeHybrid
        :                              smsTreeOrganic;

    TreeSupport ts(po, po.m_slicing_params);
    ts.throw_on_cancel = [](){};
    ts.generate();
    return collect_output(po);
}

std::vector<LayerOut> generate_normal(const std::vector<std::vector<Ring>>& object_slices_mm,
                                      const std::vector<double>&            layer_print_z_mm,
                                      const std::vector<LayerSurf>&         surfs,
                                      const Params&                         P)
{
    const size_t N = object_slices_mm.size();
    if (N == 0 || layer_print_z_mm.size() != N) return {};

    Print pr; PrintRegion reg; PrintObject po;
    build_facade(pr, reg, po, object_slices_mm, layer_print_z_mm, P);
    po.m_config.support_type.value  = P.support_auto ? stNormalAuto : stNormal;
    po.m_config.support_style.value = (P.normal_style == "snug") ? smsSnug : smsGrid;

    // WP2: inject LayerRegion surface data — the minimal surfaces SupportMaterial consumes:
    //  · raw_slices (sharp-tail detection), · the stTop (bottom contact detection) / stBottom / stInternal partitions of slices.
    //  perimeters/unsupported_bridge_edges are not supplied -> bridge_no_support's bridge detection is a no-op (a documented approximation;
    //  it can be promoted once an adapter reconstructs kernel perimeters as ExtrusionEntity).
    // (WP-tbb) Only the upstream grid/snug support may use the real-parallel tbb stubs (tree stays serial because the concurrent_* stubs are unsafe).
    //  The scope is extended to before the surface injection loop — facade construction benefits from the parallelism too.
    tbb_stub::ParallelScope par;
    // [parallel] Surface partitioning is per-layer independent (it only writes its own Layer/LayerRegion) — the main component of the measured 0.43s facade time.
    tbb::parallel_for(tbb::blocked_range<size_t>(0, N), [&](const tbb::blocked_range<size_t>& __r) {
    for (size_t i = __r.begin(); i < __r.end(); ++i) {
        Layer *L = po.get_layer(int(i));
        LayerRegion *lr = L->get_region(0);
        lr->raw_slices = L->lslices;
        ExPolygons top, bot;
        if (i < surfs.size()) {
            top = union_ex(rings_to_polys(surfs[i].top));
            bot = union_ex(rings_to_polys(surfs[i].bottom));
        }
        Polygons topbot = to_polygons(top);
        polygons_append(topbot, to_polygons(bot));
        ExPolygons rest = topbot.empty() ? L->lslices : diff_ex(L->lslices, topbot);
        Surfaces ss;
        for (ExPolygon &e : top)  ss.emplace_back(stTop, std::move(e));
        for (ExPolygon &e : bot)  ss.emplace_back(stBottom, std::move(e));
        for (ExPolygon &e : rest) ss.emplace_back(stInternal, std::move(e));
        lr->slices.set(std::move(ss));
    }
    });

    PrintObjectSupportMaterial sm(&po, po.m_slicing_params);
    sm.generate(po);
    return collect_output(po);
}

} // namespace treesupport_bridge
