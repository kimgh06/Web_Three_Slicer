// Stage-10: validate the ported time algorithm standalone.
#include <cstdio>
#include <string>
#include "../gcode_time.h"
using namespace gcode_time;

static std::string square_gcode(int F_mm_min, int loops){
    // a 50mm square extruding at feedrate F, then travel back
    std::string g = "G21\nG90\nM83\n; LAYER 0 Z0.200\nG1 Z0.200 F1200\n";
    char buf[128];
    double e = 1.5; // mm E per 50mm segment (arbitrary)
    for (int l=0;l<loops;++l){
        snprintf(buf,sizeof buf,"G1 X50.000 Y0.000 E%.5f F%d\n", e, F_mm_min); g+=buf;
        snprintf(buf,sizeof buf,"G1 X50.000 Y50.000 E%.5f F%d\n", e, F_mm_min); g+=buf;
        snprintf(buf,sizeof buf,"G1 X0.000 Y50.000 E%.5f F%d\n", e, F_mm_min); g+=buf;
        snprintf(buf,sizeof buf,"G1 X0.000 Y0.000 E%.5f F%d\n", e, F_mm_min); g+=buf;
        g += "G0 X10.000 Y10.000 F9000\n";
    }
    return g;
}

int main(){
    Limits lim;
    Result slow = estimate(square_gcode(1200, 20), lim);   // 20 mm/s
    Result fast = estimate(square_gcode(6000, 20), lim);   // 100 mm/s
    printf("slow(20mm/s): total=%.3fs moves=%ld filament=%.3fmm layer0=%.3fs\n", slow.total_s, slow.moves, slow.filament_mm, slow.first_layer_s);
    printf("fast(100mm/s): total=%.3fs moves=%ld filament=%.3fmm\n", fast.total_s, fast.moves, fast.filament_mm);
    printf("total>0=%d  faster_is_less=%d  filament_equal=%d\n",
           slow.total_s>0.0, fast.total_s < slow.total_s, (int)(std::abs(slow.filament_mm-fast.filament_mm)<1e-6));
    // manual sanity: 20 loops * 200mm/loop = 4000mm extrude at ~20mm/s -> ~200s+ (plus accel). Print time plausible.
    return 0;
}
