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
// WP2: generate_normal() 추가 — 같은 파사드 위에서 원본 PrintObjectSupportMaterial(SupportMaterial.cpp
//  포트)을 구동한다. 파사드 구성은 build_facade() 로 공용화(tree/normal 이 config 의 type/style 만 다름).
#include "../../treesupport_bridge.h"   // file-relative -> wasm-core/treesupport_bridge.h (plain types)
#include <tbb/stub_parallel.h>          // (WP-tbb) generate_normal 한정 병렬 허용 스코프 + 실진행 카운터
#include <cstdint>

namespace treesupport_bridge {
unsigned long progress_addr() { return (unsigned long)(uintptr_t)&tbb_stub::prog(); }
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
#include "Support/SupportMaterial.hpp"  // WP2: 원본 normal(grid/snug) 서포트

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
        ln.role       = int(path->role());        // WP3: base(14)/interface(15)/ironing(8) 구분 보존
        ln.height     = double(path->height);     // WP3: 원본 압출 높이(브리징 접촉층 등에서 레이어높이와 다름)
        ln.mm3_per_mm = path->mm3_per_mm;         // WP3: 원본 부피 유량 → 커널이 E 를 원본 그대로 재현 가능
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

// mm 링 목록 → scaled Polygons (3점 미만 링 무시)
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

// WP2: 공용 파사드 빌더 — config(공통부)/slicing_params/Layer 그래프/페인트 facets 까지.
//  support_type/support_style 및 스타일별 config 는 각 진입점이 설정한다.
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
    if (P.support_line_width_mm > 0) {   // (19단계) explicit support extrusion width → support flow → per-path width
        po.m_config.support_line_width.value = P.support_line_width_mm;
        po.m_config.support_line_width.percent = false;
    }
    if (P.line_width_mm > 0) {           // WP1: lslices_extrudable 얇은영역 필터 + auto-threshold flow 폴백 활성화
        po.m_config.line_width.value = P.line_width_mm;
        po.m_config.line_width.percent = false;
    }
    // WP1: 이전에 파싱만 되고 버려지던 4개 파라미터 + z/xy gap 계열 배선 (원본 config 키 그대로)
    po.m_config.support_top_z_distance.value        = P.support_top_z_distance;
    po.m_config.support_bottom_z_distance.value     = P.support_bottom_z_distance;
    po.m_config.support_object_xy_distance.value    = P.support_xy_distance;
    po.m_config.support_object_first_layer_gap.value= P.first_layer_gap_mm;
    po.m_config.support_interface_top_layers.value  = P.interface_top_layers;
    po.m_config.support_interface_bottom_layers.value = P.interface_bottom_layers; // -1 => top 과 동일(원본 규약)
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
    // WP1: 트리 형상 키 (TreeSupportCommon.hpp:79~95 TreeSupportSettings 가 소비 — normal 경로 무해)
    po.m_config.tree_support_branch_angle_organic.value    = P.branch_angle_deg;
    po.m_config.tree_support_angle_slow.value              = P.angle_slow_deg;
    po.m_config.tree_support_branch_diameter_organic.value = P.branch_diameter_mm;
    po.m_config.tree_support_branch_distance_organic.value = P.branch_distance_mm;
    po.m_config.tree_support_branch_diameter_angle.value   = P.branch_diameter_angle_deg;
    po.m_config.tree_support_tip_diameter.value            = P.tip_diameter_mm;
    po.m_config.tree_support_top_rate.value                = P.top_rate_pct;
    po.m_config.tree_support_wall_count.value              = P.wall_count;
    // 비-organic(slim/strong/hybrid) 경로가 읽는 쌍둥이 키(TreeSupport.cpp:651/2657/3405)도 같은 값으로 배선
    po.m_config.tree_support_branch_angle.value    = P.branch_angle_deg;
    po.m_config.tree_support_branch_diameter.value = P.branch_diameter_mm;
    po.m_config.tree_support_branch_distance.value = P.branch_distance_mm;
    // WP2: normal 경로 전용 키 (tree 경로 무해 — organic 은 미소비)
    po.m_config.support_expansion.value             = P.support_expansion_mm;
    po.m_config.bridge_no_support.value             = P.bridge_no_support;
    po.m_config.support_remove_small_overhang.value = P.remove_small_overhang;
    po.m_config.support_threshold_overlap.value     = P.threshold_overlap_pct;
    po.m_config.support_threshold_overlap.percent   = true;

