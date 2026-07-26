#!/usr/bin/env bash
# Stage-14: compile probe for the real CGAL planarity check (VoronoiUtilsCgal.cpp) under emscripten.
# Goal: header-only CGAL 6.x with Boost.Multiprecision backend (no GMP/MPFR link).
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."   # -> wasm-core
REPO=/Users/kim/Documents/github/web3d_slicer/web/wasm-core/third_party
L=arachne_port/libslic3r
INC="-Iarachne_port/cgal_stubs -Iarachne_port/stubs -Iarachne_port -I$L -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
# CGAL number-type backend: no CGAL_USE_GMP defined => CGAL 5.4+ falls back to Boost.Multiprecision.
DEFS="${DEFS:-}"
mkdir -p arachne_port/gcodeproc/obj 2>/dev/null; OBJ=arachne_port/vcgal_probe.o
em++ -O1 -std=c++17 $DEFS $INC -c $L/Geometry/VoronoiUtilsCgal.cpp -o $OBJ 2>&1 \
  | grep -E 'error:|fatal error:' | grep -viE 'note:' | sed -E 's#^.*/([A-Za-z0-9_]+\.[ch]pp?)#\1#' | sort | uniq -c | sort -rn | head -30
echo "=== result: $([ -f $OBJ ] && echo COMPILED || echo FAILED) ==="
rm -f $OBJ
