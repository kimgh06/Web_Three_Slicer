// Stage-9: prove the ported TreeSupport core (MinimumSpanningTree) runs — branch topology over
// support points. A tree spanning N points has exactly N-1 edges (connected acyclic).
#include <cstdio>
#include "../tree_bridge.h"
using namespace tree_bridge;
int main() {
    // scattered overhang support points (mm)
    std::vector<std::pair<double,double>> pts = {
        {0,0},{10,0},{20,0},{5,8},{15,8},{10,16},{2,20},{18,20},{10,25}
    };
    auto edges = branch_mst(pts);
    double total = 0; for (auto& e : edges) total += std::hypot(e.x1-e.x0, e.y1-e.y0);
    printf("MST branch-merge: %zu points -> %zu edges (expect %zu = N-1), total branch len=%.2fmm\n",
           pts.size(), edges.size(), pts.size()-1, total);
    printf("acyclic_tree=%d\n", edges.size() == pts.size()-1 ? 1 : 0);
    return 0;
}
