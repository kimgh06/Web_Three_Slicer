# AGENTS.md

Web_Three_Slicer — OrcaSlicer를 리버스 엔지니어링한 브라우저/WASM 슬라이서. 루트는 두 폴더뿐:

- **`slicer/`** — 업스트림 OrcaSlicer 원본 (무수정, 참조·추출 소스 전용). 자체 가이드는 `slicer/AGENTS.md`.
- **`web/`** — 브라우저 슬라이싱 커널 + SDK + 뷰어. `slicer/`에 빌드·런타임 의존 0. 상세: `web/README.md`, `web/GUIDE.md`, `web/SPECS.md`.

## 핵심 규칙

- **`slicer/`는 수정하지 않는다.** 모든 개발은 `web/`에서.
- `web/`는 `slicer/` 없이도 실행·빌드·배포가 되어야 한다 (34단계에서 실증됨). 이 독립성을 깨는 변경 금지.
- 커널(`wasm-core/`) 변경 시 golden byte-identical 검증(`golden.mjs`)과 `test.mjs` 불변식 스위트를 통과해야 한다.
- 라이선스 AGPL-3.0-or-later (`LICENSE.txt`).

## 명령어

```bash
# 뷰어 (커밋된 WASM 사용 — emscripten 불필요)
cd web/viewer && npm i && npm run dev

# 커널 테스트 (120+ 불변식)
node web/wasm-core/test.mjs

# 커널 재빌드 (emscripten + brew boost/eigen 필요)
bash web/wasm-core/build.sh

# 추출 JSON 재생성 (slicer/ 소스 → web/packages/data/)
python3 web/extract_all.py
```

## 구조 (web/ npm workspaces)

- `packages/engine/` — `@orca-re/engine`: WASM 커널 SDK (배치/스트리밍 슬라이스, 워커, 설정 매핑)
- `packages/data/` — `@orca-re/data`: 추출 JSON 4종 (config-schema, ui-tree, toggle-rules, invalidation-map)
- `packages/components/` — `@orca-re/components`: React `<SettingsPanel/>` (전역 결합 0)
- `viewer/` — 데모 앱 (Vite + React + three.js)
- `wasm-core/` — 커널 C++ 소스 + `third_party/` (deps 사본, 독립 빌드용)
- `apps/independence-check/` — 컴포넌트 독립성 증명 앱
