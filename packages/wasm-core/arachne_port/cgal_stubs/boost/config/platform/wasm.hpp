//  STUB/OVERRIDE (stage 14 CGAL port): copy of boost/config/platform/wasm.hpp with the final
//  `#define BOOST_NO_FENV_H` REMOVED. Boost's stock wasm config assumes wasm's fenv.h lacks the
//  C++11 macros, but emscripten provides fenv.h (fesetround / FE_UPWARD / FE_DOWNWARD). With
//  BOOST_NO_FENV_H undefined, Boost.Numeric.Interval takes its c99_rounding_control path (used by
//  CGAL's Interval_nt_advanced filtered kernel) instead of erroring "specify rounding control".
//  NOTE: wasm has no hardware FP rounding-mode register; emscripten's fesetround may be a no-op, so
//  interval bounds are not guaranteed conservative to the ULP. CGAL uses the interval only as a
//  FILTER — inconclusive cases fall back to the exact MP_Float / Epeck path (software, correct). So
//  the planarity result is faithful; only rare near-degenerate cases might do extra exact work.
#define BOOST_PLATFORM "Wasm"
#ifdef __has_include
#if __has_include(<unistd.h>)
#  define BOOST_HAS_UNISTD_H
#endif
#endif
#include <boost/config/detail/posix_features.hpp>
