// STUB → 실병렬 (WP-tbb): enabled 구간에서 run() 을 스레드로 스폰(예산제), 아니면 기존처럼 인라인.
#pragma once
#include "stub_parallel.h"
#include <vector>
#include <thread>
#include <utility>
#include <functional>
namespace tbb {
class task_group {
  std::vector<std::thread> ths;
public:
  // 1차: task_group 은 인라인 유지(스레딩 비활성). 대형 모델 mt abort 조사 중 — 병목의 ~85%
  //  (top_contacts 18.4s/base 7.2s/trim 3.5s, sup-prof 실측)는 parallel_for 쪽이라 이득 손실 미미.
  //  task_group 병렬 재활성은 크래시 원인 확정 후. (스레드 버전은 git 이력 참조)
  // [확정] task_group 스레딩은 조기 단순화(힙 4×↓) 이후에도 774k tri 에서 abort 재현(3/3, 2차 소크)
  //  → 원인은 메모리 압박이 아니라 포트 내부 레이스/UB. 인라인 영구 고정. (스레드 버전은 git 이력)
  template<class F> void run(F&& f){ f(); tbb_stub::prog().fetch_add(1); }   // 실진행 틱(UI 폴링용)

  void wait(){ for (auto& t : ths) t.join(); ths.clear(); }
  ~task_group(){ wait(); }
};
}
