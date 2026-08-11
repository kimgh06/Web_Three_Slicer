#ifndef slic3r_MultiMaterialSegmentation_hpp_
#define slic3r_MultiMaterialSegmentation_hpp_

// Ported from slicer/src/libslic3r/MultiMaterialSegmentation.hpp. The algorithm in the .cpp is upstream's, unchanged;
// what differs is the entry point. Upstream's takes a PrintObject and walks its layers and ModelVolumes, neither of
// which exists in this kernel, so the driver at the bottom of the .cpp was rewritten to take the two things the
// kernel actually has: the sliced contour of every layer, and the painted facets of every selector state.

#include <functional>
#include <utility>
#include <vector>

#include "Point.hpp"
#include "TriangleMesh.hpp"   // indexed_triangle_set

namespace Slic3r {

class ExPolygon;

using ExPolygons = std::vector<ExPolygon>;

struct ColoredLine
{
    Line line;
    int  color;
    int  poly_idx       = -1;
    int  local_line_idx = -1;
};

using ColoredLines = std::vector<ColoredLine>;

enum class IncludeTopAndBottomLayers {
    Yes,
    No
};

// The painted facets of one selector state, in the same coordinates the layer contours are in.
//  `strict` mirrors upstream's get_facets/get_facets_strict split: the projection onto the layer contour wants every
//  facet carrying the state, while the top/bottom shell projection wants only the ones entirely of that state (a
//  partially painted facet would otherwise cast a whole-triangle shadow over the shell).
using PaintedFacetsOfState = std::function<indexed_triangle_set(size_t /* state */, bool /* strict */)>;

// What upstream reads off the PrintRegions of a layer. One region and one nozzle here, so each is a single value.
struct SegmentationShellParams {
    int    top_shell_layers       = 0;
    int    bottom_shell_layers    = 0;
    float  layer_height           = 0.2f;
    double outer_wall_line_width  = 0.42;
};

// Per-layer, per-extruder regions: out[layer][extruder]. Extruder 0 is the default one, i.e. everything the paint
// did not claim, which is exactly the shape slice_mm.cpp already partitions its layer polygons into.
std::vector<std::vector<ExPolygons>> mm_segmentation_by_painting(const std::vector<ExPolygons>  &layer_slices,
                                                                 const std::vector<float>       &zs,
                                                                 const PaintedFacetsOfState     &painted_facets_of_state,
                                                                 size_t                          num_facets_states,
                                                                 const SegmentationShellParams  &shell,
                                                                 float                           segmentation_max_width,
                                                                 IncludeTopAndBottomLayers       include_top_and_bottom_layers,
                                                                 const std::function<void()>    &throw_on_cancel_callback);

} // namespace Slic3r

namespace boost::polygon {
template<> struct geometry_concept<Slic3r::ColoredLine>
{
    typedef segment_concept type;
};

template<> struct segment_traits<Slic3r::ColoredLine>
{
    typedef coord_t       coordinate_type;
    typedef Slic3r::Point point_type;

    static inline point_type get(const Slic3r::ColoredLine &line, const direction_1d &dir)
    {
        return dir.to_int() ? line.line.b : line.line.a;
    }
};
} // namespace boost::polygon

#endif // slic3r_MultiMaterialSegmentation_hpp_
