// STUB (stage 7 Arachne port): SVG debug output. All Arachne SVG use is under #ifdef
// ARACHNE_DEBUG, but EdgeGrid.cpp/Surface.cpp have non-guarded debug helpers that reference
// SVG members. All methods are no-ops (no SVG is ever produced by the port).
#pragma once
#include <string>
namespace Slic3r {
class SVG {
public:
    template <class... A> SVG(A&&...) {}
    template <class... A> void draw(A&&...) {}
    template <class... A> void draw_outline(A&&...) {}
    template <class... A> void draw_text(A&&...) {}
    template <class... A> void draw_legend(A&&...) {}
    template <class... A> void writePoints(A&&...) {}
    template <class... A> void writePolyline(A&&...) {}
    template <class... A> void nextLayer(A&&...) {}
    void Close() {}
    template <class... A> static void export_expolygons(A&&...) {}
};
} // namespace Slic3r
