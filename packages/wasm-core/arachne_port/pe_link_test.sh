#!/usr/bin/env bash
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."
REPO=/Users/kim/Documents/github/web3d_slicer/packages/wasm-core/third_party; AP=arachne_port/libslic3r
INC="-Iarachne_port/stubs -Iarachne_port -I$AP -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
SRC="pe_bridge.cpp $AP/GCode/PressureEqualizer.cpp $AP/GCodeFormatter_impl.cpp
  $AP/Point.cpp $AP/libslic3r.cpp arachne_port/test_pe.cpp"
em++ -O1 -std=c++17 $INC $SRC -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -o arachne_port/test_pe.js 2>&1 \
  | grep -viE "warning:|note:|In file included|macro redefined|previous definition|^\s*[0-9]+ \||^\s*\||~~~|\^" | head -30
