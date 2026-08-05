// STUB (stage 11 config port): trimmed GCode/Thumbnails.hpp. The real header pulls ThumbnailData.hpp
// (image buffers) + boost/beast base64 + the export_thumbnails_to_file template — none of which the
// config subsystem needs. PrintConfig.cpp uses only:
//   - enum class GCodeThumbnailsFormat  (actually defined in PrintConfig.hpp:468, not here)
//   - ThumbnailError / ThumbnailErrors  (the bitmask below, copied verbatim from the real header)
//   - GCodeThumbnails::make_and_check_thumbnail_list(string, string_view)  (ported verbatim inline)
// The GCodeThumbnailsFormat-format free helper set + the base64 export template are omitted.
#ifndef slic3r_GCodeThumbnails_stub_hpp_
#define slic3r_GCodeThumbnails_stub_hpp_

// NOTE: in the isolated config-port layout Point.hpp/enum_bitmask.hpp live in arachne_port/libslic3r
// (resolved via -I), while PrintConfig.hpp is the real copy in this dir's parent. So the real
// header's "../Point.hpp" form is replaced with the -I-resolved plain form here.
#include "Point.hpp"
#include "../PrintConfig.hpp"
#include "enum_bitmask.hpp"

#include <vector>
#include <string>
#include <string_view>
#include <sstream>
#include <utility>
#include <boost/algorithm/string/case_conv.hpp>
#include "format.hpp"

namespace Slic3r {
    // Verbatim from src/libslic3r/GCode/Thumbnails.hpp:17-19
    enum class ThumbnailError : int { InvalidVal, OutOfRange, InvalidExt };
    using ThumbnailErrors = enum_bitmask<ThumbnailError>;
    ENABLE_ENUM_BITMASK_OPERATORS(ThumbnailError);
}

namespace Slic3r::GCodeThumbnails {

typedef std::vector<std::pair<GCodeThumbnailsFormat, Vec2d>> GCodeThumbnailDefinitionsList;
using namespace std::literals;

// Ported verbatim from src/libslic3r/GCode/Thumbnails.cpp (get_error_string).
inline std::string get_error_string(const ThumbnailErrors& errors)
{
    std::string error_str;
    if (errors.has(ThumbnailError::InvalidVal))
        error_str += "\n - " + Slic3r::format("Invalid input format. Expected vector of dimensions in the following format: \"%1%\"", "XxY/EXT, XxY/EXT, ...");
    if (errors.has(ThumbnailError::OutOfRange))
        error_str += "\n - Input value is out of range";
    if (errors.has(ThumbnailError::InvalidExt))
        error_str += "\n - Some extension in the input is invalid";
    return error_str;
}

// Ported verbatim from src/libslic3r/GCode/Thumbnails.cpp (make_and_check_thumbnail_list(string)).
inline std::pair<GCodeThumbnailDefinitionsList, ThumbnailErrors>
make_and_check_thumbnail_list(const std::string& thumbnails_string, const std::string_view def_ext = "PNG"sv)
{
    if (thumbnails_string.empty())
        return {};

    std::istringstream is(thumbnails_string);
    std::string point_str;

    ThumbnailErrors errors;

    GCodeThumbnailDefinitionsList thumbnails_list;
    while (std::getline(is, point_str, ',')) {
        Vec2d point(Vec2d::Zero());
        GCodeThumbnailsFormat format;
        std::istringstream iss(point_str);
        std::string coord_str;
        if (std::getline(iss, coord_str, 'x') && !coord_str.empty()) {
            std::istringstream(coord_str) >> point(0);
            if (std::getline(iss, coord_str, '/') && !coord_str.empty()) {
                std::istringstream(coord_str) >> point(1);

                if (0 < point(0) && point(0) < 1000 && 0 < point(1) && point(1) < 1000) {
                    std::string ext_str;
                    std::getline(iss, ext_str, '/');

                    if (ext_str.empty())
                        ext_str = def_ext.empty() ? "PNG"sv : def_ext;

                    boost::to_upper(ext_str);
                    if (!ConfigOptionEnum<GCodeThumbnailsFormat>::from_string(ext_str, format)) {
                        format = GCodeThumbnailsFormat::PNG;
                        errors = enum_bitmask(errors | ThumbnailError::InvalidExt);
                    }

                    thumbnails_list.emplace_back(std::make_pair(format, point));
                }
                else
                    errors = enum_bitmask(errors | ThumbnailError::OutOfRange);
                continue;
            }
        }
        errors = enum_bitmask(errors | ThumbnailError::InvalidVal);
    }

    return std::make_pair(std::move(thumbnails_list), errors);
}

} // namespace Slic3r::GCodeThumbnails

#endif