    // 31단계: 커널이 모델을 원점 중심(bbox center=0)으로 넘긴다(작은 좌표=안전 영역). printable_area 를 [0,bed]
    //  양수 사분면으로 두면 TreeSupport 의 m_machine_border 클립(intersection_ex, TreeSupport.cpp:2188/2193/2197)이
    //  모델의 음수-X/Y 절반 서포트를 통째로 잘라 "한쪽만 서포트" 버그가 난다. 베드를 **원점 중심**([-bed/2,bed/2])으로
    //  둬 원점중심 모델이 온전히 안에 들어오게 한다(대칭 모델 → 좌우 대칭 서포트).
    const double hw = P.bed_width_mm * 0.5, hd = P.bed_depth_mm * 0.5;
    pr.m_config.printable_area.values  = { Vec2d(-hw,-hd), Vec2d(hw,-hd), Vec2d(hw,hd), Vec2d(-hw,hd) };
    pr.m_config.nozzle_diameter.values = { P.nozzle_mm };
    pr.m_config.printable_height.value = P.printable_height_mm;   // WP1: BuildVolume 높이 (이전엔 기본 100mm 고정)
    pr.m_config.independent_support_layer_height.value = P.independent_support_layer_height; // WP1: 갭 양자화 스위치
    // 33단계: 경로 단순화 허용오차 배선. TreeSupportCommon.hpp:56 이 이 값을 TreeSupportSettings::resolution
    //  으로 받아 TreeSupport3D 의 polygons_simplify 에 쓴다. 미설정 시 PrintConfig 기본 0.01 이 적용된다.
    if (P.resolution_mm > 0.0) pr.m_config.resolution.value = P.resolution_mm;

    PrintInstance inst; inst.print_object = &po; inst.shift = Point(0,0);
    po.m_instances.push_back(inst);

    const double lh  = P.layer_height_mm;
    const double flh = (P.first_layer_height_mm > 0.0) ? P.first_layer_height_mm : lh;
    po.m_slicing_params.layer_height             = lh;
    po.m_slicing_params.min_layer_height         = lh;
    po.m_slicing_params.max_layer_height         = lh;
    po.m_slicing_params.max_suport_layer_height  = lh;   // 원본 create_from_config: 서포트 있으면 max_layer_height
    // (19단계 z 정합→WP1 확장) 커널 z 그리드가 first_layer_height + idx*layer_height 이므로 첫층 높이를 그대로
    // 반영한다(원본 initial_layer_print_height 대응). first_layer_height 미전달(0)이면 기존과 동일하게 lh.
    po.m_slicing_params.first_print_layer_height  = flh;
    po.m_slicing_params.first_object_layer_height = flh;
    po.m_slicing_params.object_print_z_min       = 0.0;
    // ---- WP1: 원본 SlicingParameters::create_from_config (Slicing.cpp:80~190) 의 갭 수식 이식 ----
    // 이전에는 gap_support_object / gap_object_support 가 0 으로 남아 z_distance_top_layers=0
    // (서포트가 모델에 밀착)이었다. zero-gap 인터페이스 검출 + independent 여부에 따른 레이어 양자화까지 동일.
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
            return std::round(gap / lh + EPSILON) * lh;   // 원본: round(gap/layer_height + EPSILON)*layer_height
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
        if (prev) prev->upper_layer = L;   // WP1: 원본 레이어 그래프와 동일하게 상방 링크도 연결
        // WP1: LayerRegion 1개 연결 — support_threshold_angle=0("auto")일 때 TreeSupport3D.cpp:251~256 이
        //  lower_layer.regions() 의 외벽 flow 로 임계 오프셋을 계산한다. 이전엔 regions 가 비어 0/0=NaN.
        //  단일 리전 커널이므로 공유 PrintRegion 하나면 원본과 동치(외벽폭은 line_width 폴백으로 산출).
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
    if (N > 0) {   // WP1: 원본 create_from_config 의 object_print_z_max(오브젝트 높이) 대응
        po.m_slicing_params.object_print_z_max = layer_print_z_mm[N-1];
        po.m_slicing_params.valid = true;
    }

    // (stage 20) hand the painted enforcer/blocker facets to the facade so generate_overhangs projects
    // them (project_and_append_custom_facets -> slice_mesh_slabs). No paint => empty its => no-op.
    po.set_custom_facets(selector_enforcer_its(), selector_blocker_its());
}

// SupportLayer::support_fills → LayerOut 목록 (tree/normal 공용)
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
    po.m_config.support_style.value  =            // WP1: 스타일 하드코딩 해제 (slim/strong/hybrid 는 비-organic 경로)
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

    // WP2: LayerRegion 표면 데이터 주입 — SupportMaterial 이 소비하는 최소 표면:
    //  · raw_slices (sharp-tail 검출), · slices 의 stTop (bottom contact 검출) / stBottom / stInternal 파티션.
    //  perimeters/unsupported_bridge_edges 는 미공급 → bridge_no_support 의 브리지 검출은 no-op (문서화된 근사;
    //  커널 페리미터를 ExtrusionEntity 로 재구성하는 어댑터가 생기면 승격).
    for (size_t i = 0; i < N; ++i) {
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

    PrintObjectSupportMaterial sm(&po, po.m_slicing_params);
    // (WP-tbb) grid/snug 원본 서포트 생성만 tbb 스텁 실병렬 허용 — tree 경로는 concurrent_* 스텁이
    //  비스레드안전(std alias)이라 직렬 유지. 실측: 774k tri 모델에서 서포트 40.1s/전체 51s(79%)가 여기.
    tbb_stub::ParallelScope par;
    sm.generate(po);
    return collect_output(po);
}

} // namespace treesupport_bridge
