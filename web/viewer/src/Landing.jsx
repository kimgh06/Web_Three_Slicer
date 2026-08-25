import React, { Suspense, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

// The live embed below mounts the real <Viewport/>, so the same guard Prepare.jsx uses applies here:
// Googlebot's renderer has no WebGL, and mounting there would blank the one page that carries the
// crawlable content. Without WebGL the static screenshot simply stays.
const webglAvailable = (() => {
  try {
    const probeCanvas = document.createElement('canvas')
    return !!(probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl'))
  } catch { return false }
})()

// Lazy on purpose, twice over: the chunk (three.js + the viewer) only downloads once the section
// scrolls into view, and the kernel WASM only downloads if the visitor actually presses Slice.
const Viewport = React.lazy(() => import('three-slicer/viewer'))

// Written out rather than imported: `Object.keys(config-schema.json).length` pulled all 382KB of the schema
// into the landing chunk to produce one integer, on the one page that has no other use for it.
// The generator of record is packages/types/gen_settings_types.mjs — it prints the same count.
const OPTION_COUNT = 976

// npm and GitHub live in the CTA row — this row holds only destinations the buttons do not.
const LINKS = [
  ['Community', 'https://github.com/kimgh06/Web_Three_Slicer/discussions', 'questions · ideas · show and tell'],
  ['Issues', 'https://github.com/kimgh06/Web_Three_Slicer/issues', 'bug reports'],
  ['Integration specs', 'https://github.com/kimgh06/Web_Three_Slicer/tree/main/examples', 'the demo specs and sources'],
]

// Every figure is measured from the shipped artifacts (schema key count from gen_settings_types,
// catalog sizes from data/, invariant count from wasm-core/test.mjs) — update alongside them.
const STATS = [
  [OPTION_COUNT, 'OrcaSlicer options'],
  ['1,041', 'printer profiles'],
  ['5,999', 'filament presets'],
  ['120+', 'kernel invariants'],
  ['byte-identical', 'golden G-code gate'],
]

// The same copy the /demos page uses; each card opens the standalone build of that demo.
const DEMOS = [
  ['instant-quote', 'Instant Quote', 'Headless slicing', 'Slice in the browser, price the result. No viewer, no React — the SDK on its own.'],
  ['printer-showcase', 'Printer Showcase', 'Drop-in embed', 'A product page with a slicer in it. Three machines, host-owned settings, Shadow DOM isolation.'],
  ['cad-embed', 'CAD Embed', 'Programmable engine', 'Move a slider, get print time back. Debounced re-slicing with a generation guard.'],
  ['farm-dashboard', 'Print Farm', 'Client-side compute', 'Queue jobs for several printers. Slicing happens here; a backend would only hold G-code.'],
]

// Kept word-for-word in sync with the FAQPage JSON-LD in index.html — Google only honours FAQ
// structured data whose answers are visible on the rendered page.
const FAQ = [
  ['Do my models get uploaded anywhere?',
   'No. The slicing kernel is compiled to WebAssembly and runs inside the browser tab, so the model file never leaves the machine it was opened on.'],
  ['Which file formats can it slice?',
   'STL, OBJ, 3MF, AMF and PLY are read directly, and STEP is read through a loader that only downloads when a STEP file is actually opened. An .sl1 resin archive can be opened as well. The output is G-code for filament printers, or an .sl1 archive for resin ones.'],
  ['Is it based on a real slicer?',
   'Yes. The kernel is a port of OrcaSlicer, which is itself a PrusaSlicer/Slic3r descendant. Arachne wall generation, tree supports, multi-material segmentation and the prime tower are ported from that source rather than reimplemented, and the resin support-point generator, support tree and pad are ported from PrusaSlicer 2.9.6.'],
  ['Can I use the slicer in my own site or app?',
   'Yes. The same engine is published to npm as three-slicer under AGPL-3.0-or-later: a headless slicing kernel for Node or the browser, plus an optional React viewer and settings panel.'],
]

const ROUTES = [
  ['Engine', 'three-slicer', 'Slice a binary STL into G-code, or into SLA layer masks, in Node or the browser'],
  ['Settings', 'three-slicer/settings', 'Convert an OrcaSlicer settings map into kernel parameters'],
  ['Viewer', 'three-slicer/viewer', 'React 3D viewer: model loading, worker slicing, toolpath preview'],
  ['Components', 'three-slicer/components', `React SettingsPanel driven by the ${OPTION_COUNT}-option schema`],
  ['Data', 'three-slicer/data', 'config schema, UI tree, toggle rules, printer / process / filament catalogs'],
  ['Worker', 'three-slicer/worker', 'Layer streaming off the browser main thread'],
]

const GROUPS = [
  ['Input', ['STL', 'OBJ', '3MF project (layout · settings · painting)', 'AMF', 'PLY', 'STEP', '.sl1 archive', 'drag and drop', 'multiple models']],
  ['Arrange', ['move', 'rotate', 'scale', 'duplicate', 'split to objects', 'place on bed', 'multi-plate']],
  ['Slicing', [
    'Arachne variable-width walls', 'gyroid / honeycomb / crosshatch infill',
    'tree · grid support', 'support painting', 'material painting',
    'skirt', 'brim', 'raft', 'ironing', 'arc fitting', 'multi-material', 'prime tower',
  ]],
  ['Resin', [
    'PrusaSlicer support points', 'support tree', 'pad', 'pad around object',
    'resin catalog', 'layer mask preview', '.sl1 import',
  ]],
  ['Preview', ['layer slider', 'single layer', 'travel', 'move scrub', 'feature / speed / height / width / fan / temperature views']],
  ['Output', ['G-code download', '.3mf project save', '.sl1 archive', 'print time', 'filament usage']],
  ['Settings', [`${OPTION_COUNT} options`, 'search', 'mode filter']],
]

function Screenshot() {
  return (
    <picture>
      <source srcSet="/usage.webp" type="image/webp" />
      <img
        src="/usage.png"
        alt="A sliced Benchy in the Preview tab: organic tree supports, per-feature toolpath colors, dual layer-range slider, filament and print-time estimates"
        width="2674"
        height="1996"
        fetchpriority="high"
      />
    </picture>
  )
}

// The screenshot's spot, upgraded in place: off by default, and when the section scrolls into view the
// real slicer mounts with a Benchy already on the plate (an FFF session — the default technology).
// The prime tower ghost draws whenever two extruders are loaded (the default filament pair) unless the
// map holds an explicit false — the viewer reads the MAP, not the schema default. The support keys are
// inert until the checkbox sets enable_support: tree supports only, standing on the build plate only.
const INITIAL_SETTINGS = {
  enable_prime_tower: false,
  // The kernel routes tree vs grid from support_style ONLY (settings.js maps /tree|organic/ -> the real
  // organic TreeSupport); support_type is not consulted, so 'tree(auto)' alone still sliced grid.
  support_style: 'organic',
  support_on_build_plate_only: true,
}

function LiveSlicer() {
  const [armed, setArmed] = useState(false)      // the section has been near the viewport once
  const [files, setFiles] = useState(null)       // [{name, data}] — held in state for a stable identity
  const [settings, setSettings] = useState(INITIAL_SETTINGS)
  // The viewer exposes no imperative slice — slicing starts from its own UI or defaultAutoSlice at
  // mount. With the built-in chrome hidden, the FIRST slice therefore works by REMOUNTING (the key)
  // with defaultAutoSlice; after that auto-slice is on, so a settings change (the Supports checkbox,
  // a drag) re-slices in place with no remount. The benchy buffer stays in state, so a remount
  // re-parses but never re-downloads.
  //
  // `phase` exists because the remount made the buttons flicker (measured: enabled until the new mount's
  // slicing event at ~960ms, disabled for 240ms, enabled again). Going busy AT THE CLICK and staying
  // busy until the slice reports done turns that double flip into one continuous window, and the veil
  // covers the remount's blank frame.
  const [generation, setGeneration] = useState(0)
  const [wantSlice, setWantSlice] = useState(false)
  const [phase, setPhase] = useState('idle')     // idle | preparing | slicing | done
  const boxRef = useRef(null)

  useEffect(() => {
    if (!webglAvailable) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setArmed(true); io.disconnect() }
    }, { rootMargin: '200px' })
    io.observe(boxRef.current)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!armed) return
    let gone = false
    fetch('/benchy.stl')
      .then(response => { if (!response.ok) throw new Error(String(response.status)); return response.arrayBuffer() })
      .then(buffer => { if (!gone) setFiles([{ name: 'benchy.stl', data: buffer }]) })
      .catch(() => {})                            // fetch failure leaves the screenshot — never a broken frame
    return () => { gone = true }
  }, [armed])

  const live = webglAvailable && armed && files
  return (
    <figure className={`lp-shot${live ? ' lp-live' : ''}`} ref={boxRef}>
      {live ? (
        <>
          <div className="lp-live-frame">
            <Suspense fallback={<Screenshot />}>
              <Viewport
                key={generation}
                settings={settings}
                setSettings={setSettings}
                files={files}
                defaultAutoSlice={wantSlice}
                panels={{ sidebar: false, topBar: false, gizmoRail: false, objectToolbar: false, plateBar: false, sliceBar: false, paintPanel: false, emptyHint: false }}
                features={{ shortcuts: false }}
                onEvent={event => {
                  if (event.type !== 'slicing') return
                  if (event.value) setPhase('slicing')
                  else setPhase(previous => previous === 'slicing' ? 'done' : previous)
                }}
              />
            </Suspense>
            {phase === 'preparing' && <div className="lp-live-veil">Starting the slice…</div>}
          </div>
          <div className="lp-live-bar">
            <button className="lp-btn primary" disabled={phase !== 'idle'}
              onClick={() => { setWantSlice(true); setPhase('preparing'); setGeneration(n => n + 1) }}>
              {phase === 'idle' ? 'Slice this Benchy' : phase === 'done' ? 'Sliced' : 'Slicing…'}
            </button>
            <label className="lp-live-check">
              <input
                type="checkbox"
                checked={!!settings.enable_support}
                disabled={phase === 'preparing' || phase === 'slicing'}
                onChange={event => setSettings(current => ({ ...current, enable_support: event.target.checked }))}
              />
              Supports
            </label>
            <button className="lp-btn" disabled={phase === 'preparing' || phase === 'slicing'}
              onClick={() => { setWantSlice(false); setPhase('idle'); setSettings(INITIAL_SETTINGS); setGeneration(n => n + 1) }}>
              Reset
            </button>
          </div>
        </>
      ) : (
        <Screenshot />
      )}
      <figcaption>
        {live && 'Live — a Benchy preloaded on the plate, sliced in this tab.'}
        {!live &&'The Preview tab — a sliced Benchy with tree supports, per-feature toolpath colors and print estimates.'}
      </figcaption>
    </figure>
  )
}

