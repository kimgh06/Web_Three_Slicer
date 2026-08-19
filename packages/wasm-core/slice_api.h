// slice_api.h — the slice() entry point shared by slicer_core.cpp (definition) and bindings.cpp (embind).
#pragma once
#include <emscripten/val.h>
#include <string>

namespace em = emscripten;

// slice(Uint8Array stl, string paramsJson, function onProgress) → { gcode, stats, layers[] }
em::val slice(em::val stl_bytes, std::string params_json, em::val onProgress);

// slice_sla(Uint8Array stl, string paramsJson, function onProgress) → { stats, layers[] } — resin contours +
//  generated supports/pad, no G-code. Streams through the same layer sink slice() uses. (slice_sla.cpp)
em::val slice_sla(em::val stl_bytes, std::string params_json, em::val onProgress);
