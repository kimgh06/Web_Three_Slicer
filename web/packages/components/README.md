# @three-slicer/components

Reusable React components for the browser slicer. **Props-driven, zero global/context coupling** — each
component takes plain props and can render in any React tree (proven by `apps/independence-check`).

## `<SettingsPanel/>`

Config-schema-driven settings form (907 options, tabs/pages/modes, search, dirty-dot + reset, disable
rules). Depends only on React + `@three-slicer/data` (schema/ui-tree/toggle-rules) + `@three-slicer/engine`
(settingRaw/disabledKeys/makeCfg). No router, no global store.

```jsx
import { useState } from 'react'
import SettingsPanel from '@three-slicer/components/SettingsPanel'

function MyTool() {
  const [settings, setSettings] = useState({})   // sparse map {optKey: value}; missing = schema default
  return (
    <SettingsPanel
      settings={settings}
      setSettings={setSettings}
      onOptionOpen={key => {/* optional: open detail/deep-link. Omit → plain labels (no router needed). */}}
    />
  )
}
```

Props:
- `settings` — sparse `{optKey: value}` map (edited keys only).
- `setSettings` — `(updater) => void` (React setState style); the only channel state leaves the component.
- `onOptionOpen?` — `(optKey) => void`; label click. Omit for zero router dependency.

Standalone proof: `apps/independence-check` renders `<SettingsPanel/>` with just `useState` (no App, no
context, no router) and edits flow to local state — build + run with `cd apps/independence-check && npm i && npm run dev`.

## `<SlicerViewport/>` (status)

The 3D viewport + slice/preview orchestration currently lives as a single props-driven component
`viewer/Viewport.jsx` (`<Viewport settings setSettings processPanel/>`), consuming `@three-slicer/engine`
(worker + `deriveKernelParams`). It is already prop-driven at the top level, but has **not** yet been
relocated into this package or split into its internal `PreviewPanel` / `ObjectList` / `FilamentBar`
sub-components — that decomposition touches a large three.js/worker/assets module and requires a full
demo regression pass (load / slice / preview / plates / paint / OOM / gizmo), deferred to a focused
follow-up. `apps/demo` (the viewer) consumes `<SettingsPanel/>` from here today.
