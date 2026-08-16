# three-slicer 예제 데모 명세

이 디렉터리는 `three-slicer`를 실제 제품에 통합하는 다섯 가지 방법을 정의한다. 데모는 이 저장소와
다른 사이트에 배포하는 독립 프로젝트이며 패키지를 npm에서 설치해 쓴다 (§2). 다섯 중 넷은 구현돼
있고, 남은 하나(marketplace)는 아직 **구현 명세**다.

구현된 데모 4개: [`instant-quote/`](./instant-quote/), [`printer-showcase/`](./printer-showcase/),
[`cad-embed/`](./cad-embed/), [`farm-dashboard/`](./farm-dashboard/) — 각각 `npm i && npm run dev`.
넷 다 정적 호스팅으로 배포된다(백엔드 없음). 남은 하나(marketplace)는 패키지에 project codec
export가 publish되어야 시작할 수 있다.

## 데모 카탈로그

| 데모 | 대표 사용 사례 | 핵심 package surface | 상태 | 상세 명세 |
| --- | --- | --- | --- | --- |
| Instant Quote | 출력 대행 자동 견적 | `client`, `settings`, `viewer/loaders`, `viewer/toolpath` | **구현됨** | [명세](./instant-quote.md) · [앱](./instant-quote/) |
| Printer Showcase | 제조사 페이지 임베드 | `viewer`, `settings` | **구현됨** | [명세](./printer-showcase.md) · [앱](./printer-showcase/) |
| CAD Embed | 설계 중 출력성 피드백 | `client`, `settings`, `toggle`, `viewer/toolpath` | **구현됨** | [명세](./cad-embed.md) · [앱](./cad-embed/) |
| Marketplace | 3MF project 보존·재타기팅 | project codec, `viewer`, `settings` | API 선행 작업 필요 | [marketplace.md](./marketplace.md) |
| Farm Dashboard | 브라우저 분산 slicing | `client`, `settings`, `viewer/gcode`, `viewer/toolpath` | **구현됨** | [명세](./farm-dashboard.md) · [앱](./farm-dashboard/) |

각 데모는 하나의 질문에만 답한다.

- 출력 대행업체: “견적 계산만 가져다 쓸 수 있나?”
- 프린터 제조사: “우리 제품 페이지 안에 slicer를 넣을 수 있나?”
- CAD 개발자: “설계 변경을 출력 시간과 재료량에 바로 연결할 수 있나?”
- Marketplace 개발자: “mesh가 아니라 3MF project 전체를 보존할 수 있나?”
- Print farm 개발자: “slicing server 없이 여러 프린터의 job을 준비할 수 있나?”

## 1. 공통 구현 원칙

- slicing은 브라우저의 WASM worker에서 수행한다. 어떤 데모도 backend를 두지 않는다.
- 모델 원본은 데모가 명시하지 않는 한 서버로 전송하지 않는다.
- 모든 import는 `three-slicer`의 public export를 사용한다. `../../packages/*`와 `../../slicers/*`는
  금지한다.
- `slicers/`는 reference checkout이므로 수정하거나 runtime dependency로 사용하지 않는다.
- 결제, 계정, 실제 프린터 프로토콜처럼 데모의 핵심이 아닌 기능은 mock하고 UI에 표시한다.
- 처음 방문한 사용자가 sample model로 30초 안에 핵심 동작을 확인할 수 있어야 한다.
- package private API가 필요하면 복사하거나 우회하지 않고 package export와 타입을 먼저 보강한다.

## 2. 독립 프로젝트와 설치

데모는 이 저장소와 **다른 웹사이트에 배포한다.** 따라서 각 데모는 monorepo에 묶인 workspace가
아니라 **npm에서 패키지를 설치해 쓰는 독립 프로젝트**다. 소스는 이 저장소의 `examples/` 아래에
두되, root `package.json`의 `workspaces`(현재 `packages`, `web/viewer`)에는 **추가하지 않는다** —
추가하는 순간 npm이 로컬 소스를 link해버려서 데모가 검증하는 대상이 "배포된 패키지"가 아니게
된다.

