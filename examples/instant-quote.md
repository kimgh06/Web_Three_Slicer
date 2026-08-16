# instant-quote — FDM 출력 대행 자동 견적

> 공통 규칙(디렉터리, 상태 머신, 오류 처리, 성능 표시, fixture)은 [DEMOS.md](./DEMOS.md)를 따른다. 이 문서는 이 데모 고유의 것만 서술한다.

> **현재 상태:** 구현됨 — [`instant-quote/`](./instant-quote/) (`npm i && npm run dev`).
> 이 문서는 명세로 남고, 실행 방법·파일 구조·측정치는 앱의 [README](./instant-quote/README.md)에 있다.
> 실측(20mm 큐브 / P1S 0.4 / 0.20mm Standard / PLA Matte): 12m · 4.0g · 99 layers, 슬라이싱 21–48ms.
> 남은 것: 배포 URL, screenshot, `benchy-small.stl` fixture.

## What this demonstrates

사용자가 모델을 선택하면 **브라우저에서 실제 slicing을 수행**하여 출력 시간과 filament 사용량 기준으로 즉시 FDM 견적을 계산하는 **headless** 데모.

증명하는 것: **서버에 모델을 보내지 않고 actual slicer output으로 FDM quote를 계산할 수 있다.** 뷰어 없이도 three-slicer가 독립 SDK로 성립함을 보이는 데모이므로, `three-slicer/viewer`와 `three-slicer/components`는 의도적으로 사용하지 않는다.

레퍼런스 UX: Hubs(옵션 변경 → 실시간 quote 갱신), Treatstock(재료·support 등 비용 요소 반영), Craftcloud(업로드 → 제조 조건 선택 흐름). 이들을 복제하는 것이 아니라 "모델이 브라우저를 떠나지 않는다"는 차이를 판다. FDM으로 한정한다 — SLS/MJF/SLA 견적 엔진인 것처럼 보이지 않게 한다.

## 타깃

FDM 출력 대행 업체 · 소규모 print farm · 주문형 제조 플랫폼 · 견적 widget SaaS.

## Package APIs used

```
three-slicer/client         createSlicerClient() → slice(stl, params, {onProgress}), terminate()
three-slicer/settings       printerSettings(name), processPresets(), filamentPresets(),
                            deriveKernelParams(settings), settingScalar(settings, key)
three-slicer/viewer/loaders loadModel(name, buffer) — 파일 파싱·치수 표시용
```

사용하지 않음: `three-slicer/viewer`, `three-slicer/components`.

## 설치

