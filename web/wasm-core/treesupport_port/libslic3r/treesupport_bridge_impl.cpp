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
#include "../../treesupport_bridge.h"   // file-relative -> wasm-core/treesupport_bridge.h (plain types)

#include "Print.hpp"
#include "Layer.hpp"
#include "I18N.hpp"
#include "ClipperUtils.hpp"
#include "ExtrusionEntity.hpp"
#include "ExtrusionEntityCollection.hpp"
#include "selector_state.hpp"   // (stage 20) painted enforcer/blocker its from the selector (port world)
#include "Support/TreeSupport.hpp"

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
        ln.width = double(path->width);
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

} // namespace

namespace treesupport_bridge {

std::vector<LayerOut> generate(const std::vector<std::vector<Ring>>& object_slices_mm,
                               const std::vector<double>&            layer_print_z_mm,
                               const Params&                         P)
{
    std::vector<LayerOut> result;
    const size_t N = object_slices_mm.size();
    if (N == 0 || layer_print_z_mm.size() != N) return result;

    Print pr; PrintRegion reg; PrintObject po;
    po.m_print = &pr; po.m_shared_regions.all_regions = { &reg };
    pr.m_objects = { &po };
    po.m_model_object = new ModelObject();

    // config: organic tree support (kernel params passed through where the facade exposes them).
    po.m_config.support_type.value   = P.support_auto ? stTreeAuto : stTree;  // manual => only painted enforcers
    po.m_config.enable_support.value = true;
    po.m_config.support_style.value  = smsTreeOrganic;
    po.m_config.layer_height.value   = P.layer_height_mm;
    po.m_config.support_threshold_angle.value = int(P.support_threshold_angle);
    if (P.support_line_width_mm > 0) {   // (19단계) explicit support extrusion width → support flow → per-path width
        po.m_config.support_line_width.value = P.support_line_width_mm;
        po.m_config.support_line_width.percent = false;
    }
    // 31단계: 커널이 모델을 원점 중심(bbox center=0)으로 넘긴다(작은 좌표=안전 영역). printable_area 를 [0,bed]
    //  양수 사분면으로 두면 TreeSupport 의 m_machine_border 클립(intersection_ex, TreeSupport.cpp:2188/2193/2197)이
    //  모델의 음수-X/Y 절반 서포트를 통째로 잘라 "한쪽만 서포트" 버그가 난다. 베드를 **원점 중심**([-bed/2,bed/2])으로
    //  둬 원점중심 모델이 온전히 안에 들어오게 한다(대칭 모델 → 좌우 대칭 서포트).
    const double hw = P.bed_width_mm * 0.5, hd = P.bed_depth_mm * 0.5;
    pr.m_config.printable_area.values  = { Vec2d(-hw,-hd), Vec2d(hw,-hd), Vec2d(hw,hd), Vec2d(-hw,hd) };
    pr.m_config.nozzle_diameter.values = { P.nozzle_mm };

    PrintInstance inst; inst.print_object = &po; inst.shift = Point(0,0);
    po.m_instances.push_back(inst);

    const double lh = P.layer_height_mm;
    po.m_slicing_params.layer_height             = lh;
    po.m_slicing_params.min_layer_height         = lh;
    po.m_slicing_params.max_layer_height         = lh;
    po.m_slicing_params.first_print_layer_height = lh;
    // (19단계 z 정합) layer_z() 는 first_object_layer_height 를 쓴다(first_print_layer_height 아님). 커널 오브젝트
    // z 그리드가 first_layer_height + idx*layer_height 이므로 이 값을 lh 로 맞춰 서포트 z 를 오브젝트 z 에 정합(잔차 0).
    po.m_slicing_params.first_object_layer_height = lh;
    po.m_slicing_params.object_print_z_min       = 0.0;

    auto S = [](double mm){ return coord_t(scale_(mm)); };
    coord_t minx = 0, miny = 0, maxx = 0, maxy = 0; bool bbox_init = false;
    Layer *prev = nullptr;
    for (size_t i = 0; i < N; ++i) {
        const double pz = layer_print_z_mm[i];
        Layer *L = po.add_layer(int(i), lh, pz, pz - lh * 0.5);
        L->lower_layer = prev;
        Polygons polys;
        for (const Ring &r : object_slices_mm[i]) {
            if (r.size() < 3) continue;
            Polygon p; p.points.reserve(r.size());
            for (const auto &xy : r) {
                coord_t sx = S(xy.first), sy = S(xy.second);
                p.points.emplace_back(sx, sy);
                if (!bbox_init) { minx = maxx = sx; miny = maxy = sy; bbox_init = true; }
                else { minx = std::min(minx, sx); maxx = std::max(maxx, sx);
                       miny = std::min(miny, sy); maxy = std::max(maxy, sy); }
            }
            polys.emplace_back(std::move(p));
        }
        ExPolygons ex = union_ex(polys);   // group rings into contour+holes ExPolygons
        L->lslices = ex;
        L->lslices_extrudable = ex;
        prev = L;
    }
    if (bbox_init) po.m_bbox = BoundingBox(Point(minx, miny), Point(maxx, maxy));

    // (stage 20) hand the painted enforcer/blocker facets to the facade so generate_overhangs projects
    // them (project_and_append_custom_facets -> slice_mesh_slabs). No paint => empty its => no-op.
    po.set_custom_facets(selector_enforcer_its(), selector_blocker_its());

    TreeSupport ts(po, po.m_slicing_params);
    ts.throw_on_cancel = [](){};
    ts.generate();

    for (const SupportLayer *sl : po.support_layers()) {
        if (sl == nullptr) continue;
        LayerOut lo; lo.print_z_mm = sl->print_z;
        for (const ExtrusionEntity *ee : sl->support_fills.entities)
            flatten_entity(ee, lo.lines);
        if (!lo.lines.empty()) result.push_back(std::move(lo));
    }
    return result;
}

} // namespace treesupport_bridge
