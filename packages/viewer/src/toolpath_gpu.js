// Stage 24: faithful port of the upstream libvgcode toolpath renderer (CPU geometry builder dropped -> GPU instancing).
//  Upstream: src/libvgcode/{SegmentTemplate.cpp, ShadersES.hpp(Segments_Vertex_Shader_ES), ViewerImpl.cpp(extract_pos_and_or_hwa)}.
//  Structure: an 8-vertex diamond template (24 indices) x InstancedBufferGeometry, segment data in a DataTexture (RGBA32F/32UI)
//        + RawShaderMaterial (GLSL3). The vertex shader is a straight port of the upstream ES variant (algorithm unchanged).
//  The CPU builds no geometry — only the PathVertex stream (endpoints + height/width/color) and precomputed segment join angles.

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

// Toolpath type colors (0=travel,1=wall,2=sparse,3=solid,4=skirt/brim,5=support,6=raft,7=gap,8=thin,9=bridge,10=iron,11=prime)
export const TYPE_COLOR = {
  0: [0.42, 0.45, 0.50], 1: [0.85, 0.51, 0.17], 2: [0.21, 0.45, 0.76],
  3: [0.35, 0.75, 0.85], 4: [0.16, 0.68, 0.40], 5: [0.66, 0.42, 0.85], 6: [0.55, 0.45, 0.35],
  7: [0.95, 0.85, 0.25], 8: [0.90, 0.35, 0.65], 9: [0.90, 0.25, 0.25],
  10: [0.60, 0.82, 0.55], 11: [0.30, 0.72, 0.70],
}
function packColor(c) {   // [r,g,b] 0..1 -> r<<16|g<<8|b (inverse of the upstream decode_color; exact in f32 below 2^24)
  const r = Math.round(c[0] * 255), g = Math.round(c[1] * 255), b = Math.round(c[2] * 255)
  return (r << 16) | (g << 8) | b
}

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
export const TYPE_LABEL = { 1: 'Wall', 2: 'Sparse', 3: 'Solid', 4: 'Skirt', 5: 'Support', 6: 'Raft', 7: 'Gap fill', 8: 'Thin wall', 9: 'Bridge', 10: 'Ironing', 11: 'Prime' }
export function roleRatios(typeLengths) {
  let total = 0; for (let t = 1; t < 16; t++) total += typeLengths[t] || 0
  const out = []
  if (total <= 0) return out
  for (let t = 1; t < 16; t++) { const l = typeLengths[t] || 0; if (l > 0) out.push({ type: t, label: TYPE_LABEL[t] || ('t' + t), pct: 100 * l / total, color: TYPE_COLOR[t] || TYPE_COLOR[1] }) }
  return out.sort((a, b) => b.pct - a.pct)
}

// ── View-type coloring (upstream libvgcode ColorRange approach) ───────────────
//  DEFAULT_RANGES_COLORS (src/libvgcode/include/ColorRange.hpp:14) — a blue-to-red 11-color heatmap.
export const DEFAULT_RANGES_COLORS = [
  [11, 44, 122], [19, 89, 133], [28, 136, 145], [4, 214, 15], [170, 242, 0], [252, 249, 3],
  [245, 206, 10], [227, 136, 32], [209, 104, 48], [194, 82, 60], [148, 38, 22],
].map(c => [c[0] / 255, c[1] / 255, c[2] / 255])
// Upstream ColorRange::get_color_at (Linear): step=(hi-lo)/(N-1), t=(v-lo)/step, lerp between adjacent palette colors.
function rangeColorAt(v, lo, hi, pal) {
  const N = pal.length
  if (!(hi > lo)) return pal[0]
  const step = (hi - lo) / (N - 1)
  const gt = (v - lo) / step
  const li = Math.max(0, Math.min(N - 1, Math.floor(gt)))
  const hiI = Math.max(0, Math.min(N - 1, li + 1))
  const f = gt - li
  const a = pal[li], b = pal[hiI]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}
