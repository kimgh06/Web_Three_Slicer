// surfaces.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "slice_ctx.h"

#include "clip_util.h"

#include <algorithm>
#include <atomic>
#include <thread>
#include <vector>

void surfaces_run(SliceCtx& C) {
  std::vector<LayerData>& L = *C.L;
  const int N = C.N;
  // ---- PASS 1.5: surface detection (this layer's fill − the neighboring contour) ----
  //  Per-layer independent (reads: immutable neighboring contours, writes: its own topSurf/botSurf) -> the same layer parallelism as PASS1.
  {
    auto surfOne = [&](int i){
      if (L[i].fill.empty()) return;
      Paths above = (i+1<N) ? L[i+1].contour : Paths{};
      Paths below = (i-1>=0) ? L[i-1].contour : Paths{};
      L[i].topSurf = clip_paths(L[i].fill, above, ctDifference);  // nothing above -> a top surface
      L[i].botSurf = clip_paths(L[i].fill, below, ctDifference);  // nothing below -> a bottom surface
    };
#ifdef __EMSCRIPTEN_PTHREADS__
    { unsigned hw = std::thread::hardware_concurrency();
      unsigned nt = std::max(1u, std::min<unsigned>(hw ? hw : 4, (unsigned)std::max(1, N)));
      std::atomic<int> nextIdx{0};
      auto workfn = [&]{ int i; while ((i = nextIdx.fetch_add(1)) < N) surfOne(i); };
      std::vector<std::thread> ths; ths.reserve(nt-1);
      for (unsigned t=1; t<nt; ++t) { try { ths.emplace_back(workfn); } catch (...) { break; } }
      workfn();
      for (auto& th : ths) th.join(); }
#else
    for (int i=0;i<N;++i) surfOne(i);
#endif
  }
}
