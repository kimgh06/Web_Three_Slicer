// The fake product page. Everything here is marketing chrome — the integration is src/slicer_section.jsx,
// which this file mounts in one line.
import { createRoot } from 'react-dom/client'
import SlicerSection from './slicer_section.jsx'
import './host.css'

function ProductPage() {
  return (
    <>
      <header className="nav">
        <span className="brand">ACME 3D</span>
        <nav>
          <a href="#try">Printers</a>
          <a href="#try">Materials</a>
          <a href="#try">Support</a>
        </nav>
        <button type="button" className="buy">Buy now</button>
      </header>

      <main>
        <section className="hero">
          <h1>ACME P1</h1>
          <p>Fast CoreXY printing for everyday production.</p>
          <p className="hero-meta">From $699 · 256 × 256 × 250 mm · 0.4 mm hardened nozzle</p>
          <button type="button" className="buy buy-lg">Buy now</button>
        </section>

        <section className="try" id="try">
          <h2>Try it with your model</h2>
          <p className="try-lede">
            Pick a machine, drop a model, and see the real toolpaths and print time it produces.
            Nothing is uploaded — the slicer runs in this page.
          </p>

          <SlicerSection />

          <p className="sample">
            No model handy? <a href="calibration-cube.stl" download>Download a 20 mm test cube</a> and drop it on the plate.
          </p>
        </section>

        <section className="specs">
          <h2>Specifications</h2>
          <dl>
            <div><dt>Build volume</dt><dd>256 × 256 × 250 mm</dd></div>
            <div><dt>Max speed</dt><dd>500 mm/s</dd></div>
            <div><dt>Nozzle</dt><dd>0.4 mm hardened steel</dd></div>
            <div><dt>Chamber</dt><dd>Enclosed, active carbon filter</dd></div>
          </dl>
        </section>
      </main>

      <footer className="foot">
        <p>ACME 3D is a fictional company. This page is a <code>three-slicer</code> embed demo.</p>
        <p>Powered by <code>three-slicer/viewer</code> and <code>three-slicer/settings</code></p>
      </footer>
    </>
  )
}

createRoot(document.getElementById('root')).render(<ProductPage />)
