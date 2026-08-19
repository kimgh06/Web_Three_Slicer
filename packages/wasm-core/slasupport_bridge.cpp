// slasupport_bridge.cpp — drives the ported PrusaSlicer DefaultSupportTree (slasupport_port/). Compiled with
//  the SLA include set (Prusa headers win), so no kernel header may be included here besides the bridge's own.
//
//  What this does, in upstream's own order: build an AABBMesh over the model, snap every candidate contact
//  onto the surface (the move_on_mesh_surface logic — up/down raycast, closest-point fallback), hand the
//  points to DefaultSupportTree::execute (pinheads -> classify -> routing -> bracing — all upstream verbatim),
//  then flatten builder.merged_mesh() into a triangle soup shifted up by the elevation so the kernel's global
//  layer frame (elevation zone at the bottom) receives world coordinates.
#include "slasupport_bridge.h"

#include <libslic3r/AABBMesh.hpp>
#include <libslic3r/SLA/DefaultSupportTree.hpp>
#include <libslic3r/SLA/SupportTree.hpp>
#include <libslic3r/SLA/SupportTreeBuilder.hpp>
#include <libslic3r/SLA/SupportPoint.hpp>
#include <libslic3r/SLA/SupportPointGenerator.hpp>
#include <libslic3r/SLA/SupportIslands/SampleConfigFactory.hpp>
#include <libslic3r/SLA/Pad.hpp>
#include <libslic3r/KDTreeIndirect.hpp>
#include <libslic3r/ClipperUtils.hpp>
#include <libslic3r/TriangleMesh.hpp>        // its_merge_vertices — the soup must be welded before slicing
#include <libslic3r/TriangleMeshSlicer.hpp>  // slice_mesh_ex — the generator's input slicer (upstream's own)

#include <admesh/stl.h>
#include <exception>
#include <algorithm>
#include <cmath>
#include <numeric>
#include <limits>
#include <unordered_map>

using namespace Slic3r;
using namespace Slic3r::sla;

