#!/usr/bin/env bash
# Stage-10: standalone check of the ported GCodeProcessor time algorithm (trapezoidal planner).
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."
em++ -O1 -std=c++17 gcode_time.cpp arachne_port/test_time.cpp \
  -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -o arachne_port/test_time.js 2>&1 | grep -iE "error:" | head
node arachne_port/test_time.js
rm -f arachne_port/test_time.js