이 데모는 저장소와 다른 사이트에 배포하는 독립 프로젝트다 ([DEMOS.md §2](./DEMOS.md#2-독립-프로젝트와-설치)).

```bash
npm i three-slicer three
```

`three`가 필요한 이유는 뷰어가 아니라 `three-slicer/viewer/loaders`가 three를 import하기 때문이다
(STL/OBJ/PLY/AMF 로더). 반대로 `three-slicer/client`와 `/settings`는 아무것도 import하지 않으므로
**React 없이 vanilla JS로 만드는 것을 권장한다** — "이 SDK는 프레임워크를 요구하지 않는다"가 이
데모가 추가로 증명할 수 있는 사실이고, 통합 파일(`quote.js`)이 그대로 어느 앱에나 붙는다.

## 화면

초기 → 파일 로드 후 → 계산 중 → 결과의 4단계. 와이어프레임은 [DEMOS.md](./DEMOS.md) §1 참조. 핵심 카피 두 줄은 고정이다:

```
Your model never leaves this browser.      (초기 드롭존)
Demo pricing formula — not a commercial quote.   (결과 카드)
```

## Architecture

```
파일 드롭 (STL/3MF)
  → loadModel()로 파싱 → 치수·파일명 표시
  → printer / filament / process 프리셋 선택 (settings API)
  → 선택된 프리셋 병합 → deriveKernelParams()
  → client.slice(stlBuffer, params, { onProgress })   ← 워커, 브라우저 안
  → result.stats → 가격 공식 → 견적 카드
```

## 최소 구현 순서

1. `loadModel()`로 파일을 읽고 모든 object의 bbox를 합쳐 치수를 표시한다.
2. printer를 고르면 해당 기종과 호환되는 process/material만 노출한다.
3. profile 종류를 바꿀 때 이전 종류의 key를 지운 뒤 새 settings를 병합한다
   ([공통 settings 계약](./DEMOS.md#6-settings와-preset-적용-계약)).
4. STL은 원본 bytes를, 3MF/OBJ 등은 `modelPos`를 binary STL로 직렬화해 worker에 전달한다.
5. `stats`를 견적 입력으로 바꾸고, 옵션이 바뀌면 이전 결과를 stale로 표시한다.

## 핵심 API 예시

```js
const input = stlBytes.slice(0) // client.slice()가 worker로 transfer한다
const result = await client.slice(input, deriveKernelParams(settings), {
  onProgress(done, total) {
    setProgress(total > 0 ? done / total : 0)
  },
})

if (result.error) throw new Error(result.error)

const { time_estimate: seconds, filament_mm: lengthMm } = result.stats
const radiusMm = Number(settingScalar(settings, 'filament_diameter') ?? 1.75) / 2
const density = Number(settingScalar(settings, 'filament_density') ?? 1.24)
const grams = lengthMm * Math.PI * radiusMm ** 2 * density / 1000
```

## 구현 노트 (실제 API와의 매핑)

- **통계 필드**: 출력 시간은 `result.stats.time_estimate`, filament는 `result.stats.filament_mm`.
- **filament는 길이(mm)이지 무게가 아니다.** g 표시는 데모 측에서 변환한다:
  `grams = filament_mm × π × (diameter/2)² × density(g/cm³) / 1000`
  diameter·density는 선택된 filament 프리셋(`filament_diameter`, `filament_density`)에서 읽는다.
- **slice 입력은 STL 바이트다.** STL 업로드는 원본 버퍼를 그대로 넘기면 되고, 3MF는 `loadModel()`이 돌려준
  지오메트리를 바이너리 STL로 직렬화하는 데모 유틸 하나가 필요하다 (position 배열 → 50byte/tri, ~30줄).
- **worker 입력은 transfer된다.** 같은 bytes로 다시 slice하거나 치수 계산에 재사용해야 하면 전달 전에
  `slice(0)`으로 복제한다.
- **cancel은 조건부다.** `client.cancel()`은 SharedArrayBuffer 기반이라 cross-origin-isolated 페이지(MT 커널)
  에서만 동작하고 아니면 `false`를 반환한다. 정적 배포(COOP/COEP 헤더 없음)에서는
  `terminate()` 후 클라이언트 재생성으로 취소를 구현한다.

## 가격 공식

실제 사업 알고리즘을 만들지 않는다.

```js
const quoteConfig = { filamentPricePerKg: 25, machineHourlyRate: 3, handlingFee: 2, marginMultiplier: 1.08 };
price = (materialCost + machineCost + handlingFee) * marginMultiplier * quantity;
```

## What is intentionally mocked

- 가격 상수 — 실제 시장가 아님을 UI에 명시.
- 결제·주문·배송 — 없음. 견적 카드에서 끝.

## 프라이버시 증명

이 데모의 핵심. UI에 "Local slicing — Your model stays on this device." 표시.
개발자 도구 Network 탭에서 slicing 동안 model upload request가 0건이어야 한다.

자동 검증에서는 업로드 이후 발생한 request의 body에 모델 bytes가 없는지 검사한다. analytics를
추가하더라도 파일명, 원본 크기, geometry hash를 보내지 않는다.

## 오류와 재시도

- profile lookup이 `null`이면 slice button을 비활성화하고 어떤 선택이 없는지 표시한다.
- `stats.time_estimate === 0` 또는 `stats.filament_mm <= 0`이면 가격을 계산하지 않고 결과를
  “견적 불가”로 표시한다.
- build volume 초과는 `stats.over_bed_model`과 초과 축을 이용해 printer 변경으로 연결한다.
- 취소 후에는 직전 성공 견적을 새 견적인 것처럼 유지하지 않는다.

## 완료 조건

- [ ] STL 업로드 / 3MF geometry 업로드
- [ ] printer · filament · process 프리셋 선택
- [ ] browser worker slicing + 실제 progress 표시 (가짜 애니메이션 금지)
- [ ] cancel (MT면 `cancel()`, 아니면 terminate+재생성)
- [ ] print time · filament 무게/길이 출력
- [ ] 가격 계산, 옵션 재설정 시 재슬라이스
- [ ] network 없이 정적 배포 후 기본 기능 실행

## E2E 시나리오

```
benchy-small.stl → Generic PLA → P1S → 0.20 mm → Slice
→ stats.time_estimate > 0 → stats.filament_mm > 0 → quote > 0
```

실패 경로도 하나 고정한다.

```text
손상된 .3mf 선택 → 사용자용 오류 표시 → Replace file → calibration-cube.stl → 정상 견적
```

## 구현 후 문서에 추가할 항목

- live URL과 screenshot
- `npm run dev`, `npm run build`, `npm test`의 실제 명령
- pricing 상수의 위치와 변경 방법
- fixture 출처·라이선스

## Production considerations

실제 견적 서비스는 인건비, 장비 감가상각, 실패율, support 제거, 배송, 세금, 최소 주문 금액을
추가로 반영해야 한다. 이 데모의 공식은 slicer 통계 → 가격의 연결만 보여준다.
