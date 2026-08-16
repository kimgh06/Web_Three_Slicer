# CAD Embed — three-slicer demo

파라메트릭 설계 도구 안에서 슬라이서를 **programmable engine**으로 쓰는 데모. 슬라이더를 움직이면
저장도 내보내기도 없이 출력 시간과 재료량이 따라온다.

통합은 [`src/print_feedback.js`](./src/print_feedback.js) 한 파일이고, 핵심은 이 루프다.

```js
const loop = createFeedbackLoop({
  makeWorker: () => new SlicerWorker(),
  onState: render,          // {status:'stale'|'slicing'|'ready'|'error', …}
})

// 파라미터가 바뀔 때마다 호출한다. 700ms 동안 잠잠해지면 마지막 지오메트리 하나만 슬라이스된다.
loop.request(positions, settings)

// 슬라이스할 수 없는 설계(구멍이 부품보다 큼 등)로 넘어갔을 때.
loop.invalidate()
```

`request()`가 하는 일은 두 가지고, 둘 다 없으면 통합이 고장난 것처럼 보인다.

1. **디바운스** — 슬라이더 드래그가 픽셀마다 슬라이스를 큐에 넣지 않게 한다.
2. **generation 가드** — 이미 낡은 슬라이스의 결과가 최신 답을 덮어쓰지 못하게 한다.
   워커는 FIFO라 요청을 취소해도 답은 돌아온다. 돌아온 답을 **버리는** 쪽이 확실하다.

## 현재 상태

동작한다. 배포 URL은 아직 없다 (`npm run build` → `dist/`, 정적 호스팅 가능).

실측 (M-series Mac, Chrome, P1S 0.4 / 0.20mm Standard / PLA Matte, 404 facet 브래킷):

| 설계 | 결과 |
| --- | --- |
| 80 × 50 × 4 mm, 구멍 8 mm | 31m · 10.6 g · 19 layers |
| 두께만 4 → 8 mm | 39m · 15.4 g · 39 layers (`+8m · +4.8 g`) |
| 80 × 20 × 8 mm, 구멍 8 mm | 17m · 4.6 g |

슬라이더를 4번 연속으로 움직여도 슬라이스는 1회만 실행된다 (`stale` ×4 → `slicing` 1회).

## Try it

```bash
npm i
npm run dev      # http://localhost:5173
```

슬라이더를 움직이고 손을 떼면 오른쪽 숫자가 갱신된다.

## Package APIs used

| 경로 | 쓰는 것 |
| --- | --- |
| `three-slicer/client` | `createSlicerClient()` → `warmup()`, `slice()`, `cancel()`, `terminate()` |
| `three-slicer/settings` | `printerSettings`, `printerDefaultPreset`, `processPresets`, `filamentPresets`, `deriveKernelParams`, `settingScalar` |
| `three-slicer/toggle` | `makeCfg` + `disabledKeys` — 슬라이서의 enable_if 규칙을 호스트 컨트롤에 그대로 적용 |
| `three-slicer/viewer/toolpath` | `buildSegmentData` / `makeToolpath` / `computeColors` — 재슬라이스마다 툴패스 갱신 |

`<Viewport/>`는 쓰지 않는다. 설계 화면은 호스트의 three.js 씬이고, 슬라이서는 숫자만 돌려준다 —
이 데모가 파는 것이 "화면"이 아니라 "API"이기 때문이다. 3MF 왕복은
[marketplace](../marketplace.md)의 몫이라 여기서 다루지 않는다.

## Architecture

```
슬라이더 변경
  → validate()            ─ CAD 도메인 오류는 워커를 부르기 전에 차단 (+ loop.invalidate())
  → makeBracket()         ─ three.js ExtrudeGeometry (사각 판 + 관통 구멍)
  → trianglesOf()         ─ 삼각형 soup (N*9)
  → loop.request()        ─ 700ms 디바운스 + generation++
      → toBinarySTL()     ─ 원점 중심, 최저점 z=0 (베드 중앙 아님)
      → client.slice()    ─ 워커
      → toFeedback()      ─ 초 · mm · g · layers
  → onState('ready')      ─ 이전 값과의 차이 + 툴패스 갱신 (toolpath_view.js)
```

## Run locally

```bash
npm i
npm run dev
npm run build && npm run preview
npm test       # 지오메트리·STL 계약 + 실제 슬라이스 + 루프 규칙 3가지
```

## Important files

