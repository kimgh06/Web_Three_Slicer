#!/usr/bin/env bash
# Standalone tarball verification: npm pack three-slicer, then scaffold consumers in a temp directory outside the repo
# to confirm the tarball alone builds and runs. This script must live inside packages/ —
# a standalone-verification tool sitting outside packages/ would not itself be standalone.
#
# Cases: (1) Node consumer (no peers) (2) type check with tsc --noEmit (3) Vite (4) Next
# (runtime E2E slicing is separate — this is a build/resolution gate only, no browser needed)
set -euo pipefail
PKG="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d /tmp/three-slicer-packcheck.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
echo "== pack -> $TMP"
mkdir -p "$TMP/tarballs"
npm pack "$PKG" --pack-destination "$TMP/tarballs" >/dev/null
T=("$TMP"/tarballs/*.tgz)

echo "== node consumer (no peers)"
# Engine/settings/toggle must run under Node without react or three. Guards against JSON import attribute regressions.
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
if (Object.keys(rawSchema).length !== Object.keys(schema).length) throw new Error('raw JSON path mismatch')
for (const [n, v] of [['uiTree', uiTree], ['toggleRules', toggleRules], ['invalidationMap', invalidationMap]])
  if (!Object.keys(v).length) throw new Error(n + ' is empty')
if (typeof createSlicer !== 'function') throw new Error('createSlicer missing')
if (!engineWorkerURL().href.endsWith('slicer.worker.js')) throw new Error('bad worker URL')
if (schemaDefault('layer_height') == null) throw new Error('schemaDefault failed')
if (!Object.keys(schema).length) throw new Error('schema is empty')
const p = deriveKernelParams({ layer_height: 0.15 })
if (p.layer_height !== 0.15) throw new Error('deriveKernelParams failed: ' + p.layer_height)
if (typeof disabledKeys(makeCfg({})) !== 'object') throw new Error('disabledKeys failed')
console.log('  node OK —', Object.keys(schema).length, 'keys loaded')
EOF
node run.mjs
# Optional peers drop out silently -> check they were installed automatically.
[ -d node_modules/three ] || { echo "FAIL: three was not auto-installed as a peer"; exit 1; }
[ -d node_modules/react ] || { echo "FAIL: react was not auto-installed as a peer"; exit 1; }
echo "OK: node consumption + peer auto-install"

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

// Do the generated key types actually narrow
const s: SlicerSettings = { layer_height: 0.2, sparse_infill_pattern: 'gyroid', spiral_mode: false }
// @ts-expect-error — an unknown enum value must be rejected
const bad: SlicerSettings = { sparse_infill_pattern: 'not-a-pattern' }
// @ts-expect-error — a type mismatch must be rejected
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
echo "OK: types (strict, including 2 @ts-expect-error cases)"

echo "== vite consumer"
mkdir -p "$TMP/vite/src" && cd "$TMP/vite"
cat > package.json <<'EOF'
{ "name": "packcheck-vite", "private": true, "type": "module", "scripts": { "build": "vite build" } }
EOF
cat > vite.config.js <<'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// The 2 Vite requirements from the README: dynamic st/mt worker selection (es worker) + top-level await in the mt glue (es2022)
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
ls dist/assets/ | grep -q "slicer.worker" || { echo "FAIL: no worker chunk in the vite consumer's dist"; exit 1; }
echo "OK: vite build + worker chunk"

echo "== next consumer"
mkdir -p "$TMP/next/pages" && cd "$TMP/next"
cat > package.json <<'EOF'
{ "name": "packcheck-next", "private": true, "scripts": { "build": "next build" } }
EOF
cat > next.config.js <<'EOF'
/** The Next recipe from the README: map the emscripten glue's Node guard paths (node:*) to an empty module */
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
echo "OK: next build"
echo "ALL PACK CHECKS PASSED"
