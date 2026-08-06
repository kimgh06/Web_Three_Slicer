// Stage 24: faithful port of the upstream libvgcode toolpath renderer (CPU geometry builder dropped -> GPU instancing).
//  Upstream: src/libvgcode/{SegmentTemplate.cpp, ShadersES.hpp(Segments_Vertex_Shader_ES), ViewerImpl.cpp(extract_pos_and_or_hwa)}.
//  Structure: an 8-vertex diamond template (24 indices) x InstancedBufferGeometry, segment data in a DataTexture (RGBA32F/32UI)
//        + RawShaderMaterial (GLSL3). The vertex shader is a straight port of the upstream ES variant (algorithm unchanged).
//  The CPU builds no geometry — only the PathVertex stream (endpoints + height/width/color) and precomputed segment join angles.
// This file owns the CPU side only: kernel layers -> the PathVertex stream the GPU consumes.
import { TYPE_COLOR, TYPE_LABEL, packColor } from './toolpath_palette.js'

// ── CPU data preparation (pure functions — testable under node) ───────────────
//  Kernel layers[{z,paths(stride8),widths[]}] -> PathVertex stream + segment indices.
//  Follows the upstream extract_pos_and_or_hwa: position.z -= 0.5*height, angle = atan2(prev x this, prev · this).
//  Connected extrusion segments (matching endpoint, same type) share a vertex -> the join angle is computed, forming a miter join.
//  Travels (type 0) are not instanced -> they go into a separate line stream.
export function buildSegmentData(layers, defaultLineWidth) {
  const L = layers.length
  const lw = defaultLineWidth > 0 ? defaultLineWidth : 0.42
  // Bead height per layer = the z increment (first layer = z0, so raft/first_layer are picked up automatically)
  const layerH = new Array(L)
  for (let i = 0; i < L; i++) { const z = layers[i].z; layerH[i] = Math.max(0.02, i === 0 ? z : z - layers[i - 1].z) }

  // PathVertex stream (raw)
  const vx = [], vy = [], vz = [], vh = [], vw = [], vtype = [], vlayer = []
  const realNext = []          // realNext[i]=true -> segment (i,i+1) is an extrusion segment that actually gets drawn
  const segIdA = [], segLayer = []
  const typeLengths = new Float64Array(16)   // stage 25 S6.3: total extruded length per type (for the role-share legend)
  const travel = [], travelLayer = []   // travels: [x0,y0,z0,x1,y1,z1] per seg
  let lastIdx = -1, lastX = 0, lastY = 0, lastZ = 0, lastType = -1, curLayer = 0
  const EPS = 1e-4
  const push = (x, y, z, t, h, w) => { vx.push(x); vy.push(y); vz.push(z); vtype.push(t); vh.push(h); vw.push(w); vlayer.push(curLayer); realNext.push(false); return vx.length - 1 }

  for (let li = 0; li < L; li++) {
    const paths = layers[li].paths, widths = layers[li].widths, h = layerH[li]
    curLayer = li
    if (!paths) continue
    for (let k = 0; k < paths.length; k += 8) {
      const type = paths[k + 3]
      const x0 = paths[k], y0 = paths[k + 1], z0 = paths[k + 2], x1 = paths[k + 4], y1 = paths[k + 5], z1 = paths[k + 6]
      if (type === 0) { travel.push(x0, y0, z0, x1, y1, z1); travelLayer.push(li); continue }
      const w = (widths && widths[k / 8] > 0) ? widths[k / 8] : lw
      if (type < 16) typeLengths[type] += Math.hypot(x1 - x0, y1 - y0)   // accumulate length per role
      let idA
      if (lastIdx >= 0 && lastType === type &&
          Math.abs(lastX - x0) < EPS && Math.abs(lastY - y0) < EPS && Math.abs(lastZ - z0) < EPS) {
        idA = lastIdx                    // reuse the previous segment's endpoint (connected) -> shared vertex
        push(x1, y1, z1, type, h, w)     // append endpoint B at idA+1
      } else {
        idA = push(x0, y0, z0, type, h, w)   // new run: start A
        push(x1, y1, z1, type, h, w)         // end B (= idA+1)
      }
      realNext[idA] = true
      lastIdx = idA + 1; lastX = x1; lastY = y1; lastZ = z1; lastType = type
      segIdA.push(idA); segLayer.push(li)
    }
  }

  const nV = vx.length, nSeg = segIdA.length
  // Texture arrays (RGBA). The color is packed into hwa.w instead of a separate texture — saves one texelFetch per vertex and one texture.
  const position = new Float32Array(nV * 4)
  const hwa = new Float32Array(nV * 4)
  let maxAbs = 0, hasNaN = false
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity   // bbox for frustum culling
  for (let i = 0; i < nV; i++) {
    const h = vh[i]
    // Upstream: position.z -= 0.5*height (places the diamond center at the middle of the bead)
    const px = vx[i], py = vy[i], pz = vz[i] - 0.5 * h
    position[i * 4] = px; position[i * 4 + 1] = py; position[i * 4 + 2] = pz
    // angle = atan2(prev x this, prev · this) — upstream extract_pos_and_or_hwa
    const prevValid = i > 0 && realNext[i - 1]
    const thisValid = realNext[i]
    let angle = 0
    if (prevValid || thisValid) {
      const pdx = prevValid ? vx[i] - vx[i - 1] : 0, pdy = prevValid ? vy[i] - vy[i - 1] : 0, pdz = prevValid ? vz[i] - vz[i - 1] : 0
      const tdx = thisValid ? vx[i + 1] - vx[i] : 0, tdy = thisValid ? vy[i + 1] - vy[i] : 0, tdz = thisValid ? vz[i + 1] - vz[i] : 0
      angle = Math.atan2(pdx * tdy - pdy * tdx, pdx * tdx + pdy * tdy + pdz * tdz)
    }
    hwa[i * 4] = h; hwa[i * 4 + 1] = vw[i]; hwa[i * 4 + 2] = angle
    hwa[i * 4 + 3] = packColor(TYPE_COLOR[vtype[i]] || TYPE_COLOR[1])   // .w = packed color (exact in f32 below 2^24)
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) || !Number.isFinite(angle)) hasNaN = true
    maxAbs = Math.max(maxAbs, Math.abs(px), Math.abs(py), Math.abs(pz))
    if (px < bx0) bx0 = px; if (px > bx1) bx1 = px
    if (py < by0) by0 = py; if (py > by1) by1 = py
    if (pz < bz0) bz0 = pz; if (pz > bz1) bz1 = pz
  }
  // Segment indices (layer order) + a per-layer running prefix (O(1) visible range)
  //  .r=id_a, .g=layer (lets the shader decide the dual slider's lower cut in O(1) -> no texture re-upload)
  const segIndex = new Uint32Array(nSeg * 4)
  for (let s = 0; s < nSeg; s++) { segIndex[s * 4] = segIdA[s]; segIndex[s * 4 + 1] = segLayer[s] }
  // Per-vertex metadata for view-type coloring (used only to recompute value -> color; pure)
  const meta = { vType: new Uint8Array(nV), vWidth: new Float32Array(nV), vHeight: new Float32Array(nV), vLayer: new Int32Array(nV) }
  for (let i = 0; i < nV; i++) { meta.vType[i] = vtype[i]; meta.vWidth[i] = vw[i]; meta.vHeight[i] = vh[i]; meta.vLayer[i] = vlayer[i] }
  const layerSegPrefix = new Int32Array(L + 1)   // prefix[n] = number of segments with layer<n (segLayer is ascending)
  { let s = 0; for (let n = 0; n < L; n++) { while (s < nSeg && segLayer[s] === n) s++; layerSegPrefix[n + 1] = s } }
  // Travels (layer order) + prefix
  const nTrav = travelLayer.length
  const travelPos = new Float32Array(nTrav * 6)
  for (let i = 0; i < travelPos.length; i++) travelPos[i] = travel[i]
  for (let i = 0; i < travelPos.length; i += 3) {   // travels join the bbox too (culled by the same sphere)
    const x = travelPos[i], y = travelPos[i + 1], z = travelPos[i + 2]
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x
    if (y < by0) by0 = y; if (y > by1) by1 = y
    if (z < bz0) bz0 = z; if (z > bz1) bz1 = z
  }
  const travelPrefix = new Int32Array(L + 1)
  { let s = 0; for (let n = 0; n < L; n++) { while (s < nTrav && travelLayer[s] === n) s++; travelPrefix[n + 1] = s } }

  const bbox = nV + nTrav > 0 ? { min: [bx0, by0, bz0], max: [bx1, by1, bz1] } : null
  return { position, hwa, segIndex, nV, nSeg, layerSegPrefix, travelPos, travelPrefix, nTrav, layerCount: L, maxAbs, hasNaN, meta, typeLengths, bbox }
}

// S6.3: role-share legend data — length % per type (the kernel does not expose time per role -> approximated by length share, documented).
export function roleRatios(typeLengths) {
  let total = 0; for (let t = 1; t < 16; t++) total += typeLengths[t] || 0
  const out = []
  if (total <= 0) return out
  for (let t = 1; t < 16; t++) { const l = typeLengths[t] || 0; if (l > 0) out.push({ type: t, label: TYPE_LABEL[t] || ('t' + t), pct: 100 * l / total, color: TYPE_COLOR[t] || TYPE_COLOR[1] }) }
  return out.sort((a, b) => b.pct - a.pct)
}
