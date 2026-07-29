import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { deriveKernelParams, settingRaw } from '@three-slicer/engine/settings'
import { buildSegmentData, makeToolpath, computeColors, roleRatios, VIEW_TYPES, DEFAULT_RANGES_COLORS, TYPE_COLOR } from './toolpath_gpu.js'
import { loadModel, SUPPORTED_EXT, fileExt } from './model_loaders.js'
// 27단계: 데스크톱 원본 툴바 아이콘 재사용(resources/images → assets, 동일 프로젝트 라이선스).
import moveIcon from './assets/move.svg'
import rotateIcon from './assets/rotate.svg'
import scaleIcon from './assets/scale.svg'
import paintIcon from './assets/paint.svg'
import openIcon from './assets/open.svg'
import addIcon from './assets/add.svg'
import deleteIcon from './assets/delete.svg'
import arrangeIcon from './assets/arrange.svg'
import orientIcon from './assets/orient.svg'

// 3D 뷰포트 + 브라우저 단독 슬라이싱(WASM, 트랙 C 4단계).
//  - 슬라이스 파라미터는 우측 편집 패널 설정값에서 유도(deriveKernelParams) — 중복 폼 없음.
//  - 멀티 오브젝트(누적 업로드 + TransformControls 변환 병합), 서포트/래프트/베드/패턴/냉각/아크/심.
//  - 툴패스: 24단계 — 원본 libvgcode 방식(GPU 인스턴싱, toolpath_gpu.js). CPU 지오메트리 빌더 폐기.
//    좌표: 커널 z-up → toolpathGroup rotation.x=-90°(셰이더는 로컬 z-up 에서 계산, view_matrix 가 보정).

// 모델 로딩(STL/OBJ/3MF/AMF/PLY)은 model_loaders.js 로 이관(26단계). 여기선 model→three 로컬 변환만.
// model → three-local(R=RotX(-90°)), XZ 중심·minY=0
function bakeLocal(modelPos) {
  const n = modelPos.length, p = new Float32Array(n)
  for (let i = 0; i < n; i += 3) { p[i] = modelPos[i]; p[i + 1] = modelPos[i + 2]; p[i + 2] = -modelPos[i + 1] }
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = 0; i < n; i += 3) { minx = Math.min(minx, p[i]); maxx = Math.max(maxx, p[i]); miny = Math.min(miny, p[i + 1]); maxy = Math.max(maxy, p[i + 1]); minz = Math.min(minz, p[i + 2]); maxz = Math.max(maxz, p[i + 2]) }
  const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2
  for (let i = 0; i < n; i += 3) { p[i] -= cx; p[i + 1] -= miny; p[i + 2] -= cz }
  return { localPos: p, size: { w: maxx - minx, d: maxz - minz, h: maxy - miny } }
}

// 툴패스 색/지오메트리/셰이더는 toolpath_gpu.js(원본 libvgcode 포팅)로 이전 — CPU 리본 빌더 폐기(24단계).
const PLATE_GAP = 40   // 29단계-2: 플레이트 간 간격(mm). PX_i = i*(bedW+GAP).