```text
examples/
├── DEMOS.md              # 이 문서
├── fixtures/
├── instant-quote/        # 각각 독립 프로젝트 (자체 node_modules, 자체 배포)
├── printer-showcase/
├── cad-embed/
├── marketplace/
└── farm-dashboard/
```

### 설치

패키지는 npm에서 가져온다. `three-slicer`는 런타임 의존성이 없고, 필요한 것은 peer로 선언된
`react >=18`, `react-dom >=18`, `three ^0.160.0`뿐이다. 데모가 쓰는 surface에 따라 필요한 peer가
다르다.

```bash
# viewer/components를 쓰는 데모 (printer-showcase, marketplace, cad-embed)
npm i three-slicer three react react-dom

# viewer를 안 쓰는 데모 — 단, three-slicer/viewer/loaders는 three를 import한다
npm i three-slicer three          # instant-quote, farm-dashboard

# client + settings만 쓴다면 peer 없이도 성립한다
npm i three-slicer
```

`package.json`에는 배포된 버전 범위를 쓴다. `workspace:*`나 `file:../../packages`는 금지 —
다른 사이트에 올리는 순간 죽는다.

```json
{
  "private": true,
  "dependencies": {
    "three-slicer": "^0.1.7"
  }
}
```

npm 설치본을 쓴다는 것은 데모가 **published tarball을 검증한다**는 뜻이기도 하다: 새 artifact가
`packages/package.json`의 `files`에서 빠지면 데모가 먼저 깨진다.

미공개 API를 쓰는 데모(marketplace의 project codec)는 그 export가 publish된 **다음** 버전부터만
성립한다 — §10에서 export 보강이 선행 작업인 이유가 하나 더 있는 셈이다. 릴리스 전에 미리
확인하려면 `npm pack`으로 만든 tarball을 설치한다(`npm i ../../packages/three-slicer-0.1.8.tgz`).

소비자는 배포된 패키지와 같은 경로만 사용한다.

```js
import { createSlicerClient } from 'three-slicer/client'
import { deriveKernelParams } from 'three-slicer/settings'
import Viewport from 'three-slicer/viewer'
```

### 2.1 복사 단위 코드 구조

구조의 단위는 "데모"가 아니라 **"복사"**다. 폴더 하나가 통째로 degit되고, 파일 하나가 통째로
도입자의 앱에 복사되고, 코드 블록 하나가 통째로 README에 인용되는 3단 크기로 자른다.
도입자가 가져갈 통합 코드와 데모라서 있는 코드를 파일 경계로 분리한다.

```text
instant-quote/            # 예시 — 파일명은 데모마다 자기 문서의 개념을 따른다
├── package.json          # 위의 published 버전 범위
├── index.html
├── vite.config.js        # COOP/COEP 옵션은 주석으로 설명
└── src/
    ├── quote.js          # ★ 통합 파일 — 도입자가 복사해 갈 코드 전부
    ├── stl_serialize.js  # 독립 유틸 — 역시 단독 복사 가능
    ├── App.jsx           # 데모 크롬 — 드롭존·셀렉트·카드, 최대한 뻔하게
    └── mock/
        └── pricing.js    # 교체 대상임이 경로에서 드러남
```

- **의존 방향이 경계다.** 통합 파일은 `three-slicer/*`와 표준 라이브러리만 import하고, 데모
  크롬(App)이 통합 파일을 import한다. import 문만 보고 어디까지가 패키지 통합인지 판단할 수
  있어야 한다.
- **통합 파일은 README에 전문 인용 가능한 크기(±100줄)로 유지한다.** 도입자는 그 코드 블록
  하나로 통합 비용을 판단한다.
- **데모 폴더는 완전 자립한다.** 루트 공유 vite 설정, path alias, 공용 demo-utils 패키지 금지.
  filament mm→g 환산처럼 작은 유틸은 데모마다 중복 작성한다 — 공유하는 순간 어떤 데모도 혼자
  복사될 수 없고, StackBlitz/CodeSandbox 링크도 만들 수 없다.
