# cad-embed — Design-to-Print Feedback Loop

> 공통 규칙은 [DEMOS.md](./DEMOS.md)를 따른다. 이 문서는 이 데모 고유의 것만 서술한다.

> **현재 상태:** 구현됨 — [`cad-embed/`](./cad-embed/) (`npm i && npm run dev`).
> 실행 방법·측정치는 앱의 [README](./cad-embed/README.md)에 있다.
> 실측: 80×50×4 브래킷 31m·10.5g → 두께만 8mm로 39m·15.2g. 슬라이더 4연속 변경 → 슬라이스 1회.
> 명세에 없던 규칙 하나가 구현 중 드러났다: 도메인 오류 시 **예약된 슬라이스를 무효화**해야 한다
> (`loop.invalidate()`). 없으면 낡은 결과가 1초 뒤 도착해 오류 메시지를 "Up to date"로 덮는다.
> 남은 것: 배포 URL, screenshot.

## What this demonstrates

웹 CAD/파라메트릭 설계도구가 three-slicer를 **programmable engine**으로 호출하여, 설계 변경이
출력 시간·재료량에 미치는 영향을 즉시 보여주는 통합 예제.

질문은 하나다: **"설계하는 동안 manufacturing cost를 바로 볼 수 있다면?"** Tinkercad·Onshape류
browser CAD는 설계와 slicing이 별도 단계로 단절되어 있다 — 그 단절을 없애는 루프가 주인공이다.

3MF round-trip은 이 데모에서 다루지 않는다 — 그 주인공은 [marketplace](./marketplace.md)로 고정.

이 데모의 숨은 역할: **API 설계 검증.** 만들다 package private state를 조작해야 한다면 데모가
아니라 package API가 부족한 것이다 (DEMOS.md §8 Phase 2).

## 타깃

browser CAD · generative design · product configurator · parametric design SaaS.

## Package APIs used

```
three-slicer/client   createSlicerClient() — slice / cancel / terminate
three-slicer/settings deriveKernelParams(settings) — 호스트 settings → 커널 파라미터
three-slicer/toggle   makeCfg/disabledKeys — 옵션 활성/비활성 규칙을 호스트 UI에서 재사용
three-slicer/viewer   (선택) <Viewport gcode={...}/> — 슬라이스 결과 프리뷰를 뷰어에 위임
```

## 설치

