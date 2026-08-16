# Printer Showcase — three-slicer demo

프린터 제조사 제품 페이지 안에 슬라이서를 넣는 임베드 데모. 가상의 "ACME 3D" 랜딩 페이지가
호스트이고, 그 안의 한 섹션이 three-slicer다.

통합은 [`src/slicer_section.jsx`](./src/slicer_section.jsx) 한 파일이다. 기종 목록·settings 상태·
스타일까지 자기가 들고 있어서, 기존 사이트에 한 줄로 마운트된다.

```jsx
import SlicerSection from './slicer_section.jsx'

<section id="try">
  <h2>Try it with your model</h2>
  <SlicerSection />        {/* 이게 전부 */}
</section>
```

안쪽은 이렇게 생겼다.

```jsx
// 호스트가 settings를 소유하고, 기종 버튼이 그 state를 갈아끼운다.
const [settings, setSettings] = useState(() => printerSettings(MACHINES[1].profile))

<div className="ts-frame">      {/* position: relative + 실제 height 필수 */}
  <Viewport
    settings={settings} setSettings={setSettings}
    defaultAutoSlice                                   // 모델이 올라오면 알아서 슬라이스
    onEvent={e => e.type === 'progress' && setProgress(e.value)}
    onSliced={({ stats }) => setStats(stats)}          // 통계는 호스트 페이지가 그린다
    panels={{ topBar: false, printerCard: false, processCard: false, /* … */ }}
    features={{ shortcuts: false, logs: false }}       // 페이지 키보드는 호스트 것
  />
</div>
```

## 현재 상태

동작한다. 배포 URL은 아직 없다 (`npm run build` → `dist/`, 정적 호스팅 가능).

실측 (M-series Mac, Chrome, 20mm 큐브):

| 기종 | 베드 | 0.20mm | 0.28mm |
| --- | --- | --- | --- |
| ACME A1 mini (`Bambu Lab A1 mini 0.4 nozzle`) | 180 × 180 × 180 | 15m · 4.0 g | 12m · 4.0 g |
| ACME P1 (`Bambu Lab P1S 0.4 nozzle`) | 256 × 256 × 250 | 12m · 4.0 g | — |

같은 모델·같은 재료인데 기종에 따라 시간이 다른 것은 프로파일의 모션 리밋이 실제로 반영되기
때문이고, 레이어 높이를 올리면 시간만 줄고 재료는 그대로다.

## Try it

```bash
npm i
npm run dev      # http://localhost:5173
```

**Choose file** 또는 플레이트에 드래그로 모델을 올리면 자동으로 슬라이스된다. 모델이 없으면
페이지 하단의 20mm 테스트 큐브를 받아 쓰면 된다.

## Package APIs used

| 경로 | 쓰는 것 |
| --- | --- |
| `three-slicer/viewer` | `<Viewport/>` — `settings`/`setSettings`, `defaultAutoSlice`, `panels`, `features`, `onEvent`, `onSliced` |
| `three-slicer/settings` | `printerSettings`, `printerDefaultPreset`, `processPresets`, `filamentPresets`, `settingScalar` |

`three-slicer/client`은 쓰지 않는다 — Viewport가 워커와 slice lifecycle을 소유하고, 호스트는
`onEvent`/`onSliced`로 상태만 받는다. `three-slicer/components`도 쓰지 않는다: `<SettingsPanel/>`의
`only`는 **builder/page 단위**로만 좁혀지고 임의 키 목록 필터가 없어서, "레이어 높이와 인필 두 개만"
같은 요구에는 맞지 않는다. 그 두 컨트롤은 호스트가 직접 만들어 `settings`에 쓴다.

## Architecture

```
호스트 페이지 (ACME 랜딩)
  └─ <SlicerSection/>
       ├─ 기종 버튼 3개 → printerSettings(profile) + 기본 process + 호환 filament 병합 → settings
       ├─ <Viewport settings setSettings defaultAutoSlice …/>   ← 워커·커널·씬 전부 뷰어 소유
       │     onEvent   → progress / slicing / error
       │     onSliced  → stats (time_estimate, filament_mm)
       └─ 호스트 컨트롤 2개 (layer_height, sparse_infill_density) → settings → 자동 재슬라이스
```

