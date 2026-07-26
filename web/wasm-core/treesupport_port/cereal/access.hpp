// STUB (stage 7 Arachne port): cereal not in deps_src. Geometry.hpp's Transformation has a
// load_and_construct(Archive&, cereal::construct<Transformation>&) that calls construct(1) and
// construct.ptr()->m_matrix. That method is never instantiated at runtime by the Arachne port,
// but its non-dependent body needs cereal::construct to be a complete type. Minimal definition:
#pragma once
#include <type_traits>
namespace cereal {
class access;
template <class T> class construct {
public:
    template <class... A> void operator()(A&&...) {}
    T* ptr() { return nullptr; }
};
// (stage 11 config port) real cereal specialize machinery — declarations copied from
// cereal/details/traits.hpp. PrintConfig.hpp:2398 declares an explicit specialization
// `specialize<Archive, DynamicPrintConfig, specialization::non_member_load_save>`; these tags +
// the primary template make it well-formed without pulling real cereal (not in deps).
namespace specialization {
    struct member_serialize {};
    struct member_load_save {};
    struct member_load_save_minimal {};
    struct non_member_serialize {};
    struct non_member_load_save {};
    struct non_member_load_save_minimal {};
} // namespace specialization
template <class Archive, class T, class Specialize = void> struct specialize : public std::false_type {};
} // namespace cereal
