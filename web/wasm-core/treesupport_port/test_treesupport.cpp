// Stage-16 adapter driver: build a kernel-like overhang PrintObject (facade) and run the REAL
// organic TreeSupport, then report support-layer areas. Proves the ported pipeline links + runs.
#include <cstdio>
#include <vector>
#include "Print.hpp"
#include "Layer.hpp"
#include "I18N.hpp"
#include "Support/TreeSupport.hpp"

using namespace Slic3r;
namespace Slic3r { namespace I18N { translate_fn_type translate_fn = nullptr; } }

static ExPolygon square(double cx, double cy, double half) {
    ExPolygon e;
    auto S = [](double v){ return coord_t(scale_(v)); };
    e.contour.points = { Point(S(cx-half),S(cy-half)), Point(S(cx+half),S(cy-half)),
                         Point(S(cx+half),S(cy+half)), Point(S(cx-half),S(cy+half)) };
    return e;
}

int main() {
    Print pr; PrintRegion reg; PrintObject po;
    po.m_print = &pr; po.m_shared_regions.all_regions = { &reg };
    pr.m_objects = { &po };   // register the object: generate_tree_support_3D finds its index via print()->objects()
    po.m_model_object = new ModelObject();

    // config: organic tree support
    po.m_config.support_type.value      = stTreeAuto;   // auto: generate_overhangs scans all layers (manual+no-enforcers => 0 overhang layers)
    po.m_config.enable_support.value    = true;
    po.m_config.support_style.value     = smsTreeOrganic;
    po.m_config.layer_height.value      = 0.2;
    pr.m_config.printable_area.values   = { Vec2d(0,0), Vec2d(200,0), Vec2d(200,200), Vec2d(0,200) };
    pr.m_config.nozzle_diameter.values  = { 0.4 };

    PrintInstance inst; inst.print_object = &po; inst.shift = Point(0,0);
    po.m_instances.push_back(inst);

    // slicing params
    const double lh = 0.2;
    po.m_slicing_params.layer_height = lh;
    po.m_slicing_params.min_layer_height = lh;
    po.m_slicing_params.max_layer_height = lh;
    po.m_slicing_params.first_print_layer_height = lh;
    po.m_slicing_params.object_print_z_min = 0.0;

    // overhang model: a thin leg (layers 0..19, 10x10) then a wide table top (layers 20..29, 30x30).
    const int N = 30, kLeg = 20;
    Layer* prev = nullptr; double z = 0;
    for (int i = 0; i < N; ++i) {
        z += lh;
        Layer* L = po.add_layer(i, lh, z, z - lh*0.5);   // PrintObject is friend of Layer
        L->lower_layer = prev;
        ExPolygon s = (i < kLeg) ? square(0,0,5) : square(0,0,15);
        L->lslices = { s };
        L->lslices_extrudable = { s };
        prev = L;
    }
    po.m_bbox = BoundingBox(Point(scale_(-15),scale_(-15)), Point(scale_(15),scale_(15)));

    printf("driver: %zu layers (leg 10x10 x%d, top 30x30 x%d) -> organic tree support\n",
           po.m_layers.size(), kLeg, N - kLeg);

    TreeSupport ts(po, po.m_slicing_params);
    ts.throw_on_cancel = [](){};   // real pipeline injects the cancel callback; empty => bad_function_call at first check
    ts.generate();

    int nsup = (int)po.support_layers().size();
    int with_paths = po.count_support_layers_with_area();
    size_t toolpaths = po.total_support_toolpaths();
    printf("RESULT: support_layers=%d  layers_with_toolpaths=%d  total_support_toolpaths=%zu\n", nsup, with_paths, toolpaths);
    printf("CHECK support generated: %s\n", (nsup > 0 && with_paths > 0 && toolpaths > 0) ? "PASS" : "FAIL");
    return 0;
}
