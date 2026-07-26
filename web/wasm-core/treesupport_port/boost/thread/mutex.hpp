// STUB (stage 16): TriangleMeshSlicer.cpp includes <boost/thread/mutex.hpp>; the real header requires
// -pthread (unavailable in this single-threaded WASM port -> "Boost threads unavailable"). The port runs
// sequentially, so boost::mutex maps to std::mutex. Resolved ahead of /opt/homebrew/include via -Itreesupport_port.
#pragma once
#include <mutex>
namespace boost {
using mutex = std::mutex;
using recursive_mutex = std::recursive_mutex;
}
