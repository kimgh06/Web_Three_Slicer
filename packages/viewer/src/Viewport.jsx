import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { deriveKernelParams, settingRaw } from '@three-slicer/engine/settings'
import { makeSlicerWorker } from './make_worker.js'
import ShadowHost from './shadow_host.jsx'
import shadowCss from '../styles.css?inline'   // Shadow DOM 격리 — 빌드 시 문자열로 내장
import { buildSegmentData, makeToolpath, computeColors, roleRatios, VIEW_TYPES, DEFAULT_RANGES_COLORS, TYPE_COLOR } from './toolpath_gpu.js'
import { loadModel, SUPPORTED_EXT, fileExt, splitConnectedComponents } from './model_loaders.js'
// 27단계: 데스크톱 원본 툴바 아이콘 재사용(resources/images → assets, 동일 프로젝트 라이선스).
import {
  moveIcon, rotateIcon, scaleIcon, paintIcon, openIcon, addIcon, deleteIcon, arrangeIcon, orientIcon,
  onbedIcon, duplicateIcon, splitIcon, deleteallIcon, cutIcon, booleanIcon, negativeIcon,
  seamIcon, mmuIcon, textmarkIcon, measureIcon, varlayerIcon,
} from './icons.js'

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
// 플레이트 간격 — 고정 mm. (원본은 폭 비례 1/5 이지만, 베드 크기와 무관하게 일정한 간격을 쓴다)
const PLATE_GAP = 40
const plateStep = (edge) => edge + PLATE_GAP
// 플레이트 정방형 배치 — 원본 PartPlate.hpp compute_colum_count: cols ≈ ceil(sqrt(n)).
//  i 번째 플레이트 = (col=i%cols)*stepX, (row=i/cols)*stepZ (원본은 -Y 로 증가 → three 에선 +z).
const MAX_PLATES = 9
const plateCols = (count) => { const v = Math.sqrt(count), r = Math.round(v); return v > r ? r + 1 : r }

