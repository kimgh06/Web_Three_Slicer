# web/ — 브라우저 슬라이싱(SDK) + 추출 산출물

원본 OrcaSlicer 소스는 `../slicer/` 에 있고, 이 `web/` 는 그것을 리버스 엔지니어링한 브라우저/WASM
슬라이싱 커널 + 뷰어다(`../slicer/` 에 대한 빌드·런타임 의존 0). 가이드: [`GUIDE.md`](GUIDE.md), 스펙: [`SPECS.md`](SPECS.md).

## 워크스페이스 구조 (33단계 Phase 2)

npm workspaces 루트(`web/package.json`):
- **`packages/engine/`** — `@orca-re/engine`: WASM 슬라이싱 커널 SDK. 공개 API + 워커 + 설정 매핑.
  - 커널 재빌드(`wasm-core/build.sh`)는 34단계에서 **완전 독립화**: 원본 deps(clipper·clipper2·libnest2d·libigl·
    admesh 등 deps_src 전량 23M)를 `wasm-core/third_party/` 로 사본화 → `slicer/` 없이도 빌드 성공(실증: slicer 임시
    이름변경 상태에서 build.sh+12스위트 그린). golden byte-identical 유지.
- **`packages/data/`** — `@orca-re/data`: 추출 JSON(config-schema/ui-tree/toggle-rules/invalidation-map). `extract_all.py` 가 재생성.
- **`packages/components/`** — `@orca-re/components`: 재사용 React 컴포넌트(props 구동, 전역/컨텍스트 결합 0). `<SettingsPanel/>` 제공(사용법: `packages/components/README.md`).
- **`viewer/`** — 데모 앱. engine(워커·설정) + data + components(`<SettingsPanel/>`) 를 소비. (구조상 apps/demo 역할; 이름 유지)
- **`apps/independence-check/`** — `<SettingsPanel/>` 를 App/컨텍스트/라우터 없이 단독 렌더·편집해 독립성 증명(자체 install).

### `@orca-re/engine` 사용 (헤드리스/Node)

```js
import { createSlicer } from '@orca-re/engine'        // 예제: web/packages/engine/examples/headless.mjs

const slicer = await createSlicer()                    // WASM 커널 로드
// 배치: 전체 결과(gcode + stats + layers)
const r = slicer.slice(stlArrayBuffer, kernelParams)
console.log(r.stats.layers, r.gcode.length)
// 스트리밍(30단계 OOM 내성): 레이어마다 방출 + 힙 해제, 결과엔 stats 만
slicer.slice(stlArrayBuffer, kernelParams, {
  onProgress: (done, total) => {},
  onLayer: ({ z, idx, gcode, paths, widths }) => { /* GPU 업로드/다운로드 누적 */ },
})
slicer.dispose()
```

브라우저(오프-메인스레드)는 워커로: `new Worker(engineWorkerURL(), { type: 'module' })` — 워커가
30단계 스트리밍 프로토콜(`{type:'layer'|'done'|'error'|'progress'}`)을 말한다. UI 설정→커널 파라미터
변환은 `@orca-re/engine/settings` 의 `deriveKernelParams(settings)` (config-schema 기반, 번들러/브라우저용).

## 추출 산출물

`GUIDE.md` 의 §11 레시피를 실행한 실물이다.
재생성: `python3 web/extract_all.py` (경로는 `__file__` 기준 유도 — 원본은 `../slicer/`, 산출은 `web/`).

| 파일 | 내용 | 커버리지 (2026-07-23, main 607648c 기준) |
|---|---|---|
| `config-schema.json` | 옵션 907개 메타데이터: type, label, category, tooltip, sidetext, min/max, mode, gui_type, enum_values/labels, ratio_over, default, 소스 줄번호 | coEnum 전체(70개)가 enum_values 보유. 툴팁 732개. **default 92% 파싱**(매크로 상수·enum s_keys_map 역해석·벡터/Vec2d 리터럴 포함; enum 기본값↔enum_values 정합 오매핑 0 검증). UI 노출 552개 기준 미해석 default는 `thumbnails_format` 1건뿐, default 자체가 없는 69개는 전부 비UI 런타임/CLI 내부 옵션. 루프 생성 12개는 수동 전개(`generated_by_loop` 마커). **11단계에서 빌드 기반 덤프(`config-schema-builddump.json`)로 교차검증 완료 — 아래 참조.** |
| `config-schema-builddump.json` | **빌드 기반 실측** print_config_def 덤프 817개: type, mode, nullable, label/full_label, category, tooltip, sidetext, ratio_over, min/max, enum_values/labels, serialize된 default | 11단계: 이식된 실 PrintConfig.cpp 를 WASM 에서 컴파일→`print_config_def`(=817) 를 embind 로 덤프. 정규식 907 vs 빌드 817 차이 = 정규식이 별도 ConfigDef(CLI actions/transform/misc)·placeholder-parser 런타임변수 107개를 잘못 포함 + 루프생성 filament_* 17개 누락. `compare_schema.mjs` 로 필드 대조: type 불일치 0, default 불일치 54(전부 표현차 bool 0/1↔false·문자열 이스케이프·coEnums 빈벡터·nil; 정규식 실추출버그 `has_scarf_joint_seam` 1건 빌드가 교정), enum 불일치 2(`filament_type` 빌드가 MaterialType 75종 정확 열거·정규식 0, `support_interface_bottom_layers`) |
| `ui-tree.json` | Tab.cpp의 페이지→그룹→옵션 트리. 빌더 11개(TabPrint/TabFilament/TabPrinter/Frequent/Plate/SettingOverrides + SLA), 34페이지, 옵션 참조 587개, 각 항목 소스 줄번호 | `<custom-widget line:N>` 마커 = G-code 에디터 등 수동 구현 필요 지점 |
| `toggle-rules.json` | 옵션 활성/비활성 규칙 231개: `{fields[], enable_if(C++ 조건식 원문), kind, line}` + 함수별 지역변수 조건(`locals`) | 원본 호출 242개 중 231개(95%). 함수별 미추출 수는 각 `stats`에 기록 — 변수명으로 호출된 것들이라 해당 줄 직접 확인 필요 |
| `invalidation-map.json` | 옵션 변경→재실행 단계 매핑. Print 6분기 + PrintObject 19분기(키 263개) | 매핑에 없는 키 = 전체 무효화(기본 분기). 자세한 의미는 가이드 §2.2 |

## 사용법 (웹 구현에서)

- **설정 폼 자동 생성**: `config-schema.json` + `ui-tree.json` 조인. 위젯 선택 규칙은 가이드 §4.3.
- **활성/비활성**: `toggle-rules.json`의 `enable_if`는 C++ 원문이다. `config->opt_bool("x")` →
  `cfg.x`, `opt_enum<T>(...) == T::y` → `cfg.x === 'y'` 식으로 기계적 번역 가능. `locals`의
  변수를 먼저 인라인할 것.
- **증분 슬라이싱**: `invalidation-map.json`으로 변경 옵션→재실행 단계 판정.

## 알려진 한계

- 정규식 기반 정적 추출이다. **빌드 기반 덤프 툴(가이드 §11.1)은 11단계에서 실현됨** →
  `config-schema-builddump.json`(WASM 에서 실 `print_config_def` 를 덤프한 817개, 컴파일러 근거).
  교차검증(`compare_schema.mjs`) 결과 type 불일치 0 으로 정규식 추출의 정확성이 대체로 확인됐고,
  차이는 대부분 정규식의 과대포함(별도 CLI/placeholder ConfigDef 107개)·과소포함(루프생성 17개)·표현차였다.
  UI 소비 시엔 여전히 `config-schema.json`(카테고리/툴팁/줄번호 등 UI 메타 풍부)을 쓰고, 옵션 존재·타입·
  default 의 최종 진실은 빌드 덤프를 신뢰하라.
- `update_print_fff_config`(ConfigManipulation.cpp)의 **값 자동보정 다이얼로그 규칙**(예: spiral
  mode 켜면 wall_loops=1 강제)은 toggle이 아니라서 이 JSON에 없다. 수동 번역 대상.
- SLA 계열은 추출은 됐지만 검수하지 않았다.
- ui-tree ↔ schema 교차검증 결과 댕글링 참조 2건: `spaghetti_detector`(PrintConfig.cpp:4020에서
  주석 처리됨, TabPrinter가 여전히 참조), `pad_edge_radius`(SLA 레거시, 정의 없음). 웹 구현에서는
  이 두 키를 스킵하면 된다.

## 뷰어

- 위치: `reverse_engineering/viewer/` (Vite + React 18 + react-router v7 + three.js, 위 JSON 4종을 정적 import).
- 실행: `cd reverse_engineering/viewer && npm i && npm run dev` → 브라우저에서 hash 라우팅으로 열림.
- 메인 화면 `/`: **헤더 없음** — 좌측 **3D 뷰포트**(three.js: 베드 그리드+테두리(설정값으로 그림),
  데모 메시, OrbitControls 회전/팬/줌, Raycaster 호버/선택, TransformControls 이동/회전/스케일 — G/R/S),
  우측 **편집 가능 설정 패널**(전체 높이) — 빌더→페이지→그룹→옵션 행. 상단 **검색 input**(결과는 패널
  안 리스트, 편집 가능). 위젯(input/checkbox/select) 편집 → 공유 설정 상태(`key→value` sparse 맵, 초기값
  = 스키마 default) 갱신. 벡터형(coFloats 등)은 첫 원소만 편집. 세션 내 유지(리로드 시 초기화).
- 딥링크 라우트: `/tab/:builder`·`/option/:key`·`/search` 는 URL 직접 접근용으로만 유지(내비 제거).
- **모델 임포트**(26단계, `model_loaders.js`): **STL·OBJ·3MF·AMF·PLY** 다중 업로드(누적) + **드래그앤드롭**(뷰포트
  전체 드롭존) + 빈 씬 안내 오버레이(데모 메시 제거). three/examples/jsm 로더 재사용(신규 의존성 없음), 결과(BufferGeometry|
  Group)를 월드행렬 베이크→비인덱스 삼각형→model z-up flat 로 통일해 기존 슬라이스 경로 재사용(커널 무변경). 3MF/AMF 복수
  오브젝트는 개별 등록, bbox 나란히 배치(겹침 방지). **STEP 은 범위 외**(OCCT 필요). 3MF 는 1차 지오메트리만(프로젝트 설정
  복원은 후속 — SPECS §1).
- **Slice 패널**(뷰포트 우상단): 업로드된 각 오브젝트를 TransformControls 로
  이동/회전(목록+삭제 UI) → 서포트 토글(=`enable_support` 동기화) → [Slice]. **파라미터는 우측 설정
  패널 실값에서 유도**(schema key→커널 param 매핑, `settings.js`) — 중복 폼 없음. **Web Worker** 슬라이스
  (진행률 %, UI 논블록) → 툴패스 오버레이. **실폭(볼류메트릭) 렌더**(24단계 — **원본 libvgcode 방식 그대로 포팅**,
  `toolpath_gpu.js`): CPU 는 지오메트리를 만들지 않는다 — 8정점 다이아몬드 템플릿을 `InstancedBufferGeometry`
  로 세그먼트마다 인스턴싱하고, PathVertex 스트림(position/height_width_angle/color/segment_index)을 `DataTexture`
  (RGBA32F·RGBA32UI, texelFetch)로 올려 원본 `Segments_Vertex_Shader_ES`(GLSL ES 3.0, `RawShaderMaterial`)가
  뷰의존 하프박스·마이터 조인·POINTY_CAPS·2광원 라이팅을 그대로 계산. 세그먼트별 폭(`widths[]`) 반영, 트래블은
  별도 라인. 가시 레이어는 세그먼트 인덱스가 레이어순이라 `instanceCount` O(1) 로 조절. 177만+ 세그먼트도 단번에
  렌더(청크/폴백/상한 불필요). **다이아몬드 단면 + z 센터링**이라 층간 공면 z-fighting("대각선 거대 폴리곤") 구조적 부재.
  색: 벽=주황/스파스=파랑/솔리드=시안/스커트=초록/서포트=보라/래프트=갈색/갭필=노랑/씬월=분홍/브리지=빨강/
  **아이어닝=연두/프라임타워=청록**/트래블=회색. **레이어 슬라이더**,
  stats(+베드 초과 경고), **G-code 다운로드**. 멀티 오브젝트는 각 변환을 JS 에서 삼각형에 적용해 하나로
  병합 후 커널로. WASM 은 첫 Slice 시 lazy 로드. 정적 산출물(`vite preview`)만으로 완전 자립 동작.
- 향후: toggle-rules(옵션 활성/비활성 조건) 적용은 미구현 — 현재 모든 위젯 항상 편집 가능.

## WASM 코어 (트랙 C — 브라우저 단독 슬라이싱 미니 커널)

- 위치: `reverse_engineering/wasm-core/`.
- 빌드: `bash reverse_engineering/wasm-core/build.sh` (emscripten 필요, `EMSDK_PYTHON` export 포함).
  **7단계부터 brew `boost`+`eigen` 필요**(header-only voronoi/Eigen). 산출물 `slicer_core.js`
  (SINGLE_FILE=1 → wasm base64 인라인)는 `viewer/src/slicer/` 에 커밋되어 있어 **뷰어만 쓸 땐
  emscripten/boost/eigen 없이도 동작**한다.
- 자체 테스트: `node reverse_engineering/wasm-core/test.mjs` (큐브+ASCII+오버행 테이블+원기둥+얇은
  십자+얇은 링+L자+나란한 두 박스 → **120개 불변식**: 레이어수·솔리드셸·스커트·z_hop·서포트·래프트·베드 +
  인필 패턴별 슬라이스·zigzag 트래블 감소·팬 램프(첫층 0/M107)·소형레이어 감속·아크 G2/G3 존재+압출 ±1%·
  심 4모드 분포·스파이럴 + **5단계: 갭필(2.5w링)·씬월 중심선·scarf 마커+심 z중간값·M900·tree_lite
  테이퍼+접지·브리지** + **6단계: 아이어닝 type10+유량10%·벽회피 트래블 감소(L자)·PE-lite 유량 변화율
  한도(F 검산)·멀티머티리얼 T0/T1+프라임타워** + **7단계: 실제 Arachne 가변폭 벽(얇은 십자 0.42→0.60mm
  가변·큐브 균일·E 폭기반)·classic 기본 하위호환** + **8단계: 실제 Fill 패턴(gyroid TPMS/honeycomb/
  3dhoneycomb/crosshatch/concentric)·원본 gyroid≠근사·gyroid z-위상·실제 PE 이식 실행+E보존** + **9단계:
  실제 PE 완전통합(OrcaSlicer 태그 방출→세그먼트 F램프 G1↑+E보존+태그strip)·TreeSupport MST 코어 이식** +
  **10단계: 이식된 GCodeProcessor 시간추정(원본 사다리꼴 플래너 verbatim, 파싱기반 총/레이어별/role별 시간·faster→less·
  필라멘트 0% 대조)·뷰어 예상시간 표시·WipeTower/full-GCodeProcessor는 config 서브시스템 관문 기록**).
- 구성: `slicer_core.cpp`(multi-pass: STL → 교차·체이닝·Union·벽 → 표면검출 → **서포트** → 솔리드/스파스
  (패턴) → **래프트** → 냉각/감속/심/아크 → G-code, 유량 수학 SPECS §6.2), `clipper.{cpp,hpp}`
  (OrcaSlicer deps Clipper 6.4.2 를 WASM 용 패치: Eigen/oneTBB 제거), `Int128.hpp`(로컬 복사).
