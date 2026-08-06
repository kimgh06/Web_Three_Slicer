// STUB (stage 15) → 실병렬 (WP-tbb): 기본은 기존과 동일한 직렬. tbb_stub::enabled() 구간
//  (브릿지 generate_normal — grid/snug)에서만 blocked_range 를 스레드 분할 실행한다.
//  분할 경계는 결정적이고 원본 tbb 사용 코드는 인덱스별 독립 슬롯에 쓰므로 결과 동일
//  (golden grid 케이스 byte-identical 로 검증). 예산(tbb_stub::budget) 소진 시 직렬 폴백 — 데드락 불가.
#pragma once
#include "blocked_range.h"
#include "stub_parallel.h"
#include <vector>
#include <thread>
namespace tbb {
struct simple_partitioner {};
struct auto_partitioner {};
struct affinity_partitioner {};
template<class I, class F> void parallel_for(const blocked_range<I>& r, const F& f) {
#ifdef __EMSCRIPTEN_PTHREADS__
  const size_t n = r.size();
  if (n > 1 && tbb_stub::enabled().load(std::memory_order_relaxed)) {
    int extra = tbb_stub::take((int)n - 1);
    if (extra > 0) {
      const size_t nt = (size_t)extra + 1;
      // 동적 분배 — 레이어별 비용 편차(오버행 있는 층만 무거움)로 균등 n/nt 분할은 놀았다
      //  (실측: top_contact_layers 14스레드에서 2.75×뿐, 동일 구조 base_layers 는 10×).
      //  작은 청크 + atomic 인덱스 워크스틸링. 청크 경계는 결정적, 결과는 인덱스별 독립 → 출력 동일.
      const size_t chunk = std::max<size_t>(1, n / (nt * 4));
      std::atomic<size_t> next{0};
      const I b = r.begin();
      auto work = [&]{
        for (;;) {
          size_t lo = next.fetch_add(chunk);
          if (lo >= n) break;
          size_t hi = lo + chunk < n ? lo + chunk : n;
          f(blocked_range<I>(b + (I)lo, b + (I)hi));
          tbb_stub::prog().fetch_add((uint32_t)(hi - lo));   // 실진행 틱(UI 폴링용)
        }
      };
      std::vector<std::thread> ths; ths.reserve(nt - 1);
      for (size_t t = 1; t < nt; ++t) {
        // emscripten 풀 워커 반납이 비동기라 순간 고갈 시 pthread_create EAGAIN → std::thread throw.
        //  치명상 대신 남은 청크를 호출자+기존 워커가 소화(결과 동일).
        try { ths.emplace_back(work); }
        catch (...) { break; }
      }
      work();
      for (auto& th : ths) th.join();
      tbb_stub::give(extra);
      return;
    }
  }
#endif
  f(r);
}
template<class R, class F> void parallel_for(const R& r, const F& f){ f(r); }
template<class R, class F, class P> void parallel_for(const R& r, const F& f, P&&){ parallel_for(r, f); }
template<class I, class F> void parallel_for(I b, I e, const F& f){
#ifdef __EMSCRIPTEN_PTHREADS__
  if (e > b && tbb_stub::enabled().load(std::memory_order_relaxed)) {
    parallel_for(blocked_range<I>(b, e), [&f](const blocked_range<I>& sub){
      for (I i = sub.begin(); i < sub.end(); ++i) f(i);
    });
    return;
  }
#endif
  for (I i = b; i < e; ++i) f(i);
}
namespace this_task_arena { inline int max_concurrency(){ return 1; } }
}
