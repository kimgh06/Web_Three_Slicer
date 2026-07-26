// STUB (stage 16): Semver is version-compare machinery that NO file in the TreeSupport link set uses
// (Config.cpp / PrintConfig.cpp / the Support/* sources reference it zero times). It only enters the
// build transitively via AppConfig.hpp, whose members store a Semver by value. The real header pulls
// boost/optional.hpp, whose resolution flakes under load in the em++ sandbox on large translation units
// (e.g. TriangleMeshSlicer.cpp). This minimal, boost-free type satisfies the transitive users
// (AppConfig.hpp: default ctor / Semver::invalid(); PresetBundle.hpp: default ctor by value). Documented.
#ifndef slic3r_Semver_hpp_
#define slic3r_Semver_hpp_

#include <string>
#include <cstdint>

namespace Slic3r {

class Semver {
public:
    Semver() = default;
    Semver(int maj, int min, int patch) : m_maj(maj), m_min(min), m_patch(patch) {}
    static Semver invalid() { return Semver(-1, 0, 0); }
    static Semver zero()    { return Semver(0, 0, 0); }
    int  maj()   const { return m_maj; }
    int  min()   const { return m_min; }
    int  patch() const { return m_patch; }
    std::string to_string() const {
        return std::to_string(m_maj) + "." + std::to_string(m_min) + "." + std::to_string(m_patch);
    }
    bool operator==(const Semver &o) const { return m_maj == o.m_maj && m_min == o.m_min && m_patch == o.m_patch; }
    bool operator!=(const Semver &o) const { return !(*this == o); }
    bool operator< (const Semver &o) const {
        return m_maj != o.m_maj ? m_maj < o.m_maj : (m_min != o.m_min ? m_min < o.m_min : m_patch < o.m_patch);
    }
    bool operator<=(const Semver &o) const { return *this < o || *this == o; }
    bool operator> (const Semver &o) const { return o < *this; }
    bool operator>=(const Semver &o) const { return o <= *this; }
private:
    int m_maj = 0, m_min = 0, m_patch = 0;
};

} // namespace Slic3r
#endif