- 인터페이스: embind `slice(Uint8Array stl, string paramsJson, function onProgress)` → `{ gcode,
  stats:{layers,model_layers,raft_layers,path_segments,filament_mm,over_bed,wall_crossings}, layers:[{z, paths:Float32Array, widths:Float32Array}] }`.
  (`widths` = 세그먼트별 폭 병렬 배열, 7단계 Arachne 가변폭용. classic 은 line_width 균일.)
  툴패스 flat `[x,y,z,type]` (0=travel/1=wall/2=sparse/3=solid/4=skirt·brim/5=support/6=raft/7=gap-fill/8=thin-wall/9=bridge/**10=ironing/11=prime-tower**). `stats.wall_crossings`(벽 횡단 트래블 수) 추가. `onProgress(done,total)` 레이어 단위.

**1단계** (골격): STL(바이너리) → 벽 N개 + sparse 평행선 인필 → G-code. (위아래 뚫림)

**2단계** (실제 출력 가능 수준):
- 솔리드 top/bottom 셸 — 표면 검출(이웃 레이어 Clipper Difference) → `top_shell_layers`/`bottom_shell_layers`
  전파, 첫/마지막 레이어 전체 solid. 솔리드=간격 line_width, 스파스=line_width/density.
- 스커트(`skirt_loops`@`skirt_distance`) + 브림(`brim_width` → w 간격 링들), 첫 레이어. **동심 링은 개별 방출**.
- ASCII STL 파싱(`vertex` 수집). 바이너리/ASCII 자동 판별(`84+50n==size`).
- 리트랙션 파라미터화(`retract_length`/`retract_speed`) + `z_hop`(리트랙션 시 Z↑ 이동 후 Z↓).
- 심 정렬(rear seam): 각 레이어 벽 루프 시작점을 Y최대 정점으로 회전 → 심이 후면 한 줄로 정렬.
- Web Worker 논블록 슬라이스 + 레이어 단위 진행률.

**3단계** (지오메트리 완성):
- **일반(grid) 서포트** — 오버행 검출 `contour_i − offset(contour_{i-1}, +tan(threshold)·lh)` → 위→아래
  수직 투영(union, `support_top_z_distance` 만큼 지연해 접촉 z간격) → 모델 회피(`support_xy_distance`) →
  인터페이스 `support_interface_top_layers`(solid) / 본체(sparse, `support_density`). 벽 없음. 툴패스 type=5.
- **래프트**(`raft_layers`) — 모델+서포트 첫 레이어 영역 +3mm 팽창 베이스를 z 아래 삽입(첫층 0.3 solid,
  이후 sparse), 모델 전체 z 시프트. `; raft` 마커, 툴패스 type=6.
- **베드 파라미터화**(`bed_width`/`bed_depth`) — G-code 오프셋=bed/2, 뷰포트 그리드도 이 값. 초과 시 `over_bed`.
- **멀티 오브젝트** — 뷰어에서 여러 STL 누적 + TransformControls 변환을 JS 에서 삼각형에 적용해 병합 후
  커널로. 겹치지 않는 오브젝트는 커널 Union 으로 자연 처리.
- **top 솔리드 모노토닉** — 솔리드 인필 라인을 채움 법선축 투영값으로 정렬해 방출.

**4단계** (경로·G-code 레벨):
- **인필 패턴**(`sparse_infill_pattern`) — rectilinear·grid(0/90°)·triangles(0/60/120°)·zigzag(경계
  연결 연속 경로 → 트래블 감소)·gyroid(사인 근사, z 위상 회전). 커널 미지원 패턴명은 rectilinear 로 폴백.
- **냉각**(`fan_speed`/`close_fan_the_first_x_layers`/`full_fan_speed_layer`) — 레이어 경계 M106 선형 램프
  (첫층 0 → full 층 255·fan/100), 끝 M107. + 레이어 예상시간 < `slow_down_layer_time` 이면 이송속도 비율
  감속(최저 20mm/s), 방출 전 경로길이로 산정.
- **아크 피팅**(`enable_arc_fitting`) — 연속 세그먼트 원호 근사(≥5점, 편차≤0.05mm, r 0.1~200, ≤155°) → G2/G3.
- **심 위치**(`seam_position`) — back(Y최대)/nearest(노즐 최근접)/aligned(이전 레이어 심)/random(레이어
  인덱스 시드 LCG, 결정적).
- **스파이럴**(`spiral_mode`) — 단일 외벽, 인필/솔리드 없음, 둘레 따라 z 연속 상승(vase).

**5단계** (품질·근사 기능 — 각각 최소 구현+근사, "완전 libslic3r 아님" 주석 명시):
- **갭필**(type7) — 최내벽 안쪽 fill 의 morphological-open 잔여(`offset -w/2 후 +w/2`, 폭<w 얇은 틈)를
  검출 → 단일폭 중심선 근사(rectilinear 1줄). fillCore 에서 제외해 이중압출 방지. ⚠ 메디얼축/가변폭 아님.
- **씬월(Arachne-lite)**(type8) — 폭<2w 라 벽 오프셋이 소실되는 영역 검출(`contour − open(contour,w)`).
  두꺼운 코어에서만 벽 생성, 얇은 부위는 성분별 장축 **중심선 1줄** + 국소폭(면적/길이)으로 flow 보정.
  ⚠ 완전한 Arachne 가변폭 스켈레톤 아님 — 단일 중심선 근사.
- **Scarf 심**(`seam_slope_type` none|external|all) — external/all 이면 외벽 루프 시작에서 z(`z-h→z`)·
  flow(0→1) 램프업(기본 10mm, 긴 직선벽은 세분해 z 연속), 끝에서 같은 길이 오버랩 램프다운(flow 1→0).
  `; scarf` 마커. z-seam blob 대신 완만한 경사 조인트.
- **압력 어드밴스**(`enable_pressure_advance`+`pressure_advance`, 기본 0.02) — 프리앰블 `M900 K<v>`
  (Marlin/RRF). Klipper 는 `SET_PRESSURE_ADVANCE` 주석 표기만.
- **트리라이트 서포트**(`support_style` grid|tree_lite) — tree_lite 는 위→아래 스윕서 층마다 `-0.5mm`
  수축(최소 기둥 반경 1.5mm 유지)+union 병합 → 위 넓고 아래 좁은 나무형. 모델 회피 재사용.
  ⚠ 오가닉 트리(가지 분기/각도 최적화) 아님 — 단순 하강 테이퍼. 프레임형 오버행은 트렁크로 병합되지 않고
  최소폭까지 좁아진 뒤 동결(솔리드 오버행만 트렁크로 수렴). 뷰어는 스키마 `support_style` enum(tree_*·
  organic)을 tree_lite 로, 그 외를 grid 로 매핑.
- **브리지**(type9) — 무지지 bottom 솔리드(오버행 밑면, 서포트 미접촉) → 팬 100%+`bridge_speed`(기본 25) 감속.

**6단계** (동등성 갭 축소 — 각각 최소 구현+근사, "완전 libslic3r 아님" 주석 명시):
- **아이어닝**(`ironing_type` no ironing|top|topmost|solid, type10) — top류면 노출 top 솔리드 위에 같은 z 로
  저유량 재패스: 간격 `ironing_spacing`(0.1), flow `ironing_flow`(10%→e_per_mm×0.1), 속도 `ironing_speed`.
  `; ironing` 마커. ⚠ top/topmost/solid 를 모두 노출 top 표면 아이어닝으로 동일 처리(레이어 구분 없음).
- **벽 회피 트래블**(`reduce_crossing_wall`) — 트래블 시작·끝이 아일랜드(벽 안쪽=`offset(contour,-w/2)`)
  안인데 직선이 경계를 횡단하면 → 경계 폴리곤을 A근접정점→(짧은쪽)→B근접정점 으로 걷는 우회 경로(리트랙션
  생략). 항상 횡단 검출(`stats.wall_crossings`), avoid 시만 우회. ⚠ 완전 회피 아님(우회 실패분 잔존).
- **PressureEqualizer-lite**(`max_volumetric_extrusion_rate_slope`, mm³/s², 0=off) — 인접 압출 세그먼트
  체적유량 변화율을 한도로: Δt=d/v_n, v_n=Fn/A → slope=|Fn−Fl|·Fn/(d·A)≤한도. 가속은 Fn 상한(2차식),
  감속은 급강하 구간을 hi 로 제한. **세그먼트 분할 없이 세그먼트 단위 속도만 조정**(E 불변, 속도만). 저유량
  피처(씬월·아이어닝)는 단면 급변 회피 위해 PE 대상서 제외. ⚠ 데스크톱은 세그먼트 분할·전구간 예측; 여기선 근사.
- **멀티머티리얼 기초**(`extruder_count`=2 + `mm_group_split`) — 뷰어 오브젝트별 익스트루더(T1/T2) 지정 →
  병합 STL 을 익스트루더순 정렬, 그룹 경계 인덱스 전달 → 레이어 내 그룹별 분리 슬라이스, 전환 시 `T0/T1` +
  간단 프라임 타워(베드 구석 15×15 동심 사각 링 3줄, type11, 전환 레이어에만). 벽+스파스 인필만.
  ⚠ **와이프타워 본격 구현 아님** — 퍼지/램밍/와이프량·타워 밀도 최적화 없음. 서포트/솔리드셸 등 미적용.

**7단계** (성격 전환 — 근사가 아니라 **실제 OrcaSlicer Arachne 소스 이식**, 동등성 확보의 시작):
- `src/libslic3r/Arachne/` 전체(WallToolPaths·SkeletalTrapezoidation Voronoi 스켈레톤·5개 BeadingStrategy·
  ExtrusionLine/Junction·SparseGrid/PolylineStitcher 유틸)를 **원본 알고리즘 무수정**으로
  `wasm-core/arachne_port/` 에 이식 → WASM **컴파일+링크+실행 성공**. `wall_generator=arachne` 시 벽 생성을
  진짜 Arachne 로 수행(classic 이 커널 기본값 → 하위호환 유지).
- 결과(검증): 큐브 벽 균일 0.42mm, **얇은 십자 팔은 가변폭 0.42→0.60mm**(실제 가변폭 비드), E 는 세그먼트
  폭 기반(`set_e_per_mm_width` — 넓은 세그먼트가 단위길이당 E↑, G-code 0.031→0.046 검산), 툴패스에
  `widths[]` 병렬 배열 → 리본이 세그먼트별 실폭 렌더. 뷰어 스크린샷 `screenshots/stage7-arachne-*`.
- 통합 구조: `arachne_bridge.{h,cpp}` 가 유일한 경계 — 커널(전역 `ClipperLib`)과 이식본
  (`Slic3r::ClipperLib` + `ClipperLib_Z`)을 서로 다른 네임스페이스로 격리해 한 모듈에 공존. 커널은
  plain-type `arachne_bridge.h` 만 include(Slic3r/clipper 타입 미노출). fill/인필/서포트 등은 classic 유지,
  **벽 생성만** 실제 Arachne 로 대체.
- 의존성: brew **boost**(header-only `polygon/voronoi` + `container_hash`) + brew **eigen** + `deps_src`
  (`clipper/clipper_z`, `ankerl/unordered_dense`). boost 링크 라이브러리는 **불필요**(voronoi 는 header-only) —
  이게 이식 가능성의 핵심이었다.
- 스텁/최소수정(원본 알고리즘 불변, 주변부만 — 각 파일 상단 주석에 사유 기록):
  `oneapi/tbb`→std::allocator, `boost/log`→no-op, `cereal/access`→전방선언+construct, `SVG`→no-op
  (SVG 사용은 전부 `#ifdef ARACHNE_DEBUG`), `Flow`→정적 1함수만, `VariableWidth/PrintConfig/Utils/Config`→
  미사용부 스텁, `Geometry`→실물 사용(cereal 만 스텁). **소스 수정 2곳**: `WallToolPaths.cpp`
  (`make_paths_params` 정의 제거 — PrintConfig 읽는 편의함수, 포트는 params 직접 구성) +
  `WallToolPaths.hpp`(`boost/container_hash/hash.hpp` include 추가 — 스텁으로 빠진 전이 include 보충) +
  `ExtrusionLine.cpp`(libslic3r ExtrusionPaths 변환 헬퍼 2개 제거 — Flow 결합, 포트 미사용).

**8단계** (원본 소스 이식 계속 — 실제 Fill 패턴 + 실제 PressureEqualizer):
- **실제 Fill 패턴 이식** (`src/libslic3r/Fill/`) — FillBase 프레임워크 + `FillGyroid`(진짜 TPMS)·
  `FillHoneycomb`·`Fill3DHoneycomb`·`FillCrossHatch`·`FillConcentric` 전체를 `arachne_port/` 에 이식,
  WASM **컴파일+링크+실행 성공**. `sparse_infill_pattern` 에서 gyroid 를 **진짜 TPMS 로 교체**(기존 사인
  근사는 `gyroid_approx` 로 보존). `fill_bridge` 가 유일한 경계(성분별 ExPolygon→FillBase.fill_surface→
  Polylines). 검증: gyroid 실제 50968 세그 ≠ 근사 101828, **gyroid z-위상**(층마다 곡면 위상 변화), 5개 패턴
  전부 슬라이스+세그>0. 뷰어 스크린샷 `screenshots/stage8-real-gyroid-tpms.png`(잘라낸 큐브 내부 TPMS 곡면).
  - 의존성 추가: **Clipper2**(deps_src/clipper2, header+3 .cpp, `FillBase::multiline_fill`), `ShortestPath`
    (경로 정렬), `ExtrusionEntityCollection`, `Circle`(ArcSegment), `MarchingSquares`(gyroid 등고선).
  - 스텁/수정: `Execution/ExecutionTBB`→순차 정책(TBB 없음), `PrintConfig`→infill enum 추가+PrintRegionConfig
    전방선언, `Utils`→IsTriviallyCopyable/modulo 헬퍼, `Flow`→width/spacing/mm3_per_mm 실물 공식, `cereal/types`
    →스텁, `GCodeWriter`→GCodeFormatter 만 추출. **소스 수정**: `FillBase.cpp`(new_from_type 를 이식 5패턴만
    으로 축소·use_bridge_flow null 가드·string 팩토리/fill_surface_extrusion/_create_gap_fill 스텁 — 전부
    PrintObjectConfig/미이식 패턴 결합부), `FillConcentric.cpp`(nozzle 상수화), `ShortestPath.cpp`
    (Print.hpp 제거+chain_print_object_instances 스텁).
- **실제 PressureEqualizer 이식** (`src/libslic3r/GCode/PressureEqualizer.cpp`) — WASM 컴파일+링크+실행 성공.
  `GCodeConfig` 생성자 → **파라미터 직접 주입**으로 치환, `LayerResult` 오버로드 제거, `process_to_string()`
  추가(문자열 in→평활 g-code out), `GCodeFormatter::emit_axis` 추출(wasm 은 std::to_chars). 검증: 실행+
  **E 총량 정확 보존**+g-code 구조(`; LAYER`/M104) 유지. ⚠ **한계(정직 기록)**: 실제 PE 는 OrcaSlicer 의
  `;_EXTRUDE_SET_SPEED`/`;_EXTRUDE_END`/`;_EXTRUSION_ROLE:` 태그 블록 안의 압출만 조정한다(PE.cpp:317
  `adjustable_flow = opened_extrude_set_speed_block`). 이 미니커널은 **평문 g-code**(태그 없음)를 내보내므로
  실제 PE 가 통과(no-op)한다 — 태그 주입한 최소 합성 입력도 세그먼트 분할이 관측되지 않았다(완전한 role-slope+
  다줄 look-back 파이프라인 컨텍스트 필요 추정). 그래서 **기본값 pe_lite=true**(실효 있는 6단계 근사 유지),
  실제 PE 는 `pe_lite=false` 옵트인+본 한계 문서화. **완전 통합 = 커널이 SET_SPEED/EXTRUSION_ROLE 태그
  g-code 를 방출하도록 개조**(다음 단계, g-code 포맷 변경).
- **WipeTower 정찰만** (`src/libslic3r/GCode/WipeTower.cpp`) — include 그래프: 지오메트리 코어(Point/Polygon/
  Polyline/BoundingBox/ClipperUtils, 이미 이식됨) + **GCodeProcessor.hpp**(g-code 파서, 최대 블로커 — 아래
  9단계 로드맵 참조) + **TriangleMesh + Triangulation**(타워 메시, 중간 난이도) + LocalesUtils(헤더 인라인).

**9단계** (실제 PE 완전 통합 + TreeSupport 코어 이식 + GCodeProcessor 로드맵):
- **실제 PE 완전 통합** — 커널 G-code 방출부가 OrcaSlicer 태그를 달도록 확장(`emit_pe_tags`, 기본 false;
  실제 PE 사용 시 자동 활성): 압출 런에 `;_EXTRUSION_ROLE:<n>`(원본 ExtrusionRole 정수 — wall=2/infill=4/
  solid=5/skirt=12/support=14/...) + `G1 F<v> ;_EXTRUDE_SET_SPEED`(블록 열기, 형식은 GCode.cpp:7643/7753,
  PE.cpp:289/317 에서 역산) + `;_EXTRUDE_END`(닫기). 그 위에 실제 PE 후처리 → **세그먼트 F 램프가 실제
  삽입**됨. 검증(node): arachne 큐브(가변 유량)에서 **G1 라인 4574→4754(+180 F램프)**, **E 총량 정확 보존**
  (570.76), 최종 출력 태그 strip(`pe_strip_tags` 기본 true → 깨끗한 g-code), 태그 모드에 3종 태그 존재/
  기본값 부재. → **실제 PE 가 이제 미니커널 g-code 에서 실효 동작**(8단계 no-op 한계 해소).
- **TreeSupport(오가닉) 이식 시도** — 전체 파이프라인(`Support/TreeSupport.cpp` 195KB + `TreeSupport3D.cpp`
  248KB)은 **PrintObject 결합이 깊어 이식 불가**: `Print.hpp`/`Layer.hpp`/`SupportCommon`/`TreeModelVolumes`
  (PrintObject 참조 각각 21·16회) + tbb concurrent 컨테이너 + libnest2d + nlohmann. **핵심 기하 루틴은 이식
  성공**: `MinimumSpanningTree`(branch 배치·병합 — Prim MST over 서포트 점, `Point.hpp`+`libslic3r.h` 만 의존,
  완전 자립)를 `tree_bridge` 로 커널형 점 집합에서 구동 → **9점→8엣지 유효 트리(N−1 비순환)**, 브랜치 길이
  74.06mm. 재현 `arachne_port/tree_link_test.sh`. 실제 서포트 생성은 **tree_lite 유지**(오가닉 트리 미통합).
  - 계층별 관문: MinimumSpanningTree ✅ 이식·구동 / TreeModelVolumes(avoidance) ⛔ TreeSupportCommon→
    SupportCommon→Print / TreeSupport.cpp(branch 배치·radii·접지) ⛔ PrintObject·Layer·tbb-concurrent.
- **GCodeProcessor 이식 로드맵** (`GCode/GCodeProcessor.{hpp,cpp}` ~9091줄, WipeTower·시간추정·프리뷰의 관문)
  — **호재: PrintObject 미결합**(Print.hpp 를 include 하나 `PrintConfig` 만 12회 참조, PrintObject 참조 0).
  파서라 구조적으로 이식 가능. 의존/스텁 초안:
    · 이식 대상: `GCodeReader`(PrintConfig+libslic3r 만 — 경량), `Geometry/ArcWelder`(Eigen+libslic3r), 
      `CustomGCode`·`MultiNozzleUtils`(중간), 본체 GCodeProcessor.cpp.
    · 스텁/치환: **`boost::filesystem`+`boost::nowide`**(파일 I/O 9곳 — WASM 은 문자열 입력이므로 파일 로드/
      저장 경로 스텁, 유일한 링크 블로커성 항목이나 스텁으로 회피), **GCodeConfig→파라미터 직접 주입**(PE 와
      동일 패턴), `boost/log`→no-op(기존), `format.hpp`·LocalesUtils(헤더 인라인).
    · 예상 규모: 중(파서 본체 큼) — Arachne(성공)보다 크고 Fill 과 비슷. 관문은 config 주입 + 파일 I/O 스텁이지
      PrintObject 가 아니므로 **이식 실현성 높음**. 완성 시 WipeTower·시간추정·프리뷰 데이터가 전부 원본이 됨.

**10단계** (GCodeProcessor 시간추정 이식 + WipeTower 관문 + 다음 대형 마일스톤 정찰):
- **원본 시간추정 이식 성공** — 9단계 로드맵 실행 중 **전체 GCodeProcessor.cpp 는 config 서브시스템에 막힘**을
  실측(컴파일 프로브): GCodeProcessor.hpp→`calib.hpp` 가 ExtruderType/NozzleVolumeType/BedType/FullPrintConfig/
  GCodeWriter/DynamicPrintConfig/BrimType 등 실 PrintConfig.hpp(~3000줄) 전부 요구 → 수백 에러. (9단계의 "PrintObject
  미결합" 관측은 맞으나, **PrintConfig 서브시스템 자체가 관문**이었음 — 정정.) 대응: **시간추정 알고리즘을
  verbatim 전사**(`gcode_time.{h,cpp}` — GCodeProcessor.cpp 원본 라인 인용: 헬퍼 L146-175, Trapezoid/TimeBlock
  L261-290, 플래너 정/역방향 L332-413, calculate_time L435-487, process_G1 블록생성 L5007-5231) + 머신한계
  파라미터 주입(PE 패턴, machine_max_*/machine_min_* 프로파일 대표값) + 방출 g-code 를 직접 파싱하는 경량 파서.
  - **커널 통합**: `stats.time_estimate`(총 초)·`layer_times[]`(레이어별, 합=총)·`role_times{}`(PE 태그 시 role별)·
    `time_extrude/time_travel`(move-type 분해)·`time_filament_mm`(파싱 필라멘트, gw.filament 대조). 뷰어 stats 에
    "예상 출력 시간 h:mm:ss" 표시.
  - **검증(node 신규 7)**: 큐브 파싱+총시간>0, layer_times 합=총, **faster print_speed→less time**(30mm/s 878s>120mm/s 698s,
    물리 방향성), **파싱 필라멘트==gw.filament 0.00%**(±2% 기준 통과), role 분해(태그모드 {2,4,5,12}), 결정성. 브라우저
    스모크 콘솔 에러 0(favicon 404 제외), 스크린샷 `screenshots/stage10_time_estimate.png`.
  - **간극/근사**: 시간모드 Normal 단일(Stealth 미모델), 룩어헤드 무제한(펌웨어는 64블록 윈도우 — 다소 낙관적),
    G2/G3 는 호길이로 단일 이동 근사(arc_fitting 기본 off), M204/커스텀 g-code 가속 미반영. 방향성·규모는 정확.
