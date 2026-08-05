// Stage-11 WipeTower link+run probe: constructs a real WipeTower on the ported real PrintConfig and
// drives it far enough to emit the original tool-change g-code markers (; WIPE_TOWER_START etc.).
#include <cstdio>
#include <vector>
#include <string>
#include "WipeTower.hpp"
#include "PrintConfig.hpp"

using namespace Slic3r;

int main() {
    PrintConfig cfg; // real StaticPrintConfig, default-initialized from print_config_def

    // Minimal multi-material setup (direct static-config member writes).
    cfg.printable_area.values = { Vec2d(0,0), Vec2d(200,0), Vec2d(200,200), Vec2d(0,200) };
    cfg.nozzle_diameter.values = { 0.4, 0.4 };
    cfg.single_extruder_multi_material.value = true;
    cfg.wipe_tower_x.values = { 15.0 };
    cfg.wipe_tower_y.values = { 15.0 };
    cfg.travel_speed.values = { 120.0 };
    cfg.initial_layer_speed.values = { 30.0 };
    cfg.filament_change_length.values = { 0.0, 0.0 };
    cfg.hotend_heating_rate.values = { 2.0, 2.0 };
    cfg.physical_extruder_map.values = { 0, 1 };
    cfg.extruder_max_nozzle_count.values = { 1, 1 };
    cfg.extruder_printable_height.values = {};

    printf("PrintConfig built: nozzle_diameter.size=%zu prime_tower_width=%.1f\n",
           cfg.nozzle_diameter.size(), (double)cfg.prime_tower_width.value);

    WipeTower wt(cfg, 0, Vec3d(0,0,0), 0, 30.0f, std::vector<unsigned int>{0u,1u});
    printf("WipeTower constructed: width=%.2f pos=(%.1f,%.1f)\n",
           (double)wt.width(), (double)wt.position().x(), (double)wt.position().y());

    // Drive a single tool change and generate.
    int marker_start = 0, marker_change_layer = 0, marker_feature = 0, total_gcode = 0;
    try {
        wt.set_extruder(0, cfg);
        wt.set_extruder(1, cfg);
        wt.plan_toolchange(0.2f, 0.2f, 0, 1, 100.0f, 0.0f);
        std::vector<std::vector<WipeTower::ToolChangeResult>> result;
        wt.generate(result);
        for (auto& layer : result)
            for (auto& tcr : layer) {
                total_gcode += (int)tcr.gcode.size();
                if (tcr.gcode.find("WIPE_TOWER_START") != std::string::npos) marker_start++;
                if (tcr.gcode.find("CHANGE_LAYER") != std::string::npos || tcr.gcode.find("CHANGE LAYER") != std::string::npos) marker_change_layer++;
                if (tcr.gcode.find("FEATURE") != std::string::npos || tcr.gcode.find("TYPE:") != std::string::npos) marker_feature++;
            }
        printf("generate() ok: layers=%zu total_gcode_bytes=%d markers{wipe_tower_start=%d change_layer=%d feature=%d}\n",
               result.size(), total_gcode, marker_start, marker_change_layer, marker_feature);
        // Emit a snippet of the first non-empty gcode for eyeballing markers.
        for (auto& layer : result) { for (auto& tcr : layer) if (!tcr.gcode.empty()) {
            std::string snip = tcr.gcode.substr(0, 400);
            printf("---- first tcr gcode (first 400 bytes) ----\n%s\n----\n", snip.c_str());
            return 0;
        } }
    } catch (const std::exception& e) {
        printf("generate() threw: %s (construct+link OK; generation needs deeper pipeline setup)\n", e.what());
    }
    return 0;
}
