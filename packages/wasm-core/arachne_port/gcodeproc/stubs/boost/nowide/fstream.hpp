// STUB (stage 13): boost::nowide::ifstream/ofstream -> std (see cstdio stub rationale).
#pragma once
#include <fstream>
namespace boost { namespace nowide {
    using std::ifstream;
    using std::ofstream;
    using std::fstream;
} }
