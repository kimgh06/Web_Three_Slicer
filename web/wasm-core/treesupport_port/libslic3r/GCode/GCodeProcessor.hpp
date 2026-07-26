// STUB (stage 16): BuildVolume::all_paths_inside(GCodeProcessorResult) is never called by TreeSupport.
// Minimal GCodeProcessorResult so BuildVolume.cpp compiles (the method is inert).
#pragma once
#include "../Point.hpp"
#include "../ExtrusionEntity.hpp"   // ExtrusionRole / erCustom / erNone
#include <vector>
namespace Slic3r {
enum class EMoveType : unsigned char { Noop, Retract, Unretract, Seam, Tool_change, Color_change, Pause_Print, Custom_GCode, Travel, Wipe, Extrude, Count };
struct GCodeProcessorResult {
    // Mirrors the real MoveVertex members read by BuildVolume::all_paths_inside (inert in the port).
    struct MoveVertex {
        EMoveType     type{EMoveType::Noop};
        ExtrusionRole extrusion_role{erNone};
        Vec3f         position{Vec3f::Zero()};
        float         width{0.0f};
        float         height{0.0f};
    };
    std::vector<MoveVertex> moves;
};
}
