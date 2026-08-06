#!/usr/bin/env bash
# Build of the browser-only slicing mini kernel (track C)
# Output: ../engine/src/slicer_core.js  (SINGLE_FILE=1 -> the wasm is inlined as base64,
#         no external .wasm fetch -> self-contained on any static server or vite preview)
#
# Stage 7: the real OrcaSlicer Arachne (WallToolPaths) port is linked in as well.
#  - The kernel's own clipper (global ClipperLib) and the Arachne port's clipper (Slic3r::ClipperLib / ClipperLib_Z) live in
#    different namespaces, so they coexist. Only arachne_bridge.cpp bridges the two worlds.
#  - Requires: brew boost (header-only voronoi) + brew eigen. Stubbed: tbb/boost-log/cereal/SVG/Flow/Config, etc.
set -euo pipefail

export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
# ccache wrapping: unchanged TUs are reused -> a single-file rebuild goes from minutes to tens of seconds. (brew install ccache)
command -v ccache >/dev/null && export EM_COMPILER_WRAPPER=ccache

cd "$(dirname "$0")"
# Stage 34: copy the deps into third_party/ -> removes the dependency on slicer/ (REPO can be deleted)
AP=arachne_port/libslic3r

# --- Arachne port sources (upstream verbatim + documented minimal edits) ---
ARACHNE_SRC="
  arachne_bridge.cpp
  $AP/Arachne/WallToolPaths.cpp
  $AP/Arachne/SkeletalTrapezoidation.cpp
  $AP/Arachne/SkeletalTrapezoidationGraph.cpp
  $AP/Arachne/utils/ExtrusionLine.cpp
  $AP/Arachne/utils/PolylineStitcher.cpp
  $AP/Arachne/utils/SquareGrid.cpp
  $AP/Arachne/BeadingStrategy/BeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/BeadingStrategyFactory.cpp
  $AP/Arachne/BeadingStrategy/DistributedBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/LimitedBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/OuterWallInsetBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/RedistributeBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/WideningBeadingStrategy.cpp
  $AP/Point.cpp $AP/Line.cpp $AP/Polygon.cpp $AP/Polyline.cpp $AP/MultiPoint.cpp
  $AP/BoundingBox.cpp $AP/ExPolygon.cpp $AP/ClipperUtils.cpp $AP/EdgeGrid.cpp
  $AP/Surface.cpp $AP/ArcFitter.cpp $AP/libslic3r.cpp $AP/Geometry.cpp
  $AP/Geometry/VoronoiUtils.cpp $AP/Geometry/Voronoi.cpp
  $AP/Geometry/VoronoiUtilsCgal.cpp

  $AP/clipper.cpp
  third_party/deps_src/clipper/clipper_z.cpp
"
# --- Stage 8: the ported real OrcaSlicer Fill patterns (gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/concentric) ---
C2=third_party/deps_src/clipper2/Clipper2Lib
FILL_SRC="
  fill_bridge.cpp
  $AP/Fill/FillBase.cpp $AP/Fill/FillGyroid.cpp $AP/Fill/FillHoneycomb.cpp
  $AP/Fill/Fill3DHoneycomb.cpp $AP/Fill/FillCrossHatch.cpp $AP/Fill/FillConcentric.cpp
  $AP/Fill/FillRectilinear.cpp
  $AP/ShortestPath.cpp $AP/ExtrusionEntityCollection.cpp $AP/Circle.cpp $AP/Clipper2Utils.cpp
  $C2/src/clipper.engine.cpp $C2/src/clipper.offset.cpp $C2/src/clipper.rectclip.cpp
