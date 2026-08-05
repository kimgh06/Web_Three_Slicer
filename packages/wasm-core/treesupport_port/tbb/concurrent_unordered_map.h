#pragma once
#include <unordered_map>
namespace tbb { template<class K,class V,class H=std::hash<K>,class E=std::equal_to<K>>
using concurrent_unordered_map = std::unordered_map<K,V,H,E>; }
