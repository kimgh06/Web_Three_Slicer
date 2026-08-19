// Point.hpp — compat VENEER, not a copy: the Orca-generation Point.hpp underneath (include_next continues the
//  search past this directory) plus the alias the Prusa-generation SLA sources expect. Orca renamed Vec3i to
//  Vec3i32 and left the old alias commented out; both spell the same Eigen type, so re-adding it here cannot
//  diverge from anything.
#pragma once
#include_next <libslic3r/Point.hpp>
namespace Slic3r { using Vec3i = Eigen::Matrix<int, 3, 1, Eigen::DontAlign>; }
