// STUB (stage 11 WipeTower port): the real GCodeProcessor.hpp is the full ~9000-line g-code parser
// (calib.hpp config flood etc.). WipeTower.cpp references only a handful of lightweight statics from
// it — the reserved-tag strings + ETags enum + s_IsBBLPrinter + the Nozzle_Change tags. Those are
// reproduced verbatim from src/libslic3r/GCode/GCodeProcessor.{hpp,cpp} (Reserved_Tags table,
// Reserved_Tags_compatible table, Nozzle_Change_*_Tag, ETags enum, reserved_tag()). This stub ALSO
// pulls the real ported PrintConfig.hpp (WipeTower reads config.<option>.value directly, so it needs
// the full StaticPrintConfig definition) and ExtrusionEntity.hpp (ExtrusionEntity::role_to_string).
#ifndef slic3r_GCodeProcessor_stub_hpp_
#define slic3r_GCodeProcessor_stub_hpp_

#include <string>
#include <vector>
// Real ported config. Explicit path (resolved via -Iarachne_port) so this works in BOTH the standalone
// wipetower_probe AND the main slicer_core.js build WITHOUT putting config/libslic3r on the global -I
// (which would make Arachne/Fill/PE compile against the real header instead of their lean stub).
#include "config/libslic3r/PrintConfig.hpp"
#include "ExtrusionEntity.hpp"   // erWipeTower / role_to_string (arachne_port/libslic3r)

namespace Slic3r {

class GCodeProcessor {
public:
    enum class ETags : unsigned char {
        Role, Wipe_Start, Wipe_End, Height, Width, Layer_Change, Color_Change, Pause_Print,
        Custom_Code, First_Line_M73_Placeholder, Last_Line_M73_Placeholder,
        Estimated_Printing_Time_Placeholder, Total_Layer_Number_Placeholder, Manual_Tool_Change,
        During_Print_Exhaust_Fan, Wipe_Tower_Start, Wipe_Tower_End, PA_Change,
        Print_Time_Sec_Placeholder, Used_Filament_Length_Placeholder,
    };

    // Verbatim from GCodeProcessor.cpp (BBL table).
    static inline const std::vector<std::string> Reserved_Tags = {
        " FEATURE: ", " WIPE_START", " WIPE_END", " LAYER_HEIGHT: ", " LINE_WIDTH: ", " CHANGE_LAYER",
        " COLOR_CHANGE", " PAUSE_PRINTING", " CUSTOM_GCODE", "_GP_FIRST_LINE_M73_PLACEHOLDER",
        "_GP_LAST_LINE_M73_PLACEHOLDER", "_GP_ESTIMATED_PRINTING_TIME_PLACEHOLDER",
        "_GP_TOTAL_LAYER_NUMBER_PLACEHOLDER", " MANUAL_TOOL_CHANGE ", "_DURING_PRINT_EXHAUST_FAN",
        " WIPE_TOWER_START", " WIPE_TOWER_END", " PA_CHANGE:", "@PRINT_TIME_SEC@", "@USED_FILAMENT_LENGTH@"
    };
    // Verbatim from GCodeProcessor.cpp (compatible table).
    static inline const std::vector<std::string> Reserved_Tags_compatible = {
        "TYPE:", "WIPE_START", "WIPE_END", "HEIGHT:", "WIDTH:", "LAYER_CHANGE", "COLOR_CHANGE",
        "PAUSE_PRINT", "CUSTOM_GCODE", "_GP_FIRST_LINE_M73_PLACEHOLDER", "_GP_LAST_LINE_M73_PLACEHOLDER",
        "_GP_ESTIMATED_PRINTING_TIME_PLACEHOLDER", "_GP_TOTAL_LAYER_NUMBER_PLACEHOLDER",
        " MANUAL_TOOL_CHANGE ", "_DURING_PRINT_EXHAUST_FAN", " WIPE_TOWER_START", " WIPE_TOWER_END",
        " PA_CHANGE:", "@PRINT_TIME_SEC@", "@USED_FILAMENT_LENGTH@"
    };
    static inline const std::string Nozzle_Change_Start_Tag = " NOZZLE_CHANGE_START";
    static inline const std::string Nozzle_Change_End_Tag   = " NOZZLE_CHANGE_END";
    static inline bool s_IsBBLPrinter = true;

    static const std::string& reserved_tag(ETags tag) {
        return s_IsBBLPrinter ? Reserved_Tags[static_cast<unsigned char>(tag)]
                              : Reserved_Tags_compatible[static_cast<unsigned char>(tag)];
    }
};

} // namespace Slic3r
#endif
