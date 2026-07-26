// STUB (stage 15): tbb -> sequential. blocked_range exposes begin()/end()/size().
#pragma once
#include <cstddef>
namespace tbb {
template<class I> class blocked_range {
public: blocked_range(I b, I e, size_t=1):m_b(b),m_e(e){} I begin() const {return m_b;} I end() const {return m_e;}
    size_t size() const {return size_t(m_e-m_b);} bool empty() const {return m_e<=m_b;}
private: I m_b,m_e; };
}
