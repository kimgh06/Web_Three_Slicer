// STUB (stage 8 port): real ExecutionTBB.hpp pulls Intel TBB (tbb/parallel_for, spin_mutex...).
// WASM port has no TBB, so we mark ExecutionTBB as a SEQUENTIAL execution policy — the sequential
// execution::Traits specialization in ExecutionSeq.hpp then handles for_each/reduce serially.
// MarchingSquares (used by FillGyroid) runs correctly, just single-threaded.
#ifndef EXECUTIONTBB_HPP
#define EXECUTIONTBB_HPP
#include "Execution.hpp"
#include "ExecutionSeq.hpp"

namespace Slic3r {
struct ExecutionTBB {};
template<> struct IsExecutionPolicy_<ExecutionTBB> : public std::true_type {};
template<> struct IsSequentialEP_<ExecutionTBB> : public std::true_type {};  // route to sequential Traits
static constexpr ExecutionTBB ex_tbb = {};
} // namespace Slic3r

#endif // EXECUTIONTBB_HPP