"
# --- Stage 8: the ported real PressureEqualizer ---
PE_SRC="pe_bridge.cpp $AP/GCode/PressureEqualizer.cpp $AP/GCodeFormatter_impl.cpp"
# --- Stage 10: the ported GCodeProcessor time estimation algorithm ---
TIME_SRC="gcode_time.cpp"
# --- Stage 12: merge the real config subsystem (Config.cpp + PrintConfig.cpp) into the main build ---
#  Only config_bridge.cpp sits on the kernel <-> real PrintConfig boundary (same isolation as arachne_bridge). The config sources pull
#  the real headers from their own directory via "" relative includes, while Arachne/Fill/PE keep using the stub PrintConfig.hpp
#  (the enums are verbatim identical -> ODR-safe). No main TU includes boost/thread, so the empty boost/thread stubs under config/stubs
#  affect PrintConfig.cpp only.
CP=arachne_port/config/libslic3r
CONFIG_SRC="config_bridge.cpp $CP/Config.cpp $CP/PrintConfig.cpp $CP/MaterialType.cpp"
CONFIG_INC="-Iarachne_port/config/stubs"
# --- Stage 12 item 2: link the real WipeTower into the main build (wipe_tower_real). WipeTower.cpp uses the
#  GCodeProcessor stub in its own directory (-> real PrintConfig) and the TriangleMesh/Triangulation stubs in wipetower/inc.
#  role_to_string/localesutils_wasm are single-function/unity wrappers (avoiding the whole TU's Flow/PCH dependency). Arachne/Fill/PE
#  still use the stub PrintConfig — wipetower/inc only shadows libslic3r/TriangleMesh (prefix) and Triangulation, and no compiled TU in
#  the main build includes them (measured). Circle/ArcFitter/geometry are already linked.
WT=arachne_port/wipetower
WIPETOWER_SRC="$WT/GCode/WipeTower.cpp $WT/role_to_string.cpp $WT/localesutils_wasm.cpp"
CONFIG_INC="$CONFIG_INC -Iarachne_port/wipetower/inc"
# --- Stage 13: the real ported GCodeProcessor itself (time_engine=full). gcodeproc_bridge.cpp is the kernel <-> GCodeProcessor
#  boundary. GCodeProcessor.cpp uses the Print stub in gcodeproc/inc (2 symbols) and the boost::nowide/filesystem stubs in gcodeproc/stubs,
#  with PrintConfig going forwarder -> real. GCodeReader/MultiNozzleUtils/ArcWelder/Elegoo are ported and string_to_role is extracted as a
#  single function. ProjectTask uses a FilamentInfo stub. No pre-existing TU in the main build includes these stubs (measured).
GP=arachne_port/gcodeproc
GCODEPROC_SRC="gcodeproc_bridge.cpp $GP/GCode/GCodeProcessor.cpp $GP/GCode/ElegooGCodeProcessorHelper.cpp $GP/extrusion_role_helper.cpp $AP/GCodeReader.cpp $AP/MultiNozzleUtils.cpp $AP/Geometry/ArcWelder.cpp"
CONFIG_INC="$CONFIG_INC -Iarachne_port/gcodeproc/inc -Iarachne_port/gcodeproc/stubs"
# Includes for the Arachne/Fill ports (no effect on kernel sources — the kernel only includes arachne_bridge.h/fill_bridge.h)
# Stage 14: the real CGAL planarity check (VoronoiUtilsCgal). cgal_stubs overrides boost's wasm.hpp (dropping BOOST_NO_FENV_H
#  -> Boost.Multiprecision interval c99 rounding). CGAL 6.x is header-only (brew), with no GMP/MPFR linkage.
# --- Stage 18: integrate the real organic TreeSupport into the main build (treesupport_bridge, option (a) approved) ---
#  Stage-17 ODR findings: the shared-symbol approach already achieved an ODR-clean link and 120 green, and the only runtime wall was the
#  main build's FillBase factory STAGE-8 trim (new_from_type -> nullptr for ipSupportBase/ipRectilinear). Stage 18 restores that trim
#  additively (the STAGE-18 UNTRIM in FillBase.cpp above + adding FillRectilinear.cpp to FILL_SRC; a byte-diff of 0 against golden proves
#  the default path is unaffected), so the tree path also gets the real fillers. Only tree-specific sources are compiled in isolation into
#  separate relocatable objects (port headers resolved via file-relative includes) before joining the main link. Shared sources (Point/Polygon/
#  PrintConfig/Arachne/Fill*/Geometry/Voronoi/clipper, …) are not recompiled (header ABI verified identical; FillRectilinear/SupportBase are now
#  provided by the main build). The 2 conflicting symbols (ExtrusionEntity::role_to_string/string_to_role) are guarded with
#  -DTS_BRIDGE_EXCLUDE_ROLE_FNS (the main build provides role_to_string.cpp + extrusion_role_helper.cpp). The kernel <-> bridge boundary uses plain types only. -DNDEBUG applies to the tree group only.
TS=treesupport_port; TL=$TS/libslic3r
TS_UNIQUE_SRC="
  $TL/treesupport_bridge_impl.cpp $TL/selector_bridge_impl.cpp $TL/TriangleSelector.cpp
  $TL/Support/SupportCommon.cpp $TL/Support/TreeModelVolumes.cpp $TL/Support/TreeSupport3D.cpp $TL/Support/TreeSupport.cpp
  $TL/Support/SupportMaterial.cpp $TL/layerregion_flow_impl.cpp
  $TL/Flow.cpp $TL/Layer.cpp $TL/MutablePolygon.cpp $TL/BuildVolume.cpp $TL/SurfaceCollection.cpp
  $TL/TriangleMesh.cpp $TL/TriangleMeshSlicer.cpp
  $TL/Fill/FillLightning.cpp $TL/MinimumSpanningTree.cpp $TL/ExtrusionEntity.cpp
  $TL/Geometry/ConvexHull.cpp $TL/Geometry/Circle.cpp
  $TL/Fill/Lightning/DistanceField.cpp $TL/Fill/Lightning/Generator.cpp $TL/Fill/Lightning/Layer.cpp $TL/Fill/Lightning/TreeNode.cpp
