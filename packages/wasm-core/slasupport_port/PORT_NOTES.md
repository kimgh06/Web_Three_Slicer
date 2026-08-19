# slasupport_port — PrusaSlicer 2.9.6 SLA support chain, ported verbatim

Sources: `slicers/PrusaSlicer/src/libslic3r/{SLA/*,AABBMesh.*,AABBTreeIndirect.hpp,MeshNormals.*,BoostAdapter.hpp,Optimize/*}`.
Compiled against the treesupport_port (Orca-generation) libslic3r core — Prusa-generation files staged HERE win
the include order for the SLA TUs only. `third_party/deps_src/libigl_prusa` is Prusa's own bundled libigl
(untemplated igl::Hit — the Orca-generation igl in `libigl/` is templated and does not match these sources).

Shims (whole-file, not edits):
- `libslic3r/Point.hpp` — include_next veneer re-adding the Vec3i alias Orca renamed to Vec3i32.
- `libslic3r/Optimize/NLoptOptimizer.hpp` — upstream's file VERBATIM, no longer a shim: the REAL NLopt 2.5.0
  (the exact version PrusaSlicer's deps pin, SHA-verified) is vendored under `third_party/deps_src/nlopt`
  and compiled into the SLA group (build.sh NLOPT_SRC). The earlier BruteforceOptimizer stand-in is gone.
- `libslic3r/libslic3r.h` — include_next veneer adding Prusa's `for_each_in_tuple`/`for_each_argument`
  (libslic3r.h:479), which the real NLoptOptimizer.hpp uses and the Orca-generation core lacks.
- `oneapi/tbb/spin_mutex.h` — std::mutex; the chain runs on ExecutionSeq.

PORT-EDIT lines (minimal, each marked in-file):
- `AABBTreeIndirect.hpp` centroid(): `.cast<int32_t>()` -> `.cast<coord_t>()` — Prusa's scaled coords are int32,
  the Orca-generation core here uses int64; identical behaviour on Prusa, correct width on this infra.
- `DefaultSupportTree.hpp` merge_result(): merged_mesh(45 default) -> merged_mesh(16) — the builder CACHES
  the first merge, so this is the one call that decides the mesh resolution. NOTE: the bridge calls
  `builder.merged_mesh(45)` itself (bc.mesh_steps, upstream's output resolution) BEFORE merge_result would,
  so the effective resolution is 45 again; the PORT-EDIT remains only as belt-and-braces for the cached path.

Support-point generation (SupportPointGenerator + SupportIslands, LINKED):
- `SLA/SupportPointGenerator.{cpp,hpp}` and `SLA/SupportIslands/*` are copied from the pinned 2.9.6 checkout
  and all 14 TUs are in `build.sh:SLA_SRC`. `slice_sla` reports `support_point_generator=prusa_port` and
  `support_point_parity_status=ported`; the old rim-sampling heuristic is deleted, not kept as a fallback.
- `KDTreeIndirect.hpp` is copied because the generator needs the 2.9.6 `get_copy()` and `get_nodes()` API.
- The historical blocker was `SupportIslands/LineUtils.cpp` reaching the Orca-generation `Geometry/Circle.hpp`,
  whose `ray_circle_intersections` calls a helper under a name upstream Orca never declares (`…_r2_lv2_c2` — an
  upstream typo in a template Orca never instantiates). Fixed by staging Prusa's own `Geometry/Circle.hpp`
  (header only — nothing here needs `Circle.cpp` symbols), which wins the include order for SLA TUs.
- The island group needs real CGAL (Delaunay/Voronoi sampling in `VoronoiDiagramCGAL.cpp` /
  `UniformSupportIsland.cpp`): brew CGAL headers, header-only, with `CGAL_DISABLE_GMP=1` everywhere CGAL is
  compiled — see the comment in `build.sh` (GMP auto-detection otherwise links `__gmpn_*` no wasm provides).
- Three more compatibility pieces: `libslic3r/Utils.hpp` veneer (adds Prusa's `ScopeGuard`, which reaches the
  TU transitively upstream), a `draw_original` no-op on the treesupport SVG stub, and PORT-EDIT lines inside
  `UniformSupportIsland.cpp` (free `perp_signed_distance_to_line` helper — upstream `Line.cpp:67` verbatim —
  and a `Polygons{}` wrap to hit Orca's `(Polygons, ExPolygon)` intersection overload) and
  `VoronoiGraphUtils.cpp` (explicit `BoundingBox{…}` for the SVG stub's variadic ctor).
- The driver is `slasupport_bridge::generate_support_points`, mirroring upstream `SLAPrintSteps::support_points`
  in its exact order: the object mesh is welded (`its_merge_vertices`) and sliced by the REAL slicer
  (`slice_mesh_ex` + `slice_closing_radius`, upstream's own `get_model_slices` pipeline — NOT the kernel's
  display contours), then `prepare_generator_data`,
  `generate_support_points`, `move_on_mesh_surface` (allowed move = one layer height), then permanent/manual
  points appended AFTER the move so their authored position survives; modifier masks still apply in
  `generate()` (task-6 semantics). Config mapping is upstream `SLAPrintSteps.cpp:716`: density percents -> ratio,
  `head_diameter` from `support_head_front_diameter`, island config via `SampleConfigFactory::apply_density`.

Support-slice capability:
- `SupportTreeSlicer.{cpp,hpp}` can reach the staged `ExPolygon`, `ClipperUtils`, `SupportTreeTypes`, and TBB
  surfaces, but upstream `SupportSlicesCache` also requires `SLAPrint.hpp::SliceRecord` and the
  `PrinterCorrections.hpp` correction pipeline (`apply_printer_corrections` and `apply_absolute_correction`).
- Those correction dependencies are not in the SLA port universe. The bridge therefore reports
  `SLA_SUPPORT_ANALYTICAL_CACHE_DEPENDENCY_UNAVAILABLE` and labels the active implementation
  `generic_mesh_sweep_fallback`; it caches exact repeated heights and does not claim analytical/cache parity.

Layer assembly and correction capability:
- Plate layers retain object-ordered contributions, including empty object records, so later model/support/pad
  assembly does not lose provenance.
- Printer and Z corrections remain immutable behind `SLA_PRINTER_Z_CORRECTION_DEPENDENCY_UNAVAILABLE`. An
  omitted request is a no-op; a non-zero request returns the typed error instead of borrowing FFF defaults.

Pad (Pad.cpp + ConcaveHull + Tesselate/glu-libtess, LINKED):
- Prusa's `SLA/Pad.cpp` group is linked verbatim: `ConcaveHull.cpp` (the merged-pad silhouette),
  `Tesselate.cpp` over the bundled SGI `glu-libtess` (compiled as C — its header is `extern "C"` — with
  `-include limits.h` for a missing `<limits.h>`), and Orca's `TriangulateWall.hpp` for the walls (its only
  difference is the `Vec3i32` spelling, which the Point.hpp veneer aliases back). `pad_capability()` reports
  `SLA_PAD_SUPPORTED` / backend `prusa_port`, and `slice_sla` sets `pad_parity_status=upstream`.
- The driver is `slasupport_bridge::generate_pad`, the port of upstream `SupportTree.cpp:71`: blueprint the
  support mesh (and, with supports off, the model) over the foot band `[0, full_height + 0.1]`, then
  `Pad.cpp::create_pad`. Pad geometry comes out with its top at z=0 and is stood ON the plate instead; the
  scene above rises by `ceil(full_height / layer_height)` layers — upstream's rebase at slicing time.
- `pad_around_object` (embed / zero elevation) stays a typed unsupported error
  (`SLA_PAD_AROUND_OBJECT_UNSUPPORTED`): the geometry exists upstream but the zero-elevation frame (object
  seated into the pad plate, bottom point filtering) is not wired in this driver yet.
- With `pad_enable=false`, no role-6 paths or pad mesh are emitted. `test_sla_pad.mjs` locks omission, the
  supported capability, the lifted layer frame, and the embed gate.
