// Stage-13 UNIFICATION: this location used to hold the lean stub (InfillPattern enum + forward
// decls) that let Arachne/Fill/PE compile without the full config machinery. Stage-12 merged the
// real config into the main build; stage-13's full GCodeProcessor needs the REAL PrintConfig visible
// to headers that live in this directory (calib.hpp / MultiNozzleUtils.hpp include "PrintConfig.hpp"
// same-dir → previously got the stub, colliding with the real one pulled elsewhere in the same TU).
// Fix per coordinator's sanctioned "include 경로 통일": forward to the canonical real header. One
// PrintConfig for the whole tree now (guard slic3r_PrintConfig_hpp_ dedups). Old stub kept as
// PrintConfig_stub.hpp.bak for reference. Main build re-verified 120-green after this change.
#pragma once
#include "../config/libslic3r/PrintConfig.hpp"
