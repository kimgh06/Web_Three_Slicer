#!/usr/bin/env bash
# Stage-9: link the ported TreeSupport core (MinimumSpanningTree) branch-merge into a node test.
set -uo pipefail
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
cd "$(dirname "$0")/.."
REPO=/Users/kim/Documents/github/web3d_slicer/web/wasm-core/third_party; AP=arachne_port/libslic3r
em++ -O1 -std=c++17 -Iarachne_port/stubs -Iarachne_port -I$AP -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include \
  tree_bridge.cpp $AP/MinimumSpanningTree.cpp $AP/Point.cpp $AP/libslic3r.cpp arachne_port/test_tree.cpp \
  -s ENVIRONMENT=node -s ALLOW_MEMORY_GROWTH=1 -o arachne_port/test_tree.js 2>&1 | grep -iE "error:|undefined" | head
node arachne_port/test_tree.js
