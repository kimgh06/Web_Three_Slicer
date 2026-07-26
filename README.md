# OrcaSlicer + Browser Slicing (reverse-engineering)

This repository holds two independent parts:

- **`slicer/`** — the upstream OrcaSlicer source, unmodified (C++ app, `deps/`, `resources/`, `tests/`, CMake, build scripts). See [`slicer/README.md`](slicer/README.md).
- **`web/`** — a browser/WASM slicing kernel + viewer reverse-engineered from `slicer/`, self-contained (no build/runtime dependency on `slicer/`). See [`web/README.md`](web/README.md) and [`web/GUIDE.md`](web/GUIDE.md).

Licensed under AGPL-3.0-or-later (see [`LICENSE.txt`](LICENSE.txt)).

> **Tradeoff:** placing upstream under `slicer/` (rather than the repo root) makes syncing new OrcaSlicer releases harder — upstream merges/rebases must be re-targeted into the `slicer/` subtree. This was an accepted decision to cleanly separate the reverse-engineered `web/` work from the original tree.