- **패키지 API를 래퍼로 감싸지 않는다.** `createSlicerClient()`를 훅이나 서비스 계층으로 숨기면
  파는 물건이 안 보인다. 호출부는 raw하게 두고 호출부 주변에만 주석을 단다. 데모 크롬에는 상태
  라이브러리, CSS 프레임워크, 커스텀 훅 체계를 넣지 않는다 — 패키지 호출부만 눈에 띄는 코드가
  되게 하는 것이 목표다.
- **파일명은 데모 문서의 개념과 1:1로 맞춘다** (`compatibility.js`, `submit_job.js`). 화면 하단의
  "Powered by" surface 표기는 해당 파일 링크로 연결한다.
- **복잡도 사다리를 지킨다.** instant-quote는 전체 300줄 이하로 억제해 "통합이 이만큼 싸다"는
  첫인상을 만들고, marketplace가 사다리의 끝이다. §10의 구현 순서가 그대로 진입 순서다.

## 3. 공통 fixture

재배포 가능한 자체 제작 모델을 `examples/fixtures/`에 둔다.

| 파일 | 목적 | 권장 상한 |
| --- | --- | --- |
| `calibration-cube.stl` | 첫 로드와 빠른 smoke test | 100 KB |
| `benchy-small.stl` | 일반 slicing·견적 | 5 MB |
| `multi-object.3mf` | object transform과 merge | 10 MB |
| `multi-color.3mf` | material assignment와 painting | 10 MB |
| `multi-plate.3mf` | plate layout과 project round-trip | 15 MB |

fixture의 출처, 라이선스, 생성 방법을 `examples/fixtures/README.md`에 기록한다. 외부 marketplace
모델을 허가 없이 저장하지 않는다.

## 4. 공통 상태와 오류 계약

slice를 수행하는 앱은 최소한 다음 상태를 갖는다.

```ts
type SliceState =
  | { status: 'idle' }
  | { status: 'loading-model' }
  | { status: 'ready' }
  | { status: 'slicing'; progress: number }
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }
```

`onProgress(done, total)`의 `total`이 0일 수 있음을 고려하고, 실제 callback 없이 가짜 progress를
만들지 않는다. `result.error`도 성공 result와 분리해 처리한다.

공통 오류와 사용자의 다음 행동은 다음과 같다.

| 오류 | 사용자 메시지/행동 |
| --- | --- |
| 지원하지 않는 확장자 | 지원 형식과 다시 선택 버튼 표시 |
| 손상된 STL/3MF | 파일을 읽지 못했다는 메시지와 교체 버튼 표시 |
| build volume 초과 | 초과 축과 크기, printer 변경 버튼 표시 |
| profile 없음 | printer/process/material 재선택 유도 |
| worker 초기화·slice 실패 | 재시도 또는 모델 교체 제공 |
| 메모리 부족 | 작은 모델 권장; 조용히 품질을 낮추지 않음 |
| 사용자 취소 | `cancelled`로 전환하고 다시 slice 가능하게 함 |

stack trace와 원본 예외는 개발자 console에만 남긴다.

## 4.5 커널에 넘기는 좌표 — plate-local

**모델은 원점(0, 0) 중심으로 넘긴다. 베드 중앙으로 옮겨서 넘기면 안 된다.** 커널은 plate-local
좌표를 받아 자기가 베드에 올려놓기 때문에, 미리 베드 중앙으로 옮기면 **두 번 더해진다**.

측정값 (250 × 210 베드, 20mm 큐브, `Prusa MK4 0.4 nozzle`):

| 입력 | 결과 G-code의 X 범위 | `stats.over_bed_model` |
| --- | --- | --- |
| 베드 중앙 (125, 105)으로 이동 | 234.7 – 265.4 | **true** (베드 밖) |
| 원점 (0, 0) 중심 | 109.7 – 140.3 | false |

