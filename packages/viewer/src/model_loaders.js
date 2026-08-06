// 26단계: 통일 모델 임포트 파이프라인 — STL/OBJ/3MF/AMF/PLY.
//  three/examples/jsm 로더 재사용(신규 npm 의존성 없음). 각 로더 결과(BufferGeometry|Group) →
//  월드행렬 베이크 → 비인덱스 삼각형 → **model z-up** flat 배열(N*9). 슬라이스 경로(addObject→buildMergedSTL→커널) 재사용.
//  좌표계(실측): 3D 프린팅 포맷은 모두 z-up mm. three 로더는 축 변환을 하지 않고 파일 원좌표를 그대로 로드하므로,
//   STL/3MF/AMF/PLY 는 z-up 그대로 model 좌표로 사용. OBJ 는 관례상 y-up(그래픽) 가능성이 있으나 프린팅 OBJ 는 z-up 이
//   일반적 → z-up 기본(부적절 시 기즈모 회전). 이 판단은 프린팅 워크플로 기준(근거 주석).
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js'
import { parse3MF } from './parse_3mf.js'

// 내장 포맷. registerLoader() 로 확장되면 여기에 확장자가 추가된다(파일 대화상자/드래그앤드롭 필터가 이걸 본다).
export const SUPPORTED_EXT = ['stl', 'obj', '3mf', 'amf', 'ply']

// 확장 로더 레지스트리. STEP 처럼 무거운 의존성(OCCT WASM 7.6MB)이 필요한 포맷은 패키지에 넣지 않고
//  쓰는 쪽에서 등록한다 — three-slicer 는 런타임 의존성 0 을 유지한다. (데모 앱 예: web/viewer/src/step_loader.js)
//   registerLoader('step,stp', async (buffer, name) => [{ name, modelPos: Float32Array(N*9, z-up mm) }])
const extra = new Map()
export function registerLoader(exts, fn) {
  for (const e of (Array.isArray(exts) ? exts : String(exts).split(',')).map(s => s.trim().toLowerCase())) {
    extra.set(e, fn)
    if (!SUPPORTED_EXT.includes(e)) SUPPORTED_EXT.push(e)
  }
}

export function fileExt(name) { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase() }

// --- STL 파서 (바이너리 + ASCII) → model 좌표 position (N*9) ---  (기존 Viewport 로직 이관)
function parseSTL(buffer) {
  const dv = new DataView(buffer)
  if (buffer.byteLength >= 84) {
    const n = dv.getUint32(80, true)
    if (buffer.byteLength === 84 + n * 50) {
      const pos = new Float32Array(n * 9)
      let off = 84, p = 0
      for (let i = 0; i < n; i++) {
        off += 12
        for (let v = 0; v < 3; v++) { pos[p++] = dv.getFloat32(off, true); pos[p++] = dv.getFloat32(off + 4, true); pos[p++] = dv.getFloat32(off + 8, true); off += 12 }
        off += 2
      }
      return pos
    }
  }
  const text = new TextDecoder().decode(buffer)
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g
  const nums = []; let m
  while ((m = re.exec(text))) nums.push(+m[1], +m[2], +m[3])
  if (nums.length < 9) return null
  return new Float32Array(nums)
}

// BufferGeometry(+월드행렬) → 비인덱스 삼각형 model z-up flat 배열(N*9). 로더 좌표=z-up 그대로 사용.
function geoToModelTris(geometry, matrix) {
  const pos = geometry?.attributes?.position
  if (!pos || pos.count < 3) return null
  const idx = geometry.index
  const v = new THREE.Vector3()
  const nTri = Math.floor((idx ? idx.count : pos.count) / 3)
  const out = new Float32Array(nTri * 9)
  let o = 0
  const emit = (i) => { v.fromBufferAttribute(pos, i); if (matrix) v.applyMatrix4(matrix); out[o++] = v.x; out[o++] = v.y; out[o++] = v.z }
  if (idx) { for (let i = 0; i < nTri * 3; i++) emit(idx.getX(i)) }
  else { for (let i = 0; i < nTri * 3; i++) emit(i) }
  return out
}

// Group/Object3D 재귀 → [{geometry, matrixWorld}] (월드행렬 베이크용).
function collectMeshes(root) {
  root.updateMatrixWorld(true)
  const meshes = []
  root.traverse(o => { if (o.isMesh && o.geometry) meshes.push({ geometry: o.geometry, matrix: o.matrixWorld }) })
  return meshes
}

// 로더 결과 → 오브젝트 목록. multi=true(3mf/amf) 면 메시별 개별 오브젝트, 아니면 하나로 병합.
function meshesToObjects(baseName, meshes, multi) {
  const parts = meshes.map(m => geoToModelTris(m.geometry, m.matrix)).filter(Boolean)
  if (!parts.length) return []
  if (multi && parts.length > 1) {
    return parts.map((p, i) => ({ name: `${baseName}#${i + 1}`, modelPos: p }))
  }
  if (parts.length === 1) return [{ name: baseName, modelPos: parts[0] }]
  // 병합
  let total = 0; for (const p of parts) total += p.length
  const merged = new Float32Array(total); let o = 0
  for (const p of parts) { merged.set(p, o); o += p.length }
  return [{ name: baseName, modelPos: merged }]
}

