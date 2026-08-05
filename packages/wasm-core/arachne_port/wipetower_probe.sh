#!/usr/bin/env bash
# Stage-11: compile probe for WipeTower.cpp on the ported REAL PrintConfig (the config keystone
# unlocking WipeTower). Step 1 compiles WipeTower.cpp to an object file (proves it type-checks against
# the real StaticPrintConfig). GCodeProcessor / TriangleMesh / Triangulation are stubbed (documented).
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."   # -> wasm-core
REPO=/Users/kim/Documents/github/web3d_slicer/packages/wasm-core/third_party
CP=arachne_port/config/libslic3r
L=arachne_port/libslic3r
# wipetower/inc (mesh stubs) + wipetower/GCode (WipeTower + GCodeProcessor stub) + config/libslic3r
# (REAL PrintConfig.hpp — must precede arachne_port/libslic3r's stub PrintConfig.hpp) + config/stubs
# (boost/thread) + arachne_port (geometry, libslic3r/ prefix includes).
INC="-Iarachne_port/wipetower/inc -Iarachne_port/wipetower/GCode -I$CP -Iarachne_port/config/stubs -Iarachne_port/config -Iarachne_port/stubs -Iarachne_port -I$L -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"

echo "=== STEP 1: compile WipeTower.cpp -> object ==="
em++ -O1 -std=c++17 $INC -c arachne_port/wipetower/GCode/WipeTower.cpp -o arachne_port/wipetower/WipeTower.o 2>&1 \
  | grep -viE "warning:|note:|In file included|macro redefined|previous definition|\^|~|^\s*\|" | head -50
if [ -f arachne_port/wipetower/WipeTower.o ]; then
  echo ">>> WipeTower.cpp COMPILED to object ($(ls -la arachne_port/wipetower/WipeTower.o | awk '{print $5}') bytes)"
else
  echo ">>> WipeTower.cpp compile FAILED"; exit 1
fi

echo ""
echo "=== STEP 2: link WipeTower + real config + geometry + driver, run in node ==="
GEO="
  $CP/Config.cpp $CP/PrintConfig.cpp $CP/MaterialType.cpp
  $L/Point.cpp $L/Line.cpp $L/Polygon.cpp $L/Polyline.cpp $L/MultiPoint.cpp
  $L/BoundingBox.cpp $L/ExPolygon.cpp $L/ClipperUtils.cpp $L/Surface.cpp
  arachne_port/wipetower/localesutils_wasm.cpp $L/ArcFitter.cpp $L/Circle.cpp
  arachne_port/wipetower/role_to_string.cpp
  $L/libslic3r.cpp $L/Geometry.cpp $L/clipper.cpp
  $REPO/deps_src/clipper/clipper_z.cpp
"
em++ -O1 -std=c++17 $INC \
  arachne_port/wipetower/GCode/WipeTower.cpp $GEO arachne_port/test_wipetower.cpp \
  -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s TOTAL_STACK=16MB \
  -o arachne_port/test_wipetower.js 2>&1 \
  | grep -viE "warning:|note:|In file included|macro redefined|previous definition|\^|~|^\s*\|" | head -40
if [ -f arachne_port/test_wipetower.js ]; then
  echo ">>> LINK OK. RUN:"
  node arachne_port/test_wipetower.js
  rm -f arachne_port/test_wipetower.js
else
  echo ">>> LINK FAILED (see undefined symbols above)"
fi