이 데모는 저장소와 다른 사이트에 배포하는 독립 프로젝트다 ([DEMOS.md §2](./DEMOS.md#2-독립-프로젝트와-설치)).

```bash
npm i three-slicer three react react-dom
```

`three`는 파라메트릭 지오메트리 생성과 CAD 캔버스에 필요하고, react/react-dom은 Viewport를
쓸 때만 필요하다. Viewport 없이 통계만 표시한다면 `npm i three-slicer three`로 충분하다 —
`client`·`settings`·`toggle`은 프레임워크를 요구하지 않는다.

## CAD 부분

실제 CAD kernel을 만들지 않는다. three.js primitive로 만든 파라메트릭 브래킷 하나:

```ts
interface BracketParams { width: number; height: number; thickness: number; holeDiameter: number }
```

슬라이더 4개 (Width/Height/Thickness/Hole). 화면은 좌 DESIGN(브래킷 3D) / 우 PRINT FEEDBACK
(print time · material · layers) 2분할 — 와이어프레임은 [DEMOS.md](./DEMOS.md) §4 참조.

## Slicing 정책

parameter 변경마다 무한 slicing하지 않는다:

```
Change → Change → Change → 700ms idle → 최신 geometry만 slice
```

`const RESLICE_DEBOUNCE_MS = 700` + 이전 작업 cancel. 이 패턴 자체가 SDK integration 예제다.

요청마다 증가하는 generation id를 두어 종료된 옛 worker의 결과가 최신 설계 결과를 덮지 못하게 한다.

```js
let generation = 0
let timer

function scheduleSlice() {
  const mine = ++generation
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const result = await sliceCurrentGeometry()
    if (mine === generation) showFeedback(result)
  }, 700)
}
```

## 핵심 API 예시 (README에서 UI 코드보다 먼저 보여야 하는 코드)

```js
const client = createSlicerClient()
const params = deriveKernelParams(hostSettings)
const result = await client.slice(stlBytes, params, { onProgress })
if (result.error) throw new Error(result.error)
setManufacturingFeedback({
  printTimeSec: result.stats.time_estimate,
  filamentMm:   result.stats.filament_mm,   // 무게(g)는 직경·밀도로 호스트가 환산
})
```

## 구현 노트

- **slice 입력은 STL 바이트다.** 파라메트릭 지오메트리(three.js BufferGeometry)를 바이너리 STL로
  직렬화하는 유틸이 필요하다 (three/examples의 STLExporter 또는 ~30줄 직접 구현).
- **cancel은 조건부**: `client.cancel()`은 MT 커널(cross-origin-isolated 페이지)에서만 동작.
  아니면 superseded slice는 `terminate()` 후 클라이언트 재생성으로 버린다 — debounce가 있으므로
  재생성 빈도는 낮다.
- **filament는 mm.** g 표시는 filament 프리셋의 직경·밀도로 환산 ([instant-quote](./instant-quote.md)와
  같은 공식) — 두 데모가 같은 환산을 쓰지만 각자 ~5줄이므로 공유 패키지를 만들지 않는다.
- Viewport를 쓴다면 **호스트가 settings를 소유**하고 `gcode` prop으로 결과만 넘긴다 — 커널을 두 번
  띄우지 않는 host-control 임베드 패턴.
- `<Viewport/>`에는 programmatic model 입력 prop이 없다. CAD geometry는 CAD canvas가 표시하고,
  slicing 결과만 `gcode` prop으로 Viewport에 넘긴다. `defaultAutoSlice`를 함께 켜면 중복 slice가 된다.
- toggle은 `disabledKeys(makeCfg(settings))` 결과에 포함된 control을 비활성화한다. `evalEnableIf()`의
  `null`은 false가 아니라 “판단 불가, fail-open”이다.

## 상태와 오류

- geometry 생성 실패와 slicing 실패를 분리해 어느 단계가 실패했는지 표시한다.
- 변경 후 debounce 대기 중에는 이전 수치를 “이전 설계 결과”로 표시한다.
- hole diameter가 bracket 외곽을 침범하는 등 CAD domain 오류는 worker를 호출하기 전에 막는다.
- 취소된 generation은 오류 toast를 띄우지 않는다.

## What is intentionally mocked

- CAD kernel (B-rep/피처 트리) — three.js primitive 조합이 전부.
- 저장·내보내기·프로젝트 관리 — 없음. 피드백 루프에서 끝.

## 완료 조건

- [ ] 4 parametric controls + geometry 재생성
- [ ] 호스트가 three-slicer 상태(settings) 소유
- [ ] debounce + 이전 slicing cancel(또는 terminate fallback)
- [ ] 자동 재슬라이스 → print time · filament 변화 표시
- [ ] viewer host-control (사용 시)
- [ ] 별도 export/import 없이 feedback 생성
- [ ] public export만 사용 — private 접근이 필요해지면 package API 이슈로 환원

## E2E 시나리오

```
초기 로드 → 자동 slice → 피드백 표시
→ Thickness 4→8mm → 700ms 후 재슬라이스 1회만 발생(중간 변경은 cancel)
→ filament·print time 증가 확인
```

추가 회귀 시나리오:

```text
Thickness slider를 10회 빠르게 이동 → 마지막 값으로 slice 1회만 완료 → 이전 결과가 UI를 덮지 않음
```

## 구현 후 문서에 추가할 항목

- live URL과 screenshot
- 실제 실행·build·test 명령
- bracket parameter 범위와 단위
- STL serializer와 debounce controller의 파일 경로

## Production considerations

실제 CAD 통합은 지오메트리 증분 업데이트(전체 재직렬화 대신), 슬라이스 결과 캐싱(동일 파라미터
재방문), 워커 풀, 그리고 설계 단위계(mm 가정) 검증이 추가로 필요하다.
