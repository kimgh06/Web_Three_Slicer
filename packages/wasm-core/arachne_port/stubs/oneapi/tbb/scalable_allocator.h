// STUB (stage 7 Arachne port): oneapi/tbb/scalable_allocator → std::allocator.
// Point.hpp only uses tbb::scalable_allocator<T> as the Points vector allocator.
#pragma once
#include <memory>
namespace tbb {
template <class T> using scalable_allocator = std::allocator<T>;
}
