import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 워크스페이스 hoist 로 react 사본이 web/node_modules 하나로 통일돼 절대경로 alias 는 불필요.
  //  dedupe 만 남겨 앱 로컬 사본이 생겨도 단일 인스턴스를 보장한다.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { fs: { allow: ['..'] } },   // web/* (packages, *.json) 접근 허용
})
