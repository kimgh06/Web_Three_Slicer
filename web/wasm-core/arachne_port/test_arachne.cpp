// Stage-7 link/functional test: call the real ported Arachne WallToolPaths on a square,
// print the resulting variable-width beads. Proves the port links & runs.
#include <cstdio>
#include "libslic3r/Arachne/WallToolPaths.hpp"

using namespace Slic3r;
using namespace Slic3r::Arachne;

int main() {
    // 20x20 mm square outline (coords scaled: 1mm = 1e6)
    const coord_t S = 1000000; // scaled(1mm)
    Polygon sq;
    sq.points = { Point(0,0), Point(20*S,0), Point(20*S,20*S), Point(0,20*S) };
    Polygons outline; outline.push_back(sq);

    WallToolPathsParams params;
    params.min_bead_width = 0.85f * 0.4f;   // ~min_bead_width_pct * nozzle
    params.min_feature_size = 0.1f * 0.4f;
    params.min_length_factor = 0.5f;
    params.wall_transition_length = 0.4f;
    params.wall_transition_angle = 10.f;
    params.wall_transition_filter_deviation = 0.25f * 0.4f;
    params.wall_distribution_count = 1;
    params.is_top_or_bottom_layer = false;

    coord_t bead_width = coord_t(0.42 * S);   // 0.42mm line width
    WallToolPaths wtp(outline, bead_width, bead_width, /*inset_count*/3, /*wall_0_inset*/0, /*layer_height*/0.2, params);
    const std::vector<VariableWidthLines>& toolpaths = wtp.generate();

    printf("ARACHNE OK (square 20mm): %zu inset groups\n", toolpaths.size());
    auto report = [S](const char* name, const std::vector<VariableWidthLines>& tp){
        int lines = 0; double wmin = 1e18, wmax = -1e18; long junctions = 0;
        for (const VariableWidthLines& grp : tp)
            for (const ExtrusionLine& line : grp) {
                ++lines;
                for (const ExtrusionJunction& j : line.junctions) {
                    ++junctions;
                    double w = j.w / double(S);
                    if (w < wmin) wmin = w; if (w > wmax) wmax = w;
                }
            }
        printf("  %s: groups~ lines=%d junctions=%ld  width_mm min=%.4f max=%.4f\n", name, lines, junctions, wmin, wmax);
    };
    report("square20", toolpaths);

    // Tapering wedge: forces Arachne variable-width beads (wide end -> narrow tip).
    Polygon wedge;
    wedge.points = { Point(0,0), Point(30*S,0), Point(30*S, coord_t(0.55*S)), Point(0, coord_t(2.2*S)) };
    Polygons wedgeOut; wedgeOut.push_back(wedge);
    WallToolPaths wtp2(wedgeOut, bead_width, bead_width, 3, 0, 0.2, params);
    const auto& tp2 = wtp2.generate();
    printf("ARACHNE OK (tapering wedge): %zu inset groups\n", tp2.size());
    report("wedge", tp2);
    return 0;
}
