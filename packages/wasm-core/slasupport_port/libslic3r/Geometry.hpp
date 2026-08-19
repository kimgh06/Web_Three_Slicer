// Geometry.hpp — compat VENEER: the Orca-generation Geometry.hpp underneath plus the spherical-coordinate
//  helpers the Prusa-generation SLA sources call (copied verbatim from PrusaSlicer Geometry.hpp:545-566;
//  the Orca fork never carried them).
#pragma once
#include_next <libslic3r/Geometry.hpp>
#include <cmath>
#include <utility>

namespace Slic3r { namespace Geometry {

template<class Tout = double, class Tin>
std::pair<Tout, Tout> dir_to_spheric(const Vec<3, Tin> &n, Tout norm = 1.)
{
    Tout z       = n.z();
    Tout r       = norm;
    Tout polar   = std::acos(z / r);
    Tout azimuth = std::atan2(n(1), n(0));
    return {polar, azimuth};
}

template<class T = double>
Vec<3, T> spheric_to_dir(double polar, double azimuth)
{
    return {T(std::cos(azimuth) * std::sin(polar)),
            T(std::sin(azimuth) * std::sin(polar)), T(std::cos(polar))};
}

template <class T = double, class Pair>
Vec<3, T> spheric_to_dir(const Pair &v)
{
    double plr = std::get<0>(v), azm = std::get<1>(v);
    return spheric_to_dir<T>(plr, azm);
}

}} // namespace Slic3r::Geometry
