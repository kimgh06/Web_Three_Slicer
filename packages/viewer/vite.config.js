import { defineConfig } from 'vite'

// 라이브러리 빌드 — JSX 트랜스파일만 하고 나머지는 전부 external.
// slicer.worker.js 의 new URL 패턴은 dist 에 원형 보존돼야 한다(소비자 번들러가 워커 청크로 인식).
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),   // --config 로 루트 cwd 에서 실행돼도 엔트리/outDir 기준 고정
  build: {
    lib: {
      entry: { Viewport: 'src/Viewport.jsx', toolpath_gpu: 'src/toolpath_gpu.js', model_loaders: 'src/model_loaders.js' },
      formats: ['es'],
    },
    outDir: 'dist',
    rollupOptions: {
      // make_worker.js 는 external + 원형 복사(build 스크립트) — 정적 워커 패턴을 소비자 번들러에 보존.
      external: [/^react(-dom)?($|\/)/, /^three($|\/)/, /^three-slicer($|\/)/, /make_worker\.js$/],
      output: { paths: (id) => /make_worker\.js$/.test(id) ? './make_worker.js' : id },
    },
  },
})