| 파일 | 역할 |
| --- | --- |
| [`src/print_feedback.js`](./src/print_feedback.js) | **통합 전부.** 프리셋, STL 직렬화, 디바운스·generation 루프, 통계 환산 |
| [`src/bracket.js`](./src/bracket.js) | 파라메트릭 지오메트리 + 도메인 검증 (CAD 쪽) |
| [`src/toolpath_view.js`](./src/toolpath_view.js) | 슬라이스 결과 경로 렌더. 단독 복사 가능 |
| [`src/main.js`](./src/main.js) | three.js 씬, 슬라이더 배선, Vite worker 생성 |
| [`test_feedback.mjs`](./test_feedback.mjs) | 스모크 테스트 (가짜 워커로 루프 규칙 검증) |

## 상태와 오류

```
stale → slicing(progress) → ready
                          ↘ error
```

- **stale**: 값이 바뀌었고 디바운스를 기다리는 중. 이전 숫자를 흐리게 유지한다 (지우지 않는다 —
  "이전 설계의 결과"라는 정보는 여전히 유효하다).
- **error**: 슬라이스 실패, 또는 애초에 슬라이스할 수 없는 설계. 후자는 `validate()`가
  `makeBracket()`보다 먼저 잡는다.
- 취소된 generation은 조용히 버려진다 — 오류 토스트를 띄우지 않는다.

`invalidate()`가 없으면 생기는 실제 버그 (이 데모에서 관측 후 고침): 유효한 변경이 슬라이스를
예약한 직후 무효한 값으로 넘어가면, 1초 뒤 그 낡은 결과가 도착해 오류 메시지를 지우고
"Up to date"로 바꿔 버린다. 화면의 숫자는 슬라이더가 말하는 설계와 다른 것을 가리키게 된다.

## 슬라이스 결과 경로 보기

설계 아래에 슬라이서가 실제로 만든 경로가 그려지고, **재슬라이스마다 다시 만들어진다** —
두께 4 → 8 mm면 20 레이어 11,149 세그먼트에서 40 레이어 22,615 세그먼트로 바뀐다. 기본값은
전체 레이어 + travel 포함이고 슬라이더로 잘라 볼 수 있다.

`loop`가 `onState('ready')`에 `layers`를 함께 실어 보낸다. `client.slice()`에 `onLayer` 콜백을 주지
않았으므로 클라이언트가 레이어를 모아 주고, 그게 `buildSegmentData()`의 입력 모양 그대로다 —
G-code 재파싱 없음.

## 모델은 원점 중심으로 넘긴다

`toBinarySTL()`은 설계를 베드 중앙이 아니라 **원점(0, 0) 중심**으로 옮긴다. 커널이 plate-local
좌표를 받아 자기가 베드에 올려놓기 때문이고, 미리 베드 중앙으로 옮기면 두 번 더해져 베드 밖에서
슬라이스된다. 신호는 `stats.over_bed_model` 하나뿐이라 슬라이스마다 확인한다.
자세한 측정값: [DEMOS.md §4.5](../DEMOS.md#45-커널에-넘기는-좌표--plate-local)

## Vite에서 worker를 직접 만드는 이유

`createSlicerClient()`를 인자 없이 부르면 패키지가 `new URL('./src/slicer.worker.js',
import.meta.url)`로 worker를 만드는데, Vite는 이 표현을 asset 참조로 보고 워커 파일을 가공 없이
복사한다. 그 복사본은 해시되지 않은 `./slicer_core.js`를 import한 채라 production build에서만 404가
난다 (dev는 통과). 그래서 `main.js`가 `three-slicer/worker?worker`로 만들어 넘긴다.
`print_feedback.js`는 worker 팩토리를 인자로 받기만 하므로 bundler 중립으로 남는다.

## What is intentionally mocked

- CAD 커널 — B-rep도 피처 트리도 없다. three.js `ExtrudeGeometry` 하나가 전부다.
- 저장·프로젝트·버전 관리 — 없다. 피드백 루프에서 끝난다.

## Production considerations

- **지오메트리 증분 업데이트**: 지금은 파라미터가 바뀔 때마다 전체 메시를 다시 만들어 전부
  직렬화한다. 404 facet에서는 무시할 만하지만 실제 CAD 모델(수십만 facet)에서는 변경된 부분만
  다시 만드는 편이 낫다.
- **결과 캐싱**: 같은 파라미터 조합으로 되돌아오는 일이 잦다. `JSON.stringify(params)` 키로 캐시하면
  슬라이더를 앞뒤로 움직일 때 워커를 거의 안 부른다.
- **워커 풀**: 지금은 워커 하나가 FIFO로 처리한다. 설계 여러 개를 동시에 비교하려면 풀이 필요하다.
- **단위계**: 커널은 mm를 가정한다. inch 기반 CAD라면 직렬화 직전에 변환해야 한다.
- `cancel()`은 cross-origin isolated 페이지에서만 진짜 취소이고, 아니면 워커 재시작이다. 디바운스가
  있어 자주 쓸 일은 없지만, 큰 모델을 다룬다면 COOP/COEP를 켜는 편이 낫다.
