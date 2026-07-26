// STUB (stage 11 config port): PrintConfig.cpp does `#include <boost/thread.hpp>` but references NO
// boost::thread / mutex / once symbol (verified by grep). The real boost/thread.hpp fails under
// emscripten (no -pthread) with "Boost threads unavailable on this platform". Empty stub, resolved
// ahead of /opt/homebrew/include via -Iarachne_port/config/stubs (config-probe build only; the main
// slicer_core.js build never sees this dir).
#pragma once
