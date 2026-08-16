# farm-dashboard — Client-compute Print Farm

> 공통 규칙은 [DEMOS.md](./DEMOS.md)를 따른다. 이 문서는 이 데모 고유의 것만 서술한다.

> **현재 상태:** 구현됨 — [`farm-dashboard/`](./farm-dashboard/) (`npm i && npm run dev`).
> 실행 방법·측정치는 앱의 [README](./farm-dashboard/README.md)에 있다.
> 실측: 같은 큐브가 P1S 12m / MK4 20m, G-code 309–312 kB.
>
> **명세와 크게 달라진 것: backend가 없다.** 이건 데모 페이지로 보여주는 것이 목적이라 정적
> 호스팅이 되어야 해서 내린 결정이다. queue·printer 상태·mock 프린터는 `src/farm_store.js`에
> 들어가고, 그 파일은 서버 모양 그대로다(`snapshot()` = GET /api/state, `addJob()` = POST /api/jobs …).
> 아키텍처 주장은 **전송될 payload를 화면에 그대로 띄워서** 유지한다 — G-code 텍스트와 숫자 3개뿐,
> 모델은 탭을 떠나지 않는다. `test_submit.mjs`가 그 payload와 queue 동작(오프라인 프린터는 잡을
> 시작하지 않음)을 검사한다.
> WebSocket 대신 in-process 이벤트, farm은 빈 상태로 시작(슬라이스 없이는 잡도 없다).
> 남은 것: 배포 URL, screenshot.

## What this demonstrates

여러 프린터의 job을 관리하되 **slicing compute는 운영자 브라우저가 수행**하고, 서버는 queue와
상태만 중계하는 분산형 print farm architecture 데모.

증명하는 것: **N대의 printer가 있어도 slicing server가 커질 필요가 없다.** SimplyPrint·3DQue의
printer-management 기능 재현이 목적이 아니다 — 그들의 대시보드 형태를 빌려 architecture를 보인다.

구현 우선순위는 마지막이다 — Three Slicer 핵심 검증보다 architecture demonstration 성격이 강하다.

## 타깃

소규모 print farm · 대학 fab lab · 사내 printer pool · print management SaaS 개발자.

## Package APIs used

```
three-slicer/client           createSlicerClient() — job별 대상 기종 프로파일로 슬라이스
three-slicer/settings         printerSettings(model) — printer 카드의 기종 ↔ 프로파일 매칭
three-slicer/viewer/gcode     parseGcode(text) — 저장된 G-code 재파싱·검수
three-slicer/viewer/toolpath  buildSegmentData/makeToolpath — 진행 중 job의 레이어 프리뷰
```

## 설치

