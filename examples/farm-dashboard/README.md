# Print Farm — three-slicer demo

여러 대의 프린터를 한 화면에서 관리하되 **슬라이싱은 운영자 브라우저가** 하는 아키텍처 데모.
백엔드는 없다 — 정적 페이지 하나로 돌아간다.

통합은 [`src/submit_job.js`](./src/submit_job.js) 한 파일이고, 이 함수가 데모의 주장 전부다.

```js
// 대상 프린터의 프로파일로 슬라이스하고, 큐에 올릴 payload를 만든다.
export async function prepareJob({ client, model, printer, onProgress }) {
  const settings = await settingsForPrinter(printer.model)          // 기종마다 다른 프로파일
  const result = await client.slice(toBinarySTL(model), deriveKernelParams(settings), { onProgress })

  return {
    payload: {
      name: model.name, printerId: printer.id,
      gcode: result.gcode,                                          // 텍스트
      layers: result.stats.layers,
      seconds: result.stats.time_estimate,
      grams: /* filament_mm → g */,
    },
  }
}
```

모델도 정점 버퍼도 파일명도 이 함수를 떠나지 않는다. 그래서 이 payload는 **큐 서버가 있었다면
받았을 것 전부**이기도 하고, 화면에서 그대로 확인할 수 있다.

## 백엔드가 없는데 왜 분산 아키텍처 데모인가

이 페이지는 데모용이라 정적 호스팅이 되어야 해서 백엔드를 두지 않았다. queue·프린터 상태·mock
프린터는 [`src/farm_store.js`](./src/farm_store.js)에 있고, 그 파일은 **서버 모양 그대로** 만들었다.

| store 메서드 | 대응하는 HTTP |
| --- | --- |
| `snapshot()` | `GET /api/state` |
| `addJob(payload)` | `POST /api/jobs` — 데이터를 싣는 유일한 호출 |
| `setOnline(id, on)` | `POST /api/printers/:id/online` |
| `gcodeOf(jobId)` | `GET /api/jobs/:id/gcode` |
| `subscribe(fn)` | `GET /api/events` (SSE/WebSocket) |

주장은 "서버가 없다"가 아니라 **"서버가 있어도 슬라이서는 필요 없다"**이다. 그래서 두 가지를
검사 가능하게 두었다.

1. **전송될 payload를 화면에 띄운다** — 슬라이스 후 "What a queue server would receive" 패널에
   `{name, printerId, gcode: "<309 kB of G-code text>", layers, seconds, grams}`가 그대로 뜬다.
2. **`farm_store.js`는 아무것도 import하지 않는다** — `test_submit.mjs`가 import 목록이 비어 있음을
   검사한다. 이 파일을 그대로 서버로 옮기면 그게 곧 슬라이서 없는 큐 서버다.

## 현재 상태

동작한다. 정적 빌드만으로 배포 가능하다 (`npm run build` → `dist/`).

실측 (M-series Mac, Chrome, 20mm 큐브):

| 대상 | 결과 | G-code |
| --- | --- | --- |
| Printer 01 (P1S 0.4) | 12m · 4.1 g · 99 layers | 309 kB |
| Printer 03 (MK4 0.4) | 20m · 4.1 g · 99 layers | 312 kB |

같은 모델인데 시간이 다른 이유는 기종 프로파일의 모션 리밋이 실제로 반영되기 때문이다.
큐에 보관된 G-code를 다시 파싱하면 99 layers · 8,658 segments가 나온다.

## Try it

```bash
npm i
npm run dev      # http://localhost:5173
```

**Use sample cube** → 대상 프린터 선택 → **Slice & queue**. 큐에 올라가고, mock 프린터가 레이어를
올리기 시작하며, 큐의 행을 누르면 그 잡의 툴패스가 보인다.

첫 화면의 farm이 비어 있는 것은 의도다: **잡은 슬라이스가 있어야 생기고, 슬라이스는 이 브라우저만
할 수 있다.** 서버가 있었어도 마찬가지다.

## Package APIs used

| 경로 | 쓰는 것 |
| --- | --- |
| `three-slicer/client` | `createSlicerClient()` — 잡마다 대상 기종 프로파일로 슬라이스 |
| `three-slicer/settings` | `printerSettings`, `printerDefaultPreset`, `processPresets`, `filamentPresets`, `deriveKernelParams`, `settingScalar` |
| `three-slicer/viewer/loaders` | `loadModel()` — STL/OBJ/3MF/AMF/PLY |
| `three-slicer/viewer/gcode` | `parseGcode()` — 보관된 G-code를 다시 레이어로 |
| `three-slicer/viewer/toolpath` | `buildSegmentData` / `makeToolpath` / `computeColors` |

## Architecture

```
브라우저 (한 탭 안에서)
──────────────────────────────────────────────────────────
모델 읽기         loadModel
대상 기종 프로파일  settingsForPrinter
슬라이스          client.slice          ← 여기가 유일한 compute
payload 생성      prepareJob            → {gcode, 숫자}   ← 네트워크를 건널 전부
   │
   └─▶ farm_store  addJob / snapshot / subscribe / gcodeOf   ← 서버로 교체 가능한 지점
          │            mock printer가 레이어를 올림
          ▼
G-code 다시 파싱   parseGcode
툴패스 렌더       makeToolpath          (기본: 전체 레이어. "Follow print progress"를
                                        켜면 프린터가 도달한 층까지만 표시)
```

