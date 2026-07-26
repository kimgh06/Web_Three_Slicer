#pragma once
namespace tbb { class spin_mutex { public: class scoped_lock { public: scoped_lock(){} scoped_lock(spin_mutex&){} void acquire(spin_mutex&){} void release(){} }; void lock(){} void unlock(){} }; }
