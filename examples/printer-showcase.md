# printer-showcase — 제조사 제품 페이지용 Embedded Slicer

> 공통 규칙은 [DEMOS.md](./DEMOS.md)를 따른다. 이 문서는 이 데모 고유의 것만 서술한다.

> **현재 상태:** 구현됨 — [`printer-showcase/`](./printer-showcase/) (`npm i && npm run dev`).
> 실행 방법·측정치·격리 검증 결과는 앱의 [README](./printer-showcase/README.md)에 있다.
> 실측: A1 mini(180 베드) 15m vs P1S(256 베드) 12m — 같은 20mm 큐브, 프로파일 모션 리밋 차이.
> **미충족 1건**: sample model 자동 load. `<Viewport/>`에 호스트가 모델 바이트를 넣는 prop이 없어
> public API만으로는 불가능하다(0.1.7과 로컬 소스 모두). 테스트 큐브 다운로드 + 뷰어 자체
> 드롭/파일 선택으로 대체했고, 우회는 하지 않았다.
> 남은 것: 배포 URL, 대표 GIF, 모델 입력 prop.

## What this demonstrates

3D 프린터 제조사가 제품 상세 페이지에 넣을 수 있는 **"이 프린터에서 실제로 어떻게 출력되는지 체험하는 embeddable slicer"**.

파는 것은 slicer 자체가 아니라 **기존 웹페이지에 slicer experience를 embed할 수 있다**는 사실이다. 따라서 전체화면 slicer처럼 만들지 않는다 — 가상의 제조사 랜딩 페이지(마케팅 카피, Buy now 버튼) 안의 한 섹션으로 존재한다.

## 타깃

3D 프린터 OEM · 리셀러 · 제품 비교 사이트 · 프린터 랜딩 페이지.

## Package APIs used

```
three-slicer/viewer      <Viewport settings setSettings panels features defaultExtruderColors/>
three-slicer/settings    printersByVendor / printerSettings(name) — 기종 목록과 프로파일 스왑
three-slicer/components  <SettingsPanel embedded/> — 노출 옵션은 소수로 제한
```

직접 `three-slicer/client`를 호출하지 않는다. Viewport가 worker와 slice lifecycle을 소유하고,
호스트는 `onEvent`와 `onSliced`로 상태·통계를 받는다.

## 설치

