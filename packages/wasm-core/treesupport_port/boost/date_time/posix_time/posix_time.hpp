// STUB (stage 16): TreeSupport.cpp uses boost::posix_time only for a stage-timing profiler. wasm has
// no need to link Boost.DateTime; a no-op clock is sufficient (profiling numbers are debug-only).
#pragma once
#include <cstdint>
namespace boost { namespace posix_time {
    struct time_duration {
        long long us = 0;
        long total_milliseconds() const { return long(us/1000); }
        long long total_microseconds() const { return us; }
        long total_seconds() const { return long(us/1000000); }
    };
    struct ptime {
        long long t = 0;
        time_duration operator-(const ptime& o) const { return time_duration{ t - o.t }; }
    };
    struct microsec_clock { static ptime local_time() { return ptime{}; } static ptime universal_time() { return ptime{}; } };
}}