## Run locally

```bash
npm i
npm run dev
npm run build && npm run preview   # 빌드 산출물로도 동일하게 동작하는지 확인
```

## Important files

| 파일 | 역할 |
| --- | --- |
| [`src/slicer_section.jsx`](./src/slicer_section.jsx) | **임베드 전부.** 기종 목록, 프리셋 병합, Viewport, 호스트 컨트롤, 자기 CSS |
| [`src/main.jsx`](./src/main.jsx) | 가상 제품 페이지. 통합과 무관한 마케팅 크롬 |
| [`src/host.css`](./src/host.css) | 페이지 스타일 + **의도적으로 적대적인 전역 CSS** |
| [`vite.config.js`](./vite.config.js) | ES 워커, es2022 |

## Shadow DOM 격리 검증

`host.css` 맨 위에 실제 사이트에 흔한 무차별 셀렉터를 일부러 둔다.

```css
button { border-radius: 0 !important; text-transform: uppercase; }
canvas { max-width: 300px !important; filter: sepia(1); }
input, select { font-size: 24px !important; border: 4px dashed magenta !important; }
aside { display: none !important; }
```

브라우저에서 잰 계산값:

| | 프레임 안 (Shadow DOM) | 프레임 밖 (호스트 DOM) |
| --- | --- | --- |
| `canvas` max-width | `none` | — |
| `canvas` filter | `none` | — |
| `button` border-radius | `8px` | `0px` |
| `button` text-transform | `none` | `uppercase` |
| `select` border | 기본 | `dashed magenta`, 24px |

즉 뷰어는 호스트 CSS의 영향을 전혀 받지 않고, 이 컴포넌트가 호스트 DOM에 그리는 부분은 받는다.
그 경계를 화면에도 한 줄로 적어 두었다 — 데모의 결함이 아니라 보여주려는 사실이다.

## 알려진 제약: 샘플 모델 자동 로드

`<Viewport/>`에는 **호스트가 모델 바이트를 넣는 prop이 없다** (0.1.7 기준, 로컬 소스도 동일).
그래서 "페이지 열자마자 샘플이 올라와 있는" 상태는 public API만으로는 만들 수 없다. private scene
접근이나 합성 drop 이벤트로 우회하지 않고, 대신 테스트 큐브 다운로드 링크 + 뷰어 자체의 파일
선택/드롭을 쓴다.

제대로 하려면 패키지에 모델 입력 경로가 필요하다 (예: `<Viewport model={{name, buffer}}/>` 또는
`onReady`로 넘어오는 imperative handle). 그 전까지 이 데모의 "sample model 자동 load" 완료 조건은
미충족이다.

## What is intentionally mocked

- ACME 3D는 가상의 회사다. Buy now, 내비게이션, 스펙 표는 동작하지 않는 마케팅 크롬이다.
- 실기기 연결·펌웨어·클라우드·계정 — 없다.

## Production considerations

- **CSP**: 워커와 WASM을 쓰므로 `worker-src blob:`, `script-src 'wasm-unsafe-eval'`이 필요하다.
- **번들 크기**: 커널 WASM이 4MB대다. 제품 페이지라면 `features={{ warmup: false }}`로 두고 사용자가
  모델을 올릴 때 받게 하는 편이 첫 로드에 유리하다.
- **COOP/COEP**를 켜면 멀티스레드 커널로 바뀌어 큰 모델이 빨라지지만, 같은 페이지의 서드파티
  임베드(광고·유튜브 등)가 CORP 헤더 없이는 깨진다. 마케팅 페이지에서는 대개 켜지 못한다.
- 기종별 프로파일은 `three-slicer/settings`의 벤더 데이터를 그대로 쓴다. 자사 기종이라면 스스로의
  프로파일을 `printerSettings()` 대신 넣으면 된다 — 나머지 배선은 그대로다.
