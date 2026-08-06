import { defineConfig } from 'vite'

// 라이브러리 빌드: 생 JSX 배포 불가(소비자 번들러가 node_modules 의 JSX 를 변환하지 않음) → ESM 으로 트랜스파일.
// react/@three-slicer/* 는 전부 external — dist 는 이 컴포넌트 코드만 담는다.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),   // --config 로 루트 cwd 에서 실행돼도 엔트리/outDir 기준 고정
  build: {
    lib: { entry: { SettingsPanel: 'SettingsPanel.jsx' }, formats: ['es'] },
    outDir: 'dist',
    rollupOptions: { external: [/^react(-dom)?($|\/)/, /^three-slicer($|\/)/] },
  },
})
