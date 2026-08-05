// STUB extraction (stage 11 WipeTower port): WipeTower.cpp needs exactly one symbol from
// ExtrusionEntity.cpp — ExtrusionEntity::role_to_string(erWipeTower). Compiling the whole
// ExtrusionEntity.cpp TU would drag in Flow::bridging_flow (the trimmed Flow stub lacks it; the main
// build never compiles this TU). So the single function is reproduced verbatim from
// src/libslic3r/ExtrusionEntity.cpp here.
#include "ExtrusionEntity.hpp"
#include "I18N.hpp"
#include <cassert>
#include <string>

namespace Slic3r {

std::string ExtrusionEntity::role_to_string(ExtrusionRole role)
{
    switch (role) {
        case erNone                         : return L("Undefined");
        case erPerimeter                    : return L("Inner wall");
        case erExternalPerimeter            : return L("Outer wall");
        case erOverhangPerimeter            : return L("Overhang wall");
        case erInternalInfill               : return L("Sparse infill");
        case erSolidInfill                  : return L("Internal solid infill");
        case erTopSolidInfill               : return L("Top surface");
        case erBottomSurface                : return L("Bottom surface");
        case erIroning                      : return L("Ironing");
        case erBridgeInfill                 : return L("Bridge");
        case erInternalBridgeInfill         : return L("Internal Bridge");
        case erGapFill                      : return L("Gap infill");
        case erSkirt                        : return L("Skirt");
        case erBrim                         : return L("Brim");
        case erSupportMaterial              : return L("Support");
        case erSupportMaterialInterface     : return L("Support interface");
        case erSupportTransition            : return L("Support transition");
        case erWipeTower                    : return L("Prime tower");
        case erCustom                       : return L("Custom");
        case erMixed                        : return L("Multiple");
        default                             : assert(false);
    }
    return "";
}

} // namespace Slic3r
