// slice_api.h — the slice() entry point shared by slicer_core.cpp (definition) and bindings.cpp (embind).
#pragma once
#include <emscripten/val.h>
#include <string>

namespace em = emscripten;

// slice(Uint8Array stl, string paramsJson, function onProgress) → { gcode, stats, layers[] }
em::val slice(em::val stl_bytes, std::string params_json, em::val onProgress);
