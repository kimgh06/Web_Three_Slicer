import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  // 33단계 Phase 4: cross-package 컴포넌트(packages/components/*.jsx)가 이 앱의 단일 react 사본을 쓰도록
  //  alias/dedupe (모노레포 npm hoist 없이 해결). packages/components 는 이 앱 밖이라 자체 node_modules 가
  //  없으므로 bare 'react' 를 여기로 고정.
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      react: path.resolve(here, 'node_modules/react'),
      'react-dom': path.resolve(here, 'node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(here, 'node_modules/react/jsx-runtime'),
    },
  },
  server: { fs: { allow: ['..'] } },   // web/* (packages, *.json) 접근 허용
})
