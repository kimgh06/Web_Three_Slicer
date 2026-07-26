// STUB (stage 16): TriangleMeshSlicer.cpp uses boost::lock_guard<std::mutex>; map to std::lock_guard
// (single-threaded WASM port, same RAII scoped-lock semantics). Real boost/thread pulls the pthreads
// backend that is unavailable here. Resolved ahead of /opt/homebrew/include via -Itreesupport_port.
#pragma once
#include <mutex>
namespace boost {
template <class Mutex> using lock_guard = std::lock_guard<Mutex>;
}
