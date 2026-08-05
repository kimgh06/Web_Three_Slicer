// STUB (stage 13 GCodeProcessor port): boost::nowide wraps stdio for wide-char paths on Windows.
// Under emscripten paths are UTF-8 std already, and file I/O is never reached (WASM takes string
// input). Alias to std. Only fopen/remove are referenced.
#pragma once
#include <cstdio>
namespace boost { namespace nowide {
    using std::fopen;
    using std::remove;
    using std::fclose;
    using std::fwrite;
    using std::fread;
} }
