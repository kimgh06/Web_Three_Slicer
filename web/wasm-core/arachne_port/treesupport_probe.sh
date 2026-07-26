#!/usr/bin/env bash
# Stage-16: isolated TreeSupport compile probe. All stubs consolidated under treesupport_port/ to
# minimize -I search (large files flake with many -I under the sandbox). main arachne_port untouched.
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."
REPO=/Users/kim/Documents/github/web3d_slicer/web/wasm-core/third_party
P=treesupport_port
INC="-I$P -I$P/libslic3r -I$P/libslic3r/Support -I$REPO/deps_src -I$REPO/deps_src/libnest2d/include -I$REPO/deps_src/libigl -I$REPO/deps_src/clipper2/Clipper2Lib/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
F="${1:-SupportCommon}"
em++ -O0 -std=c++17 $INC -c $P/libslic3r/Support/$F.cpp -o $P/ts_$F.o 2>&1 \
  | grep -E 'error:|fatal error:' | grep -viE 'note:' | sed -E 's#^.*/([A-Za-z0-9_]+\.[ch]pp?)#\1#' | sort | uniq -c | sort -rn | head -35
echo "=== $F.cpp: $([ -f $P/ts_$F.o ] && echo COMPILES || echo BLOCKED) ==="
rm -f $P/ts_$F.o
