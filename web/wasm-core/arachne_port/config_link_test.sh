#!/usr/bin/env bash
# Stage-11: standalone compile+link+run probe of the ported real Config.cpp + PrintConfig.cpp
# subsystem (print_config_def global + FullPrintConfig). Isolated from the main slicer_core.js
# build: the config sources live in arachne_port/config/libslic3r and resolve their own overridden
# headers (real PrintConfig.hpp, stub Preset/Thumbnails/Utils) via "" relative includes, while
# geometry falls through to arachne_port/libslic3r. The main build keeps the stub PrintConfig.hpp.
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."   # -> wasm-core
REPO=/Users/kim/Documents/github/web3d_slicer/web/wasm-core/third_party
CP=arachne_port/config/libslic3r
L=arachne_port/libslic3r
INC="-Iarachne_port/config/stubs -Iarachne_port/config -Iarachne_port/stubs -Iarachne_port -I$L -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
SRC="
  $CP/Config.cpp
  $CP/PrintConfig.cpp
  $CP/MaterialType.cpp
  $L/Point.cpp $L/Line.cpp $L/Polygon.cpp $L/Polyline.cpp $L/MultiPoint.cpp
  $L/BoundingBox.cpp $L/ExPolygon.cpp $L/ClipperUtils.cpp
  $L/libslic3r.cpp $L/Geometry.cpp
  $L/clipper.cpp
  $REPO/deps_src/clipper/clipper_z.cpp
  ${EXTRA:-}
  arachne_port/test_config.cpp
"
em++ -O1 -std=c++17 $INC $SRC -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -s TOTAL_STACK=8MB \
  -o arachne_port/test_config.js 2>&1 | grep -viE "warning:|note:|In file included|macro redefined|previous definition|\^|~|^\s*\|" | head -60
if [ -f arachne_port/test_config.js ]; then
  echo "=== RUN ==="
  node arachne_port/test_config.js
  rm -f arachne_port/test_config.js
fi
