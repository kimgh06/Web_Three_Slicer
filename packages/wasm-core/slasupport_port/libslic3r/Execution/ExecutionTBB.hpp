// SHADOW over treesupport_port's sequential ExecutionTBB stub, for the SLA group only (SLA_INC puts
// -Islasupport_port first, and SupportPointGenerator.cpp includes this before anything that could pull
// the treesupport copy). Here ExecutionTBB is a REAL parallel policy backed by the tbb stub's pthread
// parallel_for — which runs threads only inside a tbb_stub::ParallelScope in an mt build and stays
// serial everywhere else, so the st kernel's behavior and bytes are untouched. The scope is opened by
// slasupport_bridge around slice_mesh_ex + prepare_generator_data, whose work is per-layer independent
// with deterministic per-slot writes (byte-identical to serial); generate_support_points stays OUTSIDE
// the scope because its mutex-guarded result collection would make output order thread-dependent.
//
// Two deliberate deviations from upstream's ExecutionTBB.hpp, both for st==mt byte parity:
//   - reduce stays sequential (a parallel merge would reorder float accumulation),
//   - max_concurrency stays 1 (DefaultSupportTree/SupportTreeUtils size work chunks with it; st and mt
//     must make the same choices — this also matches what every other group's sequential stub reports).
#ifndef EXECUTIONTBB_HPP
#define EXECUTIONTBB_HPP

#include <libslic3r/Execution/Execution.hpp>
#include <libslic3r/Execution/ExecutionSeq.hpp>  // IsSequentialEP_ machinery (ExecutionTBB stays non-sequential)
#include <tbb/parallel_for.h>
#include <exception>
#include <mutex>

namespace Slic3r {

struct ExecutionTBB {};
template<> struct IsExecutionPolicy_<ExecutionTBB> : public std::true_type {};

static constexpr ExecutionTBB ex_tbb = {};

// Partial specialization over any cv-ref spelling of the policy: the SpinningMutex/BlockingMutex
// aliases in Execution.hpp instantiate Traits with the DECLARED type (e.g. const ExecutionTBB &),
// while for_each/max_concurrency go through AsTraits (remove_cvref) — both must land here, exactly
// as the sequential Traits' SequentialEPOnly matcher does for its policies.
template<class EP>
struct execution::Traits<EP, std::enable_if_t<std::is_same<remove_cvref_t<EP>, ExecutionTBB>::value, void>> {
private:
    template<class Fn, class It>
    static IteratorOnly<It, void> loop_(It from, It to, Fn &&fn)
    {
        for (auto it = from; it != to; ++it) fn(*it);
    }

    template<class Fn, class I>
    static IntegerOnly<I, void> loop_(I from, I to, Fn &&fn)
    {
        for (I i = from; i < to; ++i) fn(i);
    }

public:
    using SpinningMutex = std::mutex;   // real locks — the loop may actually run on threads here
    using BlockingMutex = std::mutex;

    // Iterator ranges stay serial: the only iterator-based callers are in the tree phase, which runs
    // outside any ParallelScope by design, and the tbb stub's chunk arithmetic is integer-only.
    template<class It, class Fn>
    static IteratorOnly<It, void> for_each(const ExecutionTBB &, It from, It to, Fn &&fn, size_t = 1)
    {
        loop_(from, to, std::forward<Fn>(fn));
    }

    template<class I, class Fn>
    static IntegerOnly<I, void> for_each(const ExecutionTBB &, I from, I to, Fn &&fn, size_t granularity = 1)
    {
        // The upstream loop bodies throw on cancel; an exception escaping a worker std::thread would
        // terminate. Catch per chunk, keep the first, rethrow on the calling thread — the serial path
        // behaves exactly as an uncaught throw did.
        std::exception_ptr first_error = nullptr;
        std::mutex error_mutex;
        tbb::parallel_for(tbb::blocked_range<I>(from, to, granularity),
                          [&](const tbb::blocked_range<I> &range) {
                              try {
                                  loop_(range.begin(), range.end(), fn);
                              } catch (...) {
                                  std::lock_guard<std::mutex> hold(error_mutex);
                                  if (!first_error) first_error = std::current_exception();
                              }
                          });
        if (first_error) std::rethrow_exception(first_error);
    }

    template<class I, class MergeFn, class T, class AccessFn>
    static T reduce(const ExecutionTBB &,
                    I          from,
                    I          to,
                    const T   &init,
                    MergeFn  &&mergefn,
                    AccessFn &&access,
                    size_t /*granularity*/ = 1)
    {
        T acc = init;
        loop_(from, to, [&](auto &i) { acc = mergefn(acc, access(i)); });
        return acc;
    }

    static size_t max_concurrency(const ExecutionTBB &) { return 1; }
};

} // namespace Slic3r

#endif // EXECUTIONTBB_HPP
