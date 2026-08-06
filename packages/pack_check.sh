#!/usr/bin/env bash
# tarball 독립 검증: three-slicer 를 npm pack → 저장소 밖 임시 디렉토리에서 소비자를 스캐폴드해
# tarball 만으로 빌드/실행이 되는지 확인. 이 스크립트는 packages/ 안에 있어야 한다 —
# 독립 검증 도구가 packages/ 밖에 있으면 그 자체로 독립이 아니다.
#
# 케이스: (1) Node 소비자(peer 0) (2) 타입 tsc --noEmit (3) Vite (4) Next
# (런타임 E2E 슬라이스는 별도 — 여기는 빌드/해석 게이트만. 브라우저 불필요)
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d /tmp/three-slicer-packcheck.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
echo "== pack -> $TMP"
mkdir -p "$TMP/tarballs"
npm pack "$PKG" --pack-destination "$TMP/tarballs" >/dev/null
T=("$TMP"/tarballs/*.tgz)

echo "== node consumer (peer 없음)"
# 엔진/설정/토글은 react·three 없이 Node 에서 돌아야 한다. JSON import attribute 회귀 방지.
mkdir -p "$TMP/node" && cd "$TMP/node"
cat > package.json <<'EOF'
{ "name": "packcheck-node", "private": true, "type": "module" }
EOF
npm i --no-audit --no-fund "${T[@]}" >/dev/null
cat > run.mjs <<'EOF'
import { createSlicer, engineWorkerURL } from 'three-slicer'
import { deriveKernelParams, schemaDefault } from 'three-slicer/settings'
import { makeCfg, disabledKeys } from 'three-slicer/toggle'
import { schema, uiTree, toggleRules, invalidationMap } from 'three-slicer/data'
import rawSchema from 'three-slicer/data/config-schema.json' with { type: 'json' }
if (Object.keys(rawSchema).length !== Object.keys(schema).length) throw new Error('raw JSON 경로 불일치')
for (const [n, v] of [['uiTree', uiTree], ['toggleRules', toggleRules], ['invalidationMap', invalidationMap]])
  if (!Object.keys(v).length) throw new Error(n + ' 비어있음')
if (typeof createSlicer !== 'function') throw new Error('createSlicer 없음')
if (!engineWorkerURL().href.endsWith('slicer.worker.js')) throw new Error('워커 URL 이상')
if (schemaDefault('layer_height') == null) throw new Error('schemaDefault 실패')
if (!Object.keys(schema).length) throw new Error('schema 비어있음')
const p = deriveKernelParams({ layer_height: 0.15 })
if (p.layer_height !== 0.15) throw new Error('deriveKernelParams 실패: ' + p.layer_height)
if (typeof disabledKeys(makeCfg({})) !== 'object') throw new Error('disabledKeys 실패')
console.log('  node OK —', Object.keys(schema).length, '키 로드')
EOF
node run.mjs
# peer 가 optional 이면 조용히 빠진다 → 자동설치됐는지 확인.
[ -d node_modules/three ] || { echo "FAIL: three 가 peer 자동설치되지 않음"; exit 1; }
[ -d node_modules/react ] || { echo "FAIL: react 가 peer 자동설치되지 않음"; exit 1; }
echo "OK: node 소비 + peer 자동설치"

echo "== types (tsc --noEmit)"
mkdir -p "$TMP/ts/src" && cd "$TMP/ts"
cat > package.json <<'EOF'
{ "name": "packcheck-ts", "private": true, "type": "module" }
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "es2022", "module": "esnext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "strict": true, "noEmit": true,
    "resolveJsonModule": false, "skipLibCheck": false
  },
  "include": ["src"]
}
EOF
cat > src/check.ts <<'EOF'
import { createSlicer, type SlicerSettings } from 'three-slicer'
import { deriveKernelParams, settingScalar } from 'three-slicer/settings'
import { makeCfg, disabledKeys } from 'three-slicer/toggle'
import { buildSegmentData, computeColors, VIEW_TYPES } from 'three-slicer/viewer/toolpath'
import { loadModel, SUPPORTED_EXT, splitConnectedComponents } from 'three-slicer/viewer/loaders'
import { schema, uiTree } from 'three-slicer/data'
import rawSchema from 'three-slicer/data/config-schema.json'

// 생성된 키 타입이 실제로 좁혀지는가
const s: SlicerSettings = { layer_height: 0.2, sparse_infill_pattern: 'gyroid', spiral_mode: false }
// @ts-expect-error — 없는 enum 값은 거부돼야 한다
const bad: SlicerSettings = { sparse_infill_pattern: 'not-a-pattern' }
// @ts-expect-error — 타입 불일치는 거부돼야 한다
const bad2: SlicerSettings = { layer_height: 'thick' }

export async function main(buf: ArrayBuffer) {
  const slicer = await createSlicer()
  const r = slicer.slice(buf, deriveKernelParams(s))
  const n: number = r.stats.layers
  settingScalar(s, 'layer_height')
  const dis: Record<string, string> = disabledKeys(makeCfg(s))
  const objs = await loadModel('a.stl', buf)
  const name: string = objs[0].name
  splitConnectedComponents(objs[0].modelPos)?.length
  const data = buildSegmentData([], 0.42)
  const c = computeColors(data, VIEW_TYPES[0].key, { firstLayerSpeed: 20 })
  const pages = uiTree[Object.keys(uiTree)[0]][0].groups[0].options.length
  return { n, dis, name, ext: SUPPORTED_EXT[0], cont: c.cont, pages, keys: Object.keys(schema).length, raw: Object.keys(rawSchema).length }
}
EOF
npm i --no-audit --no-fund "${T[@]}" >/dev/null
npm i --no-audit --no-fund -D typescript@5 @types/react@18 >/dev/null
npx tsc --noEmit -p tsconfig.json
echo "OK: 타입 (strict, @ts-expect-error 2건 포함)"

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
import Viewport from 'three-slicer/viewer'
import SettingsPanel from 'three-slicer/components'
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
const Viewport = dynamic(() => import('three-slicer/viewer'), { ssr: false })
const SettingsPanel = dynamic(() => import('three-slicer/components'), { ssr: false })
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
