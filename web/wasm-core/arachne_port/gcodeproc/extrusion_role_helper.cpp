// STUB extraction (stage 13 GCodeProcessor port): GCodeProcessor needs ExtrusionEntity::string_to_role.
// Compiling the whole ExtrusionEntity.cpp TU drags in Flow::bridging_flow (trimmed Flow stub lacks it).
// So the single function is reproduced verbatim from src/libslic3r/ExtrusionEntity.cpp:611.
#include "ExtrusionEntity.hpp"
#include "libslic3r/I18N.hpp"
#include <string_view>

namespace Slic3r {

ExtrusionRole ExtrusionEntity::string_to_role(const std::string_view role)
{
    if (role == L("Inner wall")) return erPerimeter;
    else if (role == L("Outer wall")) return erExternalPerimeter;
    else if (role == L("Overhang wall")) return erOverhangPerimeter;
    else if (role == L("Sparse infill")) return erInternalInfill;
    else if (role == L("Internal solid infill")) return erSolidInfill;
    else if (role == L("Top surface")) return erTopSolidInfill;
    else if (role == L("Bottom surface")) return erBottomSurface;
    else if (role == L("Ironing")) return erIroning;
    else if (role == L("Bridge")) return erBridgeInfill;
    else if (role == L("Internal Bridge")) return erInternalBridgeInfill;
    else if (role == L("Gap infill")) return erGapFill;
    else if (role == ("Skirt")) return erSkirt;
    else if (role == ("Brim")) return erBrim;
    else if (role == L("Support")) return erSupportMaterial;
    else if (role == L("Support interface")) return erSupportMaterialInterface;
    else if (role == L("Support transition")) return erSupportTransition;
    else if (role == L("Prime tower")) return erWipeTower;
    else if (role == L("Custom")) return erCustom;
    else if (role == L("Multiple")) return erMixed;
    else return erNone;
}

} // namespace Slic3r