이 데모는 저장소와 다른 사이트에 배포하는 독립 프로젝트다 ([DEMOS.md §2](./DEMOS.md#2-독립-프로젝트와-설치)).

```bash
npm i three-slicer three react react-dom
```

세 peer 모두 필요하다 — Viewport와 SettingsPanel이 React 컴포넌트이고 three로 렌더한다.
실제 제조사 페이지가 React가 아닐 수 있으므로, 임베드 지점을 한 파일(`slicer_section.jsx`)로
격리해 "이 파일만 마운트하면 된다"는 형태로 만든다.

## 화면

가상 제조사 "ACME" 랜딩 페이지. 와이어프레임은 [DEMOS.md](./DEMOS.md) §2 참조.

- 히어로: 제품명 + 마케팅 카피 + [Buy now] (동작 안 함, mock)
- "Try it with your model" 섹션: Viewport 임베드 + layer height/infill 두 개만 노출
- 슬라이스 후 같은 viewport가 toolpath 모드로 전환, print time · filament · layer slider 표시

## 기종 전환

상단에 실제 catalog의 3기종만 둔다: `[A1 mini] [P1S] [X1 Carbon]` (모두 0.4mm nozzle).
선택 시 `printerSettings()`로 얻은 실제 프로파일로
`settings`를 갈아끼운다 — build volume, nozzle, machine limits, build plate가 함께 바뀐다.
임의 값 금지: `three-slicer/settings`가 공개하는 실제 vendor 프로파일 데이터만 사용한다.

정확한 profile key는 각각 `Bambu Lab A1 mini 0.4 nozzle`, `Bambu Lab P1S 0.4 nozzle`,
`Bambu Lab X1 Carbon 0.4 nozzle`이다. UI label과 lookup key를 분리한다.

## 구현 노트

- **호스트가 `settings`/`setSettings`를 소유**하고 기종 버튼이 그 state를 바꾼다 — Viewport의
  호스트-프롭 경계가 그대로 임베드 패턴 예제가 된다.
- **`panels`로 옵트아웃**: 프린터 카드는 `'readonly'`로 두고 필요 없는 카드·도구는 `false`로 숨긴다.
  SettingsPanel은 임의 key 목록 필터가 없으므로 layer height/infill 두 control은 host UI로 직접 만든다.
  (기종은 위의 버튼으로만 바꾸게 하되, readonly는 host의 settings 쓰기를 막지 않는다.)
- **`features`로 옵트아웃**: 페이지 키보드 점유 등 호스트 페이지와 충돌할 동작을 끈다.
- 방문자 STL 업로드와 기본 sample model 자동 로드 둘 다 지원.
- 현재 `<Viewport/>`에는 host가 model bytes를 주입하는 prop이 없다. “sample 자동 load”를 만족하려면
  public imperative/model prop을 먼저 추가하거나, 첫 화면에 명시적인 **Load sample** 사용자 동작을 둔다.
  private scene 접근이나 synthetic drop event로 우회하지 않는다.

## 최소 embed 예시

```jsx
<div className="slicer-frame">
  <Viewport
    settings={settings}
    setSettings={setSettings}
    defaultAutoSlice
    panels={{ printerCard: 'readonly', processCard: false, towerCard: false }}
    features={{ shortcuts: false, logs: false }}
    onEvent={event => event.type === 'progress' && setProgress(event.value)}
    onSliced={({ stats }) => setStats(stats)}
  />
</div>
```

`.slicer-frame`에는 `position: relative`와 실제 height가 반드시 있어야 한다. Viewport는 가장 가까운
positioned ancestor를 채우며 자체 width/height prop은 없다.

## Embed 검증 (이 데모의 핵심 완료조건)

host page에 의도적으로 충돌 가능성이 높은 전역 CSS를 둔다:

```css
button { border-radius: 0; }
canvas { max-width: 300px; }
input  { font-size: 24px; }
```

Viewport와 SettingsPanel은 Shadow DOM 격리이므로 영향을 받지 않아야 한다 — 실제로 렌더된
화면으로 isolation을 검증한다.

## What is intentionally mocked

- 제조사 브랜딩(가상의 "ACME"), Buy now, 로그인, cloud, telemetry, firmware, 실기기 연결 — 전부 없음.

## 완료 조건

- [ ] product page 안에 embed (전체화면 아님)
- [ ] 3종 printer 전환 + build plate 변경 확인
- [ ] sample model 자동 load / visitor STL upload
- [ ] 최소 settings만 노출 (`panels` 옵트아웃)
- [ ] browser slicing, model ↔ toolpath 화면 전환
- [ ] layer slider, print time · filament 표시
- [ ] host CSS isolation 확인 (위의 충돌 CSS 하에서)
- [ ] 모바일 width(360px)에서 layout 유지

## E2E 시나리오

```
페이지 로드 → sample model 표시 → [X1 Carbon] 클릭 → build plate 크기 변경 확인
→ Slice → toolpath 표시 → layer slider 동작 → print time > 0
```

추가 embed 시나리오:

```text
host CSS 충돌 규칙 적용 → 360px viewport → keyboard tab으로 Load model과 Slice 실행
→ viewer canvas가 300px로 축소되지 않고 내부 button 모양도 유지
```

## 구현 후 문서에 추가할 항목

- live URL, desktop/mobile screenshot
- 실제 실행·build·E2E 명령
- 노출하는 host control과 대응 settings key
- CSP와 COOP/COEP 배포 헤더

## Production considerations

실서비스 임베드는 CSP/iframe 정책, 번들 크기 예산, WASM 로딩 지연 처리(위 `features`로 지연
로드 제어), 접근성(키보드 포커스가 호스트 페이지와 공존)을 추가로 다뤄야 한다. README/landing의
대표 GIF는 이 데모로 만든다 (DEMOS.md §8 Phase 1).
