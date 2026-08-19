import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import createSlicer from '../engine/src/slicer_core.js'

const here = dirname(fileURLToPath(import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'sla-pad-'))

// Given: the SLA source group. When: the pad capability is audited. Then: the upstream Pad group
// (Pad.cpp + ConcaveHull + Tesselate) is linked and the capability is the supported prusa_port backend.
const build = readFileSync(join(here, 'build.sh'), 'utf8')
const sourceMatch = build.match(/^SLA_SRC="([^"]+)"/m)
assert.ok(sourceMatch, 'build.sh must declare SLA_SRC')
const linked = sourceMatch[1].split(/\s+/)
for (const unit of ['SLA/Pad.cpp', 'SLA/ConcaveHull.cpp', 'Tesselate.cpp'])
  assert.ok(linked.some(path => path.endsWith(unit)), `${unit} must be linked`)
assert.match(build, /glu-libtess/)
const notes = readFileSync(join(here, 'slasupport_port/PORT_NOTES.md'), 'utf8')
assert.match(notes, /Pad \(Pad\.cpp \+ ConcaveHull \+ Tesselate\/glu-libtess, LINKED\)/)
assert.match(notes, /SLA_PAD_AROUND_OBJECT_UNSUPPORTED/)

function boxSTL() {
  const vertices = [[-5,-5,0],[5,-5,0],[5,5,0],[-5,5,0],[-5,-5,5],[5,-5,5],[5,5,5],[-5,5,5]]
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  const buffer = Buffer.alloc(84 + faces.length * 50)
  buffer.writeUInt32LE(faces.length, 80)
  faces.forEach((face, index) => {
    let offset = 84 + index * 50 + 12
    for (const vertexIndex of face) for (const value of vertices[vertexIndex]) {
      buffer.writeFloatLE(value, offset)
      offset += 4
    }
  })
  return new Uint8Array(buffer)
}

const params = over => JSON.stringify({
  layer_height: 0.05,
  initial_layer_height: 0.05,
  bed_width: 120.96,
  bed_depth: 68.04,
  ...over,
})

const roleSegments = (layer, role) => {
  const segments = []
  for (let index = 0; index < layer.paths.length; index += 8) {
    if ((layer.paths[index + 3] & 15) !== role) continue
    segments.push([
      [layer.paths[index], layer.paths[index + 1]],
      [layer.paths[index + 4], layer.paths[index + 5]],
    ])
  }
  return segments
}

