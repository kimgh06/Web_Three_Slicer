// STUB (stage 16): qhull is used by TriangleMesh.cpp in exactly one function, its_convex_hull_3d
// (3D convex hull of a mesh). The TreeSupport pipeline never computes a mesh 3D convex hull (the
// facade ModelObject carries an empty raw_mesh), so this function is compiled-but-unreached. These
// inline, library-free types let TriangleMesh.cpp compile AND link without the qhull library; if the
// function were ever called it returns an empty hull (facetList() is empty). Resolved ahead of any
// real libqhullcpp via -Itreesupport_port. QhullFacetList.h / QhullVertexSet.h are empty companions.
#pragma once
#include <vector>

typedef double realT;
typedef double coordT;

namespace orgQhull {

class QhullPoint {
public:
    QhullPoint() = default;
    QhullPoint(const QhullPoint&) = default;
    double operator[](int) const { return 0.0; }
};

class QhullVertex {
public:
    int       id()    const { return 0; }
    QhullPoint point() const { return QhullPoint(); }
};

class QhullVertexSet {
public:
    std::vector<QhullVertex>::const_iterator begin() const { return m_.begin(); }
    std::vector<QhullVertex>::const_iterator end()   const { return m_.end(); }
private:
    std::vector<QhullVertex> m_;
};

struct facetT { double normal[3] = {0.0, 0.0, 0.0}; };

class QhullFacet {
public:
    QhullVertexSet vertices()  const { return QhullVertexSet(); }
    facetT*        getBaseT()        { return &m_base; }
    const facetT*  getBaseT()  const { return &m_base; }
private:
    facetT m_base;
};

class QhullFacetList {
public:
    std::vector<QhullFacet>::const_iterator begin() const { return m_.begin(); }
    std::vector<QhullFacet>::const_iterator end()   const { return m_.end(); }
private:
    std::vector<QhullFacet> m_;
};

class Qhull {
public:
    Qhull() = default;
    void          disableOutputStream() {}
    void          runQhull(const char*, int, int, const realT*, const char*) {}
    QhullFacetList facetList() { return QhullFacetList(); }
};

} // namespace orgQhull
