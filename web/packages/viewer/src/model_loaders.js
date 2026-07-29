// 26단계: 통일 모델 임포트 파이프라인 — STL/OBJ/3MF/AMF/PLY.
//  three/examples/jsm 로더 재사용(신규 npm 의존성 없음). 각 로더 결과(BufferGeometry|Group) →
//  월드행렬 베이크 → 비인덱스 삼각형 → **model z-up** flat 배열(N*9). 슬라이스 경로(addObject→buildMergedSTL→커널) 재사용.
//  좌표계(실측): 3D 프린팅 포맷은 모두 z-up mm. three 로더는 축 변환을 하지 않고 파일 원좌표를 그대로 로드하므로,
//   STL/3MF/AMF/PLY 는 z-up 그대로 model 좌표로 사용. OBJ 는 관례상 y-up(그래픽) 가능성이 있으나 프린팅 OBJ 는 z-up 이
//   일반적 → z-up 기본(부적절 시 기즈모 회전). 이 판단은 프린팅 워크플로 기준(근거 주석).
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js'

export const SUPPORTED_EXT = ['stl', 'obj', '3mf', 'amf', 'ply']

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
      const g = new ThreeMFLoader().parse(buffer)                          // Group (fflate 로 unzip, three 내부)
      const objs = meshesToObjects(name, collectMeshes(g), true)           // 복수 오브젝트 개별 등록
      if (!objs.length) throw new Error('3MF 메시 없음')
      return objs
    }
    case 'amf': {
      const g = new AMFLoader().parse(buffer)                              // Group (DOMParser 사용 — 브라우저)
      const objs = meshesToObjects(name, collectMeshes(g), true)
      if (!objs.length) throw new Error('AMF 메시 없음')
      return objs
    }
    default:
      throw new Error(`지원하지 않는 포맷: .${ext} (STEP 은 범위 외 — OCCT 필요)`)
  }
}
