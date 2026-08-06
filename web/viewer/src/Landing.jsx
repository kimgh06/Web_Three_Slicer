import React from 'react'
import { Link } from 'react-router'
import schema from 'three-slicer/data/config-schema.json'

const OPTION_COUNT = Object.keys(schema).length

const LINKS = [
  ['npm', 'https://www.npmjs.com/package/three-slicer', 'package'],
  ['GitHub', 'https://github.com/kimgh06/Web_Three_Slicer', 'source'],
  ['Demo', 'https://slicer.kimgh06.com/', 'deployment'],
]

const ROUTES = [
  ['Engine', 'three-slicer', 'Slice a binary STL into G-code, in Node or the browser'],
  ['Settings', 'three-slicer/settings', 'Convert an OrcaSlicer settings map into kernel parameters'],
  ['Viewer', 'three-slicer/viewer', 'React 3D viewer: model loading, worker slicing, toolpath preview'],
  ['Components', 'three-slicer/components', 'React SettingsPanel driven by the 907-option schema'],
  ['Data', 'three-slicer/data', 'config schema, UI tree, toggle rules, invalidation map'],
  ['Worker', 'three-slicer/worker', 'Layer streaming off the browser main thread'],
]

const GROUPS = [
  ['Input', ['STL', 'OBJ', '3MF', 'AMF', 'PLY', 'drag and drop', 'multiple models']],
  ['Arrange', ['move', 'rotate', 'scale', 'duplicate', 'split to objects', 'place on bed', 'multi-plate']],
  ['Slicing', [
    'Arachne variable-width walls', 'gyroid / honeycomb / crosshatch infill',
    'tree · grid support', 'support painting',
    'skirt', 'brim', 'raft', 'ironing', 'arc fitting', 'multi-material',
  ]],
  ['Preview', ['layer slider', 'single layer', 'travel', 'feature / speed / height / width / fan / temperature views']],
  ['Output', ['G-code download', 'print time', 'filament usage']],
  ['Settings', [`${OPTION_COUNT} options`, 'search', 'mode filter']],
]

export default function Landing() {
  return (
    <div className="landing">
      <header className="lp-head">
        <div className="lp-kicker">three-slicer · Browser/WASM 3D printing slicer</div>
        <h1>Web Three Slicer</h1>
        <p>An OrcaSlicer-based WASM slicing engine, React viewer and settings panel, shipped as a single npm package.</p>
        <div className="lp-cta">
          <Link className="lp-btn primary" to="/slice">Open the slicer</Link>
          <a className="lp-btn" href="https://www.npmjs.com/package/three-slicer" target="_blank" rel="noreferrer">npm package</a>
          <a className="lp-btn" href="https://github.com/kimgh06/Web_Three_Slicer" target="_blank" rel="noreferrer">GitHub</a>
        </div>
        <nav className="lp-links" aria-label="Project links">
          {LINKS.map(([label, href, meta]) => (
            <a key={label} href={href} target="_blank" rel="noreferrer">
              <span>{label}</span>
              <small>{meta}</small>
            </a>
          ))}
        </nav>
      </header>

      <main>
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

        <section className="lp-section lp-license" aria-label="License">
          <p>AGPL-3.0-or-later · based on OrcaSlicer · runs in the browser or Node with no server</p>
          <Link to="/slice">Start slicing</Link>
        </section>
      </main>

      <footer className="lp-foot">
        <span>Source</span>
        <a href="https://github.com/kimgh06/Web_Three_Slicer" target="_blank" rel="noreferrer">kimgh06/Web_Three_Slicer</a>
      </footer>
    </div>
  )
}
