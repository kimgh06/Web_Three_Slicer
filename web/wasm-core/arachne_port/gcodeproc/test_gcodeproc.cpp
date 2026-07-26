// Stage-13 diagnostic: known g-code, exact E, inspect move-type histogram + filament + print_z.
#include <cstdio>
#include <string>
#include <map>
#include "GCode/GCodeProcessor.hpp"
#include "PrintConfig.hpp"
using namespace Slic3r;

int main() {
    // 3 layers, each: travel + 4 extruding edges E1.0 => expected filament = 3*4*1.0 = 12.0 mm
    std::string g = "; test\nG21\nG90\nM83\nG28\n";
    for (int L=0;L<3;++L){ char b[128];
        std::snprintf(b,sizeof b,"G1 Z%.2f F600\n", 0.2*(L+1)); g+=b;
        g+="G1 X0 Y0 F6000\n";
        g+="G1 X40 Y0 E1.0 F1800\nG1 X40 Y40 E1.0 F1800\nG1 X0 Y40 E1.0 F1800\nG1 X0 Y0 E1.0 F1800\n";
    }
    GCodeProcessor gp; PrintConfig cfg; gp.apply_config(cfg); gp.process_buffer(g); gp.finalize(false);
    const auto& r = gp.get_result();
    const int NM=(int)PrintEstimatedStatistics::ETimeMode::Normal;
    std::map<int,int> typehist; double fil_all=0, fil_extrude=0; int nz=0; double maxz=0;
    for (auto& m : r.moves){ typehist[(int)m.type]++;
        if (m.delta_extruder>0){ fil_all+=m.delta_extruder; if(m.type==EMoveType::Extrude) fil_extrude+=m.delta_extruder; }
        if (m.print_z>0){ nz++; if(m.print_z>maxz)maxz=m.print_z; }
    }
    printf("total_moves=%zu total_time=%.3f\n", r.moves.size(), r.print_statistics.modes[NM].time);
    printf("filament: all_delta>0=%.3f  extrude_only=%.3f  (expected 12.0)\n", fil_all, fil_extrude);
    printf("moves with print_z>0: %d / %zu  maxz=%.3f\n", nz, r.moves.size(), maxz);
    printf("type histogram (8=Travel,10=Extrude): ");
    for (auto&kv:typehist) printf("[%d]=%d ", kv.first, kv.second); printf("\n");
    return 0;
}
