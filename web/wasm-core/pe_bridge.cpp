// Stage-8 bridge impl: runs the real ported PressureEqualizer over the kernel's g-code string.
#include "pe_bridge.h"
#include "arachne_port/libslic3r/GCode/PressureEqualizer.hpp"

namespace pe_bridge {
std::string equalize(const std::string& gcode, double filament_diameter_mm, double max_slope_mm3_s2,
                     double segment_length_mm, bool relative_e, bool external_perim_only)
{
    if (max_slope_mm3_s2 <= 0.0 || gcode.empty()) return gcode;
    try {
        Slic3r::PressureEqualizer pe(filament_diameter_mm, max_slope_mm3_s2, segment_length_mm,
                                     relative_e, external_perim_only);
        std::string out = pe.process_to_string(gcode);
        return out.empty() ? gcode : out;
    } catch (...) { return gcode; }
}
}
