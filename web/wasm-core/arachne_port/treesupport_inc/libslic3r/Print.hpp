// FACADE (stage 15 TreeSupport port): the real Print.hpp (1376L) pulls PrintBase/Model/SLA
// (SupportPoint.hpp) — the whole pipeline. TreeSupport only needs a PrintObject/Print/ModelObject
// facade over a Layer/SupportLayer graph the kernel adapter fills. This provides exactly the measured
// surface (get_layer/layers/support_layers/config/print/slicing_parameters/bounding_box/... + the 3
// mesh ops as EMPTY stubs — the kernel has no 3D model mesh / support painting, so enforcers/blockers/
// custom-facets are legitimately empty, documented). Real heavy header kept as Print_real.hpp.bak.
#ifndef slic3r_Print_facade_hpp_
#define slic3r_Print_facade_hpp_

#include "libslic3r.h"
#include "Point.hpp"
#include "BoundingBox.hpp"
#include "Layer.hpp"          // Layer, SupportLayer, LayerPtrs
#include "PrintConfig.hpp"    // PrintConfig, PrintObjectConfig (real)
#include "Slicing.hpp"        // SlicingParameters
#include "BuildVolume.hpp"
#include "Flow.hpp"
#include "TriangleMesh.hpp"
#include "enum_bitmask.hpp"
#include <vector>
#include <string>
#include <functional>

namespace Slic3r {

class Print;
class PrintObject;
class ModelInstance;
using SupportLayerPtrs = std::vector<SupportLayer*>;
using PrintObjectPtrs  = std::vector<PrintObject*>;

// EnforcerBlockerType (verbatim from TriangleSelector.hpp) — project_and_append_custom_facets arg.
enum class EnforcerBlockerType : int8_t {
    NONE = 0, ENFORCER = 1, BLOCKER = 2, FUZZY_SKIN = ENFORCER,
    Extruder1 = ENFORCER, Extruder2 = BLOCKER, Extruder3, Extruder4, Extruder5, Extruder6, Extruder7,
    Extruder8, Extruder9, Extruder10, Extruder11, Extruder12, Extruder13, Extruder14, Extruder15,
    Extruder16, ExtruderMax = Extruder16
};
enum class ModelVolumeType : int { INVALID = -1, MODEL_PART, NEGATIVE_VOLUME, PARAMETER_MODIFIER, SUPPORT_BLOCKER, SUPPORT_ENFORCER };

// Minimal ModelObject facade — TreeSupport uses name (logging) + raw_mesh/is_*_painted (dead OpenVDB
// branch guarded out by TREE_SUPPORT_ORGANIC_NUDGE_NEW; painting unsupported in the kernel).
class ModelObject {
public:
    std::string name;
    Points      brim_points;
    const TriangleMesh& raw_mesh() const { return m_raw_mesh; }
    bool is_mm_painted()        const { return false; }
    bool is_fuzzy_skin_painted() const { return false; }
private:
    TriangleMesh m_raw_mesh;
};

struct PrintInstance { PrintObject *print_object = nullptr; const ModelInstance *model_instance = nullptr; Point shift; };
using PrintInstances = std::vector<PrintInstance>;

// Minimal PrintRegion facade. TreeSupport reads per-region flows to size support (num_printing_regions/
// printing_region/flow/config). The kernel is single-region; flow() derives from region line-width
// config (documented approximation of the real per-region extrusion-width computation).
class PrintRegion {
public:
    const PrintRegionConfig& config() const { return m_config; }
    Flow flow(const PrintObject& object, FlowRole role, double layer_height) const;  // impl below (needs PrintObject)
    PrintRegionConfig m_config;
    float m_nozzle_diameter = 0.4f;
};

// Minimal Print facade.
class Print {
public:
    const PrintConfig& config() const { return m_config; }
    bool  canceled() const { return false; }
    void  set_status(int /*percent*/, const std::string& /*msg*/, unsigned /*flags*/ = 0) const {}
    const Vec3d get_plate_origin() const { return m_origin; }
    Flow  brim_flow() const { return Flow(0.45f, 0.2f, 0.4f); }   // used only for brim width; kernel does brim separately
    const PrintObjectPtrs& objects() const { return m_objects; }
    PrintConfig      m_config;
    Vec3d            m_origin { Vec3d::Zero() };
    PrintObjectPtrs  m_objects;
};

// PrintObject facade over a kernel-filled Layer/SupportLayer graph.
class PrintObject {
public:
    // ---- layers ----
    size_t         layer_count() const { return m_layers.size(); }
    size_t         support_layer_count() const { return m_support_layers.size(); }
    const Layer*   get_layer(int idx) const { return m_layers[idx]; }
    Layer*         get_layer(int idx)       { return m_layers[idx]; }
    SupportLayer*  get_support_layer(int idx) { return idx < (int)m_support_layers.size() ? m_support_layers[idx] : nullptr; }
    LayerPtrs&        layers()         { return m_layers; }
    const LayerPtrs&  layers() const   { return m_layers; }
    SupportLayerPtrs& support_layers() { return m_support_layers; }
    const SupportLayerPtrs& support_layers() const { return m_support_layers; }
    void clear_support_layers() { for (SupportLayer* l : m_support_layers) delete l; m_support_layers.clear(); }
    SupportLayer* add_tree_support_layer(int id, coordf_t height, coordf_t print_z, coordf_t slice_z) {
        m_support_layers.emplace_back(new SupportLayer(size_t(id), size_t(-1), this, height, print_z, slice_z));
        return m_support_layers.back();
    }

    // ---- config / print / params ----
    const PrintObjectConfig& config() const { return m_config; }
    Print*                   print()  { return m_print; }
    const Print*             print() const { return m_print; }
    const SlicingParameters& slicing_parameters() const { return m_slicing_params; }
    ModelObject*             model_object() { return m_model_object; }
    const ModelObject*       model_object() const { return m_model_object; }
    const PrintInstances&    instances() const { return m_instances; }
    const Transform3d&       trafo_centered() const { return m_trafo_centered; }
    BoundingBox              bounding_box() const { return m_bbox; }

    bool has_support()          const { return m_config.enable_support || m_config.enforce_support_layers > 0; }
    bool has_raft()             const { return m_config.raft_layers > 0; }
    bool has_support_material()  const { return has_support() || has_raft(); }

    // ---- mesh ops: EMPTY stubs. The kernel has no 3D model mesh nor support-painting data, so
    // enforcers/blockers/custom-facets are legitimately empty (no manual support painting). Documented.
    std::vector<Polygons> slice_support_blockers()  const { return {}; }
    std::vector<Polygons> slice_support_enforcers() const { return {}; }
    void project_and_append_custom_facets(bool, EnforcerBlockerType, std::vector<Polygons>&,
                                          std::vector<std::pair<Vec3f,Vec3f>>* = nullptr) const {}
    template<typename PolysType>
    static void remove_bridges_from_contacts(const Layer*, const Layer*, float, PolysType*,
                                             float = scale_(10), bool = false) {}

    // ---- adapter-filled members ----
    LayerPtrs        m_layers;
    SupportLayerPtrs m_support_layers;
    PrintObjectConfig m_config;
    Print*           m_print = nullptr;
    ModelObject*     m_model_object = nullptr;
    SlicingParameters m_slicing_params;
    PrintInstances   m_instances;
    Transform3d      m_trafo_centered { Transform3d::Identity() };
    BoundingBox      m_bbox;
};

} // namespace Slic3r
#endif
