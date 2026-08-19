// libslic3r.h — compat VENEER, not a copy: the Orca-generation libslic3r.h underneath plus the tuple
// helpers Prusa's NLoptOptimizer.hpp uses (for_each_in_tuple lives in Prusa's libslic3r.h:479).
#pragma once
#include_next <libslic3r/libslic3r.h>
#include <tuple>
#include <utility>
namespace Slic3r {

template<class Fn, class...Args>
Fn for_each_argument(Fn fn, Args&&...args)
{
    (fn(std::forward<Args>(args)), ...);
    return fn;
}

// Call fn on each element of the input tuple tup.
template<class Fn, class Tup>
Fn for_each_in_tuple(Fn fn, Tup &&tup)
{
    auto mpfn = [&fn](auto&...pack) {
        for_each_argument(fn, pack...);
    };

    std::apply(mpfn, tup);

    return fn;
}

} // namespace Slic3r
