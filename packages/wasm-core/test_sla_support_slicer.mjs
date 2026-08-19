import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'sla-support-slicer-'))
const source = join(temporary, 'test.cpp')
const binary = join(temporary, 'test')

const harness = String.raw`
#include "slasupport_bridge.h"
#include <algorithm>
#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

using namespace slasupport_bridge;

void triangle(std::vector<float>& mesh, Vec3 a, Vec3 b, Vec3 c) {
  for (const Vec3& p : {a, b, c}) {
    mesh.push_back(float(p.x)); mesh.push_back(float(p.y)); mesh.push_back(float(p.z));
  }
}

void wall(std::vector<float>& mesh, double ax, double ay, double bx, double by, double z0, double z1) {
  triangle(mesh, {ax,ay,z0}, {bx,by,z0}, {bx,by,z1});
  triangle(mesh, {ax,ay,z0}, {bx,by,z1}, {ax,ay,z1});
}

void ring(std::vector<float>& mesh, double lo, double hi, double z0, double z1) {
  wall(mesh, lo,lo, hi,lo, z0,z1); wall(mesh, hi,lo, hi,hi, z0,z1);
  wall(mesh, hi,hi, lo,hi, z0,z1); wall(mesh, lo,hi, lo,lo, z0,z1);
}

// The same square shell with the winding reversed: normals face INWARD, i.e. a genuine cavity boundary.
void ring_cavity(std::vector<float>& mesh, double lo, double hi, double z0, double z1) {
  wall(mesh, hi,lo, lo,lo, z0,z1); wall(mesh, hi,hi, hi,lo, z0,z1);
  wall(mesh, lo,hi, hi,hi, z0,z1); wall(mesh, lo,lo, lo,hi, z0,z1);
}

double signed_area(const Polygon& polygon) {
  double area = 0;
  for (std::size_t i = 0; i < polygon.size(); ++i) {
    const Vec2& a = polygon[i]; const Vec2& b = polygon[(i + 1) % polygon.size()];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

int main() {
  const SupportSlicerCapability capability = support_slicer_capability();
  assert(capability.status == SupportSlicerCapabilityStatus::dependency_unavailable);
  assert(std::string(capability.code) == "SLA_SUPPORT_ANALYTICAL_CACHE_DEPENDENCY_UNAVAILABLE");
  assert(std::string(capability.backend) == "generic_mesh_sweep_fallback");

  // Given a genuine hollow prism: outward outer shell, INWARD (reversed-winding) inner shell.
  std::vector<float> hollow;
  ring(hollow, 0, 10, 0, 2); ring_cavity(hollow, 3, 7, 0, 2);
  // When the same interior height is requested twice and an out-of-range height once.
  SupportSliceBatch hollow_result = slice_support_mesh_fallback(hollow, {1, 1, 3});
  // Then the first slice has one closed outer loop and one oppositely wound hole,
  // the repeated request is served from cache, and the out-of-range slice is empty.
  assert(hollow_result.ok && hollow_result.slices.size() == 3);
  assert(hollow_result.slices[0].size() == 2 && hollow_result.slices[1].size() == 2);
  assert(hollow_result.slices[2].empty());
  std::vector<double> areas;
  for (const Polygon& polygon : hollow_result.slices[0]) {
    assert(polygon.size() >= 4);
    areas.push_back(signed_area(polygon));
  }
  std::sort(areas.begin(), areas.end());
  assert(std::abs(areas[0] + 16) < 1e-6);
  assert(std::abs(areas[1] - 100) < 1e-6);
  assert(hollow_result.cache.hits == 1 && hollow_result.cache.misses == 2);

  // Given INTERPENETRATING solids: two outward shells nested like a pillar inside its pedestal.
  // Nesting depth would call the inner one a hole; the triangle winding says both are solid — and it is
  // the winding that must win, or the pillar's core rasterizes empty and the print starts in mid-air.
  std::vector<float> nested;
  ring(nested, 0, 10, 0, 2); ring(nested, 3, 7, 0, 2);
  SupportSliceBatch nested_result = slice_support_mesh_fallback(nested, {1});
  assert(nested_result.ok && nested_result.slices[0].size() == 2);
  for (const Polygon& polygon : nested_result.slices[0])
    assert(signed_area(polygon) > 0);

  // Given two disconnected solid wall shells at the same height.
  std::vector<float> separate;
  ring(separate, 0, 2, 0, 2); ring(separate, 5, 7, 0, 2);
  // When sliced once, both components survive as independent outer topology.
  SupportSliceBatch separate_result = slice_support_mesh_fallback(separate, {1});
  assert(separate_result.ok && separate_result.slices[0].size() == 2);
  for (const Polygon& polygon : separate_result.slices[0])
    assert(std::abs(signed_area(polygon) - 4) < 1e-6);

  std::cout << "backend=generic_mesh_sweep_fallback hollow_loops=2 hole_area=16 outer_area=100 "
               "nested_solids=positive components=2 cache_hits=1 cache_misses=2\n";
}
`

try {
  writeFileSync(source, harness)
  execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', here,
    source, join(here, 'slasupport_slicer_fallback.cpp'), '-o', binary], { stdio: 'inherit' })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(),
    'backend=generic_mesh_sweep_fallback hollow_loops=2 hole_area=16 outer_area=100 nested_solids=positive components=2 cache_hits=1 cache_misses=2')
  console.log('test_sla_support_slicer: winding-true loops (interpenetrating solids stay solid, real cavities stay holes), disconnected topology, capability, and cache behavior passed')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
