# 상세 스펙 — 3MF XML · 페인팅 코덱 · 표현식 언어 · 단축키 · 3D 렌더링

`REVERSE_ENGINEERING_GUIDE.md`의 보조 문서. 전부 소스 실측 기반 (main 607648c).

---

## 1. 3MF 프로젝트 파일 XML 스펙

원본: [src/libslic3r/Format/bbs_3mf.cpp](../slicer/src/libslic3r/Format/bbs_3mf.cpp) 상수 선언부(232-439행).
ZIP 엔트리 목록은 가이드 §7.2. 여기는 엔트리별 XML 구조.

### 1.1 `3D/3dmodel.model` — 씬/메시 (3MF 코어 + 확장)

```
<model unit="millimeter" ...>
 <resources>
  <object id="" p:UUID="" type="model">
   <mesh>
    <vertices>  <vertex x y z/>* </vertices>
    <triangles> <triangle v1 v2 v3
                  paint_supports=""    ← 서포트 페인팅 (§2 코덱)
                  paint_seam=""        ← 심 페인팅
                  paint_color=""       ← MMU 색 페인팅
                  paint_fuzzy_skin=""  ← 퍼지스킨 페인팅
                  face_property=""/>* </triangles>
   </mesh>
   <components> <component objectid="" p:path="" transform=""/>* </components>
   <!-- 텍스트/SVG 볼륨 메타 -->
   <slic3rpe:text text="" font_name="" font_size="" bold="" italic="" ... />
   <slic3rpe:shape scale="" depth="" use_surface="" filepath3mf="" ... />
  </object>
  <m:colorgroup> <m:color color=""/>* </m:colorgroup>
 </resources>
 <build> <item objectid="" transform="" printable=""/>* </build>
</model>
```

- 오브젝트별 실제 메시는 `3D/Objects/<name>_<n>.model`로 분리되고 3dmodel.model이 component로 참조한다.
- `transform` = 3×4 행렬 12개 실수 공백 구분 (column-major 3열 + translation).

### 1.2 `Metadata/model_settings.config` — 계층 설정 오버라이드 (XML)

```
<config>
 <object id="">
  <metadata key="name|extruder|...(옵션키)" value=""/>*
  <part id="" subtype="normal_part|negative_part|modifier_part|support_blocker|support_enforcer">
   <metadata key="name|matrix|source_file|source_object_id|source_volume_id|
                  source_offset_{x,y,z}|mesh_shared|volume_type|part_type" value=""/>*
   <mesh_stat ... />
  </part>
  <model_instance> <metadata key="object_id|instance_id|identify_id" value=""/>* </model_instance>
 </object>
 <plate>
  <metadata key="plater_id|plater_name|locked|bed_type|print_sequence|
                 first_layer_print_sequence|other_layers_print_sequence|
                 filament_map_mode|filament_maps|limit_filament_maps|
                 gcode_file|thumbnail_file|thumbnail_no_light_file|top_file|pick_file|
                 pattern_bbox_file|index" value=""/>*
  <model_instance .../>*                 ← 이 플레이트에 속한 인스턴스
 </plate>*
 <assemble> <assemble_item object_id="" instance_id="" transform="" offset=""/>* </assemble>
</config>
```

- **설정 오버라이드 값은 전부 `<metadata key value>` 쌍**. key가 곧 config-schema.json의 옵션 키.
- `<part>`의 `matrix`가 볼륨 로컬 변환.

### 1.3 `Metadata/project_settings.config` — 평면 JSON

병합 완료된 전체 설정 스냅샷. `{ "옵션키": "값" | ["필라멘트별 값", ...] }`.
벡터 옵션은 항상 문자열 배열. 이 파일 하나만 읽어도 슬라이싱 설정 재현 가능.

### 1.4 `Metadata/slice_info.config` — 슬라이스 결과 메타 (XML)

`<header>`(버전 등) + `<plate>`별 `<metadata key=prediction|weight|outside|support_used|
label_object_enabled|timelapse_type .../>` + `<filament id type color used_m used_g/>` +
`<warning msg/>` + `<object identify_id name skipped/>`.

### 1.5 왕복 호환 규칙

- 읽을 때 모르는 태그/속성/엔트리는 **버리지 말고 원본 바이트 보존** 후 다시 쓸 것.
- 레거시 `Metadata/Slic3r_PE*.config`(PrusaSlicer 계열)는 읽기 전용 호환.

---

## 2. 페인팅 데이터 코덱 (TriangleSelector)

