import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 워크스페이스 hoist 로 react 사본이 web/node_modules 하나로 통일돼 절대경로 alias 는 불필요.
  //  dedupe 만 남겨 앱 로컬 사본이 생겨도 단일 인스턴스를 보장한다.
  resolve: { dedupe: ['react', 'react-dom', 'three'] },
  worker: { format: 'es' },   // 워커의 st/mt 동적 선택(코드 스플릿) + mt 글루 top-level await 에 필요
  build: { target: 'es2022' },   // mt 글루(emscripten pthread)의 top-level await — Chrome 89+/Safari 15+

  // COOP/COEP → crossOriginIsolated → 워커가 mt 커널(-pthread, 2.2×) 자동 선택. 없어도 st 로 동작.
  server: {
    // fs.allow 불필요 — 루트 package.json 의 workspaces 를 Vite 가 감지해 저장소 전체를 기본 허용
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  preview: {
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
})
