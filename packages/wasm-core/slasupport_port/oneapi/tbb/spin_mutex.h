// oneapi/tbb/spin_mutex.h — SHIM over the treesupport tbb stub layout (flat include paths). The kernel runs
//  the SLA chain sequentially (ExecutionSeq), so a plain mutex satisfies the type without spinning.
#pragma once
#include <mutex>
namespace tbb { using spin_mutex = std::mutex; }