export default function Landing() {
  return (
    <div className="landing">
      <header className="lp-head">
        <div className="lp-kicker">three-slicer · Browser/WASM 3D printing slicer</div>
        <h1>Web Three Slicer</h1>
        <p className="lp-lede">Slice STL to G-code right in your browser — nothing installs, nothing uploads.</p>
        <p>Under the hood: an OrcaSlicer-based WASM slicing engine, React viewer and settings panel, shipped as a
          single npm package. Filament printers slice to G-code; resin printers route through PrusaSlicer&rsquo;s
          ported support and pad chain to an <code>.sl1</code> archive.</p>
        <div className="lp-cta">
          <Link className="lp-btn primary" to="/slice">Open the slicer</Link>
          <Link className="lp-btn" to="/demos">Demos</Link>
          <a className="lp-btn" href="https://www.npmjs.com/package/three-slicer" target="_blank" rel="noreferrer">npm package</a>
          <a className="lp-btn" href="https://github.com/kimgh06/Web_Three_Slicer" target="_blank" rel="noreferrer">
            GitHub
            <img className="lp-badge" src="https://img.shields.io/github/stars/kimgh06/Web_Three_Slicer?style=social" alt="GitHub stars" width="80" height="20" />
          </a>
        </div>
        <nav className="lp-links" aria-label="Project links">
          {LINKS.map(([label, href, meta]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer">
              <span>{label}</span>
              <small>{meta}</small>
            </a>
          ))}
        </nav>
        <ul className="lp-stats" aria-label="Measured scope">
          {STATS.map(([value, label]) => (
            <li key={label}><b>{value}</b><small>{label}</small></li>
          ))}
        </ul>
      </header>

      <main>
        <LiveSlicer />

        <section className="lp-section" aria-labelledby="install-title">
          <div className="lp-section-head">
            <h2 id="install-title">Install</h2>
            <p>Use the headless engine on its own, or add the React viewer and settings UI on top.</p>
          </div>
          <div className="lp-code-grid">
            <pre><code>npm i three-slicer</code></pre>
            <pre><code>npm i three-slicer react react-dom three</code></pre>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="routes-title">
          <div className="lp-section-head">
            <h2 id="routes-title">Use It As</h2>
            <p>Subpath exports are split so you can follow the usage paths in the README exactly.</p>
          </div>
          <div className="lp-route-grid">
            {ROUTES.map(([name, path, desc]) => (
              <article key={path} className="lp-route-card">
                <h3>{name}</h3>
                <code>{path}</code>
                <p>{desc}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="lp-section" aria-labelledby="demos-title">
          <div className="lp-section-head">
            <h2 id="demos-title">Integration Demos</h2>
            <p>Four real integrations, each an independent project installing <code>three-slicer</code> from npm.
              Cards open the standalone builds; <Link to="/demos">the gallery</Link> shows them side by side with
              their sources.</p>
          </div>
          <div className="lp-route-grid">
            {DEMOS.map(([name, title, sells, blurb]) => (
              <a key={name} className="lp-route-card lp-demo-card" href={`${import.meta.env.BASE_URL}demos/${name}/`}>
                <span className="lp-demo-sells">{sells}</span>
                <h3>{title}</h3>
                <p>{blurb}</p>
              </a>
            ))}
          </div>
        </section>

        <section className="lp-section" aria-labelledby="features-title">
          <div className="lp-section-head">
            <h2 id="features-title">Demo Surface</h2>
            <p>This deployment is a real browser demo that consumes the package by its workspace name.</p>
          </div>
          <dl className="lp-feat">
            {GROUPS.map(([label, items]) => (
              <div key={label} className="lp-row">
                <dt>{label}</dt>
                <dd>{items.map((t, i) => (
                  <span key={t}>{i > 0 && <i className="lp-dot">·</i>}{t}</span>
                ))}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="lp-section" aria-labelledby="faq-title">
          <div className="lp-section-head">
            <h2 id="faq-title">Questions</h2>
          </div>
          <dl className="lp-faq">
            {FAQ.map(([q, a]) => (
              <div key={q}>
                <dt>{q}</dt>
                <dd>{a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="lp-section lp-license" aria-label="License">
          <p>AGPL-3.0-or-later · based on OrcaSlicer · runs in the browser or Node with no server</p>
          <Link to="/slice">Start slicing</Link>
          <Link to="/demos">See the demos</Link>
        </section>
      </main>

      <footer className="lp-foot">
        <span>Source</span>
        <a href="https://github.com/kimgh06/Web_Three_Slicer" target="_blank" rel="noreferrer">kimgh06/Web_Three_Slicer</a>
        <a href="https://github.com/kimgh06/Web_Three_Slicer/discussions" target="_blank" rel="noreferrer">Community</a>
      </footer>
    </div>
  )
}
