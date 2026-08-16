// A small toolpath viewer: kernel layers -> GPU geometry -> a three.js scene you can orbit.
//
// This is `three-slicer/viewer/toolpath`, which is a geometry builder, not a UI component — the scene,
// the camera and the controls below are the host's own. Copy the file as-is; it only needs three.
//
// Two things that are easy to get wrong and are handled here:
//   * `SegmentData.position` is stride 4 (x, y, z, w). Reading it as a packed vec3 array mixes the
//     channels and any bbox computed from it is meaningless.
//   * Framing on everything puts the part in the distance: `data.bbox` includes travel moves, which
//     start at the origin, and the first layer carries the printer's prime line along the bed edge.
//     Measured on a 20 mm cube: the part rendered ~25 px wide in an 892 px canvas. Frame on the
//     extrusions above the first layer instead.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildSegmentData, makeToolpath, computeColors, roleRatios, TYPE_LABEL } from 'three-slicer/viewer/toolpath'

export function createToolpathView(canvas, { background = 0x0c0f14 } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(background)
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000)
  camera.up.set(0, 0, 1)

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true

  let handle = null
  let data = null

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(canvas)
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera) })

  const clear = () => {
    if (!handle) return
    scene.remove(handle.mesh, handle.travLines)
    handle.dispose()
    handle = null
    data = null
  }

  const frame = () => {
    if (!data?.nV) return
    const STRIDE = 4
    let floorZ = Infinity
    for (let i = 2; i < data.nV * STRIDE; i += STRIDE) floorZ = Math.min(floorZ, data.position[i])

    const fit = fromZ => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, any = false
      for (let i = 0; i < data.nV * STRIDE; i += STRIDE) {
        const z = data.position[i + 2]
        if (z < fromZ) continue
        const x = data.position[i], y = data.position[i + 1]
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
        if (z > maxZ) maxZ = z
        any = true
      }
      return any ? { minX, minY, maxX, maxY, maxZ } : null
    }

    const box = fit(floorZ + 0.5) ?? fit(-Infinity)
    if (!box) return
    const cx = (box.minX + box.maxX) / 2
    const cy = (box.minY + box.maxY) / 2
    const cz = (floorZ + box.maxZ) / 2
    const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - floorZ, 10)
    camera.position.set(cx + span * 1.1, cy - span * 1.4, cz + span * 1.0)
    controls.target.set(cx, cy, cz)
    controls.update()
  }

  return {
    /** `layers` is the slice result's own `layers` (or parseGcode's) — [{ z, paths, widths }]. */
    show(layers, defaultLineWidth = 0.42) {
      clear()
      if (!layers?.length) return { layerCount: 0, segments: 0, roles: [] }

      data = buildSegmentData(layers, defaultLineWidth)
      handle = makeToolpath(THREE, data)
      handle.setColors(computeColors(data, 'feature', {}).color)
      handle.setLayerRange(0, handle.layerCount - 1)     // everything, by default
      handle.setTravelVisible(true)
      scene.add(handle.mesh, handle.travLines)
      frame()
      resize()

      return {
        layerCount: handle.layerCount,
        segments: handle.nSeg,
        roles: roleRatios(data.typeLengths).map(r => ({ ...r, label: r.label ?? TYPE_LABEL[r.type] })),
      }
    },

    /** Show layers 1..n (1-based, as a user counts them). */
    setTopLayer(n) {
      if (!handle) return
      handle.setLayerRange(0, Math.max(0, Math.min(handle.layerCount - 1, n - 1)))
    },

    setTravel(visible) { handle?.setTravelVisible(visible) },

    get layerCount() { return handle?.layerCount ?? 0 },

    resize,
    dispose() { clear(); controls.dispose(); renderer.dispose() },
  }
}
