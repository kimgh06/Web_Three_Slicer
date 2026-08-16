# Instant Quote — three-slicer demo

모델을 브라우저에서 실제로 슬라이스해 출력 시간과 재료량을 얻고, 그 위에 가격을 얹는 견적
페이지. 모델은 서버로 가지 않는다.

전체 통합은 [`src/estimate.js`](./src/estimate.js) 한 파일이고, 아래가 그 핵심이다. 이 파일은
`three-slicer` 외에 아무것도 import하지 않으므로 그대로 복사해 쓸 수 있다.

```js
import { createSlicerClient } from 'three-slicer/client'
import { deriveKernelParams, printerSettings, processPresets, filamentPresets } from 'three-slicer/settings'

// 1. 프린터 → 품질 → 재질 순으로 프리셋을 병합한다. 각 카탈로그의 keys를 먼저 지우는 이유는
//    프리셋이 자기가 설정하는 키만 들고 있어서, 지우지 않으면 이전 선택이 살아남기 때문이다.
const settings = buildSettings(catalog, { printer, process, filament })

// 2. 워커에서 슬라이스한다. params는 객체를 넘기면 client가 직렬화한다.
//    worker는 호출자가 만들어 넘긴다 — Vite는 `three-slicer/worker?worker` (아래 참조).
const client = createSlicerClient(makeWorker())
const result = await client.slice(stlBytes.slice(0), deriveKernelParams(settings), { onProgress })
if (result.error) throw new Error(result.error)

// 3. stats는 시간(초)과 필라멘트 길이(mm)다. 무게는 직경·밀도로 환산한다.
const { time_estimate: seconds, filament_mm: lengthMm } = result.stats
const grams = lengthMm * Math.PI * (diameter / 2) ** 2 * density / 1000
```

## 현재 상태

동작한다. 아직 배포 URL은 없다 — 정적 호스팅에 그대로 올리면 된다 (`npm run build` → `dist/`).

측정치 (M-series Mac, Chrome, 20mm 정육면체 / P1S 0.4 / 0.20mm Standard / PLA Matte):

```
Model parse       0 ms
Kernel warmup   110–160 ms
Slicing          21–50 ms
결과            12m · 4.1 g (1.29 m) · 99 layers · US$2.92   (단일 스레드 커널)
```

**커널에 따라 시간 추정치가 다르다.** 같은 빌드·같은 모델을 COOP/COEP가 켜진 페이지에서 돌리면
멀티스레드 커널이 선택되고 결과가 **15m · US$3.08**로 바뀐다. 지오메트리(99 layers, 8,095 segments)와
필라멘트(4.1 g / 1.29 m)는 **완전히 동일**하고 `time_estimate`만 25% 차이가 난다. 워커 로그로 확인
가능하다 (`[slicer.worker] core: st` vs `core: mt (threads)`). 견적에 쓰는 값이므로, 배포 환경의
헤더 설정이 가격을 바꾼다는 뜻이다 — 어느 쪽을 기준으로 삼을지 정하고 헤더를 고정하는 편이 좋다.

## Try it

```bash
npm i
npm run dev      # http://localhost:5173
```

첫 화면에서 **Use the sample cube**를 누르고 **Calculate quote**를 누르면 끝이다.

## Package APIs used

| 경로 | 쓰는 것 |
| --- | --- |
| `three-slicer/client` | `createSlicerClient()` → `warmup()`, `slice()`, `cancel()`, `terminate()` |
| `three-slicer/settings` | `printersByVendor`, `printerSettings`, `printerDefaultPreset`, `printerKeys`, `processPresets`, `filamentPresets`, `deriveKernelParams`, `settingScalar` |
| `three-slicer/viewer/loaders` | `loadModel()` — STL/OBJ/3MF/AMF/PLY를 같은 `modelPos`로 |
| `three-slicer/viewer/toolpath` | `buildSegmentData` / `makeToolpath` / `computeColors` / `roleRatios` — 슬라이스 결과 경로 렌더 |

의도적으로 쓰지 않는 것: `three-slicer/viewer`(Viewport 컴포넌트), `three-slicer/components`.
`viewer/toolpath`는 UI 컴포넌트가 아니라 **지오메트리 빌더**라서, 씬·카메라·컨트롤은 이 데모가
직접 들고 있다 — 뷰어 UI 없이 SDK만으로 성립한다는 주장은 그대로다. React도 여전히 쓰지 않는다.

## Architecture

```
파일 드롭 / 샘플
  → loadModel()             ─ 모든 포맷을 modelPos(N*9)로
  → bbox·삼각형 수 표시
  → 프리셋 3종 병합          ─ buildSettings()
  → build volume 검사        ─ overBed()
  → 원점 중심으로 STL 직렬화   ─ toBinarySTL() (베드 중앙 아님 — 아래 참조)
  → client.slice()          ─ 워커, 브라우저 안
  → stats → toEstimate()    ─ 초 · mm · g · layers
  → priceOf()               ─ mock/pricing.js (교체 대상)
  → result.layers → 툴패스   ─ toolpath_view.js (견적의 근거를 눈으로)
```

## Run locally

```bash
npm i          # three-slicer를 npm에서 설치한다 (workspace 링크 아님)
npm run dev
npm run build  # dist/ — 정적 호스팅 가능
npm test       # 통합 파일의 계약 + 실제 슬라이스 1회
```

## Important files

