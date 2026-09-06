# printer-showcase — an embedded slicer for a manufacturer product page

> The shared rules are in [DEMOS.md](./DEMOS.md). This document covers only what is specific to this demo.

> **Current status:** implemented — [`printer-showcase/`](./printer-showcase/) (`npm i && npm run dev`).
> How to run it, the measurements and the isolation-verification results are in the app's
> [README](./printer-showcase/README.md).
> Measured: A1 mini (180 bed) 15m vs P1S (256 bed) 12m — the same 20mm cube, the profiles' motion-limit difference.
> Automatic sample-model load is **done**: the plate opens with the 20 mm cube already sliced, through the
> `files` prop that landed in 0.2.2 (the demos now pin ^0.2.4). Before that no such prop existed and a
> test-cube download plus the viewer's own drop/file picker stood in for it; no private access was used
> either way.
> Remaining: a deployment URL, a representative GIF.

## What this demonstrates

An **"embeddable slicer that lets a visitor experience how a model actually prints on this printer"** that a
3D-printer manufacturer can put on a product detail page.

What it sells is not the slicer itself but the fact that **a slicer experience can be embedded into an existing
web page**. So it is deliberately not built like a full-screen slicer — it exists as one section inside a
fictional manufacturer landing page (marketing copy, a Buy now button).

## Target

3D-printer OEMs · resellers · product-comparison sites · printer landing pages.

## Package APIs used

```
three-slicer/viewer      <Viewport settings setSettings panels features defaultExtruderColors/>
three-slicer/settings    printersByVendor / printerSettings(name) — the machine list and profile swap
three-slicer/components  <SettingsPanel embedded/> — the exposed options kept to a few
```

`three-slicer/client` is not called directly. Viewport owns the worker and the slice lifecycle; the host
receives state and statistics through `onEvent` and `onSliced`.

## Install

This demo is an independent project deployed to a different site than the repository
([DEMOS.md §2](./DEMOS.md#2-independent-projects-and-installation)).

```bash
npm i three-slicer three react react-dom
```

All three peers are needed — Viewport and SettingsPanel are React components and render with three.
A real manufacturer page may not be React, so the embed point is isolated into one file
(`slicer_section.jsx`), shaped as "mount this one file and you are done".

## Screen

A fictional manufacturer "ACME" landing page. For the wireframe see [DEMOS.md](./DEMOS.md) §2.

- Hero: product name + marketing copy + [Buy now] (inert, mock)
- A "Try it with your model" section: the Viewport embed, with only layer height/infill exposed
- After slicing the same viewport switches to toolpath mode, showing print time · filament · the layer slider

## Switching machines

The top bar holds only 3 machines from the real catalog: `[A1 mini] [P1S] [X1 Carbon]` (all 0.4mm nozzle).
Selecting one swaps `settings` for the real profile obtained through `printerSettings()` — build volume,
nozzle, machine limits and build plate change together. No made-up values: only the real vendor profile data
`three-slicer/settings` exposes is used.

The exact profile keys are `Bambu Lab A1 mini 0.4 nozzle`, `Bambu Lab P1S 0.4 nozzle` and
`Bambu Lab X1 Carbon 0.4 nozzle`. The UI label and the lookup key are kept separate.

## Implementation notes

- **The host owns `settings`/`setSettings`** and the machine buttons mutate that state — Viewport's
  host-prop boundary becomes the embed-pattern example as-is.
- **Opt out via `panels`**: the printer card stays `'readonly'` and unneeded cards/tools are hidden with
  `false`. SettingsPanel has no arbitrary key-list filter, so the two layer height/infill controls are built
  as host UI. (Machines change only through the buttons above — but readonly does not block the host's own
  settings writes.)
- **Opt out via `features`**: behaviours that would clash with the host page, such as claiming the page's
  keyboard, are switched off.
- Both a visitor STL upload and an automatic default sample-model load are supported.
- At the time of writing `<Viewport/>` had no prop for the host to inject model bytes. Satisfying "automatic
  sample load" means first adding a public imperative/model prop, or putting an explicit **Load sample** user
  action on the first screen. No private scene access and no synthetic drop events.

## Minimal embed example

```jsx
<div className="slicer-frame">
  <Viewport
    settings={settings}
    setSettings={setSettings}
    defaultAutoSlice
    panels={{ printerCard: 'readonly', processCard: false, towerCard: false }}
    features={{ shortcuts: false, logs: false }}
    onEvent={event => event.type === 'progress' && setProgress(event.value)}
    onSliced={({ stats }) => setStats(stats)}
  />
</div>
```

`.slicer-frame` must have `position: relative` and a real height. Viewport fills its nearest positioned
ancestor and has no width/height props of its own.

## Embed verification (this demo's key completion criterion)

The host page carries global CSS deliberately chosen to collide:

```css
button { border-radius: 0; }
canvas { max-width: 300px; }
input  { font-size: 24px; }
```

Viewport and SettingsPanel are Shadow DOM isolated, so they must be unaffected — the isolation is verified
against the actually rendered screen.

## What is intentionally mocked

- Manufacturer branding (the fictional "ACME"), Buy now, login, cloud, telemetry, firmware, a real machine
  connection — none of it exists.

## Definition of done

- [ ] embedded inside a product page (not full-screen)
- [ ] 3-machine switching + the build plate change confirmed
- [ ] automatic sample-model load / visitor STL upload
- [ ] only a minimal settings surface exposed (`panels` opt-out)
- [ ] browser slicing, model ↔ toolpath view switching
- [ ] layer slider, print time · filament shown
- [ ] host CSS isolation confirmed (under the colliding CSS above)
- [ ] layout holds at mobile width (360px)

## E2E scenario

```
page load → sample model shown → click [X1 Carbon] → confirm the build plate size changes
→ Slice → toolpath shown → layer slider works → print time > 0
```

An additional embed scenario:

```text
apply the colliding host CSS rules → 360px viewport → run Load model and Slice by keyboard tab
→ the viewer canvas does not shrink to 300px and the buttons inside keep their shape
```

## To add to the docs after implementation

- live URL, desktop/mobile screenshots
- the actual run/build/E2E commands
- the exposed host controls and their corresponding settings keys
- CSP and COOP/COEP deployment headers

## Production considerations

A production embed additionally has to handle CSP/iframe policy, a bundle-size budget, WASM loading latency
(deferred loading is controlled through `features` above), and accessibility (keyboard focus coexisting with
the host page). The representative GIF for the README/landing is made with this demo (DEMOS.md §8 Phase 1).
