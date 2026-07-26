#!/usr/bin/env bash
# Stage-13: compile probe for GCodeProcessor.cpp (7561L) on the unlocked real config.
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."   # -> wasm-core
REPO=/Users/kim/Documents/github/web3d_slicer/web/wasm-core/third_party
GP=arachne_port/gcodeproc
INC="-I$GP/inc -I$GP/GCode -I$GP/stubs -Iarachne_port/config -Iarachne_port/config/libslic3r -Iarachne_port/config/stubs -Iarachne_port/stubs -Iarachne_port -Iarachne_port/libslic3r -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
mkdir -p $GP/obj
em++ -O0 -std=c++17 $INC -c $GP/GCode/GCodeProcessor.cpp -o $GP/obj/GCodeProcessor.o 2>&1 \
  | grep -E 'error:|fatal error:' | grep -viE 'note:' | sed -E 's#^.*/([A-Za-z0-9_]+\.[ch]pp)#\1#' | sort | uniq -c | sort -rn | head -40
echo "=== result: $([ -f $GP/obj/GCodeProcessor.o ] && echo COMPILED || echo FAILED) ==="
