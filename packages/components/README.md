# three-slicer/components

Reusable React components for the browser slicer. Props-driven — no global state, no React context, no router coupling (proven standalone by the tarball consumer gate `packages/pack_check.sh`).

## `<SettingsPanel/>`

An OrcaSlicer-style settings form generated from `three-slicer/data` (schema + UI tree + toggle rules): tab/page/group navigation, mode filter (simple/advanced/expert), search across 923 options, dirty markers with per-option reset, and enable/disable rules evaluation.

The tab set follows the printer profile's technology: a settings map whose `printer_technology` says SLA swaps the FFF tabs for the SLA ones (print/material/printer builders carry the technology in their upstream builder name, which is what the filter reads). No prop needed — change the profile in the shared settings map and the panel follows.

```bash
npm i three-slicer     # react is a peer dependency — npm installs it for you
```

```jsx
import { useState } from 'react'
import SettingsPanel from 'three-slicer/components'

function App() {
  const [settings, setSettings] = useState({})   // sparse map: edited keys only; missing = schema default
  return <SettingsPanel settings={settings} setSettings={setSettings} />
}
```

Props:

| Prop | Type | Description |
|---|---|---|
| `settings` | `{ [schemaKey]: value }` | Sparse settings map — the consumer's state is the single source of truth |
| `setSettings` | `(updater) => void` | React setState-style updater; the only way state leaves the component |
| `onOptionOpen` | `(key) => void` (optional) | Label click hook for deep links/detail views. Omit → plain labels |

The same `settings` object feeds `deriveKernelParams()` in `three-slicer` and the `<Viewport/>` in `three-slicer/viewer` — one state connects all three.

Ships transpiled ESM (`dist/`); react is a peer dependency. Styling is class-based and unstyled by default (bring your own CSS, or reuse the demo's).

The 3D viewport lives in its own package: `three-slicer/viewer`.

## License

AGPL-3.0-or-later (derived from OrcaSlicer).
