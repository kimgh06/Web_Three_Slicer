// 3MF 파서 — three 의 ThreeMFLoader 를 대체한다.
// 이유: ThreeMFLoader 는 **production extension**(`p:path` 로 외부 .model 파트를 참조)을 모른다.
//  OrcaSlicer/BambuStudio/PrusaSlicer 가 저장한 3mf 는 거의 전부 이 방식이라(3D/3dmodel.model 은
//  components 껍데기만, 실제 mesh 는 3D/Objects/*.model), 로더가 빈 Group 을 돌려주고 "3MF 메시 없음" 이 났다.
// 우리는 삼각형만 필요하므로(재질·텍스처·색 무관) zip → .model XML → 삼각형 스트림으로 바로 간다.
// XML 은 정규식으로 읽는다: 3mf 의 vertex/triangle/component/item 은 전부 속성만 있는 self-closing 태그이고
//  object 는 중첩되지 않아 스캐너가 필요 없다. DOMParser 의존이 없어 node 에서도 그대로 테스트된다.
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

// 3mf transform = 4x3 행우선(행벡터 규약, 마지막 행이 이동). combine(a,b) = a 먼저, 그다음 b.
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
    // 속성 순서가 다른 writer 대비 (x/y/z 순서 무관)
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

// 하나의 .model XML → { objects: Map(id → {mesh|components}), items: [{objectid, path, transform}] }
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
 * 3MF(ArrayBuffer|Uint8Array) → [{name, tris: Float32Array(N*9)}]  (z-up mm, build 변환 베이크됨)
 * build item 하나 = 오브젝트 하나. item 이 없으면 mesh 를 가진 최상위 object 를 전부 쓴다.
 */
export function parse3MF(buffer, baseName = 'model') {
  // TypedArray/Buffer 는 풀링된 ArrayBuffer 위에 얹혀 있을 수 있어 offset/length 를 반드시 살린다.
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

  // 루트 파트: _rels/.rels 의 3dmodel 관계 → 없으면 관례 경로
  let rootPath = '3D/3dmodel.model'
  const rels = files.get('_rels/.rels')
  if (rels) {
    for (const r of dec.decode(rels).match(/<Relationship\b[^>]*>/g) || []) {
      if ((attr(r, 'Type') || '').endsWith('/3dmodel')) { rootPath = normPath(attr(r, 'Target')); break }
    }
  }
  const root = getModel(rootPath)
  if (!root) throw new Error(`3MF 루트 모델 없음: ${rootPath}`)

  const out = []
  // object 를 재귀 전개 → 삼각형을 tris 배열에 push. depth 로 순환 참조 차단.
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