| 파일 | 역할 |
| --- | --- |
| [`src/estimate.js`](./src/estimate.js) | **통합 전부.** 카탈로그, 프리셋 병합, STL 직렬화, 슬라이스, 통계 환산 |
| [`src/mock/pricing.js`](./src/mock/pricing.js) | 가격 공식 — 실제 서비스에서 교체할 파일 |
| [`src/toolpath_view.js`](./src/toolpath_view.js) | 슬라이스 결과 경로 렌더 (three + viewer/toolpath). 단독 복사 가능 |
| [`src/main.js`](./src/main.js) | DOM 배선 + Vite worker 생성. 프레임워크·상태 라이브러리 없음 |
| [`vite.config.js`](./vite.config.js) | ES 워커, es2022, `optimizeDeps.exclude` |
| [`test_estimate.mjs`](./test_estimate.mjs) | 스모크 테스트 |

## 상태와 오류

`idle → loading-model → ready → slicing → completed | cancelled | error`.

진행률은 워커의 `onProgress(done, total)`를 그대로 쓴다 (가짜 애니메이션 없음). `total`이 0인
구간은 "Preparing slicer…"로 표시한다. 처리하는 오류는 파일 파싱 실패, build volume 초과(초과 축과
치수를 함께), 프리셋 없음, 슬라이스 실패, 압출 없음(시간 0 또는 필라멘트 0)이며 전부
`role="alert"`로 알린다.

취소는 두 갈래다. `client.cancel()`은 커널이 C++ 루프 안에서 읽는 플래그이고 그 플래그가
SharedArrayBuffer에 있어서 **cross-origin isolated 페이지에서만** 동작한다. 그렇지 않으면 워커를
종료하고 새로 만든다 — 이 데모의 기본값이며, 다음 견적이 warmup을 다시 낸다. COOP/COEP를 켜서
멀티스레드 커널을 쓰려면 `vite.config.js`의 주석 처리된 `server.headers`를 살린다.

## 슬라이스 결과 경로 보기

견적 카드 아래에 실제 툴패스가 그려진다 — 기본값은 **전체 레이어 + travel 포함**이고, 슬라이더로
층을 잘라 보거나 travel을 끌 수 있다. 역할 비율(Sparse/Wall/Solid/Skirt)은 `roleRatios()`가
압출 길이 기준으로 계산한 값이다.

여기서 쓰는 레이어는 `client.slice()`가 돌려준 `result.layers`다. `onLayer` 콜백을 주지 않으면
클라이언트가 스트리밍된 레이어를 `[{z, paths, widths}]`로 모아 주고, 그게 `buildSegmentData()`가
바로 먹는 모양이라 **G-code를 다시 파싱할 필요가 없다.** (역할 정보도 이 경로에서만 정확하다 —
자세한 것은 [farm-dashboard README](../farm-dashboard/README.md#실측으로-드러난-것)를 볼 것.)

## 모델은 원점 중심으로 넘긴다

`toBinarySTL()`은 모델을 베드 중앙이 아니라 **원점(0, 0) 중심**으로 옮긴다. 커널은 plate-local
좌표를 받아 자기가 베드에 올려놓기 때문에, 미리 베드 중앙으로 옮기면 좌표가 두 번 더해져 부품이
베드 밖에서 슬라이스된다 — 시간·재료량은 그럴듯하게 나오고 오류도 없다. 유일한 신호가
`stats.over_bed_model`이라, 슬라이스마다 그것을 확인한다.
자세한 측정값: [DEMOS.md §4.5](../DEMOS.md#45-커널에-넘기는-좌표--plate-local)

## Vite에서 worker를 직접 만드는 이유

`createSlicerClient()`를 인자 없이 부르면 패키지가 `new URL('./src/slicer.worker.js',
import.meta.url)`로 worker를 만든다. Vite는 이 표현을 asset 참조로 보고 워커 파일을 **가공 없이
복사**하므로, 그 복사본은 해시되지 않은 `./slicer_core.js`를 import한 채로 남고 production build에서
404가 난다. dev server는 소스를 그대로 서빙해서 멀쩡히 돌기 때문에 **`vite build` 이후에만 드러난다**
(이 데모에서 실측: dev 정상, preview에서 `Failed to fetch dynamically imported module:
/assets/slicer_core.js`).

그래서 worker는 `main.js`가 `three-slicer/worker?worker`로 만들어 `createEstimator()`에 넘긴다.
`estimate.js`는 worker 팩토리를 인자로 받기만 하므로 bundler 중립으로 남고, `three-slicer/*` 외에는
아무것도 import하지 않는다.

## What is intentionally mocked

- **가격.** `filamentPricePerKg` 25, `machineHourlyRate` 3, `handlingFee` 2, `marginMultiplier` 1.08 —
  실제 시장가가 아니며 UI에도 그렇게 적혀 있다.
- 결제·주문·배송·계정 — 없다. 견적 카드에서 끝난다.

## 프라이버시

슬라이싱 중 모델 업로드 요청은 발생하지 않는다 (개발자 도구 Network 탭에서 확인 가능).
analytics를 붙이더라도 파일명·원본 크기·geometry hash는 보내지 않는다.

## Production considerations

- 가격: 인건비, 장비 감가상각, 실패율, support 제거, 배송, 세금, 최소 주문 금액.
- 여러 모델을 한 판에 올려 함께 견적내려면 배치(plate layout)가 필요하다. 이 데모는 한 파일을
  베드 중앙에 한 개만 놓는다.
- 큰 모델은 warmup과 슬라이스가 길어진다. cancel이 실제로 필요하면 COOP/COEP를 켜서 멀티스레드
  커널을 쓰는 편이 낫다.
- 번들은 커널 WASM 때문에 크다. 첫 방문에 warmup을 미루고 파일 선택 시점에 시작하는 것도 방법이다.
