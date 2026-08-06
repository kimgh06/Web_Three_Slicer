# AGENTS.md

Web_Three_Slicer — OrcaSlicer를 리버스 엔지니어링한 브라우저/WASM 슬라이서. 루트는 세 폴더:

- **`slicer/`** — 업스트림 OrcaSlicer 원본 (무수정, 참조·추출 소스 전용). 자체 가이드는 `slicer/AGENTS.md`.
- **`packages/`** — 배포 npm 패키지 `three-slicer` (단일) + 커널 소스. `slicer/`에 빌드·런타임 의존 0.
- **`web/`** — 데모 앱 껍데기. 패키지를 워크스페이스로 소비 (상대경로 import 없음). 상세: `web/README.md`, `web/GUIDE.md`, `web/SPECS.md`.

루트 `package.json` 이 npm workspaces 루트 (`packages/*` + `web/viewer`) — 설치는 루트 `npm i` 1회.

## 핵심 규칙

- **`slicer/`는 수정하지 않는다.** 모든 개발은 `packages/`·`web/`에서.
- `packages/`·`web/`는 `slicer/` 없이도 실행·빌드·배포가 되어야 한다 (34단계에서 실증됨). 이 독립성을 깨는 변경 금지.
- 커널(`packages/wasm-core/`) 변경 시 golden byte-identical 검증(`golden.mjs`)과 `test.mjs` 불변식 스위트를 통과해야 한다.
- UI 컴포넌트(viewer·components)는 Shadow DOM 격리 — 스타일은 각 패키지의 `styles.css`가 `?inline` 으로 번들에 내장돼 shadow root 에 주입된다. 호스트 앱 CSS 와 클래스명이 충돌하지 않는다.
- 라이선스 AGPL-3.0-or-later (`LICENSE.txt`).

## 명령어

```bash
# 설치 (루트 1회) + 패키지 빌드 (components/viewer dist)
npm i && npm run build

# 뷰어 데모 앱 (커밋된 WASM 사용 — emscripten 불필요)
cd web/viewer && npm run dev

# 커널 테스트 (120+ 불변식)
node packages/wasm-core/test.mjs

# 커널 재빌드 (emscripten + brew boost/eigen 필요)
bash packages/wasm-core/build.sh

# 추출 JSON 재생성 (slicer/ 소스 → packages/data/)
python3 web/extract_all.py

# 설정 키 타입 재생성 (config-schema.json → types/settings-keys.d.ts, 907키). build 가 자동 실행
node packages/types/gen_settings_types.mjs

# 타르볼 독립 검증 (Node/타입/Vite/Next 4종 소비자) — packages/ 안에 있어야 한다
bash packages/pack_check.sh
```

## 구조

`packages/` 전체가 **단일 npm 패키지 `three-slicer`** (subpath exports로 분리 소비):
- `packages/engine/` — 진입점 `three-slicer` (+`/settings` `/toggle` `/worker` `/wasm`): WASM 커널 SDK
- `packages/data/` — 추출 JSON 4종 (config-schema, ui-tree, toggle-rules, invalidation-map).
  소비는 `three-slicer/data` (named export, import attribute 포함) 권장 — 원시 `three-slicer/data/*.json` 도 열려 있다.
  **JSON 을 새로 import 할 때는 반드시 `engine/src/data.js` 에 추가할 것**: Vite/esbuild 가 번들 출력에서
  `with { type: 'json' }` 을 떼어내므로, import 지점이 둘 이상이면 소비자 번들러가 attribute 불일치로 경고한다.
- `packages/components/` — `three-slicer/components`: React `<SettingsPanel/>` (전역 결합 0, Shadow DOM)
- `packages/viewer/` — `three-slicer/viewer`: `<Viewport/>` 뷰어 컴포넌트 (three.js, Shadow DOM)
- `packages/types/` — `.d.ts` 전량. 손으로 쓰되 `settings-keys.d.ts`(907키)만 `gen_settings_types.mjs` 가 생성
- `packages/wasm-core/` — 커널 C++ 소스 + `third_party/` (deps 사본, 독립 빌드용) — npm 미배포, 산출물은 `packages/engine/src/`
- `web/viewer/` — 데모 앱 (Vite + React) — 워크스페이스 멤버, 패키지를 이름으로 참조