// View type list (the 6 highest-priority EViewType entries from the desktop app). value(i)=view value of vertex i, cont=continuous (heatmap) / false=fixed color.
export const VIEW_TYPES = [
  { key: 'feature', label: 'Feature type', cont: false, unit: '' },
  { key: 'speed',   label: 'Speed',        cont: true,  unit: 'mm/s' },
  { key: 'height',  label: 'Layer Height', cont: true,  unit: 'mm' },
  { key: 'width',   label: 'Line Width',   cont: true,  unit: 'mm' },
  { key: 'fan',     label: 'Fan Speed',    cont: true,  unit: '%' },
  { key: 'temp',    label: 'Temperature',  cont: true,  unit: '°C' },
]
// Per-vertex view value. speed/fan/temp are absent from the kernel toolpath, so they are derived from settings (the cheap option, kernel unchanged).
//  ctx: { speedByType:{type:val}, firstLayerSpeed, fanByType or fanFirstLayers, tempNormal, tempFirst, closeFanLayers }
function viewValue(viewType, meta, i, ctx) {
  const t = meta.vType[i], layer = meta.vLayer[i], first = layer === 0
  switch (viewType) {
    case 'height': return meta.vHeight[i]
    case 'width':  return meta.vWidth[i]
    case 'speed':  return first ? ctx.firstLayerSpeed : (ctx.speedByType[t] ?? ctx.speedByType[1])
    case 'fan':    return (layer < ctx.closeFanLayers) ? 0 : (t === 9 ? 100 : ctx.fanNormal)   // bridge(9)=100%, first N layers=0
    case 'temp':   return first ? ctx.tempFirst : ctx.tempNormal
    default:       return 0
  }
}
// View type -> per-vertex colors, Float32Array(nV*4, .r=packed) + range min/max. feature uses fixed colors.
export function computeColors(data, viewType, ctx) {
  const { meta, nV } = data
  const color = new Float32Array(nV * 4)
  const vt = VIEW_TYPES.find(v => v.key === viewType) || VIEW_TYPES[0]
  if (!vt.cont) {   // Feature type: fixed color per type
    for (let i = 0; i < nV; i++) color[i * 4] = packColor(TYPE_COLOR[meta.vType[i]] || TYPE_COLOR[1])
    return { color, min: 0, max: 0, viewType, label: vt.label, unit: vt.unit, cont: false }
  }
  // Continuous views: value range (extrusion vertices only) -> heatmap
  let lo = Infinity, hi = -Infinity
  const vals = new Float32Array(nV)
  for (let i = 0; i < nV; i++) { const v = viewValue(viewType, meta, i, ctx); vals[i] = v; if (v < lo) lo = v; if (v > hi) hi = v }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
  for (let i = 0; i < nV; i++) { const c = rangeColorAt(vals[i], lo, hi, DEFAULT_RANGES_COLORS); color[i * 4] = packColor(c) }
  return { color, min: lo, max: hi, viewType, label: vt.label, unit: vt.unit, cont: true }
}

