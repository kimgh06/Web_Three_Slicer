#!/usr/bin/env bash
# Stage-7: link the ported Arachne + minimal libslic3r + clipper into a node-runnable test.
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."   # -> wasm-core
REPO=/Users/kim/Documents/github/web3d_slicer/web/wasm-core/third_party
INC="-Iarachne_port/stubs -Iarachne_port -Iarachne_port/libslic3r -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
L=arachne_port/libslic3r
SRC="
  $L/Arachne/WallToolPaths.cpp
  $L/Arachne/SkeletalTrapezoidation.cpp
  $L/Arachne/SkeletalTrapezoidationGraph.cpp
  $L/Arachne/utils/ExtrusionLine.cpp
  $L/Arachne/utils/PolylineStitcher.cpp
  $L/Arachne/utils/SquareGrid.cpp
  $L/Arachne/BeadingStrategy/BeadingStrategy.cpp
  $L/Arachne/BeadingStrategy/BeadingStrategyFactory.cpp
  $L/Arachne/BeadingStrategy/DistributedBeadingStrategy.cpp
  $L/Arachne/BeadingStrategy/LimitedBeadingStrategy.cpp
  $L/Arachne/BeadingStrategy/OuterWallInsetBeadingStrategy.cpp
  $L/Arachne/BeadingStrategy/RedistributeBeadingStrategy.cpp
  $L/Arachne/BeadingStrategy/WideningBeadingStrategy.cpp
  $L/Point.cpp $L/Line.cpp $L/Polygon.cpp $L/Polyline.cpp $L/MultiPoint.cpp
  $L/BoundingBox.cpp $L/ExPolygon.cpp $L/ClipperUtils.cpp $L/EdgeGrid.cpp
  $L/Surface.cpp $L/ArcFitter.cpp $L/Geometry/VoronoiUtils.cpp
  $L/libslic3r.cpp $L/Geometry.cpp $L/Geometry/Voronoi.cpp
  $L/clipper.cpp
  $REPO/deps_src/clipper/clipper_z.cpp
  ${EXTRA:-}
  arachne_port/test_arachne.cpp
"
em++ -O1 -std=c++17 $INC $SRC -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -o arachne_port/test_arachne.js 2>&1 | grep -viE "warning:|note:|In file included|macro redefined|previous definition|\^|~|^\s*\|" | head -40
