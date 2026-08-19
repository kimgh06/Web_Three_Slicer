// Utils.hpp — compat VENEER, not a copy: the Orca-generation Utils.hpp stub underneath (include_next
//  continues the search past this directory) plus ScopeGuard, which the Prusa-generation SLA sources
//  use (UniformSupportIsland.cpp) and the Orca stub does not carry. The class is upstream
//  PrusaSlicer src/libslic3r/Utils.hpp:289, verbatim.
#pragma once
#include_next <libslic3r/Utils.hpp>
#include <functional>
namespace Slic3r {

class ScopeGuard
{
public:
    typedef std::function<void()> Closure;
    Closure closure;

public:
    ScopeGuard() {}
    ScopeGuard(Closure closure) : closure(std::move(closure)) {}
    ScopeGuard(const ScopeGuard&) = delete;
    ScopeGuard(ScopeGuard &&other) : closure(std::move(other.closure)) {}

    ~ScopeGuard()
    {
        if (closure) { closure(); }
    }

    ScopeGuard& operator=(const ScopeGuard&) = delete;
    ScopeGuard& operator=(ScopeGuard &&other)
    {
        closure = std::move(other.closure);
        return *this;
    }

    void reset() { closure = Closure(); }
};

} // namespace Slic3r