- **WipeTower 이식 시도 → config 서브시스템 관문 기록**(컴파일 프로브): `GCode/WipeTower.{cpp,hpp}`(4834+650줄)은
  ① `GCodeProcessor.hpp` include(위 config 플러드) ② 생성자 `WipeTower(const PrintConfig&)` 가 **config 78옵션** 직접
  참조(single_extruder_multi_material·wipe_tower_x/y·prime_tower_width·gcode_flavor·travel_speed·filament_change_length…)
  ③ `TriangleMesh.hpp→Format/STL.hpp`(타워메시 I/O, 미이식) ④ GCode.cpp `WipeTowerIntegration`(멀티머티리얼 tool-change
  오케스트레이션, Print 파이프라인 결합). → **이식 불가, 6단계 프라임타워(사각 링) 유지**. `wipe_tower_real` 미도입
  (게이트 대상 없음).
- **다음 대형 마일스톤 = config 서브시스템 이식**(정찰): full-GCodeProcessor·WipeTower·full-TreeSupport 셋 모두의
  **공통 키스톤 관문**이 실 `PrintConfig.hpp`(~3000줄 StaticPrintConfig 매크로 + 수백 옵션 + cereal + 열거형
  ExtruderType/NozzleVolumeType/BedType/BrimType…). full-TreeSupport 가 추가로 요구하는 Print/Layer 서브셋(정찰):
  Layer(`print_z`·`get_layer`·`height`·`lslices(_extrudable/_bboxes)`·`lower_layer`·`bounding_box`·sharp_tails/
  cantilevers 오버행필드), PrintObject(`layers()`·`layer_count()`·`config()`·`support_layers()`·`id`), SupportLayer
  (`support_fills`·`base/roof/floor_areas`·`area_groups`), 그리고 TreeSupportCommon 의 **config 84참조**. 헤더 규모
  Print.hpp 1376 + PrintBase.hpp 686 + Layer.hpp 354 = 2416줄 + config 서브시스템. **config 이식이 최고 레버리지**
  (한 번 뚫으면 3개 컴포넌트 동시 해금).

**11단계** (config 서브시스템 이식 — 10단계가 지목한 키스톤 관문 돌파 + WipeTower 실이식):
- **Config 코어 + PrintConfig 이식 성공** — `src/libslic3r/Config.cpp`(2122줄)·`PrintConfig.cpp`(12688줄)·
  `PrintConfig.hpp`(2429줄)·`MaterialType.cpp` 를 **원본 무수정**으로 `arachne_port/config/libslic3r/` 에 이식,
  emscripten 에서 **컴파일+링크+실행 성공**. WASM 안에서 전역 `print_config_def` 생성 + `FullPrintConfig`
  인스턴스화 동작. 격리: config 소스는 자기 디렉터리의 오버라이드 헤더(실 PrintConfig.hpp + 스텁)를 `""`
  상대 include 로, 기하는 `arachne_port/libslic3r`(실물) 로 폴백 → **메인 slicer_core.js 빌드는 stub
  PrintConfig.hpp 그대로 유지**(120 불변식 무회귀). 재현 `arachne_port/config_link_test.sh`.
  - **검증(embind, node)**: `print_config_def` **옵션 817개**(실측치 — 정규식 907 과 차이는 §config-schema 참조),
    `FullPrintConfig` **키 667개**. 스팟체크 전부 통과: `layer_height`=0.2, `seam_position`=aligned,
    `sparse_infill_pattern` enum 26개, `wall_loops`=2. 재현 `arachne_port/config_probe_build.sh` +
    `node arachne_port/config_probe_test.mjs`(→ CONFIG PROBE OK).
  - **스텁/치환(원본 알고리즘·정의 불변, 주변부만 — 각 파일 상단 주석에 사유 기록)**: `Preset.hpp`→빈 스텁
    +BBL_JSON_KEY_*·ORCA_JSON_KEY_* 매크로만(Config.cpp 는 Preset 심볼 미사용), `GCode/Thumbnails.hpp`→
    ThumbnailData/boost::beast 제거하고 `make_and_check_thumbnail_list`/`get_error_string`/ThumbnailError
    만 verbatim, `Utils.hpp`→config용 오버라이드(is_gcode_file/is_json_file verbatim + header_slic3r_generated
    스텁), `boost/thread.hpp`→빈 스텁(PrintConfig.cpp 가 include 하나 심볼 미사용, emscripten 은 -pthread 부재로
    실헤더 컴파일 불가), cereal 스텁 확장(`access.hpp` 에 `specialize`/`specialization` 추가 + 신규
    `types/polymorphic.hpp` 로 CEREAL_REGISTER_TYPE/RELATION no-op — serialize 는 WASM 에서 미호출). **소스
    무수정**(0곳 — 전부 include/스텁 경계로 해결). nlohmann/json 은 `deps_src` 존재, boost nowide/property_tree
    는 header-only(파일 I/O 경로는 WASM 에서 미도달).
- **스키마 크로스체크 = 빌드 기반 덤프 실현**(가이드 §11.1) — WASM 의 `print_config_def`→JSON 덤프
  함수(embind `dump_schema_json`) → node 로 `reverse_engineering/config-schema-builddump.json`(817개) 생성 →
  `reverse_engineering/compare_schema.mjs` 로 기존 정규식 `config-schema.json`(907)과 필드 대조. **결과**:
  공통 800개, **type 불일치 0**(정규식 타입 추출 정확), default 불일치 54개는 전부 표현차/추출아티팩트
  (bool `false`↔`"0"`, 문자열 C-이스케이프, per-extruder `coEnums` 빈벡터 default, nullable `nil`; 유일한
  실추출버그 `has_scarf_joint_seam` 를 빌드가 `0` 으로 교정), enum 불일치 2개(`filament_type` 는 빌드가
  이식된 `MaterialType::all()` 로 75종 정확 열거·정규식은 정적이라 0, `support_interface_bottom_layers`).
  onlyRegex 107개=별도 `CLIActionsConfigDef`/`CLITransformConfigDef`/`CLIMiscConfigDef`(cli_*_config_def
  전역)·placeholder-parser 런타임변수(정규식이 print_config_def 로 오분류), onlyBuild 17개=루프생성 `filament_*`
  리트랙션 오버라이드(정규식이 놓침). 산술 검산: 800+107=907(regex), 800+17=817(build).
- **WipeTower 실이식 성공**(10단계 관문 해소) — `GCode/WipeTower.{cpp,hpp}`(4834+650줄)을 **실 PrintConfig
  위에서 컴파일+링크+실행**. WipeTower 는 `config.<option>.value/.get_at()` 직접 멤버접근 → 실 StaticPrintConfig
  필요(config 키스톤이 바로 이걸 해금). GCodeProcessor.hpp 는 **경량 스텁**으로 축소(ETags·Reserved_Tags/
  _compatible 테이블·reserved_tag()·Nozzle_Change_*_Tag·s_IsBBLPrinter 만 verbatim — WipeTower 가 쓰는 전부),
  TriangleMesh/Triangulation 은 **메시경로 전용 스텁**(rib 타워/브림 메시 생성기 its_make_rib_*/Triangulation::
  triangulate 는 Print.cpp 만 호출·와이프타워 G-code 경로와 분리 → indexed_triangle_set 최소정의로 컴파일,
  실 rib 메시는 미생성). `ExtrusionEntity::role_to_string`·LocalesUtils `float_to_string_decimal_point` 는
  단일함수 추출/유니티 include 래퍼로 verbatim 제공(전체 TU 의 Flow::bridging_flow/PCH 의존 회피).
  - **검증(node)**: 2익스트루더 MM PrintConfig 구성 → `WipeTower` 생성(width=60, pos=15,15) → `set_extruder`×2
    + `plan_toolchange(0→1)` + `generate()` → **원본 툴체인지 마커 방출 확인**: `; CP TOOLCHANGE START`·
    `; toolchange #1`·`; material : PLA -> PLA`·`; WIPE_TOWER_START`·`; FEATURE: Prime tower`·
    `; LAYER_HEIGHT: 0.200000` + 실제 G1 압출(E값). 재현 `arachne_port/wipetower_probe.sh`(STEP1 컴파일→
    STEP2 링크+node 실행).
  - **남은 관문(정직 기록)**: 위는 **독립 검증**(실 WipeTower 가 실 PrintConfig 로 실 툴체인지 G-code 를
    낸다는 증명)이다. 커널 통합(`wipe_tower_real` 플래그로 6단계 사각링 프라임타워 대체)은 미완 — 커널
    slicer_core.cpp 는 plain 파라미터 구조체를 쓰므로, WipeTower 를 켜려면 **실 PrintConfig 서브시스템을
    메인 빌드에 병합**(현재 stub↔real PrintConfig.hpp 공존 불가)해야 하고 이는 120 불변식 회귀위험이 큰 별도
    마일스톤이다. rib 타워/브림 3D 메시(TriangleMesh)도 미생성(스텁).
- **동시 해금 확인**: 10단계가 "config 이식이 최고 레버리지(한 번 뚫으면 full-GCodeProcessor·WipeTower·
  full-TreeSupport 3개 동시 해금)"라 지목 → 그중 **WipeTower 가 실제로 해금됨을 실증**. full-GCodeProcessor·
  full-TreeSupport 도 동일 config 위에서 이제 이식 착수 가능(다음 단계).

**12단계** (실 config 를 본선 빌드에 병합 + WipeTower 커널 배선 + GCodeProcessor 게이트 실측):
- **실 config 서브시스템을 본선 slicer_core.js 에 병합** — 11단계의 독립 검증을 넘어 **메인 모듈이 실 config
  위에서 빌드·실행**. `config_bridge.{h,cpp}`(arachne_bridge 와 동일 격리 — 커널은 plain-type 헤더만 include,
  실 PrintConfig/Slic3r 타입은 .cpp 안에만)로 `Config.cpp`+`PrintConfig.cpp`+`MaterialType.cpp` 를 본선
  링크. **충돌 해소 방식: 공존**(stub 제거 대신 격리) — Arachne/Fill/PE 는 `../PrintConfig.hpp`(stub, InfillPattern
  등 enum verbatim 동일 → ODR 안전) 그대로, config TU 만 `""` 상대 include 로 실 PrintConfig.hpp 를 얻음.
  본선 어떤 컴파일 TU 도 boost/thread 를 include 안 함(실측) → config/stubs 의 boost/thread 빈 스텁 무해.
  embind `config_option_count()`/`config_option_default(key)` 로 노출(dead-strip 방지+검증).
  - **검증(node)**: `config_option_count()`=**817**(실 print_config_def 가 본선 모듈에 라이브), `layer_height`=0.2,
    `seam_position`=aligned. **`node test.mjs` 120 불변식 전부 통과**(기존 슬라이싱 경로·기본값 불변). 모듈 크기
    1.03MB→2.19MB(실 config+WipeTower 링크분).
- **`wipe_tower_real` 배선**(기본 false) — MM 경로의 레이어내 툴체인지에서 6단계 사각링 대신 **실 이식
  WipeTower.generate()** 출력 사용. `config_bridge::wipe_tower_block()` 이 실 PrintConfig 를 구성→WipeTower
  구동(set_extruder×2→plan_toolchange→generate)→툴체인지 블록을 베드좌표로 변환(툴타워 로컬→+타워위치,
  상대 E 유지→커널 M83 호환)→커널이 splice + type=11 툴패스 추가 + 필라멘트 누적. PlaceholderParser 토큰
  (`[filament_*_gcode]`)은 미니커널에 파서가 없어 주석 처리(문서화).
  - **검증(node)**: false(기본) → 기존 사각링 그대로(`; prime tower (basic`, WipeTower 마커 없음, type11 696세그).
    true → **원본 마커 `; CP TOOLCHANGE START`·`; WIPE_TOWER_START` + 툴체인지 E/F 시퀀스 존재**, type11 실
    프라임타워 6206세그, 타워 X10..40 Y10..29.5(베드 위, over_bed=false). 120 불변식 무회귀(기본 false).
  - **뷰어**: Slice 패널에 `실 와이프타워 (wipe_tower_real)` 토글 추가(MM 시 주입). 브라우저 스모크(cube T1+
    cylinder T2, 토글 ON) → 99레이어·9699세그 슬라이스 성공, 프라임타워 렌더, **콘솔 에러 0**(favicon 404 제외).
    스크린샷 `wasm-core/screenshots/stage12_wipe_tower_real.png`.
- **풀 GCodeProcessor 재시도 → config 게이트 해소 확인 + 잔여 게이트 실측 기록**(본체 미완, 파일·심볼 단위):
  10단계가 지목한 관문(`calib.hpp`→실 PrintConfig)은 **12단계 config 병합으로 해소**. 남은 이식 대상(컴파일
  프로브 실측): ① 미이식 .cpp 3종 — `GCodeReader.cpp`(358L)·`CustomGCode.cpp`(76L)·`MultiNozzleUtils.cpp`(970L),
  ② `Geometry/ArcWelder.{cpp,hpp}`, ③ 스텁 — `boost::nowide`(파일 I/O 7곳)·`boost::filesystem/path`,
  `Print.hpp`(단 2심볼: `m_print->print_statistics().total_wipe_tower_filament`@1050 + `active_step_add_warning`
  @1371 — 풀 파이프라인 불필요, 최소 Print 스텁으로 회피 가능), ④ ExtrusionEntity.hpp 전이트리(deps_src/semver
  필요). 규모 7561L 단일 TU·다중 컴파일 웨이브 → 잔여 예산 내 무결 완주 불가로 판단, **게이트 기록으로 대체**
  (성공 시 시간추정을 `gcode_time` 전사본에서 원본 본체로 승격 예정 — 전사본은 `time_engine=transcribed` 로 보존).
