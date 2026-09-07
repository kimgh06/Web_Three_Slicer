# three-slicer-viewer-core

G-code parsing and GPU toolpath rendering for 3D printing. **MIT licensed** — usable in closed-source
commercial products.

This is the display half of [`three-slicer`](https://www.npmjs.com/package/three-slicer), separated so it can
be adopted without the AGPL obligation the slicing kernel carries. It draws toolpaths; it does not slice.
If you need slicing, install `three-slicer` — and note that doing so puts your application under AGPL.

## What it does

```js
import { parseGcode } from 'three-slicer-viewer-core/gcode'
import { buildSegmentData, makeToolpath, computeColors } from 'three-slicer-viewer-core'
import * as THREE from 'three'

const { layers, stats } = parseGcode(gcodeText)          // any slicer's output
const data = buildSegmentData(layers, 0.4)               // -> GPU attribute buffers
const handle = makeToolpath(THREE, data)                 // -> { mesh, travLines, ... }
scene.add(handle.mesh, handle.travLines)

handle.setLayerRange(0, 90)                              // cut the print open
handle.setColors(computeColors(data, 'speed', ctx).color) // recolour without a rebuild
```

- Reads G-code from OrcaSlicer, PrusaSlicer, Cura and this kernel — roles, widths, tool changes, arcs.
- Draws one instanced call for the whole plate, with per-role, per-tool and heatmap colouring.
- `three` is an **optional peer**: `makeToolpath` takes the THREE namespace as an argument rather than
  importing it, so your instance is the one used — and a consumer that only parses G-code pulls in no
  renderer at all.

## Licensing

MIT. It depends on nothing AGPL, which a check in this repository enforces rather than documents
(`packages/viewer/test_license_boundary.mjs`).

The implementation was written from [`TOOLPATH_SPEC.md`](./TOOLPATH_SPEC.md), a functional contract, rather
than derived from any upstream slicer. The reasoning and evidence are in
[`../packages/PROVENANCE.md`](../packages/PROVENANCE.md); the plan it came from is
[`../packages/RELICENSE.md`](../packages/RELICENSE.md).

Published as a locked pair with `three-slicer`: both carry the same version, and `three-slicer` pins this
package exactly, so a combination that was never built together cannot be resolved.
