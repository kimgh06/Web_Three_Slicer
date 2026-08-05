// STUB (stage 13 GCodeProcessor port): the real ProjectTask.hpp pulls boost::thread + boost::filesystem
// (fs::path members in BBLProject/BBLSliceInfo) which are link-required. The only consumer in any WASM
// build is MultiNozzleUtils.cpp, which needs solely FilamentInfo. Reproduced verbatim from
// src/libslic3r/ProjectTask.hpp:38-100 (data members + get_ams_id/get_slot_id/get_display_filament_type).
// Original heavy header kept as ProjectTask_real.hpp.bak.
#ifndef slic3r_ProjectTask_hpp_
#define slic3r_ProjectTask_hpp_
#include <string>
#include <vector>
namespace Slic3r {
struct FilamentInfo
{
    int         id{0};
    std::string type;
    std::string color;
    std::string filament_id;
    std::string brand;
    float       used_m{0.f};
    float       used_g{0.f};
    int         tray_id{0};
    float       distance{0.f};
    int         ctype = 0;
    std::vector<std::string> colors = std::vector<std::string>();
    int         mapping_result = 0;
    bool        used_for_support{false};
    bool        used_for_object{false};
    std::vector<int> group_id;
    double      nozzle_diameter{0.0};
    std::string nozzle_volume_type;
    std::string ams_id;
    std::string slot_id;
public:
    int get_ams_id() const { if (ams_id.empty()) return -1; try { return stoi(ams_id); } catch (...) {} return -1; }
    int get_slot_id() const { if (slot_id.empty()) return -1; try { return stoi(slot_id); } catch (...) {} return -1; }
    std::string get_display_filament_type() const {
        if (type == "PLA-S") return "Sup.PLA";
        else if (type == "PA-S") return "Sup.PA";
        else if (type == "ABS-S") return "Sup.ABS";
        else return type;
    }
};
} // namespace Slic3r
#endif