조용히 틀리는 종류의 실수다. 시간·재료량은 그럴듯하게 나오고(2% 차이), 오류도 안 나며, 툴패스를
실제로 **그려보기 전까지는** 보이지 않는다 — farm-dashboard에서 부품이 화면 구석에 점처럼 찍혀서야
발견됐다. 그러니 슬라이스 후에는 항상 `stats.over_bed_model`을 확인한다.

```js
if (result.stats.over_bed_model) throw new Error('slices outside the printable area')
```

베드 크기는 여전히 필요하다 — 모델이 애초에 그 기계에 들어가는지 미리 거르는 용도 (§4의 build
volume 초과 오류).

## 4.6 슬라이스 결과 경로를 그리는 두 가지 경로

`three-slicer/viewer/toolpath`는 UI 컴포넌트가 아니라 **지오메트리 빌더**다 (씬·카메라는 호스트 것).
입력으로 줄 레이어를 어디서 얻느냐에 따라 복원되는 정보가 다르다.

| 입력 | 얻는 곳 | 역할(role) 정보 |
| --- | --- | --- |
| 커널의 레이어 스트림 | `client.slice()`의 `result.layers` (onLayer 콜백을 주지 않으면 딸려 온다) | **정확** |
| G-code 재파싱 | `parseGcode(text).layers` | **근사** — wall로 뭉개짐 |

이유: **이 커널의 G-code 출력에는 `;TYPE:` / `;FEATURE:` 주석이 없다.** `parseGcode`는 문서대로
모르는 역할을 wall(1)로 떨어뜨린다. 같은 20mm 큐브 측정값:

```
커널 레이어에서 : Sparse 43% · Wall 38% · Solid 16% · Skirt 3%
G-code 왕복에서 : Wall 94% · Skirt 6%
```

지오메트리(레이어 수, 세그먼트 위치, 폭)는 양쪽 다 정확하다 — 잃는 것은 역할뿐이다. 그러므로
슬라이스한 쪽에서 바로 그릴 수 있으면 `result.layers`를 쓰고, G-code만 손에 있으면(farm-dashboard)
색이 근사치임을 화면에 밝힌다.

## 4.7 st / mt 커널은 같은 시간을 말하지 않는다

브라우저 워커는 페이지가 cross-origin isolated면 멀티스레드 커널을, 아니면 단일 스레드 커널을
자동으로 고른다. **그 선택이 `time_estimate`를 바꾼다.** 같은 빌드로 같은 20mm 큐브를 측정:

| 페이지 | 워커 로그 | time_estimate | filament | layers / segments |
| --- | --- | --- | --- | --- |
| 헤더 없음 (정적 호스팅) | `core: st` | **12m** | 4.1 g (1.29 m) | 99 / 8,095 |
| COOP/COEP (web/viewer의 `/demos`) | `core: mt (threads)` | **15m** | 4.1 g (1.29 m) | 99 / 8,095 |

지오메트리와 재료는 동일하고 시간만 25% 다르다. 견적·가격을 그 값에 얹는 데모(instant-quote)는
배포 헤더에 따라 가격이 달라진다는 뜻이므로, 어느 커널을 기준으로 할지 정하고 헤더를 고정한다.

## 5. Worker 사용 계약

**Vite에서는 worker를 직접 만들어 넘긴다.** `createSlicerClient()`를 인자 없이 부르면 패키지가
`new URL('./src/slicer.worker.js', import.meta.url)`로 worker를 만드는데, Vite는 이 표현을 **asset
참조로 보고 원본 파일을 그대로 복사**한다. 그 복사본은 여전히 해시되지 않은 `./slicer_core.js`를
import하므로 production build에서 404가 난다. dev server는 소스를 그대로 서빙해서 통과하기 때문에
**`vite build` 이후에만 드러나는 함정이다** (instant-quote에서 실측: dev 정상, build에서 워커가
`/assets/slicer_core.js` fetch 실패). `?worker`로 가져오면 Vite가 kernel chunk까지 제대로 번들한다.

