// STUB (stage 13 GCodeProcessor port): the real Print.hpp (1376 lines) pulls the whole Print /
// PrintObject / Layer / PrintBase pipeline (the same subsystem that gates TreeSupport). GCodeProcessor
// uses Print for EXACTLY two things (verified in stage 12):
//   - m_print->print_statistics().total_wipe_tower_filament   (GCodeProcessor.cpp:1050)
//   - m_print->active_step_add_warning(WarningLevel::CRITICAL, msg)  (GCodeProcessor.cpp:1371)
// So a minimal Print with those members + PrintStateBase::WarningLevel is sufficient; the full
// pipeline is intentionally avoided. In the WASM kernel m_print stays null (set_print never called),
// so both paths are inert anyway.
#ifndef slic3r_Print_stub_hpp_
#define slic3r_Print_stub_hpp_
#include <string>
#include <cstdint>
// Transitive includes the real Print.hpp provided that GCodeProcessor.cpp relies on.
#include <unordered_set>
#include <unordered_map>
#include "BoundingBox.hpp"
#include "CommonDefs.hpp"   // NozzleType

namespace Slic3r {

// Verbatim from TriangleSelector.hpp:13 — GCodeProcessor uses EnforcerBlockerType::ExtruderMax as a
// per-extruder array size. Reproduced here (GCodeProcessor doesn't include TriangleSelector, gets it
// transitively in the real build).
enum class EnforcerBlockerType : int8_t {
    NONE = 0, ENFORCER = 1, BLOCKER = 2, FUZZY_SKIN = ENFORCER,
    Extruder1 = ENFORCER, Extruder2 = BLOCKER, Extruder3, Extruder4, Extruder5, Extruder6, Extruder7,
    Extruder8, Extruder9, Extruder10, Extruder11, Extruder12, Extruder13, Extruder14, Extruder15,
    Extruder16, ExtruderMax = Extruder16
};

class PrintStateBase {
public:
    // Values/order copied from src/libslic3r/PrintBase.hpp:54.
    enum class WarningLevel { NON_CRITICAL, CRITICAL };
};

struct PrintStatistics {
    double total_wipe_tower_filament = 0.0;
    // Format-mask comment strings (verbatim from Print.cpp:4557-4573) used by GCodeProcessor's
    // statistics writer (file-export path, inert in WASM). C++17 inline statics — no .cpp needed.
    inline static const std::string FilamentUsedGMask      = "; filament used [g] =";
    inline static const std::string TotalFilamentUsedGMask = "; total filament used [g] =";
    inline static const std::string FilamentUsedCm3Mask    = "; filament used [cm3] =";
    inline static const std::string FilamentUsedMmMask     = "; filament used [mm] =";
    inline static const std::string FilamentCostMask       = "; filament cost =";
    inline static const std::string TotalFilamentCostMask  = "; total filament cost =";
};

class Print {
public:
    const PrintStatistics& print_statistics() const { return m_print_statistics; }
    PrintStatistics&       print_statistics()       { return m_print_statistics; }
    void active_step_add_warning(PrintStateBase::WarningLevel /*level*/, const std::string& /*message*/,
                                 int /*message_id*/ = -1) {}
    // STUB: real returns nozzle-material HRC hardness (Print.cpp) for a wear warning — inert in WASM.
    static int get_hrc_by_nozzle_type(const NozzleType& /*type*/) { return 0; }
private:
    PrintStatistics m_print_statistics;
};

} // namespace Slic3r
#endif
