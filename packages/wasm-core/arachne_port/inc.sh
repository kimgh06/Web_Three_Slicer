#!/usr/bin/env bash
# include flags for the Arachne WASM port
export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
REPO=/Users/kim/Documents/github/web3d_slicer/packages/wasm-core/third_party
INC="-Iarachne_port/stubs -Iarachne_port -Iarachne_port/libslic3r -I$REPO/deps_src -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
echo "$INC"
