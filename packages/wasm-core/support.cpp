// support.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "slice_ctx.h"

#include "clip_util.h"
#include "selector_bridge.h"
#include "treesupport_bridge.h"

#include <algorithm>
#include <cmath>
#include <vector>

void support_run(SliceCtx& C) {
  const Params& p = *C.p;
  std::vector<LayerData>& L = *C.L;
  const int N = C.N;
  const double w = C.w, cx = C.cx, cy = C.cy, support_spacing = C.support_spacing;
  double& treeZMaxResid = *C.treeZMaxResid;
  int&    treeSupLayers = *C.treeSupLayers;
  // ---- PASS 1.6: support (overhang detection -> vertical projection -> interface/base) ----
  // (G003: used in the preamble outside the skip block -> hoisted above)
  if (p.enable_support) {
   // WP2: "grid"/"snug" now also go through the upstream port (PrintObjectSupportMaterial) — our own reimplementation is used only by tree_lite
   //  (and the explicit "grid_kernel" fallback). It shares the same facade, coordinate transform and rebinding as tree.
   const bool portNormal = (p.support_style == "grid" || p.support_style == "snug");
   if (p.support_style == "tree" || portNormal) {
    // Stage 18: the real organic TreeSupport (generate_tree_support_3D) — build the facade PrintObject graph from the kernel lslices (mm)
    //  -> TreeSupport::generate() -> emit SupportLayer::support_fills (the branch toolpaths) as type5.
    //  A separate path from grid/tree_lite (the simple descending approximation). treesupport_bridge is the ODR boundary (isolating port types).
    // Stage 28 P2: with viewer coordinates (auto_center=false) the model sits away from the origin -> the tree bridge (the generate_tree_support_3D port)
    //  hits a memory access violation at off-origin coordinates. The rings are shifted to the origin by the model's XY center before being handed to the bridge, and the branch output is shifted
    //  back by the same amount (to the model position) before emission -> avoids the crash and preserves the P2 overlap (round trip: input −tcx, output +tcx). With auto_center=true it is already at the origin.
    // Stage 31: the model stays centered on the origin (small coordinates = the safe zone). The bug where support appeared on one side only came from the bridge's
    //  printable_area (= machine_border) being the positive quadrant [0,bed], so intersection_ex clipped away the support on the origin-centered model's
    //  negative X/Y half -> fixed in treesupport_bridge_impl.cpp by making the border **origin-centered** ([-bed/2,bed/2])
    //  (model coordinates stay small -> this also avoids the cross-slice OOB that reappeared at large coordinates).
    const double tcx = p.auto_center ? 0.0 : cx, tcy = p.auto_center ? 0.0 : cy;
    std::vector<std::vector<treesupport_bridge::Ring>> slices(N);
    std::vector<double> zs(N);
    // [Ultra-dense contour guard] Same rule as the arachne guard: a 5µm reduction only above 20k points per layer.
    //  Upstream OrcaSlicer hands support contours that went through resolution simplification, but the kernel's PASS1 skips it, so on
    //  large models (measured at 774k tri) the ported support cost explodes in proportion to the point count. Below the threshold (the golden fixtures) nothing changes.
    auto sanitized = [&](const Paths& src) -> Paths {
      size_t npts = 0; for (const Path& q : src) npts += q.size();
      if (npts <= 20000) return src;
      Paths out = src; CleanPolygons(out, SCALE * 0.005); return out;
    };
    for (int j=0;j<N;++j) {
      zs[j] = L[j].z;
      for (const Path& ring : sanitized(L[j].contour)) {
        treesupport_bridge::Ring r; r.reserve(ring.size());
        for (const IntPoint& pt : ring) r.emplace_back(pt.x()*INV - tcx, pt.y()*INV - tcy);
        if (r.size()>=3) slices[j].push_back(std::move(r));
      }
    }
    treesupport_bridge::Params tsp;
    tsp.layer_height_mm=p.layer_height; tsp.nozzle_mm=p.nozzle_diameter;
    tsp.first_layer_height_mm=p.first_layer_height;                 // WP1: matches upstream initial_layer_print_height
    tsp.line_width_mm=p.line_width;                                 // WP1: the lslices_extrudable filter + auto-threshold flow
    tsp.support_threshold_angle=p.support_threshold_angle;
    tsp.support_top_z_distance=p.support_top_z_distance;
    tsp.support_bottom_z_distance=p.support_bottom_z_distance;      // WP1: → gap_object_support
    tsp.support_xy_distance=p.support_xy_distance;
    tsp.first_layer_gap_mm=p.support_object_first_layer_gap;        // WP1
    tsp.interface_top_layers=p.support_interface_top_layers;
    tsp.interface_bottom_layers=p.support_interface_bottom_layers;  // WP1: -1 => same as top
    tsp.independent_support_layer_height=p.independent_support_layer_height; // WP1: gap quantization switch
    tsp.support_auto=p.support_auto;                                // stage 20: automatic/manual (painted enforcers only)
    tsp.support_line_width_mm=p.support_line_width;                 // stage 19: the real support extrusion width (config -> flow -> per-path)
    tsp.support_angle_deg=p.support_angle;                          // WP1: SupportParameters::base_angle
    tsp.on_build_plate_only=p.support_on_build_plate_only;          // WP1
    tsp.tree_style=p.tree_style;                                    // WP1: organic|slim|strong|hybrid
    tsp.branch_angle_deg=p.tree_support_branch_angle;               // WP1: wiring up the tree shape keys
    tsp.angle_slow_deg=p.tree_support_angle_slow;
    tsp.branch_diameter_mm=p.tree_support_branch_diameter;
    tsp.branch_distance_mm=p.tree_support_branch_distance;
    tsp.branch_diameter_angle_deg=p.tree_support_branch_diameter_angle;
    tsp.tip_diameter_mm=p.tree_support_tip_diameter;
    tsp.top_rate_pct=p.tree_support_top_rate;
    tsp.wall_count=p.tree_support_wall_count;
    tsp.interface_pattern=p.support_interface_pattern;              // WP1: interface/base patterns and spacing
    tsp.base_pattern=p.support_base_pattern;
    tsp.interface_spacing_mm=p.support_interface_spacing;
    tsp.base_pattern_spacing_mm=p.support_base_pattern_spacing;
    tsp.bed_width_mm=p.bed_width; tsp.bed_depth_mm=p.bed_depth;
    tsp.printable_height_mm=p.printable_height;                     // WP1: BuildVolume height (previously hardcoded to 100mm)
    tsp.resolution_mm=p.gcode_resolution;   // stage 33: path simplification tolerance for the tree path (the upstream print_config "resolution")
    std::vector<treesupport_bridge::LayerOut> tlayers;
    if (portNormal) {
      // WP2: the upstream normal (grid/snug) support — supplies the PASS 1.5 surfaces (topSurf/botSurf) as stTop/stBottom
      //  (so upstream bottom-contact detection and sharp-tail handling work as-is). Coordinates are shifted by −tcx/−tcy exactly like the slices.
      tsp.normal_style = p.support_style;                           // grid|snug → smsGrid|smsSnug
      tsp.support_expansion_mm = p.support_expansion;
      tsp.bridge_no_support    = p.bridge_no_support;
      tsp.remove_small_overhang= p.support_remove_small_overhang;
      tsp.threshold_overlap_pct= p.support_threshold_overlap * 100.0; // kernel fraction (0.5) -> upstream percentage (50)
      std::vector<treesupport_bridge::LayerSurf> surfs(N);
      auto toRings=[&](const Paths& psRaw, std::vector<treesupport_bridge::Ring>& out){
        Paths ps = sanitized(psRaw);               // surfaces get the same guard (reduction on large models only)
        for (const Path& ring : ps) {
          treesupport_bridge::Ring r; r.reserve(ring.size());
          for (const IntPoint& pt : ring) r.emplace_back(pt.x()*INV - tcx, pt.y()*INV - tcy);
          if (r.size()>=3) out.push_back(std::move(r));
        }
      };
      for (int j=0;j<N;++j) { toRings(L[j].topSurf, surfs[j].top); toRings(L[j].botSurf, surfs[j].bottom); }
      tlayers = treesupport_bridge::generate_normal(slices, zs, surfs, tsp);
    } else {
      tlayers = treesupport_bridge::generate(slices, zs, tsp);
    }
    for (const treesupport_bridge::LayerOut& lo : tlayers) {
      // Stage 19 z alignment: support layers are synchronized with the object layers (layer_z uses the same slicing_params), so
      //  print_z lands exactly on the object z grid. Each is bound to the object layer with the smallest residual and the residual is recorded
      //  -> treeZMaxResid≈0 proves that "nearest" is in fact "exact" (zero error). The emitted Z is that object layer's print_z.
      int best=-1; double bestd=1e18;
      for (int j=0;j<N;++j){ double d=std::fabs(L[j].z - lo.print_z_mm); if(d<bestd){bestd=d;best=j;} }
      if (best<0) continue;
      treeZMaxResid = std::max(treeZMaxResid, bestd); ++treeSupLayers;
      for (const treesupport_bridge::Line& ln : lo.lines) {
        Path pl; pl.reserve(ln.pts.size());
        for (const auto& xy : ln.pts)
          pl.push_back(IntPoint((cInt)std::llround((xy.first+tcx)*SCALE),(cInt)std::llround((xy.second+tcy)*SCALE)));  // stage 28: shift back to the model position
        if (pl.size()>=2) L[best].supTree.push_back({std::move(pl), (float)ln.width,
                              ln.role, (float)ln.height, (float)ln.mm3_per_mm});  // WP3: preserve role/height/mm3
      }
    }
   } else {
    // Allowed horizontal step per layer = layer_height / tan(θ). Identical to upstream detect_overhangs (SupportMaterial.cpp:1439)
    //  lower_layer_offset = scale_(lower_layer.height / tan(threshold_rad)).
    //  θ is the "slope angle" (90° = vertical), so a smaller θ means a gentler slope -> a larger expansion and less support (matching the upstream tooltip).
    //  Note: before stage 33, tan was in the numerator and the direction was inverted (3x over-detection at 30°). It matched only by coincidence at 45°.
    //  Bounds: clamped at 89° like upstream (avoiding tan -> ∞), and θ<=0 is treated as "support everywhere" (zero expansion).
    const double thrDeg = std::min(89.0, p.support_threshold_angle);
    // Stage 33: θ=0 means "auto" — upstream uses an overlap criterion instead of an angle (detect_overhangs):
    //   lower_layer_offset = fw - scale_(support_threshold_overlap.get_abs_value(fw))
    //  Previously 0 was used literally, making the lower-layer expansion 0 (= every increase in the upper layer counted as an overhang), which over-detected.
    double maxStep = (thrDeg > 0.0) ? (p.layer_height / std::tan(thrDeg * PI/180.0))
                                    : std::max(0.0, w - p.support_threshold_overlap * w);
    int gap = std::max(1, (int)std::llround(p.support_top_z_distance / p.layer_height)); // contact z gap (in layers)
    int ifaceN = std::max(1, p.support_interface_top_layers);
    // Stage 20: painted enforcers/blockers -> per-layer polygons (slice_mesh_slabs projection, the same slice_z as the facade)
    std::vector<double> sliceZs(N); for (int j=0;j<N;++j) sliceZs[j]=L[j].z - p.layer_height*0.5;
    // The bridge now takes an EnforcerBlockerType state number (1..16) instead of a bool, so the two support states
    //  are named explicitly here — ENFORCER/BLOCKER are exactly what the old true/false meant.
    auto projToPaths=[&](int state)->std::vector<Paths>{
      auto pl = selector_bridge::project_layers(sliceZs, state);
      std::vector<Paths> out(N);
      for (int j=0;j<N && j<(int)pl.size();++j) for (auto& ring:pl[j]) {
        Path pa; pa.reserve(ring.size());
        for (auto& xy:ring) pa.push_back(IntPoint((cInt)std::llround(xy.first*SCALE),(cInt)std::llround(xy.second*SCALE)));
        if (pa.size()>=3) out[j].push_back(std::move(pa));
      }
      return out;
    };
    std::vector<Paths> enfL = projToPaths(selector_bridge::STATE_ENFORCER),
                       blkL = projToPaths(selector_bridge::STATE_BLOCKER);
    // Overhang: contour_i − offset(contour_{i-1}, +maxStep)
    // Stage 33: the old morphological opening (offset -openR -> +openR) is removed. The opening erased whole bands narrower than
    //  2*openR (=1.26w), so on gentle slopes (measured from 25°) no support was generated at all
    //  (effectively neutralizing support_threshold_angle). Upstream detect_overhangs does not erode the overhang result; instead it
    //  (1) first filters out islands in the lower slice narrower than the extrusion width (excluded when offset(-fw/2) is empty; "Do not use offset2()") and
    //  (2) cleans up the result by area. The same is done here.
    const double minOhArea = (p.support_overhang_min_area > 1e-9) ? p.support_overhang_min_area : (w*w);
    std::vector<Paths> overhang(N);
    if (p.support_auto) for (int i=1;i<N;++i) {
      // Stage 32 Fix A: do not skip when the lower layer is empty (a floating part, above a full z gap) — with no lower layer
      //  offset(empty)=empty, so the clip result is the whole contour_i = a full overhang -> support is generated beneath it.
      if (L[i].contour.empty()) continue;
      // (1) Lower-island filter: lower-layer fragments thinner than the extrusion width cannot support anything, so they are excluded from the lower layer (the upstream rule)
      Paths lower;
      for (const Path& isl : L[i-1].contour) {
        Paths one{isl};
        if (!offset_paths(one, -w*0.5).empty()) lower.push_back(isl);
      }
      Paths oh = clip_paths(L[i].contour, offset_paths(lower, maxStep), ctDifference);
      if (oh.empty()) continue;
      // Stage 33: bridge_no_support — no support is created under regions that will be bridged (the upstream option of the same name).
      //  Bridge candidates = this layer's exposed bottom surfaces (botSurf, from PASS 1.5). The kernel already handled the opposite direction
      //  (a support contact surface is not a bridge); this direction was missing.
      if (p.bridge_no_support && !L[i].botSurf.empty()) {
        oh = clip_paths(oh, L[i].botSurf, ctDifference);
        if (oh.empty()) continue;
      }
      // Stage 33: support_expansion — widens the overhang region to enlarge the contact area (upstream xy_expansion).
      if (p.support_expansion > 1e-9) oh = offset_paths(oh, p.support_expansion);
      // (2) Per-component selection (a verdict, not an erosion — components that pass are preserved in their original shape)
      //   (a) area: below the minimum area it is numerical noise
      //   (b) support_remove_small_overhang (upstream default true, SupportMaterial.cpp:2244):
      //      Upstream clusters overhangs across layers, erodes by 1x the extrusion width and discards them when the bbox is under 2x the extrusion width.
      //      Here it is approximated per component — if offset(-w) is empty the fragment "cannot fit even two lines" and is discarded.
      //      Note: this does not carve the shape (verdict only). The old openR opening eroded the shape itself and erased the bands.
      // Floating island exemption: when the lower layer is entirely empty, this layer is an island starting in mid-air.
      //  Regardless of size it cannot be printed without support, so it is exempt from small-overhang removal.
      //  Upstream saves the same situation with its cantilever/sharp-tail exceptions (around SupportMaterial.cpp:2270) —
      //  lacking those detectors, we approximate with "is the layer below empty".
      //  Note (measured): without this exemption, a real Benchy chimney (a thin-walled ring, z40.4) vanished at offset(-w) and
      //    got no support at all, leaving it floating.
      const bool floatingIsland = lower.empty();
      Paths keep;
      for (const Paths& comp : split_components(oh)) {
        if (paths_area(comp) < minOhArea) continue;
        if (p.support_remove_small_overhang && !floatingIsland) {
          // Implements the two categories upstream exempts from small-overhang removal (around SupportMaterial.cpp:2270).
          //  (a) sharp tail: a thin pointed island with area < 36mm² (=6x6, area_thresh_well_supported) that survives a 0.1x fw erosion.
          //     It collapses without support, so it is kept.  (upstream :1484)
          const bool sharpTail = paths_area(comp) < 36.0 && !offset_paths(comp, -0.1*w).empty();
          //  (b) cantilever: attached to the lower layer but extending more than 3mm beyond that attachment. (upstream :1524-1542)
          //     Upstream measures the maximum distance to the attachment; here an equivalent set operation is used —
          //     if anything remains after expanding the attachment by 3mm, it extends more than 3mm.
          bool cantilever = false;
          {
            Paths base = clip_paths(comp, offset_paths(lower, std::max(w, maxStep) + 0.1), ctIntersection);
            if (!base.empty()) cantilever = !clip_paths(comp, offset_paths(base, 3.0), ctDifference).empty();
          }
          if (!sharpTail && !cantilever && offset_paths(comp, -w).empty()) continue;
        }
        for (const Path& q : comp) keep.push_back(q);
      }
      if (!keep.empty()) overhang[i] = keep;
    }
    // enforcer: painted regions are forcibly added as overhangs (projecting a support column downward). blocker: subtracted from the overhangs (no
    //  column beneath them) — the same meaning as tree's generate_overhangs (overhangs -= blockers).
    for (int i=0;i<N;++i) if (!enfL[i].empty()) overhang[i] = union_paths(overhang[i], enfL[i]);
    for (int i=0;i<N;++i) if (!blkL[i].empty()) overhang[i] = clip_paths(overhang[i], blkL[i], ctDifference);
    // Downward projection: top to bottom.
    // Stage 33 [floating support fix] Follows the upstream project_support_to_grid (SupportMaterial.cpp) rule:
    //   Polygons trimming = offset(layer.lslices, EPS);
    //   overhangs_projection = diff(overhangs, trimming);   // <- the projection itself is carved before being passed down
    //   ...  out.second (the carved projection) becomes the next (lower) layer's overhangs_projection
    // So a projection that touches the model dies there permanently (= that point is a bottom contact, where support lands on the model).
    // The old implementation only accumulated into accum without subtracting the model and clipped "per layer afterwards", so
    //  a region erased behind the model on layer j came back on j-1 where the model disappears, producing **support floating in mid-air**.
    // Note: upstream's "stop propagating thinned columns" (an opening by column_propagation_filtering_radius) is in fact
    //   commented out and inactive (SupportMaterial.cpp:2701). We do not do it either —
    //   erasing a column on layer j robs the support above it on j+1 of its base and actually creates floating parts (confirmed by measurement).
    bool treeLite = (p.support_style == "tree_lite");
    // Stage 33: support_on_build_plate_only — when this option is on, upstream's project_support_to_grid switches trimming
    //  from "this layer's model" to buildplate_covered (the model footprint accumulated from below).
    //  As a result no projection survives at any XY the model ever occupied, leaving only columns that run straight down to the bed.
    std::vector<Paths> covered;
    if (p.support_on_build_plate_only) {
      covered.resize(N); Paths cov;
      for (int j=0;j<N;++j) { if (!L[j].contour.empty()) cov = union_paths(cov, L[j].contour); covered[j]=cov; }
    }
    std::vector<Paths> column(N);
    Paths accum;
    for (int j=N-1;j>=0;--j) {
      if (treeLite) accum = tree_taper(accum, p.tree_lite_shrink, p.tree_lite_min_radius);  // per-layer taper (keeping the minimum pillar)
      int src=j+gap; if (src<N) accum = union_paths(accum, overhang[src]);
      // * Upstream diff(overhangs, trimming): subtract this layer's model from the projection, and the result continues downward.
      //   This one line is what makes "support that lands on the model ends there" (bottom contact).
      const Paths& trim = p.support_on_build_plate_only ? covered[j] : L[j].contour;
      if (!trim.empty()) accum = clip_paths(accum, offset_paths(trim, p.support_xy_distance), ctDifference);
      column[j]=accum;
    }
    // Stage 32 Fix B: bottom z gap (support_bottom_z_distance) — the gap between a model top surface and the support bottom resting on it.
    //  botGap layers = round(dist/lh). With the default 0.2/0.2=1 the extra clip loop below does not run -> identical to today (golden byte-identical).
    int botGap = std::max(1, (int)std::llround(p.support_bottom_z_distance / p.layer_height));
    // Per-layer interface (solid) / base (sparse) split + model avoidance
    for (int j=0;j<N;++j) {
      if (column[j].empty()) continue;
      Paths modelClear = offset_paths(L[j].contour, p.support_xy_distance);
      // Bottom z gap: also remove support above the model top surface on the (botGap-1) layers directly below -> the support starts botGap above the model top surface.
      for (int k=1;k<botGap;++k){ int b=j-k; if (b>=0 && !L[b].contour.empty()) modelClear = union_paths(modelClear, offset_paths(L[b].contour, p.support_xy_distance)); }
      Paths col = clip_paths(column[j], modelClear, ctDifference);
      if (col.empty()) continue;
      // Stage 33: grid snapping (the upstream SupportGridPattern). After snapping it is trimmed back against the model region —
      //  upstream also passes both arguments together as support_grid_pattern(support_polygons, trimming_polygons).
      //  Applied to the grid style only (tree_lite exists for its taper shape, which snapping would destroy).
      if (!treeLite && p.support_grid_snap) {
        Paths snapped = grid_snap(col, support_spacing);
        snapped = clip_paths(snapped, modelClear, ctDifference);   // keep the parts inflated by snapping from intruding into the model
        if (!snapped.empty()) col = snapped;
      }
      Paths iface;
      for (int k=0;k<ifaceN;++k){ int s=j+gap+k; if (s<N) iface = union_paths(iface, overhang[s]); }
      iface = clip_paths(iface, col, ctIntersection);
      // Stage 33: support_interface_bottom_layers — the interface on the side where support rests on a model top surface
      //  (bottom contact). Upstream generate_interface_layers builds top and bottom interfaces separately
      //  (SupportParameters.hpp:37 num_bottom_interface_layers). We only had top.
      //  Test: if there is model near the point directly below this layer's support (botGap down), that part is a bottom contact surface.
      if (p.support_interface_bottom_layers > 0) {
        Paths under;
        for (int k=botGap;k<botGap+p.support_interface_bottom_layers;++k) {
          int b=j-k; if (b>=0 && !L[b].contour.empty()) under = union_paths(under, offset_paths(L[b].contour, p.support_xy_distance));
        }
        if (!under.empty()) {
          Paths botIface = clip_paths(col, under, ctIntersection);
          if (!botIface.empty()) iface = union_paths(iface, botIface);
        }
      }
      L[j].supIface = iface;
      L[j].supBase  = clip_paths(col, iface, ctDifference);
    }
   }
  }
}