## Run locally

```bash
npm i
npm run dev
npm run build && npm run preview   # 정적 산출물로도 동일하게 동작
npm test                           # payload 검사 + 실제 슬라이스 + queue 동작
```

## Important files

| 파일 | 역할 |
| --- | --- |
| [`src/submit_job.js`](./src/submit_job.js) | **통합 전부.** 프로파일, STL 직렬화, 슬라이스, payload 생성 |
| [`src/farm_store.js`](./src/farm_store.js) | queue·프린터 상태·mock 프린터. 서버로 교체할 자리 |
| [`src/toolpath_view.js`](./src/toolpath_view.js) | 툴패스 렌더 (three + viewer/toolpath). 세 데모가 같은 파일을 복사해 쓴다 |
| [`src/main.js`](./src/main.js) | 대시보드 UI |
| [`test_submit.mjs`](./test_submit.mjs) | 스모크 테스트 |

## Mock 경계

- **프린터 하드웨어 전부.** `farm_store.js`의 타이머가 레이어를 올린다. Moonraker/OctoPrint/Bambu
  프로토콜은 구현하지 않는다 — 어댑터는 이 데모가 파는 물건이 아니다. 실물 어댑터도 같은 모양이면
  된다: 잡을 받고, 진행을 알리고, 끝나거나 실패한다.
- **영속성 없음.** 새로고침하면 큐가 사라진다. 데모 페이지로는 맞는 동작이다.
- **인증·멀티유저** 없음. 운영자 한 명, 탭 하나 가정.

## 실측으로 드러난 세 가지

**(1) 모델은 원점 중심으로 커널에 넘겨야 한다.** 베드 중앙으로 옮겨서 넘기면 커널이 다시 베드에
올리면서 좌표가 두 번 더해진다. 250 × 210 베드에서 큐브가 X 234.7–265.4에 슬라이스됐고 —
베드 밖인데 — 시간·재료량은 멀쩡해 보였다. 유일한 신호는 `stats.over_bed_model`이고, 눈으로는
**툴패스를 그려봐야** 보인다 (부품이 화면 구석에 점으로 찍혔다). 지금은 슬라이스마다 그 플래그를
확인한다. [DEMOS.md §4.5](../DEMOS.md#45-커널에-넘기는-좌표--plate-local)

**(2) 커널 G-code에는 `;TYPE:` 역할 주석이 없다.** 그래서 보관된 G-code를 다시 파싱하면 지오메트리는
정확히 복원되지만 **역할은 복원되지 않는다** — `parseGcode`의 문서대로 모르는 역할은 wall로 떨어진다.
같은 큐브를 커널의 레이어 스트림에서 그리면 `Sparse 43% · Wall 38% · Solid 16% · Skirt 3%`인데,
G-code 왕복으로 그리면 `Wall 94% · Skirt 6%`가 된다. 이 데모의 색은 그래서 근사치이고, 화면에도
그렇게 적어 두었다. 정확한 역할이 필요하면 instant-quote/cad-embed처럼 슬라이스 결과의 `layers`를
직접 그려야 한다.

**(3) `SegmentData.position`은 stride 4다** (x, y, z, w). 타입 정의에는 `Float32Array`라고만 적혀
있어서 stride 3으로 읽었더니 좌표 채널이 섞여 카메라가 엉뚱한 곳을 봤다. 툴패스 bbox를 직접
계산한다면 stride 4로 읽어야 한다. `data.bbox`는 travel까지 포함하고, 첫 레이어에는 프린터의
프라임 라인이 있어서, 부품에 카메라를 맞추려면 둘 다 빼야 한다.

## Production considerations

실서비스에는 backend가 필요하다 — 운영자가 둘 이상이면 같은 큐를 봐야 하고, 새로고침 후에도 잡이
남아야 하며, 남이 올린 잡의 G-code도 열어봐야 한다. 이 데모가 보여주는 것은 그 backend가 **얼마나
얇아도 되는가**다.

- **교체 지점**: `farm_store.js`의 다섯 메서드를 fetch/SSE로 바꾸면 끝난다. 호출부는 이미 그 모양이다.
- **G-code 저장**: 잡 하나가 수백 kB~수십 MB다. 객체 스토리지 + 만료 정책.
- **이벤트 적용**: 지금은 이벤트마다 스냅샷을 다시 읽는다. 규모가 커지면 이벤트를 로컬 상태에
  적용하고 `revision`으로 뒤처짐만 감지해야 한다.
- **프린터 어댑터**: Moonraker/OctoPrint/Bambu, 재연결, 오프라인 큐, 실패 재시도.
- **권한**: 누가 어느 프린터에 잡을 넣을 수 있는가.
- 운영자가 늘어도 슬라이싱은 각자 브라우저에서 도니 backend는 그대로 얇게 유지된다.