try {
  // Given: the plain-data bridge alone. Then: pad_capability() is the supported prusa_port backend.
  const source = join(temporary, 'capability.cpp')
  const binary = join(temporary, 'capability')
  writeFileSync(source, String.raw`
#include "slasupport_bridge.h"
#include <cassert>
#include <iostream>
#include <string>
using namespace slasupport_bridge;
int main() {
  const PadCapability capability = pad_capability();
  assert(capability.status == PadCapabilityStatus::supported);
  assert(std::string(capability.code) == "SLA_PAD_SUPPORTED");
  assert(std::string(capability.backend) == "prusa_port");
  std::cout << capability.code << ' ' << capability.backend << '\n';
}
`)
  execFileSync('c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', here,
    source, join(here, 'slasupport_bridge_validate.cpp'), '-o', binary], { stdio: 'inherit' })
  assert.equal(execFileSync(binary, { encoding: 'utf8' }).trim(), 'SLA_PAD_SUPPORTED prusa_port')

  const slicer = await createSlicer()

  // Given: pad disabled. Then: no role-6 output of any kind (byte-identical disabled behavior).
  const off = slicer.slice_sla(boxSTL(), params({ pad_enable: false }), undefined)
  assert.equal(off.stats.pad_layers, 0)
  assert.equal(off.pad_mesh.length, 0)
  assert.ok(off.layers.every(layer => roleSegments(layer, 6).length === 0))

  // Given: pad enabled, supports off (default 2mm-thick flat pad).
  // Then: the ported pad occupies the bottom pad zone, the MODEL rises above it, and the layer count grows
  // by exactly the pad zone.
  const on = slicer.slice_sla(boxSTL(), params({ pad_enable: true }), undefined)
  assert.equal(on.stats.pad_capability, 'supported')
  assert.equal(on.stats.pad_code, 'SLA_PAD_SUPPORTED')
  assert.equal(on.stats.pad_backend, 'prusa_port')
  assert.equal(on.stats.pad_parity_status, 'upstream')
  assert.equal(on.stats.pad_error, undefined)
  assert.ok(on.pad_mesh.length > 0 && on.pad_mesh.length % 9 === 0)
  const padZone = 40 // ceil(pad_wall_thickness 2mm / 0.05)
  assert.equal(on.stats.layers, off.stats.layers + padZone)
  assert.equal(on.stats.pad_layers, padZone)
  const padLayerIndexes = on.layers.flatMap((layer, index) => roleSegments(layer, 6).length ? [index] : [])
  assert.deepEqual(padLayerIndexes, Array.from({ length: padZone }, (_, index) => index),
    'role-6 fills exactly the pad zone at the bottom')
  assert.ok(on.layers.slice(0, padZone).every(layer => roleSegments(layer, 1).length === 0),
    'no model contour inside the pad zone')
  assert.ok(roleSegments(on.layers[padZone], 1).length > 0, 'the model starts right above the pad')
  // The pad mesh itself sits on the plate and is exactly full_height tall.
  let zmin = Infinity, zmax = -Infinity
  for (let index = 2; index < on.pad_mesh.length; index += 3) {
    zmin = Math.min(zmin, on.pad_mesh[index]); zmax = Math.max(zmax, on.pad_mesh[index])
  }
  assert.ok(Math.abs(zmin) < 1e-4 && Math.abs(zmax - 2) < 1e-4, `pad z range [${zmin}, ${zmax}]`)
  // Brim: the pad silhouette reaches beyond the model footprint.
  let xmax = 0
  for (let index = 0; index < on.pad_mesh.length; index += 3) xmax = Math.max(xmax, Math.abs(on.pad_mesh[index]))
  assert.ok(xmax > 5.5, `pad reaches ${xmax}, expected beyond the 5mm footprint + brim`)

  // Given: pad + supports. Then: the feet stand ON the pad (support paths never below the pad zone top),
  // and the whole stack is pad + elevation + model.
  const sup = slicer.slice_sla(boxSTL(),
    params({ pad_enable: true, supports_enable: true, support_object_elevation: 5 }), undefined)
  assert.equal(sup.stats.pad_layers, padZone)
  assert.equal(sup.stats.layers, off.stats.layers + padZone + 100) // + elevation 5mm / 0.05
  assert.ok(sup.stats.support_points > 0)
  assert.ok(sup.support_mesh.length > 0 && sup.pad_mesh.length > 0)
  let supportZmin = Infinity
  for (let index = 2; index < sup.support_mesh.length; index += 3)
    supportZmin = Math.min(supportZmin, sup.support_mesh[index])
  assert.ok(supportZmin > 2 - 0.35, `support mesh bottom ${supportZmin} must stand on the 2mm pad top`)

  // Given: pad_around_object. Then: the typed unsupported error, and no pad output at all.
  const embed = slicer.slice_sla(boxSTL(), params({ pad_enable: true, pad_around_object: true }), undefined)
  assert.equal(embed.stats.pad_error, 'SLA_PAD_AROUND_OBJECT_UNSUPPORTED')
  assert.equal(embed.pad_mesh.length, 0)
  assert.equal(embed.stats.pad_layers, 0)
  assert.equal(embed.stats.layers, off.stats.layers, 'the embed gate must not lift the stack')

  // Given: a pad request that cannot be satisfied (supports on but enforcers-only filters every point, so
  // nothing reaches the plate to blueprint). Then: the SLICE fails — upstream's SlicingError semantics —
  // instead of silently emitting a scene lifted by a pad zone with nothing underneath.
  const unpaddable = slicer.slice_sla(boxSTL(),
    params({ pad_enable: true, supports_enable: true, support_object_elevation: 5, support_enforcers_only: true }), undefined)
  assert.match(unpaddable.error ?? '', /pad/, `expected a pad slicing error, got: ${unpaddable.error}`)

  // Determinism: the ported pad produces identical bytes across runs.
  const again = slicer.slice_sla(boxSTL(), params({ pad_enable: true }), undefined)
  assert.deepEqual(again.pad_mesh, on.pad_mesh)

  console.log('test_sla_pad: ported pad geometry, lifted layer frame, feet-on-pad, embed gate, and pad-off isolation passed')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
