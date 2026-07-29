#!/usr/bin/env bash
# tarball 독립 검증 (S4): 4개 패키지를 npm pack → 저장소 밖 임시 디렉토리에서
# Vite/Next 소비자 앱을 스캐폴드해 tarball 만으로 빌드가 성공하는지 확인.
# (런타임 E2E 슬라이스는 별도 — 이 스크립트는 빌드 게이트만. 브라우저 불필요)
set -euo pipefail
WEB="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d /tmp/three-slicer-packcheck.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
echo "== pack -> $TMP"
mkdir -p "$TMP/tarballs"
for p in data engine components viewer; do
  npm pack "$WEB/packages/$p" --pack-destination "$TMP/tarballs" >/dev/null
done
T=("$TMP"/tarballs/*.tgz)

echo "== vite consumer"
mkdir -p "$TMP/vite/src" && cd "$TMP/vite"
cat > package.json <<'EOF'
{ "name": "packcheck-vite", "private": true, "type": "module", "scripts": { "build": "vite build" } }
EOF
cat > vite.config.js <<'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// README 의 Vite 요구 2줄: 워커 st/mt 동적 선택(es 워커) + mt 글루 top-level await(es2022)
export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
EOF
cat > index.html <<'EOF'
<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>
EOF
cat > src/main.jsx <<'EOF'
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import Viewport from '@three-slicer/viewer'
import '@three-slicer/viewer/styles.css'
import SettingsPanel from '@three-slicer/components/SettingsPanel'
function App() {
  const [settings, setSettings] = useState({})
  return (<><Viewport settings={settings} setSettings={setSettings} />
    <SettingsPanel settings={settings} setSettings={setSettings} /></>)
}
createRoot(document.getElementById('root')).render(<App />)
EOF
npm i --no-audit --no-fund react@18 react-dom@18 three@0.160.1 "${T[@]}" >/dev/null
npm i --no-audit --no-fund -D vite@5 @vitejs/plugin-react@4 >/dev/null
npm run build >/dev/null
ls dist/assets/ | grep -q "slicer.worker" || { echo "FAIL: vite 소비자 dist 에 워커 청크 없음"; exit 1; }
echo "OK: vite 빌드 + 워커 청크"

echo "== next consumer"
mkdir -p "$TMP/next/pages" && cd "$TMP/next"
cat > package.json <<'EOF'
{ "name": "packcheck-next", "private": true, "scripts": { "build": "next build" } }
EOF
cat > next.config.js <<'EOF'
/** README 의 Next 레시피: emscripten 글루의 Node 가드 경로(node:*) 를 빈 모듈로 */
module.exports = { webpack: (config) => {
  for (const m of ['node:module','node:fs','node:path','node:url','node:crypto','node:worker_threads']) config.resolve.alias[m] = false
  return config
} }
EOF
cat > pages/_app.jsx <<'EOF'
export default function App({ Component, pageProps }) { return <Component {...pageProps} /> }
EOF
cat > pages/index.jsx <<'EOF'
import dynamic from 'next/dynamic'
import React, { useState } from 'react'
import '@three-slicer/viewer/styles.css'
const Viewport = dynamic(() => import('@three-slicer/viewer'), { ssr: false })
const SettingsPanel = dynamic(() => import('@three-slicer/components/SettingsPanel'), { ssr: false })
export default function Home() {
  const [settings, setSettings] = useState({})
  return (<><Viewport settings={settings} setSettings={setSettings} />
    <SettingsPanel settings={settings} setSettings={setSettings} /></>)
}
EOF
npm i --no-audit --no-fund next@14 react@18 react-dom@18 three@0.160.1 "${T[@]}" >/dev/null
npx next build >/dev/null
echo "OK: next 빌드"
echo "ALL PACK CHECKS PASSED"
