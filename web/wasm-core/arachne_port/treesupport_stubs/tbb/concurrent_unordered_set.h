#pragma once
#include <unordered_set>
namespace tbb { template<class K, class H=std::hash<K>, class E=std::equal_to<K>>
using concurrent_unordered_set = std::unordered_set<K,H,E>; }