// 공개 API: (파일명, ArrayBuffer) → Promise<[{name, modelPos(N*9, model z-up)}]>. 커널 무관 순수.
export async function loadModel(name, buffer) {
  const ext = fileExt(name)
  switch (ext) {
    case 'stl': {
      const pos = parseSTL(buffer)
      if (!pos) throw new Error('STL 파싱 실패')
      return [{ name, modelPos: pos }]
    }
    case 'obj': {
      const g = new OBJLoader().parse(new TextDecoder().decode(buffer))   // Group
      return meshesToObjects(name, collectMeshes(g), false)
    }
    case 'ply': {
      const geo = new PLYLoader().parse(buffer)                            // BufferGeometry
      const tris = geoToModelTris(geo, null)
      if (!tris) throw new Error('PLY 지오메트리 없음')
      return [{ name, modelPos: tris }]
    }
    case '3mf': {
      // 자체 파서 — three 의 ThreeMFLoader 는 production extension(p:path)을 못 읽어 슬라이서 저장 3mf 가 전부 빈다.
      const objs = parse3MF(buffer, name).map(o => ({ name: o.name, modelPos: o.tris }))
      if (!objs.length) throw new Error('3MF 메시 없음')
      return objs
    }
    case 'amf': {
      const g = new AMFLoader().parse(buffer)                              // Group (DOMParser 사용 — 브라우저)
      const objs = meshesToObjects(name, collectMeshes(g), true)
      if (!objs.length) throw new Error('AMF 메시 없음')
      return objs
    }
    default: {
      const fn = extra.get(ext)
      if (!fn) throw new Error(`지원하지 않는 포맷: .${ext}`)
      const objs = await fn(buffer, name)
      if (!objs?.length) throw new Error(`.${ext} 메시 없음`)
      return objs
    }
  }
}

// ---- 33단계: 객체 분리 (원본 Split to objects / TriangleMesh::its_split) ----
// 원본 정의: "면은 **에지를 공유하면** 연결된 것으로 본다(공유 에지 = 정점 인덱스 2개 공유)"
//  (TriangleMesh.cpp:1505). 그 연결 성분(patch)마다 독립 오브젝트가 된다.
// 우리 localPos 는 비인덱스 삼각형 스트림(정점 9개/삼각형)이라, 먼저 좌표를 양자화해 정점을 용접하고
//  에지를 만든 뒤 union-find 로 성분을 모은다. 인접 리스트를 만들지 않아 메모리/시간이 선형에 가깝다.
//
// 반환: 성분이 2개 이상이면 Float32Array[] (각 성분의 localPos, 좌표계는 입력 그대로),
//       1개면 null (분리 불가).
export function splitConnectedComponents(localPos) {
  const nTri = Math.floor(localPos.length / 9)
  if (nTri < 2) return null

  // 정점 용접: 부동소수 오차로 같은 점이 갈라지지 않도록 1e-4mm 격자로 양자화
  const Q = 1e4
  const vmap = new Map()
  const vidx = new Int32Array(nTri * 3)
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3
      const key = `${Math.round(localPos[o] * Q)},${Math.round(localPos[o + 1] * Q)},${Math.round(localPos[o + 2] * Q)}`
      let id = vmap.get(key)
      if (id === undefined) { id = vmap.size; vmap.set(key, id) }
      vidx[t * 3 + k] = id
    }
  }

  // union-find
  const parent = new Int32Array(nTri)
  for (let i = 0; i < nTri; i++) parent[i] = i
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a }

  // 에지(정점쌍) → 처음 본 면. 같은 에지를 다시 만나면 두 면을 합친다.
  //  에지당 면이 3개 이상인 비-매니폴드도 첫 면 기준으로 전부 이어져 문제없다.
  const edge = new Map()
  for (let t = 0; t < nTri; t++) {
    for (let e = 0; e < 3; e++) {
      const a = vidx[t * 3 + e], b = vidx[t * 3 + (e + 1) % 3]
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a   // 정점 인덱스 2개를 하나의 수로
      const prev = edge.get(key)
      if (prev === undefined) edge.set(key, t)
      else union(t, prev)
    }
  }

  // 성분별 면 수집
  const groups = new Map()
  for (let t = 0; t < nTri; t++) {
    const r = find(t)
    let g = groups.get(r)
    if (!g) { g = []; groups.set(r, g) }
    g.push(t)
  }
  if (groups.size < 2) return null

  // 큰 성분부터 (원본도 부피 순으로 정렬해 첫 오브젝트가 본체가 되게 한다)
  const parts = [...groups.values()].sort((a, b) => b.length - a.length)
  return parts.map(faces => {
    const out = new Float32Array(faces.length * 9)
    let w = 0
    for (const t of faces) { const o = t * 9; for (let k = 0; k < 9; k++) out[w++] = localPos[o + k] }
    return out
  })
}
