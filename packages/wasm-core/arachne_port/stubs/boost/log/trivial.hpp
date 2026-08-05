// STUB (stage 7 Arachne port): boost/log/trivial.hpp → no-op sink (avoids linking boost_log).
// Arachne uses `BOOST_LOG_TRIVIAL(level) << msg;` for warnings only.
#pragma once
#include <ostream>
namespace boost { namespace log { namespace trivial {
enum severity_level { trace, debug, info, warning, error, fatal };
}}}
namespace slic3r_stub_log {
struct NullStream { template <class T> NullStream& operator<<(const T&) { return *this; } };
inline NullStream& sink() { static NullStream s; return s; }
}
#define BOOST_LOG_TRIVIAL(level) ::slic3r_stub_log::sink()