```js
import SlicerWorker from 'three-slicer/worker?worker'   // Vite
const client = createSlicerClient(new SlicerWorker())
```

worker를 어떻게 만드는지는 bundler의 문제이므로, 통합 파일은 worker 팩토리를 **인자로 받아**
bundler 중립으로 유지한다 (§2.1의 "통합 파일은 `three-slicer/*`만 import"와 같은 이유).

같은 원인의 부작용 하나: 그 asset 복사본이 자기 chunk 그래프를 끌고 오기 때문에 **멀티스레드 커널이
dist에 두 벌 들어간다**(+4.3 MB). 네 데모 전부에서 확인했고, `three-slicer/viewer`만 쓰는
printer-showcase도 마찬가지다. 런타임에는 하나만 fetch되므로 사용자 대역폭 문제는 아니고 배포 용량
문제다(데모 하나당 19 MB). 패키지 쪽에서 `engineWorkerURL`을 지연 참조로 바꾸면 사라진다.

브라우저에서 slicing할 때의 최소 흐름이다.

```js
import { createSlicerClient } from 'three-slicer/client'
import { deriveKernelParams } from 'three-slicer/settings'

let client = createSlicerClient()

async function slice(stlBytes, settings, onProgress) {
  const input = stlBytes.slice(0) // worker 전송 후 ArrayBuffer가 detach되므로 재사용할 입력은 복제
  const result = await client.slice(input, deriveKernelParams(settings), { onProgress })
  if (result.error) throw new Error(result.error)
  return result
}

function cancelSlice() {
  if (client.cancel()) return
  client.terminate()
  client = createSlicerClient()
}
```

`cancel()`은 SharedArrayBuffer를 쓸 수 있는 multithreaded kernel에서만 동작한다. 정적 호스팅에서
COOP/COEP가 없으면 `false`를 반환하므로 worker를 종료하고 다시 만든다.

## 6. Settings와 preset 적용 계약

settings map은 sparse하다. profile 교체 시 새 profile이 설정하지 않은 이전 값이 남지 않도록 각
catalog의 `keys`를 먼저 지운다.

```js
import {
  printerKeys,
  printerSettings,
  processPresets,
  filamentPresets,
} from 'three-slicer/settings'

const without = (source, keys) => {
  const next = { ...source }
  for (const key of keys) delete next[key]
  return next
}

const processApi = await processPresets()
const filamentApi = await filamentPresets()

settings = {
  ...without(settings, printerKeys),
  ...printerSettings(printerName),
}
settings = {
  ...without(settings, processApi.keys),
  ...processApi.settingsFor(processName),
}
settings = {
  ...without(settings, filamentApi.keys),
  ...filamentApi.settingsFor(filamentName),
}
```

`printerSettings()`와 `settingsFor()`는 이름이 없으면 `null`이므로 UI에서 먼저 확인한다. schema
default로 빈 값을 채워 kernel에 넘기지 않는다. `deriveKernelParams()`가 omission 규칙을 책임진다.

## 7. 측정과 privacy 증명

개발 모드에서 최소 다음 수치를 확인할 수 있게 한다.

```text
Model parse      120 ms
Kernel warmup    480 ms
Slicing         3.82 s
Total           4.42 s
```

숫자는 `performance.now()` 구간 측정과 실제 worker callback에서 얻는다. 모델이 서버로 가지 않는다고
말하는 데모는 Playwright request listener 또는 브라우저 Network 탭으로 slice 중 model upload가
0건임을 검증한다.

## 8. 접근성·반응형 기준

- 파일 drop zone은 keyboard로도 열 수 있는 button/label을 제공한다.
- 진행률은 `aria-valuenow`가 있는 progressbar 또는 상태 text로 전달한다.
- 오류는 `role="alert"`, 완료 상태는 적절한 live region으로 알린다.
- canvas만으로 의미를 전달하지 않고 핵심 통계와 상태를 text로 함께 표시한다.
- 360px 너비에서 가로 스크롤 없이 핵심 작업을 완료할 수 있어야 한다.
- `prefers-reduced-motion`에서 장식 animation을 줄인다.

