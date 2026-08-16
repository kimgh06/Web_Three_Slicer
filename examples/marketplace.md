# marketplace — 3MF-native Model Marketplace

> 공통 규칙은 [DEMOS.md](./DEMOS.md)를 따른다. 이 문서는 이 데모 고유의 것만 서술한다.

> **현재 상태:** 구현 전 명세. 아래 두 public API blocker가 해결되기 전에는 시작하지 않는다.

## What this demonstrates

단순 mesh가 아니라 **작성자의 printer project 전체**(플레이트 배치·세팅·멀티머티리얼 페인팅)를
게시하고, 방문자가 **자기 printer 기준으로 다시 소비**할 수 있는 marketplace model detail page.

레퍼런스는 MakerWorld의 Print Profile — geometry + print settings + orientation + arrangement +
coloring을 하나의 3MF로 보존하는 구조. three-slicer는 이를 일반적인 3MF project 소비 시나리오로
보여준다. **"3MF는 메시가 아니라 프로젝트다"**가 이 데모의 문장이다.

## 선행 작업 (구현 전 필수)

1. `parse3MFProject` / `write3MFProject`는 현재 **public export가 아니다** — viewer 내부
(`packages/viewer/src/parse_3mf.js`, `packages/viewer/src/write_3mf.js`)에만 있다. DEMOS.md의 public
export 규칙
("private API가 필요하면 데모에서 우회하지 말고 package API를 먼저 개선한다")에 따라
**subpath export 추가(예: `three-slicer/viewer/project`) + 타입 정의가 이 데모의 첫 작업이다.**
상대경로 import로 우회하는 순간 데모의 존재 이유가 사라진다.

2. `<Viewport/>`는 host가 model/project를 주입하는 prop이나 imperative handle을 제공하지 않는다.
정적 fixture를 페이지 첫 화면에 복원하려면 package에 programmatic project-load surface를 추가하거나,
`viewer/loaders`와 `viewer/toolpath` 위에 이 데모 전용 scene을 구성해야 한다. synthetic drop event나
private scene 접근은 금지한다. 선택한 방향을 package 문서와 타입에도 반영한다.

## 타깃

3D model marketplace · creator platform · 교육자료 공유 · 사내 printable asset 저장소.

## Package APIs used

```
three-slicer/viewer/project (신설) parse3MFProject(buffer, baseName) /
                                   write3MFProject(objects, settings, options)
three-slicer/settings              normalizeProjectSettings / serializeProjectSettings —
                                   문자열 세팅 강제 변환 (공개 API에 이미 있음)
three-slicer/viewer                <Viewport/> — multi-plate·painting 표시, onExport로 저장 가로채기
three-slicer/settings              printerSettings(visitor) — 방문자 기종 프로파일
three-slicer/client                방문자 프로파일로 재슬라이스
```

## 설치