export default function Viewport({ settings = {}, setSettings = () => {}, processPanel = null }) {
  const mountRef = useRef(null)
  const apiRef = useRef(null)
  const three = useRef({})
  const workerRef = useRef(null)
  const objectsRef = useRef([])        // [{id,name,mesh,localPos}]
  const layersDataRef = useRef(null)   // 포커스(선택) 플레이트의 레이어 데이터 별칭
  const toolpathRef = useRef(null)     // 24단계: makeToolpath() 컨트롤러 — 포커스 플레이트 별칭(슬라이더/트래블 대상)
  const segDataRef = useRef(null)      // 25단계: buildSegmentData 결과 — 포커스 플레이트 별칭(뷰 타입 색 재계산용)
  const plateTpRef = useRef({})        // 플레이트별 툴패스 실체 {idx: {group, ctl, seg}} — 전 플레이트 동시 렌더
  const keyRef = useRef(null)          // 단축키 핸들러(컴포넌트 스코프 — 최신 상태 캡처). 이펙트는 포워딩만.
  const clipboardRef = useRef(null)    // 인앱 복사 버퍼(오브젝트 스냅샷) — OS 클립보드 미사용
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
  // 플레이트 i 의 three 월드 오프셋 (정방형 그리드 배치)
  function platePos(i) {
    const cols = plateCols(plateCountRef.current)
    return { x: (i % cols) * plateStep(plateBWRef.current), z: Math.floor(i / cols) * plateStep(plateBDRef.current) }
  }
  // 월드 (x,z) → 가장 가까운 플레이트 인덱스
  function plateOfXZ(wx, wz) {
    const n = plateCountRef.current, cols = plateCols(n)
    const col = Math.max(0, Math.min(cols - 1, Math.round(wx / plateStep(plateBWRef.current))))
    const row = Math.max(0, Math.round(wz / plateStep(plateBDRef.current)))
    return Math.max(0, Math.min(n - 1, row * cols + col))
  }
  const [selectedPlate, setSelectedPlate] = useState(0) // 선택 플레이트(0-based)
  const [sliceMenu, setSliceMenu] = useState(false)     // [슬라이스 ▾] 드롭다운 열림
  const [showHelp, setShowHelp] = useState(false)       // '?' 단축키 도움말 오버레이
  const [slicedPlateCount, setSlicedPlateCount] = useState(0)   // 결과 보유 플레이트 수(전체 내보내기 노출용)
  const [ctxMenu, setCtxMenu] = useState(null)          // 우클릭 컨텍스트 메뉴 {x, y, onObject}
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
    // 툴패스 루트(회전 없는 컨테이너, 모드 가시성 게이팅 대상). 플레이트별 서브그룹이
    //  rotation.x=-90°(셰이더 로컬 z-up) + position(offX,0,offZ) 을 각자 가져 전 플레이트 동시 렌더.
    const toolpathGroup = new THREE.Group(); scene.add(toolpathGroup)

    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.target.set(0, 22, 0); orbit.enableDamping = false; orbit.update()   // 관성 없음 — 데스크톱 슬라이서 관례(릴리즈 즉시 정지, 글라이드 꼬리 버벅임 원천 제거)
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
      ? `오브젝트 ${objectsRef.current.length}개 · 선택: ${selected ? selected.userData.name : '—'} | M/R/S · 좌드래그 회전 · ? 단축키`
      : `호버: ${hovered ? hovered.userData.name : '—'} · 선택: ${selected ? selected.userData.name : '—'} | 좌드래그 회전 · ? 단축키`
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
    // 커서 힌트: 페인트 모드 crosshair, 오브젝트 호버 pointer, 그 외 기본(카메라 조작).
    const applyCursor = () => {
      const el = renderer.domElement
      el.style.cursor = canvasModeRef.current === 'preview' ? ''
        : paintModeRef.current !== 'off' ? 'crosshair'
        : hovered ? 'pointer' : ''
    }
    const onMove = ev => {
      if (canvasModeRef.current === 'preview') return   // S2: Preview 에선 호버/선택 없음
      if (paintModeRef.current !== 'off') { if (paintDrawingRef.current) paintAt(ev); return }
      if (transform.dragging || transform.axis) return; toPointer(ev); const hit = pick(); if (hit !== hovered) { hovered = hit; paint(); applyCursor(); setStatus(statusText()) } }
    const onDown = ev => {
      if (ev.button !== 0) return                       // 좌클릭만 — 우/휠 클릭은 OrbitControls 팬·줌 전용(선택·페인팅 오발 방지)
      if (canvasModeRef.current === 'preview') return   // S2: Preview 에선 기즈모/페인팅 없음
      if (paintModeRef.current !== 'off') { paintDrawingRef.current = true; orbit.enabled = false; paintAt(ev); return }
      if (transform.dragging || transform.axis) return; toPointer(ev); const hit = pick(); if (hit) { selected = hit; transform.attach(hit) } else { selected = null; transform.detach() } paint(); setStatus(statusText()) }
    // 페인팅 종료는 window 에서 받는다 — 캔버스 밖에서 버튼을 떼도 paintDrawing/orbit.enabled 가 고착되지 않도록.
    const onUp = () => { if (paintDrawingRef.current) { paintDrawingRef.current = false; orbit.enabled = true } }
    // 더블클릭: 오브젝트 = 줌투, 빈 공간 = 선택 해제 (3D 앱 관례)
    const onDblClick = ev => {
      if (ev.button !== 0 || canvasModeRef.current === 'preview' || paintModeRef.current !== 'off') return
      toPointer(ev)
      if (pick()) frameObjects()
      else { selected = null; transform.detach(); paint(); setStatus(statusText()) }
    }
    // 휠: 페인트 모드에선 브러시 반경 조절(원본 GLGizmoPainterBase 관례) — 그 외엔 OrbitControls 줌 그대로.
    const onWheel = ev => {
      if (paintModeRef.current === 'off' || canvasModeRef.current === 'preview') return
      ev.preventDefault(); ev.stopPropagation()
      const v = Math.min(15, Math.max(1, brushRadiusRef.current + (ev.deltaY < 0 ? 0.5 : -0.5)))
      brushRadiusRef.current = v; setBrushRadius(v)
    }
    // 우클릭 컨텍스트 메뉴 — 눌린 지점의 오브젝트를 선택한 뒤 메뉴 좌표를 컴포넌트로 넘긴다.
    //  (OrbitControls 가 contextmenu 를 preventDefault 하므로 기본 메뉴와 충돌 없음.)
    //  주의: 우클릭 팬 드래그와 구분 — pointerdown 위치에서 4px 이상 움직였으면 메뉴를 열지 않는다.
    let rmbDown = null
    const onRmbDown = ev => { if (ev.button === 2) rmbDown = { x: ev.clientX, y: ev.clientY } }
    const onCtxMenu = ev => {
      ev.preventDefault()
      if (canvasModeRef.current === 'preview' || paintModeRef.current !== 'off') return
      if (rmbDown && Math.hypot(ev.clientX - rmbDown.x, ev.clientY - rmbDown.y) > 4) return   // 팬 드래그였음
      toPointer(ev); const hit = pick()
      if (hit) { selected = hit; transform.attach(hit) } else { selected = null; transform.detach() }
      paint(); setStatus(statusText())
      const r = renderer.domElement.getBoundingClientRect()
      setCtxMenu({ x: ev.clientX - r.left, y: ev.clientY - r.top, onObject: !!hit })
    }
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerdown', onRmbDown)
    renderer.domElement.addEventListener('contextmenu', onCtxMenu)
    renderer.domElement.addEventListener('dblclick', onDblClick)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false, capture: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)

    const setMode = m => { transform.setMode(m); setGmode(m) }
    const frameObjects = () => {
      const arr = objectsRef.current
      const box = new THREE.Box3()
      if (arr.length) arr.forEach(o => box.expandByObject(o.mesh)); else box.setFromCenterAndSize(new THREE.Vector3(0, 25, 0), new THREE.Vector3(100, 50, 100))
      const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3())
      const d = Math.max(s.x, s.y, s.z, 20) * 1.9 + 40
      orbit.target.copy(c); camera.position.set(c.x + d * 0.7, c.y + d * 0.55 + s.y * 0.3, c.z + d); camera.updateProjectionMatrix(); orbit.update()
    }

    // 오브젝트 메시 등록 공통 경로 — addObject(신규 로드)와 spawnSnapshot(복제/붙여넣기)이 공유.
    //  26단계 R4 + 29단계-2: 선택 플레이트 위에 나란히 배치(placeXRef=플레이트 상대 커서, PX=플레이트 오프셋).
    //  pos 를 주면 배치 커서 대신 그 위치에 놓는다(분리: 부품이 원래 있던 자리를 유지해야 한다).
    const spawnMesh = (name, localPos, rot = null, scale = null, pos = null) => {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(localPos, 3)); geo.computeVertexNormals()
      geo.computeBoundingBox()
      const col0 = extruderColorsRef.current[0] || '#6aa0dc'   // T1 필라멘트 색 반영
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: new THREE.Color(col0), roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide }))
      if (rot) mesh.rotation.copy(rot)
      if (scale) mesh.scale.copy(scale)
      if (pos) {
        mesh.position.copy(pos)                       // 분리 등: 원래 자리 유지(배치 커서 미사용)
      } else {
        const w = (geo.boundingBox.max.x - geo.boundingBox.min.x) * (scale ? Math.abs(scale.x) : 1)
        if (objectsRef.current.length === 0) placeXRef.current = 0
        const pp = platePos(selectedPlateRef.current)
        mesh.position.set(pp.x + placeXRef.current + w / 2, 0, pp.z)
        placeXRef.current += w + 8
      }
      mesh.userData = { name }
      objectsGroup.add(mesh)
      const id = ++objIdCounter
      objectsRef.current.push({ id, name, mesh, localPos, extruder: 1, visible: true })   // MM: 기본 익스트루더 1
      objectsGroup.visible = true
      setStatus(statusText()); frameObjects()
      return { id, name }
    }

    apiRef.current = {
      setMode,
      refreshCursor: () => applyCursor(),                                        // 페인트 모드 전환 시 커서 힌트 동기화
      detachTransform: () => { selected = null; transform.detach(); paint() },   // 20단계: 페인팅 진입 시 기즈모 해제
      addObject: (name, modelPos) => spawnMesh(name, bakeLocal(modelPos).localPos),
      // ---- 단축키 지원 (복제/넛지/회전/줌투) ----
      getSnapshot: (id) => {           // 복사/복제용 스냅샷 — localPos 는 불변이라 참조 공유
        const o = objectsRef.current.find(x => x.id === id); if (!o) return null
        return { name: o.name, localPos: o.localPos, rot: o.mesh.rotation.clone(), scale: o.mesh.scale.clone(), pos: o.mesh.position.clone() }
      },
      // keepPos=true 면 스냅샷의 원래 위치를 유지(분리). false(기본)면 배치 커서로 옆에 놓는다(복제/붙여넣기).
      spawnSnapshot: (snap, keepPos = false) => snap ? spawnMesh(snap.name, snap.localPos, snap.rot, snap.scale, keepPos ? (snap.pos || null) : null) : null,
      nudgeSelected: (dx, dz) => { if (!selected) return; selected.position.x += dx; selected.position.z += dz },
      rotateSelectedY: (rad) => { if (!selected) return; selected.rotation.y += rad },
      frame: () => frameObjects(),                                   // Z: 전체 오브젝트로 줌
      frameBed: () => {                                              // B: 선택 플레이트로 줌
        const pp = platePos(selectedPlateRef.current)
        const d = Math.max(plateBWRef.current, plateBDRef.current) * 1.1 + 40
        orbit.target.set(pp.x, 0, pp.z); camera.position.set(pp.x + d * 0.55, d * 0.8, pp.z + d); orbit.update()
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
      platePos: (i) => platePos(i),   // 플레이트 i 의 three (x,z) 오프셋
      plateOfObject: (o) => {                                // 위치 기반 소속 = 가장 가까운 플레이트 중심
        o.mesh.updateMatrixWorld(true)
        const wp = new THREE.Vector3().setFromMatrixPosition(o.mesh.matrixWorld)
        return plateOfXZ(wp.x, wp.z)
      },
      // plateIdx!=null 이면 그 플레이트 소속 오브젝트만 + 좌표를 플레이트 로컬(three-x -= PX)로 변환(28단계 계약 유지).
      buildMergedSTL: (plateIdx = null) => {
        let arr = objectsRef.current.filter(o => o.visible !== false)
        if (plateIdx != null) arr = arr.filter(o => { o.mesh.updateMatrixWorld(true); const wp = new THREE.Vector3().setFromMatrixPosition(o.mesh.matrixWorld); return plateOfXZ(wp.x, wp.z) === plateIdx })
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
      selectObject: (id) => {   // 33단계: 목록에서 클릭한 오브젝트를 선택(분리 등 선택 기반 동작용)
        const o = objectsRef.current.find(x => x.id === id); if (!o) return
        selected = o.mesh; transform.attach(o.mesh); paint(); setStatus(statusText())
      },
      // 28단계 P1: 바닥 안착 — 로컬 지오메트리는 bakeLocal 이 minZ→0(로드 시 1회). 기즈모 Z이동 후 재안착.
      //  (원본 ensure_on_bed 의 싱킹 허용[allow_negative_z]은 범위 외 — 우리는 -min_z 안착만.)
      placeOnBed: () => { for (const o of objectsRef.current) o.mesh.position.y = 0; if (selected) transform.update?.() },
      onSliced: () => { objectsGroup.visible = false; transform.detach(); selected = null; paint() },
      showObjects: () => { objectsGroup.visible = true },
      // 29단계-2: N 플레이트 렌더 — 각 플레이트 = 그리드+테두리, PX_i 오프셋, 선택 플레이트 테두리 하이라이트.
      setPlates: (n, bw, bd, sel) => {
        const t = three.current
        plateBWRef.current = bw; plateBDRef.current = bd; plateCountRef.current = n; selectedPlateRef.current = sel
        for (const p of (t.plateBeds || [])) for (const m of [p.gridThin, p.gridBold, p.border]) { t.scene.remove(m); m.geometry.dispose(); m.material.dispose() }
        t.plateBeds = []
        const cols = plateCols(n), sx = plateStep(bw), sz = plateStep(bd)
        // 격자: 원본 Bed_2D 규칙 — 베드 사각형에 정확히 맞는 직사각 격자, 짧은 변 기준 셀
        //  간격(<600mm → 10mm …), 코너 원점에서 전개하며 5칸마다 굵은 선(main grid 50mm).
        const minEdge = Math.min(bw, bd)
        const cell = minEdge >= 6000 ? 100 : minEdge >= 1200 ? 50 : minEdge >= 600 ? 20 : 10
        const thin = [], bold = []
        const x0 = -bw / 2, z0 = -bd / 2
        for (let i = 0, x = x0; x <= bw / 2 + 1e-6; x = x0 + ++i * cell) (i % 5 ? thin : bold).push(x, 0, z0, x, 0, bd / 2)
        for (let j = 0, z = z0; z <= bd / 2 + 1e-6; z = z0 + ++j * cell) (j % 5 ? thin : bold).push(x0, 0, z, bw / 2, 0, z)
        const lineGeo = (a) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); return g }
        for (let i = 0; i < n; i++) {
          const px = (i % cols) * sx, pz = Math.floor(i / cols) * sz
          const gt = new THREE.LineSegments(lineGeo(thin), new THREE.LineBasicMaterial({ color: 0x232a31 }))
          const gb = new THREE.LineSegments(lineGeo(bold), new THREE.LineBasicMaterial({ color: 0x39434d }))
          gt.position.set(px, 0, pz); gb.position.set(px, 0, pz); t.scene.add(gt); t.scene.add(gb)
          const sel_ = i === sel
          const b = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(bw, bd)), new THREE.LineBasicMaterial({ color: sel_ ? 0x00ae42 : 0x4a5560, linewidth: sel_ ? 2 : 1 }))
          b.rotation.x = -Math.PI / 2; b.position.set(px, 0, pz); t.scene.add(b)
          t.plateBeds.push({ gridThin: gt, gridBold: gb, border: b })
        }
      },
      setBed: (bw, bd) => { apiRef.current?.setPlates(plateCountRef.current, bw, bd, selectedPlateRef.current) },   // 하위호환
    }

    // 단축키 본체는 컴포넌트 스코프(keyRef — 매 렌더 최신 상태/함수 캡처). 이펙트는 포워딩만.
    const onKey = e => keyRef.current?.(e)
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
      renderer.domElement.removeEventListener('pointerdown', onRmbDown); renderer.domElement.removeEventListener('contextmenu', onCtxMenu)
      renderer.domElement.removeEventListener('dblclick', onDblClick); renderer.domElement.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp)
      apiRef.current = null
      transform.detach(); transform.dispose(); orbit.dispose()
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose() })
      renderer.dispose()
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => () => { if (workerRef.current) { workerRef.current.terminate(); workerRef.current = null } }, [])

  // 워밍업: 마운트 직후 워커 생성 + 커널 로드(3.4MB 파싱·wasm 컴파일·mt pthread 풀)를 미리 수행.
  //  사용자가 모델을 고르고 배치하는 유휴 시간에 끝나므로 첫 슬라이스 클릭 시 체감 로딩이 사라진다.
  useEffect(() => { try { getWorker().postMessage({ cmd: 'warmup' }) } catch { /* 로드 실패는 첫 슬라이스에서 정식 보고 */ } }, [])

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

  // ---- 툴패스 빌드 (24단계: 원본 libvgcode GPU 인스턴싱 / 플레이트별 동시 렌더) ----
  function disposePlateToolpath(idx) {
    const e = plateTpRef.current[idx]
    if (!e) return
    e.group.remove(e.ctl.mesh); e.group.remove(e.ctl.travLines); e.ctl.dispose()
    three.current.toolpathGroup?.remove(e.group)
    delete plateTpRef.current[idx]
    if (toolpathRef.current === e.ctl) { toolpathRef.current = null; segDataRef.current = null }
  }
  function clearToolpaths() {
    for (const k of Object.keys(plateTpRef.current)) disposePlateToolpath(Number(k))
    toolpathRef.current = null; segDataRef.current = null
  }
  // 플레이트 idx 의 툴패스 실체를 (재)구축 — 서브그룹이 자기 오프셋을 가져 다른 플레이트와 동시 표시.
  function buildPlateToolpath(idx, layers) {
    const { toolpathGroup } = three.current
    if (!toolpathGroup) return null
    disposePlateToolpath(idx)
    if (!layers || !layers.length) return null
    const seg = buildSegmentData(layers, lineWidthRef.current)
    if (import.meta.env?.DEV && seg.hasNaN) console.error('[toolpath] non-finite vertex data')   // dev 회귀 감지
    const ctl = makeToolpath(THREE, seg)
    const off = plateOffsetsRef.current[idx] || { offX: 0, offZ: 0 }
    const group = new THREE.Group()
    group.rotation.x = -Math.PI / 2
    group.position.set(off.offX || 0, 0, off.offZ || 0)
    group.add(ctl.mesh); group.add(ctl.travLines)
    toolpathGroup.add(group)
    ctl.setTravelVisible(showTravelRef.current)
    ctl.setLayerRange(0, Math.max(0, layers.length - 1))            // 비포커스 기본: 전체 범위
    const cc = computeColors(seg, viewTypeRef.current, viewCtx())   // 현재 뷰 타입 색 적용
    ctl.setColors(cc.color)
    const entry = { group, ctl, seg, layers }   // layers = 소스 참조(재슬라이스 감지용)
    plateTpRef.current[idx] = entry
    return entry
  }
  // 캐시된 모든 플레이트 결과의 툴패스 실체를 보장 — slice-all 후 전 플레이트 동시 조회.
  //  소스 레이어 참조가 바뀌었으면(재슬라이스) 스테일 실체를 재구축.
  function ensurePlateToolpaths() {
    for (const [k, r] of Object.entries(plateResultsRef.current)) {
      const idx = Number(k)
      if (!r || r.error || !r.layers || !r.layers.length) continue
      const e = plateTpRef.current[idx]
      if (!e || e.layers !== r.layers) buildPlateToolpath(idx, r.layers)
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
  // 현재 뷰 타입으로 color 텍스처 재계산 — 모든 플레이트에 적용, 범례/범위는 포커스 플레이트 기준.
  function applyViewColors() {
    const ctx = viewCtx()
    for (const e of Object.values(plateTpRef.current)) {
      const cc = computeColors(e.seg, viewTypeRef.current, ctx)
      e.ctl.setColors(cc.color)
      if (e.ctl === toolpathRef.current)
        setColorRange({ min: cc.min, max: cc.max, label: cc.label, unit: cc.unit, cont: cc.cont })
    }
  }
  // 포커스 플레이트(selectedPlateRef) 툴패스 재구축 + 별칭/통계 갱신. 다른 플레이트 실체는 유지.
  function rebuildToolpaths() {
    const idx = selectedPlateRef.current
    const data = layersDataRef.current || []
    if (!data.length) {
      disposePlateToolpath(idx)
      setSegCount(0); toolpathRef.current = null; segDataRef.current = null
      return
    }
    const entry = buildPlateToolpath(idx, data)
    if (!entry) { setSegCount(0); return }
    toolpathRef.current = entry.ctl
    segDataRef.current = entry.seg
    entry.ctl.setLayerRange(layerLoRef.current, layerHiRef.current)
    applyViewColors()
    setSegCount(entry.seg.nSeg)
    setRoleLegend(roleRatios(entry.seg.typeLengths))   // S6.3: 역할별 비율
  }
  function applyLayerRange() { toolpathRef.current?.setLayerRange(layerLoRef.current, layerHiRef.current) }

  // ---- 진행률: 시간 가중 매핑 + 서포트 실진행(SAB 폴링) ----
  //  구간별 실측 시간 비중(774k tri): PASS1 7% · 표면 6% · 서포트 48% · 방출 38% → 예산 15/5/40/40.
  const supSabRef = useRef(null)     // { arr: Uint32Array(SAB, ptr, 1) } — mt 워커가 1회 공유
  const supPollRef = useRef(0)
  const stopSupPoll = () => { if (supPollRef.current) { clearInterval(supPollRef.current); supPollRef.current = 0 } }
  const mapProgress = (done, total) => {
    const N = total > 2 ? (total - 2) / 2 : 0
    if (!N) return total ? done / total : 0
    if (done <= N) return 0.15 * (done / N)          // PASS1: 0→15%
    if (done === N + 1) return 0.20                  // 표면 완료 → 서포트 진입
    if (done === N + 2) return 0.60                  // 서포트 완료
    return 0.60 + 0.40 * ((done - N - 2) / N)        // 방출: 60→100%
  }
  const startSupPoll = (N) => {
    const sab = supSabRef.current; if (!sab || supPollRef.current) return
    // 총 작업량 ≈ 3.5×N (top_contacts N + bottom ~N + trim N + base N 근사, 실측 보정 상수) — 95% 캡 후 완료 틱에서 스냅
    supPollRef.current = setInterval(() => {
      const ticks = sab.arr[0]
      setProgress(0.20 + 0.40 * Math.min(0.95, ticks / (3.5 * N)))
    }, 150)
  }
  function getWorker() {
    if (!workerRef.current) {
      const wk = makeSlicerWorker()   // 정적 워커 패턴은 make_worker.js(비번들 원형 배포)에 격리
      wk.onmessage = (e) => {
        const d = e.data
        const pnd = pendingSliceRef.current
        if (d.type === 'progress') {   // 30단계: 워치독 리셋(+단계 기록) + 가중 매핑 + 서포트 폴링 제어
          const N = d.total > 2 ? (d.total - 2) / 2 : 0
          if (N && d.done === N + 1) startSupPoll(N)
          if (N && d.done >= N + 2) stopSupPoll()
          setProgress(mapProgress(d.done, d.total)); pnd?.note?.(d.done, d.total); pnd?.kick?.()
        }
        else if (d.type === 'supsab') { try { supSabRef.current = { arr: new Uint32Array(d.buf, d.ptr, 1) } } catch {} }
        else if (d.type === 'layer') {   // 30단계 스트리밍: 레이어 즉시 수신(transfer) → 누적, 워치독 리셋
          pnd?.kick?.()
          const a = streamAccumRef.current
          if (a) { a.layers.push({ z: d.z, paths: d.paths, widths: d.widths }); if (d.gcode) a.gcode.push(d.gcode) }
        }
        else if (d.type === 'done') { stopSupPoll(); if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.resolve(assembleResult(d.result)) } else { handleResult(assembleResult(d.result)); setSlicing(false) } }
        else if (d.type === 'error') { stopSupPoll(); if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); pnd.reject(new Error(d.error)) } else { setError('슬라이스 실패: ' + d.error); setSlicing(false) } }
        else if (d.type === 'prepared') { /* selector mesh registered */ }
        else if (d.type === 'painted') { setPaintCounts({ enf: d.enf, blk: d.blk }); wk.postMessage({ cmd: 'overlay' }) }
        else if (d.type === 'overlay') { rebuildPaintOverlay(d.enf, d.blk) }
      }
      // 30단계 OOM 감지: worker error/messageerror → 진행 중 슬라이스를 거부(사다리가 절약 재시도 판정).
      const killPending = (msg) => { stopSupPoll(); supSabRef.current = null; const pnd = pendingSliceRef.current; if (pnd) { pendingSliceRef.current = null; pnd.stop?.(); try { wk.terminate() } catch {} workerRef.current = null; pnd.reject(new Error(msg)) } else { setError(msg); setSlicing(false) } }
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
    clearToolpaths(); refreshSlicedCount()
    setStats(null); setOverBed(false); setLayerCount(0); setSegCount(0); setColorRange(null); setSliceNotice(''); setDowngradeOffer(null)
    setGcodeUrl(prev => { if (prev) URL.revokeObjectURL(prev); return '' })
    setCanvasMode('prepare')   // S2: 새 모델은 Prepare 로
    apiRef.current?.showObjects()
    let totalTri = 0
    for (const f of files) {
      try {
        const __tl0 = performance.now()   // [vp-prof] 로드 계측(임시)
        const buf = await f.arrayBuffer()
        const __tl1 = performance.now()
        const objs = await loadModel(f.name, buf)          // [{name, modelPos}] (3MF/AMF 는 복수 가능)
        const __tl2 = performance.now()
        for (const ob of objs) { apiRef.current?.addObject(ob.name, ob.modelPos); totalTri += ob.modelPos.length / 9 }
        console.info(`[vp-prof] load ${f.name}: read ${(__tl1-__tl0).toFixed(0)}ms, parse ${(__tl2-__tl1).toFixed(0)}ms, scene ${(performance.now()-__tl2).toFixed(0)}ms`)
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
    apiRef.current?.refreshCursor()   // 페인트 진입/해제 시 커서 힌트 갱신
  }
  function clearPaint() { getWorker().postMessage({ cmd: 'clear' }); clearPaintOverlay(); setPaintCounts({ enf:0, blk:0 }) }

  // ---- 슬라이스 (우측 패널 설정값 유도) — 29단계-2 플레이트별 + 30단계 스트리밍/워치독/OOM 사다리 ----
  const WATCHDOG_MS = 60000   // 30단계 행 워치독: 진행(progress/layer) 무소식 60초 → 죽음 판정
  const SILENT_STAGE_MS = 300000   // 표면·서포트 창(진행률 50% 부근): 커널이 구조적으로 무보고 — 대형 모델은 수 분 정상. 오탐 방지용 완화 한도.
  function sliceOne(buf, paramsStr) {
    return new Promise((resolve, reject) => {
      // dev/test 훅(프로덕션 미설정): __vpFail(n)=강제 실패(사다리 검증) · __vpStallNext=워커 무응답(워치독) · __vpWatchdogOnce=짧은 워치독(ms).
      if (typeof window !== 'undefined' && window.__vpFail && window.__vpFail(window.__vpSliceN = (window.__vpSliceN || 0) + 1)) { reject(new Error('forced failure (test hook)')); return }
      const stall = (typeof window !== 'undefined' && window.__vpStallNext) ? (window.__vpStallNext = false, true) : false
      const wdMs = (typeof window !== 'undefined' && window.__vpWatchdogOnce) ? ((v) => (window.__vpWatchdogOnce = 0, v))(window.__vpWatchdogOnce) : WATCHDOG_MS
      streamAccumRef.current = { layers: [], gcode: [] }   // 스트리밍 누적 초기화(레이어별 수신)
      let t = 0
      let lastD = 0, lastT = 0
      const __ts = performance.now(); let __stage = ''   // [vp-prof] 스테이지 도달 시각(임시)
      const note = (done, total) => {
        lastD = done; lastT = total
        const N = total > 2 ? (total - 2) / 2 : 0
        const st = !N ? '' : done < N ? 'PASS1…' : done === N ? 'PASS1-done' : done === N + 1 ? 'surf-done' : done === N + 2 ? 'support-done' : done === total ? 'emit-done' : 'emit…'
        if (st && st !== __stage) { console.info(`[vp-prof] ${st} +${((performance.now() - __ts) / 1000).toFixed(1)}s`); __stage = st }
      }
      // 마지막 진행이 표면·서포트 창(d ∈ [N, N+2), N=(t−2)/2)이면 완화 한도 — 이 구간은 무보고가 정상이라
      //  60초 워치독이 건강한 슬라이스를 죽였다(실측: 774k tri 서포트 19s+, 저사양·부하 시 60s 초과).
      const curWd = () => {
        const N = lastT > 2 ? (lastT - 2) / 2 : 0
        return (N && lastD >= N && lastD < N + 2) ? SILENT_STAGE_MS : wdMs
      }
      const stop = () => { if (t) { clearTimeout(t); t = 0 } }
      const kick = () => { stop(); const ms = curWd(); t = setTimeout(() => {
        pendingSliceRef.current = null
        stopSupPoll(); supSabRef.current = null   // 워커 종료 → SAB 폴링/참조 해제
        try { workerRef.current?.terminate() } catch {} ; workerRef.current = null   // 멎은 워커 강제 종료
        reject(new Error(`watchdog: ${ms}ms 무진행 — 메모리 압박으로 판단`))
      }, ms) }
      pendingSliceRef.current = { resolve, reject, kick, stop, note }
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
  // 캐시된 결과를 Preview 로 표시 — 캐시된 모든 플레이트의 툴패스를 각자 오프셋으로 동시 렌더하고,
  //  idx 는 포커스(슬라이더/stats/G-code 대상)가 된다. 캐시 없는 플레이트 포커스 = 빈 상태(잔류 제거).
  function showPlateResult(idx) {
    ensurePlateToolpaths()                                   // 전 플레이트 동시 조회
    const prev = toolpathRef.current
    if (prev) prev.setLayerRange(0, 1e9)                     // 이전 포커스는 전체 범위로 복귀
    const r = plateResultsRef.current[idx]
    if (!r || r.error || !r.layers || !r.layers.length) {    // 결과 없는 플레이트: 포커스 UI 비움
      layersDataRef.current = null; toolpathRef.current = null; segDataRef.current = null
      setStats(null); setOverBed(false); setLayerCount(0); setSegCount(0); setColorRange(null); setRoleLegend([])
      setGcodeUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return '' })
      return
    }
    layersDataRef.current = r.layers
    const n = r.layers.length
    layerLoRef.current = 0; layerHiRef.current = n - 1; setLayerLo(0); setLayerHi(n - 1)
    const cached = plateTpRef.current[idx]
    const entry = (cached && cached.layers === r.layers) ? cached : buildPlateToolpath(idx, r.layers)
    if (entry) {
      toolpathRef.current = entry.ctl; segDataRef.current = entry.seg
      entry.ctl.setLayerRange(0, n - 1)
      applyViewColors()
      setSegCount(entry.seg.nSeg); setRoleLegend(roleRatios(entry.seg.typeLengths))
    }
    apiRef.current?.onSliced()
    setCanvasMode('preview')
    setStats({ layers: r.stats.layers, segments: r.stats.path_segments, filament: r.stats.filament_mm, timeSec: r.stats.time_estimate })
    setOverBed(!!r.stats.over_bed); setLayerCount(n)
    setGcodeUrl(prevUrl => { if (prevUrl) URL.revokeObjectURL(prevUrl); return URL.createObjectURL(new Blob([r.gcode], { type: 'text/plain' })) })
  }
  function downloadGcode(gcode, name) { const url = URL.createObjectURL(new Blob([gcode], { type: 'text/plain' })); const a = document.createElement('a'); a.href = url; a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(url) }, 4000) }
  const _sleep = (ms) => new Promise(r => setTimeout(r, ms))
  // plateResultsRef 는 ref 라 UI 가 자동 갱신되지 않는다 — 변경 지점마다 개수를 state 로 동기화.
  function refreshSlicedCount() {
    setSlicedPlateCount(Object.values(plateResultsRef.current).filter(r => r && !r.error && r.gcode).length)
  }
  // 슬라이스된 전 플레이트 G-code 를 한 번에 저장 — 사용자가 명시적으로 요청했을 때만(자동 저장 아님).
  //  브라우저가 연속 다운로드를 쓰로틀링하므로 파일 사이에 간격을 둔다.
  async function exportAllGcode() {
    setSliceMenu(false)
    const done = Object.entries(plateResultsRef.current)
      .filter(([, r]) => r && !r.error && r.gcode)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
    if (!done.length) { setError('내보낼 슬라이스 결과가 없습니다 — 먼저 슬라이스하세요'); return }
    for (const [i, r] of done) { downloadGcode(r.gcode, `plate_${Number(i) + 1}.gcode`); await _sleep(350) }
    setSliceNotice(`${done.length}개 플레이트 G-code 를 내보냈습니다`)
  }
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
          plateResultsRef.current[i] = r; refreshSlicedCount(); sliced++   // 자동 다운로드 없음 — 탭 전환으로 조회, 저장은 명시적 내보내기로
          if (economy) anyEconomy = true
        } catch (e) { failed.push(i + 1) }   // E1: 실패해도 이미 완주한 플레이트 g-code 는 보존/제공됨
      }
      setSlicing(false)
      if (!sliced) { setDowngradeOffer({ scope: 'all' }); setError('모든 플레이트 슬라이스 실패(절약 모드 포함) — 간소화 재시도를 시도하세요'); return }
      if (failed.length) setError(`플레이트 ${failed.join(', ')} 실패 — 완주한 ${sliced}개 결과는 유지됨(탭에서 조회·내보내기)`)
      if (anyEconomy) setSliceNotice('메모리 압박 — 일부 플레이트를 절약 모드로 완주(프리뷰 없음, G-code 정상)')
      showPlateResult(plateResultsRef.current[idx0] ? idx0 : Object.keys(plateResultsRef.current).map(Number)[0])
    } else {
      const __tm0 = performance.now()   // [vp-prof] 전처리 계측(임시)
      const merged = apiRef.current?.buildMergedSTL(idx0)
      if (!merged) { setError(`플레이트 ${idx0 + 1} 에 오브젝트가 없습니다`); return }
      console.info(`[vp-prof] buildMergedSTL ${(performance.now() - __tm0).toFixed(0)}ms (${(merged.buf.byteLength / 1048576).toFixed(1)}MB)`)
      plateOffsetsRef.current[idx0] = { offX: merged.offX, offZ: merged.offZ }
      setSlicing(true); setProgress(0)
      try {
        const { r, economy } = await sliceLadder(merged.buf, buildParams(merged))
        plateResultsRef.current[idx0] = r; refreshSlicedCount(); setSlicing(false); showPlateResult(idx0)
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
  function addPlate() { setPlateCount(n => Math.min(MAX_PLATES, n + 1)) }
  function deletePlate() {
    setPlateCount(n => { if (n <= 1) return n; const last = n - 1; delete plateResultsRef.current[last]; disposePlateToolpath(last); refreshSlicedCount(); if (selectedPlateRef.current >= last) selectPlate(last - 1); return last })
  }
  function selectPlate(i) {
    selectedPlateRef.current = i; setSelectedPlate(i); placeXRef.current = 0
    if (canvasMode === 'preview') showPlateResult(i)   // Preview 에서 플레이트 전환 → 캐시 결과로 스위치
  }
  // 프린터 카드의 베드 폭×깊이 편집 — printable_area 사각형으로 환원(원점 보존). 원형/커스텀은 패널 에디터 담당.
  function setBedSize(w, d) {
    if (!(w > 0) || !(d > 0)) return
    const pa = settingRaw(settings, 'printable_area')
    const ok = Array.isArray(pa) && pa.length >= 3
    const x0 = ok ? Math.min(...pa.map(p => p[0])) : 0, y0 = ok ? Math.min(...pa.map(p => p[1])) : 0
    setSettings(s => ({ ...s, printable_area: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]] }))
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
  function onToggleTravel(e) { const v = e.target.checked; setShowTravel(v); showTravelRef.current = v; for (const p of Object.values(plateTpRef.current)) p.ctl.setTravelVisible(v) }
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

  // ---- 오브젝트 툴바 정의 ----
  //  원본 툴바(GLToolbar) 구성을 따른다. run 이 없으면 비활성으로 렌더되며, 툴팁에 무엇이고 왜 안 되는지 적는다.
  //  버튼을 늘릴 때 JSX 를 복제하지 말고 이 배열만 고칠 것.
  const OBJECT_TOOLS = [
    { id: 'add', icon: addIcon, label: '추가', tip: '모델 파일을 현재 플레이트에 추가 (기존 오브젝트 유지)', run: () => fileInputRef.current?.click() },
    { id: 'delete', icon: deleteIcon, label: '삭제', tip: '선택한 오브젝트 삭제 (Del)', run: deleteSelected },
    { id: 'delete-all', icon: deleteallIcon, label: '전체 삭제', tip: '플레이트의 모든 오브젝트 삭제', run: deleteAllObjects, disabled: () => objects.length === 0 },
    { sep: true },
    { id: 'duplicate', icon: duplicateIcon, label: '복제', tip: '선택 오브젝트 복제 (Ctrl+K)', run: duplicateSelected },
    { id: 'split', icon: splitIcon, label: '분리', tip: '객체로 분리 — 서로 떨어진 부분(연결 성분)마다 독립 오브젝트로 나눔. 파트로 분리는 미구현(파트 개념 부재)', run: splitSelected },
    { id: 'onbed', icon: onbedIcon, label: '바닥에 놓기', tip: '모든 오브젝트를 베드 바닥(Z=0)에 붙임 — 기즈모로 띄운 뒤 재안착용', run: () => apiRef.current?.placeOnBed() },
    { sep: true },
    { id: 'arrange', icon: arrangeIcon, label: '배치', tip: '자동 배치 — 오브젝트를 베드에 겹치지 않게 정렬. 미구현(libslic3r Arrange 이식 필요)' },
    { id: 'orient', icon: orientIcon, label: '방향', tip: '자동 방향 — 서포트가 덜 필요한 방향으로 회전. 미구현(libslic3r Orient 이식 필요)' },
    { sep: true },
    { id: 'cut', icon: cutIcon, label: '컷', tip: '컷 — 평면으로 모델을 잘라 두 조각으로 분리. 미구현(절단면 재봉합 필요)' },
    { id: 'boolean', icon: booleanIcon, label: '불리언', tip: '메시 불리언 — 두 오브젝트의 합/차/교집합. 미구현(CGAL 불리언 이식 필요)' },
    { id: 'negative', icon: negativeIcon, label: '음각 파트', tip: '음각·모디파이어 파트 추가 — 한 오브젝트 안에 성질이 다른 파트를 넣음. 미구현(파트 개념 부재)' },
    { sep: true },
    { id: 'seam', icon: seamIcon, label: '심 페인팅', tip: '심 페인팅 — 레이어 이음매 위치를 브러시로 지정. 미구현(커널 심 배선 필요)' },
    { id: 'mmu', icon: mmuIcon, label: '컬러 페인팅', tip: '컬러 페인팅 — 멀티머티리얼 색을 면 단위로 지정. 미구현(MMU 페인트 코덱 배선 필요)' },
    { id: 'text', icon: textmarkIcon, label: '텍스트', tip: '텍스트·SVG 각인 — 모델 표면에 문자/도형을 새김. 미구현(폰트 래스터화 필요)' },
    { id: 'measure', icon: measureIcon, label: '측정', tip: '측정 — 두 지점/면 사이 거리·각도 측정. 미구현' },
    { id: 'varlayer', icon: varlayerIcon, label: '가변 레이어', tip: '가변 레이어 높이 — 구간별로 레이어 높이를 다르게. 미구현(커널 가변 z 미지원)' },
  ]

  // ---- 단축키 (SPECS §4 원본 + PrusaSlicer/Cura 관례) ----
  //  Prepare/Preview 로 유효 키가 갈린다. 입력 위젯 포커스 시 전부 무시.
  // 33단계: 선택이 없을 때 조용히 무시하지 않고 이유를 알린다(툴바 버튼에서 눌러도 아무 일이 없어 보이던 문제).
  function duplicateSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('먼저 복제할 오브젝트를 선택하세요'); return }
    const snap = apiRef.current?.getSnapshot(id)
    if (snap) { apiRef.current?.spawnSnapshot(snap); refreshObjects(); setError('') }
  }
  function copySelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('먼저 복사할 오브젝트를 선택하세요'); return }
    clipboardRef.current = apiRef.current?.getSnapshot(id); setError('')
    setSliceNotice('오브젝트를 복사했습니다 (Ctrl+V 로 붙여넣기)')
  }
  function pasteClipboard() { if (clipboardRef.current) { apiRef.current?.spawnSnapshot(clipboardRef.current); refreshObjects() } }
  function deleteSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('먼저 삭제할 오브젝트를 선택하세요'); return }
    removeObject(id); setError('')
  }
  // 33단계: 전체 삭제 (원본 Ctrl+D / Delete all). 씬의 모든 오브젝트를 비운다.
  function deleteAllObjects() {
    const ids = objectsRef.current.map(o => o.id)
    if (!ids.length) return
    for (const id of ids) apiRef.current?.removeObject(id)
    refreshObjects()
    setSliceNotice(`${ids.length}개 오브젝트를 모두 삭제했습니다`)
  }
  // 33단계: 객체 분리 (원본 Split to objects). 연결 성분마다 독립 오브젝트로 만든다.
  //  각 성분은 원본 좌표를 유지하므로, spawnMesh 의 배치 커서가 제대로 놓도록 bakeLocal 과 같은 규칙
  //  (XZ 중심·minY=0)으로 재정렬한 뒤 등록한다.
  function splitSelected() {
    const id = apiRef.current?.selectedObjectId()
    if (!id) { setError('먼저 분리할 오브젝트를 선택하세요'); return }
    const snap = apiRef.current?.getSnapshot(id); if (!snap) return
    let parts
    try { parts = splitConnectedComponents(snap.localPos) }
    catch (e) { setError('분리 실패: ' + (e?.message || e)); return }
    if (!parts || parts.length < 2) { setError('분리할 독립 부분이 없습니다 — 하나로 연결된 메시입니다'); return }
    // 각 성분의 좌표는 부모의 로컬 좌표계 그대로다. 부모의 위치/회전/스케일을 그대로 물려주면
    //  분리 후에도 화면상 위치가 변하지 않는다(원본 Split 과 동일 — 부품이 제자리에 남는다).
    //  재정렬해서 배치 커서로 늘어놓으면 21개가 일렬이 되어 베드를 벗어난다(실측).
    const base = String(snap.name || 'object').replace(/\.[^.]+$/, '')
    removeObject(id)
    parts.forEach((p, i) => apiRef.current?.spawnSnapshot(
      { name: `${base}_${i + 1}`, localPos: p, rot: snap.rot, scale: snap.scale, pos: snap.pos }, true))
    refreshObjects()
    setError('')
    setSliceNotice(`${parts.length}개 오브젝트로 분리했습니다`)
  }
  function setGizmo(m) { if (paintModeRef.current !== 'off') setPaintMode('off'); apiRef.current?.setMode(m) }   // 페인트 해제 선행(툴바와 동일 경로)

  keyRef.current = (e) => {
    // Shadow DOM: window 레벨에서는 e.target 이 shadow host 로 리타게팅됨 → composedPath 로 실제 타깃 확인
    const t = e.composedPath ? e.composedPath()[0] : e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    const k = e.key, low = typeof k === 'string' ? k.toLowerCase() : ''
    const mod = e.ctrlKey || e.metaKey
    const preview = canvasModeRef.current === 'preview'
    const stop = () => { e.preventDefault(); e.stopPropagation() }

    if (mod) {                                            // ---- Ctrl/⌘ 조합 (모드 공통) ----
      if (low === 'r') { stop(); if (!slicing) onSlice('current') }        // 슬라이스(원본 Ctrl+R)
      else if (low === 'c') { stop(); copySelected() }
      else if (low === 'v') { stop(); pasteClipboard() }
      else if (low === 'x') { stop(); copySelected(); deleteSelected() }
      else if (low === 'k' || low === 'd') { stop(); duplicateSelected() }  // Ctrl+K(원본) / ⌘D(macOS 관례)
      return
    }

    if (preview) {                                        // ---- Preview: 레이어 검사 ----
      const step = e.shiftKey ? 10 : 1
      if (k === 'ArrowUp')        { stop(); const v = layerHiRef.current + step; singleLayer ? setRange(v, v) : setRange(layerLoRef.current, v) }
      else if (k === 'ArrowDown') { stop(); const v = layerHiRef.current - step; singleLayer ? setRange(v, v) : setRange(layerLoRef.current, v) }
      else if (low === 'l')       { stop(); toggleSingle() }
      else if (low === 't')       { stop(); onToggleTravel({ target: { checked: !showTravelRef.current } }) }
      else if (low === 'z')       { stop(); apiRef.current?.frame() }
      else if (low === 'b')       { stop(); apiRef.current?.frameBed() }
      else if (k === 'Escape')    { stop(); setCanvasMode('prepare') }
      return
    }

    // ---- Prepare: 오브젝트 조작 ----
    if (low === 'm' || low === 'g') { stop(); setGizmo('translate') }       // M=원본, G=Blender 관례(유지)
    else if (low === 'r')           { stop(); setGizmo('rotate') }
    else if (low === 's')           { stop(); setGizmo('scale') }
    else if (low === 'z')           { stop(); apiRef.current?.frame() }
    else if (low === 'b')           { stop(); apiRef.current?.frameBed() }
    else if (k === 'Delete' || k === 'Backspace') { stop(); deleteSelected() }
    else if (k === 'Escape')        { stop(); if (paintModeRef.current !== 'off') setPaintMode('off'); apiRef.current?.detachTransform() }
    else if (k === 'PageUp')        { stop(); apiRef.current?.rotateSelectedY(Math.PI / 4) }
    else if (k === 'PageDown')      { stop(); apiRef.current?.rotateSelectedY(-Math.PI / 4) }
    else if (k.startsWith?.('Arrow')) {                                     // 넛지: 10mm, Shift=1mm (Prusa 관례)
      stop(); const d = e.shiftKey ? 1 : 10
      apiRef.current?.nudgeSelected(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0,
                                    k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0)
    }
    else if (k === '?')             { stop(); setShowHelp(v => !v) }
  }
  const nozzleDia = kp.nozzle_diameter || settingRaw(settings, 'nozzle_diameter') || '0.4'

  // Preview 컨트롤(뷰 타입 + 이중 슬라이더 + 범례) — 사이드바에 배치
  const previewControls = layerCount > 0 && (
    <div className="slice-layer" data-testid="preview-controls">
      <label className="view-type-row">뷰 타입
        <select value={viewType} onChange={onViewType} data-testid="view-type-select" title="툴패스 색을 무엇으로 칠할지 — 피처 종류·속도·레이어 높이·폭·팬·온도">
          {VIEW_TYPES.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
      </label>
      <label>레이어 <b data-testid="layer-range">{singleLayer ? (layerHi + 1) : `${layerLo + 1}..${layerHi + 1}`}</b> / {layerCount}
        <span className="muted"> ({segCount.toLocaleString()} 세그먼트)</span></label>
      <div className="dual-slider">
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerLo} onChange={onLo} data-testid="layer-lo" title="표시할 최하단 레이어 (↓/↑ 로도 조절)" />
        <input type="range" min="0" max={Math.max(0, layerCount - 1)} value={layerHi} onChange={onHi} data-testid="layer-hi" title="표시할 최상단 레이어 (↓/↑, Shift 로 10단계)" />
      </div>
      <div className="layer-ctl">
        <button className={singleLayer ? 'on' : ''} onClick={toggleSingle} data-testid="single-layer-btn" title="선택한 한 층만 보기 (L)">단일 레이어</button>
        <label className="slice-travel"><input type="checkbox" checked={showTravel} onChange={onToggleTravel} data-testid="travel-toggle" title="압출 없이 이동하는 경로를 회색 선으로 표시 (T)" /> 트래블</label>
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
    <ShadowHost css={shadowCss}>
    <div className="app-shell">
      {/* 공용 숨김 파일 입력 */}
      <input ref={fileInputRef} type="file" accept=".stl,.obj,.3mf,.amf,.ply" multiple onChange={onFiles} title="STL·OBJ·3MF·AMF·PLY (여러 개 선택 가능)" data-testid="stl-input" style={{ display: 'none' }} />

      {/* S1 상단바 */}
      <header className="topbar">
        <div className="tb-left">
          <span className="tb-logo"><b>Three</b>Slicer <span className="tb-re">RE</span></span>
          <button className="tb-btn" onClick={() => fileInputRef.current?.click()} title="모델 파일 열기 — 기존 오브젝트는 모두 지워짐" data-testid="open-file"><img src={openIcon} alt="" /><span>열기</span></button>
        </div>
        {ok && (
          <div className="tb-tabs" role="tablist" aria-label="캔버스 모드">
            <button role="tab" className={canvasMode === 'prepare' ? 'on' : ''} onClick={() => setCanvasMode('prepare')} data-testid="mode-prepare" title="모델 배치·변형·서포트 페인팅">Prepare</button>
            <button role="tab" className={canvasMode === 'preview' ? 'on' : ''} onClick={() => setCanvasMode('preview')} disabled={layerCount === 0} data-testid="mode-preview" title="슬라이스된 툴패스 미리보기 (슬라이스 후 활성화)">Preview</button>
          </div>
        )}
        <div className="tb-right">
          <button className="tb-icon" disabled title="실행 취소 — 미구현(작업 이력 스택 필요)">↶</button>
          <button className="tb-icon" disabled title="다시 실행 — 미구현(작업 이력 스택 필요)">↷</button>
        </div>
      </header>

      <div className="app-body">
        {/* S3 좌측 기즈모 툴바 */}
        {ok && canvasMode === 'prepare' && (
          <nav className="left-rail" role="toolbar" aria-label="기즈모 도구">
            <button className={gmode === 'translate' && paintMode === 'off' ? 'on' : ''} onClick={() => { setPaintMode('off'); apiRef.current?.setMode('translate') }} title="오브젝트 이동 — 기즈모 축을 끌거나 방향키로 10mm(Shift 1mm) 이동 (M/G)" data-testid="gizmo-move"><img src={moveIcon} alt="이동" /></button>
            <button className={gmode === 'rotate' && paintMode === 'off' ? 'on' : ''} onClick={() => { setPaintMode('off'); apiRef.current?.setMode('rotate') }} title="오브젝트 회전 — PageUp/PageDown 으로 45° 단위 회전 (R)" data-testid="gizmo-rotate"><img src={rotateIcon} alt="회전" /></button>
            <button className={gmode === 'scale' && paintMode === 'off' ? 'on' : ''} onClick={() => { setPaintMode('off'); apiRef.current?.setMode('scale') }} title="오브젝트 크기 조절 (S)" data-testid="gizmo-scale"><img src={scaleIcon} alt="스케일" /></button>
            <div className="rail-sep" />
            <button className={paintMode !== 'off' ? 'on' : ''} onClick={togglePaintGizmo} title="브러시로 면을 칠해 서포트를 강제하거나 차단 — 휠로 브러시 크기 조절" data-testid="gizmo-paint"><img src={paintIcon} alt="서포트 페인팅" /></button>
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
                <button className="eh-btn" onClick={() => fileInputRef.current?.click()} data-testid="empty-pick" title="STL·OBJ·3MF·AMF·PLY 파일 선택 (여러 개 가능)">파일 선택</button>
              </div>
            )}
            {dragOver && <div className="drop-overlay" data-testid="drop-overlay">여기에 놓기 (STL/OBJ/3MF/AMF/PLY)</div>}
            {ctxMenu && (
              <>
                <div className="ctx-scrim" onPointerDown={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null) }} />
                <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} data-testid="ctx-menu">
                  {ctxMenu.onObject ? (<>
                    <button onClick={() => { setCtxMenu(null); duplicateSelected() }} data-testid="ctx-duplicate" title="선택 오브젝트를 같은 크기·회전으로 복제해 옆에 배치">복제 <span className="ctx-key">Ctrl+K</span></button>
                    <button onClick={() => { setCtxMenu(null); copySelected() }} data-testid="ctx-copy" title="선택 오브젝트를 버퍼에 복사 (붙여넣기로 추가)">복사 <span className="ctx-key">Ctrl+C</span></button>
                    <button onClick={() => { setCtxMenu(null); splitSelected() }} data-testid="ctx-split" title="객체로 분리 — 서로 떨어진 부분(연결 성분)마다 독립 오브젝트로 나눔. 파트로 분리는 미구현(파트 개념 부재)">분리</button>
                    <button onClick={() => { setCtxMenu(null); apiRef.current?.placeOnBed() }} data-testid="ctx-seat" title="모든 오브젝트를 베드 바닥(Z=0)에 붙임">바닥에 놓기</button>
                    <hr />
                    <button className="danger" onClick={() => { setCtxMenu(null); deleteSelected() }} data-testid="ctx-delete" title="선택 오브젝트를 씬에서 제거">삭제 <span className="ctx-key">Del</span></button>
                  </>) : (<>
                    <button onClick={() => { setCtxMenu(null); fileInputRef.current?.click() }} data-testid="ctx-open" title="모델 파일을 열어 현재 플레이트에 추가">모델 열기…</button>
                    <button disabled={!clipboardRef.current} onClick={() => { setCtxMenu(null); pasteClipboard() }} data-testid="ctx-paste" title="복사해 둔 오브젝트를 현재 플레이트에 추가">붙여넣기 <span className="ctx-key">Ctrl+V</span></button>
                    <hr />
                    <button onClick={() => { setCtxMenu(null); apiRef.current?.frame() }} data-testid="ctx-zoom-all" title="모든 오브젝트가 보이도록 카메라 맞춤">전체 보기 <span className="ctx-key">Z</span></button>
                    <button onClick={() => { setCtxMenu(null); apiRef.current?.frameBed() }} data-testid="ctx-zoom-bed" title="선택한 플레이트 전체가 보이도록 카메라 맞춤">베드 보기 <span className="ctx-key">B</span></button>
                  </>)}
                </div>
              </>
            )}
            {showHelp && (
              <div className="help-overlay" data-testid="help-overlay" onClick={() => setShowHelp(false)}>
                <div className="help-card" onClick={e => e.stopPropagation()}>
                  <h3>단축키 <span className="muted">(? 로 닫기)</span></h3>
                  <div className="help-cols">
                    <section>
                      <h4>Prepare</h4>
                      <dl>
                        <dt>M / G</dt><dd>이동</dd><dt>R</dt><dd>회전</dd><dt>S</dt><dd>스케일</dd>
                        <dt>방향키</dt><dd>10mm 이동 (Shift 1mm)</dd>
                        <dt>PageUp/Down</dt><dd>45° 회전</dd>
                        <dt>Del</dt><dd>선택 삭제</dd><dt>Esc</dt><dd>선택/페인트 해제</dd>
                      </dl>
                    </section>
                    <section>
                      <h4>Preview</h4>
                      <dl>
                        <dt>↑ / ↓</dt><dd>레이어 (Shift 10단계)</dd>
                        <dt>L</dt><dd>단일 레이어</dd><dt>T</dt><dd>트래블</dd>
                        <dt>Esc</dt><dd>Prepare 로</dd>
                      </dl>
                    </section>
                    <section>
                      <h4>공통</h4>
                      <dl>
                        <dt>Ctrl+R</dt><dd>슬라이스</dd>
                        <dt>Ctrl+K / ⌘D</dt><dd>복제</dd>
                        <dt>Ctrl+C/V/X</dt><dd>복사/붙여넣기/잘라내기</dd>
                        <dt>Z / B</dt><dd>전체 / 베드로 줌</dd>
                      </dl>
                    </section>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 뷰포트 상단 오브젝트 툴바 */}
          {ok && canvasMode === 'prepare' && (
            <div className="vp-top-toolbar" role="toolbar" aria-label="오브젝트 도구">
              {OBJECT_TOOLS.map((t, i) => t.sep
                ? <span key={'sep' + i} className="vtt-sep" />
                : <button key={t.id} onClick={t.run} disabled={t.disabled?.() ?? !t.run}
                    title={t.tip} data-testid={`tool-${t.id}`}><img src={t.icon} alt={t.label} /></button>)}
            </div>
          )}

          {/* 페인팅 플로팅 패널 */}
          {ok && canvasMode === 'prepare' && paintMode !== 'off' && (
            <div className="brush-panel" data-testid="paint-tools">
              <div className="bp-title">서포트 페인팅</div>
              <div className="bp-modes">
                <button className={paintMode === 'enforcer' ? 'on enf' : 'enf'} onClick={() => setPaintMode('enforcer')} title="칠한 면 아래에 서포트를 강제로 생성" data-testid="paint-enforcer">enforcer</button>
                <button className={paintMode === 'blocker' ? 'on blk' : 'blk'} onClick={() => setPaintMode('blocker')} title="칠한 면 아래에 서포트가 생기지 않게 차단" data-testid="paint-blocker">blocker</button>
                <button onClick={clearPaint} data-testid="paint-clear" title="칠한 강제/차단 영역을 모두 지움">지우기</button>
                <button onClick={() => setPaintMode('off')} data-testid="paint-off" title="페인팅 모드 종료 (Esc)">닫기</button>
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
                <button key={i} role="tab" className={'plate-tab' + (i === selectedPlate ? ' on' : '')} onClick={() => selectPlate(i)} title={`플레이트 ${i + 1} 선택 — Preview 에선 이 플레이트 결과로 전환`} data-testid={`plate-${i}`} title={`플레이트 ${i + 1}`}>{i + 1}</button>
              ))}
              <button className="plate-add" onClick={addPlate} disabled={plateCount >= MAX_PLATES} title="빈 플레이트 추가 (최대 9개) — 플레이트별로 따로 슬라이스·내보내기" data-testid="plate-add">+</button>
              {plateCount > 1 && <button className="plate-del" onClick={deletePlate} title="마지막 플레이트와 그 슬라이스 결과 삭제" data-testid="plate-del">−</button>}
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
                <div className="sc-info"><span>베드</span>
                  {/* 폭×깊이 직접 편집(사각형). 원점·원형·커스텀 형상은 프로세스 패널의 printable_area 에디터에서. */}
                  <span className="sc-bed" title="플레이트 크기 — Enter 또는 포커스 아웃으로 적용. 원형/커스텀 형상은 printable_area 옵션에서">
                    <input type="number" min="1" key={`w${Math.round(kp.bed_width)}`} defaultValue={Math.round(kp.bed_width)}
                      onBlur={e => setBedSize(+e.target.value, kp.bed_depth)}
                      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }} data-testid="bed-w-card" />
                    ×
                    <input type="number" min="1" key={`d${Math.round(kp.bed_depth)}`} defaultValue={Math.round(kp.bed_depth)}
                      onBlur={e => setBedSize(kp.bed_width, +e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }} data-testid="bed-d-card" />
                    mm
                  </span>
                </div>
                <div className="sc-info"><span>노즐 Ø</span><b>{nozzleDia} mm</b></div>
              </section>

              {/* ② 필라멘트 */}
              <section className="side-card" data-testid="filament-section">
                <div className="sc-head">🧵 필라멘트 <span className="sc-count">{extruderColors.length}</span>
                  <span className="sc-head-btns">
                    <button onClick={addFilament} disabled={extruderColors.length >= 4} title="필라멘트(익스트루더) 추가 — 최대 4개, 오브젝트별로 지정 가능" data-testid="filament-add">+</button>
                    <button onClick={removeFilament} disabled={extruderColors.length <= 1} title="마지막 필라멘트 제거 — 이를 쓰던 오브젝트는 남은 번호로 재배정" data-testid="filament-del">−</button>
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
                        <button className="obj-eye" onClick={() => toggleObjVisible(o.id)} title="이 오브젝트를 출력 대상에서 제외/포함 — 제외해도 씬에는 남음" data-testid={`eye-${o.id}`}>{o.visible === false ? '🚫' : '👁'}</button>
                        <span className="obj-name" title={o.name}>{o.name}</span>
                        <select className="obj-ext" value={o.extruder ?? 1} onChange={e => setObjExtruder(o.id, +e.target.value)} title="이 오브젝트를 출력할 필라멘트(익스트루더) 번호" data-testid={`ext-${o.id}`}>
                          {extruderColors.map((c, i) => <option key={i} value={i + 1}>T{i + 1}</option>)}
                        </select>
                        <button className="obj-split" onClick={() => { apiRef.current?.selectObject(o.id); splitSelected() }} title="객체로 분리 — 서로 떨어진 부분(연결 성분)마다 독립 오브젝트로 나눔. 파트로 분리는 미구현(파트 개념 부재)" data-testid={`split-${o.id}`}><img src={splitIcon} alt="분리" /></button>
                        <button className="obj-del" onClick={() => removeObject(o.id)} title="이 오브젝트를 씬에서 제거">✕</button>
                      </li>
                    ))}
                  </ul>
                  <label className="slice-support"><input type="checkbox" checked={supportOn} onChange={onToggleSupport} title="오버행 아래에 지지 구조를 생성 (설정 패널의 enable_support 와 동일)" data-testid="support-toggle" /> 서포트 생성</label>
                  <label className="slice-support"><input type="checkbox" checked={wipeTowerReal} onChange={e => setWipeTowerReal(e.target.checked)} title="멀티머티리얼 툴체인지 시 원본 WipeTower 로 퍼지량을 계산 (끄면 단순 사각 링)" data-testid="wipe-tower-real-toggle" /> 실 와이프타워 <span className="muted">(MM)</span></label>
                </section>
              )}
              {triWarn && <div className="slice-warn side-warn">⚠ {triWarn}</div>}
              {sliceNotice && <div className="slice-warn side-warn" data-testid="slice-notice">ℹ {sliceNotice}</div>}
              {error && <div className="slice-err side-warn" data-testid="slice-err">{error}</div>}
              {downgradeOffer && <button className="slice-btn" data-testid="downgrade-retry" onClick={retryDowngrade} title="인필을 단순화하고 밀도를 낮춰 메모리 부담을 줄인 뒤 재시도">간소화 재시도(인필 단순화·절약 모드)</button>}

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
                <button className="slice-btn" title={plateCount > 1 ? '슬라이스 대상 선택 (Ctrl+R = 현재 플레이트)' : '현재 플레이트를 슬라이스 (Ctrl+R)'} onClick={() => (plateCount > 1 ? setSliceMenu(v => !v) : onSlice('current'))} disabled={objects.length === 0 || slicing} data-testid="slice-btn">
                  {slicing ? `슬라이싱… ${Math.round(progress * 100)}%` : (plateCount > 1 ? '슬라이스 ▾' : '슬라이스')}
                </button>
                {sliceMenu && plateCount > 1 && (
                  <div className="slice-menu" data-testid="slice-menu">
                    <button onClick={() => onSlice('current')} data-testid="slice-current" title="선택한 플레이트만 슬라이스 (Ctrl+R)">현재 플레이트 (P{selectedPlate + 1})</button>
                    <button onClick={() => onSlice('all')} data-testid="slice-all" title="모든 플레이트를 차례로 슬라이스 — 결과는 탭 전환으로 조회">전체 플레이트 ({plateCount})</button>
                    {slicedPlateCount > 0 && (
                      <button onClick={exportAllGcode} data-testid="export-all" title="슬라이스된 모든 플레이트의 G-code를 각각 파일로 저장">전체 G-code 내보내기 ({slicedPlateCount})</button>
                    )}
                  </div>
                )}
              </div>
              {gcodeUrl
                ? <a className="export-btn" href={gcodeUrl} download={`plate_${selectedPlate + 1}.gcode`} title="현재 보고 있는 플레이트의 G-code 파일 저장" data-testid="gcode-dl">G-code 내보내기</a>
                : <button className="export-btn" disabled title="G-code 내보내기 — 슬라이스 후 활성화됩니다">G-code 내보내기</button>}
            </div>
          </aside>
        )}
      </div>
    </div>
    </ShadowHost>
  )
}