namespace slasupport_bridge {

static indexed_triangle_set soup_to_its(const std::vector<float>& soup) {
  indexed_triangle_set its;
  const size_t n = soup.size() / 9;
  its.vertices.reserve(n * 3);
  its.indices.reserve(n);
  for (size_t t = 0; t < n; ++t) {
    for (int v = 0; v < 3; ++v)
      its.vertices.emplace_back(soup[t * 9 + v * 3], soup[t * 9 + v * 3 + 1], soup[t * 9 + v * 3 + 2]);
    its.indices.emplace_back(int(t * 3), int(t * 3 + 1), int(t * 3 + 2));
  }
  return its;
}

static Vec3d transformed(const Transform& transform, const Vec3& point) {
  const auto& m = transform.matrix;
  return Vec3d(
    m[0] * point.x + m[4] * point.y + m[8]  * point.z + m[12],
    m[1] * point.x + m[5] * point.y + m[9]  * point.z + m[13],
    m[2] * point.x + m[6] * point.y + m[10] * point.z + m[14]);
}

static std::vector<float> merged_mesh(const PreparedJob& job) {
  std::vector<float> soup;
  for (const PreparedObject& object : job.objects) {
    soup.reserve(soup.size() + object.mesh.size());
    for (std::size_t i = 0; i < object.mesh.size(); i += 3) {
      const Vec3d point = transformed(object.transform,
        Vec3{object.mesh[i], object.mesh[i + 1], object.mesh[i + 2]});
      soup.push_back(float(point.x()));
      soup.push_back(float(point.y()));
      soup.push_back(float(point.z()));
    }
  }
  return soup;
}

// The move_on_mesh_surface logic (SupportPointGenerator.cpp): project up and down, take the closer hit; a miss
//  on both sides falls back to the closest surface point.
static Vec3f snap_to_surface(const AABBMesh& emesh, const Vec3d& p) {
  const Vec3d up(0., 0., 1.), down(0., 0., -1.);
  auto hit_up = emesh.query_ray_hit(p, up);
  auto hit_down = emesh.query_ray_hit(p, down);
  const bool u = hit_up.is_hit(), d = hit_down.is_hit();
  if (u || d) {
    const auto& hit = (!d || (u && hit_up.distance() < hit_down.distance())) ? hit_up : hit_down;
    if (hit.distance() < 2.0)
      return (p + hit.distance() * hit.direction()).cast<float>();
  }
  int tri; Vec3d closest;
  emesh.squared_distance(p, tri, closest);
  return closest.cast<float>();
}

// ---- Automatic support-point generation (ported Prusa SupportPointGenerator + SupportIslands) --------------

namespace {
struct BridgeCanceled {};
} // namespace

// Upstream SLAPrintSteps.cpp:121 prepare_permanent_support_points, verbatim logic: keep only manual_add
// points near the surface, drop overlapped ones through a KD-tree pass, sort by z.
static void prepare_permanent_support_points_port(
    Slic3r::sla::SupportPoints &permanent_supports,
    const Slic3r::sla::SupportPoints &object_supports,
    const AABBMesh &emesh) {
  using Slic3r::sla::SupportPoint;
  using Slic3r::sla::SupportPointType;
  permanent_supports.clear(); // previous supports are irelevant
  for (const SupportPoint &p : object_supports) {
    if (p.type != SupportPointType::manual_add)
      continue;
    // (upstream applies object_trafo here; the caller hands points already in generation space)
    double dist_sq = emesh.squared_distance(p.pos.cast<double>());
    if (dist_sq >= double(p.head_front_radius) * double(p.head_front_radius))
      continue; // skip points outside the mesh
    permanent_supports.push_back(p);
  }

  // Prevent overlapped permanent supports
  auto point_accessor = [&permanent_supports](size_t idx, size_t dim) -> float & {
    return permanent_supports[idx].pos[dim]; };
  std::vector<size_t> indices(permanent_supports.size());
  std::iota(indices.begin(), indices.end(), 0);
  KDTreeIndirect<3, float, decltype(point_accessor)> tree(point_accessor, indices);
  for (Slic3r::sla::SupportPoint &p : permanent_supports) {
    if (p.head_front_radius < 0.f)
      continue; // already marked for erase
    std::vector<size_t> near_indices = find_nearby_points(tree, p.pos, p.head_front_radius);
    if (near_indices.size() <= 1)
      continue; // only support itself
    size_t index = &p - &permanent_supports.front();
    for (size_t near_index : near_indices) {
      if (near_index == index)
        continue;
      const Slic3r::sla::SupportPoint &p_near = permanent_supports[near_index];
      if ((p.pos - p_near.pos).squaredNorm() > double(p.head_front_radius) * double(p.head_front_radius))
        continue;
      permanent_supports[near_index].head_front_radius = -1.0f; // mark for erase
    }
  }
  permanent_supports.erase(std::remove_if(permanent_supports.begin(), permanent_supports.end(),
      [](const Slic3r::sla::SupportPoint &p) { return p.head_front_radius < 0.f; }), permanent_supports.end());
  std::sort(permanent_supports.begin(), permanent_supports.end(),
      [](const Slic3r::sla::SupportPoint &p1, const Slic3r::sla::SupportPoint &p2) { return p1.pos.z() < p2.pos.z(); });
}

GeneratedPoints generate_support_points(const PreparedJob& job, const PointGenConfig& cfg) {
  GeneratedPoints out;
  const ValidationResult checked = validate(job);
  if (!checked.ok) { out.error = checked.error; return out; }

  // Upstream SLAPrintSteps.cpp:716 config mapping.
  Slic3r::sla::SupportPointGeneratorConfig generator_config;
  generator_config.density_relative = float(cfg.density_relative);
  generator_config.head_diameter = float(cfg.head_diameter);
  generator_config.island_configuration = Slic3r::sla::SampleConfigFactory::apply_density(
      Slic3r::sla::SampleConfigFactory::create(generator_config.head_diameter),
      generator_config.density_relative);

  Slic3r::sla::ThrowOnCancel cancel = [&job]() {
    if (job.callbacks.is_canceled && job.callbacks.is_canceled()) throw BridgeCanceled{};
  };

  try {
    for (const PreparedObject& object : job.objects) {
      // This object's prepared layers, in index order.
      std::vector<const PreparedLayer*> object_layers;
      for (const PreparedLayer& layer : job.layers)
        if (layer.object_id == object.id) object_layers.push_back(&layer);
      std::sort(object_layers.begin(), object_layers.end(),
                [](const PreparedLayer* a, const PreparedLayer* b) { return a->index < b->index; });
      if (object_layers.empty()) continue;

      // The object mesh in generation (plate) space — for slicing, the surface snap, and the permanent-point
      // checks. Vertices are welded because the slicer walks shared edges (an unwelded soup has none).
      std::vector<float> soup;
      soup.reserve(object.mesh.size());
      for (std::size_t i = 0; i < object.mesh.size(); i += 3) {
        const Vec3d point = transformed(object.transform,
          Vec3{object.mesh[i], object.mesh[i + 1], object.mesh[i + 2]});
        soup.push_back(float(point.x()));
        soup.push_back(float(point.y()));
        soup.push_back(float(point.z()));
      }
      indexed_triangle_set its = soup_to_its(soup);
      its_merge_vertices(its);
      AABBMesh emesh{its};

      // The generator's input slices come from the REAL slicer with the profile's gap-closing radius —
      // exactly upstream's pipeline (SLAPrintSteps slice_model -> get_model_slices), not from the kernel's
      // display contours: the borderline overhangs the sampler reacts to live in that difference.
      std::vector<float> heights;
      heights.reserve(object_layers.size());
      for (const PreparedLayer* layer : object_layers) heights.push_back(float(layer->slice_z));
      Slic3r::MeshSlicingParamsEx slicing_params;
      slicing_params.closing_radius = float(cfg.slice_closing_radius);
      std::vector<Slic3r::ExPolygons> slices =
          Slic3r::slice_mesh_ex(its, heights, slicing_params, [&cancel]{ cancel(); });

      const std::size_t object_index = &object - job.objects.data();
      Slic3r::sla::StatusFunction status = [&job, object_index, total = job.objects.size()](int st) {
        if (job.callbacks.on_progress)
          job.callbacks.on_progress({ProgressPhase::prepare,
                                     object_index * 100 + std::size_t(std::max(0, std::min(100, st))),
                                     total * 100});
      };

      Slic3r::sla::SupportPointGeneratorData data = Slic3r::sla::prepare_generator_data(
          std::move(slices), heights, {}, cancel, status);

      // Permanent (manual) points of this object enter the generator's density accounting…
      Slic3r::sla::SupportPoints authored;
      for (const SupportPoint& point : job.points) {
        if (point.object_id != object.id || !(point.permanent || point.manual)) continue;
        const Vec3d position = transformed(object.transform, point.position);
        Slic3r::sla::SupportPoint sp;
        sp.pos = position.cast<float>();
        sp.head_front_radius = float(point.head_front_radius);
        sp.type = Slic3r::sla::SupportPointType::manual_add;
        authored.push_back(sp);
      }
      prepare_permanent_support_points_port(data.permanent_supports, authored, emesh);

      Slic3r::sla::LayerSupportPoints layer_points =
          Slic3r::sla::generate_support_points(data, generator_config, cancel, status);

      // Maximal move of support point to mesh surface, no more than height of layer (upstream :768).
      double allowed_move = heights.size() > 1
          ? double(heights[1] - heights[0]) + std::numeric_limits<float>::epsilon()
          : double(std::numeric_limits<float>::epsilon());
      Slic3r::sla::SupportPoints surface_points =
          Slic3r::sla::move_on_mesh_surface(layer_points, emesh, allowed_move, cancel);

      // …and are appended AFTER the move so their authored 3d position survives (upstream :776).
      surface_points.insert(surface_points.end(),
                            data.permanent_supports.begin(), data.permanent_supports.end());

      // Back to object-local coordinates for the bridge schema.
      Eigen::Matrix4d matrix;
      for (int c = 0; c < 4; ++c)
        for (int r = 0; r < 4; ++r) matrix(r, c) = object.transform.matrix[c * 4 + r];
      const Eigen::Matrix4d inverse = matrix.inverse();
      const std::size_t generated_count = surface_points.size() - data.permanent_supports.size();
      for (std::size_t i = 0; i < surface_points.size(); ++i) {
        const Slic3r::sla::SupportPoint& sp = surface_points[i];
        const Eigen::Vector4d local = inverse * Eigen::Vector4d(sp.pos.x(), sp.pos.y(), sp.pos.z(), 1.0);
        SupportPoint point;
        point.source_id = out.points.size();
        point.object_id = object.id;
        point.position = {local.x(), local.y(), local.z()};
        point.head_front_radius = sp.head_front_radius;
        point.type = sp.type == Slic3r::sla::SupportPointType::island ? PointType::island
                   : sp.type == Slic3r::sla::SupportPointType::slope  ? PointType::slope
                                                                      : PointType::manual_add;
        point.permanent = i >= generated_count;
        point.manual = point.permanent;
        out.points.push_back(std::move(point));
      }
    }
  } catch (const BridgeCanceled&) { out.error = "support point generation canceled"; return out; }
    catch (const std::exception& e) { out.error = std::string("exception: ") + e.what(); return out; }
    catch (...) { out.error = "unknown exception"; return out; }

  out.ok = true;
  return out;
}

// ---- Pad (ported Pad.cpp driven the way upstream SupportTree.cpp:71 drives it) -----------------------------

PadResult generate_pad(const std::vector<float>& model_mesh,
                       const std::vector<float>& support_mesh,
                       bool supports_enabled,
                       const PadParams& params) {
  PadResult out;
  out.capability = pad_capability();
  if (params.around_object) {
    out.error = "SLA_PAD_AROUND_OBJECT_UNSUPPORTED";
    return out;
  }

  Slic3r::sla::PadConfig pad_config;
  pad_config.wall_thickness_mm = params.wall_thickness;
  pad_config.wall_height_mm    = params.wall_height;
  pad_config.max_merge_dist_mm = params.max_merge_distance;
  pad_config.wall_slope        = params.wall_slope_deg * M_PI / 180.0;
  pad_config.brim_size_mm      = params.brim_size;
  const std::string invalid = pad_config.validate();
  if (!invalid.empty()) { out.error = invalid; return out; }
  out.full_height = pad_config.full_height();

  // Upstream samples the blueprint over [ground, ground + full_height + sampling] — the foot band. The
  // inputs here are in the print frame, so ground is 0.
  constexpr float PadSamplingLH = 0.1f;
  std::vector<float> heights;
  for (float h = 0.f; h < float(out.full_height + PadSamplingLH + 1e-6); h += PadSamplingLH)
    heights.push_back(h);

  try {
    Slic3r::ExPolygons model_contours;
    if (!supports_enabled && !model_mesh.empty()) {
      indexed_triangle_set model_its = soup_to_its(model_mesh);
      Slic3r::sla::pad_blueprint(model_its, model_contours, heights);
    }
    Slic3r::ExPolygons support_contours;
    if (!support_mesh.empty()) {
      indexed_triangle_set support_its = soup_to_its(support_mesh);
      Slic3r::sla::pad_blueprint(support_its, support_contours, heights);
    }
    if (model_contours.empty() && support_contours.empty()) {
      out.error = "pad: nothing reaches the plate to stand on";
      return out;
    }

    indexed_triangle_set pad;
    Slic3r::sla::create_pad(support_contours, model_contours, pad, pad_config);
    if (pad.indices.empty()) { out.error = "pad: empty geometry"; return out; }

    // Pad.cpp emits z in [-full_height, 0] (top face on the ground); stand it on the plate instead.
    const float lift = float(out.full_height);
    out.mesh.reserve(pad.indices.size() * 9);
    for (const auto& face : pad.indices)
      for (int v = 0; v < 3; ++v) {
        const auto& p = pad.vertices[face(v)];
        out.mesh.push_back(p.x()); out.mesh.push_back(p.y()); out.mesh.push_back(p.z() + lift);
      }
  } catch (const std::exception& e) { out.error = std::string("exception: ") + e.what(); return out; }
    catch (...) { out.error = "unknown exception"; return out; }

  out.ok = true;
  return out;
}

Result generate(const PreparedJob& job, const Config& cfg) {
  Result out;
  out.capability = strategy_capability(cfg.strategy);
  if (out.capability.status != StrategyCapabilityStatus::supported) {
    out.error = out.capability.code;
    return out;
  }
  const ValidationResult checked = validate(job);
  if (!checked.ok) { out.error = checked.error; return out; }
  const std::vector<slasupport_bridge::SupportPoint> filtered_points =
    filter_support_points_by_modifiers(job.points, job.layers, job.support_enforcers_only);
  out.point_order.reserve(filtered_points.size());
  for (const slasupport_bridge::SupportPoint& point : filtered_points) out.point_order.push_back(point.source_id);
  if (job.callbacks.on_progress)
    job.callbacks.on_progress({ProgressPhase::validation, 1, 1});
  if (job.callbacks.is_canceled && job.callbacks.is_canceled()) {
    out.error = "support tree canceled";
    return out;
  }
  if (filtered_points.empty()) { out.error = "points: empty"; return out; }

  const std::vector<float> model = merged_mesh(job);

  indexed_triangle_set its = soup_to_its(model);

  SupportTreeConfig stc;
  stc.enabled                     = true;
  stc.head_front_radius_mm        = cfg.head_front_radius;
  stc.head_back_radius_mm         = cfg.head_back_radius;
  stc.head_fallback_radius_mm     = cfg.head_fallback_radius;
  stc.head_width_mm               = cfg.head_width;
  stc.head_penetration_mm         = cfg.head_penetration;
  stc.base_radius_mm              = cfg.base_radius;
  stc.base_height_mm              = cfg.base_height;
  stc.max_bridge_length_mm        = cfg.max_bridge_length;
  stc.max_pillar_link_distance_mm = cfg.max_pillar_link_distance;
  stc.object_elevation_mm         = cfg.object_elevation;
  stc.ground_facing_only          = cfg.buildplate_only;
  stc.bridge_slope                = cfg.bridge_slope;
  stc.pillar_widening_factor      = cfg.pillar_widening_factor;
  // Upstream make_support_cfg: a zero base safety distance means "use the kernel's own safety distance".
  stc.pillar_base_safety_distance_mm = cfg.pillar_base_safety_distance < 1e-9
    ? SupportTreeConfig::safety_distance_mm : cfg.pillar_base_safety_distance;
  stc.max_bridges_on_pillar       = (unsigned)std::max(0, cfg.max_bridges_on_pillar);
  stc.max_weight_on_model_support = cfg.max_weight_on_model;
  stc.pillar_connection_mode      = cfg.pillar_connection_mode == 0 ? PillarConnectionMode::zigzag
                                  : cfg.pillar_connection_mode == 1 ? PillarConnectionMode::cross
                                                                    : PillarConnectionMode::dynamic;

  SupportPoints pts;
  pts.reserve(job.points.size());
  {
    AABBMesh snap_mesh{its};
    std::unordered_map<std::string, const PreparedObject*> objects;
    for (const PreparedObject& object : job.objects) objects.emplace(object.id, &object);
    for (const slasupport_bridge::SupportPoint& point : filtered_points) {
      Vec3 local = point.position;
      local.z += point.elevation;
      const Vec3d position = transformed(objects.at(point.object_id)->transform, local);
      Slic3r::sla::SupportPoint sp;
      sp.pos = snap_to_surface(snap_mesh, position);
      sp.head_front_radius = float(point.head_front_radius);
      sp.type = point.type == PointType::island ? SupportPointType::island
              : point.type == PointType::slope ? SupportPointType::slope
                                               : SupportPointType::manual_add;
      pts.push_back(sp);
    }
  }
  if (job.callbacks.on_progress)
    job.callbacks.on_progress({ProgressPhase::prepare, filtered_points.size(), filtered_points.size()});

  SupportableMesh sm{its, pts, stc};
  JobController ctl;
  if (job.callbacks.on_progress) {
    auto cb = job.callbacks.on_progress;
    ctl.statuscb = [cb](unsigned pct, const std::string&) {
      cb({ProgressPhase::support_tree, pct, 100});
    };
  }
  if (job.callbacks.is_canceled) ctl.stopcondition = job.callbacks.is_canceled;
  SupportTreeBuilder builder{ctl};
  try {
    // Upstream quirk (DefaultSupportTree.cpp `return pc == ABORT`): execute returns TRUE only when ABORTED.
    if (DefaultSupportTree::execute(builder, sm)) { out.error = "support tree aborted"; return out; }
  } catch (const std::exception& e) { out.error = std::string("exception: ") + e.what(); return out; }
    catch (...) { out.error = "unknown exception"; return out; }

  const indexed_triangle_set& merged = builder.merged_mesh((size_t)std::max(6, cfg.mesh_steps));
  out.mesh.reserve(merged.indices.size() * 9);
  const float lift = float(cfg.object_elevation);
  for (const auto& f : merged.indices)
    for (int v = 0; v < 3; ++v) {
      const auto& p = merged.vertices[f(v)];
      out.mesh.push_back(p.x()); out.mesh.push_back(p.y()); out.mesh.push_back(p.z() + lift);
    }
  out.pillars = builder.pillarcount();
  out.heads   = pts.size();
  out.ok      = true;
  if (job.callbacks.on_progress)
    job.callbacks.on_progress({ProgressPhase::complete, 1, 1});
  return out;
}

} // namespace slasupport_bridge