// ── GLSL ES 3.0 shaders (faithful port of the upstream Segments_Vertex_Shader_ES) ─────
//  Differences (required by the port, algorithm unchanged): #version is supplied by three (GLSL3) / precision block spelled out /
//  the 'f' float literal suffix removed (255.0f -> 255.0, for WebGL2 ANGLE) / vertex_id is a float attribute.
//  texelFetch keeps the upstream ES variant's sampler2D + tex_coord(id->(u,v)) — compensating for the missing samplerBuffer (upstream semantics preserved).
const SEG_VS = `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
#define POINTY_CAPS
#define FIX_TWISTING
const vec3  light_top_dir = vec3(-0.4574957, 0.4574957, 0.7624929);
const float light_top_diffuse = 0.6 * 0.8;
const float light_top_specular = 0.6 * 0.125;
const float light_top_shininess = 20.0;
const vec3  light_front_dir = vec3(0.6985074, 0.1397015, 0.6985074);
const float light_front_diffuse = 0.6 * 0.3;
const float ambient = 0.3;
const float emission = 0.15;
const vec3 UP = vec3(0, 0, 1);
uniform mat4 view_matrix;
uniform mat4 projection_matrix;
uniform vec3 camera_position;
uniform sampler2D position_tex;
uniform sampler2D height_width_angle_tex;
uniform int layer_lo;   // stage 25: dual slider lower bound (layer). The shader clips out-of-range segments in O(1).
uniform int layer_hi;   //          the upper bound is cut via instanceCount (sorted by layer).
in float vertex_id_float;
in uint seg_id_a_u;     // instance attribute (formerly segment_index_tex.r) — attribute fetch is cheaper than texelFetch
in uint seg_layer_u;    // instance attribute (formerly segment_index_tex.g)
out vec3 color;
vec3 decode_color(float col) {
  int c = int(round(col));
  int r = (c >> 16) & 0xFF;
  int g = (c >> 8) & 0xFF;
  int b = (c >> 0) & 0xFF;
  float f = 1.0 / 255.0;
  return f * vec3(r, g, b);
}
float lighting(vec3 eye_position, vec3 eye_normal) {
  float top_diffuse = light_top_diffuse * max(dot(eye_normal, light_top_dir), 0.0);
  float front_diffuse = light_front_diffuse * max(dot(eye_normal, light_front_dir), 0.0);
  float top_specular = light_top_specular * pow(max(dot(-normalize(eye_position), reflect(-light_top_dir, eye_normal)), 0.0), light_top_shininess);
  return ambient + top_diffuse + front_diffuse + top_specular + emission;
}
ivec2 tex_coord(sampler2D sampler, int id) {
  ivec2 tex_size = textureSize(sampler, 0);
  return (tex_size.y == 1) ? ivec2(id, 0) : ivec2(id % tex_size.x, id / tex_size.x);
}
void main() {
  int vertex_id = int(vertex_id_float);
  int seg_layer = int(seg_layer_u);
  if (seg_layer < layer_lo || seg_layer > layer_hi) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // out of range -> clip
  int id_a = int(seg_id_a_u);
  int id_b = id_a + 1;
  vec3 pos_a = texelFetch(position_tex, tex_coord(position_tex, id_a), 0).xyz;
  vec3 pos_b = texelFetch(position_tex, tex_coord(position_tex, id_b), 0).xyz;
  vec3 line = pos_b - pos_a;
  float line_len = length(line);
  vec3 line_dir;
  if (line_len < 1e-4)
    line_dir = vec3(1.0, 0.0, 0.0);
  else
    line_dir = line / line_len;
  vec3 line_right_dir;
  if (abs(dot(line_dir, UP)) > 0.9) {
    line_right_dir = normalize(cross(vec3(1, 0, 0), line_dir));
  }
  else
    line_right_dir = normalize(cross(line_dir, UP));
  vec3 line_up_dir = normalize(cross(line_right_dir, line_dir));
  const vec2 horizontal_vertical_view_signs_array[16] = vec2[](
    vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 0.0), vec2(0.0, -1.0),
    vec2(0.0, -1.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 0.0),
    vec2(0.0, 1.0), vec2(-1.0, 0.0), vec2(0.0, 0.0), vec2(1.0, 0.0),
    vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(-1.0, 0.0), vec2(0.0, 0.0)
    );
  int id = vertex_id < 4 ? id_a : id_b;
  vec3 endpoint_pos = vertex_id < 4 ? pos_a : pos_b;
  vec4 hwa_color = texelFetch(height_width_angle_tex, tex_coord(height_width_angle_tex, id), 0);   // .xyz=h/w/angle, .w=packed color
  vec3 height_width_angle = hwa_color.xyz;
#ifdef FIX_TWISTING
  int closer_id = (dot(camera_position - pos_a, camera_position - pos_a) < dot(camera_position - pos_b, camera_position - pos_b)) ? id_a : id_b;
  vec3 closer_pos = (closer_id == id_a) ? pos_a : pos_b;
  vec3 camera_view_dir = normalize(closer_pos - camera_position);
  vec3 closer_height_width_angle = texelFetch(height_width_angle_tex, tex_coord(height_width_angle_tex, closer_id), 0).xyz;
  vec3 diagonal_dir_border = normalize(closer_height_width_angle.x * line_up_dir + closer_height_width_angle.y * line_right_dir);
#else
  vec3 camera_view_dir = normalize(endpoint_pos - camera_position);
  vec3 diagonal_dir_border = normalize(height_width_angle.x * line_up_dir + height_width_angle.y * line_right_dir);
#endif
  bool is_vertical_view = abs(dot(camera_view_dir, line_up_dir)) / abs(dot(diagonal_dir_border, line_up_dir)) >
    abs(dot(camera_view_dir, line_right_dir)) / abs(dot(diagonal_dir_border, line_right_dir));
  vec2 signs = horizontal_vertical_view_signs_array[vertex_id + 8 * int(is_vertical_view)];
#ifndef POINTY_CAPS
  if (vertex_id == 2 || vertex_id == 7) signs = -horizontal_vertical_view_signs_array[(vertex_id - 2) + 8 * int(is_vertical_view)];
#endif
  float view_right_sign = sign(dot(-camera_view_dir, line_right_dir));
  float view_top_sign = sign(dot(-camera_view_dir, line_up_dir));
  float half_height = 0.5 * height_width_angle.x;
  float half_width = 0.5 * height_width_angle.y;
  vec3 horizontal_dir = half_width * line_right_dir;
  vec3 vertical_dir = half_height * line_up_dir;
  float horizontal_sign = signs.x * view_right_sign;
  float vertical_sign = signs.y * view_top_sign;
  vec3 pos = endpoint_pos + horizontal_sign * horizontal_dir + vertical_sign * vertical_dir;
  if (vertex_id == 2 || vertex_id == 7) {
    float line_dir_sign = (vertex_id == 2) ? -1.0 : 1.0;
    if (height_width_angle.z == 0.0) {
#ifdef POINTY_CAPS
      pos += line_dir_sign * line_dir * half_width;
#endif
    }
    else {
      pos += line_dir_sign * line_dir * half_width * sin(abs(height_width_angle.z) * 0.5);
      pos += sign(height_width_angle.z) * horizontal_dir * cos(abs(height_width_angle.z) * 0.5);
    }
  }
  vec3 eye_position = (view_matrix * vec4(pos, 1.0)).xyz;
  vec3 eye_normal = (view_matrix * vec4(normalize(pos - endpoint_pos), 0.0)).xyz;
  vec3 color_base = decode_color(hwa_color.w);
  color = color_base * lighting(eye_position, eye_normal);
  gl_Position = projection_matrix * vec4(eye_position, 1.0);
}
`

const SEG_FS = `
precision highp float;
in vec3 color;
out vec4 fragment_color;
void main() {
  fragment_color = vec4(color, 1.0);
}
`

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
