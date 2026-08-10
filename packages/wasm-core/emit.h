// emit.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  Declarations only; the definitions (with their comments) live in emit.cpp, which also holds the single
//  definition of the file-scope width/island state (g_seg_w / g_seg_w_cur / g_keep_island).
#pragma once
#include "arachne_bridge.h"
#include "clip_util.h"
#include "gcode_writer.h"
#include "geom_helpers.h"
#include "params.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <vector>

namespace em = emscripten;

// Per-segment width tracking / island-keeping state — defined once in emit.cpp.
extern bool g_keep_island;
extern thread_local std::vector<float>* g_seg_w;
extern thread_local float g_seg_w_cur;

em::val to_f32(const std::vector<float>& v);
void emit_loops(GW& gw, std::vector<float>& tp, Paths loops, double z, float type, int fPrint, int fTravel,
                int seamMode, SeamCtx& sc, bool updateSeam=false);
void emit_lines(GW& gw, std::vector<float>& tp, const Paths& lines, double z, float type, int fPrint, int fTravel);
// Stage 19 -> WP3: one real tree support toolpath — per-path width plus the upstream ExtrusionPath's role/height/mm3_per_mm.
struct TreePath { Path pl; float w; int role; float h; float mm3; };
void emit_lines_vw(GW& gw, std::vector<float>& tp, const std::vector<TreePath>& lines,
                   double z, double h, const Params& p, float type, int fPrint, int fTravel);
void emit_arachne_walls(GW& gw, std::vector<float>& tp, const std::vector<arachne_bridge::WLine>& walls,
                        double z, double h, const Params& p, int fPrint, int fTravel);
void emit_spiral(GW& gw, std::vector<float>& tp, const Paths& outerWall, double z0, double h, int fPrint, int fTravel);
void emit_scarf_loop(GW& gw, std::vector<float>& tp, Path wp, double z, double h,
                     int fPrint, int fTravel, int seamMode, SeamCtx& sc);
