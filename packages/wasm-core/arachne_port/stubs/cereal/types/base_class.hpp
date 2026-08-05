// STUB (stage 8 port): cereal not in deps_src. ObjectID.hpp uses cereal::base_class<T>(this) inside
// serialize() templates that the port never instantiates. Minimal type suffices.
#pragma once
namespace cereal {
template <class T> struct base_class { const void* p; base_class(const void* ptr) : p(ptr) {} };
}
