// WP2 (normal 서포트 포트): LayerRegion 의 flow 계열 3 메서드만 발췌한 최소 TU.
// LayerRegion.cpp 전체(1,130줄)는 BridgeDetector/PerimeterGenerator 등 페리미터 생성 스택을 통째로
// 끌고 들어오는데, SupportMaterial.cpp 가 실제로 링크 요구하는 것은 flow/bridging_flow 뿐이다.
// 본문은 LayerRegion.cpp:21~60 에서 verbatim 복사 (수정 0) — 원본 갱신 시 재복사만 하면 된다.
// ponytail: 최소 발췌 TU. SupportMaterial 이 LayerRegion 의 다른 메서드를 요구하게 되면 이 파일 대신
//  LayerRegion.cpp 본체 컴파일로 승격.
#include "Layer.hpp"
#include "Print.hpp"
#include "Flow.hpp"

namespace Slic3r {

Flow LayerRegion::flow(FlowRole role) const
{
    return this->flow(role, m_layer->height);
}

Flow LayerRegion::flow(FlowRole role, double layer_height) const
{
    return m_region->flow(*m_layer->object(), role, layer_height, m_layer->id() == 0);
}

Flow LayerRegion::bridging_flow(FlowRole role, bool thick_bridge) const
{
    const PrintRegion       &region         = this->region();
    const PrintRegionConfig &region_config  = region.config();
    const PrintObject       &print_object   = *this->layer()->object();
    Flow bridge_flow;
    // Here this->extruder(role) - 1 may underflow to MAX_INT, but then the get_at() will fall back to zero'th element, so everything is all right.
    auto nozzle_diameter = float(print_object.print()->config().nozzle_diameter.get_at(region.extruder(role) - 1));
    const ConfigOptionFloatOrPercent& bridge_width_opt = region_config.bridge_line_width;
    const double                      bridge_width      = bridge_width_opt.get_abs_value(nozzle_diameter);
    const bool                        has_bridge_width  = bridge_width > 0.;
    const double                      bridge_flow_ratio = region_config.bridge_flow;

    if (thick_bridge) {
        // The old Slic3r way (different from all other slicers): Use rounded extrusions.
        // Get the configured nozzle_diameter for the extruder associated to the flow role requested.
        float thread_diameter = has_bridge_width ? float(bridge_width) : nozzle_diameter;
        if (bridge_flow_ratio > 0.)
            thread_diameter *= float(sqrt(bridge_flow_ratio));
        bridge_flow = Flow::bridging_flow(thread_diameter, nozzle_diameter);
    } else {
        // The same way as other slicers: Use normal extrusions. Apply bridge_flow while maintaining the original spacing.
        Flow base_flow = this->flow(role);
        if (has_bridge_width)
            base_flow = Flow(float(bridge_width), base_flow.height(), nozzle_diameter);
        bridge_flow = base_flow.with_flow_ratio(bridge_flow_ratio);
    }
    return bridge_flow;

}

} // namespace Slic3r