- **(스트레치) 커널이 실 DynamicPrintConfig 키 직접 수신** — 명시적 "여유 시" 항목, 12단계 예산은 item 1-3 에
  집중되어 **미착수**. 현행 settings.js 스키마키→커널파라미터 매핑 유지(하위호환).

**13단계** (마지막 이식 라운드 — 풀 GCodeProcessor 완주 + TreeSupport 최종 게이트):
- **풀 GCodeProcessor 본체 이식 성공** — `GCode/GCodeProcessor.cpp`(7561줄) + `GCodeReader.cpp`(358)·
  `MultiNozzleUtils.cpp`(970)·`Geometry/ArcWelder.{cpp,hpp}`·`ElegooGCodeProcessorHelper.cpp`(190, process_elegoo_M6211)
  을 원본 무수정으로 이식, WASM **컴파일+링크+실행 성공**. 12단계 config 병합으로 관문(calib.hpp→실 PrintConfig)이
  해소돼 실현. `gcodeproc_bridge.{h,cpp}` 가 커널↔GCodeProcessor 경계(apply_config→process_buffer→finalize→
  GCodeProcessorResult 추출). **시간추정 엔진 승격**: `time_engine` 파라미터 — `full`(신규 기본)=실 GCodeProcessor
  본체, `transcribed`=10단계 `gcode_time` 전사본 보존.
  - **스텁/치환(원본 무수정, 각 상단 주석)**: `Print.hpp`→2심볼 스텁(print_statistics().total_wipe_tower_filament +
    active_step_add_warning; GCodeProcessor 는 PrintObject 미결합) + 전이 include(unordered_set/map·BoundingBox·
    EnforcerBlockerType enum verbatim·get_hrc_by_nozzle_type), `boost::nowide`→std 별칭·`boost::filesystem/path`→
    빈 스텁(파일 I/O 미도달), `Utils.hpp`→단일 canonical 로 통합(FilePtr/get_time_dhms/short_time/format_diameter_to_str/
    rename_file/is_gcode_file verbatim; config override 는 forwarder), `GCodeWriter`→set_temperature/
    supports_separate_travel_acceleration 2정적함수 verbatim 추가, `PrintStatistics` 마스크 6개 verbatim, `ExtrusionEntity::
    string_to_role` 단일함수 추출, `ProjectTask.hpp`→FilamentInfo 만(boost::filesystem 회피). **PrintConfig 통일**:
    stub PrintConfig.hpp → 실 헤더 forwarder(calib/MultiNozzle 가 same-dir stub↔real 충돌 → 코디네이터 승인
    "include 경로 통일"; 본선 재빌드 120 그린 확인).
  - **검증(node, 120 불변식 전부 통과 — 신규 엔진 위에서)**: ① 파싱+총시간>0(cube 808.2s) ② faster→less(30mm/s
    946s > 120mm/s 766s) ③ **전사본 대비 편차 8.5%**(full 1406.6s vs transcribed 1296.6s — full 이 원본 정답 기준;
    사다리꼴 플래너 accel/jerk/lookahead 차이) ④ **필라멘트 vs 커널 ±2%**(570.8 vs 570.8, 0.00% — 브릿지가 상대
    E 직접 파싱; GCodeProcessor 의 move 합은 actual-speed 렌더 서브무브 삽입으로 팽창, 체적 합은 기하 width/height
    기반이라 실 E 와 불일치 → 직접 파싱으로 E 무결성 검증) ⑤ 레이어별 시간(position.z 그룹핑, 51/101층). 기본값
    변화(full)에도 기존 stage-10 불변식 7개가 전부 신규 엔진에서 통과 → 재기준 불필요.
  - **간극(정직)**: role별 시간은 pe_lite=false(태그 모드)에서만 세분(기본은 role 0=erNone 집계); 레이어 검출은
    커널이 CHANGE_LAYER 예약태그 대신 "; LAYER" 를 방출해 position.z 로 그룹핑(브릿지); actual-speed 렌더 서브무브
    때문에 move 단위 필라멘트/시간 직접합은 부정확(총량은 modes[Normal].time 권위값 사용).
- **풀 TreeSupport 최종 시도 → 구조적 게이트 최종 기록**(config 게이트는 12단계에서 해소, 그러나 구조 게이트 잔존):
  - **부분 성공(유지)**: MST branch 배치 코어(`MinimumSpanningTree`)는 9단계에서 이식·구동(tree_bridge: 9점→8엣지
    비순환·74.06mm). 이것이 코디네이터 "부분 허용" 의 branch 배치 경로.
  - **최종 게이트(파일·심볼 단위)**: `Support/TreeSupport.cpp`(3786)+`TreeSupport3D.cpp`(4198)+`TreeModelVolumes.cpp`
    (886)+`SupportCommon.cpp`(2033)는 **PrintObject/Layer/SupportLayer 객체그래프**에 근본 결합 — config 아님:
    TreeSupport.cpp 실측 **`m_object->` 121회·`lower_layer` 52·`lslices` 39·`SupportLayer` 36**(PrintObject 주도
    알고리즘이 레이어별 실 슬라이스 지오메트리 위에서 동작). `TreeModelVolumes`(avoidance)조차 생성자가
    `(const PrintObject&, const BuildVolume&)` 요구 + tbb:: 44회. 추가 비-config 의존: **tbb concurrent 컨테이너**
    (concurrent_vector/unordered_set, brew 부재→순차 스텁 필요), **libnest2d**(arrangement, deps_src). → 이식하려면
    **슬라이싱 파이프라인의 객체모델(PrintObject/Layer/SupportLayer + 레이어별 lslices/lower_layer 실 슬라이스
    상태 + BuildVolume)을 재구성**하고 커널 슬라이스 지오메트리를 주입해야 함 = 스텁 계층을 넘는 파이프라인
    재구현. 실 서포트는 tree_lite(5단계 형태학적 테이퍼) 유지. **이것이 full 포팅 로드맵의 마지막 장이다.**
- **(스트레치) 커널이 실 DynamicPrintConfig 키 직접 수용** — 12단계 이월분, 13단계 예산은 item 1-2 집중되어 미착수.

**14단계** (영구 예외 최소화 — 미시도 공격로 2건):
- **CGAL 평면성 검사 실이식 성공**(예외 제거) — CGAL 6.2 는 header-only 이고 GMP/MPFR 없이 Boost.Multiprecision
  백엔드로 동작함을 활용. `brew install cgal`(헤더만) → 7단계 스텁이던 `VoronoiUtilsCgal.cpp`(원본)를 복구·
  본선 링크. `is_voronoi_diagram_planar_angle`(Voronoi.cpp 실제 복구경로)가 진짜로 실행. **검증**: 120 무회귀
  (arachne 벽 0.42 균일·가변폭 불변), `cgal_planar_check_count` embind 노출 → arachne 큐브 슬라이스 후 99회 호출
  (레이어당 1회)로 실제 호출 실증. **스텁/치환(기록)**: ① `arachne_port/cgal_stubs/boost/config/platform/wasm.hpp`
  = boost 원본에서 `#define BOOST_NO_FENV_H` 만 제거(emscripten 은 fenv.h 제공 → Boost.Interval c99 rounding 경로
  활성) ② `-DCGAL_DISABLE_ROUNDING_MATH_CHECK`(wasm 은 FP 라운딩모드 제어 불가 → CGAL interval 시동 자가진단
  abort 회피). ⚠ **정직한 한계**: wasm 라운딩 부재로 interval 필터가 배정밀도(비보수적) → 근접-0 케이스는 exact
  MP_Float 폴백(정확), 극히 드문 준퇴화 케이스만 오판 가능. 데스크톱 exact 보장은 아니나 "항상 평면" 스텁 대비
  실검사. 재현 `arachne_port/cgal_probe.sh`.
- **풀 TreeSupport 어댑터 — 파운데이션 컴파일 성공, 최종 게이트 심화 기록**: 13단계 "PrintObject 객체그래프
  결합"을 어댑터로 재접근. **성과**: 어댑터 파운데이션(`Layer.hpp`/`SupportLayer`/`LayerRegion`)이 이식된
  deps + `FlowRole`(Flow 스텁에 enum 추가)로 **컴파일 성공**(재현 `arachne_port/layer_probe.sh`) — 13단계보다
  두 계층 깊음. `SupportCommon.hpp` 는 경량(libslic3r+Polygon). **잔여 게이트(구체·최종)**: ① `Print.hpp`
  PrintObject 파사드 — 19개 메서드 중 **메시 연산**(`slice_support_enforcers/blockers`·`project_and_append_custom_facets`·
  `remove_bridges_from_contacts`)이 모델 3D 메시 + 서포트 페인팅을 요구(커널엔 2D lslices 만 있음 → 스텁 가능하나
  수동 서포트 페인팅 상실) ② `TreeSupport3D.cpp`(4198L, 실제 오가닉 생성 — TreeSupport.cpp 가 `generate_tree_support_3D`
  로 위임)+`TreeModelVolumes.cpp`(886L, avoidance — 생성자가 `PrintObject&`+`BuildVolume&` 요구)+`SupportCommon.cpp`
  (2033L) ③ tbb concurrent 컨테이너→순차 치환 ④ libnest2d→스텁. **결론**: 단일 하드 블로커가 아니라 ~7000줄 서포트
  본체 + 파사드 + tbb/libnest2d 의 **물량**이 관문 — 어댑터는 원리상 가능(파운데이션 실증)하나 잔여 예산 내 무결
  완주 불가. 실 서포트는 tree_lite 유지. "어댑터로도 잔여 예산 내 안 되는 이유"가 이 게이트의 최종 문서다.

**15단계** (마지막 예외 = 풀 TreeSupport 어댑터 이식 시도 → 최종장 관문 기록):
- **구축 완료(인프라)**: ① `Print.hpp` **파사드**(PrintObject 19메서드 + Print + ModelObject + PrintRegion +
  PrintInstances; 메시연산 3종 = 문서화된 빈 스텁 — 커널엔 3D 모델메시·서포트페인팅 데이터 없음) →
  `arachne_port/treesupport_inc/libslic3r/Print.hpp` 로 보존 ② **tbb concurrent→순차 스텁** 일체(blocked_range·
  parallel_for/_each·concurrent_vector/_unordered_set·spin_mutex·task_group·task_arena·enumerable_thread_specific
  + oneapi/tbb 포워더) → `arachne_port/treesupport_stubs/` ③ `Format/STL.hpp` 복사(실 TriangleMesh.hpp 해소)
  ④ 실 `Flow.hpp`(treesupport_inc 보존) ⑤ 4개 본체 .cpp + 7개 tree 헤더 → `arachne_port/libslic3r/Support/`
  ⑥ 프로브 `treesupport_probe.sh`·`layer_probe.sh`·`print_probe.sh`.
- **OpenVDB 회피 확인**: `TREE_SUPPORT_ORGANIC_NUDGE_NEW 1` 이 TreeSupport3D.cpp:44 자체에 정의됨 → OpenVDB
  `organic_smooth_branches` 변형은 죽은 코드, 신형 AABB-트리 nudge(실물, OpenVDB 링크 불요) 사용. **OpenVDB 예외 소멸.**
- **컴파일 진행(SupportCommon.cpp — 베이스 파일, 웨이브별)**: `Format/STL` 누락→복사 → `oneapi/tbb/*`→포워더 →
  `SupportParameters.hpp` 가 실 Flow(bridging_flow/with_flow_ratio/scaled_spacing/nozzle_diameter/support_material_flow
  자유함수) + **PrintRegion 파사드**(config()→PrintRegionConfig + flow(PrintObject,FlowRole,height)→Flow) +
  PrintObject::num_printing_regions/printing_region/object_extruders 요구.
- **최종 관문(구체·심볼)**: `SupportParameters.hpp`(config파생 per-region flow 파라미터) — 실 Flow+파사드 이후
  도달, **PrintRegion 파사드의 per-region flow 계산**을 PrintObject 파사드에 배선해야 함. 이것이 첫 본체파일(베이스)의
  첫 헤더 내부 지점.
- **잔여 규모**: SupportCommon(2033)+TreeModelVolumes(886)+TreeSupport3D(4198)+TreeSupport(3786)=**10903줄** 다수
  컴파일 웨이브 + PrintRegion 파사드 완성 + libnest2d EdgeCache 스텁 + 커널 통합(어댑터가 커널 lslices 로 Layer/
  SupportLayer 그래프 채움→오버행/오가닉→type5 툴패스) + 검증.
- **핵심 구조 통찰(격리 충돌)**: tree .cpp 는 `"../Flow.hpp"`/`"../Print.hpp"`(부모상대) include 사용 → **공유
  arachne_port/libslic3r 헤더로 해소**됨. 따라서 treesupport 의 실-Flow+파사드-Print 오버라이드를 `-I` 만으로 본선
  빌드에서 격리 불가(상대 include 는 -I 무시). 완주하려면 ⓐ 공유헤더 in-place 스왑(본선 stub-Flow 기대 파괴→120
  회귀 위험) 또는 ⓑ 헤더트리 전체 복제(격리 dir) 필요. 파운데이션(Layer.hpp 컴파일·파사드 구축)까지 왔으나 이
  격리충돌 + 10903줄 볼륨이 본선 무회귀 유지하며 예산 내 완주를 막음. **본선 무회귀 위해 공유 Flow.hpp/Print.hpp 는
  14단계 상태로 복원(120 그린 재확인).** 실 서포트는 tree_lite 유지. **예외 1건(풀 TreeSupport) 최대 심도로 문서화.**

**16단계** (15단계가 기록한 근본 해법 실행 → 풀 오가닉 TreeSupport **컴파일+링크+실행+실 툴패스 생성 성공**, standalone):
- **격리 충돌 해소(15단계 ⓑ 실행)**: 전 libslic3r 헤더트리를 `treesupport_port/` 로 복제(cp -R) → tree .cpp 의
  `"../Flow.hpp"`/`"../Print.hpp"`(부모상대) include 가 **포트-로컬 실-Flow + 파사드-Print** 로 해소. `-I` 무시하는
  상대 include 문제(15단계 관문) 완전 소멸. **본선 arachne_port 공유헤더·build.sh 무수정(무접촉)**, 전 작업 격리 dir 내.
- **컴파일 웨이브 완주**: SupportCommon(2033)+TreeModelVolumes(886)+TreeSupport3D(4198)+TreeSupport(3786)=**10903줄**
  4개 본체 전부 컴파일. PrintObject/Print/PrintRegion/ModelObject **파사드 완성**(per-region flow=실 PrintRegion.cpp:25
  전사, `shared_regions()→all_regions`(FillLightning), `support_fills` 메트릭).