export default function Viewport({ settings = {}, setSettings = () => {}, processPanel = null }) {
  const mountRef = useRef(null)
  const apiRef = useRef(null)
  const three = useRef({})
  const workerRef = useRef(null)
  const objectsRef = useRef([])        // [{id,name,mesh,localPos}]
  const layersDataRef = useRef(null)
  const toolpathRef = useRef(null)     // 24단계: makeToolpath() 컨트롤러(원본 libvgcode 인스턴싱 렌더러)
  const segDataRef = useRef(null)      // 25단계: buildSegmentData 결과(뷰 타입 색 재계산용)
  const showTravelRef = useRef(false)
  const viewTypeRef = useRef('feature')  // 25단계: 뷰 타입(feature/speed/height/width/fan/temp)
  const layerLoRef = useRef(0)         // 25단계: 이중 슬라이더 하한/상한(0-based 레이어)
  const layerHiRef = useRef(0)
  const canvasModeRef = useRef('prepare')  // S2: 인터랙션 게이팅(preview 에선 기즈모/페인팅 비활성)
  const lineWidthRef = useRef(0.42)    // 마지막 슬라이스의 line_width (기본 폭; 레이어 높이는 buildSegmentData 가 z 증분에서 유도)
  // 20단계: 수동 서포트 페인팅 (enforcer/blocker)
  const paintModeRef = useRef('off')   // 'off' | 'enforcer' | 'blocker'
  const brushRadiusRef = useRef(5)
  const paintXformRef = useRef(null)    // {cx,cy,minz} kernel 변환(오브젝트 STL bbox)
  const paintOverlayRef = useRef(null)  // {enf: Mesh, blk: Mesh}
  const paintDrawingRef = useRef(false)
  // 29단계-2: 다중 플레이트 (S7 최소판). 플레이트 i 는 three-x 오프셋 PX_i = i*(bedW+GAP) 에 배치.
  const plateResultsRef = useRef({})    // {plateIdx: sliceResult} 캐시
  const plateOffsetsRef = useRef({})    // {plateIdx: {offX, offZ}} 툴패스 표시 오프셋(중심화 슬라이스 보정)
  const pendingSliceRef = useRef(null)  // 프로미스 기반 슬라이스(전체 플레이트 순차용) + 30단계 워치독 타이머
  const streamAccumRef = useRef(null)   // 30단계: 스트리밍 레이어 누적 {layers:[{z,paths,widths}], gcode:[chunk]}
  const downgradeRef = useRef(false)    // 30단계: 다운그레이드(간소화) 재시도 중 — buildParams 가 인필 단순화+economy
  const selectedPlateRef = useRef(0)
  const plateCountRef = useRef(1)
  const placeXRef = useRef(0)           // 선택 플레이트 내 오브젝트 배치 커서(플레이트 상대)
  const plateBWRef = useRef(200)        // 플레이트(베드) 폭/깊이 — PX_i·멤버십 계산용
  const plateBDRef = useRef(200)

  const [ok, setOk] = useState(true)
  const [gmode, setGmode] = useState('translate')
  const [status, setStatus] = useState('초기화 중…')
  const [objects, setObjects] = useState([])
  const [triWarn, setTriWarn] = useState('')
  const [slicing, setSlicing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [stats, setStats] = useState(null)
  const [overBed, setOverBed] = useState(false)
  const [layerCount, setLayerCount] = useState(0)
  const [segCount, setSegCount] = useState(0)   // 24단계: 렌더된 세그먼트 수(인스턴스)
  const [plateCount, setPlateCount] = useState(1)       // 29단계-2: 플레이트 수
  const [selectedPlate, setSelectedPlate] = useState(0) // 선택 플레이트(0-based)
  const [sliceMenu, setSliceMenu] = useState(false)     // [슬라이스 ▾] 드롭다운 열림
  // 25단계 S6: 뷰 타입 + 이중 슬라이더 + 그라디언트 범례
  const [viewType, setViewType] = useState('feature')
  const [colorRange, setColorRange] = useState(null)   // {min,max,label,unit,cont}
  const [layerLo, setLayerLo] = useState(0)            // 0-based 하한
  const [layerHi, setLayerHi] = useState(0)            // 0-based 상한
  const [singleLayer, setSingleLayer] = useState(false)
  const [roleLegend, setRoleLegend] = useState([])          // S6.3: 역할별 길이 비율
  const [canvasMode, setCanvasMode] = useState('prepare')   // S2: 'prepare'(모델+기즈모+페인팅) | 'preview'(툴패스)
  const [dragOver, setDragOver] = useState(false)           // 26단계 R4: 드래그앤드롭 하이라이트
  const fileInputRef = useRef(null)
  // 27단계 S4: 필라멘트(익스트루더) 색 — 오브젝트 메시/프라임타워 색에 반영. 기본 T1/T2.
  const [extruderColors, setExtruderColors] = useState(['#6aa0dc', '#e08a2b'])
  const extruderColorsRef = useRef(['#6aa0dc', '#e08a2b'])
  const [gcodeUrl, setGcodeUrl] = useState('')
  const [showTravel, setShowTravel] = useState(false)
  const [wipeTowerReal, setWipeTowerReal] = useState(false)   // 12단계: 실 WipeTower.generate() (MM 전용)
  const [paintMode, setPaintModeState] = useState('off')      // 20단계: 서포트 페인팅 모드
  const [brushRadius, setBrushRadius] = useState(5)
  const [paintCounts, setPaintCounts] = useState({ enf: 0, blk: 0 })
  // 30단계 OOM 사다리 UI: 절약 모드 완주 안내 + 다운그레이드 제안(간소화 재시도)
  const [sliceNotice, setSliceNotice] = useState('')       // 예: "메모리 압박 — 절약 모드로 완주(프리뷰 없음)"
  const [downgradeOffer, setDowngradeOffer] = useState(null) // {scope} — 절약 모드도 실패 → 간소화 재시도 제안

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const probe = document.createElement('canvas')
    if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) {
      setOk(false); setStatus('이 환경에서 WebGL 컨텍스트를 만들 수 없습니다 (헤드리스/GPU 미지원).'); return
    }
    let w = mount.clientWidth || 800, h = mount.clientHeight || 480
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(w, h); renderer.setClearColor(0x161a1e, 1)
    renderer.domElement.setAttribute('data-webgl', renderer.getContext() ? 'ok' : 'fail')
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    // 22-fix(H3): 깊이 범위 대폭 축소(기존 0.1/6000 → 1/3000). far/near 비 60000→3000 로 24비트 깊이 정밀도 ~20배↑
    //  → 서브표면 인필이 표면을 뚫는 z-fighting("대각선 거대 폴리곤") 제거. 실측 깊이해상도: 0.08mm@d974·0.13mm@d1500
    //  (층높이 0.2mm 이내). logarithmicDepthBuffer 는 gl_FragDepth 로 early-Z 무효화 → 489k 오버드로에서 fps 3배 저하라 미채택.
    const camera = new THREE.PerspectiveCamera(50, w / h, 1, 3000)
    camera.position.set(210, 180, 260)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2f36, 1.0))
    const dir = new THREE.DirectionalLight(0xffffff, 1.1); dir.position.set(120, 220, 160); scene.add(dir)

    // 29단계-2: 베드(플레이트) 렌더는 apiRef.setPlates 가 관리(bed useEffect 가 초기화). 초기 단일 그리드 제거.

    // 26단계: 하드코딩 데모 메시(큐브/실린더/토러스) 제거 — 빈 씬 + 드롭 오버레이로 안내.
    const objectsGroup = new THREE.Group(); scene.add(objectsGroup)
    const toolpathGroup = new THREE.Group(); toolpathGroup.rotation.x = -Math.PI / 2; scene.add(toolpathGroup)

    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.target.set(0, 22, 0); orbit.enableDamping = true; orbit.update()
    const transform = new TransformControls(camera, renderer.domElement)
    transform.setMode('translate'); transform.setSize(0.8)
    // 29단계-1: 변환 커밋(드래그 종료)마다 바닥 재안착 — 데스크톱 GLCanvas3D::do_move/rotate/scale 의
    //  "snaps object to buildplate"(ensure_on_bed) 실측. 이동·회전·스케일 모두, 커밋 시에만(회전 중 실시간 불필요).
    //  원본: flying(minZ>0)은 베드로 스냅, sinking(minZ<0)은 SINKING_Z_THRESHOLD 까지 유지. **차이(문서화)**: 우리 커널은
    //  음수 z 슬라이스 불가라 싱킹 미지원 → minZ≠0 이면 방향 무관 0 으로 스냅(위든 아래든). 월드 bbox minY(three 높이)→0.
    const _seatBox = new THREE.Box3()
    const seatMesh = (m) => { if (!m) return; m.updateMatrixWorld(true); _seatBox.setFromObject(m); const minY = _seatBox.min.y; if (Number.isFinite(minY) && Math.abs(minY) > 1e-4) { m.position.y -= minY; m.updateMatrixWorld(true) } }
    transform.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; if (!e.value) seatMesh(transform.object) })
    scene.add(transform)

    three.current = { scene, camera, renderer, orbit, transform, objectsGroup, toolpathGroup, plateBeds: [] }
    if (typeof window !== 'undefined') { window.__vpThree = three.current; window.__vpApi = () => apiRef.current }   // dev/test aid

    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2()
    let hovered = null, selected = null, objIdCounter = 0   // 배치 커서는 placeXRef(플레이트 상대)
    const activeMeshes = () => objectsRef.current.map(o => o.mesh)
    const paint = () => { for (const m of activeMeshes()) m.material.emissive.setHex(m === selected ? 0x00ae42 : m === hovered ? 0x1f5c34 : 0x000000) }
    const statusText = () => objectsRef.current.length
      ? `오브젝트 ${objectsRef.current.length}개 · 선택: ${selected ? selected.userData.name : '—'} | 이동 G/R/S · 좌드래그 회전`
      : `호버: ${hovered ? hovered.userData.name : '—'} · 선택: ${selected ? selected.userData.name : '—'} | 좌드래그 회전 · G/R/S`
    const toPointer = ev => { const r = renderer.domElement.getBoundingClientRect(); pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1; pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1 }
    const pick = () => { raycaster.setFromCamera(pointer, camera); const hits = raycaster.intersectObjects(activeMeshes(), false); return hits.length ? hits[0].object : null }
    // 20단계: 페인팅 — raycast 히트(faceIndex + 월드점)를 kernel 좌표로 변환해 worker 로 paint 명령.
    const pickHit = () => { raycaster.setFromCamera(pointer, camera); const hits = raycaster.intersectObjects(activeMeshes(), false); return hits.length ? hits[0] : null }
    const paintAt = ev => {
      const X = paintXformRef.current; if (!X) return
      toPointer(ev); const hit = pickHit(); if (!hit || hit.faceIndex == null) return
      const toK = v => [v.x - X.cx, -v.z - X.cy, v.y - X.minz]   // viewer(Y-up) -> STL(Z-up) -> kernel
      const hk = toK(hit.point), ck = toK(camera.position)
      workerRef.current?.postMessage({ cmd:'paint', facet:hit.faceIndex, hx:hk[0],hy:hk[1],hz:hk[2],
        cx:ck[0],cy:ck[1],cz:ck[2], radius:brushRadiusRef.current, enforcer: paintModeRef.current === 'enforcer' })
    }
    const onMove = ev => {
      if (canvasModeRef.current === 'preview') return   // S2: Preview 에선 호버/선택 없음
      if (paintModeRef.current !== 'off') { if (paintDrawingRef.current) paintAt(ev); return }
      if (transform.dragging || transform.axis) return; toPointer(ev); const hit = pick(); if (hit !== hovered) { hovered = hit; paint(); setStatus(statusText()) } }
    const onDown = ev => {
      if (canvasModeRef.current === 'preview') return   // S2: Preview 에선 기즈모/페인팅 없음
      if (paintModeRef.current !== 'off') { paintDrawingRef.current = true; orbit.enabled = false; paintAt(ev); return }
      if (transform.dragging || transform.axis) return; toPointer(ev); const hit = pick(); if (hit) { selected = hit; transform.attach(hit) } else { selected = null; transform.detach() } paint(); setStatus(statusText()) }
    const onUp = () => { if (paintDrawingRef.current) { paintDrawingRef.current = false; orbit.enabled = true } }
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    const setMode = m => { transform.setMode(m); setGmode(m) }
    const frameObjects = () => {
      const arr = objectsRef.current
      const box = new THREE.Box3()
      if (arr.length) arr.forEach(o => box.expandByObject(o.mesh)); else box.setFromCenterAndSize(new THREE.Vector3(0, 25, 0), new THREE.Vector3(100, 50, 100))
      const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3())
      const d = Math.max(s.x, s.y, s.z, 20) * 1.9 + 40
      orbit.target.copy(c); camera.position.set(c.x + d * 0.7, c.y + d * 0.55 + s.y * 0.3, c.z + d); camera.updateProjectionMatrix(); orbit.update()
    }

    apiRef.current = {
      setMode,
      detachTransform: () => { selected = null; transform.detach(); paint() },   // 20단계: 페인팅 진입 시 기즈모 해제
      addObject: (name, modelPos) => {
        const { localPos, size } = bakeLocal(modelPos)
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.Float32BufferAttribute(localPos, 3)); geo.computeVertexNormals()
        const col0 = extruderColorsRef.current[0] || '#6aa0dc'   // T1 필라멘트 색 반영
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(col0), roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide }))
        // 26단계 R4 + 29단계-2: 선택 플레이트 위에 나란히 배치(placeXRef=플레이트 상대 커서, PX=플레이트 오프셋).
        if (objectsRef.current.length === 0) placeXRef.current = 0
        const px = selectedPlateRef.current * (plateBWRef.current + PLATE_GAP)
        mesh.position.set(px + placeXRef.current + size.w / 2, 0, 0)
        placeXRef.current += size.w + 8
        mesh.userData = { name }
        objectsGroup.add(mesh)
        const id = ++objIdCounter
        objectsRef.current.push({ id, name, mesh, localPos, extruder: 1, visible: true })   // MM: 기본 익스트루더 1
        objectsGroup.visible = true
        setStatus(statusText()); frameObjects()
        return { id, name }
      },
      removeObject: (id) => {
        const arr = objectsRef.current
        const k = arr.findIndex(o => o.id === id); if (k < 0) return
        const o = arr[k]
        if (selected === o.mesh) { selected = null; transform.detach() }
        if (hovered === o.mesh) hovered = null
        objectsGroup.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose()
        arr.splice(k, 1)
        if (arr.length === 0) placeXRef.current = 0
        paint(); setStatus(statusText())
      },
      // MM: 익스트루더 오름차순으로 삼각형 정렬 병합 → 그룹0(ext1) 뒤 그룹1(ext2), split 반환.
      plateX: (i) => i * (plateBWRef.current + PLATE_GAP),   // 29단계-2: 플레이트 i 의 three-x 오프셋
      plateOfObject: (o) => {                                // 위치 기반 소속 = 가장 가까운 플레이트 중심
        const step = plateBWRef.current + PLATE_GAP
        o.mesh.updateMatrixWorld(true)
        const wx = new THREE.Vector3().setFromMatrixPosition(o.mesh.matrixWorld).x
        return Math.max(0, Math.min(plateCountRef.current - 1, Math.round(wx / step)))
      },
      // plateIdx!=null 이면 그 플레이트 소속 오브젝트만 + 좌표를 플레이트 로컬(three-x -= PX)로 변환(28단계 계약 유지).
      buildMergedSTL: (plateIdx = null) => {
        let arr = objectsRef.current.filter(o => o.visible !== false)
        if (plateIdx != null) { const step = plateBWRef.current + PLATE_GAP; arr = arr.filter(o => { o.mesh.updateMatrixWorld(true); const wx = new THREE.Vector3().setFromMatrixPosition(o.mesh.matrixWorld).x; return Math.max(0, Math.min(plateCountRef.current - 1, Math.round(wx / step))) === plateIdx }) }
        if (!arr.length) return null
        const sorted = [...arr].sort((a, b) => (a.extruder || 1) - (b.extruder || 1))
        const usedExtruders = new Set(sorted.map(o => o.extruder || 1))
        const tmp = new THREE.Vector3(); const out = []
        let triCount = 0, split = 0
        for (const o of sorted) {
          if ((o.extruder || 1) >= 2 && split === 0) split = triCount   // ext2 시작 경계
          o.mesh.updateMatrixWorld(true)
          const M = o.mesh.matrixWorld, lp = o.localPos
          for (let i = 0; i < lp.length; i += 3) { tmp.set(lp[i], lp[i + 1], lp[i + 2]).applyMatrix4(M); out.push(tmp.x, -tmp.z, tmp.y) }  // Rinv → model(월드)
          triCount += lp.length / 9
        }
        // 29단계: 슬라이스 입력을 XY 원점 중심으로(대칭 좌표). 원본 데스크톱도 m_plate_origin 로 중심화 후 슬라이스.
        //  이유: 28단계 P2(재정렬 제거) 이후 일부 비대칭/음수 좌표(예: x[0,20]·y[-10,10])가 커널 스커트/인필 경로에서
        //  memory OOB 를 유발(대칭 좌표는 무사 — golden 도 무사). 중심화로 회피 + 그만큼 툴패스를 오프셋해 화면 모델과 겹침 유지.
        let mnx = 1e18, mny = 1e18, mxx = -1e18, mxy = -1e18
        for (let i = 0; i < out.length; i += 3) { if (out[i] < mnx) mnx = out[i]; if (out[i] > mxx) mxx = out[i]; if (out[i + 1] < mny) mny = out[i + 1]; if (out[i + 1] > mxy) mxy = out[i + 1] }
        const Cmx = (mnx + mxx) / 2, Cmy = (mny + mxy) / 2   // 월드 콘텐츠 XY중심(플레이트 오프셋 PX 포함)
        for (let i = 0; i < out.length; i += 3) { out[i] -= Cmx; out[i + 1] -= Cmy }
        // 툴패스 표시 오프셋(three): 콘텐츠 월드중심 model(Cmx,Cmy) → three(x=Cmx, z=-Cmy). Cmx 가 플레이트 PX 를 이미 포함 → 해당 플레이트 위에 렌더.
        const offX3 = Cmx, offZ3 = -Cmy
        const buf = new ArrayBuffer(84 + triCount * 50), dvw = new DataView(buf)
        dvw.setUint32(80, triCount, true)
        let off = 84, vi = 0
        for (let t = 0; t < triCount; t++) {
          off += 12
          for (let k = 0; k < 3; k++) { dvw.setFloat32(off, out[vi++], true); dvw.setFloat32(off + 4, out[vi++], true); dvw.setFloat32(off + 8, out[vi++], true); off += 12 }
          dvw.setUint16(off, 0, true); off += 2
        }
        return { buf, split, extruders: usedExtruders.size, offX: offX3, offZ: offZ3 }
      },
      setObjectExtruder: (id, e) => { const o = objectsRef.current.find(x => x.id === id); if (o) { o.extruder = e; const c = extruderColorsRef.current[e - 1]; if (c) o.mesh.material.color.set(c) } },
      setObjectVisible: (id, v) => { const o = objectsRef.current.find(x => x.id === id); if (o) { o.visible = v; o.mesh.visible = v } },   // 27단계: 출력 토글(눈알)
      recolorObjects: () => { for (const o of objectsRef.current) { const c = extruderColorsRef.current[(o.extruder || 1) - 1]; if (c) o.mesh.material.color.set(c) } },   // 필라멘트 색 변경 반영
      selectedObjectId: () => selected ? (objectsRef.current.find(o => o.mesh === selected)?.id ?? null) : null,   // 27단계: 뷰포트 툴바 "선택 삭제"
      // 28단계 P1: 바닥 안착 — 로컬 지오메트리는 bakeLocal 이 minZ→0(로드 시 1회). 기즈모 Z이동 후 재안착.
      //  (원본 ensure_on_bed 의 싱킹 허용[allow_negative_z]은 범위 외 — 우리는 -min_z 안착만.)
      placeOnBed: () => { for (const o of objectsRef.current) o.mesh.position.y = 0; if (selected) transform.update?.() },
      onSliced: () => { objectsGroup.visible = false; transform.detach(); selected = null; paint() },
      showObjects: () => { objectsGroup.visible = true },
      // 29단계-2: N 플레이트 렌더 — 각 플레이트 = 그리드+테두리, PX_i 오프셋, 선택 플레이트 테두리 하이라이트.
      setPlates: (n, bw, bd, sel) => {
        const t = three.current
        plateBWRef.current = bw; plateBDRef.current = bd; plateCountRef.current = n; selectedPlateRef.current = sel
        for (const p of (t.plateBeds || [])) { t.scene.remove(p.grid); t.scene.remove(p.border); p.grid.geometry.dispose(); p.grid.material.dispose(); p.border.geometry.dispose(); p.border.material.dispose() }
        t.plateBeds = []
        const sz = Math.max(bw, bd, 20), step = bw + PLATE_GAP
        for (let i = 0; i < n; i++) {
          const px = i * step
          const g = new THREE.GridHelper(sz, Math.max(8, Math.round(sz / 16)), i === sel ? 0x00ae42 : 0x2a3138, 0x2a3138)
          g.position.x = px; t.scene.add(g)
          const sel_ = i === sel
          const b = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(bw, bd)), new THREE.LineBasicMaterial({ color: sel_ ? 0x00ae42 : 0x4a5560, linewidth: sel_ ? 2 : 1 }))
          b.rotation.x = -Math.PI / 2; b.position.x = px; t.scene.add(b)
          t.plateBeds.push({ grid: g, border: b })
        }
      },
      setBed: (bw, bd) => { apiRef.current?.setPlates(plateCountRef.current, bw, bd, selectedPlateRef.current) },   // 하위호환
      setToolpathOffset: (x, z) => { const g = three.current.toolpathGroup; if (g) { g.position.x = x || 0; g.position.z = z || 0 } },   // 29단계: 중심화 슬라이스 → 모델 위치로 오프셋(겹침)
    }

    const onKey = e => {
      const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (e.key === 'g' || e.key === 'G') setMode('translate')
      else if (e.key === 'r' || e.key === 'R') setMode('rotate')
      else if (e.key === 's' || e.key === 'S') setMode('scale')
      else if (e.key === 'Escape') { selected = null; transform.detach(); paint() }
    }
    window.addEventListener('keydown', onKey)
    const ro = new ResizeObserver(() => { w = mount.clientWidth || w; h = mount.clientHeight || h; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h) })
    ro.observe(mount)
    setStatus(statusText())
    let raf = 0
    const loop = () => { raf = requestAnimationFrame(loop); orbit.update(); renderer.render(scene, camera) }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect(); window.removeEventListener('keydown', onKey)
      renderer.domElement.removeEventListener('pointermove', onMove); renderer.domElement.removeEventListener('pointerdown', onDown)
      apiRef.current = null
      transform.detach(); transform.dispose(); orbit.dispose()
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose() })
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => () => { if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null } }, [])

  // 베드 그리드를 설정(printable_area) 유도값으로 갱신
  const kp = deriveKernelParams(settings)
  useEffect(() => { apiRef.current?.setPlates(plateCount, kp.bed_width, kp.bed_depth, selectedPlate) }, [kp.bed_width, kp.bed_depth, plateCount, selectedPlate])

  // S2: Prepare|Preview 모드 — 그룹 가시성 + 인터랙션 게이팅
  useEffect(() => {
    canvasModeRef.current = canvasMode
    const t = three.current; if (!t.toolpathGroup) return
    const preview = canvasMode === 'preview'
    t.toolpathGroup.visible = preview
    if (t.objectsGroup) t.objectsGroup.visible = !preview && objectsRef.current.length > 0
    if (preview) {                                   // Preview: 기즈모/페인팅 강제 해제
      apiRef.current?.detachTransform()
      if (paintModeRef.current !== 'off') setPaintMode('off')
    }
  }, [canvasMode])

  // ---- 툴패스 빌드 (24단계: 원본 libvgcode GPU 인스턴싱) ----
  function clearToolpaths() {
    const { toolpathGroup } = three.current
    if (toolpathRef.current) {
      if (toolpathGroup) { toolpathGroup.remove(toolpathRef.current.mesh); toolpathGroup.remove(toolpathRef.current.travLines) }
      toolpathRef.current.dispose(); toolpathRef.current = null
    }
  }
  // CPU 는 지오메트리를 만들지 않는다 — buildSegmentData 로 텍스처 스트림만 준비 → makeToolpath 로 인스턴싱 메시.
  //  177만+ 세그먼트도 O(1) 지오메트리(24정점 템플릿) + O(n) 텍스처로 단번에 렌더(청크/폴백 불필요).
  // 25단계: 뷰 타입 컬러링용 컨텍스트 — 속도/팬/온도는 커널 toolpath 에 없어 설정값에서 유도(커널 무변경).
  //  타입→피처 속도 매핑(외벽/인필 등 데스크톱 설정 그대로). settingRaw 로 스키마 값 직접 조회.
  function viewCtx() {
    const S = (k, def) => { const v = settingRaw(settings, k); const n = parseFloat(v); return Number.isFinite(n) ? n : def }
    const ow = S('outer_wall_speed', 60)
    return {
      speedByType: {
        1: ow, 2: S('sparse_infill_speed', 40), 3: S('internal_solid_infill_speed', 45),
        4: ow, 5: S('support_speed', 35), 6: S('support_speed', 35), 7: S('gap_infill_speed', 30),
        8: ow, 9: S('bridge_speed', 25), 10: S('ironing_speed', 20), 11: ow,
      },
      firstLayerSpeed: S('initial_layer_speed', 30),
      closeFanLayers: S('close_fan_the_first_x_layers', 1),
      fanNormal: S('fan_max_speed', 100),
      tempNormal: S('nozzle_temperature', 210),
      tempFirst: S('nozzle_temperature_initial_layer', S('nozzle_temperature', 210)),
    }
  }
  // 현재 뷰 타입으로 color 텍스처 재계산 + 범례 갱신 (§7 구조: color 텍스처만 교체).
  function applyViewColors() {
    const seg = segDataRef.current, ctl = toolpathRef.current
    if (!seg || !ctl) return
    const cc = computeColors(seg, viewTypeRef.current, viewCtx())
    ctl.setColors(cc.color)
    setColorRange({ min: cc.min, max: cc.max, label: cc.label, unit: cc.unit, cont: cc.cont })
  }
  function rebuildToolpaths() {
    const { toolpathGroup } = three.current
    if (!toolpathGroup) return
    clearToolpaths()
    const data = layersDataRef.current || []
    if (!data.length) { setSegCount(0); segDataRef.current = null; return }
    const seg = buildSegmentData(data, lineWidthRef.current)
    if (import.meta.env?.DEV && seg.hasNaN) console.error('[toolpath] non-finite vertex data')   // dev 회귀 감지
    segDataRef.current = seg
    const ctl = makeToolpath(THREE, seg)
    toolpathGroup.add(ctl.mesh); toolpathGroup.add(ctl.travLines)
    ctl.setTravelVisible(showTravelRef.current)
    toolpathRef.current = ctl
    ctl.setLayerRange(layerLoRef.current, layerHiRef.current)
    applyViewColors()
    setSegCount(seg.nSeg)
    setRoleLegend(roleRatios(seg.typeLengths))   // S6.3: 역할별 비율
  }
  function applyLayerRange() { toolpathRef.current?.setLayerRange(layerLoRef.current, layerHiRef.current) }

  function getWorker() {
    if (!workerRef.current) {
      const wk = new Worker(new URL('../../packages/engine/src/slicer.worker.js', import.meta.url), { type: 'module' })
      wk.onmessage = (e) => {
        const d = e.data
        const pnd = pendingSliceRef.current
        if (d.type === 'progress') { setProgress(d.total ? d.done / d.total : 0); pnd?.kick?.() }   // 30단계: 워치독 리셋
        else if (d.type === 'layer') {   // 30단계 스트리밍: 레이어 즉시 수신(transfer) → 누적, 워치독 리셋
          pnd?.kick?.()
          const a = streamAccumRef.current
          if (a) { a.layers.push({ z: d.z, paths: d.paths, widths: d.widths }); if (d.gcode) a.gcode.push(d.gcode) }
        }
        else if (d.type === 'done') { if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.resolve(assembleResult(d.result)) } else { handleResult(assembleResult(d.result)); setSlicing(false) } }
        else if (d.type === 'error') { if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.reject(new Error(d.error)) } else { setError('슬라이스 실패: ' + d.error); setSlicing(false) } }
        else if (d.type === 'prepared') { /* selector mesh registered */ }
        else if (d.type === 'painted') { setPaintCounts({ enf: d.enf, blk: d.blk }); wk.postMessage({ cmd: 'overlay' }) }
        else if (d.type === 'overlay') { rebuildPaintOverlay(d.enf, d.blk) }
      }
      // 30단계 OOM 감지: worker error/messageerror → 진행 중 슬라이스를 거부(사다리가 절약 재시도 판정).
      const killPending = (msg) => { const pnd = pendingSliceRef.current; if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); try { wk.terminate() } catch {} workerRef.current = null; pnd.reject(new Error(msg)) } else { setError(msg); setSlicing(false) } }
      wk.onerror = (ev) => killPending('Worker 종료(메모리 초과 추정): ' + (ev.message || 'worker error'))
      wk.onmessageerror = () => killPending('Worker 메시지 오류(구조화 복제 실패)')
      workerRef.current = wk
      if (typeof window !== 'undefined') window.__vpWorker = wk   // dev/test aid: drive selector cmds directly
    }
    return workerRef.current
  }
  // 30단계: 스트리밍 결과 조립 — streamed 면 g-code/layers 는 'layer' 로 이미 받았으므로 누적분으로 구성.
  //  batch/MM 는 result 에 gcode+layers 가 그대로 있음. 절약 모드는 layers 빈 배열(툴패스 없음) + gcode 만.
  function assembleResult(result) {
    if (result && result.stats && result.stats.streamed) {
      const a = streamAccumRef.current || { layers: [], gcode: [] }
      return { stats: result.stats, layers: a.layers, gcode: a.gcode.join('') }
    }
    return result
  }
  function handleResult(result) {
    if (result.error) { setError(String(result.error)); return }
    layersDataRef.current = result.layers
    const n = result.layers.length
    layerLoRef.current = 0; layerHiRef.current = n - 1; setLayerLo(0); setLayerHi(n - 1)   // 이중 슬라이더 전체 범위
    rebuildToolpaths()
    apiRef.current?.onSliced()
    setCanvasMode('preview')   // S2: 슬라이스 완료 시 자동 Preview 전환
    setStats({ layers: result.stats.layers, segments: result.stats.path_segments, filament: result.stats.filament_mm, timeSec: result.stats.time_estimate })
    setOverBed(!!result.stats.over_bed)
    setLayerCount(n)
    setGcodeUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(new Blob([result.gcode], { type: 'text/plain' })) })
  }

  // ---- 26단계: 모델 로드 (STL/OBJ/3MF/AMF/PLY, 누적) — 파일선택+드래그앤드롭 공용 ----
  async function loadFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => SUPPORTED_EXT.includes(fileExt(f.name)))
    const rejected = Array.from(fileList || []).length - files.length
    if (!files.length) { if (rejected) setError('지원 포맷: STL/OBJ/3MF/AMF/PLY'); return }
    setError(''); setTriWarn(''); setProgress(0)
    layersDataRef.current = null; segDataRef.current = null; plateResultsRef.current = {}; plateOffsetsRef.current = {}
    clearToolpaths(); apiRef.current?.setToolpathOffset(0, 0)
    setStats(null); setOverBed(false); setLayerCount(0); setSegCount(0); setColorRange(null); setSliceNotice(''); setDowngradeOffer(null)
    setGcodeUrl(prev => { if (prev) URL.revokeObjectURL(prev); return '' })
    setCanvasMode('prepare')   // S2: 새 모델은 Prepare 로
    apiRef.current?.showObjects()
    let totalTri = 0
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer()
        const objs = await loadModel(f.name, buf)          // [{name, modelPos}] (3MF/AMF 는 복수 가능)
        for (const ob of objs) { apiRef.current?.addObject(ob.name, ob.modelPos); totalTri += ob.modelPos.length / 9 }
      } catch (err) { setError(`로드 실패 ${f.name}: ${(err && err.message) || err}`) }
    }
    setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false })))
    if (totalTri > 100000) setTriWarn(`삼각형 ${Math.round(totalTri).toLocaleString()}개 — 슬라이스가 오래 걸릴 수 있습니다`)
  }
  function onFiles(e) { loadFiles(e.target.files); e.target.value = '' }
  function removeObject(id) { apiRef.current?.removeObject(id); setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false }))) }
  // 26단계 R4: 뷰포트 전체 드롭존
  function onDrop(e) { e.preventDefault(); setDragOver(false); loadFiles(e.dataTransfer?.files) }
  function onDragOver(e) { e.preventDefault(); e.dataTransfer && (e.dataTransfer.dropEffect = 'copy'); if (!dragOver) setDragOver(true) }
  function onDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }

  // ---- 20단계: 수동 서포트 페인팅 (enforcer/blocker) ----
  function rebuildPaintOverlay(enfArr, blkArr) {
    const t = three.current; if (!t.objectsGroup) return
    const X = paintXformRef.current || { cx:0, cy:0, minz:0 }
    const ov = paintOverlayRef.current
    if (ov) { for (const k of ['enf','blk']) if (ov[k]) { t.objectsGroup.remove(ov[k]); ov[k].geometry.dispose(); ov[k].material.dispose() } }
    const mk = (arr, color) => {
      if (!arr || arr.length < 9) return null
      const pos = new Float32Array(arr.length)
      for (let i=0;i<arr.length;i+=3){ const kx=arr[i],ky=arr[i+1],kz=arr[i+2];  // kernel -> STL -> viewer(Y-up)
        pos[i]=kx+X.cx; pos[i+1]=kz+X.minz; pos[i+2]=-(ky+X.cy) }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3)); g.computeVertexNormals()
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent:true, opacity:0.55, side:THREE.DoubleSide, depthTest:false }))
      m.renderOrder = 999; t.objectsGroup.add(m); return m
    }
    paintOverlayRef.current = { enf: mk(enfArr, 0x2b6cff), blk: mk(blkArr, 0xe23b3b) }  // enforcer=파랑, blocker=빨강
  }
  function clearPaintOverlay() {
    const t = three.current, ov = paintOverlayRef.current
    if (ov && t.objectsGroup) for (const k of ['enf','blk']) if (ov[k]) { t.objectsGroup.remove(ov[k]); ov[k].geometry.dispose(); ov[k].material.dispose() }
    paintOverlayRef.current = null
  }
  function setPaintMode(mode) {
    if (mode !== 'off' && objectsRef.current.length === 0) { setError('먼저 STL 을 업로드하세요'); return }
    if (mode !== 'off') {
      const merged = apiRef.current?.buildMergedSTL(selectedPlateRef.current); if (!merged) return
      // 29단계: 병합 STL 이 중심화(Cmx,Cmy 뺌)됨 → 페인트 레이캐스트(월드)를 같은 만큼 빼야 셀렉터와 정합. Cmx=offX, Cmy=-offZ.
      paintXformRef.current = { cx: merged.offX, cy: -merged.offZ, minz: 0 }
      apiRef.current?.detachTransform()
      getWorker().postMessage({ cmd: 'prepare', stl: merged.buf })
    }
    paintModeRef.current = mode; setPaintModeState(mode)
  }
  function clearPaint() { getWorker().postMessage({ cmd: 'clear' }); clearPaintOverlay(); setPaintCounts({ enf:0, blk:0 }) }

  // ---- 슬라이스 (우측 패널 설정값 유도) — 29단계-2 플레이트별 + 30단계 스트리밍/워치독/OOM 사다리 ----
  const WATCHDOG_MS = 60000   // 30단계 행 워치독: 진행(progress/layer) 무소식 60초 → 죽음 판정
  function sliceOne(buf, paramsStr) {
    return new Promise((resolve, reject) => {
      // dev/test 훅(프로덕션 미설정): __vpFail(n)=강제 실패(사다리 검증) · __vpStallNext=워커 무응답(워치독) · __vpWatchdogOnce=짧은 워치독(ms).
      if (typeof window !== 'undefined' && window.__vpFail && window.__vpFail(window.__vpSliceN = (window.__vpSliceN || 0) + 1)) { reject(new Error('forced failure (test hook)')); return }
      const stall = (typeof window !== 'undefined' && window.__vpStallNext) ? (window.__vpStallNext = false, true) : false
      const wdMs = (typeof window !== 'undefined' && window.__vpWatchdogOnce) ? ((v) => (window.__vpWatchdogOnce = 0, v))(window.__vpWatchdogOnce) : WATCHDOG_MS
      streamAccumRef.current = { layers: [], gcode: [] }   // 스트리밍 누적 초기화(레이어별 수신)
      let t = 0
      const stop = () => { if (t) { clearTimeout(t); t = 0 } }
      const kick = () => { stop(); t = setTimeout(() => {
        pendingSliceRef.current = null
        try { workerRef.current?.terminate() } catch {} ; workerRef.current = null   // 멎은 워커 강제 종료
        reject(new Error(`watchdog: ${wdMs}ms 무진행 — 메모리 압박으로 판단`))
      }, wdMs) }
      pendingSliceRef.current = { resolve, reject, kick, stop }
      kick()
      getWorker().postMessage({ stl: buf, params: paramsStr, stall })
    })
  }
  function recreateWorker() { try { workerRef.current?.terminate() } catch {} ; workerRef.current = null; getWorker() }
  // OOM 재시도 사다리: ① 정상(스트리밍) → 실패(오류/abort/워치독) 시 ② 워커 재생성 + 절약 모드(툴패스·시간
  //  추정 생략, g-code 만)로 완주. 둘 다 실패면 throw → 호출부가 다운그레이드(간소화) 제안. 부분 g-code 는 주지 않음.
  async function sliceLadder(buf, params) {
    try { const r = await sliceOne(buf, JSON.stringify(params)); return { r, economy: !!(r.stats && r.stats.economy) } }
    catch (e1) {
      recreateWorker()
      const r = await sliceOne(buf, JSON.stringify({ ...params, economy: true }))   // 실패 시 throw 전파
      return { r, economy: true, recovered: true }
    }
  }
  function buildParams(merged) {
    const params = deriveKernelParams(settings)
    if (merged.extruders >= 2 && merged.split > 0) { params.extruder_count = merged.extruders; params.mm_group_split = merged.split; params.wipe_tower_real = wipeTowerReal }
    if (downgradeRef.current) { params.sparse_infill_pattern = 'rectilinear'; params.infill_density = Math.min(params.infill_density ?? 0.15, 0.08); params.economy = true }  // 다운그레이드 재시도
    if (typeof window !== 'undefined' && window.__vpForceTree) { params.enable_support = true; params.support_style = 'tree'; params.support_threshold_angle = 40 }  // 31단계 테스트 훅: 트리 서포트 강제(프로덕션 미설정)
    return params
  }
  // 캐시된 결과를 Preview 로 표시 — 툴패스는 플레이트 로컬 좌표라 PX 오프셋으로 해당 플레이트 위에 렌더(28단계 겹침).
  function showPlateResult(idx) {
    const r = plateResultsRef.current[idx]
    if (!r || r.error) return
    layersDataRef.current = r.layers
    const n = r.layers.length
    layerLoRef.current = 0; layerHiRef.current = n - 1; setLayerLo(0); setLayerHi(n - 1)
    rebuildToolpaths()
    const off = plateOffsetsRef.current[idx] || { offX: 0, offZ: 0 }
    apiRef.current?.setToolpathOffset(off.offX, off.offZ)
    apiRef.current?.onSliced()
    setCanvasMode('preview')
    setStats({ layers: r.stats.layers, segments: r.stats.path_segments, filament: r.stats.filament_mm, timeSec: r.stats.time_estimate })
    setOverBed(!!r.stats.over_bed); setLayerCount(n)
    setGcodeUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(new Blob([r.gcode], { type: 'text/plain' })) })
  }
  function downloadGcode(gcode, name) { const url = URL.createObjectURL(new Blob([gcode], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(url) }, 4000) }
  const _sleep = (ms) => new Promise(r => setTimeout(r, ms))
  async function onSlice(scope = 'current') {
    setSliceMenu(false); setError(''); setSliceNotice(''); setDowngradeOffer(null)
    const idx0 = selectedPlateRef.current
    lineWidthRef.current = deriveKernelParams(settings).line_width
    if (scope === 'all') {
      setSlicing(true); setProgress(0)
      let sliced = 0, anyEconomy = false; const failed = []
      for (let i = 0; i < plateCountRef.current; i++) {
        const merged = apiRef.current?.buildMergedSTL(i); if (!merged) continue
        plateOffsetsRef.current[i] = { offX: merged.offX, offZ: merged.offZ }
        try {
          const { r, economy } = await sliceLadder(merged.buf, buildParams(merged))   // 정상 실패 시 절약 재시도
          plateResultsRef.current[i] = r; downloadGcode(r.gcode, `plate_${i + 1}.gcode`); await _sleep(350); sliced++
          if (economy) anyEconomy = true
        } catch (e) { failed.push(i + 1) }   // E1: 실패해도 이미 완주한 플레이트 g-code 는 보존/제공됨
      }
      setSlicing(false)
      if (!sliced) { setDowngradeOffer({ scope: 'all' }); setError('모든 플레이트 슬라이스 실패(절약 모드 포함) — 간소화 재시도를 시도하세요'); return }
      if (failed.length) setError(`플레이트 ${failed.join(', ')} 실패 — 완주한 ${sliced}개 G-code 는 저장됨`)
      if (anyEconomy) setSliceNotice('메모리 압박 — 일부 플레이트를 절약 모드로 완주(프리뷰 없음, G-code 정상)')
      showPlateResult(plateResultsRef.current[idx0] ? idx0 : Object.keys(plateResultsRef.current).map(Number)[0])
    } else {
      const merged = apiRef.current?.buildMergedSTL(idx0)
      if (!merged) { setError(`플레이트 ${idx0 + 1} 에 오브젝트가 없습니다`); return }
      plateOffsetsRef.current[idx0] = { offX: merged.offX, offZ: merged.offZ }
      setSlicing(true); setProgress(0)
      try {
        const { r, economy } = await sliceLadder(merged.buf, buildParams(merged))
        plateResultsRef.current[idx0] = r; setSlicing(false); showPlateResult(idx0)
        if (economy) setSliceNotice('메모리 압박 — 절약 모드로 완주(프리뷰 없음, G-code 는 다운로드 가능)')
      } catch (e) { setSlicing(false); setDowngradeOffer({ scope: 'current' }); setError('슬라이스 실패(절약 모드도 실패): ' + e.message) }
    }
  }
  // 다운그레이드 재시도: 인필 패턴 단순화(rectilinear)+밀도↓+절약 모드로 다시(사용자 선택). buildParams 가 반영.
  async function retryDowngrade() {
    const off = downgradeOffer; setDowngradeOffer(null); if (!off) return
    downgradeRef.current = true
    try { await onSlice(off.scope) } finally { downgradeRef.current = false }
  }
  // 플레이트 추가/삭제/선택
  function addPlate() { setPlateCount(n => Math.min(6, n + 1)) }
  function deletePlate() {
    setPlateCount(n => { if (n <= 1) return n; const last = n - 1; delete plateResultsRef.current[last]; if (selectedPlateRef.current >= last) selectPlate(last - 1); return last })
  }
  function selectPlate(i) {
    selectedPlateRef.current = i; setSelectedPlate(i); placeXRef.current = 0
    if (canvasMode === 'preview') showPlateResult(i)   // Preview 에서 플레이트 전환 → 캐시 결과로 스위치
  }
  function setObjExtruder(id, e) { apiRef.current?.setObjectExtruder(id, e); setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false }))) }

  // 25단계 S6: 이중 슬라이더(lo/hi) — 단일 레이어 모드면 두 썸이 함께 이동.
  function setRange(lo, hi) {
    const max = Math.max(0, layerCount - 1)
    lo = Math.max(0, Math.min(max, lo)); hi = Math.max(0, Math.min(max, hi))
    if (lo > hi) { const t = lo; lo = hi; hi = t }
    layerLoRef.current = lo; layerHiRef.current = hi; setLayerLo(lo); setLayerHi(hi); applyLayerRange()
  }
  function onLo(e) { const v = parseInt(e.target.value, 10); if (singleLayer) setRange(v, v); else setRange(v, layerHiRef.current) }
  function onHi(e) { const v = parseInt(e.target.value, 10); if (singleLayer) setRange(v, v); else setRange(layerLoRef.current, v) }
  function toggleSingle() {
    const next = !singleLayer; setSingleLayer(next)
    if (next) setRange(layerHiRef.current, layerHiRef.current)   // 단일 레이어 = 상한 레이어만
  }
  function onViewType(e) { const v = e.target.value; setViewType(v); viewTypeRef.current = v; applyViewColors() }
  function onToggleTravel(e) { const v = e.target.checked; setShowTravel(v); showTravelRef.current = v; toolpathRef.current?.setTravelVisible(v) }
  function onToggleSupport(e) { const v = e.target.checked; setSettings(s => ({ ...s, enable_support: v })) }
  const supportOn = !!settingRaw(settings, 'enable_support')
  // 27단계 S4: 필라멘트 색/개수 + 오브젝트 출력토글 + 페인팅 기즈모 모드
  function refreshObjects() { setObjects(objectsRef.current.map(o => ({ id: o.id, name: o.name, extruder: o.extruder, visible: o.visible !== false }))) }
  function setExtColor(i, hex) { setExtruderColors(cs => { const n = [...cs]; n[i] = hex; extruderColorsRef.current = n; apiRef.current?.recolorObjects(); return n }) }
  function addFilament() { setExtruderColors(cs => { if (cs.length >= 4) return cs; const pal = ['#e0473b', '#3bb0e0', '#7ad14a']; const n = [...cs, pal[cs.length - 1] || '#888888']; extruderColorsRef.current = n; return n }) }
  function removeFilament() {
    setExtruderColors(cs => {
      if (cs.length <= 1) return cs
      const n = cs.slice(0, -1); extruderColorsRef.current = n
      objectsRef.current.forEach(o => { if ((o.extruder || 1) > n.length) apiRef.current?.setObjectExtruder(o.id, n.length) })
      apiRef.current?.recolorObjects(); refreshObjects(); return n
    })
  }
  function toggleObjVisible(id) { const o = objectsRef.current.find(x => x.id === id); apiRef.current?.setObjectVisible(id, !(o?.visible !== false)); refreshObjects() }
  function togglePaintGizmo() { setPaintMode(paintMode === 'off' ? 'enforcer' : 'off') }
  const nozzleDia = kp.nozzle_diameter || settingRaw(settings, 'nozzle_diameter') || '0.4'

  // Preview 컨트롤(뷰 타입 + 이중 슬라이더 + 범례) — 사이드바에 배치
  const previewControls = layerCount > 0 && (
    <div className="slice-layer" data-testid="preview-controls">
      <label className="view-type-row">뷰 타입
        <select value={viewType} onChange={onViewType} data-testid="view-type-select">
          {VIEW_TYPES.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
      </label>
      <label>레이어 <b data-testid="layer-range">{singleLayer ? (layerHi + 1) : `${layerLo + 1}..${layerHi + 1}`}</b> / {layerCount}
        <span className="muted"> ({segCount.toLocaleString()} 세그먼트)</span></label>
      <div className="dual-slider">
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerLo} onChange={onLo} data-testid="layer-lo" title="하한" />
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerHi} onChange={onHi} data-testid="layer-hi" title="상한" />
      </div>
      <div className="layer-ctl">
        <button className={singleLayer ? 'on' : ''} onClick={toggleSingle} data-testid="single-layer-btn">단일 레이어</button>
        <label className="slice-travel"><input type="checkbox" checked={showTravel} onChange={onToggleTravel} data-testid="travel-toggle" /> 트래블</label>
      </div>
      {colorRange && colorRange.cont ? (
        <div className="grad-legend" data-testid="view-legend">
          <div className="grad-title">{colorRange.label} <span className="muted">{colorRange.unit}</span></div>
          <div className="grad-bar" data-testid="gradient-bar" style={{ background: `linear-gradient(to right, ${DEFAULT_RANGES_COLORS.map(c => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`).join(',')})` }} />
          <div className="grad-minmax"><span data-testid="grad-min">{colorRange.min.toFixed(colorRange.unit === 'mm' ? 2 : 0)}</span><span data-testid="grad-max">{colorRange.max.toFixed(colorRange.unit === 'mm' ? 2 : 0)}</span></div>
        </div>
      ) : (
        <div className="role-legend" data-testid="view-legend">
          {roleLegend.map(r => (
            <span key={r.type} className="role-item">
              <i style={{ background: `rgb(${Math.round(r.color[0] * 255)},${Math.round(r.color[1] * 255)},${Math.round(r.color[2] * 255)})` }} />
              {r.label} <b>{r.pct.toFixed(0)}%</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
  const statsBlock = stats && (
    <>
      <div><b>{stats.layers}</b> 레이어 · <b>{stats.segments}</b> 세그먼트</div>
      <div>필라멘트 <b>{stats.filament.toFixed(1)}</b> mm</div>
      {typeof stats.timeSec === 'number' && stats.timeSec > 0 && (() => {
        const s = Math.round(stats.timeSec)
        const t = `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`
        return <div data-testid="print-time">⏱ 예상 출력 <b>{t}</b></div>
      })()}
      {overBed && <div className="slice-warn" data-testid="over-bed">⚠ 모델이 베드를 벗어남</div>}
    </>
  )

  return (
    <div className="app-shell">
      {/* 공용 숨김 파일 입력 */}
      <input ref={fileInputRef} type="file" accept=".stl,.obj,.3mf,.amf,.ply" multiple onChange={onFiles} data-testid="stl-input" style={{ display: 'none' }} />

      {/* S1 상단바 */}
      <header className="topbar">
        <div className="tb-left">
          <span className="tb-logo"><b>Orca</b>Slicer <span className="tb-re">RE</span></span>
          <button className="tb-btn" onClick={() => fileInputRef.current?.click()} title="파일 열기" data-testid="open-file"><img src={openIcon} alt="" /><span>열기</span></button>
        </div>
        {ok && (
          <div className="tb-tabs" role="tablist" aria-label="캔버스 모드">
            <button role="tab" className={canvasMode === 'prepare' ? 'on' : ''} onClick={() => setCanvasMode('prepare')} data-testid="mode-prepare">Prepare</button>
            <button role="tab" className={canvasMode === 'preview' ? 'on' : ''} onClick={() => setCanvasMode('preview')} disabled={layerCount === 0} data-testid="mode-preview">Preview</button>
          </div>
        )}
        <div className="tb-right">
          <button className="tb-icon" disabled title="실행 취소 — 후속 과제(undo/redo)">↶</button>
          <button className="tb-icon" disabled title="다시 실행 — 후속 과제(undo/redo)">↷</button>
        </div>
      </header>

      <div className="app-body">
        {/* S3 좌측 기즈모 툴바 */}
        {ok && canvasMode === 'prepare' && (
          <nav className="left-rail" role="toolbar" aria-label="기즈모 도구">
            <button className={gmode === 'translate' && paintMode === 'off' ? 'on' : ''} onClick={() => { setPaintMode('off'); apiRef.current?.setMode('translate') }} title="이동 (G)" data-testid="gizmo-move"><img src={moveIcon} alt="이동" /></button>
            <button className={gmode === 'rotate' && paintMode === 'off' ? 'on' : ''} onClick={() => { setPaintMode('off'); apiRef.current?.setMode('rotate') }} title="회전 (R)" data-testid="gizmo-rotate"><img src={rotateIcon} alt="회전" /></button>
            <button className={gmode === 'scale' && paintMode === 'off' ? 'on' : ''} onClick={() => { setPaintMode('off'); apiRef.current?.setMode('scale') }} title="스케일 (S)" data-testid="gizmo-scale"><img src={scaleIcon} alt="스케일" /></button>
            <div className="rail-sep" />
            <button className={paintMode !== 'off' ? 'on' : ''} onClick={togglePaintGizmo} title="서포트 페인팅" data-testid="gizmo-paint"><img src={paintIcon} alt="서포트 페인팅" /></button>
          </nav>
        )}

        {/* 중앙 뷰포트 */}
        <div className="viewport-col">
          <div className={(ok ? 'vp-canvas' : 'vp-canvas fail') + (dragOver ? ' drag-over' : '')} ref={mountRef}
            onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave} data-testid="drop-zone">
            {!ok && <div className="vp-fallback">⚠ {status}</div>}
            {ok && objects.length === 0 && canvasMode !== 'preview' && (
              <div className="empty-hint" data-testid="empty-hint">
                <div className="eh-icon">📦</div>
                <div className="eh-title">파일을 드래그하거나 선택하세요</div>
                <div className="eh-sub">STL · OBJ · 3MF · AMF · PLY</div>
                <button className="eh-btn" onClick={() => fileInputRef.current?.click()} data-testid="empty-pick">파일 선택</button>
              </div>
            )}
            {dragOver && <div className="drop-overlay" data-testid="drop-overlay">여기에 놓기 (STL/OBJ/3MF/AMF/PLY)</div>}
          </div>

          {/* 뷰포트 상단 오브젝트 툴바 */}
          {ok && canvasMode === 'prepare' && (
            <div className="vp-top-toolbar" role="toolbar" aria-label="오브젝트 도구">
              <button onClick={() => fileInputRef.current?.click()} title="파일 추가" data-testid="tool-add"><img src={addIcon} alt="추가" /></button>
              <button onClick={() => { const id = apiRef.current?.selectedObjectId(); if (id) removeObject(id) }} title="선택 삭제" data-testid="tool-delete"><img src={deleteIcon} alt="삭제" /></button>
              <button onClick={() => apiRef.current?.placeOnBed()} title="바닥에 놓기 (Z 안착)" data-testid="tool-onbed" className="vtt-text">⬇0</button>
              <span className="vtt-sep" />
              <button disabled title="자동 배치 — 백엔드 이식 예정(libslic3r Arrange)" data-testid="tool-arrange"><img src={arrangeIcon} alt="배치" /></button>
              <button disabled title="자동 정렬 — 백엔드 이식 예정(libslic3r Orient)" data-testid="tool-orient"><img src={orientIcon} alt="정렬" /></button>
            </div>
          )}

          {/* 페인팅 플로팅 패널 */}
          {ok && canvasMode === 'prepare' && paintMode !== 'off' && (
            <div className="brush-panel" data-testid="paint-tools">
              <div className="bp-title">서포트 페인팅</div>
              <div className="bp-modes">
                <button className={paintMode === 'enforcer' ? 'on enf' : 'enf'} onClick={() => setPaintMode('enforcer')} data-testid="paint-enforcer">enforcer</button>
                <button className={paintMode === 'blocker' ? 'on blk' : 'blk'} onClick={() => setPaintMode('blocker')} data-testid="paint-blocker">blocker</button>
                <button onClick={clearPaint} data-testid="paint-clear">지우기</button>
                <button onClick={() => setPaintMode('off')} data-testid="paint-off">닫기</button>
              </div>
              <label className="bp-radius">브러시 반경 {brushRadius}mm
                <input type="range" min="1" max="15" step="0.5" value={brushRadius}
                  onChange={e => { const v = parseFloat(e.target.value); setBrushRadius(v); brushRadiusRef.current = v }} data-testid="brush-radius" />
              </label>
              <div className="muted bp-counts" data-testid="paint-counts">enforcer {paintCounts.enf} · blocker {paintCounts.blk} · 모델 위 드래그로 페인트</div>
            </div>
          )}

          {/* Preview 좌하단 stats 카드 */}
          {ok && canvasMode === 'preview' && stats && (
            <div className="stats-card" data-testid="slice-stats">{statsBlock}</div>
          )}

          {/* 29단계-2: 플레이트 탭바(선택·이름표 + 추가/삭제) */}
          {ok && (
            <div className="plate-bar" data-testid="plate-bar" role="tablist" aria-label="플레이트">
              {Array.from({ length: plateCount }, (_, i) => (
                <button key={i} role="tab" className={'plate-tab' + (i === selectedPlate ? ' on' : '')} onClick={() => selectPlate(i)} data-testid={`plate-${i}`} title={`플레이트 ${i + 1}`}>{i + 1}</button>
              ))}
              <button className="plate-add" onClick={addPlate} disabled={plateCount >= 6} title="플레이트 추가" data-testid="plate-add">+</button>
              {plateCount > 1 && <button className="plate-del" onClick={deletePlate} title="플레이트 삭제" data-testid="plate-del">−</button>}
            </div>
          )}

          {ok && <div className="vp-status" data-testid="vp-status">{status}</div>}
        </div>

        {/* S4 우측 사이드바 */}
        {ok && (
          <aside className="sidebar">
            <div className="sidebar-scroll">
              {/* ① 프린터 */}
              <section className="side-card">
                <div className="sc-head">🖨 프린터</div>
                <div className="sc-info"><span>베드</span><b>{Math.round(kp.bed_width)} × {Math.round(kp.bed_depth)} mm</b></div>
                <div className="sc-info"><span>노즐 Ø</span><b>{nozzleDia} mm</b></div>
              </section>

              {/* ② 필라멘트 */}
              <section className="side-card" data-testid="filament-section">
                <div className="sc-head">🧵 필라멘트 <span className="sc-count">{extruderColors.length}</span>
                  <span className="sc-head-btns">
                    <button onClick={addFilament} disabled={extruderColors.length >= 4} title="추가" data-testid="filament-add">+</button>
                    <button onClick={removeFilament} disabled={extruderColors.length <= 1} title="제거" data-testid="filament-del">−</button>
                  </span>
                </div>
                {extruderColors.map((c, i) => (
                  <div className="filament-row" key={i}>
                    <input type="color" value={c} onChange={e => setExtColor(i, e.target.value)} title={`T${i + 1} 필라멘트 색`} data-testid={`filament-color-${i}`} />
                    <span className="fil-t">T{i + 1}</span>
                    <span className="fil-swatch" style={{ background: c }} />
                    <span className="fil-hex muted">{c}</span>
                  </div>
                ))}
              </section>

              {/* ④ 오브젝트 리스트 */}
              {objects.length > 0 && (
                <section className="side-card" data-testid="object-section">
                  <div className="sc-head">📦 오브젝트 <span className="sc-count">{objects.length}</span></div>
                  <ul className="obj-list2" data-testid="obj-list">
                    {objects.map(o => (
                      <li key={o.id} className={o.visible === false ? 'obj-hidden' : ''}>
                        <button className="obj-eye" onClick={() => toggleObjVisible(o.id)} title="출력 토글" data-testid={`eye-${o.id}`}>{o.visible === false ? '🚫' : '👁'}</button>
                        <span className="obj-name" title={o.name}>{o.name}</span>
                        <select className="obj-ext" value={o.extruder ?? 1} onChange={e => setObjExtruder(o.id, +e.target.value)} title="익스트루더" data-testid={`ext-${o.id}`}>
                          {extruderColors.map((c, i) => <option key={i} value={i + 1}>T{i + 1}</option>)}
                        </select>
                        <button className="obj-del" onClick={() => removeObject(o.id)} title="삭제">✕</button>
                      </li>
                    ))}
                  </ul>
                  <label className="slice-support"><input type="checkbox" checked={supportOn} onChange={onToggleSupport} data-testid="support-toggle" /> 서포트 생성</label>
                  <label className="slice-support"><input type="checkbox" checked={wipeTowerReal} onChange={e => setWipeTowerReal(e.target.checked)} data-testid="wipe-tower-real-toggle" /> 실 와이프타워 <span className="muted">(MM)</span></label>
                </section>
              )}
              {triWarn && <div className="slice-warn side-warn">⚠ {triWarn}</div>}
              {sliceNotice && <div className="slice-warn side-warn" data-testid="slice-notice">ℹ {sliceNotice}</div>}
              {error && <div className="slice-err side-warn" data-testid="slice-err">{error}</div>}
              {downgradeOffer && <button className="slice-btn" data-testid="downgrade-retry" onClick={retryDowngrade}>간소화 재시도(인필 단순화·절약 모드)</button>}

              {/* Preview 컨트롤(뷰타입/슬라이더/범례) */}
              {canvasMode === 'preview' && previewControls && (
                <section className="side-card">
                  <div className="sc-head">🎚 미리보기</div>
                  {previewControls}
                </section>
              )}

              {/* ③ 프로세스(설정 패널) */}
              <section className="side-card process-card" data-testid="process-section">
                <div className="sc-head">⚙ 프로세스</div>
                {processPanel}
              </section>
            </div>

            {/* ⑤ 하단 고정 버튼 바 */}
            <div className="side-bottom">
              <div className="slice-dd">
                <button className="slice-btn" onClick={() => (plateCount > 1 ? setSliceMenu(v => !v) : onSlice('current'))} disabled={objects.length === 0 || slicing} data-testid="slice-btn">
                  {slicing ? `슬라이싱… ${Math.round(progress * 100)}%` : (plateCount > 1 ? '슬라이스 ▾' : '슬라이스')}
                </button>
                {sliceMenu && plateCount > 1 && (
                  <div className="slice-menu" data-testid="slice-menu">
                    <button onClick={() => onSlice('current')} data-testid="slice-current">현재 플레이트 (P{selectedPlate + 1})</button>
                    <button onClick={() => onSlice('all')} data-testid="slice-all">전체 플레이트 ({plateCount})</button>
                  </div>
                )}
              </div>
              {gcodeUrl
                ? <a className="export-btn" href={gcodeUrl} download={`plate_${selectedPlate + 1}.gcode`} data-testid="gcode-dl">G-code 내보내기</a>
                : <button className="export-btn" disabled title="슬라이스 후 활성화">G-code 내보내기</button>}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
