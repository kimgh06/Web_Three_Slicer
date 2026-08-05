// Stage-11 embind probe: exposes the ported real Config/PrintConfig subsystem to node.
//  - option_count()            : print_config_def.options.size()  (build-based ground truth)
//  - full_print_config_keys()  : FullPrintConfig instance key count
//  - default_of(key)           : serialized default of one option
//  - enum_count(key)           : enum_values size of one option
//  - dump_schema_json()        : full print_config_def -> JSON (for config-schema cross-check)
// Standalone module; does NOT touch the main slicer_core.js build (which keeps the stub PrintConfig).
#include <string>
#include <sstream>
#include <emscripten/bind.h>
#include "config/libslic3r/PrintConfig.hpp"

using namespace Slic3r;

static const char* type_to_string(ConfigOptionType t) {
    switch (t) {
        case coNone:               return "coNone";
        case coFloat:              return "coFloat";
        case coFloats:             return "coFloats";
        case coInt:                return "coInt";
        case coInts:               return "coInts";
        case coString:             return "coString";
        case coStrings:            return "coStrings";
        case coPercent:            return "coPercent";
        case coPercents:           return "coPercents";
        case coFloatOrPercent:     return "coFloatOrPercent";
        case coFloatsOrPercents:   return "coFloatsOrPercents";
        case coPoint:              return "coPoint";
        case coPoints:             return "coPoints";
        case coPoint3:             return "coPoint3";
        case coBool:               return "coBool";
        case coBools:              return "coBools";
        case coEnum:               return "coEnum";
        case coEnums:              return "coEnums";
        case coPointsGroups:       return "coPointsGroups";
        case coIntsGroups:         return "coIntsGroups";
        default:                   return "coUnknown";
    }
}

static const char* mode_to_string(ConfigOptionMode m) {
    switch (m) {
        case comSimple:   return "simple";
        case comAdvanced: return "advanced";
        case comExpert:   return "expert";
        case comDevelop:  return "develop";
        default:          return "unknown";
    }
}

static void json_escape(std::ostream& o, const std::string& s) {
    o << '"';
    for (char c : s) {
        switch (c) {
            case '"':  o << "\\\""; break;
            case '\\': o << "\\\\"; break;
            case '\n': o << "\\n";  break;
            case '\r': o << "\\r";  break;
            case '\t': o << "\\t";  break;
            default:
                if ((unsigned char)c < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", c); o << buf; }
                else o << c;
        }
    }
    o << '"';
}

static void json_str_array(std::ostream& o, const std::vector<std::string>& v) {
    o << '[';
    for (size_t i = 0; i < v.size(); ++i) { if (i) o << ','; json_escape(o, v[i]); }
    o << ']';
}

int option_count() { return (int)print_config_def.options.size(); }

int full_print_config_keys() { FullPrintConfig fpc; return (int)fpc.keys().size(); }

std::string default_of(const std::string& key) {
    auto d = print_config_def.get(key);
    if (!d || !d->default_value) return std::string();
    return d->default_value->serialize();
}

int enum_count(const std::string& key) {
    auto d = print_config_def.get(key);
    return d ? (int)d->enum_values.size() : -1;
}

std::string dump_schema_json() {
    std::ostringstream o;
    o << '{';
    bool first = true;
    for (const auto& kv : print_config_def.options) {
        const std::string& key = kv.first;
        const ConfigOptionDef& def = kv.second;
        if (!first) o << ',';
        first = false;
        json_escape(o, key);
        o << ":{";
        o << "\"type\":\"" << type_to_string(def.type) << "\"";
        o << ",\"mode\":\"" << mode_to_string(def.mode) << "\"";
        o << ",\"nullable\":" << (def.nullable ? "true" : "false");
        o << ",\"label\":"; json_escape(o, def.label);
        o << ",\"full_label\":"; json_escape(o, def.full_label);
        o << ",\"category\":"; json_escape(o, def.category);
        o << ",\"tooltip\":"; json_escape(o, def.tooltip);
        o << ",\"sidetext\":"; json_escape(o, def.sidetext);
        o << ",\"ratio_over\":"; json_escape(o, def.ratio_over);
        // min/max only meaningful when set away from +/-FLT_MAX
        if (def.min > -3.0e38f) o << ",\"min\":" << def.min;
        if (def.max <  3.0e38f) o << ",\"max\":" << def.max;
        o << ",\"enum_values\":"; json_str_array(o, def.enum_values);
        o << ",\"enum_labels\":"; json_str_array(o, def.enum_labels);
        if (def.default_value) { o << ",\"default\":"; json_escape(o, def.default_value->serialize()); }
        else                   { o << ",\"default\":null"; }
        o << '}';
    }
    o << '}';
    return o.str();
}

EMSCRIPTEN_BINDINGS(config_probe) {
    emscripten::function("option_count", &option_count);
    emscripten::function("full_print_config_keys", &full_print_config_keys);
    emscripten::function("default_of", &default_of);
    emscripten::function("enum_count", &enum_count);
    emscripten::function("dump_schema_json", &dump_schema_json);
}
