#pragma once
#include "blocked_range.h"
namespace tbb {
template<class R, class F> void parallel_for(const R& r, const F& f){ f(r); }
template<class I, class F> void parallel_for(I b, I e, const F& f){ for(I i=b;i<e;++i) f(i); }
namespace this_task_arena { inline int max_concurrency(){ return 1; } }
}
