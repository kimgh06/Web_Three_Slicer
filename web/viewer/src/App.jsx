import React, { Suspense, lazy } from 'react'
import Landing from './Landing.jsx'

// Every route except the landing page is lazy. They pull three.js, the settings panel and the WASM glue,
// which is most of the bundle — and the landing page is the one a search engine or a first-time visitor
// actually loads, so it must not pay for the slicer it is only describing.
const Prepare = lazy(() => import('./Prepare.jsx'))
const TestBed = lazy(() => import('./TestBed.jsx'))
const Demos = lazy(() => import('./Demos.jsx'))

// The chunk is a few MB, so the wait is real and needs to be visible. It matches the pre-render fallback in
// slice/index.html deliberately: the static HTML and the first React frame should not disagree.
function Loading() {
  return (
    <div className="route-loading">
      <p>Loading…</p>
    </div>
  )
}

const deferred = (element) => <Suspense fallback={<Loading />}>{element}</Suspense>

// The landing page (/) is kept separate from the slicer (/slice). The landing page lives outside the 3D
// shell so it renders without initializing three.js/WASM — someone who only came to read about it
// should not load the kernel.
// /demos hosts the examples/ projects: each is built separately and shown in an iframe, so the page
// demonstrates the published package rather than this app's own wiring.
// /testbed drives the embedding surface (panels, features, onEvent, onExport, gcode-only) from outside the
// component, with the configuration in the URL. /slice cannot do that job: it is a host that already made one set
// of choices, which is exactly what a test bed has to be able to vary.
export const routes = [
  { path: '/', element: <Landing /> },
  { path: '/slice', element: deferred(<Prepare />) },
  { path: '/testbed', element: deferred(<TestBed />) },
  { path: '/demos', element: deferred(<Demos />) },
]