"
TS_INC="-Iarachne_port/cgal_stubs -I$TS -I$TL -I$TL/Support -Ithird_party/deps_src -Ithird_party/deps_src/libnest2d/include -Ithird_party/deps_src/libigl -Ithird_party/deps_src/clipper2/Clipper2Lib/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
# ---- Parallel compile helper: compile one .o per source, as many at a time as there are cores (previously: a single em++ call = sequential compilation) ----
#  ccache (EM_COMPILER_WRAPPER) handles caching including header dependencies, so everything is invoked every time with no mtime-based incremental logic
#  — unchanged TUs hit the cache in ~0.1s. The link passes the .o files in source order to stay deterministic (golden).
NCPU=$(sysctl -n hw.ncpu 2>/dev/null || echo 8)
pcompile() {  # $1=objdir  $2=compile flags (string)  rest=source list
  local objdir="$1" flags="$2"; shift 2
  mkdir -p "$objdir"
  printf '%s\n' "$@" | OBJDIR="$objdir" CFLAGS="$flags" xargs -P "$NCPU" -I SRC bash -c '
    em++ $CFLAGS -c "SRC" -o "$OBJDIR/$(printf "%s" "SRC" | tr "/" "_").o"'
}
objs() {  # $1=objdir  rest=source list -> prints .o paths in source order
  local objdir="$1"; shift; local s
  for s in "$@"; do printf '%s/%s.o ' "$objdir" "$(printf '%s' "$s" | tr '/' '_')"; done
}

TS_GROUP_OBJ=/tmp/ts_group.o
TS_CFLAGS="-O2 -std=c++17 -DNDEBUG -DTS_BRIDGE_EXCLUDE_ROLE_FNS -DCGAL_DISABLE_ROUNDING_MATH_CHECK $TS_INC"
echo "compiling treesupport group (isolated, parallel x$NCPU) -> $TS_GROUP_OBJ"
pcompile /tmp/ws_obj/ts_st "$TS_CFLAGS" $TS_UNIQUE_SRC
em++ -O2 -r $(objs /tmp/ws_obj/ts_st $TS_UNIQUE_SRC) -o $TS_GROUP_OBJ

ARACHNE_INC="-Iarachne_port/cgal_stubs $CONFIG_INC -Iarachne_port/stubs -Iarachne_port -I$AP -Ithird_party/deps_src -I$C2/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"

