# AGENTS.md

Web_Three_Slicer — OrcaSlicer를 리버스 엔지니어링한 브라우저/WASM 슬라이서. 루트는 세 폴더:

- **`slicer/`** — 업스트림 OrcaSlicer 원본 (무수정, 참조·추출 소스 전용). 자체 가이드는 `slicer/AGENTS.md`.
- **`packages/`** — 배포 npm 패키지 4종 + 커널 소스. `slicer/`에 빌드·런타임 의존 0.
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

# 타르볼 독립 검증 (npm pack → Vite/Next 소비자 빌드)
bash web/pack_check.sh
```

## 구조

- `packages/engine/` — `@three-slicer/engine`: WASM 커널 SDK (배치/스트리밍 슬라이스, 워커, 설정 매핑)
- `packages/data/` — `@three-slicer/data`: 추출 JSON 4종 (config-schema, ui-tree, toggle-rules, invalidation-map)
- `packages/components/` — `@three-slicer/components`: React `<SettingsPanel/>` (전역 결합 0, Shadow DOM)
- `packages/viewer/` — `@three-slicer/viewer`: `<Viewport/>` 뷰어 컴포넌트 (three.js, Shadow DOM)
- `packages/wasm-core/` — 커널 C++ 소스 + `third_party/` (deps 사본, 독립 빌드용) — npm 미배포, 산출물은 `packages/engine/src/`
- `web/viewer/` — 데모 앱 (Vite + React) — 워크스페이스 멤버, 패키지를 이름으로 참조