이 데모는 저장소와 다른 사이트에 배포하는 독립 프로젝트다 ([DEMOS.md §2](./DEMOS.md#2-독립-프로젝트와-설치)).

```bash
npm i three-slicer three react react-dom
```

**단, `three-slicer/viewer/project`가 아직 배포된 패키지에 없다.** 현재 npm의 최신은 `0.1.7`이고
project codec은 그 안에 export되어 있지 않으므로, 이 데모는 위의 선행 작업이 반영된 버전이
publish된 뒤에야 `npm i`만으로 성립한다. 그 전에 착수하려면 `npm pack`으로 만든 tarball을
설치해 개발하고(`npm i ../../packages/three-slicer-<next>.tgz`), 배포는 publish 이후로 미룬다.
로컬 소스를 상대경로로 import하는 우회는 하지 않는다 — 그러면 이 데모가 검증하는 대상이
사라진다.

## Fixture

이 데모용 3MF는 반드시 포함한다: **2 plates · 3+ objects · 2+ filament assignments · painted
region · printer profile · process settings · object transforms.**
단순 STL의 확장자만 바꾼 파일 금지. 현재 `fixtures/`가 없으므로 제작이 필요하다 — 이 뷰어
자체로 만들어 저장하면 된다 (페인팅 포함 저장은 이미 동작).

## 화면

모델 상세 페이지 하나가 전부: 프로젝트 뷰(플레이트 전환) + Objects/Filaments/Print profile
사이드 정보 + Estimated. 와이어프레임은 [DEMOS.md](./DEMOS.md) §5 참조.

### 작성자 project mode (초기 상태)

페이지를 열면 작성자의 project를 그대로 복원하고, 보존 여부를 체크리스트로 보인다:

```
Project data restored
✓ 2 plates  ✓ 3 objects  ✓ 2 filaments  ✓ painted regions  ✓ process settings
```

### 방문자 printer 변경 → 호환성 검사

`[Bambu Lab P1S ▼]` → `[Prusa MK4 ▼]` 변경 시 `printerSettings(방문자 기종)`의
`printable_area`/`printable_height` 대 프로젝트 객체 bbox로 검사:

```
⚠ Plate 2 exceeds MK4 build volume.   (초과 객체와 치수 명시)
Compatible → [Reslice for MK4]
```

### 재슬라이스 · 다운로드

Original(작성자 프로파일) vs Your printer(방문자 프로파일) 통계를 나란히 표시.
다운로드는 두 가지: `[Download G-code]`, `[Save modified 3MF]` — 후자는 `write3MFProject()`를
실제로 사용해야 한다 (Viewport `onExport`로 가로채 저장 흐름에 연결).

## 구현 노트

- **project_settings의 모든 값은 문자열이다** — bool `"0"`이 truthy가 되는 함정 포함. 반드시
  `normalizeProjectSettings`를 통과시킨다 (raw 사용 금지). 쓰기는 `serializeProjectSettings`가 역변환.
- **플레이트 배치는 upstream 그리드 규칙으로 디코드된다** (200mm 베드에서만 이 뷰어의 규칙과
  우연히 일치). 배치 로직은 패키지가 처리하므로 데모는 손대지 않는다 — 손대고 있다면 뭔가 잘못된 것.
- **material paint와 support paint가 같은 facet에 겹치면 material이 이기고 support는 드롭 보고** —
  복원 체크리스트에 드롭 여부도 표시한다.
- `parse3MFProject()`의 현재 내부 반환 shape는 `{objects, project}`다. `project.settings`는 아직 raw
  string 값이므로 normalize 뒤에만 `deriveKernelParams()`로 보낸다.
- `write3MFProject()`는 async다. 저장 중 UI를 busy로 만들되 main thread progress를 꾸며내지 않는다.
- 여러 plate의 paint는 selector가 전체 project를 대표하지 못하므로 package의 기존 보존 규칙을 따른다.
  데모에서 facet index를 직접 재배치하지 않는다.

## 핵심 검증 (round-trip)

```js
const a = await parse3MFProject(input, 'fixture')
const settings = normalizeProjectSettings(a.project.settings).settings
const saved = await write3MFProject(a.objects, settings, {
  bedWidth,
  bedDepth,
  plateCount: a.project.plates?.length || 1,
})
const b = await parse3MFProject(saved, 'roundtrip')
expect(projectSemantics(b)).toEqual(projectSemantics(a))
```

byte equality가 아니라 **의미 데이터의 보존**: plate · object transform · process setting ·
filament assignment · painting · printer metadata.

## What is intentionally mocked

- 마켓 CRUD (검색·리뷰·결제·업로드 관리) — 상세 페이지 하나가 데모의 전부.
- 작성자 계정 — fixture 프로젝트 하나를 정적으로 서빙.

## 완료 조건

- [ ] `three-slicer/viewer/project` export + 타입 (선행 작업)
- [ ] 실제 project 3MF load — multi-plate · multi-object · filament/color · painting 표시
- [ ] original settings 복원 + 복원 체크리스트
- [ ] visitor printer 변경 → build-volume compatibility 검사
- [ ] browser reslicing → original vs visitor 통계
- [ ] G-code download + modified 3MF write
- [ ] parse → write → parse round-trip test

## E2E 시나리오

```
fixture 3MF 로드 → 복원 체크리스트 전항목 ✓ → MK4로 변경 → 호환성 경고 또는 Compatible
→ Reslice → 두 통계 표시 → Save modified 3MF → 재파싱 시 의미 데이터 동일
```

실패 경로:

```text
material/support paint가 겹친 fixture 로드 → material 유지 + dropped support 경고
→ 저장 후 재파싱 → 경고와 보존 결과가 동일
```

## 구현 후 문서에 추가할 항목

- 선택한 programmatic project-load 방식과 public API 링크
- live URL, fixture provenance, screenshot
- 실행·build·round-trip test 명령
- 의미 비교 함수가 포함·제외하는 field 목록

## Production considerations

실서비스는 프로젝트 버저닝, 썸네일 생성(뷰어 스크린샷), 프로파일 신뢰성 표시(작성자가 실제
출력했는가), 라이선스 표기, 대용량 3MF의 점진 로딩이 추가로 필요하다.
