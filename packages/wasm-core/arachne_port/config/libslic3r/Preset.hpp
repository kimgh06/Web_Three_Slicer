// STUB (stage 11 config port): real Preset.hpp (1177 lines) pulls PresetBundle / AppConfig /
// Semver / the whole preset-management subsystem. Config.cpp includes it but references NO Preset
// symbol (verified by grep: only the `#include "Preset.hpp"` line, zero `Preset::`/`PresetBundle`
// uses). So an empty stub is sufficient EXCEPT for the BBL_JSON_KEY_* string-literal macros, which
// Config.cpp's JSON preset loader references (never reached in WASM but must compile). Copied
// verbatim from src/libslic3r/Preset.hpp:44-81.
#pragma once
#define BBL_JSON_KEY_VERSION        "version"
#define BBL_JSON_KEY_IS_CUSTOM      "is_custom_defined"
#define BBL_JSON_KEY_URL            "url"
#define BBL_JSON_KEY_NAME           "name"
#define BBL_JSON_KEY_DESCRIPTION    "description"
#define BBL_JSON_KEY_FORCE_UPDATE   "force_update"
#define BBL_JSON_KEY_MACHINE_MODEL_LIST     "machine_model_list"
#define BBL_JSON_KEY_PROCESS_LIST   "process_list"
#define BBL_JSON_KEY_SUB_PATH       "sub_path"
#define BBL_JSON_KEY_FILAMENT_LIST  "filament_list"
#define BBL_JSON_KEY_MACHINE_LIST   "machine_list"
#define BBL_JSON_KEY_TYPE           "type"
#define BBL_JSON_KEY_FROM           "from"
#define BBL_JSON_KEY_SETTING_ID     "setting_id"
#define BBL_JSON_KEY_BASE_ID        "base_id"
#define BBL_JSON_KEY_USER_ID        "user_id"
#define BBL_JSON_KEY_FILAMENT_ID    "filament_id"
#define BBL_JSON_KEY_INHERITS       "inherits"
#define BBL_JSON_KEY_INSTANTIATION  "instantiation"
#define ORCA_JSON_KEY_RENAMED_FROM  "renamed_from"