# Speed flags, measured (2026-07-29, big_cyl arachne+support): -O3 -msimd128 gives 5183ms vs -O2 5149ms —
#  a 0.7% (noise-level) gain for +9% size (3.43 -> 3.74MB), so -O2 stays. -flto hits a wasm-ld SIGSEGV (conflict with -r partial linking).
#  -ffast-math is forbidden (breaks golden byte-identity). The bottleneck is scalar integer polygon math — the real lever is threading.
MAIN_SRC="slicer_core.cpp clipper.cpp $ARACHNE_SRC $FILL_SRC $PE_SRC $TIME_SRC $CONFIG_SRC $WIPETOWER_SRC $GCODEPROC_SRC"
# -DNDEBUG: turns off assert() exactly like an upstream OrcaSlicer release build (CMAKE_BUILD_TYPE=Release).
#  Without it, asserts upstream treats as "debug-only invariants" kill the worker in a shipped build — e.g. meshes with unwelded vertices and
#  sliver triangles, such as OCCT tessellations (STEP import), hit Voronoi.cpp:334 (*inside* the recovery routine),
#  VoronoiUtils.cpp:322 and FillBase.cpp:1407 (zero-length closed edge). Upstream has recovery paths for all of them, so they
#  slice fine in release. The tree support group (TS_CFLAGS) already had -DNDEBUG.
MAIN_CFLAGS="-O2 --bind -std=c++17 -DNDEBUG -DCGAL_DISABLE_ROUNDING_MATH_CHECK $ARACHNE_INC"
echo "compiling main sources (st, parallel x$NCPU)"
pcompile /tmp/ws_obj/st "$MAIN_CFLAGS" $MAIN_SRC
em++ -O2 --bind -std=c++17 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=4GB \
  -s STACK_SIZE=2MB \
  -s EXPORT_NAME=createSlicer \
  -s ENVIRONMENT=web,worker,node \
  -o ../engine/src/slicer_core.js \
  $(objs /tmp/ws_obj/st $MAIN_SRC) $TS_GROUP_OBJ

# webpack compatibility: webpack tries to statically resolve the dynamic import("node:module") inside the ENVIRONMENT_IS_NODE guard
# and fails (node: scheme) -> excluded with a webpackIgnore magic comment. Runtime behavior is unchanged (no effect on Vite/Node).
sed -i '' 's|await import("node:module")|await import(/* webpackIgnore: true */ "node:module")|' ../engine/src/slicer_core.js

echo "built -> ../engine/src/slicer_core.js"
ls -la ../engine/src/slicer_core.js

# ---- Multithreaded (mt) build: PASS 1 layers in parallel (__EMSCRIPTEN_PTHREADS__) ----
#  A separate artifact — the default (st) stays zero-config, while mt needs COOP/COEP (crossOriginIsolated) in the browser.
#  emscripten warns about the ALLOW_MEMORY_GROWTH + pthreads combination, but it is functionally valid (judged by measurement).
echo "compiling treesupport group (mt, parallel x$NCPU) -> /tmp/ts_group_mt.o"
pcompile /tmp/ws_obj/ts_mt "-pthread $TS_CFLAGS" $TS_UNIQUE_SRC
em++ -O2 -pthread -r $(objs /tmp/ws_obj/ts_mt $TS_UNIQUE_SRC) -o /tmp/ts_group_mt.o

echo "compiling main sources (mt, parallel x$NCPU)"
pcompile /tmp/ws_obj/mt "-pthread $MAIN_CFLAGS" $MAIN_SRC
em++ -O2 -pthread --bind -std=c++17 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=4GB \
  -s STACK_SIZE=2MB \
  -s DEFAULT_PTHREAD_STACK_SIZE=2MB \
  -s MALLOC=mimalloc \
  -s PTHREAD_POOL_SIZE='(typeof navigator!=="undefined"&&navigator.hardwareConcurrency)||4' \
  -s EXPORT_NAME=createSlicer \
  -s ENVIRONMENT=web,worker,node \
  -o ../engine/src/slicer_core.mt.js \
  $(objs /tmp/ws_obj/mt $MAIN_SRC) /tmp/ts_group_mt.o

sed -i '' 's|await import("node:module")|await import(/* webpackIgnore: true */ "node:module")|' ../engine/src/slicer_core.mt.js
# The same case applies to the pthread bootstrap in the mt glue: the dynamic import("node:worker_threads") inside the Node guard
sed -i '' 's|await import("node:worker_threads")|await import(/* webpackIgnore: true */ "node:worker_threads")|' ../engine/src/slicer_core.mt.js

echo "built -> ../engine/src/slicer_core.mt.js"
ls -la ../engine/src/slicer_core.mt.js
