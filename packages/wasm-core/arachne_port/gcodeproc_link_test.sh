#!/usr/bin/env bash
# Stage-13: link+run the real ported GCodeProcessor (7561L) + its deps on a sample g-code.
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."   # -> wasm-core
REPO=/Users/kim/Documents/github/web3d_slicer/packages/wasm-core/third_party
GP=arachne_port/gcodeproc
L=arachne_port/libslic3r
CP=arachne_port/config/libslic3r
INC="-I$GP/inc -I$GP/GCode -I$GP/stubs -Iarachne_port/config -Iarachne_port/config/libslic3r -Iarachne_port/config/stubs -Iarachne_port/stubs -Iarachne_port -Iarachne_port/libslic3r -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
SRC="
  $GP/GCode/GCodeProcessor.cpp $GP/GCode/ElegooGCodeProcessorHelper.cpp
  $GP/extrusion_role_helper.cpp
  $L/GCodeReader.cpp $L/MultiNozzleUtils.cpp $L/Geometry/ArcWelder.cpp
  $CP/Config.cpp $CP/PrintConfig.cpp $CP/MaterialType.cpp
  $L/Point.cpp $L/Line.cpp $L/Polygon.cpp $L/Polyline.cpp $L/MultiPoint.cpp
  $L/BoundingBox.cpp $L/ExPolygon.cpp $L/ClipperUtils.cpp $L/Surface.cpp $L/EdgeGrid.cpp
  arachne_port/wipetower/localesutils_wasm.cpp
  $L/libslic3r.cpp $L/Geometry.cpp $L/clipper.cpp
  $REPO/deps_src/clipper/clipper_z.cpp
  ${EXTRA:-}
  $GP/test_gcodeproc.cpp
"
em++ -O1 -std=c++17 $INC $SRC -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s TOTAL_STACK=32MB \
  -o $GP/test_gcodeproc.js 2>&1 \
  | grep -viE "warning:|note:|In file included|macro redefined|previous definition|\^|~|^\s*\|" | grep -E 'error|undefined' | head -40
if [ -f $GP/test_gcodeproc.js ]; then
  echo "=== LINK OK. RUN ==="
  node $GP/test_gcodeproc.js
  rm -f $GP/test_gcodeproc.js
else
  echo "=== LINK/COMPILE FAILED ==="
fi
