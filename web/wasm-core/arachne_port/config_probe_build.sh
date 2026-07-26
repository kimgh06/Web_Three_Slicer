#!/usr/bin/env bash
# Stage-11: build the embind config-probe module (ported real Config/PrintConfig subsystem) as an
# ES6 single-file WASM module runnable from node. Isolated from the main slicer_core.js build.
# Output: arachne_port/config_probe.mjs  (git-ignored; regenerate on demand).
set -euo pipefail
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
  arachne_port/config_probe.cpp
"
em++ -O2 --bind -std=c++17 \
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s SINGLE_FILE=1 -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORT_NAME=createConfigProbe -s ENVIRONMENT=node \
  $INC $SRC \
  -o arachne_port/config_probe.mjs
echo "built -> arachne_port/config_probe.mjs"
ls -la arachne_port/config_probe.mjs
