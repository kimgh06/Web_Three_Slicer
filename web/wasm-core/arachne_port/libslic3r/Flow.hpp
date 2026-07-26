// STUB (stage 7/8 port): real Flow.hpp pulls Config.hpp (heavy config machinery). This minimal Flow
// provides only what the ported code touches: the static rounded_rectangle_extrusion_width_from_spacing
// (WallToolPaths), and instance width()/height()/spacing()/mm3_per_mm() (FillBase::fill_surface_extrusion,
// which the port does not call — fill_surface() is used instead). Formulas copied verbatim from
// src/libslic3r/Flow.cpp (algorithm unchanged). POD members → FillParams stays trivially copyable.
#pragma once
#include "libslic3r.h"   // PI
namespace Slic3r {
// (stage 14) FlowRole enum verbatim from Flow.hpp:16 — needed by Layer.hpp/LayerRegion (TreeSupport
// adapter probe). Additive; the main build's Fill/Arachne don't reference it.
enum FlowRole {
    frExternalPerimeter, frPerimeter, frInfill, frSolidInfill, frTopSolidInfill,
    frSupportMaterial, frSupportMaterialInterface, frSupportTransition,
};
class Flow {
public:
    Flow() = default;
    Flow(float w, float h, float nozzle) : m_width(w), m_height(h),
        m_spacing(float(w - h * (1. - 0.25 * PI))), m_nozzle_diameter(nozzle) {}
    float  width()   const { return m_width; }
    float  height()  const { return m_height; }
    float  spacing() const { return m_spacing; }
    double mm3_per_mm() const {
        return m_bridge ? double((m_width * m_width) * 0.25 * PI)
                        : double(m_height * (m_width - m_height * (1. - 0.25 * PI)));
    }
    bool operator<(const Flow& rhs) const { return this->mm3_per_mm() < rhs.mm3_per_mm(); }  // Flow.hpp:90
    static float rounded_rectangle_extrusion_width_from_spacing(float spacing, float height)
    { return float(spacing + height * (1. - 0.25 * PI)); }
    Flow with_spacing(float new_spacing) const   // FillBase::fill_surface_extrusion (port doesn't call it)
    { return Flow(rounded_rectangle_extrusion_width_from_spacing(new_spacing, m_height), m_height, m_nozzle_diameter); }

    float m_width = 0.f, m_height = 0.f, m_spacing = 0.f, m_nozzle_diameter = 0.f;
    bool  m_bridge = false;
};
} // namespace Slic3r
