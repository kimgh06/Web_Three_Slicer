// three.js instanced mesh built from a buildSegmentData result. The only file here that touches three.
import { SEG_VS, SEG_FS } from './toolpath_shaders.js'

// Upstream SegmentTemplate.cpp:18 VERTEX_DATA (the 24 triangle indices of the 8-vertex diamond, verbatim).
//   /1-------6\      cross-section = diamond (0=top, 3=bottom, 2/7=front/back spikes, 5/6/4/1=sides/top-bottom)
//  2--0-------5--7
//   \3-------4/
export const VERTEX_DATA = [
  0, 1, 2,  0, 2, 3,   // front spike
  0, 3, 4,  0, 4, 5,   // right/bottom body
  0, 5, 6,  0, 6, 1,   // left/top body
  5, 4, 7,  5, 7, 6,   // back spike
]

// ── three.js instanced mesh creation ──────────────────────────────────────────
//  view_matrix = camera.matrixWorldInverse * mesh.matrixWorld (kernel z-up local -> eye).
//  camera_position is converted into mesh-local (kernel z-up) coordinates (the shader's UP=(0,0,1) matches kernel z-up).
export function makeToolpath(THREE, data) {
  const floatTex = (arr, count) => {
    const W = Math.min(2048, Math.max(1, count)), H = Math.max(1, Math.ceil(count / W))
    const buf = new Float32Array(W * H * 4); buf.set(arr.subarray(0, Math.min(arr.length, W * H * 4)))
    const t = new THREE.DataTexture(buf, W, H, THREE.RGBAFormat, THREE.FloatType)
    t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true
    return t
  }
  const posTex = floatTex(data.position, data.nV)
  const hwaTex = floatTex(data.hwa, data.nV)   // .w = packed color

  const geo = new THREE.InstancedBufferGeometry()
  // Restores the upstream SegmentTemplate approach: 8 vertices + 24 indices (VERTEX_DATA). Compared with expanding to 24 non-indexed vertices,
  //  the vertex shader runs 8 instead of 24 times per instance — same triangles in the same order, so pixels are identical.
  geo.setIndex(VERTEX_DATA)
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3), 3))   // dummy (8 vertices)
  geo.setAttribute('vertex_id_float', new THREE.BufferAttribute(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]), 1))
  // Segment indices live in instance attributes rather than a texture — the segIndex (Uint32 [id_a,layer,0,0]) array is interleaved as-is.
  const segBuf = new THREE.InstancedInterleavedBuffer(data.segIndex, 4)
  geo.setAttribute('seg_id_a_u', new THREE.InterleavedBufferAttribute(segBuf, 1, 0))
  geo.setAttribute('seg_layer_u', new THREE.InterleavedBufferAttribute(segBuf, 1, 1))
  geo.instanceCount = 0

  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      view_matrix: { value: new THREE.Matrix4() },
      projection_matrix: { value: new THREE.Matrix4() },
      camera_position: { value: new THREE.Vector3() },
      position_tex: { value: posTex },
      height_width_angle_tex: { value: hwaTex },
      layer_lo: { value: 0 },
      layer_hi: { value: data.layerCount },
    },
    vertexShader: SEG_VS, fragmentShader: SEG_FS,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geo, mat)
  // Per-plate frustum culling — with a dummy position it cannot be computed automatically, so it is set manually from the buildSegmentData bbox.
  //  Only off-screen plates are skipped, so there is no visual change (measured: multi-plate zoom-in 24 -> 110fps).
  let sphere = null
  if (data.bbox) {
    const { min, max } = data.bbox
    const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)
    const r = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 + 2   // +2mm: headroom for the bead half-width
    sphere = new THREE.Sphere(c, r)
  }
  mesh.frustumCulled = !!sphere
  if (sphere) geo.boundingSphere = sphere
  const _inv = new THREE.Matrix4(), _cw = new THREE.Vector3()
  mesh.onBeforeRender = (renderer, scene, camera) => {
    mat.uniforms.projection_matrix.value.copy(camera.projectionMatrix)
    mat.uniforms.view_matrix.value.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld)
    _inv.copy(mesh.matrixWorld).invert()
    camera.getWorldPosition(_cw).applyMatrix4(_inv)
    mat.uniforms.camera_position.value.copy(_cw)
  }

  // Travels: a separate LineSegments (layer order -> visible range via setDrawRange)
  const travGeo = new THREE.BufferGeometry()
  travGeo.setAttribute('position', new THREE.BufferAttribute(data.travelPos, 3))
  travGeo.setDrawRange(0, 0)
  const travLines = new THREE.LineSegments(travGeo, new THREE.LineBasicMaterial({ color: 0x6b727a }))
  travLines.frustumCulled = !!sphere; travLines.visible = false
  if (sphere) travGeo.boundingSphere = sphere

  let travelOn = false, visLo = 0, visHi = data.layerCount - 1
  const applyTravelRange = () => {
    const ts = data.travelPrefix[visLo], te = data.travelPrefix[visHi + 1]
    travGeo.setDrawRange(travelOn ? ts * 2 : 0, travelOn ? (te - ts) * 2 : 0)
  }
  // Stage 25: dual slider [lo..hi] layer range. Upper bound cut by instanceCount, lower bound clipped by the shader's layer_lo (both O(1)).
  const setLayerRange = (lo, hi) => {
    const L = data.layerCount
    visLo = Math.max(0, Math.min(L - 1, lo | 0)); visHi = Math.max(visLo, Math.min(L - 1, hi | 0))
    mat.uniforms.layer_lo.value = visLo; mat.uniforms.layer_hi.value = visHi
    geo.instanceCount = data.layerSegPrefix[visHi + 1]
    applyTravelRange()
  }
  const setVisibleLayers = (n) => setLayerRange(0, (n | 0) - 1)   // backwards compatible: show the bottom n layers
  const setTravelVisible = (v) => { travelOn = !!v; travLines.visible = travelOn; applyTravelRange() }
  // Upload recomputed view-type colors — packed color goes into hwa.w (computeColors keeps returning [i*4]=packed).
  const setColors = (arr) => {
    const d = hwaTex.image.data, n = Math.min(arr.length, d.length) / 4
    for (let i = 0; i < n; i++) d[i * 4 + 3] = arr[i * 4]
    hwaTex.needsUpdate = true
  }
  const dispose = () => {
    geo.dispose(); mat.dispose(); posTex.dispose(); hwaTex.dispose()
    travGeo.dispose(); travLines.material.dispose()
  }
  return { mesh, travLines, setVisibleLayers, setLayerRange, setTravelVisible, setColors, dispose, nSeg: data.nSeg, layerCount: data.layerCount }
}
