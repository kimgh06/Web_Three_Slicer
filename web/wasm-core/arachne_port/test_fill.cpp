// Stage-8 link/functional test: run the real ported Fill patterns on a 20mm square, print segment
// counts, and check FillGyroid's TPMS z-phase (different z ⇒ different curve).
#include <cstdio>
#include "../fill_bridge.h"
using namespace fill_bridge;

int main() {
    std::vector<Poly> region = {{{0,0},{20,0},{20,20},{0,20}}};
    for (const char* pat : {"gyroid","honeycomb","3dhoneycomb","crosshatch","concentric"}) {
        auto r = generate_fill(region, pat, 0.2, 0.42, 0.0, 1.0, 5);
        long segs = 0; for (auto& pl : r) segs += (long)pl.size() - 1;
        printf("%-12s polylines=%zu segments=%ld\n", pat, r.size(), segs);
    }
    // Gyroid TPMS: point set differs between z layers (phase shift along z)
    auto g1 = generate_fill(region, "gyroid", 0.2, 0.42, 0.0, 1.0, 5);
    auto g5 = generate_fill(region, "gyroid", 0.2, 0.42, 0.0, 5.4, 27);
    auto firstpt = [](const std::vector<Poly>& g){ return g.empty()||g[0].empty() ? std::pair<double,double>{0,0} : g[0][0]; };
    auto a = firstpt(g1), b = firstpt(g5);
    printf("gyroid z=1.0 firstpt=(%.3f,%.3f)  z=5.4 firstpt=(%.3f,%.3f)  differ=%d\n",
           a.first,a.second,b.first,b.second, (a.first!=b.first||a.second!=b.second)?1:0);
    return 0;
}