## 9. 각 데모 README 규격

보는 확률은 README와 live 링크가 결정하고, 도입 확률은 복사 가능한 통합 파일이 결정한다.
구현 후 README는 **제목 직후, 설명보다 먼저** 통합 파일의 코드 블록(전문 또는 핵심 발췌)을
보여준다 — 도입자는 그 블록 하나로 통합 비용을 판단한다.

구현이 시작되면 각 문서는 다음 순서를 유지한다.

1. 통합 코드 블록 (통합 파일 인용)
2. What this demonstrates
3. 현재 상태 / Try it — live URL, GIF 또는 screenshot, "복사할 파일" 링크
4. Package APIs used
5. Architecture
6. Run locally
7. Important files
8. 상태·오류 계약
9. What is intentionally mocked
10. 검증과 완료 조건
11. Production considerations

`Run locally`와 `Important files`는 실제 앱이 생기기 전까지 명령이나 경로를 추측해 쓰지 않는다.

루트 README에는 데모 갤러리를 둔다: 데모당 GIF 1개 + live 링크 + 복사할 파일 링크, 3줄 이내.
대표 GIF는 printer-showcase에서 만든다(§10 순서대로 나열). 별도의 갤러리 앱은 만들지 않는다.

## 10. 구현 순서

1. `instant-quote`: loader, settings, worker, statistics의 최소 통합을 검증한다.
2. `printer-showcase`: viewer/component embed와 Shadow DOM 격리를 검증한다.
3. `cad-embed`: host-controlled geometry와 자동 재-slice API를 검증한다.
4. `marketplace`: project codec의 public export를 추가한 뒤 3MF 의미 round-trip을 검증한다.
5. `farm-dashboard`: 앞선 browser slicing 흐름 위에 queue와 mock printer를 얹는다.

## 11. Definition of Done

데모 하나는 아래 조건을 모두 만족해야 완료다.

- 독립 프로젝트에서 `npm run dev`, `npm run build`, `npm test`가 성공한다.
- 데모 폴더를 저장소 밖으로 복사해 `npm i && npm run dev`만으로 동작한다 — 저장소의 로컬 소스가
  아니라 **npm에서 설치된 `three-slicer`**로 도는지가 판정 기준이다 (`node_modules/three-slicer`가
  symlink가 아닐 것).
- public `three-slicer/*` export만으로 동작한다. 로컬 build 산출물을 참조하지 않는다.
- 배포한 URL이 저장소 없이도 살아 있다 (정적 호스팅, farm-dashboard 제외).
- 통합 파일이 README에 인용되어 있고, 그 파일의 import가 `three-slicer/*`와 표준 라이브러리뿐이다.
- 라이선스가 기록된 sample fixture가 있고, 첫 화면에서 바로 불러올 수 있다.
- loading, slicing, completed, cancelled, error가 실제 동작과 연결돼 있다.
- 360px viewport와 keyboard-only 핵심 흐름을 검증했다.
- architecture, 실제 API, mock 경계, production 차이가 문서에 적혀 있다.
- 최소 happy-path E2E와 데모 고유 실패-path 하나가 있다.
- 실제 사용자처럼 sample을 로드해 결과 화면까지 확인한 수동 QA 기록이 있다.
- 데모가 담당하는 대표 기능을 다른 데모가 중복해서 홍보하지 않는다.

## 12. 범위 경계

| 데모 | 핵심적으로 증명 | 의도적으로 제외 |
| --- | --- | --- |
| instant-quote | headless WASM slicing과 통계 | 3D 편집기, 결제 |
| printer-showcase | 기존 페이지 안의 visual embed | 프린터 관리 |
| cad-embed | programmable feedback loop | CAD kernel, 3MF marketplace |
| marketplace | 3MF project 보존과 printer 재타기팅 | 검색·리뷰·계정 CRUD |
| farm-dashboard | client-compute queue architecture | 실제 printer protocol |