저장소와 다른 사이트에 배포하는 독립 프로젝트이고, backend가 없어 정적 호스팅으로 끝난다
([DEMOS.md §2](./DEMOS.md#2-독립-프로젝트와-설치)).

```bash
npm i three-slicer three
```

`makeToolpath`는 three를 import하지 않고 인자로 받지만, 데모가 직접 씬을 렌더하므로 three는
client의 의존성이다.

## Queue (backend 없음, 그러나 backend 모양)

책임: job metadata · G-code 보관 · printer state · queue · 이벤트.
**절대 하지 않는 것: STL parsing, slicing, G-code generation.**

이 데모에서는 `src/farm_store.js`가 그 역할을 하고, 메서드가 HTTP 계약과 1:1이다 — 서버로 바꿀 때
호출부를 다시 설계하지 않아도 되도록.

```text
snapshot()          GET  /api/state
addJob(payload)     POST /api/jobs      {name, printerId, gcode, layers, seconds, grams}
setOnline(id, on)   POST /api/printers/:id/online
gcodeOf(jobId)      GET  /api/jobs/:id/gcode
subscribe(fn)       GET  /api/events    (SSE / WebSocket)
```

`addJob`의 payload에는 STL/3MF, vertex buffer, 원본 파일 경로를 넣지 않는다. queue는 G-code를
opaque payload로 보관할 뿐 해석하거나 다시 slicing하지 않는다. 그 payload를 화면에 그대로 띄워
확인 가능하게 만드는 것이 이 데모의 증명 방식이다.

## Mock printers

4대 고정 (DEMOS.md §3의 fixture 그대로): P1S×2(printing/idle) + MK4×2(queued/offline).
어댑터는 interface만 실제처럼:

```ts
interface PrinterAdapter {
  getStatus(): Promise<PrinterStatus>
  submitJob(job: PrintJob): Promise<void>
  pause(): Promise<void>; resume(): Promise<void>; cancel(): Promise<void>
}
class MockPrinterAdapter implements PrinterAdapter { ... }
```

Moonraker · OctoPrint · Bambu protocol 구현 금지 — 어댑터 자체는 데모 대상이 아니다.

## 화면

프린터 4카드 그리드(상태·진행률·현재 layer) + Job Queue 리스트. 와이어프레임은
[DEMOS.md](./DEMOS.md) §3 참조.

## Architecture / 핵심 플로우

```
Add Job → STL 선택 → target printer 선택
  → printerSettings(target 기종) + process 프리셋으로 브라우저 슬라이스   ← client
  → G-code + 숫자만 payload로                                            ← 모델 원본은 안 감
  → queue 등록 (farm_store) → mock printer가 진행 이벤트 발생
  → 카드에서 parseGcode 결과로 toolpath layer progress 표시
```

## 구현 노트

- **toolpath 스트림의 role 필드는 인코딩되어 있다**: `enc = role + tool*16` (stride 8의 `paths[k+3]`).
  읽는 쪽은 반드시 마스크한다 — `& 15`가 role, `>>> 4`가 tool.
- `makeToolpath`는 three를 import하지 않고 **THREE namespace를 인자로 받는다** — 데모의 three
  인스턴스를 그대로 넘겨 단일 인스턴스를 보장한다.
- 진행률(현재 layer)은 mock printer 이벤트의 layer index를 `parseGcode(...).layers`에 매핑해 표시.
- G-code parser 결과는 `const parsed = parseGcode(gcode)` 형태이며, toolpath에는
  `buildSegmentData(parsed.layers, defaultLineWidth)`를 넘긴다.
- 이벤트마다 snapshot을 다시 읽는다. 서버를 붙인다면 event를 로컬 상태에 적용하고 `revision`으로
  뒤처짐만 감지해야 한다 (그래서 store도 `revision`을 내보낸다).
- backend가 없으므로 새로고침하면 queue가 사라진다. 데모 페이지로는 오히려 맞는 동작이다.

## Job 상태

```ts
type JobState = 'slicing' | 'queued' | 'printing' | 'paused' | 'completed' | 'failed' | 'cancelled'
```

브라우저 slicing이 성공하기 전에는 job을 만들지 않는다. offline printer에 submit하면 job은
`queued`로 남고, 그 프린터가 online이 된 뒤에만 `printing`으로 바뀐다.

## 분산 compute 증명

dashboard에 두 가지를 둔다.

```
This browser                      Jobs sliced: 4
A backend, if you added one       Slices it would perform: 0
```

그리고 **전송될 payload 자체**를 보여준다 — G-code 텍스트와 숫자 3개. backend가 없어도 "무엇이
네트워크를 건널 것인가"는 검사 가능하다.

## What is intentionally mocked

- 프린터 하드웨어 전부 (MockPrinterAdapter의 타이머 기반 진행 이벤트)
- 인증·멀티유저 — 없음. 단일 운영자 가정.

## 완료 조건

- [ ] 4 printer card + printer별 상태 표시
- [ ] job 추가 → target 기종 프로파일 매칭 → browser slicing
- [ ] 생성된 G-code queue 등록, queue 표시
- [ ] mock printer progress (realtime 이벤트)
- [ ] G-code toolpath 표시 (기본 전체, 진행 추종은 옵션)
- [ ] **queue 코드에 slicer dependency 없음** — `farm_store.js`는 아무것도 import하지 않는다
- [ ] 전송될 payload를 화면에서 확인 가능

## E2E 시나리오

```
Add Job → benchy-small.stl → Printer 02 (P1S, idle) → Slice → payload 확인(G-code + 숫자만)
→ queue에 등장 → mock 진행 시작 → 카드의 layer 카운트 증가 → toolpath 표시
```

경계 시나리오:

```text
Printer 04 (offline)에 job 등록 → queued 유지 → online 전환 → printing 시작 → completed
→ payload에 model bytes 없음, farm_store.js의 import 목록은 비어 있음
```

## 구현 후 문서에 추가할 항목

- 배포 URL과 screenshot
- store ↔ HTTP 계약 대응표 (backend를 붙일 때의 교체 지점)
- mock clock을 빠르게 돌리는 test 방법 (`createFarm({ tickMs })`)

## Production considerations

실서비스는 backend가 필요하다 — 운영자가 둘 이상이면 같은 queue를 봐야 하고, 새로고침에도 잡이
남아야 하며, 프린터 어댑터(Moonraker/OctoPrint/Bambu)·권한·재시도·파일 보존 정책이 붙는다.
이 데모가 보여주는 것은 그 backend가 **얼마나 얇아도 되는가**이다: queue, 상태, 파일 보관뿐이고
슬라이서는 없다. `farm_store.js`를 그대로 서버로 옮기면 그 서버가 된다.
