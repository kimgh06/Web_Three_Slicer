// WASM platform shim (stage 11): the real LocalesUtils.cpp only #includes <charconv> under _WIN32;
// its non-Windows branch uses std::stringstream / std::setprecision but relies on the desktop PCH
// for <sstream>/<iomanip>. Under emscripten (no PCH) that branch fails to find those. This wrapper
// prepends the headers and then includes the VERBATIM source unchanged (no edit to the ported file).
#include <sstream>
#include <iomanip>
#include "LocalesUtils.cpp"   // -> arachne_port/libslic3r/LocalesUtils.cpp (unmodified)
