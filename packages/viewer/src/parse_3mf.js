// 3MF parser — replaces three's ThreeMFLoader.
// Why: ThreeMFLoader does not understand the **production extension** (`p:path` referencing external .model parts).
//  Nearly every 3mf written by OrcaSlicer/BambuStudio/PrusaSlicer uses it (3D/3dmodel.model holds only component
//  shells, the real meshes live in 3D/Objects/*.model), so the loader returned an empty Group and "no 3MF mesh" errors.
// We only need triangles (materials/textures/colors are irrelevant), so we go straight from zip -> .model XML -> triangle stream.
// The XML is read with regexes: vertex/triangle/component/item in 3mf are all attribute-only self-closing tags and
//  objects do not nest, so no scanner is needed. With no DOMParser dependency it is testable under node as-is.
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

// A 3mf transform is 4x3 row-major (row-vector convention, translation in the last row). combine(a,b) = a first, then b.
function mul(a, b) {
  const o = new Array(12)
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c] + (r === 3 ? b[9 + c] : 0)
    }
  }
  return o
}

function parseTransform(s) {
  if (!s) return IDENT
  const t = s.trim().split(/\s+/).map(Number)
  return t.length === 12 && t.every(Number.isFinite) ? t : IDENT
}

const A_RE = {}
function attr(tag, name) {
  const re = A_RE[name] || (A_RE[name] = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))
  const m = re.exec(tag)
  return m ? m[1] : null
}

const VERT_FAST = /<vertex\s+x="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/g
const TRI_FAST = /<triangle\s+v1="([^"]*)"\s+v2="([^"]*)"\s+v3="([^"]*)"/g

function parseMesh(body) {
  const verts = []
  VERT_FAST.lastIndex = 0
  let m
  while ((m = VERT_FAST.exec(body))) verts.push(+m[1], +m[2], +m[3])
  if (!verts.length) {
    // Tolerates writers with a different attribute order (x/y/z order irrelevant)
    for (const t of body.match(/<vertex\b[^>]*>/g) || []) verts.push(+attr(t, 'x'), +attr(t, 'y'), +attr(t, 'z'))
  }
  if (verts.length < 9) return null

  const tris = []
  TRI_FAST.lastIndex = 0
  while ((m = TRI_FAST.exec(body))) tris.push(+m[1], +m[2], +m[3])
  if (!tris.length) {
    for (const t of body.match(/<triangle\b[^>]*>/g) || []) tris.push(+attr(t, 'v1'), +attr(t, 'v2'), +attr(t, 'v3'))
  }
  if (!tris.length) return null
  return { verts, tris }
}

// One .model XML -> { objects: Map(id -> {mesh|components}), items: [{objectid, path, transform}] }
function parseModelXml(xml) {
  const objects = new Map()
  const OBJ_RE = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
  let m
  while ((m = OBJ_RE.exec(xml))) {
    const id = attr(m[1], 'id')
    if (!id) continue
    const body = m[2]
    const comps = []
    for (const c of body.match(/<component\b[^>]*>/g) || []) {
      const oid = attr(c, 'objectid')
      if (oid) comps.push({ objectid: oid, path: attr(c, 'p:path') || attr(c, 'path'), transform: parseTransform(attr(c, 'transform')) })
    }
    objects.set(id, comps.length ? { components: comps } : { mesh: parseMesh(body) })
  }

  const items = []
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml)
  if (build) {
    for (const it of build[1].match(/<item\b[^>]*>/g) || []) {
      const oid = attr(it, 'objectid')
      if (oid) items.push({ objectid: oid, path: attr(it, 'p:path') || attr(it, 'path'), transform: parseTransform(attr(it, 'transform')) })
    }
  }
  return { objects, items }
}

function normPath(p) {
  const s = String(p).replace(/^\/+/, '')
  return s.includes('%') ? decodeURIComponent(s) : s
}

/**
 * 3MF (ArrayBuffer|Uint8Array) -> [{name, tris: Float32Array(N*9)}]  (z-up mm, build transform baked in)
 * One build item = one object. When there are no items, every top-level object with a mesh is used.
 */
export function parse3MF(buffer, baseName = 'model') {
  // TypedArray/Buffer may sit on a pooled ArrayBuffer, so offset/length must be preserved.
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer)
  const zip = unzipSync(bytes)
  const files = new Map()
  for (const k of Object.keys(zip)) files.set(normPath(k), zip[k])

  const dec = new TextDecoder()
  const models = new Map()   // path → parsed
  const getModel = (path) => {
    const p = normPath(path)
    if (models.has(p)) return models.get(p)
    const raw = files.get(p)
    const parsed = raw ? parseModelXml(dec.decode(raw)) : null
    models.set(p, parsed)
    return parsed
  }

  // Root part: the 3dmodel relationship in _rels/.rels -> the conventional path when absent
  let rootPath = '3D/3dmodel.model'
  const rels = files.get('_rels/.rels')
  if (rels) {
    for (const r of dec.decode(rels).match(/<Relationship\b[^>]*>/g) || []) {
      if ((attr(r, 'Type') || '').endsWith('/3dmodel')) { rootPath = normPath(attr(r, 'Target')); break }
    }
  }
  const root = getModel(rootPath)
  if (!root) throw new Error(`3MF root model not found: ${rootPath}`)

  const out = []
  // Expand objects recursively -> push triangles into the tris array. depth guards against circular references.
  const emit = (objectid, path, xf, sink, depth) => {
    if (depth > 16) return
    const model = getModel(path)
    const obj = model?.objects.get(objectid)
    if (!obj) return
    if (obj.components) {
      for (const c of obj.components) emit(c.objectid, c.path || path, mul(c.transform, xf), sink, depth + 1)
      return
    }
    if (!obj.mesh) return
    const { verts, tris } = obj.mesh
    for (let i = 0; i < tris.length; i++) {
      const o = tris[i] * 3
      const x = verts[o], y = verts[o + 1], z = verts[o + 2]
      sink.push(
        x * xf[0] + y * xf[3] + z * xf[6] + xf[9],
        x * xf[1] + y * xf[4] + z * xf[7] + xf[10],
        x * xf[2] + y * xf[5] + z * xf[8] + xf[11],
      )
    }
  }

  const items = root.items.length
    ? root.items
    : [...root.objects.keys()].filter(id => root.objects.get(id).mesh).map(id => ({ objectid: id, path: rootPath, transform: IDENT }))

  items.forEach((it, i) => {
    const sink = []
    emit(it.objectid, it.path || rootPath, it.transform, sink, 0)
    if (sink.length >= 9) out.push({ name: items.length > 1 ? `${baseName}#${i + 1}` : baseName, tris: new Float32Array(sink) })
  })
  return out
}
