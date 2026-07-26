#!/usr/bin/env bash
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14; export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."; REPO=/Users/kim/Documents/github/web3d_slicer/web/wasm-core/third_party; L=arachne_port/libslic3r
INC="-Iarachne_port/cgal_stubs -Iarachne_port/config -Iarachne_port/config/stubs -Iarachne_port/stubs -Iarachne_port -I$L -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
printf '#include "Print.hpp"\nint main(){return 0;}\n' > arachne_port/libslic3r/_printprobe.cpp
em++ -O0 -std=c++17 $INC -c arachne_port/libslic3r/_printprobe.cpp -o /tmp/pp.o 2>&1 | grep -E 'error:|fatal error:' | grep -viE 'note:' | sed -E 's#^.*/([A-Za-z0-9_]+\.[ch]pp?)#\1#' | sort -u | head -20
echo "Print.hpp: $([ -f /tmp/pp.o ] && echo COMPILES || echo BLOCKED)"; rm -f arachne_port/libslic3r/_printprobe.cpp /tmp/pp.o
