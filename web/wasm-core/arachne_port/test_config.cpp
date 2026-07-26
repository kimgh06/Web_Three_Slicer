// Stage-11 standalone probe: does the real Config.cpp + PrintConfig.cpp subsystem compile, link,
// and run under emscripten? Prints option count + a few spot-checks (no embind yet).
#include <cstdio>
#include "config/libslic3r/PrintConfig.hpp"

using namespace Slic3r;

int main() {
    // print_config_def is the one global built by PrintConfigDef::PrintConfigDef().
    printf("option_count=%zu\n", (size_t)print_config_def.options.size());

    // FullPrintConfig instantiation (exercises the StaticPrintConfig cache machinery).
    FullPrintConfig fpc;
    printf("fullprintconfig_keys=%zu\n", (size_t)fpc.keys().size());

    // Spot checks against known defaults.
    auto lh = print_config_def.get("layer_height");
    if (lh && lh->default_value) printf("layer_height_default=%s\n", lh->default_value->serialize().c_str());
    auto sp = print_config_def.get("seam_position");
    if (sp && sp->default_value) printf("seam_position_default=%s\n", sp->default_value->serialize().c_str());
    auto sip = print_config_def.get("sparse_infill_pattern");
    if (sip) printf("sparse_infill_pattern_enum_count=%zu\n", (size_t)sip->enum_values.size());
    return 0;
}
