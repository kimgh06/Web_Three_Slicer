# OrcaSlicer 리버스 엔지니어링 가이드 — 웹/npm 패키지화

> 대상: OrcaSlicer 코드베이스(C++17, wxWidgets, CMake)를 분석해 **npm에서 동작 가능한 패키지 군(群)** 으로
> 재구성하려는 개발자. 모든 파일 참조는 이 저장소 기준이며 `파일:줄번호` 형식이다.
> 조사 기준 커밋: `607648c61f` (main).

---

## 목차

1. [아키텍처 총람](#1-아키텍처-총람)
2. [런타임 동작 원리](#2-런타임-동작-원리)
3. [핵심 데이터 모델](#3-핵심-데이터-모델)
4. [설정(Config) 시스템 — 최우선 추출 대상](#4-설정config-시스템)
5. [프리셋 시스템과 프로파일 데이터](#5-프리셋-시스템과-프로파일-데이터)
6. [UI 구성 전체 분해](#6-ui-구성-전체-분해)
7. [데이터 영속성 (디스크/프로젝트 파일)](#7-데이터-영속성)
8. [슬라이싱 파이프라인](#8-슬라이싱-파이프라인)
9. [G-code 처리와 프리뷰](#9-g-code-처리와-프리뷰)
10. [npm 패키지화 전략](#10-npm-패키지화-전략)
11. [추출 레시피 (실행 가능한 절차)](#11-추출-레시피)
12. [로드맵과 난이도표](#12-로드맵과-난이도표)
13. [부록: 주요 파일 인덱스](#13-부록-주요-파일-인덱스)

---

## 0. 바로 시작하기 (핸드오프 체크리스트)

이 문서를 받은 사람이 Day 1에 할 일. 저장소 없이 문서만으로는 부족하고,
**이 저장소 + [reverse_engineering/](reverse_engineering/) 산출물**이 세트다.

1. §1(아키텍처)·§2(런타임) 읽기 — 30분. 나머지는 필요할 때 찾아 읽는 참조서다.
2. `reverse_engineering/` 4개 JSON을 열어 구조 확인 — 웹 구현의 입력 데이터가 이것이다.
3. 모노레포 생성 후 §10.2 패키지 뼈대 잡기. 첫 스프린트 = §12 로드맵 1–4번:
   - `@orca/config-schema`: config-schema.json + d.ts 생성기 (이미 데이터 있음, 하루)
   - `@orca/ui-map`: ui-tree.json + toggle-rules.json 번역 (§4.3 위젯 매핑 규칙)
   - `@orca/presets`: `resources/profiles/` 복사 + §5.4 상속 해석기
   - 설정 폼 제너레이터: schema × ui-map 조인 → React 폼
4. 각 패키지는 §11.7 인수 기준을 CI 테스트로 먼저 박고 시작할 것.
5. 슬라이싱은 처음부터 WASM 하지 말 것 — CLI 서버(§10.1 트랙 C)로 동작부터 확보.

막히는 곳이 생기면: 파일 인덱스(§13)에서 해당 영역 원본 파일을 열고, 산출물 JSON의
`line` 필드로 정확한 소스 위치로 점프한다.

---

## 1. 아키텍처 총람

OrcaSlicer는 3계층 구조다. **UI를 걷어내도 슬라이싱 코어가 완전히 독립적으로 동작**하며,
CLI(`--slice`)가 그 증거다.

```
┌─────────────────────────────────────────────────────────────┐
│  src/slic3r/GUI/          GUI 계층 (wxWidgets + ImGui + GL)   │
│  - MainFrame/Plater/Tab   창·탭·사이드바                       │
│  - GLCanvas3D/Gizmos      3D 뷰포트, 모델 조작                  │
│  - GCodeViewer            프리뷰 (libvgcode 위임)               │
├─────────────────────────────────────────────────────────────┤
│  src/slic3r/               GUI-코어 접착 계층                   │
│  - BackgroundSlicingProcess  워커 스레드에서 Print::process 실행 │
│  - Utils/UndoRedo            cereal 직렬화 스냅샷               │
├─────────────────────────────────────────────────────────────┤
│  src/libslic3r/            코어 (UI 의존성 없음) ★ 포팅 대상     │
│  - Model.*                 3D 모델 트리                        │
│  - Config/PrintConfig      907개 옵션 정의 + 값 컨테이너         │
│  - Preset/PresetBundle     프리셋 로딩·상속·호환성               │
│  - Print/PrintObject       슬라이싱 파이프라인                   │
│  - GCode/*                 G-code 생성·후처리                   │
│  - Format/*                3MF/STL/OBJ/STEP 입출력             │
├─────────────────────────────────────────────────────────────┤
│  src/libvgcode/            G-code 시각화 전용 독립 라이브러리 ★   │
└─────────────────────────────────────────────────────────────┘
```

의존성 (deps/): Boost, TBB, Eigen, CGAL, OpenVDB, OCCT(STEP), Clipper, Cereal,
wxWidgets, GLEW/GLFW, CURL, OpenSSL, Draco 등. **WASM 포팅 시 병목은 TBB(스레드),
CGAL/OpenVDB(무거움), OCCT(사실상 포기 대상)**.

Emscripten/WASM 빌드 설정은 현재 저장소에 **존재하지 않는다** (CMakeLists 검색 결과 0건).

---

## 2. 런타임 동작 원리

### 2.1 시작 시퀀스

```
main (src/OrcaSlicer.cpp)
 └→ GUI_App::OnInit (src/slic3r/GUI/GUI_App.cpp:2672)
     └→ on_init_inner (GUI_App.cpp:2824)
         ├→ app_config = new AppConfig()            ← 전역 앱 설정 로드
         ├→ preset_bundle = new PresetBundle()       (GUI_App.cpp:3058)
         │    └→ system/user 프리셋 전체 로드, 상속 해석
         └→ mainframe = new MainFrame()              (GUI_App.cpp:3324)
              └→ Plater, Tab(Print/Filament/Printer), 웹뷰 홈 생성
```

### 2.2 편집→슬라이스→프리뷰 루프 (앱의 심장)

```
사용자 편집 (모델 이동, 설정 변경, 프리셋 전환)
  → Plater::priv::update_background_process (Plater.cpp:8884)
      → Print::apply(Model, DynamicPrintConfig)     ← 차분 비교
          반환: UNCHANGED / CHANGED / INVALIDATED   (PrintBase.hpp:401)
          변경된 옵션이 어떤 파이프라인 단계를 무효화하는지 그래프로 판정
  → BackgroundSlicingProcess 재시작
      → 워커 스레드 thread_proc (BackgroundSlicingProcess.cpp:330)
          → process_fff (같은 파일:192) → Print::process() → G-code 내보내기
  → wxWidgets 이벤트로 UI 통지
      EVT_PROCESS_COMPLETED (Plater.cpp:208, 바인딩 6182)
  → GCodeProcessor 결과를 GCodeViewer(libvgcode)에 로드 → 프리뷰 탭 갱신
```

핵심 개념 — **증분 슬라이싱(invalidation)**: 각 설정 옵션은 자신이 무효화하는
단계(step) 집합을 가진다. `layer_height` 변경 → 전체 재슬라이스,
`skirt_loops` 변경 → psSkirtBrim만 재실행. 웹 포팅 시 이 무효화 그래프를 버리면
매번 풀 슬라이스라 UX가 죽는다. 그래프 자체는 `Print::invalidate_state_by_config_options`
(Print.cpp)와 `PrintObject::invalidate_state_by_config_options`(PrintObject.cpp)에 하드코딩돼 있다.

### 2.3 스레딩 모델

- GUI 스레드: wxWidgets 이벤트 루프
- 슬라이싱: BackgroundSlicingProcess 소유의 단일 워커 스레드
- 워커 내부: TBB `parallel_for`로 레이어/오브젝트 단위 병렬화 (`AGENTS.md`의 "TBB 공유 상태 주의" 항목)
- 취소: `Print::cancel()` → 각 단계가 체크하는 협조적 취소

웹 대응: 슬라이싱 = Web Worker + WASM pthreads(SharedArrayBuffer, COOP/COEP 헤더 필수).

---

## 3. 핵심 데이터 모델

### 3.1 Model 트리 (src/libslic3r/Model.hpp)

```
Model (Model.hpp:1531)                    ← 문서 루트. 3MF 하나와 대응
 ├─ ModelObject[] (Model.hpp:354)         ← 논리적 "오브젝트" (트리 좌측 항목)
 │   ├─ ModelVolume[] (Model.hpp:794)     ← 메시 실체. 타입: 모델/네거티브/모디파이어/서포트 차단·강제
 │   │   ├─ TriangleMesh                  ← 실제 지오메트리
 │   │   ├─ ModelConfigObject             ← 볼륨별 설정 오버라이드
 │   │   └─ 페인팅 데이터                   ← TriangleSelector 직렬화 (서포트/심/MMU/퍼지스킨)
 │   ├─ ModelInstance[] (Model.hpp:1256)  ← 배치 복제 (위치·회전·스케일)
 │   ├─ ModelConfigObject                 ← 오브젝트별 설정 오버라이드
 │   └─ layer_config_ranges               ← 높이 구간별 설정 오버라이드
 ├─ ModelMaterial[] (Model.hpp:161)
 └─ ModelWipeTower (Model.hpp:1429)
```

모든 노드는 `ObjectBase`(ObjectID.hpp:63)를 상속 → **전역 유일 정수 ID**를 가진다.
이 ID가 undo/redo 스냅샷 비교와 `Print::apply` 차분 비교의 키다.
웹 포팅 시에도 "노드마다 불변 ID" 설계는 그대로 가져가야 한다 (React key, 차분 슬라이싱 둘 다 필요).

### 3.2 설정 값의 5계층 오버라이드 체인

```
Printer 프리셋 → Filament 프리셋(×N개) → Process 프리셋
  → Plate 설정 → ModelObject.config → ModelVolume.config → layer_config_ranges
```

렌더링(어느 값이 이기는가)은 단순: **뒤쪽이 이긴다**. 병합 결과가
`DynamicPrintConfig`이고, 슬라이서에 들어가기 직전 `PrintRegion`(Print.hpp:115)
단위로 굳는다(같은 설정 조합을 공유하는 볼륨끼리 묶임).

### 3.3 undo/redo

- [src/slic3r/Utils/UndoRedo.cpp](../slicer/src/slic3r/Utils/UndoRedo.cpp) — cereal 직렬화 기반
- Model 전체를 스냅샷하되, TriangleMesh 등 무거운 객체는 ObjectID 기준 공유(중복 저장 안 함)
- `Snapshot{name, timestamp, model_id, SnapshotData}` (UndoRedo.hpp:74)

웹 대응: immer/Immutable.js 스타일 구조 공유가 정확히 같은 효과. 메시 blob은 ID로 참조만.

---

## 4. 설정(Config) 시스템

**이 프로젝트의 진짜 본체. 여기를 자동 추출하면 웹 UI의 90%가 자동 생성된다.**

### 4.1 규모

- 옵션 정의: **907개** (CLI·SLA·루프생성 포함 실측) — 전부 [PrintConfig.cpp](../slicer/src/libslic3r/PrintConfig.cpp) (12,688줄)의
  `PrintConfigDef` 생성자에서 `this->add("키", 타입)` 호출로 등록
- 카테고리 분포: Quality 96 · Support 59 · Strength 56 · Speed 44 · Advanced 21 ·
  Others 12 · Machine limits 10 · Extruders 8 · Flush options 3 · 미분류 34

### 4.2 옵션 메타데이터 스키마 — `ConfigOptionDef` (Config.hpp)

웹 폼 제너레이터의 입력 스키마가 그대로 정의돼 있다:

| 필드 | 의미 | 웹 매핑 |
|---|---|---|
| `type` | coFloat/coInt/coBool/coString/coEnum/coPercent/coFloatOrPercent/coPoint(s)/coStrings… | 입력 컴포넌트 종류 |
| `gui_type` | select_open, color, i_enum_open, f_enum_open, slider, one_string, legend | 컴포넌트 변형 |
| `label`, `full_label` | UI 라벨 | 라벨 |
| `category` | 검색/분류 | 검색 인덱스 |
| `tooltip` | 설명 | 툴팁 |
| `sidetext` | 단위 (mm, %, mm/s) | suffix |
| `min`, `max`, `max_literal` | 값 범위 | validation |
| `mode` | comSimple/comAdvanced/comExpert/comDevelop (Config.hpp:206) | 노출 필터 |
| `enum_values`, `enum_labels` | enum 값/표시명 | `<select>` |
| `multiline`, `full_width`, `is_code`, `readonly`, `height`, `width` | 레이아웃 힌트 | textarea/코드에디터 |
| `nullable` | 익스트루더별 벡터에서 "상속" 허용 | null 처리 |
| `aliases`, `shortcut` | 구버전 키 호환 | 마이그레이션 |
| `printer_technology` | FFF/SLA 구분 | 필터 |
| `cli` | CLI 인자명 | — |

값 컨테이너: `DynamicPrintConfig`(키→ConfigOption 맵, 프리셋·오버라이드용)와
`StaticPrintConfig` 계열(슬라이싱 핫패스용 구조체). 웹에서는 전자만 있으면 된다
(JS 객체 그 자체).

주의할 타입 2개:
- `coFloatOrPercent` — `"120%"` 또는 `0.4` 를 모두 허용, 퍼센트는 참조 옵션(대개 line width→노즐 직경) 기준으로 해석. JS에서 재현 필수.
- `coFloats`/`coBools` 등 벡터형 — **익스트루더/필라멘트 개수만큼의 배열**. 프리셋 병합 시 배열 리사이즈 규칙 존재(PresetBundle이 처리).

### 4.3 GUI 위젯 매핑 (재현 규칙)

[OptionsGroup.cpp:41-79](../slicer/src/slic3r/GUI/OptionsGroup.cpp#L41-L79) `build_field`가 유일한 분기점:

```
gui_type == select_open | i_enum_open  → Choice (콤보박스)
gui_type == color                      → ColourPicker
gui_type == slider                     → SliderCtrl
gui_type == one_string                 → TextCtrl
(이후 type 기준)
coFloat/coFloats/coPercent/coFloatOrPercent… → TextCtrl (+단위 suffix)
coBool                                 → CheckBox
coEnum                                 → Choice
coPoints                               → PointCtrl (좌표 목록; printable_area 등)
```

→ 웹에선 컴포넌트 8종이면 828개 옵션 전부 렌더링된다.

### 4.4 옵션 간 의존/토글 로직 — ConfigManipulation

[ConfigManipulation.cpp](../slicer/src/slic3r/GUI/ConfigManipulation.cpp) — `toggle_field` 호출 **198곳**.
"서포트 꺼지면 서포트 하위 옵션 전부 비활성", "spiral_mode 켜면 wall_loops 강제" 류의
활성/비활성/자동보정 규칙이 전부 여기 절차적 C++로 존재한다.

**자동 추출 불가.** 이 파일 하나(+ `update_print_fff_config`의 값 보정 다이얼로그)는
수작업으로 JSON 규칙표(`{ when: {enable_support: false}, disable: [...] }`)로 번역해야 한다.
분량은 크지 않다(파일 하나, 규칙 ~200개).

---

## 5. 프리셋 시스템과 프로파일 데이터

### 5.1 프리셋 타입 (Preset.hpp:208)

`TYPE_PRINT / TYPE_FILAMENT / TYPE_PRINTER` (+ SLA 계열, PHYSICAL_PRINTER, plate config)

### 5.2 디스크 레이아웃

```
resources/profiles/                     ← 시스템(벤더) 프리셋, 저장소에 포함
  <Vendor>.json                         ← 인덱스: name, version, machine_model_list,
  │                                        process_list, filament_list, machine_list
  └─ <Vendor>/{machine,process,filament}/*.json

<data_dir>/user/<user_id>/{machine,process,filament}/*.json   ← 사용자 프리셋
  (PRESET_USER_DIR = "user", Preset.hpp:21; PresetBundle.cpp:996)
<data_dir>/OrcaSlicer.conf              ← 앱 설정(JSON). 구버전 .ini 폴백 (AppConfig.cpp:1752)
```

### 5.3 프리셋 JSON 구조 (실측: Elegoo process 프로파일, 92키)

```json
{
  "type": "process",             // machine | process | filament
  "name": "...",
  "inherits": "부모 프리셋 이름",   // 상속 체인
  "from": "system",
  "instantiation": "true|false", // false = 추상 부모(UI 비노출)
  "compatible_printers_condition": "printer_notes=~/.../ and nozzle_diameter[0]==0.4",
  "...나머지는 전부 옵션 키": "값(전부 문자열 또는 문자열 배열)"
}
```

### 5.4 상속 해석 알고리즘 (웹 재구현 대상, ~200줄)

```
resolve(preset):
  chain = []
  while preset:  chain.push(preset); preset = find(preset.inherits)
  config = {}
  for p in chain.reverse():  Object.assign(config, p.options)   // 자식이 이김
  벡터 옵션은 익스트루더 수에 맞춰 리사이즈
```

참조 구현: `PresetBundle::load_presets` / Preset.hpp:320-335 (`inherits()`, `normalize_inherits`).
`compatible_printers_condition`은 PlaceholderParser 표현식이므로 §9의 표현식 평가기가 필요하다.

**중요**: 벤더 JSON은 이미 웹 친화적이다. 828옵션 스키마 덤프(§11.1)와 이 해석기만 있으면
66개 벤더 전 프린터의 프로파일 시스템이 브라우저에서 그대로 돈다.

---

## 6. UI 구성 전체 분해

### 6.1 최상위 (MainFrame.cpp:1315-1354)

| 탭 | 구현 | 웹 포팅 판단 |
|---|---|---|
| Home | wxWebView (HTML) | 이미 웹. 참고만 |
| Prepare / Preview | Plater | **핵심 대상** |
| Device | 프린터 모니터(MQTT/Bambu 폐쇄 플러그인 의존) | 범위 제외 권장 |
| Multi-device | 다중 프린터 큐 | 범위 제외 권장 |
| Project | 프로젝트 첨부파일 | 후순위 |
| Calibration | 캘리브레이션 마법사 (§6.5) | 후순위 |

### 6.2 Plater(작업 화면) 구조

```
Plater
 ├─ GLCanvas3D (좌, 3D 뷰포트)
 │   ├─ 상단 메인 툴바: add/addplate/arrange/orient/splitobjects/splitvolumes/
 │   │                  layersediting/assembly_view/more·fewer  (GLCanvas3D.cpp)
 │   ├─ 좌측 기즈모 툴바: 23종 (src/slic3r/GUI/Gizmos/) — 기존 분석 그룹:
 │   │    변환(Move/Scale/Rotate/Flatten) · 페인팅(FdmSupports/Seam/MmuSegmentation/FuzzySkin)
 │   │    메시편집(Cut/AdvancedCut/MeshBoolean/Simplify) · 생성(Emboss/SVG/Text)
 │   │    측정(Measure/Assembly) · 기타(BrimEars/FaceDetector) · SLA(SlaSupports/Hollow)
 │   ├─ 렌더링: GLSL 셰이더 18쌍 (resources/shaders/110/: gouraud, phong, flat,
 │   │    printbed, variable_layer_height, ssao, fxaa, imgui …)
 │   └─ 오버레이 UI: ImGui (기즈모 패널, 알림, DailyTips)
 ├─ Sidebar (우, Plater.cpp:655-691)
 │   ├─ 프린터 프리셋 콤보 + 편집/연결 버튼 + 프린터 이미지
 │   ├─ 노즐 직경/타입 콤보, 베드 타입 콤보
 │   ├─ ExtruderGroup (single / left+right 듀얼)
 │   ├─ 필라멘트 목록 (색·프리셋 콤보, AMS 연동)
 │   ├─ Process 프리셋 콤보 + ParamsPanel(설정 트리 임베드)
 │   └─ ObjectList (wxDataViewCtrl 트리, GUI_ObjectList.hpp:85)
 └─ 하단: 슬라이스/내보내기 버튼, 플레이트 목록
```

### 6.3 설정 편집 UI — Tab 트리

구현: [Tab.cpp](../slicer/src/slic3r/GUI/Tab.cpp) (8,943줄). 구조는
`Tab → add_options_page(페이지) → new_optgroup(그룹) → append_single_option_line(옵션키)`
3단 트리. **전체 트리는 이 세션에서 추출 완료** (아래 요약, 상세는 §11.2 스크립트로 재생성):

- **TabPrint** (Process): Quality / Strength / Speed / Support / Multimaterial / Others (6페이지, ~50그룹, ~400옵션)
- **TabFilament**: Filament / Cooling / Advanced(G-code) / Multimaterial / Dependencies / Notes
- **TabPrinter**: Basic information / Machine G-code(12종 슬롯) / Motion ability(리밋+Input Shaping) / Multimaterial / Extruder(리트랙션·Z-hop) / Notes / Dependencies
- **Frequent** (Simple 모드 사이드바, Tab.cpp:3340): layer_height, sparse_infill_density, wall_loops, enable_support, curr_bed_type, 출력순서
- **Plate Settings** (Tab.cpp:3672): 베드타입, print_sequence, spiral_mode 등 6항목
- **Setting Overrides** (오브젝트/필라멘트 오버라이드, Tab.cpp:3995)

오브젝트 우클릭 메뉴의 "자주 쓰는 설정" 묶음: [GUI_Factories.cpp:56-97](../slicer/src/slic3r/GUI/GUI_Factories.cpp#L56-L97)
(`FREQ_SETTINGS_BUNDLE_FFF`: Quality/Shell/Infill/Support/Flush options).

### 6.4 커스텀 위젯 라이브러리

[src/slic3r/GUI/Widgets/](../slicer/src/slic3r/GUI/Widgets/) — wx 기본 위젯을 쓰지 않고 자체 스킨 위젯
(Button, CheckBox, ComboBox, DropDown, SpinInput, Slider, SwitchButton, TabCtrl,
ProgressBar, RadioGroup, TextInput 등 ~30종). **웹에선 전부 기성 컴포넌트로 대체** —
이 디렉토리는 스타일 참고(색·라운딩·상태)로만 쓰고 코드는 버린다.

### 6.5 Canvas(3D 뷰포트)에 반드시 들어가야 하는 것

캔버스는 3모드다 — `ECanvasType`(GLCanvas3D.hpp:510): `CanvasView3D`(Prepare) /
`CanvasPreview`(G-code) / `CanvasAssembleView`. 아래는 `GLCanvas3D::render()`
(GLCanvas3D.cpp:1940)의 실제 렌더 패스 전수 목록과 웹 포팅 판정.

**필수 (이게 없으면 슬라이서 캔버스가 아님):**

| 패스 | 원본 | 웹 구현 |
|---|---|---|
| 배경 그라데이션 | `_render_background` | CSS/클리어컬러 |
| **플레이트 시스템** | `_render_platelist` → PartPlate.cpp: `render_background/grid/exclude_area/height_limit/logo/icons/plate_name` (722–1227행) | Orca는 멀티플레이트 중심 UX. 플레이트 사각형+그리드+제외영역+높이제한+이름표+플레이트별 아이콘(잠금·설정)까지가 한 세트 |
| 베드 형상/원점 축 | `_render_bed`, Bed3D::render_axes/render_model (3DBed.cpp:373-) | 형상 데이터는 프린터 프리셋 `printable_area`(coPoints) + `bed_exclude_area` + 벤더 STL/텍스처 (PartPlate::set_shape, PartPlate.cpp:3217) |
| 모델 볼륨 (불투명→투명 2패스) | `_render_objects(Opaque/Transparent)` | 인스턴스별 변환, **필라멘트 색상별 렌더**, 빌드볼륨 밖 경고 틴트, 호버 하이라이트 |
| 선택 표시 | `_render_selection` (+바운딩박스) | three.js OutlinePass 또는 색상 오버라이드 |
| 활성 기즈모 | `_render_current_gizmo` | 최소 Move/Scale/Rotate (TransformControls) |
| 카메라 + 내비게이션 | Camera.cpp, `_render_3d_navigator`(뷰 큐브) | OrbitControls + 뷰 큐브. 원근/직교 전환 포함 |
| 피킹 | `m_scene_raycaster` (GPU 피킹) | three.js Raycaster로 대체. 클릭 선택·사각형 선택·드래그 이동이 전부 여기 의존 |
| **G-code 툴패스** (Preview 모드) | `_render_gcode` → libvgcode | §9. 레이어/무브 이중 슬라이더 포함 |
| 순차출력 간섭영역 | `_render_sequential_clearance` | print_sequence=byObject 지원 시 필수, 아니면 유예 |

**유예 가능 (원본에 있지만 MVP엔 불필요):**
그림자(`_render_shadows`), SSAO/FXAA 후처리 패스(three.js 기본 AA로 대체),
와이어프레임 오버레이, Assemble 뷰 전체(`_render_plane`, assemble 툴바류),
페인팅 툴바(`_render_paint_toolbar`), 가변 레이어 높이 편집(layersediting),
SLA 슬라이스 표시(`_render_sla_slices`), FPS/디버그 오버레이.

**캔버스에서 빼야 하는 것 (웹의 이점):** 원본은 wx 제약 때문에 툴바 전부를
GL 캔버스 안에 ImGui로 그린다(`_render_overlays` → main/collapse/view/canvas/gizmo/
plate-select 툴바, 알림까지). 웹에선 **전부 DOM으로 꺼내라**. 캔버스에 남길 것은
3D 공간에 존재하는 것(모델·플레이트·기즈모·툴패스)뿐이다. 플레이트 이름표·아이콘도
CSS2DRenderer 방식 투영 오버레이가 더 싸다.

#### 6.5.1 씬 데이터 흐름과 조작 계약 (재구현 스펙)

**Model → GPU 데이터 흐름:**

```
Model 변경 → GLCanvas3D::reload_scene
  → GLVolumeCollection::load_object / load_object_volume   (GLCanvas3D.cpp:2420, 2744)
      GLVolume 1개 = ModelVolume × ModelInstance 조합 하나  (3DScene.hpp:81, 컬렉션 :394)
      메시는 볼륨당 1회 업로드, 인스턴스는 변환행렬만 다름
```
웹 매핑: ModelVolume → `THREE.BufferGeometry` 1회 생성, 인스턴스 배치는 `Object3D.matrix`
(또는 InstancedMesh). 필라멘트 색/선택 상태는 머티리얼 유니폼.

**카메라 계약** ([Camera.hpp](../slicer/src/slic3r/GUI/Camera.hpp)):
- 타입: `Perspective`(기본) / `Ortho` 전환 (EType, :27-33)
- 조작: target 중심 구면 회전 `rotate_on_sphere(azimuth, zenith, limits)`(:151-157,
  zenith 제한 있음), 팬=target 이동, 줌=`zoom_to_box`(:140)/`zoom_to_bed`
- 프리셋 뷰 `select_view(direction)`(:103) — Ctrl+0~6 단축키와 연결
- 웹 매핑: OrbitControls 그대로 + 원근/직교 토글. `zoom_to_box`(선택 맞춤 줌)는 직접 구현 필요

**입력 이벤트:** `GLCanvas3D::on_mouse / on_mouse_wheel / on_char / on_key`
(바인딩: GLCanvas3D.cpp:3142-3145). 단일 on_mouse가 활성 기즈모·ImGui 오버레이·씬 피킹으로
이벤트를 분배한다 — 웹에선 기즈모(TransformControls)가 이벤트를 먼저 소비하고 나머지가
Raycaster 선택으로 떨어지는 구조로 재현하면 동등하다.

**선택 모델** ([Selection.hpp:34](../slicer/src/slic3r/GUI/Selection.hpp#L34)):
- `EMode { Volume, Instance }` 2모드 — 평소엔 Instance(오브젝트 통째), 파트 편집 시 Volume
- Ctrl 다중선택, 러버밴드 사각형 선택, 선택 집합의 합산 바운딩박스가 기즈모 앵커
- 조작 커밋 흐름: 기즈모 드래그 → Selection이 인스턴스/볼륨 변환 갱신 → 마우스 업 시
  Model에 반영 + undo/redo 스냅샷 + `update_background_process()`(§2.2)로 재슬라이스 판정

**웹 MVP 최소 세트:** OrbitControls + Raycaster 클릭/사각형 선택 + TransformControls
(Move/Rotate/Scale) + 변환 커밋 시 무효화 트리거. 이 4개면 §6.5 필수표의 조작 절반이 끝난다.

**구현 레벨 상세는 [reverse_engineering/SPECS.md §5](reverse_engineering/SPECS.md)** —
지오메트리 파이프라인(P3N3 버텍스 포맷, GLVolume 2단 변환), gouraud 셰이더 유니폼 계약
(베드 밖 판정·클리핑·오버행 경사가 전부 프래그먼트 셰이더에서 계산됨), CPU 레이캐스트 피킹
(AABB 트리 → three-mesh-bvh 매핑), **페인팅 브러시 8단계 상호작용 플로우**
(레이캐스트 캐시 → 커서 5종 → select_patch 재귀 분할 → 스마트/버킷 필 → 상태별 오버레이 렌더).

### 6.5.2 데스크톱 UI 전수 실측 → 웹 재현 로드맵

**[reverse_engineering/SPECS.md §8](reverse_engineering/SPECS.md)** — 타이틀바(BBLTopbar)·사이드바 전체
멤버(프린터/필라멘트/프로세스 섹션, ObjectList 컬럼 6종, ObjectSettings/ObjectLayers, 슬라이스
plate/all 분기)·ParamsPanel의 Global|Objects 스위치·Preview 이중 슬라이더(IMSlider)까지 파일:줄
단위 실측 + 뷰어 구현 순서(S1~S9).

### 6.6 캘리브레이션 (calib.hpp:16-30)

CalibMode 12종: PA Line/Pattern/Tower, Auto PA, Flow Rate, Temp Tower, Vol Speed,
VFA, Retraction, Input Shaping freq/damp, Cornering.
각각 "테스트 모델 생성 + 특정 설정 오버라이드 + G-code 후처리 주입" 조합이며
코어는 [calib.cpp](../slicer/src/libslic3r/calib.cpp)에 있다(UI 독립적 → WASM에 포함 가능).

---

## 7. 데이터 영속성

### 7.1 저장 위치 요약

| 데이터 | 위치 | 형식 |
|---|---|---|
| 앱 설정 | `<data_dir>/OrcaSlicer.conf` | JSON (AppConfig.cpp:1752) |
| 시스템 프리셋 | `resources/profiles/` | JSON |
| 사용자 프리셋 | `<data_dir>/user/<id>/{machine,process,filament}` | JSON |
| 프로젝트 | `.3mf` | ZIP |
| 필라멘트 플러시 매트릭스 등 | 프로젝트/앱 설정 내 | — |

### 7.2 3MF 프로젝트 파일 내부 (bbs_3mf.cpp에서 실측한 ZIP 엔트리)

```
3D/3dmodel.model                        ← 메시+씬 XML (인스턴스 변환 포함)
3D/Objects/<name>_<n>.model             ← 오브젝트별 분리 메시
Metadata/model_settings.config          ← 오브젝트/볼륨/플레이트별 설정 오버라이드 (XML)
Metadata/project_settings.config        ← 병합된 전체 설정 스냅샷 (JSON, 키=옵션키)
Metadata/slice_info.config              ← 슬라이스 결과 메타
Metadata/layer_config_ranges.xml        ← 높이 구간 오버라이드
Metadata/layer_heights_profile.txt      ← 가변 레이어 높이 커브
Metadata/custom_gcode_per_layer.xml     ← 레이어별 커스텀 G-code/색교체
Metadata/cut_information.xml            ← Cut 기즈모 이력
Metadata/brim_ear_points.txt            ← Brim Ears 페인팅
Metadata/filament_sequence.json
Metadata/plate_N.png / plate_no_light_N.png / top_N.png / pick_N.png ← 플레이트 썸네일
Metadata/plate_N.gcode(.md5)            ← 슬라이스 결과 임베드(있을 때)
(레거시 호환) Metadata/Slic3r_PE*.config ← PrusaSlicer 계열 읽기 호환
```

**페인팅 데이터**(서포트/심/MMU 색)는 3dmodel.model의 삼각형 커스텀 속성 문자열로 저장 —
인코딩은 [TriangleSelector.cpp](../slicer/src/libslic3r/TriangleSelector.cpp)의
`serialize`/`deserialize` (삼각형 분할 트리를 비트스트림으로 압축).
웹에서 페인팅을 지원하려면 이 코덱의 JS 포팅이 필요하다 (파일 하나, 독립적).

주의(AGENTS.md 하드 제약): **3MF와 프리셋의 하위 호환 유지**. 웹 구현이 3MF를 다시 쓸 때
알 수 없는 엔트리를 보존-복사해야 데스크톱과 왕복이 가능하다.

### 7.3 앱 설정(AppConfig)

창 상태, 최근 파일, 벤더 활성화, 사용자 로그인, 단위계 등. 웹 대응: localStorage/IndexedDB.
스키마는 [AppConfig.cpp](../slicer/src/libslic3r/AppConfig.cpp)의 `set_defaults()` 참조.

---

## 8. 슬라이싱 파이프라인

### 8.1 단계 (Print.hpp:81-103, Print.cpp:131-259에서 실측)

```
PrintObject 단계 (오브젝트별, 병렬):
  posSlice                 메시 → 레이어별 ExPolygon (TriangleMeshSlicer)
  posPerimeters            벽 생성 (PerimeterGenerator: classic | Arachne 가변폭)
  posEstimateCurledExtrusions
  posPrepareInfill         표면 분류(top/bottom/internal), 앵커 준비
  posInfill                17종 Fill 패턴 (src/libslic3r/Fill/)
  posIroning
  posContouring            (Z 등고선 보정, ZAA)
  posSupportMaterial       normal/tree 서포트 (src/libslic3r/Support/)
  posDetectOverhangsForLift
  posSimplify*             경로 단순화

Print 단계 (플레이트 전역):
  psWipeTower(=psToolOrdering) → psSkirtBrim → psGCodeExport → psConflictCheck
```

### 8.2 G-code 생성 (GCode.cpp + src/libslic3r/GCode/)

경로 순서화(ShortestPath), 심 배치(SeamPlacer — scarf joint 포함), 리트랙션/와이프,
CoolingBuffer(레이어 시간 기반 팬/속도), PressureEqualizer, AdaptivePA(압력어드밴스 보간),
SpiralVase, FanMover, WipeTower, PlaceholderParser로 커스텀 G-code 치환, ConflictChecker.

**경로 계산의 구현 레벨 상세는 [reverse_engineering/SPECS.md §6](reverse_engineering/SPECS.md)** —
ExtrusionEntity 데이터 모델, Flow 단면적→E값 수학, classic/Arachne 벽 생성, 최근접 체이닝과
심 분할, 트래블/리트랙션 판정, 방출 시점 속도 결정 우선순위, TBB 후처리 파이프라인 확정 순서
(spiral→pressure_equalizer→cooling→fan_mover→PA).

### 8.3 PlaceholderParser (커스텀 G-code 템플릿 언어)

[PlaceholderParser.cpp](../slicer/src/libslic3r/PlaceholderParser.cpp) — boost::spirit 문법.
`{...}` 표현식, `{if cond}...{elsif}...{else}...{endif}` (실측: 2177-2206행),
벡터 인덱싱 `nozzle_diameter[0]`, 산술/비교/정규식 매치.
**두 군데서 쓰인다**: ① 커스텀 G-code 슬롯 ② 프리셋 `compatible_printers_condition`.
웹에선 표현식 평가기(수백 줄)를 한 번만 구현하면 두 용도를 다 커버한다.

---

## 9. G-code 처리와 프리뷰

### 9.1 GCodeProcessor (src/libslic3r/GCode/GCodeProcessor.cpp)

G-code 텍스트 → `GCodeProcessorResult`(GCodeProcessor.hpp:178):
`MoveVertex` 배열(타입/위치/폭/높이/속도/팬/온도/유량/익스트루더), 시간 추정
(프린터 기속도 모델 시뮬레이션), 필라멘트 사용량, SettingsIds.
**입력이 텍스트라 UI와 완전 분리** — 단독 WASM/JS 포팅 가능.

### 9.2 libvgcode (src/libvgcode/) — 프리뷰 렌더러

공개 API가 6개 헤더로 정리된 **독립 라이브러리**:
`Viewer::init(gl_version) / load(GCodeInputData&&) / reset()`,
`get_layers_zs / get_extrusion_roles / get_layers_estimated_times` (Viewer.hpp).
GCodeViewer.hpp:246이 `libvgcode::Viewer m_viewer`로 위임하는 구조.

- 뷰 컬러링 모드(GCodeViewer.cpp:73-95 실측): Feature type, Layer Height, Line Width,
  Speed, **Actual Speed**, Fan Speed, Temperature, Flow, **Actual Flow**, Tool, Filament
- ExtrusionRole 20종 (ExtrusionEntity.hpp:20-43): Perimeter, ExternalPerimeter,
  OverhangPerimeter, InternalInfill, SolidInfill, TopSolidInfill, BottomSurface, Ironing,
  BridgeInfill, InternalBridgeInfill, GapFill, Skirt, Brim, SupportMaterial(+Interface,
  Transition), WipeTower, Custom, Mixed
- 상호작용: 수직(레이어)+수평(무브) 이중 슬라이더, 무브 툴팁, 옵션 마커(리트랙션/심/툴체인지)

OpenGL(ES 호환 셰이더) 기반이라 **WebGL2로 가장 이식성이 좋은 모듈**. WASM 1순위.

---

## 10. npm 패키지화 전략

### 10.1 전략 결정: 3-트랙

| 트랙 | 내용 | 이유 |
|---|---|---|
| **A. 데이터/스키마 — JS 네이티브** | 설정 스키마, 프리셋, 3MF, 표현식 평가기, UI | C++ 불필요. 원본은 "데이터+선언"이라 추출이 정답 |
| **B. 뷰어 — WASM(소형)** | libvgcode + GCodeProcessor | 독립적·소형·GL이라 WASM 적합 |
| **C. 슬라이싱 코어 — 이중화** | 1차: 서버에서 기존 CLI 실행(`orca-slicer --slice`, OrcaSlicer.cpp:5651) / 2차: libslic3r WASM | CLI는 오늘 동작. WASM은 TBB·CGAL·OCCT 제거 작업이 큰 별도 프로젝트 |

### 10.2 제안 패키지 구성 (모노레포)

```
@orca/config-schema     828옵션 메타데이터 JSON + 타입(d.ts 자동 생성)      [추출물]
@orca/ui-map            Tab 페이지/그룹/옵션 트리 JSON + toggle 규칙표      [추출+수작업]
@orca/presets           벤더 프로파일 로더 + inherits 해석 + 호환성 필터    [JS ~500줄]
@orca/expr              PlaceholderParser 표현식 평가기                    [JS ~800줄]
@orca/3mf               3MF 읽기/쓰기 (zip.js) + TriangleSelector 코덱     [JS]
@orca/gcode             GCodeProcessor WASM 또는 JS 포팅 (파서+시간추정)    [WASM/JS]
@orca/viewer            libvgcode WASM + three.js/WebGL2 래퍼             [WASM]
@orca/slicer            슬라이싱: cli-server 드라이버(1차) / core-wasm(2차) [Node/WASM]
@orca/react-ui          설정 폼 제너레이터 + 플레이터 UI (선택)             [신규]
```

의존 방향: `react-ui → ui-map → config-schema`, `presets → expr`, `slicer → 전부`.
Node 전용(@orca/slicer cli 모드)과 브라우저 공용을 `exports` 조건으로 분리.

### 10.3 WASM 빌드 시 알아야 할 지뢰

> **실측 셋업 (macOS, 2026-07-23 검증)**: `brew install emscripten binaryen` 후 두 가지 함정 —
> ① 시스템 python3(3.9)로는 emcc가 assert 실패 → `export EMSDK_PYTHON=/opt/homebrew/bin/python3.14`
> ② 자동 생성 config가 Xcode clang(WASM 백엔드 없음)을 잡음 → `libexec/.emscripten`에
> `LLVM_ROOT='/opt/homebrew/opt/emscripten/libexec/llvm/bin'`,
> `BINARYEN_ROOT='/opt/homebrew/opt/emscripten/libexec/binaryen'` 수동 지정.
> 스모크 테스트(emcc→node 실행) 통과 확인 후 진행할 것.
> Clipper1은 [deps_src/clipper/](../slicer/deps_src/clipper/)에 있으며 Eigen/TBB include 2줄만 패치하면
> 독립 컴파일 가능 — WASM 커널 1단계의 핵심 의존성이다 (진행 상태: reverse_engineering/README.md).

- **TBB**: emscripten pthreads로 대체하거나 `Execution` 추상 계층(src/libslic3r/Execution/)을 순차 실행으로 강제. 후자가 첫 빌드에선 현실적.
- **Boost**: header-only 부분은 무난, spirit(PlaceholderParser)도 컴파일은 됨.
- **CGAL/OpenVDB/OCCT**: MeshBoolean·Hollow·STEP 임포트 전용 → **1차 빌드에서 컴파일 타깃에서 제외** (CMake 옵션으로 분리 가능한 구조).
- **wxWidgets/CURL/OpenSSL**: libslic3r는 의존하지 않음 — GUI 계층만의 의존성인지 링크 에러로 확인하며 절단.
- pthread WASM → 배포 시 COOP/COEP 헤더 필수.

---

## 11. 추출 레시피

> **★ 실행 완료 — 산출물이 [reverse_engineering/](reverse_engineering/)에 실물로 존재한다.**
> 재생성: `python3 reverse_engineering/extract_all.py`. 커버리지·한계는
> [reverse_engineering/README.md](reverse_engineering/README.md) 참조.
>
> | 산출물 | 내용 | 대응 레시피 |
> |---|---|---|
> | [config-schema.json](reverse_engineering/config-schema.json) | 옵션 907개 메타데이터 (enum 100%, ratio_over 27개 포함) | §11.1 |
> | [ui-tree.json](reverse_engineering/ui-tree.json) | 페이지→그룹→옵션 트리 (11빌더/34페이지/587참조) | §11.2 |
> | [toggle-rules.json](reverse_engineering/toggle-rules.json) | 활성/비활성 규칙 231개 (커버리지 95%, C++ 조건식 원문) | §11.3 |
> | [invalidation-map.json](reverse_engineering/invalidation-map.json) | 옵션→재슬라이스 단계 매핑 (Print 6 + PrintObject 19분기) | §2.2 |
> | [SPECS.md](reverse_engineering/SPECS.md) | 3MF XML 스펙 · 페인팅 코덱 · PlaceholderParser EBNF · 단축키 표 | §7.2, §8.3 |
>
> **① 빌드 기반 스키마 덤프 — 실현됨**: [config-schema-builddump.json](reverse_engineering/config-schema-builddump.json)
> (817옵션 — 실 PrintConfig.cpp를 WASM으로 컴파일해 print_config_def에서 직접 덤프,
> [compare_schema.mjs](reverse_engineering/compare_schema.mjs)로 정규식 추출본과 크로스체크: type 불일치 0,
> 907=800공통+107 CLI별도정의 / 817=800+17 루프생성으로 산술 정합, `filament_type` 75종 enum은 빌드 덤프만 가능).
> 아직 실물이 없는 것(정직 고지): ② `update_print_fff_config`의 값 자동보정 규칙
> ③ 비주얼 스펙(색상·스크린샷 — 실행 중인 앱 관찰 필요).

### 11.1 설정 스키마 덤프 (최우선, 반나절)

정규식으로 PrintConfig.cpp를 파싱하지 말 것(12,688줄, 조건부 로직 있음).
libslic3r을 링크하는 30줄짜리 덤프 툴이 정공법:

```cpp
// tools/dump_schema.cpp — libslic3r만 링크
#include "libslic3r/PrintConfig.hpp"
#include <boost/property_tree/json_parser.hpp>
int main() {
    using namespace Slic3r;
    const PrintConfigDef& def = print_config_def;      // 전역 828옵션
    for (const auto& [key, opt] : def.options) {
        // key, opt.type, opt.label, opt.tooltip, opt.sidetext, opt.category,
        // opt.mode, opt.min/max, opt.enum_values/enum_labels, opt.gui_type,
        // opt.nullable, default 값(opt.default_value->serialize()) → JSON으로 출력
    }
}
```

CMake: `add_executable(dump_schema tools/dump_schema.cpp); target_link_libraries(dump_schema libslic3r)`.
산출물이 `@orca/config-schema`의 전부다. i18n은 `localization/i18n/*.po`에서 label/tooltip
msgid를 매칭해 언어팩 JSON으로 별도 추출.

### 11.2 UI 트리 덤프 (Tab.cpp → JSON)

Tab.cpp는 코드가 곧 선언이라 파이썬 정규식으로 충분하다 (이 세션에서 검증한 패턴):

```
add_options_page\(L\("([^"]+)"\)      → 페이지
new_optgroup\(L\("([^"]*)"\)          → 그룹
append_single_option_line\("([^"]+)"  → 옵션 키
```

`TabPrint::build / TabFilament::build / TabPrinter::build` 함수 경계로 잘라서 순회.
커스텀 위젯 라인(G-code 에디터, compatible_printers 위젯 등)은 수동 마킹 ~20곳.

### 11.3 toggle 규칙표 (수작업, 1~2일)

[ConfigManipulation.cpp](../slicer/src/slic3r/GUI/ConfigManipulation.cpp)의 `toggle_field` 198곳을
`{조건 → 비활성 필드 목록}` JSON으로 번역. 함수별로 이미 print/filament/printer가 나뉘어
있어 기계적 작업.

### 11.4 프리셋 해석기 (JS, §5.4 알고리즘)

입력: `resources/profiles/` 통째 복사(라이선스: 본체와 동일 AGPL 계열 — 배포 전 확인).
`<Vendor>.json` 인덱스 → sub_path 로드 → inherits 체인 병합 → `instantiation:"false"` 필터
→ `compatible_printers_condition`은 `@orca/expr`로 평가.

### 11.5 3MF (JS)

zip.js/fflate로 열고 §7.2 엔트리 매핑대로 파싱.
- `project_settings.config` = 평평한 JSON (옵션키→값) — 그대로 DynamicConfig
- `3dmodel.model` = XML(vertices/triangles/components + 페인팅 속성 문자열)
- 쓰기 시 **모르는 엔트리는 바이트 그대로 보존** (데스크톱 왕복 호환)

### 11.6 libvgcode WASM

`src/libvgcode/`는 CMakeLists가 이미 분리돼 있고 GL 컨텍스트 버전 문자열을 받는 구조
(`Viewer::init(const std::string& opengl_context_version)`)라 WebGL2("300 es") 대응이 설계에
들어 있다. emscripten `-sUSE_WEBGL2 -sFULL_ES3`로 빌드, 입력(`GCodeInputData`)은
@orca/gcode의 출력에서 조립.

### 11.7 검증 전략과 인수 기준 (필수)

패키지별 "완성" 판정 기준. 전부 자동화 가능한 형태로 정의한다.

| 패키지 | 인수 기준 |
|---|---|
| config-schema | 옵션 수 907 스냅샷 일치. coEnum 전체가 enum_values 보유. `layer_height`/`seam_position`/`sparse_infill_pattern`(26 enum) 스팟 체크 |
| ui-map | TabPrint 6페이지·TabFilament 6페이지·TabPrinter 페이지 구성이 ui-tree.json과 일치. 트리의 모든 옵션 키가 schema에 존재 (dangling 참조 0) |
| presets | 66개 벤더 인덱스 전체 로드 성공. 임의 벤더(예: Elegoo)의 모든 instantiation=true 프리셋이 inherits 체인 해석 후 `compatible_printers_condition` 평가 가능. 데스크톱에서 같은 프리셋 선택 시 화면에 보이는 값과 диф 0 |
| expr | PlaceholderParser 소스의 문법 케이스로 단위 테스트: 산술·비교·`=~`정규식·if/elsif/endif·벡터 인덱싱·min/max/interpolate_table. 실제 프로파일의 compatible 조건식 전량(수백 개) 파싱 에러 0 |
| 3mf | **왕복 테스트**: 데스크톱 저장 .3mf → 웹 로드 → 웹 저장 → 데스크톱 로드, 지오메트리·설정·플레이트·페인팅 무손실. 모르는 엔트리 바이트 보존 확인 |
| 페인팅 코덱 | SPECS.md §2.3 검증 벡터(`"4"` = ENFORCER 리프) + 데스크톱이 만든 paint_supports 문자열 재인코딩 시 원문 일치 |
| gcode/viewer | 같은 G-code에 대해 데스크톱 프리뷰와 레이어 수·역할별 색 분포·시간 추정(±1%) 일치 |
| slicer(CLI) | `orca-slicer --slice`(OrcaSlicer.cpp:5651) 산출 G-code와 웹 트리거 산출이 byte-diff 0 (같은 바이너리이므로 래핑만 검증) |

- 기존 테스트 자산 재사용: `tests/fff_print`, `tests/libslic3r`, `tests/data` (Catch2).
- 골든 파일은 데스크톱 CLI로 생성해 저장소에 고정하고, 웹 구현 CI에서 비교.

---

## 12. 로드맵과 난이도표

| 순서 | 작업 | 난이도 | 산출물 |
|---|---|---|---|
| 1 | 스키마 덤프 툴 + config-schema | ★☆☆ | 828옵션 JSON, d.ts |
| 2 | UI 트리 덤프 + ui-map | ★☆☆ | 페이지/그룹/옵션 JSON |
| 3 | presets + expr (상속·호환성) | ★★☆ | 66벤더 프로파일 구동 |
| 4 | 설정 폼 제너레이터 (react-ui) | ★★☆ | 데스크톱 동등 설정 UI |
| 5 | 3mf 읽기(모델+설정) + three.js 씬 | ★★☆ | 프로젝트 열기 |
| 6 | slicer: CLI 서버 드라이버 | ★☆☆ | 실제 슬라이싱 동작 |
| 7 | gcode + viewer WASM | ★★★ | 웹 프리뷰 |
| 8 | toggle 규칙표 + ConfigManipulation 재현 | ★★☆ | UI 정합성 |
| 9 | 3mf 쓰기 + 페인팅 코덱 | ★★★ | 왕복 호환 |
| 10 | libslic3r WASM (TBB/CGAL 절단) | ★★★★★ | 브라우저 단독 슬라이싱 — **13단계까지 완료** ([reverse_engineering/wasm-core/](reverse_engineering/wasm-core/), 불변식 120개 상시 검증). **원본 소스 그대로 이식된 것**: Arachne 가변폭 전체(Voronoi 스켈레톤), Fill 5패턴(진짜 TPMS gyroid), PressureEqualizer(태그 통합 실효 동작), Config+PrintConfig(12,688줄 — 817옵션 런타임 생성), WipeTower(원본 툴체인지 마커), **GCodeProcessor 본체 7,561줄**(기본 시간엔진). 커널 자체 구현: 슬라이스·솔리드셸·서포트(grid/tree-lite)·래프트·갭필·씬월·아이어닝·브리지·scarf 심·아크·냉각·멀티 오브젝트·멀티머티리얼 기초. **영구 예외(실측 관문 문서화)**: 풀 TreeSupport(PrintObject 객체그래프 재구축 필요 — m_object×121 참조), CGAL 평면성 검사(네이티브 GMP 링크) |

기즈모 중 페인팅·메시 부울·STEP 임포트는 10번 이후로 미룬다. 1–6까지가
"웹에서 열고, 설정하고, 슬라이스하고" 하는 MVP이며 전부 저위험 작업이다.

---

## 13. 부록: 주요 파일 인덱스

| 영역 | 파일 |
|---|---|
| 엔트리/CLI | [src/OrcaSlicer.cpp](../slicer/src/OrcaSlicer.cpp) (`--slice`: 5651행) |
| 앱 초기화 | [src/slic3r/GUI/GUI_App.cpp](../slicer/src/slic3r/GUI/GUI_App.cpp) (OnInit: 2672) |
| 메인 창 | [src/slic3r/GUI/MainFrame.cpp](../slicer/src/slic3r/GUI/MainFrame.cpp) |
| 작업 화면 | [src/slic3r/GUI/Plater.cpp](../slicer/src/slic3r/GUI/Plater.cpp) (사이드바: 655, 슬라이스 루프: 8884) |
| 설정 UI 트리 | [src/slic3r/GUI/Tab.cpp](../slicer/src/slic3r/GUI/Tab.cpp) |
| 위젯 매핑 | [src/slic3r/GUI/OptionsGroup.cpp](../slicer/src/slic3r/GUI/OptionsGroup.cpp):41, [Field.cpp](../slicer/src/slic3r/GUI/Field.cpp) |
| 옵션 토글 규칙 | [src/slic3r/GUI/ConfigManipulation.cpp](../slicer/src/slic3r/GUI/ConfigManipulation.cpp) |
| 옵션 정의 | [src/libslic3r/PrintConfig.cpp](../slicer/src/libslic3r/PrintConfig.cpp), 스키마: [Config.hpp](../slicer/src/libslic3r/Config.hpp) |
| 모델 트리 | [src/libslic3r/Model.hpp](../slicer/src/libslic3r/Model.hpp) |
| 프리셋 | [src/libslic3r/Preset.cpp](../slicer/src/libslic3r/Preset.cpp), [PresetBundle.cpp](../slicer/src/libslic3r/PresetBundle.cpp) |
| 파이프라인 | [src/libslic3r/Print.cpp](../slicer/src/libslic3r/Print.cpp), [PrintObject.cpp](../slicer/src/libslic3r/PrintObject.cpp) |
| 백그라운드 슬라이싱 | [src/slic3r/GUI/BackgroundSlicingProcess.cpp](../slicer/src/slic3r/GUI/BackgroundSlicingProcess.cpp) |
| G-code 생성 | [src/libslic3r/GCode.cpp](../slicer/src/libslic3r/GCode.cpp), [src/libslic3r/GCode/](../slicer/src/libslic3r/GCode/) |
| G-code 분석 | [src/libslic3r/GCode/GCodeProcessor.cpp](../slicer/src/libslic3r/GCode/GCodeProcessor.cpp) |
| 프리뷰 렌더러 | [src/libvgcode/](../slicer/src/libvgcode/), [src/slic3r/GUI/GCodeViewer.cpp](../slicer/src/slic3r/GUI/GCodeViewer.cpp) |
| 3MF | [src/libslic3r/Format/bbs_3mf.cpp](../slicer/src/libslic3r/Format/bbs_3mf.cpp) |
| 페인팅 코덱 | [src/libslic3r/TriangleSelector.cpp](../slicer/src/libslic3r/TriangleSelector.cpp) |
| 템플릿 언어 | [src/libslic3r/PlaceholderParser.cpp](../slicer/src/libslic3r/PlaceholderParser.cpp) |
| undo/redo | [src/slic3r/Utils/UndoRedo.cpp](../slicer/src/slic3r/Utils/UndoRedo.cpp) |
| 캘리브레이션 | [src/libslic3r/calib.cpp](../slicer/src/libslic3r/calib.cpp) |
| 벤더 프로파일 | [resources/profiles/](../slicer/resources/profiles/) (66벤더) |
| 셰이더 | [resources/shaders/110/](../slicer/resources/shaders/110/) |
| 테스트 | [tests/](tests/) (Catch2; fff_print, libslic3r) |