- **링크 완주(실 deps)**: TriangleMesh(+`libqhullcpp` **인라인 헤더온리 스텁** — its_convex_hull_3d 는 tree 경로 미도달)·
  TriangleMeshSlicer·Geometry(ConvexHull/Circle/Voronoi/VoronoiUtils + **실 CGAL `VoronoiUtilsCgal`** = 14단계 cgal_stubs
  재사용, `-DCGAL_DISABLE_ROUNDING_MATH_CHECK`)·Fill/Lightning/*·**풀 Arachne**(WallToolPaths+SkeletalTrapezoidation+
  BeadingStrategy)·Fill 패턴(+`FillSupportBase`/`FillRectilinear` new_from_type 케이스 복구).
- **스텁/어댑터(전부 `treesupport_port/` 내·문서화)**: `GCode/GCodeProcessor.hpp`(BuildVolume::all_paths_inside 만 참조,
  tree 미사용 → 최소 GCodeProcessorResult)·`CutUtils.hpp`(TriangleMesh.cpp 의 사문화 include → 빈 스텁, Model.hpp 그래프
  차단)·`Semver.hpp`(boost-free — em++ 대용량TU 서 boost/optional FS 플레이크 제거, tree 링크셋 미사용)·`boost/thread/
  {mutex,lock_guard}`(→std, 단일스레드)·`tbb/blocked_range2d`·`libslic3r.h` 의 `boost/format` 우산·`Point/SupportLayer.hpp`
  인라인 `scalable_allocator` 별칭(deep-path FS 플레이크 제거)·`SVG.hpp` clipper include 복구(TreeNode.cpp 의 ClipperLib 경로).
- **어댑터 드라이버**(`test_treesupport.cpp`): 오버행 모델(다리 10×10 ×20층 + 상판 30×30 ×10층) → `TreeSupport::generate()`
  (`smsTreeOrganic`+`stTreeAuto`) → `generate_tree_support_3D` → **서포트레이어 20 · 실 압출 툴패스(type5) 123개**
  (`SupportLayer::support_fills`). 런타임 배선: `print.m_objects` 등록·`stTreeAuto`(support_auto)·`throw_on_cancel` no-op·
  `FillSupportBase/Rectilinear`·`-DNDEBUG`(Release 패리티 — 엄격 기하 assert 는 프로덕션서 컴파일아웃).
- **검증**: **PASS**(20층/123툴패스) + **결정론**(2회 실행 동일) + **120 무회귀**(`node test.mjs` ALL PASSED — 본선
  build.sh 는 treesupport_port 무참조, 공유소스 무수정). 재현 `arachne_port/treesupport_link_test.sh`.
- **잔여(별도 웨이브)**: 커널 본선 통합 = `treesupport_bridge.cpp`(커널 lslices↔TreeSupport 경계, arachne_bridge 패턴) +
  build.sh 병합 + slicer_core 배선(`support_style=tree` 시 실 오가닉 → slicer_core.js). 격리 성공으로 **잠금해제**됐으나
  ODR 경계(treesupport_port 자체 PrintConfig/Flow 판 vs 본선 arachne_port 판) 설계가 필요 — 15단계가 경고한 오염 위험
  지점이므로 브리지로 격리 후 통합. 브라우저 스모크+스크린샷은 이 통합 이후.

**17단계** (본선 통합 시도 → ODR 경계 벽 도달, 충돌 실측·해법 기록 후 16단계 standalone 을 최종 상태로 마감):
- **완성한 것**: ① `treesupport_bridge.{h,cpp}`(arachne_bridge 패턴 — 커널엔 plain 타입만 노출, 포트 타입은
  `treesupport_port/libslic3r/treesupport_bridge_impl.cpp` 에 격리; 파일-상대 include 로 파사드 해소). 커널
  lslices(mm)→파사드 PrintObject 그래프→`TreeSupport::generate()`→`SupportLayer::support_fills`→plain 폴리라인.
  ② slicer_core 배선(`support_style=tree` 분기, `L[].supTree` type5 방출; tree_lite/grid 보존). ③ build.sh 2단계
  빌드(트리 고유 소스 릴로케이터블 격리 컴파일 → 본선 링크 합류).
- **공유-심볼 방식 ODR 실측**: 트리 고유 소스만 본선과 별도 컴파일, 공유 심볼은 본선 링크. 헤더 ABI 동일 실측
  (PrintConfig.hpp/Polygon.hpp identical, Point.hpp 은 scalable_allocator 별칭만 다르고 둘 다 std::allocator).
  **충돌 심볼 2개** = `ExtrusionEntity::role_to_string`/`string_to_role`(본선이 role_to_string.cpp+extrusion_role_helper.cpp
  단일함수 추출로 이미 제공) → 포트 사본서 `-DTS_BRIDGE_EXCLUDE_ROLE_FNS` 로 가드. **결과: ODR-clean 링크 성공 +
  `node test.mjs` 120 그린**(slicer_core.js 2.49MB→3.27MB).
- **런타임 벽(근본 원인)**: `support_style=tree` 슬라이스 시 크래시. 원인 = 본선의 이식 소스는 **커널용으로 트리밍**돼
  있다(예: `arachne_port/.../Fill/FillBase.cpp` 의 `Fill::new_from_type` 가 STAGE-8 트림으로 `ipSupportBase`/
  `ipRectilinear` 에 **nullptr** 반환; `fill_surface`/gap-fill 도 스텁). 공유 링크면 트리 파이프라인이 이 트림 동작을
  물려받아 null filler 역참조 → "null function/signature mismatch". 즉 **공유 = 트림 오염**.
- **완전 격리 시도 → 툴체인 벽**: 트리 그룹을 자체 완전판 전 소스로 자립 컴파일(`-fvisibility=hidden`) 후 브릿지
  진입점 외 전 심볼 LOCAL 강등 시도. 그러나 **emscripten wasm 툴체인이 심볼 로컬화를 미지원**: `llvm-objcopy` 는
  wasm 서 "only flags for section dumping, removal, and addition"(심볼 연산 불가), `wasm-ld` 는 `--version-script`/
  `--localize` 없음, `-fvisibility=hidden` 은 가시성만 바꿀 뿐 STB_GLOBAL 바인딩은 유지 → 중복정의 링크에러. 완전
  격리 co-link 불가.
- **잔여(후속 웨이브, 택일)**: (a) 본선 `FillBase.cpp` new_from_type 을 **가산적 언트리밍**(ipSupportBase/Rectilinear
  케이스 추가 — 커널은 이 팩토리 미사용이라 120 무영향, 단 본선 소스 변경) + FillRectilinear/FillSupportBase 링크,
  또는 (b) 트리 그룹 **로컬 Fill 팩토리 리다이렉트**(`ts_new_from_type` 정의 + SupportCommon.cpp/TreeSupport.cpp
  호출부 ~10곳 수정 — 포트 원본 수정, standalone 유지 위해 양쪽 컴파일 필요), 또는 (c) **SIDE_MODULE** 동적링크
  (SINGLE_FILE 로딩 모델 재설계). 각각 트레이드오프 존재 → 코디네이터 판단 필요.
- **마감 상태**: 본선 120 그린을 깨지 않기 위해 통합 배선은 **롤백**(slicer_core.js 2.49MB 원복, `node test.mjs` ALL
  PASSED 재확인). 브릿지 아티팩트(`treesupport_bridge.{h,cpp}`, `ts_verify.mjs`)는 후속 웨이브용으로 보존. **실 오가닉
  TreeSupport 의 검증된 최종 상태 = 16단계 standalone**(`arachne_port/treesupport_link_test.sh`: 20층/123 type5 툴패스,
  결정론). 뷰어 기본 서포트는 tree_lite 유지.

**18단계** (옵션 (a) 승인 — FillBase 팩토리 가산 언트림 → 실 오가닉 TreeSupport **본선 통합 완료**, 예외 0 결산):
- **가산 언트림(골든 가드)**: `arachne_port/.../Fill/FillBase.cpp::new_from_type` 에 STAGE-8 트림으로 빠졌던
  `ipSupportBase→FillSupportBase`/`ipRectilinear→FillRectilinear` 케이스를 **원본 상태로 복원**(STAGE-18 UNTRIM 주석),
  `FillRectilinear.cpp` 를 본선 FILL_SRC 에 추가. **골든 byte-diff 0 실증**: 큐브·오버행 테이블(기본 + grid-support)
  G-code 가 언트림 전후 **완전 동일**(523951B) → 커널 기본 경로가 이 팩토리 케이스를 안 부른다는 물증(`golden.mjs`).
- **통합 재적용(shared-symbol)**: 트리 고유 소스만 격리 릴로케이터블 오브젝트로 컴파일(role_fns 가드, FillRectilinear
  는 본선 제공이라 트리 그룹서 제외) → 본선 링크 합류. slicer_core.cpp 배선(`support_style=tree` → 브릿지 → `L[].supTree`
  type5 방출; grid/tree_lite 보존). **ODR-clean 링크 + 트리 경로 실 필러 수령 → 17단계 null deref 해소**(트림 캐스케이드
  없음 — fill_surface 는 실 FillRectilinear/SupportBase override 로 해소).
- **검증 풀세트 통과**: ① `support_style=tree` 오버행 테이블 → **type5 8662개**(tree_lite 511 대비) ② tree vs tree_lite
  **층별 분포 상이**(오가닉 브랜치) ③ **결정론**(2회 G-code 동일) ④ **120 무회귀 + 골든 byte-diff 0** ⑤ **브라우저**
  (vite preview): 오버행 테이블 슬라이스 → **오가닉 트리 서포트 렌더**(69층·11208세그, 서포트 브랜치 가시 —
  `wasm-core/stage18_tree_support.png`), **기능 콘솔 에러 0**(favicon.ico 404 만, 슬라이싱/WASM 무관). 재현
  `wasm-core/ts_verify.mjs`(standalone-스타일)·`golden.mjs`·뷰어 `npm run build && npm run preview`.
- **뷰어 매핑**: `viewer/src/settings.js` — organic/tree 계열 → 커널 `'tree'`(실 오가닉), 그 외 grid.
- **결산: 실 오가닉 TreeSupport 예외 소멸.** 커널이 `support_style=tree`(organic/tree_slim/strong/hybrid) 시 실
  `generate_tree_support_3D` 브랜치 툴패스(type5)를 slicer_core.js 로 방출. 기본값(grid) 및 tree_lite 보존.

**19단계** (남은 정밀도 캐비어트 각개 격파 — 우선순위 사다리 4건):
- **① 서포트 압출폭 per-path 전달**: 브릿지가 `ExtrusionPath::width` 를 폴리라인과 함께 전달, 커널이 `emit_lines_vw`
  로 path 마다 `set_e_per_mm_width`(E 계산)+`g_seg_w_cur`(리본 폭) 적용. 검산: `support_line_width` config 를
  0.4(기본)↔0.6 으로 바꾸면 방출 서포트 폭이 정확히 추종(0.4→0.6) → per-path 폭이 E·widths[] 에 반영됨을 실증.
  (주: 이 포트의 `support_material_flow`/`interface_flow` 는 폭 키를 공유 → 인터페이스=본체 폭이 동일한 포트 모델
  사실이며 배선 결함 아님.)
- **② 서포트 z 정합**: 원인 = 브릿지가 `slicing_params.first_object_layer_height` 미설정(→0)이라 `layer_z()` 가
  서포트 z 를 `idx*lh`(오브젝트는 `(idx+1)*lh`)로 계산해 1층(0.2mm) 어긋남. `first_object_layer_height=lh` 설정으로
  서포트 z 를 오브젝트 z 그리드에 동기(데스크톱 independent_support_layer_height=off 와 동등). 검산: G-code
  `; tree_support ... z_resid_max` 진단 = **0mm**(이전 0.2mm).
- **③ CGAL 평면성 정밀 술어 승격**: wasm 방향 라운딩 부재로 인터벌 필터(FK=`Interval_nt_advanced`)가 부정확할
  위험 → `VoronoiUtilsCgal.cpp`(본선 `arachne_port` + 포트 사본)의 `Filtered_predicate` 필터 스테이지를 exact
  술어(EK=`Simple_cartesian<MP_Float>`, C2E)로 치환(인터벌 건너뜀, 항상 정확). 검산: 120(Arachne 포함) 무회귀 +
  golden byte-diff 0(단순 형상은 exact==interval) + 검사 카운터 유지(`cgal_planar_check_count`=792 불변) + perf
  큐브 슬라이스 18.6ms→17.5ms(회귀 없음, <2x). 검사 레이어당 1회라 비용 허용.
- **④ 수동 서포트 페인팅 — TriangleSelector 이식+링크 완료(이번 라운드 목표)**: 실 `TriangleSelector.{cpp,hpp}`
  (2527L) 이식. `Model.hpp` 는 사문화 include(EnforcerBlockerType 은 .hpp 자체 정의, Model 심볼 미사용)→제거,
  `Geometry.hpp` 만 직접 include. 스탠드얼론 링크+실행(`arachne_port/selector_link_test.sh`): 큐브 상면에 Sphere
  커서로 ENFORCER 패치 페인트 → `get_facets(ENFORCER)`=4016 facets(삼각형 분할), blocker=0, **PASS**. **잔여 규모
  실측(후속)**: (뷰어) three.js Raycaster 로 삼각형/히트포인트 선택 → 브러시 반경/enforcer·blocker 토글 UI +
  selector_bridge(paint/get_facets em::binding); (파사드) `slice_support_enforcers/blockers` 스텁을 enforcer/blocker
  its 를 층별 z 로 `slice_mesh` 투영하는 실구현으로 교체(제일 큰 조각) → TreeSupport3D `generate_overhangs` 가
  이미 소비. 규모: 뷰어 브러시 中 + 브릿지 小 + 파사드 투영 中. 커널 배선은 다음 웨이브 판단.
- **검증**: 120 무회귀 + **golden byte-diff 0** + tree(width/z) 검산 통과 + 브라우저 오가닉 트리 렌더
  (`wasm-core/stage19_tree_support.png`, 69층·11127세그, 콘솔 기능에러 0). 재현 `wasm-core/ts_verify.mjs`·
  `golden.mjs`·`perf.mjs`·`arachne_port/selector_link_test.sh`.

**20단계** (마지막 캐비어트 — 수동 서포트 페인팅 조립 → 4캐비어트 완결, "동등 + 문서화된 잔여 0"):
- **① selector_bridge** (`selector_bridge.{h,cpp}` + `treesupport_port/libslic3r/selector_bridge_impl.cpp`):
  embind `selector_prepare/paint/clear/facet_count/painted_count/overlay`. 상태(칠한 facet)는 worker Module 에
  지속(슬라이스도 같은 Module). 커널 `selector_prepare` 는 slice 와 동일 변환(XY 중심·minZ=0)+**용접**(정확 tuple
  키 — XOR 해시는 충돌로 토폴로지 파괴, 실측 후 수정)으로 메시 구성 → 뷰어 raycast faceIndex == selector facet.
- **② 뷰어 브러시 UI** (`Viewport.jsx` + `slicer.worker.js`): "수동 서포트 페인팅" 토글(enforcer/blocker + 브러시
  반경 슬라이더 + 지우기), 모델 위 드래그로 SPHERE 커서 페인트(raycast faceIndex+히트점 → viewer(Y-up)→STL→kernel
  변환 → worker), enforcer=파랑/blocker=빨강 반투명 오버레이 렌더.
- **③ 파사드 배선**: `slice_support_enforcers/blockers` 스텁 → 칠한 enforcer/blocker its 를 층별 z 로 투영
  (`custom_facet_project.hpp`: 삼각형 XY footprint, double cross 로 방향 판정 — 대형 facet 의 coord_t area 오버플로
  회피). `slice_mesh_slabs` 는 고립 패치에 빈결과라 대체. → `generate_overhangs` 가 소비(tree) + grid 경로도 반영
  (enforcer=오버행 추가, blocker=오버행 차감).
- **④ grid 반영**: grid/tree_lite 경로도 동일 footprint 로 enforcer/blocker 적용.
- **물리 검증(PASS)**: `wasm-core/test_paint.mjs` — **tree**: enforcer(수동 모드) 0→10496, blocker 8581→44(억제,
  나머지 유지); **grid**: enforcer 0→612, blocker 558→508; 양쪽 결정론(2회 동일 g-code). 커널에 `support_auto`
  플래그 추가(false=수동, 페인트 enforcer 만) — enforcer 물리검증용(상류 tree enforcer 는 실 오버행 영역만 강제).
- **브라우저(vite preview)**: 오버행 테이블 로드 → blocker 페인트(캡 하면, 5783 facets, 빨강 오버레이 —
  `wasm-core/stage20_paint_blocker.png`) → 슬라이스 시 칠한 반쪽 서포트 억제·나머지 유지(9880→7615세그,
  `wasm-core/stage20_blocker_result.png`), 콘솔 기능에러 0(favicon 404 만). 인터랙티브 브러시·오버레이·worker
  파이프라인 동작 실증(effect 스크린샷은 selector_paint API 를 컨트롤드 좌표로 구동 — 브러시와 동일 경로).
- **결산**: **4캐비어트(폭/z/CGAL/페인팅) 전부 완결.** 기본 경로 golden byte-diff 0 · 120 무회귀 유지(페인팅
  미사용 시 완전 불변). 재현 `wasm-core/test_paint.mjs`·`arachne_port/selector_link_test.sh`.

**21단계** (사용자 버그리포트 "렌더링에 굵기 정보 반영 안 됨" → 피처별 폭 매핑 갭 수정):
- **근본 원인(코디네이터 진단)**: settings.js 가 `line_width` 단일 키만 매핑 → 패널의 피처별 폭(outer_wall/
  inner_wall/top_surface/sparse_infill/internal_solid_infill/initial_layer)이 커널에 미전달 → 리본 균일. 추가로
  MM 경로·래프트 export 에 widths[] 누락 → 그 경로 균일 폴백.
- **① 피처별 폭 파라미터**: 커널 Params 에 6개 폭 추가 + settings.js 매핑(원본 문자열 "120%" 그대로 전달).
- **② 0=자동유도**: 원본 `Flow::auto_extrusion_width`(src/libslic3r/Flow.cpp:21) 산식 인용 — top-surface/support
  = nozzle, 그 외 = 1.125*nozzle. 해석 순서: 값>0 → 그대로 · 0 → line_width(>0) · line_width 도 0 → auto.
  coFloatOrPercent "120%" → nozzle*1.2(ratio_over 시맨틱). **기본동작 불변**: 뷰어는 line_width=0.42 전송 →
  피처 0 → 0.42(auto 산식 미발동) → golden byte-diff 0(재베이스라인 불요).
- **③ 방출 배선**: 각 피처 방출 시 `set_e_per_mm_width`(E) + `g_seg_w_cur`(리본) 동시 설정(19단계 서포트 폭과
  동일 패턴). 외벽=outer_wall, 내벽=inner_wall, solid=internal_solid, top-surface 는 solid 에서 분리(폭 다를 때만
  → 무회귀), sparse=sparse_infill, 첫 레이어는 initial_layer 우선. arachne 벽은 자체 가변폭 유지.
- **④ widths export 누락 보완**: 멀티머티리얼 경로(slice_multimaterial)·래프트 행에 widths[] 추가.
- **검증(PASS)**: `wasm-core/test_width.mjs` — 외벽 0.6/내벽 0.42 → widths[] 에 0.6·0.42 공존 + 필라멘트
  1169.7→1284.6mm(E 반영); top_surface 0.6 반영; line_width:0 → auto 0.45(1.125*0.4); "150%"→0.6; MM widths[]
  존재. **120 무회귀 + golden byte-diff 0**. 브라우저: 외벽 0.6 설정 슬라이스 → 리본 줌인서 외벽이 굵게
  (`wasm-core/stage21_width_ribbon.png`), 콘솔 기능에러 0. 19/20단계(tree/paint) 무회귀 재확인.

**22단계** (사용자 버그리포트 "대형 모델서 실폭 렌더 안 됨 → 라인 폴백" + "굵기를 **오브젝트 형태로**" →
볼류메트릭 툴패스 격상 + 상한 재산정. **렌더 전용 — 커널 무변경**):
- **근본 원인**: 21단계까지의 리본은 (a) 윗면+양측면만의 **열린** 반쪽 리본이라 입체감이 없었고, (b)
  `MAX_RIBBON_SEG=10만` 자동 폴백이 과보수적이라 177k급 실사용 모델(199레이어·17.7만 세그먼트)에서 실폭 렌더가
  죽고 "라인 모드 폴백" 경고가 떴다.
- **① 볼류메트릭 비드**(`Viewport.jsx buildLayerRibbon`): 각 압출 세그먼트를 폭 w×높이 h 의 **닫힌 사각기둥**
  (윗·아랫·양측 4면×2삼각형=24정점)으로. 끝단 w/2 연장으로 인접 비드가 겹쳐 방향전환 갭을 가림(끝뚜껑 생략 —
  정점 예산 유지, 과공학 배제). `widths[]` 세그먼트별 폭 그대로 사용(21단계 피처별 폭 반영).
- **② 면별 법선+음영**: 비인덱스 지오메트리 → `computeVertexNormals` 가 삼각형마다 면법선 부여 →
  `MeshStandardMaterial{flatShading}` 로 윗면(밝음)/측면(어두움) 입체 음영. 타입별 색 유지.
- **③ 상한 = 정점 메모리 예산**(세그먼트 수 아님): 세그먼트당 24정점 × 36B(position+color+normal, 비인덱스
  Float32) = 864B. 예산 900MB → `MAX_RIBBON_SEG ≈ 1,092,266`(≈1.09M, 10만의 ~11배). 실측 근거: 329k 세그먼트
  원기둥 ≈ 284MB, 브라우저 489k 세그먼트 ≈ 423MB — 여유. 177k 리포트 모델은 폴백 없이 볼류메트릭 렌더.
- **④ 레이어 청크 빌드**(UI 논블록): 20k 세그먼트 초과 모델은 6레이어/청크로 `requestAnimationFrame` 분할 생성
  (토큰으로 이전 빌드 취소, 점진 표출, "입체 렌더 생성 중 X%" 진행표시). 작은 모델은 한 프레임 동기(기존 동작 보존).
- **⑤ 폴백 유지 + 수동 오버라이드**: 상한 초과 시 라인 모드 + 경고(실 세그먼트/상한 표시) + **"그래도 입체 렌더"**
  버튼으로 강제 볼류메트릭(사용자 선택 존중). 새 슬라이스/파일마다 안전 기본값으로 상한 재평가.
- **검증(브라우저, PASS)**: ① big_cyl.stl(`gen_big.mjs`, 256각 원기둥) 브라우저 슬라이스 **489,123 세그먼트**
  → 폴백 없이 볼류메트릭 전체 렌더(`stage22_big_full.png`) + 림 줌인 음영(`stage22_big_zoom.png`).
  ② 큐브 외벽 0.6 vs 내벽 0.42 → 입체 비드 폭 차이 줌인(`stage22_cube_wall_width.png`·`stage22_cube_volumetric.png`
  — 외벽이 윗면+측면 있는 굵은 3D 비드). ③ 진행표시 실측: 슬라이스 0→100%(~1.45s) → 청크 빌드 3%→99%(~0.5s),
  빌드 중 메인스레드 16ms 폴링 응답 지속(무프리즈); 빌드 후 궤도 드래그 **중앙값 120fps·평균 109fps**(489k 세그먼트).
  오버라이드 실측: layer_height 0.08 → **1.24M 세그먼트 > 상한** → 폴백+버튼(`stage22_fallback_override.png`) →
  버튼 클릭 → 청크 볼류메트릭 빌드 0→100% ~1.58s 완료·무크래시(`stage22_forced_volumetric.png`). ④ **콘솔
  기능에러 0**(favicon 404 만). ⑤ **커널 무변경**(slicer_core.cpp/.js 무수정) → 120 무회귀 + golden byte-identical
  (결정성 확인, 재베이스라인 불요) + WIDTH TEST PASS 재확인.

**22-fix** (사용자 버그리포트 "볼류메트릭 렌더에 모델을 대각선으로 가로지르는 거대한 평면 폴리곤(스파스/갭필/솔리드
색) 겹침" → 원인 규명 후 수정. **렌더 전용 — 커널 무변경**). 경합 가설 3개를 증거로 판정:
- **H1(퇴화 세그먼트→NaN/거대 쿼드) 기각**: `wasm-core/scan_ribbon.mjs` — 큐브·얇은십자(갭필/씬월)·원기둥·scarf·
  스파이럴·arachne 6개 모델에서 buildLayerRibbon 정점 산식을 복제해 스캔 → **NaN/거대좌표 0개**, maxWidth ≤0.45
  (거대 폭 없음). 브라우저 실측(`window.__vpThree` 씬 순회): 동기(plate 4781)·청크(big_cyl 489k=11.7M 정점) 모두
  **badVerts 0·거대메시 0**, worldBBox 정확. `len<1e-6` 가드가 이미 길이0 XY 를 스킵함.
- **H2(청크 빌드 버퍼 버그) 기각**: 청크 경로 big_cyl(199 메시·11.7M 정점) 지오메트리가 동기 경로와 동일 품질(badVerts
  0). sync/chunk 둘 다 동일 `buildOne` 호출 — 버퍼 오프셋/카운트 공유 없음.
- **H3(공면 z-fighting) 확정 = 진짜 원인**: 실측 — 인접 층의 top면 ≡ 아래층 bottom면이 **198/198 정확 공면 일치**
  (z-차 <1e-4) + 카메라 near/far=0.1/6000(비 60000)의 24비트 깊이해상도가 원거리서 층높이 0.2mm 초과(0.25mm@d646·
  0.57mm@d974) → 서브표면 인필(스파스/갭필/솔리드)이 표면을 뚫고 나와 대각선 평면으로 보임. (코디네이터는 H3 가
  "거대 폴리곤 설명 불가"로 봤으나, 증거상 거대 폴리곤은 **깨끗한 지오메트리가 깊이 부정확으로 보이는 것**이지 쓰레기
  지오메트리가 아님 → H3 가 정답, H1 오진.)
- **수정**: ① **깊이 범위 축소** near/far 0.1/6000 → **1/3000**(far/near 비 20배↓ → 깊이해상도 0.566→0.055mm@d964,
  층높이 이내). ② **층간 공면 제거**: 비드 바닥 `zb = z0-h-ε`(ε=h·0.05) 로 살짝 겹쳐 top≡bottom 정확 일치 소멸
  (198/198 → **0/198**). ③ **H1 방어(심층)**: `!(len>1e-6)`(NaN 차단)·폭 NaN 가드·반폭 상한 2.5mm·개발모드 NaN
  assert. (logarithmicDepthBuffer 는 gl_FragDepth 로 early-Z 무효화 → 489k 오버드로에서 **fps 120→42(3배 저하)**
  라 미채택; near/far 축소만으로 충분.)
- **검증(PASS)**: 수정 전/후 동일 앵글(big_cyl 489k, 원거리 top-down) `wasm-core/stage22b_before.png`→`stage22b_after.png`
  (+줌인 `stage22b_after_zoom.png` = 깨끗한 볼류메트릭 비드). NaN/이상좌표 스캔 **0**(scan_ribbon.mjs, 수정 후 산식).
  공면 일치 **198/198→0/198**. 489k fps **중앙값 120·평균 106**(수정 전과 동일, 무회귀). **콘솔 기능에러 0**(dev
  NaN assert 미발동). **커널 무변경** → golden byte-identical·120·WIDTH 무회귀. ⚠ 참고: 아티팩트 심각도는 GPU 깊이
  정밀도 의존(사용자 GPU 심각·테스트 Chrome 경미)이나, 근본 원인(공면 198건+극단 near/far)은 데이터로 제거 확인.

**24단계** (사용자 스크린샷서 거대 평면 아티팩트 재발 → 근본 대응: 손수 만든 CPU 지오메트리 빌더 폐기,
**원본 libvgcode 알고리즘 그대로 재구현**. 아티팩트 클래스 전체[CPU 지오메트리 버그·z-fighting·메모리]를 구조적 제거).
원본 실측: `src/libvgcode/{SegmentTemplate.cpp, ShadersES.hpp(Segments_Vertex_Shader_ES), ViewerImpl.cpp(extract_pos_and_or_hwa)}` (SPECS §7).
- **구조(`viewer/src/toolpath_gpu.js`)**: CPU 는 지오메트리를 만들지 않는다. ① 8정점 다이아몬드 템플릿(원본
  VERTEX_DATA 24인덱스) × `InstancedBufferGeometry`(vertex_id_float attribute) ② PathVertex 스트림을 `DataTexture`
  4종 — position(RGBA32F, z-=0.5·height), height_width_angle(RGBA32F), color(RGBA32F, r<<16|g<<8|b), segment_index
  (RGBA32UI usampler2D) ③ `RawShaderMaterial`(GLSL3)에 **원본 Segments_Vertex_Shader_ES 그대로 포팅** — 수직선 가드,
  뷰의존 하프박스(코너 부호 16테이블), 마이터 조인(sin/cos 각도), POINTY_CAPS, FIX_TWISTING, 2광원 라이팅. 알고리즘
  무변경(포팅 필수 변경만: #version 은 three(GLSL3) 부여 · `255.0f`→`255.0` · vertex_id float attribute · samplerBuffer
  → sampler2D+tex_coord(id→uv), 원본 ES 변형이 이미 이 방식).
- **CPU 데이터(`buildSegmentData`, 순수·node 테스트 가능)**: 커널 세그먼트 → PathVertex(끝점 공유로 연결 런 재구성)
  + 조인각 `atan2(prev×this, prev·this)`(원본 extract_pos_and_or_hwa) + position.z -= 0.5·height. 세그먼트 인덱스는
  레이어순 → 가시범위는 `instanceCount` O(1)(텍스처 재업로드 불필요). 트래블은 별도 라인(레이어순 drawRange).
- **뷰 변환**: `view_matrix = camera.matrixWorldInverse · mesh.matrixWorld`, `camera_position` 은 메시 로컬(커널 z-up)
  좌표로 — 셰이더 UP=(0,0,1) 이 커널 z-up 과 일치(원본 의미 보존). onBeforeRender 로 매 프레임 갱신.
- **폐기**: CPU 리본 빌더(buildLayerRibbon)·라인 폴백·상한/오버라이드·청크 빌드·zEps·near/far 튜닝 전부 제거
  (코드량 감소). 다이아몬드 단면이 층간 공면을 원천 제거하므로 z-fighting 대응 불필요.
- **검증(PASS)**: CPU — `wasm-core/test_gpu_toolpath.mjs`(NaN 0·거대좌표 0·마이터각 존재[큐브 max 1.571rad=90°]·폭 0.6/0.42
  보존·프리픽스==총합·id_a+1 안전·z 센터링). 브라우저(489k 세그먼트 = 489,521 인스턴스, 셰이더 컴파일/glError/콘솔
  에러 **0**): ① 다각도 아티팩트 없음 — `s24_big_{topfar(원거리 top-down, 22-fix서 아티팩트 났던 뷰),side,bottom,near,default}.png`
  ② 폭 차이 입체 `s24_cube_width.png`(외벽 0.6 굵은 다이아 vs 인필) ③ 마이터 조인 = 상면 동심 비드가 매끈(`s24_big_near.png`)
  ④ 레이어 슬라이더(489521→121946@50/199)·트래블 토글(on 7886정점/off 0)·타입색 동작 ⑤ 궤도 fps **120**(489k, 박스판보다↑)
  ⑥ 콘솔·셰이더 에러 0 ⑦ 커널 무변경 → golden byte-identical·120·WIDTH 무회귀.

**25단계** (데스크톱 UI 재현 1차 트랜치 — SPECS §8 로드맵의 S6·S2·S5 일부. **뷰어 전용, 커널 무변경**):
- **S6 Preview 뷰**(`toolpath_gpu.js`+`Viewport.jsx`):
  - **뷰 타입 6종**(Feature type/Speed/Layer Height/Line Width/Fan Speed/Temperature) — GPU 렌더러의 color 텍스처만
    재계산(§7 구조). 값→색은 **원본 libvgcode `DEFAULT_RANGES_COLORS`**(ColorRange.hpp, 파랑→빨강 11색) + `ColorRange::
    get_color_at`(Linear) 그대로 포팅. Feature=고정색. **Speed/Fan/Temp 는 커널 toolpath 에 없어 설정값에서 유도**
    (타입→피처 속도 등, 커널 무변경 = 싼 쪽. 근거: stride-8 paths 는 type+widths 만 보유, feedrate/fan/temp 부재).
    뷰 타입 select + 그라디언트 범례(min/max).
  - **이중 슬라이더**(lower/higher) — 세그먼트 인덱스가 레이어순이라 상한=`instanceCount` 컷·하한=셰이더 `layer_lo`
    클립(둘 다 O(1), segIndex.g 에 레이어 저장). **단일 레이어 모드** 버튼. 트래블은 `drawRange` 오프셋으로 범위 표시.
  - **역할 범례**: 타입별 **길이 비율%**(내림차순). ⚠ role별 **시간**은 커널이 미노출(time_extrude/travel 총계만) →
    길이 비율로 근사(보류 문서화; 시간 비율은 커널 role별 export 필요).
- **S2 Prepare|Preview 전환**(좌상단 토글): Prepare=모델+기즈모+페인팅(툴패스 숨김), Preview=툴패스+슬라이더+뷰타입
  (모델 숨김). **슬라이스 완료 시 자동 Preview**. Preview 에선 기즈모/페인팅 강제 해제 + 포인터 게이팅.
- **S5 일부 설정 정합**(`toggle_eval.js`+`App.jsx`):
  - **toggle-rules 부분 적용**: `toggle-rules.json`의 조건식(enable_if)을 JS로 번역(로컬 인라인: have_support_material=
    enable_support||raft, have_perimeters, have_infill, has_solid_infill, spiral, prime_tower 등). 조건 false→위젯 회색
    비활성+툴팁에 조건 표시. **번역 불가 조건(enum 비교·미지 로컬)은 fail-open**(활성 유지, 오탐 방지). 전체 907키/231규칙
    완역은 범위 외.
  - **dirty+리셋**: 스키마 default 대비 변경된 옵션에 주황 점 + ↺ 리셋(프리셋 시스템 전이므로 기준=default).
- **검증(playwright, PASS)**: ① Speed 뷰 그라디언트로 피처 속도차(첫층 30 파랑→인필 100 빨강) `wasm-core/s25_speed_view.png`
  ·489k 모델 Speed `s25_big_speed.png`(fps 120·glError 0) ② 이중 슬라이더 범위밴드 `s25_dual_range.png`+단일 레이어
  `s25_single_layer.png`(instanceCount 컷 실측) ③ Prepare↔Preview(슬라이스 후 자동 전환·데모+기즈모 vs 툴패스) ④
  enable_support=false→support_style 등 비활성(조건 툴팁 표시)·`s25_toggle_rules.png`(23행 회색) ⑤ 값 변경→주황 점→리셋
  복원 `s25_dirty_reset.png` ⑥ 콘솔·셰이더 에러 0 ⑦ 커널 무변경→golden byte-identical·120·WIDTH·GPU·VIEW 테스트 PASS.
  CPU 회귀: `wasm-core/test_viewtypes.mjs`(6뷰 무결성·wall≠infill 히트맵·폭 0.42/0.6 보존·팔레트 11색).
- **미룬 것**: role별 시간 비율(커널 export 필요), 수직 슬라이더는 기능(이중 썸+단일)만 — 방향은 CSS 후순위, 전체
  toggle-rules 완역, Global|Objects 스위치(커널 per-object config 선행), S1/S3/S4/S7(상단바·툴바·사이드바·플레이트).

**26단계** (사용자 요구: 데모 메시 제거 + 다형식 임포트 강화. **뷰어 전용, 커널 무변경**):
- **R1 데모 제거**: 하드코딩 큐브/실린더/토러스 + 관련 코드 전부 삭제(grep 0). 빈 씬에 드롭 안내 오버레이(📦 + 포맷 목록 + 파일선택).
- **R2/R3 다형식 로더**(`model_loaders.js`): **STL·OBJ·3MF·AMF·PLY** — `three/examples/jsm/loaders/{OBJ,PLY,3MF,AMF}Loader`
  재사용(**신규 npm 의존성 0**; 3MFLoader 는 three 번들 fflate 로 unzip). 통일 파이프라인: 확장자→로더→(BufferGeometry|Group)
  →`collectMeshes`(월드행렬 베이크)→비인덱스 삼각형→**model z-up flat(N*9)**. 좌표계(실측): 프린팅 포맷은 z-up mm, three 로더는
  축 변환 없이 원좌표 로드 → z-up 그대로 사용(OBJ 는 그래픽 y-up 가능성 주석, 프린팅 기준 z-up 기본). 슬라이스는 기존 경로
  (matrixWorld→바이너리 STL 병합→커널) 재사용. **STEP 범위 외**(OCCT 필요 — 브라우저 WASM OCCT 미탑재). 3MF 지오메트리만(프로젝트
  설정 복원 후속, SPECS §1).
- **R4 다중+DnD**: 다중 파일 선택 + **뷰포트 전체 드래그앤드롭**(하이라이트 오버레이), bbox 기반 나란히 배치(placeX 커서, 겹침
  방지), 3MF/AMF 내 복수 오브젝트 개별 등록. 목록/선택/기즈모/T1·T2/삭제/페인팅 전 포맷 동작.
- **검증(PASS)**: ① 데모 잔재 grep **0** ② `wasm-core/test_loaders.mjs`(node: STL/OBJ/PLY 로드→STL→커널 슬라이스, 12삼각형·20mm
  z-up·99레이어·동일 G-code) + **브라우저 5포맷 전부**(STL/OBJ/PLY/AMF/3MF) 로드→슬라이스 = **동일 99레이어·8147세그먼트·1194.1mm**
  (3MF/AMF 는 DOMParser 필요 → 브라우저서만). 픽스처: `wasm-core/gen_fixtures.mjs`(fflate 로 3MF zip 조립) → `fixtures/cube.{obj,ply,amf,3mf}`.
  ③ 이종 2포맷(OBJ 큐브+STL 실린더) 동시 로드→나란히 배치(x=10/38, 무겹침)→병합 슬라이스 `wasm-core/s26_merge.png`(2오브젝트·15246
  세그먼트) ④ 드래그앤드롭 playwright(DataTransfer 주입: dragover→오버레이 표시 `s26_dragover.png`, drop→로드 objs 0→1) ⑤ 콘솔
  에러 0 ⑥ 커널 무변경→golden byte-identical·120·WIDTH·GPU·VIEW·LOADERS PASS ⑦ 빈 씬 오버레이 `s26_empty.png`.
- **미룬 것**: STEP(OCCT), 3MF 프로젝트 설정/페인팅 데이터 복원(지오메트리만), OBJ y-up 자동판별(현재 z-up 고정).

**27단계** (사용자 피드백 "UI 개선은? 그대로인데?" → 데스크톱 OrcaSlicer 레이아웃·비주얼로 재구성. SPECS §8 의 S1/S3/S4.
**뷰어 전용, 커널 무변경, 기능 회귀 0**):
- **셸 재구성**: `Viewport.jsx` 가 데스크톱형 셸 소유(App `Prepare` 는 `processPanel={<SettingsPanel/>}` 로 임베드). 레이아웃 =
  상단바 / [좌측 기즈모 레일 · 중앙 뷰포트 · 우측 사이드바] / (사이드바 하단 고정 버튼).
- **S1 상단바**(~44px): 로고 "OrcaSlicer RE" + 열기 버튼 · 중앙 Prepare|Preview 탭(vp-modebar 이동) · 우측 undo/redo 자리(비활성+툴팁).
- **S3 좌측 레일**: 세로 기즈모 아이콘(이동/회전/스케일/**서포트 페인팅**) — **데스크톱 원본 SVG 재사용**(resources/images/toolbar_{move,
  rotate,scale,support,open,arrange,orient}_dark.svg + add/delete → viewport/src/assets). 페인팅은 레일 모드(선택 시 브러시가
  플로팅 패널). 뷰포트 상단 툴바: 추가·삭제·arrange/orient(비활성+"백엔드 이식 예정" 툴팁).
- **S4 우측 사이드바**(라이트): ① 프린터(베드 크기·노즐 Ø) ② 필라멘트(색 스와치+T행 목록, +/− = 색 배열; **색 변경 → 오브젝트
  메시 색 반영**) ③ 프로세스(설정 패널 임베드) ④ 오브젝트 리스트(눈알 출력토글·이름·T셀렉터·삭제) ⑤ 하단 고정 [슬라이스 ▾]+[G-code
  내보내기]. 슬라이스 stats 는 Preview 시 뷰포트 좌하단 카드. 뷰타입/이중슬라이더/범례는 사이드바 "미리보기" 카드.
- **스킨**: 다크 크롬(상단바·레일·뷰포트) + 라이트 사이드바, Orca 그린(#00AE42) 액센트, 섹션 카드·구분선·데스크톱 아이콘 크기. styles.css 정리 확장(신규 프레임워크 없음).
- **검증(PASS)**: ① 전체 레이아웃 스크린샷 Prepare(`wasm-core/s27_prepare_v1.png` 빈 씬 · `s27_prepare_model.png` 모델+페인트)/Preview
  (`s27_preview_v1.png`) ② 페인팅을 레일 모드로 → blocker 4066 facets → 슬라이스 동작 ③ 필라멘트 T1 색 #6aa0dc→#22cc55 → 오브젝트
  메시 녹색 반영 ④ 하단 슬라이스 → 뷰포트 좌하단 stats 카드(99레이어·8147세그·1194mm·15m33s) ⑤ 기존 기능 무회귀(뷰타입·이중슬라이더·
  DnD·toggle-rules 서포트 비활성·dirty/리셋 전부 동작) ⑥ 콘솔 에러 0 ⑦ 커널 무변경 → 120·golden byte-identical·WIDTH·GPU·VIEW·LOADERS PASS.
- **미룬 것**: undo/redo(자리만), arrange/orient(백엔드 이식), 프라임타워/툴패스 Tool-뷰 색(커널 per-세그먼트 tool export 선행 —
  현재 필라멘트 색은 Prepare 오브젝트 메시에만 반영), S4 프린터/필라멘트 콤보 프리셋(프리셋 시스템 선행), S1 File 메뉴/창 제어.

**28단계** (실세계 STL(Benchy급) 버그 라운드 — P1~P5. **커널 변경(좌표 계약) + golden 검토**):
- **P1 바닥 안착**: 로드 시 `bakeLocal` 이 각 오브젝트 로컬 지오메트리를 minZ→0 안착(원본 `ModelObject::ensure_on_bed`
  의 `z_offset=-min_z`). 싱킹(allow_negative_z)은 범위 외. 기즈모 Z 이동 후 재안착용 "바닥에 놓기(⬇0)" 버튼 추가.
- **P2 좌표 계약 뒤집기(핵심)**: 커널이 결합 bbox 를 원점 재정렬하던 3단계 설계를 폐기 → **`auto_center`(기본 false)=
  뷰어 좌표 신뢰**. false 면 XY 재정렬 없이 그대로 슬라이스(Z 만 안착), G-code 는 plate origin 오프셋(+bed/2)만(원본
  `GCode.cpp:932 m_plate_origin` 일치). 결과: **툴패스가 화면 모델 위치·자세와 정확히 겹침**(실측: 오프셋 오차 ~1-2mm=
  스커트/비드폭, 기즈모 +40/-20 이동 시 툴패스가 1.2mm 오차로 추종). 셀렉터(페인팅) weld·뷰어 paintXform 도 XY 항등으로
  정합. `auto_center=true` 는 레거시 재정렬로 하위호환 보존.
- **P3 자세**: -90°X 베이크 ↔ 슬라이스 역행렬 왕복이 자세를 보존(z-up 유지) — 실측상 눕는 버그 없음(pseudo-benchy 가 화면·
  슬라이스 모두 직립, height=three-Y). 눕는 증상은 P2 좌표 불일치의 부수효과였음. OBJ 는 z-up 가정 유지(눕으면 회전 기즈모).
- **P4 서포트∩솔리드=0 불변식**: (코디네이터 정정 반영) 닫힌 공동 제외 로직은 원본과 달라 **미구현** — 공동 내부 서포트는
  정상. 유일 기준 = **서포트 영역 ∩ 모델 솔리드(벽 내부) = 0**. P2 수정 후 재슬라이스에서 불변식 **통과**(510 서포트 세그먼트,
  솔리드 관통 0) → "서포트가 모델 안에" 증상은 좌표 파생이었고 P2 로 해소(회피 로직 버그 아님).
- **트리 서포트 원점밖 크래시 수정**: P2 로 모델이 원점 밖에 놓이자 `treesupport_bridge`(generate_tree_support_3D 포트)가
  메모리 접근 위반. 링을 모델 XY중심 만큼 원점으로 이동해 브릿지에 넘기고 브랜치 출력을 되돌려 방출 → 크래시 해소 + P2 겹침
  보존(레거시 재정렬이 가리고 있던 잠복 버그).
- **golden(재베이스라인 불요)**: 하니스가 "베드 중앙 배치 좌표"를 보내도록 수정(`golden.mjs centerTris` — 뷰어 bakeLocal 과
  동일). 중앙배치+auto_center=false = 레거시 재정렬과 **동일 G-code** → **golden byte-identical(523965B, 0줄 차이)**, 재베이스라인
  불필요(사유 기록). 커널 재빌드 후 120·WIDTH·GPU·VIEW·LOADERS·TREE·PAINT 전부 그린.
- **P5 회귀 게이트**: `wasm-core/gen_benchy.mjs`→`fixtures/pseudo_benchy.stl`(off-center·minz=5·직립·arm 오버행·밀폐 공동;
  3DBenchy 는 CC-BY-ND·저장소엔 .drc 뿐이라 프로그램 생성). `wasm-core/test_coords.mjs` 불변식: ① minZ=0 안착 ② 툴패스 XY
  bbox≈모델 XY(<1mm) ③ off-center 추종 ④ over_bed ⑤ auto_center=true 레거시 ⑥ 서포트∩솔리드=0.
- **검증(브라우저)**: 동일 카메라 Prepare 모델↔Preview 툴패스 겹침(`wasm-core/s28_prepare.png`/`s28_preview.png`), 서포트
  오버행 아래 생성·관통 없음(`s28_support.png`), 기즈모 이동 후 툴패스 추종(`s28_moved_overlap.png`), 콘솔 0.

**29단계** (사용자 요청 2건 — **커널 무변경, 뷰어 오케스트레이션만**):
- **① 기즈모 변환 후 자동 재안착**: TransformControls `dragging-changed` 커밋(드래그 끝)에서 오브젝트 월드 bbox
  minY(three)=바닥→0 재안착(이동·회전·스케일 모두, 실시간 아닌 커밋 시). 원본은 `GLCanvas3D::do_move/do_rotate/do_scale`
  가 커밋마다 `ensure_on_bed`(Model.cpp:1720, z_offset=-min_z)로 부양(minZ>0)을 베드에 스냅하고 싱킹(minZ<0)은
  SINKING_Z_THRESHOLD 까지 유지. **차이 한 줄 = 싱킹 미지원**(우리 커널은 음수 z 슬라이스 불가 → minZ≠0이면 위든
  아래든 0으로 스냅). 검증 `wasm-core/s29_reseat.png`.
- **② 다중 플레이트 1차(S7 최소판)**: N개 플레이트(1행 그리드, 기본 1, 상단 툴바 추가/삭제, 이름표 1·2·3…), 각
  플레이트=printable_area 사각형+그리드+라벨. **위치 기반 소속**(오브젝트 월드 X가 얹힌 플레이트 사각형). 플레이트 클릭
  선택→테두리 초록 강조. **[슬라이스 ▾]** 드롭다운=현재/전체. **현재**=그 플레이트 오브젝트만 커널로(좌표는 플레이트 로컬),
  **전체**=플레이트별 순차 슬라이스+개별 `plate_N.gcode` 다운로드(zip 없음, body 앵커+350ms 간격으로 다중 다운로드 차단
  회피). 프리뷰=선택 플레이트 캐시 결과(`plateResultsRef`/`plateOffsetsRef`, 전환 시 교체). **28단계 좌표 계약 유지**:
  G-code 오프셋=플레이트 원점+베드/2. **유예**(과공학 금지): per-플레이트 설정 오버라이드·lock/아이콘·자동 배치.
- **크래시 수정(뷰어 전용)**: 28단계 P2(커널 재정렬 제거) 이후 일부 비대칭/음수 좌표(예: 큐브 모델 x[0,20]·y[-10,10])가
  커널 스커트/인필 경로에서 "memory access out of bounds"를 유발(skirt_loops:0 · rectilinear · seam nearest · 대칭좌표
  중 아무거나로 회피되는 취약 케이스). "슬라이스는 중심화·표시는 오프셋"(데스크톱 `m_plate_origin` 방식)으로 회피:
  `buildMergedSTL` 이 슬라이스 입력을 XY 원점 중심(대칭 좌표)으로 보내 크래시 회피 + `offX/offZ` 반환→`setToolpathOffset`
  으로 툴패스를 되밀어 화면 모델과 겹침 유지. 페인트 xform 도 동일 중심화 반영. **커널 무변경이라 golden byte-identical**.
- **검증**: 단일 큐브 슬라이스 크래시 해소·툴패스 완전 겹침(오차 0,0), 2플레이트(benchy@0·cube@1) 전체 슬라이스
  →`plate_1.gcode`+`plate_2.gcode` 2파일, 프리뷰 전환(plate0=169층@오프셋26 · plate1=99층@오프셋250)·소속/위치 정확,
  glError 0·콘솔 0. `wasm-core/s29_multiplate.png`. **회귀 게이트**: 120·WIDTH·GPU·VIEW·LOADERS·TREE·PAINT·COORDS
  전부 그린 + golden byte-identical(523965B, 0줄 차이, 커널 무변경).

**30단계** (OOM 내성 라운드 — "메모리 압박에서도 G-code 는 끝까지 나온다". §6.8 output 스트리밍 회귀):
- **① G-code 레이어 스트리밍(근본)**: 커널에 모듈 레벨 레이어 싱크(`set_layer_sink(cb)`/`clear_layer_sink`)
  추가. 등록 시 `slice()` 가 배치 상주(전체 `gw.s` + 전체 `layersArr`) 대신 레이어마다 `cb(z, idx, gcodeChunk,
  pathsF32, widthsF32)` 로 방출하고 **그 레이어 버퍼를 힙에서 해제**(`gw.s.swap` 후 비움). 프리앰블은 첫 청크,
  마무리는 마지막 청크 → 청크 이어붙이면 배치 `gw.s` 와 **byte-identical**. 싱크 미등록 시 기존 배치 경로 그대로
  (모든 node 테스트·golden 무변경). 실 PE(전체-문자열 교차레이어 평활, 옵트인·golden 밖)는 배치로 폴백.
- **후처리기 스트리밍**: GCodeProcessor 는 원본이 스트리밍 파서(`process_buffer` 는 상태 유지 — 청크가 '\n'
  경계라 여러 번 호출=한 번 호출) → `gcodeproc_bridge` 에 `estimate_begin/feed/end` 추가, 커널이 청크를 만드는
  대로 먹여 전체 문자열을 한꺼번에 상주시키지 않음. PE 태그 제거는 무상태 줄 단위 필터라 청크마다 적용(동일 결과).
- **② 전달·렌더**: worker 가 레이어를 만드는 대로 메인으로 **transferable**(Float32Array 버퍼 이전)로 즉시 방출 →
  worker 사본 즉시 해제. 메인은 누적 후 텍스처 1회 빌드(`buildSegmentData` 가 교차레이어 마이터 조인+프리픽스합을
  요구 → 레이어별 GPU-append 성장 텍스처는 근거와 함께 유예; worker/WASM 이 OOM 병목이라 이미 해소). g-code 청크는
  배열 보관(다운로드).
- **③ OOM 감지 + 자동 재시도 사다리**: 감지 3종 — worker error/messageerror · WASM abort · **행 워치독**(진행 콜백
  60초 무소식 → 죽음 판정, 워커 terminate). 발동 시 **워커 재생성 → 절약(economy) 모드 자동 재슬라이스**(프리뷰
  툴패스·시간추정 생략, G-code 만) → 성공 시 "프리뷰 없음" 안내 + G-code 제공. 그래도 실패면 **간소화 재시도**
  (인필 rectilinear·밀도↓·economy) 제안 다이얼로그. **E1**: 전체 플레이트 순차 중 한 플레이트 실패해도 이미 완주한
  플레이트 G-code 는 보존·다운로드. 부분 G-code 는 결과로 주지 않음.
- **버그 수정(커널)**: `gcodeproc_bridge` 리팩터 중 `make_cfg` 가 `PrintConfig` 를 **값 반환** → StaticPrintConfig 의
  옵션맵(멤버 주소 포인터)이 복사본에서 원본 소멸 멤버를 가리켜 gap-fill/thin-wall g-code 파싱 시 wasm OOB. `fill_limits`
  로 **제자리 채움**(복사 금지)으로 수정. 노드 이분법(full 크래시 / transcribed 정상)으로 격리.
- **검증**: ① 힙 벤치(`wasm-core/bench_heap.mjs`, big_cyl 318,687세그) — batch **126.9MB** → stream **107.1MB**(15.6%↓,
  레이어별 해제) → **economy 16.4MB(87%↓** = base, moves 벡터·툴패스·gcode 상주 전무) = OOM 생존 모드가 대형 모델을
  기저 힙으로 완주. ② 스트리밍 조립 g-code == 배치 **byte-identical**(신규 `golden_stream.mjs`, 4케이스·economy 포함
  15/15). ③ 브라우저(콘솔 0): 정상 스트리밍(benchy 169층/13886세그 프리뷰 `wasm-core/s30_streaming.png`) · **강제 실패
  →절약 완주**(안내+다운로드) · **행 워치독**(1.5s 발동→절약 완주 2.0s) · **플레이트 E1**(plate2 실패해도 plate1 g-code
  다운로드). ④ 전 스위트(test/width/gpu/viewtypes/loaders/ts_verify/paint/coords) + batch golden **523965B byte-identical**
  무회귀. 테스트 훅(`window.__vpFail/__vpStallNext/__vpWatchdogOnce`, worker `d.stall`)은 프로덕션 미설정.

**31단계** (사용자 버그: 대칭 vase형 모델의 오가닉 트리 서포트가 **한쪽(오른쪽)만** 생성/렌더):
- **판정(생성 vs 렌더 이분)**: 대칭 픽스처(중앙 기둥 + 좌우 동일 ±X 귀 2개, 밑면 오버행) 생성 → `support_style=tree`
  배치 슬라이스 → **커널 type5(서포트) 세그먼트 X 분포** 실측: 좌(X<0)=**0**, 우(X>0)=**4080** → G-code(툴패스)
  자체가 한쪽만 = **생성 버그(H1)**. `tree_lite` 는 좌우 대칭(123/123) → 오버행 검출은 정상, **오가닉 경로만** 결함.
- **기각**: **H2(렌더 누락)** — 커널 원출력이 이미 한쪽뿐이라 렌더 이전 문제(30단계 스트리밍 조립 경로와 무관).
  **H1의 재중심화-부호 가설** — off-center(+40) 픽스처도 모델 중심 기준 동일하게 우측만(브릿지가 항상 bbox
  중심으로 재중심화하므로 28단계 tcx 부호와 무관) → 재중심화 부호 아님. **H3(원본 정상 비대칭)** — 원본
  OrcaSlicer 는 오브젝트를 프린터블에어리어(양수 [0,bed]) 안에 두므로 대칭이 정상; 우리 통합이 원점중심 모델을
  [0,bed] 보더와 불일치시킨 것이 원인(포트 자체 결함 아님).
- **근본 원인**: TreeSupport 는 서포트 영역을 `m_machine_border`(=`printable_area`)로 클립한다
  (`TreeSupport.cpp:2188/2193/2197` `intersection_ex(roof/base_areas, m_machine_border)`). 브릿지가
  `printable_area`를 **양수 사분면 [0,bed]** 로 설정(`treesupport_bridge_impl.cpp:88`)한 채 커널은 모델을 **원점 중심**
  (bbox center=0, 28단계 P2)으로 넘겨 → 모델의 **음수-X/Y 절반(대칭 모델의 한쪽 귀)** 이 보더 밖 → 서포트가 통째로
  클립되어 소실. (ts_verify 의 테이블은 단일 중앙 기둥이라 잠복 — type5>0 만 검사, 대칭은 미검사였음.)
- **수정(브릿지 1건)**: `treesupport_bridge_impl.cpp:88-93` — `printable_area`(=machine_border)를 **원점 중심**
  `[-bed/2, bed/2]` 로 변경 → 원점중심 모델이 온전히 보더 안 → 좌우 대칭 서포트. 모델 좌표는 원점 근방(작게)
  유지(`slicer_core.cpp:1244` tcx 원복 = 28단계 그대로) → **교차-슬라이스 OOB 회피**. (초기 시도: tcx 를 베드
  중심으로 옮겨 모델을 양수 좌표에 두는 방식(v1)은 대칭은 고쳤으나 큰 좌표(~100mm)에서 tree→tree_lite 연속
  슬라이스 시 "memory access out of bounds" 재발 → 폐기. 보더를 옮기는 편이 좌표를 작게 유지해 안전.)
- **검증**: 신규 `wasm-core/test_tree_symmetry.mjs` 불변식 — 대칭 픽스처 좌/우 type5 비율 **[0.7,1.3]** 및 양측>0:
  centered L/R=**0.92**(좌7365·우7969), off-center(+40) L/R=**0.92**, tree_lite 대조 1.00. **tree→tree_lite 무크래시**
  확인(v1 회귀 해소). 브라우저 vase형(`fixtures/sym_ears.stl`, `window.__vpForceTree`) → **좌우 귀 모두 서포트 렌더**
  (`wasm-core/s31_tree_symmetric.png`, 149층·서포트 19%·콘솔 0). **회귀 게이트**: 10 스위트
  (test/width/gpu/viewtypes/loaders/ts_verify/paint/coords/golden_stream/test_tree_symmetry) + batch golden
  **523965B byte-identical** 전부 그린(커널 슬라이싱 로직·golden 무변경).

**32단계** (서포트 구조 결함 라운드 — 재현우선(reproduce-first) 수사 + 실발견 수정):
- **가설 실측 → 두 가정 기각**: 지붕(테이블+캔틸레버 arm)·컵(두꺼운 벽+내부 오버행) 픽스처를 grid/tree_lite/tree
  로 슬라이스해 type5(서포트) 분포를 (x영역·z대역)별 실측(`wasm-core/repro_support.mjs`). 결론:

  | 가설 | 실측 | 판정 |
  |------|------|------|
  | 홀/`offset_paths` 결함(벽 솔리드에 서포트) | 컵: 벽솔리드 type5=**0**, 공동 서포트 존재 | **기각** — `SimplifyPolygons(pftEvenOdd)` 방향정규화 + ClipperOffset 가 홀을 정상 수축 |
  | 지붕 위 돌출이 지붕 아래로 관통 | arm 유/무 gap<지붕 type5 **Δ=0** (지붕밑 서포트는 정당한 지붕-밑면 오버행 서포트) | **기각** — 우리 커널은 브릿지 안 해 지붕 밑면이 항상 오버행→서포트, 상단 컬럼은 그에 흡수 |

  근본 이유: 레이어별 `col = column[j] − offset(contour[j],+xy)` 클립이 이미 "서포트는 솔리드 안에 안 들어가고
  모델 상면 위에 얹힌다"를 달성. 원본 bottom-contact 개념은 없지만 클립이 구조적으로 동등.
- **실발견 수정 A — 부유 오버행 무서포트**: `slicer_core.cpp:1303` 이 하층이 비면(풀 z-gap 위 부유 파트) 오버행
  검출을 skip 해 공중 파트가 **서포트 0** 이던 버그. skip 조건을 `L[i].contour.empty()` 만으로 축소 → 하층이 비면
  `offset(empty)=empty` 라 clip 결과가 contour 전체 = 전면 오버행 → 서포트 생성. (부유 파트에만 발동 → 정상 모델
  무영향·golden 불변.) 검증: 부유 arm 픽스처 type5 **0→150**.
- **실발견 수정 B — `support_bottom_z_distance` 파라미터**: 모델 상면에 얹히는 서포트 바닥 z-gap. `botGap=round(dist/lh)`,
  기본 0.2/lh=**1 → 추가 클립 루프 미실행 → 현행과 완전 동일(golden byte-identical)**. >1 이면 상면 바로 위 (botGap−1)
  레이어의 서포트를 추가 제거해 간격 확보. `settings.js` 매핑(`support_bottom_z_distance`, 기본 0.2). 검증: 타워+arm
  픽스처에서 서포트 바닥 z 5.00(0.2)→5.40(0.6)→5.80(1.0) — 상면(z=5) 위로 정확히 (botGap−1)·lh 만큼 상승.
- **회귀 가드 신설**(`wasm-core/test_support_structure.mjs`, grid·tree_lite): 컵 벽솔리드=0·공동>0, 지붕 arm Δ=0·
  지붕 위 얹힘>0, 캔틸레버 over-pillar=0, **Fix A**(부유 서포트>0), **Fix B**(z-gap 상승). 미래 서포트 개편 안전망.
- **풀 GCodeProcessor 비매니폴드 크래시(조사만, 수정은 별도 라운드)**: 겹치는 박스로 만든 비매니폴드 픽스처(지붕+arm)의
  g-code 를 `time_engine=full`(기본)로 처리 시 "memory access out of bounds"(`function[2807]`, gcodeproc move/time 경로).
  **힙 레이아웃 의존**(30·31단계 하이젠버그와 동류) — 단일 슬라이스로는 재현 안 되고 `지붕-noarm→지붕-arm` 연속
  슬라이스에서 재현. 자기교차 지오메트리가 만드는 병적 move 시퀀스(퇴화/영길이 move 추정)에 민감한 포트 내 잠복
  버퍼/인덱스 버그로 추정. **30단계 OOM 사다리가 현재 방어**(economy 재시도는 시간추정 생략). 수정은 ASan 필요 → 별도 라운드.
- **`SupportMaterial.cpp` 이식 정찰: 보류 확정 (사유: 32단계 증거).** 현 스윕이 구조적으로 건전(홀·상면 얹힘·솔리드
  회피 정상)함이 실측돼 접촉층 파이프라인 이식의 기대 이득이 낮음. bottom-contact 는 Fix B 로 파라미터화됨(스윕 위에서
  근사). 실물 vase STL 도착 시(옵션 1) 재평가.
- **회귀 게이트**: 11 스위트(위 10 + test_support_structure) + batch golden **523965B byte-identical** 전부 그린
  (Fix A/B 기본 동작 불변 실증). 커널 재빌드 후.

**여전히 미구현/근사 한계** (완전 libslic3r 포팅 없이는 근사가 한계):
- **오가닉 TreeSupport** — **18단계 본선 통합 + 19단계 정밀도 완성**: `support_style=tree` 시 실
  `generate_tree_support_3D` 브랜치 툴패스(type5) 방출(브라우저 렌더 검증). 19단계서 **per-path 서포트 압출폭
  전달**(E·리본 반영, config 추종 실증)·**서포트 z 오브젝트 그리드 정합(z_resid 0mm)** 완료. 잔여: 이 포트의
  support flow 는 인터페이스=본체 폭(포트 모델). 기본값 grid·tree_lite 보존.
- **수동 서포트 enforcer/blocker 페인팅** — **20단계서 완결(실물)**: 실 TriangleSelector 이식 + selector_bridge
  (embind) + 뷰어 three.js 브러시 UI(SPHERE 커서·오버레이) + 파사드 `slice_support_enforcers/blockers` 실투영
  (footprint) 배선. 물리 검증: enforcer→서포트 생성, blocker→억제(tree+grid, `test_paint.mjs`), 브라우저 렌더.
  잔여 근사: 상류 tree enforcer 는 실 오버행 영역만 강제(수동 모드로 검증), footprint 투영은 slice_mesh_slabs 대체
  (고립 패치 대응).
- **시간추정** — **13단계부터 실 GCodeProcessor 본체**(7561L 이식, `time_engine=full` 기본)로 계산. 10단계
  전사본은 `time_engine=transcribed` 로 보존(둘 편차 8.5%, full 이 원본 정답). 간극: role 세분은 태그 모드만,
  레이어는 position.z 그룹핑(커널이 CHANGE_LAYER 태그 미방출).
- **config 서브시스템** — **11단계 이식 + 12단계 본선 병합 완료**(실 Config.cpp+PrintConfig.cpp 가 메인
  slicer_core.js 에 링크, `config_option_count()`=817 라이브). 10단계가 지목한 키스톤 관문 완전 해소.
- **WipeTower** — **11단계 실이식 + 12단계 커널 배선 완료**(`wipe_tower_real`, 기본 false). true 시 MM 툴체인지에
  실 WipeTower.generate() 출력(`; CP TOOLCHANGE`/`; WIPE_TOWER_START` + E/F) splice, false 시 6단계 사각링.
  뷰어 토글 O. **잔여**: rib 3D 메시(TriangleMesh)는 스텁(미생성), 다층 최적화 아닌 레이어별 독립 생성,
  PlaceholderParser 토큰 미확장(주석 처리), 필라멘트 퍼지/램밍 스케줄링 미반영.
- **full-GCodeProcessor** — **13단계에서 이식 완료**(7561L 본체 컴파일+링크+실행, `time_engine=full` 신규 기본,
  120 그린). 시간추정이 이제 원본 본체(사다리꼴 플래너 실물). 전사본은 `time_engine=transcribed` 로 보존.
  간극: role 세분은 태그 모드만, 레이어 검출 position.z 그룹핑, actual-speed 서브무브로 move단위 직접합 부정확.
- **full-TreeSupport** — **18단계서 본선 통합 완료**. 16단계 standalone(10903줄/4본체, 실 CGAL+Arachne+Fill,
  20층/123 type5) → 17단계 ODR 실측(공유링크 120그린이나 본선 트림 Fill 오염 크래시; 완전격리는 wasm 심볼 로컬화
  미지원으로 불가) → **18단계 옵션(a): 본선 FillBase 팩토리 가산 언트림(골든 byte-diff 0) + shared-symbol 통합**.
  결과: `support_style=tree` 오버행 테이블 → **type5 8662개**, tree vs tree_lite 분포 상이, 결정론, 120 무회귀+골든 0,
  브라우저 오가닉 트리 렌더(`wasm-core/stage18_tree_support.png`), 콘솔 기능에러 0. 재현 `wasm-core/ts_verify.mjs`·
  `golden.mjs`. **실 오가닉 TreeSupport 예외 소멸.**
- **Fill 미이식 패턴** — rectilinear/grid/triangles/zigzag 는 커널 자체 근사 유지(이식 5패턴만 실제). FillAdaptive/
  Lightning/Tpms/Line 등은 미이식(new_from_type 에서 nullptr→커널 폴백).
- **Arachne CGAL 평면성 복구** — **14단계에서 실 이식 완료**(더 이상 스텁 아님). `VoronoiUtilsCgal.cpp`(실
  CGAL 6.2 header-only + Boost.Multiprecision, GMP/MPFR 링크 없음)가 본선에 링크돼 `is_voronoi_diagram_planar_angle`
  가 실제로 실행(검증: arachne 큐브 슬라이스 후 `cgal_planar_check_count`=99=레이어당 1회). ⚠ **wasm 라운딩 한계**:
  wasm 은 FP 라운딩모드 레지스터가 없어(fesetround no-op) CGAL interval 산술이 보수적이지 않음 →
  `CGAL_DISABLE_ROUNDING_MATH_CHECK` 로 시동 자가진단 우회, 필터가 배정밀도로 동작 + 근접 0 케이스는 exact
  MP_Float 폴백(정확). 즉 데스크톱의 exact 보장은 아니나 "항상 평면" 스텁보다 실제 검사로 격상. boost wasm.hpp
  오버라이드(BOOST_NO_FENV_H 제거 — emscripten fenv.h 존재)로 Boost.Interval c99 rounding 경로 활성.
- **Arachne 미배선 파라미터** — `wall_transition_*`/`min_bead_width` 등을 브릿지가 기본값으로 채움
  (make_paths_params 를 제거했으므로). config 로 노출하면 완전 동등.
- **classic 씬월/갭필**(5단계) — arachne 모드에선 자동 비활성(Arachne 가 가변폭으로 대체). classic 모드에선
  여전히 중심선 근사.
- **오가닉 트리 서포트** — 원본 TreeSupport 파이프라인은 16~18단계에서 본선 통합 완료(`support_style=tree`,
  19~20단계에서 per-path 폭·z 정합·수동 페인팅까지). tree_lite 는 경량 대안으로 보존(형태학적 하강 테이퍼 —
  가지 분기/병합 최적화 없음). 이 줄의 구식 서술은 15단계 이전 기록이었음.
- **와이프타워 본격** — 실 WipeTower 는 11단계 이식·12단계 커널 배선 완료(`wipe_tower_real=true` 시 실 원본
  퍼지/램밍/와이프 로직 사용). 잔여: 레이어별 독립 생성(다층 타워 스케줄링 아님)·rib 3D 메시 미생성·
  PlaceholderParser 토큰 미확장. 기본값(false)은 6단계 사각 링 유지.
- **PressureEqualizer** — 원본 PE 는 8단계 이식·9단계 태그 통합 완료(세그먼트 F램프 분할 실관측). 기본값은
  PE-lite 근사(세그먼트 단위 속도 조정, 분할 없음) — `pe_lite=false` 로 원본 PE 옵트인.
- **벽 회피 완전성** — 경계 우회가 실패하는 케이스 잔존(내벽 횡단·다중 아일랜드 hop).
- **non-planar** — 미구현. 서포트 본체는 grid(지그재그 미연결).
- 갭필/씬월/브리지/아이어닝 모두 형태학(Clipper offset) 근사라 얇은 곡선 영역에선 짧은 스텁이 생길 수 있음.

## 라이선스

이 디렉토리 전체는 상위 저장소(OrcaSlicer)와 동일하게 **AGPL-3.0-or-later**다.
`wasm-core/arachne_port/`·`treesupport_port/` 등은 본 저장소의 원본 소스(AGPL)를 이식 목적으로 복사한
것이며 원 저작권 고지를 유지한다. 외부 의존성: three/React(MIT), Clipper·Boost(BSL-1.0),
CGAL(GPL, header-only 사용), emscripten 툴체인. **npm 등 외부 배포 시** 이 패키지는 AGPL-3.0으로
배포되어야 하며 소스 공개 의무가 따른다.
