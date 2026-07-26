// Stage-13: consolidated. The config subsystem's Utils needs (is_gcode_file/is_json_file/
// header_slic3r_generated + FilePtr/get_time_dhms/short_time/format_diameter_to_str/rename_file) are
// now all in the single canonical arachne_port/libslic3r/Utils.hpp. Forward to it so there is exactly
// one definition (avoids ODR divergence between the config TUs and GCodeReader/GCodeProcessor, which
// include the canonical one same-dir).
#pragma once
#include "../../libslic3r/Utils.hpp"
