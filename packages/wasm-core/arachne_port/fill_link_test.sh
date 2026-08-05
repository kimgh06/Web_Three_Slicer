#!/usr/bin/env bash
# Stage-8: link the ported Fill patterns + fill_bridge into a node-runnable test.
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."   # -> wasm-core
REPO=/Users/kim/Documents/github/web3d_slicer/packages/wasm-core/third_party
AP=arachne_port/libslic3r
C2=$REPO/deps_src/clipper2/Clipper2Lib
INC="-Iarachne_port/stubs -Iarachne_port -I$AP -I$REPO/deps_src -I$C2/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
SRC="
  fill_bridge.cpp
  $AP/Fill/FillBase.cpp $AP/Fill/FillGyroid.cpp $AP/Fill/FillHoneycomb.cpp
  $AP/Fill/Fill3DHoneycomb.cpp $AP/Fill/FillCrossHatch.cpp $AP/Fill/FillConcentric.cpp
  $AP/ShortestPath.cpp $AP/ExtrusionEntityCollection.cpp
  $AP/Point.cpp $AP/Line.cpp $AP/Polygon.cpp $AP/Polyline.cpp $AP/MultiPoint.cpp
  $AP/BoundingBox.cpp $AP/ExPolygon.cpp $AP/ClipperUtils.cpp $AP/EdgeGrid.cpp
  $AP/Surface.cpp $AP/ArcFitter.cpp $AP/Circle.cpp $AP/Clipper2Utils.cpp $AP/libslic3r.cpp $AP/Geometry.cpp
  $AP/Geometry/VoronoiUtils.cpp $AP/Geometry/Voronoi.cpp
  $AP/Arachne/WallToolPaths.cpp $AP/Arachne/SkeletalTrapezoidation.cpp
  $AP/Arachne/SkeletalTrapezoidationGraph.cpp $AP/Arachne/utils/ExtrusionLine.cpp
  $AP/Arachne/utils/PolylineStitcher.cpp $AP/Arachne/utils/SquareGrid.cpp
  $AP/Arachne/BeadingStrategy/BeadingStrategy.cpp $AP/Arachne/BeadingStrategy/BeadingStrategyFactory.cpp
  $AP/Arachne/BeadingStrategy/DistributedBeadingStrategy.cpp $AP/Arachne/BeadingStrategy/LimitedBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/OuterWallInsetBeadingStrategy.cpp $AP/Arachne/BeadingStrategy/RedistributeBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/WideningBeadingStrategy.cpp
  $AP/clipper.cpp $REPO/deps_src/clipper/clipper_z.cpp
  $C2/src/clipper.engine.cpp $C2/src/clipper.offset.cpp $C2/src/clipper.rectclip.cpp
  arachne_port/test_fill.cpp
"
em++ -O1 -std=c++17 $INC $SRC -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -o arachne_port/test_fill.js 2>&1 \
  | grep -viE "warning:|note:|In file included|macro redefined|previous definition|^\s*[0-9]+ \||^\s*\||~~~|\^" | head -40
