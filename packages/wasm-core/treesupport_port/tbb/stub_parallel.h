// (성능) tbb 스텁 실병렬 공통부 — treesupport_port 전용.
//  기본은 기존과 동일한 직렬. 브릿지(generate_normal, grid/snug)가 ParallelScope 로 켠 구간에서만
//  parallel_for/task_group 이 실제 스레드를 사용한다. tree 경로는 concurrent_* 스텁이 비스레드안전
//  (std alias)이라 의도적으로 직렬 유지 — 플래그를 켜지 않는다.
//  budget: 중첩 스폰으로 emscripten pthread 풀(hardwareConcurrency)을 초과하지 않도록 전역 예산제.
//  예산 소진 시 호출자 스레드에서 직렬 실행(정합성 동일, 데드락 불가).
#pragma once
#include <atomic>
#include <thread>

namespace tbb_stub {

inline std::atomic<bool>& enabled() { static std::atomic<bool> v{false}; return v; }

inline std::atomic<int>& budget() {
  // 폭 hw-1 — 초기 크래시는 task_group 스레딩 비활성화로 해소됐고(대형 모델 st==mt byte-identical),
  //  parallel_for 단독 전폭 구성은 golden + 대형 모델 gcode 대조로 검증한다.
  static std::atomic<int> b((int)(std::thread::hardware_concurrency() > 1
                                  ? std::thread::hardware_concurrency() - 1 : 0));
  return b;
}
inline int take(int want) {
  int cur = budget().load(std::memory_order_relaxed);
  while (cur > 0) {
    int k = want < cur ? want : cur;
    if (budget().compare_exchange_weak(cur, cur - k)) return k;
  }
  return 0;
}
inline void give(int k) { budget().fetch_add(k); }

// 서포트 실진행 카운터 — parallel_for 인덱스 완료·task_group run 완료가 올린다.
//  UI(메인 스레드)가 SAB 로 직접 폴링(콜백 불가 구간의 진행 표시). 단위: 대략 "레이어 처리 1회".
inline std::atomic<uint32_t>& prog() { static std::atomic<uint32_t> v{0}; return v; }

// 브릿지가 병렬 허용 구간을 감싸는 RAII — 진입 시 진행 카운터 리셋
struct ParallelScope {
  ParallelScope()  { prog().store(0); enabled().store(true); }
  ~ParallelScope() { enabled().store(false); }
};

} // namespace tbb_stub
