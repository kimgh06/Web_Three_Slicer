// STUB (stage 11 config port): cereal is not in deps. Config.cpp / PrintConfig.cpp end with
// CEREAL_REGISTER_TYPE(...) + CEREAL_REGISTER_POLYMORPHIC_RELATION(...) at namespace scope to wire
// up polymorphic (de)serialization of the ConfigOption class hierarchy. Serialization is never
// invoked in the WASM slicer, so these registrations expand to nothing. Faithful behavior would
// need the real cereal polymorphic registry (link-only side effects), which the port intentionally
// omits.
#pragma once
#define CEREAL_REGISTER_TYPE(...)
#define CEREAL_REGISTER_TYPE_WITH_NAME(...)
#define CEREAL_REGISTER_POLYMORPHIC_RELATION(...)
