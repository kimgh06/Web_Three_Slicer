// Standalone build for the independence check. 워크스페이스 hoist 로 react 는 단일 사본 —
// 절대경로 alias 불필요, dedupe 만 유지.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: 'dist' },
})
