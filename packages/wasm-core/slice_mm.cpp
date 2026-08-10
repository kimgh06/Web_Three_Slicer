// slice_mm.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  slice_group stays `static` (used only here); slice_multimaterial is declared in layer_data.h.
#include "layer_data.h"

#include "config_bridge.h"
#include "gcode_writer.h"
#include "geom_helpers.h"
#include "slice_planes.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

// Slice the triangle subset [lo,hi) at a z plane -> contour
static Paths slice_group(const std::vector<Tri>& tris, int lo, int hi, double z){
  std::vector<Seg> segs; Seg sg;
  for (int ti=lo; ti<hi; ++ti){ const Tri& t=tris[ti];
    double zmin=std::min({t.v[0].z,t.v[1].z,t.v[2].z}), zmax=std::max({t.v[0].z,t.v[1].z,t.v[2].z});
    if (z<zmin||z>=zmax) continue; if (tri_plane(t,z,sg)) segs.push_back(sg); }
  return SimplifyPolygons(chain_polys(segs), pftEvenOdd);
}
// =============================================================================
// Multi-material basics (a stretch goal): two triangle groups (mm_group_split) are sliced separately within a layer,
//  and a group switch emits T0/T1 plus a simple prime tower (a 15x15 square ring in the bed corner, only on switching layers).
//  ⚠ Not a proper wipe tower — no purge/ramming/wipe volume calculation and no tower density optimization. Walls + sparse infill only.
// =============================================================================
em::val slice_multimaterial(std::vector<Tri>& tris, const Params& p, em::val onProgress,
                                   double height, bool over_bed){
  auto report=[&](int d,int t){ if(!onProgress.isUndefined()&&!onProgress.isNull()) onProgress(d,t); };
  const double w=p.line_width;
  int split=p.mm_group_split, NT=(int)tris.size();
  int N=0; for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) ++N;

  GW gw; gw.s.reserve(1<<16);
  // Per-tool filament: two materials mean two temperatures, two flow ratios and two retraction settings, so
  //  everything the writer holds about "the loaded filament" is (re)loaded here and again on every tool change.
  //  Params::forTool falls back to the scalar, so a caller that sends no per-extruder arrays gets the old G-code.
  auto loadTool=[&](int t){
    gw.tool_filament_diameter = Params::forTool(p.extruder_filament_diameter, t, p.filament_diameter);
    gw.tool_flow_ratio        = Params::forTool(p.extruder_flow_ratio,        t, p.flow_ratio);
    gw.filament_area          = PI*gw.tool_filament_diameter*gw.tool_filament_diameter/4.0;
    gw.retract_len            = Params::forTool(p.extruder_retract_length,    t, p.retract_length);
    gw.retractF               = (int)std::llround(Params::forTool(p.extruder_retract_speed, t, p.retract_speed)*60);
    gw.z_hop                  = Params::forTool(p.extruder_z_hop,             t, p.z_hop);
  };
  auto toolTemp=[&](int t){ return Params::forTool(p.extruder_nozzle_temp, t, p.nozzle_temp); };
  loadTool(0);
  gw.retract_min_travel=p.retraction_minimum_travel;
  gw.offX=p.bed_width*0.5; gw.offY=p.bed_depth*0.5;
  SeamCtx seamCtx;
  gw.raw("; OrcaSlicer RE mini-kernel (Track C stage 6) — MULTIMATERIAL (basic, NOT a real wipe tower)");
  { char h[200];
    std::snprintf(h,sizeof h,"; MM extruders=%d group_split=%d/%d  lh=%.3f lw=%.3f walls=%d infill=%.2f",
      p.extruder_count,split,NT,p.layer_height,w,p.wall_loops,p.infill_density); gw.raw(h);
    std::snprintf(h,sizeof h,"M140 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M104 S%.0f",toolTemp(0)); gw.raw(h);
    std::snprintf(h,sizeof h,"M190 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M109 S%.0f",toolTemp(0)); gw.raw(h); }
  gw.raw("G21 ; mm"); gw.raw("G90 ; absolute XYZ"); gw.raw("M83 ; relative E");
  gw.raw("T0 ; start extruder"); gw.raw("G92 E0");

  int fTravel=(int)std::llround(p.travel_speed*60);
  double sparse_sp=(p.infill_density>1e-4)?(w/p.infill_density):(w*3.0);
  // Prime tower fallback (square ring). Stage 33: position (10,10) and size 15 were hardcoded -> now wired to prime_tower_x/y/ring_size.
  //  Note: the default path is wipe_tower_real (the real WipeTower) and this ring is the fallback when that fails.
  double ptx=p.prime_tower_x-gw.offX, pty=p.prime_tower_y-gw.offY;
  const double ptSize=p.prime_tower_ring_size;
  auto primeRings=[&](){ Paths ps; for(int k=0;k<3;++k){ double o=k*w; double x0=ptx+o,y0=pty+o,x1=ptx+ptSize-o,y1=pty+ptSize-o;
    Path r; r.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y0*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y0*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y1*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y1*SCALE))); ps.push_back(r);} return ps; };

  em::val layersArr=em::val::array();
  int curTool=0;
  double lastTemp=toolTemp(0);   // the preamble already heated to T0's material
  double zShift=0.0;
  for (int i=0;i<N;++i){
    double z=p.first_layer_height + (i>0? i*p.layer_height : 0.0);   // approximate z
    double zE=z+zShift, h=(i==0)?p.first_layer_height:p.layer_height;
    gw.set_e_per_mm(h,p); gw.z=zE; gw.pe_reset();
    std::vector<float> tp, widths; g_seg_w = &widths; g_seg_w_cur = (float)p.line_width;   // stage 21: record MM widths
    char cm[64]; std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.raw(cm);
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
    int fPr=(int)std::llround(((i==0)?p.first_layer_speed:p.print_speed)*60);

    Paths c0=slice_group(tris,0,split,z), c1=slice_group(tris,split,NT,z);
    gw.island = Paths{};
    auto emitGroup=[&](const Paths& contour){
      if (contour.empty()) return;
      Paths last=contour; std::vector<Paths> walls;
      for (int wl=0; wl<p.wall_loops; ++wl){ Paths wp=offset_paths(contour,-(w*0.5+wl*w)); if(wp.empty())break; walls.push_back(wp); last=wp; }
      for (auto& wpz:walls) emit_loops(gw,tp,wpz,zE,1.0f,fPr,fTravel,-1,seamCtx);
      Paths fill = last.empty()?Paths{}:offset_paths(last,-w*0.5);
      if (!fill.empty()){ Paths lines=infill_clipped(fill,(i%2?135.0:45.0),sparse_sp); if(!lines.empty()) emit_lines(gw,tp,lines,zE,2.0f,fPr,fTravel); }
    };
    // ponytail: M109 (wait) right at the switch. A real slicer pre-heats the idle tool a few layers early to hide
    //  the stall; do that when the wipe tower knows the upcoming tool per layer.
    auto toolTo=[&](int t){
      if (curTool==t) return;
      gw.raw(t==0?"T0":"T1"); curTool=t; loadTool(t);
      if (toolTemp(t) != lastTemp) {                 // only when the materials actually disagree
        char h[48]; std::snprintf(h,sizeof h,"M109 S%.0f",toolTemp(t)); gw.raw(h); lastTemp=toolTemp(t);
      }
    };

    if (!c0.empty()){ toolTo(0); emitGroup(c0); }
    if (!c1.empty()){
      if (!c0.empty()){                                   // a switch within the layer -> prime tower
        toolTo(1);
        if (p.wipe_tower_real) {                          // stage 12: the real WipeTower.generate()
          auto wt = config_bridge::wipe_tower_block(p.bed_width,p.bed_depth,p.first_layer_height,
                        p.layer_height, zE, i==0, 0, 1, p.prime_tower_x, p.prime_tower_y,   // stage 33: the 10,10 constants -> wipe_tower_x/y
                        p.prime_tower_width, gw.tool_filament_diameter);   // the tool just switched to is the one purging
          if (wt.ok) {
            gw.raw("; wipe_tower_real: real ported WipeTower.generate()");
            gw.raw(wt.gcode.c_str());
            gw.filament += wt.filament_mm;
            for (float f : wt.toolpath) tp.push_back(f);
          } else {                                        // square ring fallback on failure
            gw.raw("; prime tower (fallback square ring)");
            emit_loops(gw,tp,primeRings(),zE,11.0f,fPr,fTravel,-1,seamCtx);
          }
        } else {
          gw.raw("; prime tower (basic — NOT a real wipe tower)");
          emit_loops(gw,tp,primeRings(),zE,11.0f,fPr,fTravel,-1,seamCtx);
        }
      } else toolTo(1);
      emitGroup(c1);
    }
    em::val Lo=em::val::object(); Lo.set("z",zE); Lo.set("paths",to_f32(tp)); Lo.set("widths",to_f32(widths)); layersArr.call<void>("push",Lo);
    report(i+1,N);
  }
  g_seg_w = nullptr;   // stage 21: the local MM widths goes out of scope here
  gw.raw("; end"); gw.raw("M104 S0"); gw.raw("M140 S0"); gw.raw("M107");
  { char h[64]; std::snprintf(h,sizeof h,"; filament used: %.2f mm",gw.filament); gw.raw(h); }
  em::val result=em::val::object(), stats=em::val::object();
  stats.set("layers",N); stats.set("model_layers",N); stats.set("raft_layers",0);
  stats.set("path_segments",(double)gw.segments); stats.set("filament_mm",gw.filament);
  stats.set("over_bed",over_bed); stats.set("wall_crossings",(double)gw.wall_crossings);
  stats.set("extruders",p.extruder_count);
  result.set("gcode",gw.s); result.set("stats",stats); result.set("layers",layersArr);
  return result;
}
