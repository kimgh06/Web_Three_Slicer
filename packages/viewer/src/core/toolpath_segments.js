// Stage 24: faithful port of the upstream libvgcode toolpath renderer (CPU geometry builder dropped -> GPU instancing).
//  Upstream: src/libvgcode/{SegmentTemplate.cpp, ShadersES.hpp(Segments_Vertex_Shader_ES), ViewerImpl.cpp(extract_pos_and_or_hwa)}.
//  Structure: an 8-vertex diamond template (24 indices) x InstancedBufferGeometry, segment data in a DataTexture (RGBA32F/32UI)
//        + RawShaderMaterial (GLSL3). The vertex shader is a straight port of the upstream ES variant (algorithm unchanged).
//  The CPU builds no geometry — only the PathVertex stream (endpoints + height/width/color) and precomputed segment join angles.
// This file owns the CPU side only: kernel layers -> the PathVertex stream the GPU consumes.
import { TYPE_COLOR, TYPE_LABEL, packColor } from './toolpath_palette.js'

// The stride-8 role field (paths[k+3]) carries the printing extruder alongside the role: value = role + tool * 16.
//  Roles only ever run 0..11, so the spare high bits are used instead of widening the stride to 9 — the segment
//  stream is the largest array the viewer holds, and a 9th float would cost +12.5% of it for one small integer.
//  Output sliced before this encoding existed is entirely below 16, so it decodes to its own role and tool 0.
const ROLE_MASK = 15, TOOL_SHIFT = 4

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
  const vx = [], vy = [], vz = [], vh = [], vw = [], vtype = [], vtool = [], vlayer = []
  const realNext = []          // realNext[i]=true -> segment (i,i+1) is an extrusion segment that actually gets drawn
  const segIdA = [], segLayer = []
  const typeLengths = new Float64Array(16)   // stage 25 S6.3: total extruded length per type (for the role-share legend)
  const travel = [], travelLayer = []   // travels: [x0,y0,z0,x1,y1,z1] per seg
  // How many of this LAYER's extrusion segments were already emitted when each travel happened. Extrusions and
  //  travels are drawn from two separate lists, but the printer performs them in ONE order, and the move scrub
  //  (setMoveRange) has to cut both at the same instant — cutting each list by the same count would show every
  //  extrusion first and then the travels. This is the smallest thing that restores the interleaving: one int per
  //  travel, from which moveCursor recovers the split by binary search. A full combined-index map would be one
  //  int per MOVE, and the segment stream is already the largest array the viewer holds.
  const travelSegBefore = []
  let lastIdx = -1, lastX = 0, lastY = 0, lastZ = 0, lastEncoded = -1, curLayer = 0
  const EPS = 1e-4
  const push = (x, y, z, t, tool, h, w) => { vx.push(x); vy.push(y); vz.push(z); vtype.push(t); vtool.push(tool); vh.push(h); vw.push(w); vlayer.push(curLayer); realNext.push(false); return vx.length - 1 }

  for (let li = 0; li < L; li++) {
    const paths = layers[li].paths, widths = layers[li].widths, h = layerH[li]
    curLayer = li
    if (!paths) continue
    const segAtLayerStart = segIdA.length
    for (let k = 0; k < paths.length; k += 8) {
      const encoded = paths[k + 3]                                  // role + tool * 16 (see ROLE_MASK above)
      const type = encoded & ROLE_MASK, tool = encoded >>> TOOL_SHIFT
      const x0 = paths[k], y0 = paths[k + 1], z0 = paths[k + 2], x1 = paths[k + 4], y1 = paths[k + 5], z1 = paths[k + 6]
      if (type === 0) {
        travel.push(x0, y0, z0, x1, y1, z1); travelLayer.push(li)
        travelSegBefore.push(segIdA.length - segAtLayerStart)
        continue
      }
      const w = (widths && widths[k / 8] > 0) ? widths[k / 8] : lw
      typeLengths[type] += Math.hypot(x1 - x0, y1 - y0)   // accumulate length per role — the mask keeps the index in range
      let idA
      // Compared on the encoded value, so a tool change breaks the run: two extruders meeting at the same point are
      //  separate beads and must not be mitered into one. For untooled output the encoded value *is* the role.
      if (lastIdx >= 0 && lastEncoded === encoded &&
          Math.abs(lastX - x0) < EPS && Math.abs(lastY - y0) < EPS && Math.abs(lastZ - z0) < EPS) {
        idA = lastIdx                          // reuse the previous segment's endpoint (connected) -> shared vertex
        push(x1, y1, z1, type, tool, h, w)     // append endpoint B at idA+1
      } else {
        idA = push(x0, y0, z0, type, tool, h, w)   // new run: start A
        push(x1, y1, z1, type, tool, h, w)         // end B (= idA+1)
      }
      realNext[idA] = true
      lastIdx = idA + 1; lastX = x1; lastY = y1; lastZ = z1; lastEncoded = encoded
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
  const meta = { vType: new Uint8Array(nV), vTool: new Uint8Array(nV), vWidth: new Float32Array(nV), vHeight: new Float32Array(nV), vLayer: new Int32Array(nV) }
  for (let i = 0; i < nV; i++) { meta.vType[i] = vtype[i]; meta.vTool[i] = vtool[i]; meta.vWidth[i] = vw[i]; meta.vHeight[i] = vh[i]; meta.vLayer[i] = vlayer[i] }
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
  const travelSegBeforeArr = new Int32Array(nTrav)
  for (let i = 0; i < nTrav; i++) travelSegBeforeArr[i] = travelSegBefore[i]

  const bbox = nV + nTrav > 0 ? { min: [bx0, by0, bz0], max: [bx1, by1, bz1] } : null
  return { position, hwa, segIndex, nV, nSeg, layerSegPrefix, travelPos, travelPrefix, travelSegBefore: travelSegBeforeArr,
           nTrav, layerCount: L, maxAbs, hasNaN, meta, typeLengths, bbox }
}

/** How many moves — extrusions and travels together — one layer performs. The move scrub's range. */
export function layerMoveCount(data, layer) {
  const li = Math.max(0, Math.min(data.layerCount - 1, layer | 0))
  return (data.layerSegPrefix[li + 1] - data.layerSegPrefix[li])
       + (data.travelPrefix[li + 1] - data.travelPrefix[li])
}

/**
 * The layer the move scrub actually walks: the topmost one in [lo, hi] that HAS moves.
 *
 * Not a nicety — it is the normal case. The kernel streams one more layer than it prints (measured on a 20mm
 * cube: 100 `onLayer` calls, `stats.layers` 99, the last one carrying an empty `paths`), so the layer slider's
 * top position is routinely an empty layer and a scrub pinned to it would have nothing to walk on every fresh
 * slice. The topmost layer with moves is also the topmost layer the user can SEE, which is what the scrub and
 * the nozzle marker are about.
 */
export function topMoveLayer(data, lo, hi) {
  const last = data.layerCount - 1
  const a = Math.max(0, Math.min(last, lo | 0)), b = Math.max(a, Math.min(last, hi | 0))
  for (let li = b; li >= a; li--) if (layerMoveCount(data, li) > 0) return li
  return b
}

/**
 * Where the nozzle is `at` moves into `layer`, and how much of each draw list that accounts for — upstream's
 * sequential view (GCodeViewer's update_sequential_view_current) reduced to what the two lists here need.
 *
 * The interleaving is recovered rather than stored: within a layer, travel t sits at combined index
 * `travelSegBefore[t] + (t - travelStart)`, which is ascending, so a binary search over the layer's travels
 * counts how many of them precede `at`. Everything left is extrusions.
 *
 * Returns `{ segCount, travCount, point, onTravel }` — `point` is the nozzle position (kernel frame, the real
 * z, not the diamond-centre z the position array holds), or null at `at === 0`.
 */
export function moveCursor(data, layer, at) {
  const li = Math.max(0, Math.min(data.layerCount - 1, layer | 0))
  const segStart = data.layerSegPrefix[li], travStart = data.travelPrefix[li]
  const total = layerMoveCount(data, li)
  const k = Math.max(0, Math.min(total, at | 0))
  // Lower bound: the first travel of this layer whose combined index is >= k.
  let lo = travStart, hi = data.travelPrefix[li + 1]
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (data.travelSegBefore[mid] + (mid - travStart) < k) lo = mid + 1
    else hi = mid
  }
  const travCount = lo - travStart
  const segCount = k - travCount
  if (k === 0) return { segCount: 0, travCount: 0, point: null, onTravel: false }
  // Which list the LAST move came from decides where the nozzle ended up.
  const lastTravel = lo > travStart && data.travelSegBefore[lo - 1] + (lo - 1 - travStart) === k - 1
  if (lastTravel) {
    const t = (lo - 1) * 6
    return { segCount, travCount, onTravel: true, point: [data.travelPos[t + 3], data.travelPos[t + 4], data.travelPos[t + 5]] }
  }
  const s = segStart + segCount - 1
  const v = data.segIndex[s * 4] + 1          // .r = id_a; the segment's far endpoint is the next vertex
  // The position array holds z - 0.5*height (upstream centres the diamond on the bead); hwa.x is that height.
  return { segCount, travCount, onTravel: false,
           point: [data.position[v * 4], data.position[v * 4 + 1], data.position[v * 4 + 2] + 0.5 * data.hwa[v * 4]] }
}

// S6.3: role-share legend data — length % per type (the kernel does not expose time per role -> approximated by length share, documented).
export function roleRatios(typeLengths) {
  let total = 0; for (let t = 1; t < 16; t++) total += typeLengths[t] || 0
  const out = []
  if (total <= 0) return out
  for (let t = 1; t < 16; t++) { const l = typeLengths[t] || 0; if (l > 0) out.push({ type: t, label: TYPE_LABEL[t] || ('t' + t), pct: 100 * l / total, color: TYPE_COLOR[t] || TYPE_COLOR[1] }) }
  return out.sort((a, b) => b.pct - a.pct)
}
