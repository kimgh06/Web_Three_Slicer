// The "CAD" side: one parametric part, built with three.js primitives. There is no B-rep kernel here —
// the point of the demo is the feedback loop, not the modelling.
import * as THREE from 'three'

export const LIMITS = {
  width: { min: 30, max: 160, step: 1 },
  height: { min: 20, max: 120, step: 1 },
  thickness: { min: 2, max: 16, step: 0.5 },
  holeDiameter: { min: 3, max: 40, step: 0.5 },
}

export const DEFAULTS = { width: 80, height: 50, thickness: 4, holeDiameter: 8 }

/** A domain error the design tool must catch before anything is sliced. */
export function validate({ width, height, holeDiameter }) {
  const margin = 3
  const room = Math.min(width, height) - 2 * margin
  if (holeDiameter >= room) {
    return `A ${holeDiameter} mm hole leaves less than ${margin} mm of material — max ${Math.floor(room * 2) / 2} mm here.`
  }
  return null
}

/** A flat plate with a through hole, lying in XY with its thickness along +Z (the bed's up). */
export function makeBracket({ width, height, thickness, holeDiameter }) {
  const shape = new THREE.Shape()
  shape.moveTo(-width / 2, -height / 2)
  shape.lineTo(width / 2, -height / 2)
  shape.lineTo(width / 2, height / 2)
  shape.lineTo(-width / 2, height / 2)
  shape.closePath()

  const hole = new THREE.Path()
  hole.absarc(0, 0, holeDiameter / 2, 0, Math.PI * 2, true)
  shape.holes.push(hole)

  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 48 })
}

/**
 * Triangle soup (N*9) for the slicer, which wants plain triangles rather than an index buffer.
 * ExtrudeGeometry already produces a non-indexed buffer, and `toNonIndexed()` warns when asked to
 * convert one — so only convert what actually needs it.
 */
export function trianglesOf(geometry) {
  const soup = geometry.index ? geometry.toNonIndexed() : geometry
  return soup.attributes.position.array
}
