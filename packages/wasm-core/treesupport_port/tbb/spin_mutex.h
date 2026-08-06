// STUB → 실뮤텍스 (WP-tbb): 병렬 구간에서 layer_storage 등 공유 상태 보호에 실제로 쓰인다.
//  pthreads 미지원 빌드는 기존 no-op 유지(직렬이라 락 불필요).
#pragma once
#ifdef __EMSCRIPTEN_PTHREADS__
#include <mutex>
namespace tbb {
class spin_mutex {
  std::mutex m;
public:
  class scoped_lock {
    spin_mutex* p = nullptr;
  public:
    scoped_lock() {}
    scoped_lock(spin_mutex& mm) : p(&mm) { p->m.lock(); }
    ~scoped_lock(){ if (p) p->m.unlock(); }
    void acquire(spin_mutex& mm){ p = &mm; p->m.lock(); }
    void release(){ if (p){ p->m.unlock(); p = nullptr; } }
  };
  void lock(){ m.lock(); }
  void unlock(){ m.unlock(); }
};
}
#else
namespace tbb { class spin_mutex { public: class scoped_lock { public: scoped_lock(){} scoped_lock(spin_mutex&){} void acquire(spin_mutex&){} void release(){} }; void lock(){} void unlock(){} }; }
#endif
