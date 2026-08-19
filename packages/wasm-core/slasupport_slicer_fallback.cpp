#include "slasupport_bridge.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <unordered_map>
#include <utility>

namespace slasupport_bridge {
namespace {

constexpr double kTolerance = 1e-7;

// A directed cross-section segment: a->b follows the slicing convention (solid on the LEFT, so outer
// boundaries chain CCW). `oriented` is false for near-horizontal triangles whose direction is unreliable —
// they still chain geometrically but do not vote on the loop's winding.
struct Segment { Vec2 a; Vec2 b; bool oriented = false; };

bool close(double a, double b) { return std::abs(a - b) <= kTolerance; }
bool close(const Vec2& a, const Vec2& b) { return close(a.x, b.x) && close(a.y, b.y); }

double signed_area(const Polygon& polygon) {
  double area = 0.0;
  for (std::size_t i = 0; i < polygon.size(); ++i) {
    const Vec2& a = polygon[i];
    const Vec2& b = polygon[(i + 1) % polygon.size()];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2.0;
}

bool contains(const Polygon& polygon, const Vec2& point) {
  bool inside = false;
  for (std::size_t i = 0, previous = polygon.size() - 1; i < polygon.size(); previous = i++) {
    const Vec2& a = polygon[i];
    const Vec2& b = polygon[previous];
    if ((a.y > point.y) != (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

bool intersect_triangle(const float* triangle, double height, Segment& segment) {
  Vec3 vertices[3];
  for (int i = 0; i < 3; ++i)
    vertices[i] = {triangle[i * 3], triangle[i * 3 + 1], triangle[i * 3 + 2]};
  Vec2 points[3];
  int count = 0;
  for (int i = 0; i < 3; ++i) {
    const Vec3& a = vertices[i];
    const Vec3& b = vertices[(i + 1) % 3];
    if (!((a.z < height && b.z >= height) || (b.z < height && a.z >= height))) continue;
    const double t = (height - a.z) / (b.z - a.z);
    const Vec2 point{a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t};
    if (count == 0 || !close(points[count - 1], point)) points[count++] = point;
  }
  if (count != 2 || close(points[0], points[1])) return false;
  segment = {points[0], points[1]};

  // Direct the segment from the triangle's own winding: with outward normal n, d = z x n points along the
  // cross-section so that the solid lies on the LEFT of a->b — outer loops come out CCW, true cavities CW
  // (checked on a cylinder's +x facet: n=(1,0,0) -> d=(0,1), the CCW tangent).
  // This is what makes a soup of INTERPENETRATING closed solids (a pillar through its pedestal, a bridge
  // through a pillar) union correctly downstream: nesting depth cannot tell such an inner boundary from a
  // hole, the winding can.
  const Vec3& v0 = vertices[0];
  const Vec3& v1 = vertices[1];
  const Vec3& v2 = vertices[2];
  const double ux = v1.x - v0.x, uy = v1.y - v0.y, uz = v1.z - v0.z;
  const double wx = v2.x - v0.x, wy = v2.y - v0.y, wz = v2.z - v0.z;
  const double nx = uy * wz - uz * wy;
  const double ny = uz * wx - ux * wz;
  const double dx = -ny, dy = nx;                       // (0,0,1) x n
  const double along = (segment.b.x - segment.a.x) * dx + (segment.b.y - segment.a.y) * dy;
  const double len2 = (dx * dx + dy * dy) *
    ((segment.b.x - segment.a.x) * (segment.b.x - segment.a.x) +
     (segment.b.y - segment.a.y) * (segment.b.y - segment.a.y));
  if (along * along > 1e-12 * len2) {                    // direction is meaningful for this triangle
    if (along < 0.0) std::swap(segment.a, segment.b);
    segment.oriented = true;
  }
  return true;
}

std::vector<Polygon> chain_closed_loops(std::vector<Segment> segments, std::string& error) {
  std::vector<Polygon> loops;
  std::vector<long> votes;   // per loop: directed segments agreeing with the chained order, minus disagreeing
  while (!segments.empty()) {
    const Segment seed = segments.back();
    segments.pop_back();
    Polygon loop{seed.a, seed.b};
    long vote = seed.oriented ? 1 : 0;
    while (!close(loop.back(), loop.front())) {
      const auto next = std::find_if(segments.begin(), segments.end(), [&](const Segment& segment) {
        return close(segment.a, loop.back()) || close(segment.b, loop.back());
      });
      if (next == segments.end()) {
        error = "generic mesh sweep produced an open contour";
        return {};
      }
      const bool forward = close(next->a, loop.back());
      if (next->oriented) vote += forward ? 1 : -1;
      loop.push_back(forward ? next->b : next->a);
      segments.erase(next);
    }
    loop.pop_back();
    if (loop.size() >= 3 && std::abs(signed_area(loop)) > kTolerance) {
      loops.push_back(std::move(loop));
      votes.push_back(vote);
    }
  }
  // Winding comes from the triangles (majority vote of the loop's directed segments), because a soup of
  // interpenetrating solids has inner boundaries whose nesting depth LOOKS like a hole but is solid. The
  // old depth-parity rule remains only as a fallback for the (degenerate) all-horizontal case with no vote.
  for (std::size_t i = 0; i < loops.size(); ++i) {
    if (votes[i] != 0) {
      // The chained order either follows the triangle convention (keep) or runs against it (reverse);
      // the signed area is NOT consulted — a genuine cavity is legitimately clockwise.
      if (votes[i] < 0) std::reverse(loops[i].begin(), loops[i].end());
    } else {
      std::size_t depth = 0;
      for (std::size_t j = 0; j < loops.size(); ++j)
        if (i != j && contains(loops[j], loops[i].front())) ++depth;
      const bool outer = depth % 2 == 0;
      if ((signed_area(loops[i]) > 0) != outer) std::reverse(loops[i].begin(), loops[i].end());
    }
  }
  return loops;
}

std::vector<Polygon> slice_at_height(const std::vector<float>& soup, double height, std::string& error) {
  std::vector<Segment> segments;
  segments.reserve(soup.size() / 9);
  for (std::size_t offset = 0; offset < soup.size(); offset += 9) {
    Segment segment;
    if (intersect_triangle(soup.data() + offset, height, segment)) segments.push_back(segment);
  }
  return chain_closed_loops(std::move(segments), error);
}

std::uint64_t height_key(double height) {
  std::uint64_t key = 0;
  static_assert(sizeof(key) == sizeof(height), "double key size");
  std::memcpy(&key, &height, sizeof(key));
  return key;
}

}

SupportSlicerCapability support_slicer_capability() { return {}; }

SupportSliceBatch slice_support_mesh_fallback(
  const std::vector<float>& triangle_soup,
  const std::vector<double>& heights)
{
  SupportSliceBatch result;
  if (triangle_soup.empty() || triangle_soup.size() % 9 != 0) {
    result.error = "support mesh: expected non-empty triangle soup";
    return result;
  }
  for (float coordinate : triangle_soup)
    if (!std::isfinite(coordinate)) {
      result.error = "support mesh: non-finite coordinate";
      return result;
    }
  std::unordered_map<std::uint64_t, std::vector<Polygon>> cache;
  result.slices.reserve(heights.size());
  for (double height : heights) {
    if (!std::isfinite(height)) {
      result.error = "support heights: non-finite value";
      return result;
    }
    const std::uint64_t key = height_key(height);
    const auto found = cache.find(key);
    if (found != cache.end()) {
      ++result.cache.hits;
      result.slices.push_back(found->second);
      continue;
    }
    ++result.cache.misses;
    std::vector<Polygon> slice = slice_at_height(triangle_soup, height, result.error);
    if (!result.error.empty()) return result;
    cache.emplace(key, slice);
    result.slices.push_back(std::move(slice));
  }
  result.ok = true;
  return result;
}

}
