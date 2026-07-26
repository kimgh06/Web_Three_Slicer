#!/usr/bin/env bash
# Stage-19 #4: link + run the REAL ported TriangleSelector (manual support painting core), standalone.
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."
REPO=/Users/kim/Documents/github/web3d_slicer/web/wasm-core/third_party
P=treesupport_port; L=$P/libslic3r
INC="-Iarachne_port/cgal_stubs -I$P -I$L -I$L/Support -I$REPO/deps_src -I$REPO/deps_src/libnest2d/include -I$REPO/deps_src/libigl -I$REPO/deps_src/clipper2/Clipper2Lib/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
C2=$REPO/deps_src/clipper2/Clipper2Lib
SRC="
  $L/selector_bridge_impl.cpp $L/TriangleSelector.cpp $L/TriangleMesh.cpp $L/TriangleMeshSlicer.cpp
  $L/Point.cpp $L/Line.cpp $L/Polygon.cpp $L/Polyline.cpp $L/MultiPoint.cpp $L/BoundingBox.cpp $L/ExPolygon.cpp
  $L/ClipperUtils.cpp $L/Surface.cpp $L/EdgeGrid.cpp $L/ArcFitter.cpp $L/Circle.cpp $L/Geometry.cpp $L/libslic3r.cpp
  $L/MutablePolygon.cpp $L/SurfaceCollection.cpp $L/Geometry/ConvexHull.cpp $L/Geometry/Circle.cpp
  $L/ExtrusionEntity.cpp $L/ExtrusionEntityCollection.cpp $L/Clipper2Utils.cpp
  $P/localesutils_wasm.cpp $L/clipper.cpp $REPO/deps_src/clipper/clipper_z.cpp
  $C2/src/clipper.engine.cpp $C2/src/clipper.offset.cpp $C2/src/clipper.rectclip.cpp
  $P/test_selector.cpp
"
em++ -O1 -std=c++17 -DNDEBUG -DCGAL_DISABLE_ROUNDING_MATH_CHECK $INC $SRC -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s TOTAL_STACK=64MB -o $P/test_sel.js 2>&1 \
  | grep -viE "warning:|note:|In file included|macro redefined|previous definition|\^|~|^\s*\|" | grep -iE 'error|undefined' | head -40
if [ -f $P/test_sel.js ]; then echo "=== LINK OK. RUN ==="; node $P/test_sel.js; rm -f $P/test_sel.js $P/test_sel.wasm; else echo "=== LINK/COMPILE FAILED ==="; fi