원본: [TriangleSelector.cpp:1692](../slicer/src/libslic3r/TriangleSelector.cpp#L1692) `serialize`,
문자열화: [Model.cpp `FacetsAnnotation::get_triangle_as_string`](../slicer/src/libslic3r/Model.cpp).

### 2.1 개념

페인팅은 원본 삼각형을 재귀 분할한 트리로 저장한다. 삼각형별로 비트스트림을 만들고,
그 비트스트림을 16진수 문자열로 바꿔 3MF `paint_*` 속성에 넣는다.
**페인팅 안 된 삼각형(상태 NONE, 미분할)은 속성 자체가 없다.**

### 2.2 삼각형 하나의 비트스트림 (재귀)

```
triangle := split_info state? children*
split_info := 2비트 yy = 분할된 변 수 (0=리프, 1..3)
분할(yy>0)  : 2비트 xx = special side (1분할: 어느 변, 2분할: 유지된 변, 3분할: 무시)
             이후 자식 (yy+1)개를 역순으로 재귀 직렬화   ← PrusaSlicer 2.3.1 호환용 역순
리프(yy=0)  : 상태 n = EnforcerBlockerType
             n<=2  → 2비트 xx = n
             n>=3  → 2비트 xx = 0b11, 그다음 4비트 zzzz = n-3   (n 최대 16, 익스트루더 색)
```

상태 값: 0=NONE, 1=ENFORCER, 2=BLOCKER, 3+=익스트루더 인덱스(MMU 페인팅).

### 2.3 문자열 인코딩

비트스트림을 4비트 니블로 잘라 각 니블을 16진 문자(`0-9A-F`)로 변환하되,
**문자를 항상 문자열 앞에 삽입한다** — 즉 최종 문자열은 니블 역순이다.
디코딩은 문자열 끝에서 앞으로 읽으며 비트를 복원한다.
니블 내 비트 순서: `next_code = bit[3]<<3 | bit[2]<<2 | bit[1]<<1 | bit[0]` (LSB가 스트림 먼저).

JS 구현 시 검증 벡터: 미분할+ENFORCER 리프 = 비트 `00`(yy) + `01`(xx→ n=1) → 니블 `0100₂=4` → 문자열 `"4"`.

---

## 3. PlaceholderParser 표현식 언어 (EBNF)

원본: [PlaceholderParser.cpp](../slicer/src/libslic3r/PlaceholderParser.cpp) boost::spirit 문법(1880-2400행).
용도: ① 커스텀 G-code 슬롯 ② 프리셋 `compatible_printers_condition` / `compatible_prints_condition`.

```ebnf
template        = { text | macro } ;
macro           = "{" block "}" | legacy "[" variable "]" ;      (* [] 는 레거시 단순치환 *)
block           = if_block | switch_block | assignment | expr ;
if_block        = "if" expr "then"? body
                  { "elsif" expr body } [ "else" body ] "endif" ;
expr            = ternary ;
ternary         = or_expr [ "?" expr ":" expr ] ;
or_expr         = and_expr { ("or"  | "||") and_expr } ;
and_expr        = equality { ("and" | "&&") equality } ;
equality        = relational { ("==" | "!=" | "=~" | "!~") relational } ;
                                          (* =~ / !~ : 정규식 매치, 우변은 /regex/ 리터럴 *)
relational      = additive { ("<" | ">" | "<=" | ">=") additive } ;
additive        = multiplicative { ("+" | "-") multiplicative } ;
multiplicative  = unary { ("*" | "/" | "%") unary } ;
unary           = [ "-" | "+" | "!" | "not" ] factor ;
factor          = "(" expr ")" | literal | function_call | variable_ref ;
variable_ref    = ident [ "[" expr "]" ] ;                        (* 벡터 인덱싱 *)
literal         = int | float | bool | string | "/" regex "/" ;
function_call   = "min(a,b)" | "max(a,b)" | "random(lo,hi)"
                | "int(x)" | "round(x)" | "floor(x)" | "ceil(x)"
                | "digits(x,n[,m])" | "zdigits(x,n[,m])"
                | "is_nil(var)" | "size(vec)" | "empty(vec)"
                | "one_of(x, list...)" | "interpolate_table(x, (k,v)...)"
                | "regex_replace(subject, pattern, repl)"
                | "repeat" | "filament_change" ;                  (* G-code 전용 *)
assignment      = ["global"|"local"] ident "=" expr ;             (* 스크립트 변수 *)
```

- 값 타입: int, double, bool, string, 벡터(설정 옵션에서 옴). nullable 벡터의 nil은 `is_nil`로 검사.
- 설정 옵션 키가 곧 변수명이다 (`nozzle_diameter[0]`, `printer_notes=~/.*PRINTER_VENDOR_XX.*/`).
- 웹 구현은 재귀하강 파서 ~800줄 규모. 우선순위는 위 EBNF 순서 그대로.

---

## 4. 키보드 단축키 (KBShortcutsDialog.cpp 실측)

플랫폼별 ctrl=⌘(macOS). 전체 목록은 [KBShortcutsDialog.cpp](../slicer/src/slic3r/GUI/KBShortcutsDialog.cpp).

| 키 | 동작 | | 키 | 동작 |
|---|---|---|---|---|
| Ctrl+N/O/S | 새/열기/저장 프로젝트 | | M / R / S | 기즈모 이동/회전/스케일 |
| Ctrl+Shift+S | 다른 이름으로 저장 | | F | 면 바닥 정렬 |
| Ctrl+I | 지오메트리 임포트 | | C / B | 컷 / 메시 불리언 |
| Ctrl+R | 플레이트 슬라이스 | | P / H | 심 페인팅 / 퍼지스킨 |
| Ctrl+G | 슬라이스 파일 내보내기 | | T / U / Y / E | 텍스트/측정/어셈블/브림이어 |
| Ctrl+Z / Ctrl+Y | undo / redo | | A / Q | 전체 정렬 / 자동 방향 |
| Ctrl+X/C/V | 잘라내기/복사/붙여넣기 | | I / O | 줌 인/아웃 |
| Ctrl+A / Ctrl+D | 전체 선택 / 전체 삭제 | | V | 출력 가능 토글 |
| Ctrl+K | 선택 복제 | | 1-9 | 필라멘트/익스트루더 지정 |
| Ctrl+0~6 | 카메라 프리셋 뷰 | | ? | 단축키 목록 |
| Ctrl+P | 환경설정 | | L / C (프리뷰) | 단일 레이어 모드 / G-code 창 |
| Del/fn+⌫ | 선택 삭제 | | | |

---

## 5. 3D 렌더링 · 피킹 · 페인팅 상호작용 상세

전부 소스 실측. 웹(three.js/WebGL2) 재구현의 계약 문서다.

### 5.1 지오메트리 파이프라인 (Model → GPU)

```
ModelVolume.mesh (TriangleMesh)
  → GLVolume 생성 시 v.model.init_from(mesh)         (3DScene.cpp:836 → GLModel.cpp:436)
  → GLModel::Geometry 버텍스 버퍼
```

- **버텍스 레이아웃**: `EVertexLayout::P3N3` — position 3f + normal 3f 인터리브
  ([GLModel.hpp:38-47](../slicer/src/slic3r/GUI/GLModel.hpp#L38)). 인덱스는 UINT/USHORT/UBYTE 자동 축소.
- **GLVolume 1개 = ModelVolume × ModelInstance 조합 하나**. 변환은
  `m_instance_transformation`(인스턴스)과 `m_volume_transformation`(파트 로컬) **2단 분리 보관**
  ([3DScene.hpp:117-119](../slicer/src/slic3r/GUI/3DScene.hpp#L117)) — 최종 월드행렬 = instance ∘ volume.
- 부가 캐시: convex hull(배치·간섭 판정용), 변환된 bbox 3종, `SinkingContours`(베드 아래로
  가라앉은 부분의 윤곽 표시, flat 셰이더로 별도 렌더 — 3DScene.cpp:1060).
- **상태·색 팔레트는 GLVolume 정적 멤버**: `MODEL_COLOR[5]`(필라멘트 폴백), `MODEL_NEGTIVE_COL`,
  `MODEL_MIDIFIER_COL`, `SUPPORT_ENFORCER/BLOCKER_COL`, `MODEL_HIDDEN_COL`, `DISABLED/UNPRINTABLE` +
  호버 상태 `EHoverState {None, Hover, Select, Deselect}` (3DScene.hpp:85-110). 매 프레임
  `set_render_color()`가 (선택·호버·타입·필라멘트 색)을 조합해 최종 색 결정.
- 웹 매핑: `BufferGeometry`(pos+normal) 볼륨당 1개, `Object3D.matrix`에 2단 변환 합성,
  색은 머티리얼 유니폼. InstancedMesh는 동일 볼륨 다중 인스턴스일 때만.

### 5.2 셰이더 계약 (본체 = gouraud)

`_render_objects`가 사용하는 셰이더는 `gouraud` (폴백 확인: GLCanvas3D.cpp `_render_objects` 내부
`shader = get_shader("gouraud")`). 유니폼이 곧 기능 목록이다
([resources/shaders/110/gouraud.vs/.fs](../slicer/resources/shaders/110/)):

| 유니폼 | 기능 | 웹 재현 |
|---|---|---|
| `view_model_matrix, projection_matrix, view_normal_matrix, volume_world_matrix` | 변환 | three 기본 |
| `uniform_color` | 볼륨 색 (5.1의 set_render_color 결과) | material.color |
| `print_volume` (PrintVolumeDetection: type 0=Rect/1=Circle + xy_data/z_data) | **베드 밖 판정을 프래그먼트에서 실시간 계산 → 회색/경고 틴트** (`_render_objects`가 `set_print_volume` 주입, GLCanvas3D.cpp:8199-8214) | onBeforeCompile 셰이더 주입, 또는 단순화: CPU bbox 판정 후 머티리얼 스왑 |
| `extruder_printable_heights` | 익스트루더별 출력높이 초과 표시 | 〃 |
| `z_range`, `clipping_plane` | 단면 클리핑 (기즈모/어셈블 뷰) — fragment discard | material.clippingPlanes |
| `color_clip_plane` + 2색 | 클립면 기준 이중 색 (컷 기즈모) | 커스텀 |
| `slope` (SlopeDetection) | 오버행 경사 시각화 (법선 z 임계) | 커스텀 셰이더 |
| `is_outline`, `depth_tex`, `screen_size` | 선택 아웃라인 (깊이 비교 방식) | three OutlinePass로 대체 |

투명 볼륨(모디파이어 등)은 불투명 패스 후 별도 패스 (§가이드 6.5 렌더 순서). 렌더 전
`m_volumes`에 z_range/클리핑 플레인을 일괄 세팅한다 (GLCanvas3D.cpp:8226-8240).

### 5.3 피킹 (GPU 컬러피킹 아님 — CPU 레이캐스트)

- 진입: `SceneRaycaster` ([SceneRaycaster.hpp:40](../slicer/src/slic3r/GUI/SceneRaycaster.hpp#L40)) —
  Bed/Volume/Gizmo 그룹별 raycaster 목록, `encode_id/decode_id/base_id`(:115-119)로 히트 대상 식별.
- 개별 메시: `MeshRaycaster` ([MeshUtils.hpp:159](../slicer/src/slic3r/GUI/MeshUtils.hpp#L159)) —
  **`AABBMesh`(igl AABB 트리) 기반** `unproject_on_mesh`(마우스→역투영→트리 쿼리→히트점+법선),
  `closest_hit`. 즉 마우스 픽셀→월드 레이→BVH 순회가 매 프레임 호버에도 돈다.
- 웹 매핑: `three.Raycaster` + **three-mesh-bvh**(동일 가속 구조). id 인코딩은 불필요
  (three가 객체 참조를 돌려줌). 호버 하이라이트도 같은 캐시 전략(§5.4의 raycast cache) 사용.

### 5.4 페인팅 브러시 상호작용 (GLGizmoPainterBase — 서포트/심/MMU/퍼지스킨 공통)

전체 플로우 ([GLGizmoPainterBase.cpp](../slicer/src/slic3r/GUI/Gizmos/GLGizmoPainterBase.cpp)):

```
① 마우스 이동 → update_raycast_cache(mouse, camera, trafo_matrices)   (:158, 495, 603)
     모든 후보 볼륨에 레이캐스트 → 최근접 (mesh_id, hit점, facet번호) 캐시
② 드래그/클릭 → gizmo_event(action, mouse_pos, shift/alt/ctrl)        (:658)
③ 커서(브러시) 생성 — TriangleSelector::CursorType                    (TriangleSelector.hpp:52)
     CIRCLE(화면축 원기둥) | SPHERE(구, 기본값) | POINTER(삼각형 단위)
     | HEIGHT_RANGE(높이 구간) | GAP_FILL   ← BBS 확장
     프레임 간 이동은 Capsule2D/3D(DoublePointCursor, :209-223)로 이어 빈틈 방지
④ 적용 → TriangleSelector::select_patch(facet_start, cursor, new_state,
        trafo_no_translate, triangle_splitting, highlight_by_angle_deg,
        select_partially)                                             (TriangleSelector.hpp:306)
     시작 facet에서 BFS 확장, 커서 경계에 걸친 삼각형은 재귀 분할(triangle_splitting)
     → 브러시 경계가 삼각형 크기보다 정밀해짐. highlight_by_angle_deg = 오버행 한정 페인팅
⑤ 스마트/버킷 필: seed_fill_select_triangles(법선각 smart_fill_angle 이내 flood, :693,857)
     bucket_fill_select_triangles(:861-864), 휠로 각도 조절(:680), 업 시
     seed_fill_apply_on_triangles(new_state) 확정(:855)
⑥ 확정 → ModelVolume의 FacetsAnnotation에 직렬화(§2 코덱) + undo 스냅샷
⑦ 렌더 — TriangleSelectorGUI (GLGizmoPainterBase.hpp:33):
     상태별 GLModel 분리(m_iva_enforcers / m_iva_blockers / m_iva_seed_fills[3] /
     m_paint_contour, :71-79). 변경 시 update_render_data()가 페인트된 삼각형만
     재빌드해 본체 메시 위에 오버레이로 그림. MMU 다색은 triangle_patches(:109-111)
⑧ 클리핑 플레인 안쪽만 페인트 (get_clipping_plane_in_volume_coordinates, :805 부근)
```

**웹 재구현 지침**: 원본 메시는 불변으로 두고 ① three-mesh-bvh로 ①의 캐시 재현
② TriangleSelector 알고리즘(BFS+분할)을 JS 포팅 — 자료구조는 §2 코덱과 동일한 분할 트리라
직렬화까지 한 번에 해결 ③ 페인트 오버레이는 상태별 BufferGeometry 재구성(⑦과 동일 전략).
브러시 반경은 월드 단위(SPHERE)와 화면 단위(CIRCLE) 두 모드 다 지원해야 데스크톱과 감각이 같다.

### 5.5 렌더 루프 요약 (프레임 1장)

가이드 §6.5 패스 순서 + 위 계약을 합치면: 배경 → 베드/플레이트(그리드·로고·아이콘) →
불투명 볼륨(gouraud, print_volume 판정) → 선택 표시 → 투명 볼륨 → 순차간섭영역 →
활성 기즈모(+페인트 오버레이) → (SSAO/FXAA 선택) → ImGui 오버레이. 카메라는 target 중심
구면 궤도(가이드 §6.5.1). 호버는 매 프레임 CPU 레이캐스트(§5.3).

---

## 6. G-code 경로 계산 파이프라인 상세

슬라이스 결과(ExPolygon)가 실제 G1/G2 라인이 되기까지의 전 단계. 전부 소스 실측.

### 6.1 경로 데이터 모델 — ExtrusionEntity 계층

([ExtrusionEntity.hpp:165-179](../slicer/src/libslic3r/ExtrusionEntity.hpp#L165))

```
ExtrusionPath      = Polyline3(점열) + mm3_per_mm + width + height + role
                     + overhang_degree + smooth_speed
ExtrusionLoop      = ExtrusionPath 연속(닫힌 루프, 심 분할점 보유)
ExtrusionEntityCollection = 엔티티 트리. no_sort 플래그(:33)가 true면 순서 보존
```

**이 계층이 슬라이서의 "경로" 그 자체다.** 속도·E값은 여기 없다 — 방출 시점(§6.7)에 계산된다.
role 20종은 가이드 §9. 웹에서 프리뷰용 경로가 필요하면 G-code 텍스트를 다시 파싱하는 대신
이 계층을 직렬화하는 커스텀 export가 지름길이다.

### 6.2 폭→유량 수학 (Flow → E값)

- 단면적 공식 ([Flow.cpp:219-230](../slicer/src/libslic3r/Flow.cpp#L219)):
  - 일반 압출: `mm3_per_mm = h × (w − h(1 − π/4))` — 스타디움(직사각형+반원 끝) 단면
  - 브리지: `mm3_per_mm = π w²/4` — 원형 단면
- E값 변환 ([GCode.cpp:7382](../slicer/src/libslic3r/GCode.cpp#L7382), [Extruder.cpp:19](../slicer/src/libslic3r/Extruder.cpp#L19)):
  ```
  e_per_mm3 = filament_flow_ratio / 필라멘트단면적(π d²/4)
  e_per_mm  = e_per_mm3 × path.mm3_per_mm        (flow_ratio로 재나눔 :7383)
  dE        = e_per_mm × 세그먼트 길이             (:7900)
  ```
  상대 E(`use_relative_e_distances`)/절대 E 모드는 GCodeWriter가 처리.

### 6.3 벽 경로 생성 (PerimeterGenerator)

- `process_classic()` ([PerimeterGenerator.cpp:1159](../slicer/src/libslic3r/PerimeterGenerator.cpp#L1159)) —
  슬라이스 윤곽을 라인 스페이싱만큼 **반복 내측 오프셋**(Clipper) → wall_loops개 루프,
  남은 틈은 갭필 경로. 오버행 구간은 폴리라인 분할로 role 태깅(erOverhangPerimeter).
- `process_arachne()` (:2108) — Arachne 가변폭 알고리즘([src/libslic3r/Arachne/](../slicer/src/libslic3r/Arachne/)):
  스켈레톤 기반 bead 배치로 얇은 벽에서 폭을 연속 변화. ExtrusionPath의 width가 세그먼트마다 다름.
- 인필 경로: [Fill/](../slicer/src/libslic3r/Fill/) 패턴별 클래스가 표면 → 폴리라인 생성 후
  anchor(벽에 붙이는 짧은 연결)를 더해 ExtrusionPath로 변환 (내부 알고리즘은 패턴별, 요약 수준).

### 6.4 순서화와 심

- 최근접 체이닝: `chain_extrusion_entities(entities, start_near)`
  ([ShortestPath.hpp:21](../slicer/src/libslic3r/ShortestPath.hpp#L21)) — 이전 끝점에서 가장 가까운
  엔티티/방향 선택. `no_sort` 컬렉션(서포트 등)은 건너뜀.
- 심: `extrude_loop` → `m_seam_placer.place_seam(layer, loop, last_pos, …)` →
  `loop.split_at(seam점)` ([GCode.cpp:6626-6628](../slicer/src/libslic3r/GCode.cpp#L6626)) —
  루프를 심 위치에서 잘라 열린 경로로 만든 뒤 방출. scarf joint도 여기서 시작.
  (SeamPlacer 내부 스코어링 — 가시성·각도·정렬 — 은 [SeamPlacer.cpp](../slicer/src/libslic3r/GCode/SeamPlacer.cpp), 요약 수준.)

### 6.5 트래블과 리트랙션

([GCode.cpp:8254-8330](../slicer/src/libslic3r/GCode.cpp#L8254))

```
travel_to(point, role):
  needs_retraction(travel, role, lift_type) 판정 (:8263)
    — 최소 이동거리, 같은 아일랜드 내부 여부 등
  reduce_crossing_wall이면 AvoidCrossingPerimeters.travel_to로 벽 회피 경로 재계산 (:8327)
    — 우회로가 있으면 리트랙션 생략 가능(could_be_wipe_disabled)
  retract(:8556): 와이프(경로 되짚기) → 리트랙션 → z_hop(LiftType: 일반/경사/스파이럴)
```

### 6.6 속도 결정 (방출 시점, `_extrude` :7215)

우선순위 (관찰: GCode.cpp:7390-7465 부근):
1. role별 config 속도 (bridge_speed, ironing_speed, scarf_joint_speed로 캡 등)
2. 속도 미설정 시: `filament_max_volumetric_speed / mm3_per_mm` 로 역산 (:7430)
3. 첫 `slow_down_layers`층은 선형 보간 감속 (:7442+, raft 오프셋 고려)
4. **레이어 최소시간 감속은 여기가 아니라 CoolingBuffer 후처리**(§6.8)에서 G-code 재작성으로 적용

### 6.7 방출 (GCodeWriter)

- `extrude_to_xy(point, dE)` ([GCodeWriter.cpp:1094](../slicer/src/libslic3r/GCodeWriter.cpp#L1094)) → `G1 X.. Y.. E..`
- `travel_to_xy` (:749), `retract` (:1165)
- 아크 피팅 켜짐 + ArcSegment면 G2/G3 방출 ([GCode.cpp:7980](../slicer/src/libslic3r/GCode.cpp#L7980),
  [GCodeWriter.cpp:1116](../slicer/src/libslic3r/GCodeWriter.cpp#L1116)) — 경로는 사전에 ArcFitter가 원호 근사

### 6.8 레이어 후처리 파이프라인 (확정 순서)

TBB parallel_pipeline ([GCode.cpp:4223-4231](../slicer/src/libslic3r/GCode.cpp#L4223)):

```
generator(레이어 G-code 생성)
  → [spiral_mode]           켜진 경우: 레이어 경계 없는 나선 Z로 재작성
  → [pressure_equalizer]    켜진 경우: 압출률 변화 평활화
  → cooling                 CoolingBuffer: 레이어 시간 계산→감속/팬속도 재작성 (항상)
  → fan_mover               팬 명령 시간축 이동 (항상)
  → [adaptive PA processor] 어댑티브 압력어드밴스 주입
  → output stream
```

즉 **속도·팬의 최종값은 경로 계산이 아니라 텍스트 후처리에서 확정**된다. 웹에서 시간
추정을 재현하려면 GCodeProcessor(가이드 §9.1)를 쓰는 게 정확한 이유가 이것이다.

**30단계 — output 스트리밍 회귀(OOM 내성).** 원본은 위 파이프라인이 레이어 단위로 흘러 `output stream` 으로
빠져나간다(전체 상주 안 함). 미니커널은 그간 전체 `gw.s`(g-code 문자열)+전체 `layersArr`(툴패스)를 상주시킨 뒤
PE·GCodeProcessor 가 전체 문자열을 재파싱(A3 삼중 상주)했다 — 대형 모델 OOM 원인. 30단계에서 레이어 싱크
(`set_layer_sink`)로 레이어마다 청크 방출+힙 해제, GCodeProcessor 는 `process_buffer` 청크 피드(원본이 스트리밍
파서), 뷰어는 transferable 로 즉시 인출. 스트리밍 조립본 = 배치 byte-identical(절대 조건, `golden_stream.mjs`).
힙 피크: batch 126.9MB→stream 107.1MB→**economy 16.4MB(87%↓)**(318k세그, `bench_heap.mjs`).

**OOM 시나리오 표(S-A~S-E)** — 30단계 대응:

| ID | 압박 지점 | 대응(30단계) |
|----|-----------|--------------|
| S-A1/A2/A3 | 커널 전체 g-code 문자열 · 전체 툴패스 · 후처리 삼중 상주 | 레이어 스트리밍 방출+해제, PE/GCodeProcessor 청크 피드(A3 제거) |
| S-B1/B2 | Worker→메인 전달 · JS 사본 상주 | transferable 이전(worker 사본 즉시 해제), 메인 청크 소비 |
| S-B3 | g-code 텍스트 상주(다운로드용) | 청크 배열 보관(OPFS append 는 옵션·유예) |
| S-C2 | 플레이트 결과 텍스처 상주 | 선택 외 플레이트는 캐시(레이어 데이터)만, 텍스처는 전환 시 재빌드 |
| S-D2/A6 | OOM/행 | 감지 3종(worker error·WASM abort·60s 워치독)→워커 재생성→절약 재슬라이스(g-code만)→간소화 제안 |
| S-E1 | 전체 플레이트 순차 중 실패 | 완주 플레이트 g-code 보존·제공, 부분 g-code 는 미제공 |

### 6.9 웹 매핑 판단

이 파이프라인(§6.3-6.8)은 Clipper 오프셋·Arachne·심 스코어링이 얽힌 **WASM 트랙 영역**
(가이드 §10 트랙 C) — JS 재구현 비권장. 인수 기준은 골든 G-code byte-diff(가이드 §11.7).
웹이 직접 필요로 하는 것은 ① E값/단면적 수학(§6.2 — 프리뷰 두께 재현) ② ExtrusionEntity
직렬화(§6.1 — 프리뷰 데이터) ③ 후처리 순서 지식(§6.8 — 시간 추정 검증) 세 가지다.

---

## 7. libvgcode 툴패스 렌더링 원본 알고리즘 (섹션 분해)

원본: [src/libvgcode/](../slicer/src/libvgcode/) — SegmentTemplate.cpp, Shaders.hpp `Segments_Vertex_Shader`. 전부 실측.

### 7.1 데이터 모델 — CPU는 지오메트리를 만들지 않는다
- `PathVertex`(PathVertex.hpp:17): G-code 무브 끝점당 1개 — position, **height, width**, feedrate, role, type…
- GPU 업로드는 **텍스처 버퍼(TBO)**: `position_tex`, `height_width_angle_tex`(x=높이,y=폭,z=다음 세그먼트와의 조인 각도,w=z-fighting bias), `color_tex`, `segment_index_tex`(가시 세그먼트 인덱스만).

### 7.2 지오메트리 — 8정점 템플릿 × GPU 인스턴싱
SegmentTemplate.cpp:17 (원본 주석 그대로):
```
     /1-------6\
    / |       | \
   2--0-------5--7      ← 단면은 다이아몬드(상·하·좌·우), 2/7 = 앞뒤 "스파이크"
    \ |       | /
      3-------4
```
세그먼트당 고정 24인덱스(8삼각형) 템플릿 하나를 `glDrawArraysInstanced(TRIANGLES, 24, 세그먼트수)`(:81)로 반복 — **CPU 정점 버퍼가 세그먼트 수와 무관**(메모리 O(1) 지오메트리 + TBO만 O(n)).

### 7.3 정점 셰이더 확장 (핵심 수학, Shaders.hpp)
1. `gl_InstanceID` → segment_index_tex → PathVertex a, b=a+1 페치
2. `line_dir` 계산 — **수직선 가드**: `|dot(dir,UP)|>0.9`면 right=cross(X축,dir) (퇴화 방어를 셰이더가 직접)
3. **뷰 의존 하프박스**: 카메라가 옆/위 어느 쪽인지에 따라 코너 부호 테이블 16개 중 8개 선택 — 카메라를 향한 절반 면만 생성 (오버드로 절반)
4. 코너 = endpoint ± half_width·right ± half_height·up
5. **마이터 조인**: 스파이크 정점(2/7)을 `sin(|θ|/2)·dir + sign(θ)·cos(|θ|/2)·right` 만큼 이동(θ=사전계산된 이웃 세그먼트 각도) → 코너에서 이웃 비드와 정확히 맞물림. 이음 없는 끝은 POINTY_CAPS로 half_width 뾰족 캡
6. **Orca 확장: `eye_position.z += bias`** — z-fighting을 (월드가 아닌) **뷰공간 z bias**로 회피. 원본도 이 문제를 명시적으로 다룬다
7. 라이팅: 고정 2광원(top/front) 디퓨즈+스펙큘러, 법선은 `normalize(pos−endpoint)` 근사

### 7.4 우리 뷰어(`toolpath_gpu.js`)와의 구조 차이 — 24단계에서 원본 방식으로 정합
원래 손수 만든 CPU 리본 빌더(직육면체·w/2 근사·월드 ε)는 거대 평면 아티팩트를 반복 유발 → 24단계에서 **원본 알고리즘
그대로 포팅**해 아래 모든 항목을 원본과 일치시켰다. (WebGL2 제약상 표현만 다른 항목은 "원본 의미 보존"으로 표기.)
| | 원본 libvgcode(데스크톱 OpenGL) | 현 뷰어(24단계, WebGL2) |
|---|---|---|
| 지오메트리 | GPU 인스턴싱(8정점 템플릿, 24인덱스) | 동일 — `InstancedBufferGeometry`(vertex_id_float) |
| 단면 | 다이아몬드+앞뒤 스파이크 | 동일(VERTEX_DATA 그대로) |
| 조인 | 마이터(atan2 각도 사전계산) | 동일(`buildSegmentData` 가 동일 산식) |
| 정점 셰이더 | `Segments_Vertex_Shader_ES`(GLSL ES 3.0) | 동일 포팅(`RawShaderMaterial` GLSL3) |
| 데이터 전송 | TBO(samplerBuffer) 또는 2D 텍스처 폴백 | 2D `DataTexture`+`texelFetch(tex_coord(id))` (원본 ES 폴백 경로와 동일) |
| z-fighting | 다이아몬드 단면 + position.z-=0.5h(뷰공간 bias 는 옵션 확장) | 동일 — 다이아몬드+z센터링으로 공면 원천 부재 |
| 메모리 | O(n) 텍스처 + O(1) 템플릿 | 동일(O(1) 지오메트리 + O(n) DataTexture) |
| 가시 범위 | 인덱스만 조절 | 세그먼트 인덱스 레이어순 → `instanceCount` O(1) |

---

## 8. 데스크톱 UI 전수 실측 — 뷰어 재현 로드맵

원본 UI를 파일:줄 단위로 전수 조사한 결과와 웹 뷰어가 따라가기 위한 섹션 정의. (2026-07-24 실측)

### S1. 상단 커스텀 타이틀바 — BBLTopbar.cpp:245-301  🟡 27단계(상단바+탭+열기; File메뉴/undo-redo 자리만)
로고 · File 메뉴 · 드롭다운 메뉴 · 저장 · **undo/redo 버튼** · 창 제어.
→ 뷰어: 파일/저장/undo·redo 버튼 바. (뷰어의 "헤더 제거"는 빌더 나열 제거였을 뿐 — 데스크톱은 상단바가 있다.)
→ **뷰어(27단계)**: ~44px 상단바 = 로고 "OrcaSlicer RE" + 열기 · 중앙 Prepare|Preview 탭 · undo/redo 자리(비활성+툴팁). File 메뉴/창 제어 미룸.

### S2. 뷰 전환 — ECanvasType 3모드 (GLCanvas3D.hpp:510)  ✅ 25단계 구현(Prepare|Preview)
Prepare | Preview | Assemble. assemble_view_toolbar(GLCanvas3D.cpp:1172)로 전환. 어셈블은 후순위.
→ **뷰어(25단계 완료)**: 좌상단 Prepare|Preview 토글, 슬라이스 완료 시 자동 Preview, Preview 에서 기즈모/페인팅 게이팅.
  Assemble 는 후순위 유지.

### S3. 툴바 3종  🟡 27단계(좌측 기즈모 레일 4종 + 뷰포트 add/delete + arrange/orient 비활성)
상단 메인(add/addplate/arrange/orient/split/layersediting…) · 좌측 기즈모 23종 · **collapse_toolbar**(사이드바 접기, :1356).
arrange/orient 는 백엔드(libslic3r Arrange/Orient) 이식 필요 — 버튼 비활성+툴팁이 정직한 1단계.
→ **뷰어(27단계)**: 좌측 세로 레일 = 이동/회전/스케일/서포트페인팅(원본 toolbar_*_dark.svg). 뷰포트 상단 = 추가·선택삭제 + arrange/orient
  비활성("백엔드 이식 예정" 툴팁). split/layersediting/collapse·기즈모 23종 나머지 미룸.

### S4. 사이드바 (Plater.cpp:655-800 멤버 실측, 위→아래)  🟡 27단계(프린터/필라멘트/프로세스/오브젝트 + 하단 버튼바)
→ **뷰어(27단계)**: 우측 사이드바 = ① 프린터(베드·노즐 표시) ② 필라멘트(색 스와치+T행+/−, 색→오브젝트 반영) ③ 프로세스(설정 패널 임베드)
  ④ 오브젝트 리스트(출력토글 눈알·이름·T셀렉터·삭제 = 컬럼 6종 중 4종) ⑤ 하단 [슬라이스▾]+[G-code 내보내기]. 콤보(프리셋)·AMS·flushing·
  ObjectSettings/ObjectLayers·plate/all 분기·send_gcode 미룸(프리셋 시스템·커널 per-object 선행).
1. 프린터 섹션: 타이틀+아이콘, connect·sync·setting 버튼, 프린터 콤보, 노즐 직경/타입, 베드 타입, 익스트루더 그룹(단일/듀얼)
2. 필라멘트 섹션: 타이틀+개수, add/del/AMS/set 버튼 4종, 필라멘트 콤보 목록(combos_filament[]), purge_mode·flushing_volume 버튼(플러시 매트릭스)
3. 프로세스 섹션: combo_print(프리셋 콤보) + ParamsPanel 임베드(sizer_params)
4. 검색바(m_search_bar) + SearchObjectDialog (Ctrl+F)
5. **ObjectList 트리 — 컬럼 6종** (GUI_ObjectList.cpp:406-413): 이름·출력토글(colPrint)·필라멘트·서포트페인트(colSupportPaint)·싱킹(colSinking)·편집(colEditing)
6. **ObjectSettings**(오브젝트별 오버라이드) + **ObjectLayers**(높이 구간별 설정)
7. 하단 버튼: btn_reslice(**plate/all 분기** — on_action_slice_all, Plater.cpp:5625) · btn_export_gcode · btn_send_gcode(프린터 전송, 웹 범위 외)

### S5. 파라미터 패널 — ParamsPanel.cpp  🟡 25단계 부분(toggle-rules 일부 + dirty/리셋)
- **`Global | Objects` SwitchButton** (:265-267) — 전역 설정 ↔ 선택 오브젝트 오버라이드 전환 (핵심 UX) — **미구현**(커널 per-object 선행)
- m_tab_print/filament/printer 임베드, mode 스위치(Simple/Advanced/Expert)
- 프리셋 대비 변경값 표시(dirty) + 리셋 화살표, toggle-rules 기반 활성/비활성
→ **뷰어(25단계)**: `toggle_eval.js` 가 toggle-rules 조건식을 JS 번역(로컬 인라인) — 완전 번역 가능한 규칙만 적용(회색+툴팁),
  enum 비교·미지 로컬은 fail-open. **dirty 주황점+↺리셋**(기준=default). 전체 231규칙 완역·Global|Objects 스위치는 미룸.

### S6. Preview 뷰  🟡 25단계 대부분(뷰타입 6/11 + 이중 슬라이더 + 역할 범례)
- 수직 슬라이더 = **lower/higher 이중 값**(IMSlider.hpp:68-73, 범위 표시 + one-layer 모드) + 수평 무브 슬라이더 별도
- 뷰 타입 11종 컬러링(가이드 §9) — GPU 렌더러(§7 포트)가 color 텍스처 구조라 재계산만으로 전환 가능
- 역할별 범례(시간·비율 — GCodeProcessor 결과에 이미 있음)
→ **뷰어(25단계)**: 이중 슬라이더(lower/higher+단일레이어; instanceCount 컷+셰이더 layer_lo 클립, O(1)) ✅. 뷰 타입
  **6종**(Feature/Speed/Height/Width/Fan/Temp) — 원본 `DEFAULT_RANGES_COLORS`+`get_color_at` 포팅, color 텍스처만
  재계산 ✅. Speed/Fan/Temp 는 커널 미보유라 설정값 유도(근거 기록). 역할 범례 = **길이 비율**(시간 비율은 커널 role
  export 필요 → 보류). 남은 5종 뷰(ActualSpeed/PA/Accel/Jerk/VolFlow 등)·수직 방향 CSS·수평 무브 슬라이더 미룸.

### S7~S9. 플레이트 시스템(PartPlate — 다중 플레이트+이름표+아이콘) · 단축키(§4 표)+undo/redo · 알림 토스트
🟡 **S7 1차판 — 29단계** (뷰어 오케스트레이션, 커널 무변경): N개 플레이트(1행 그리드, 상단 툴바 추가/삭제, 이름표 1·2·3…) · 위치 기반 소속(오브젝트 원점이 얹힌 플레이트 사각형) · 플레이트 클릭 선택(테두리 강조) · [슬라이스 ▾]→현재/전체 · 전체=플레이트별 순차 슬라이스+개별 `plate_N.gcode` 다운로드(zip 없음) · 프리뷰=선택 플레이트 캐시 결과(전환 시 교체). 각 플레이트는 좌표를 로컬로 넘기고 G-code 오프셋=플레이트 원점+베드/2(28단계 좌표 계약 유지). **유예**: per-플레이트 설정 오버라이드 · lock/아이콘 · 자동 배치.

### 권장 구현 순서  (진행: ✅S6 대부분 · ✅S2 · 🟡S5 일부 · 🟡S7 1차 — 29단계)
S6(이중 슬라이더+뷰타입: 데이터 준비됨) → S5(스위치+toggle-rules+dirty) → S2(뷰 분리) → S4-5·6(ObjectList 컬럼+ObjectLayers — 커널 per-object 확장 포함) → S4-1~3(**프리셋 시스템 = 분수령**: 66벤더 로드+inherits+expr 평가기) → S1(상단바+undo/redo) → S3 → S7(플레이트).

---

## 9. 미구현 기능 전수 목록 (2026-07-25 기준)

28단계 시점의 갭 인벤토리. 근거: README 단계별 유예 기록 전수 + settings.js/커널 실측(매핑 42키·커널 파라미터 57개).

### A. 슬라이싱 커널
1. **커스텀 G-code 슬롯 전체 + PlaceholderParser 미포팅** — 시작/종료/레이어체인지/필라멘트체인지 커스텀 불가 (EBNF 스펙은 §3에 존재, 커널은 고정 프리앰블)
2. 인필 패턴: 데스크톱 26종 중 ~10종 (원본 이식 5 + 자체 근사 4 + gyroid_approx). 미이식: adaptive cubic·lightning(스파스 경로)·monotonic 표면·hilbert 계열 등
3. **가변 레이어 높이**(adaptive layer height) 없음
4. **per-object/per-region 설정 + layer_config_ranges** 없음 (전역 1세트 — Global|Objects 스위치의 선행 조건)
5. WipeTower: 다층 스케줄링·rib 메시·PlaceholderParser 토큰 (레이어별 독립 생성)
6. PE 기본값 lite (원본 PE는 옵트인), 벽회피 실패 케이스 잔존, 스파이럴 바닥 개방, zigzag 오목 갭 횡단
7. 멀티머티리얼 고급: 그룹별 셸/서포트/아이어닝 미분리, 플러시 볼륨 행렬·램밍 없음
8. 브림 세분(ears/outer-inner), 드래프트 실드, 프라임타워 위치/크기 파라미터 일부 하드코딩(§감사 참조)
9. non-planar — 데스크톱에도 없음(범위 외 확정)

### B. 설정 표면 (최대 갭)
- 매핑 42키 / 907옵션 (**4.6%**) — 커널 파라미터 57개가 상한. 미매핑 대군: 온도 세부(챔버·아이들), 리트랙션 세부(wipe·lift 방향), accel/jerk 개별, 최소 레이어시간 세부, top/bottom 표면 패턴 선택, 시퀀스·타임랩스, 정밀도(슬라이스 갭 클로징·해상도) 등 대부분
- coFloatOrPercent의 ratio_over 참조 체인 일반화 안 됨(노즐 기준 %만), 벡터 옵션 첫 원소만 편집, "0=auto" 일부만

### C. 프리셋/프로파일 시스템 — 전부 미구현 ⭐분수령
66벤더 로드·inherits 해석·compatible 조건(expr 평가기)·프리셋 콤보 3종·사용자 프리셋 저장·dirty 기준을 프리셋으로(현재 스키마 default 기준)

### D. 프로젝트/포맷
3MF **프로젝트** 저장/복원(설정·배치·페인팅 왕복 — §1 스펙 존재), STEP(OCCT)·DRC(Draco) 임포트, G-code 임포트(뷰어 전용 모드), 프로젝트 저장 기능 자체

### E. UI (SPECS §8 잔여)
undo/redo(자리만) · ~~기즈모 변환 후 자동 재안착~~ **✅29단계**(드래그 커밋 시 minZ→0 재안착, 이동·회전·스케일; 원본과 차이는 싱킹 미지원 한 줄 — 원본은 sinking(minZ<0) 유지, 우리는 슬라이스 음수z 불가로 minZ≠0이면 0으로 스냅) · arrange/orient(백엔드 필요) · ObjectSettings/ObjectLayers(A-4 선행) · Global|Objects 스위치 · **플레이트 시스템(S7 🟡1차 완 — 29단계, per-플레이트 설정·lock·자동배치 잔여)** · File 메뉴 · 단축키 대부분(§4 표) · 카메라 프리셋(Ctrl+0~6)/뷰 큐브 · 알림 토스트 · AMS/플러싱 다이얼로그 · **수평 무브 슬라이더** · 옵션 마커(심/리트랙션/툴체인지 표시)

### F. 페인팅
심/MMU 색/퍼지스킨 페인팅 미구현(서포트 enforcer/blocker만 — TriangleSelector 기반은 이식 완료라 확장 가능) · 커서 종류 SPHERE만(CIRCLE/POINTER/HEIGHT_RANGE/GAP_FILL 미구현) · 언더뷰 브러시 조준 러프엣지

### G. 프리뷰
뷰 타입 잔여 5종(ActualSpeed/PA/Accel/Jerk/VolFlow) · **Speed/Fan/Temp가 실측 아닌 설정 유도값**(커널 per-segment feedrate/tool export 필요 — Tool 뷰 색 포함) · role별 시간 분해 표시 · G-code 텍스트 뷰·라인↔툴패스 연동

### H. 캘리브레이션
12종(PA/Flow/Temp/VFA/Retraction/Input Shaping/Cornering…) 전부 미구현 — calib.cpp는 UI 독립적이라 이식 후보

### I. 범위 외 선언 (구현 대상 아님)
Device/네트워크/멀티디바이스·프린터 전송·클라우드 — 데스크톱의 프린터 연동 계층
