// STUB -> real mutex (WP-tbb): genuinely used inside parallel scopes to protect shared state such as layer_storage.
//  Builds without pthreads keep the old no-op (serial execution needs no lock).
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
