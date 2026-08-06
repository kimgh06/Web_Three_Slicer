# OrcaSlicer reverse-engineering guide — packaging it for the web/npm

> Audience: developers analyzing the OrcaSlicer codebase (C++17, wxWidgets, CMake) to rebuild it as a **family of packages that run on npm**.
> Every file reference is relative to this repository and uses the `file:line` format.
> Commit surveyed: `607648c61f` (main).

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [How the runtime works](#2-how-the-runtime-works)
3. [Core data models](#3-core-data-models)
4. [The config system — the top extraction target](#4-the-config-system)
5. [The preset system and profile data](#5-the-preset-system-and-profile-data)
6. [Full breakdown of the UI](#6-full-breakdown-of-the-ui)
7. [Data persistence (disk/project files)](#7-data-persistence)
8. [The slicing pipeline](#8-the-slicing-pipeline)
9. [G-code processing and preview](#9-g-code-processing-and-preview)
10. [npm packaging strategy](#10-npm-packaging-strategy)
11. [Extraction recipes (runnable procedures)](#11-extraction-recipes)
12. [Roadmap and difficulty table](#12-roadmap-and-difficulty-table)
13. [Appendix: index of key files](#13-appendix-index-of-key-files)

---

## 0. Getting started (handoff checklist)

What whoever receives this document should do on day 1. The document alone is not enough without the repository —
**this repository plus the [reverse_engineering/](reverse_engineering/) artifacts** are the set.

1. Read §1 (architecture) and §2 (runtime) — 30 minutes. The rest is a reference to consult as needed.
2. Open the 4 JSON files in `reverse_engineering/` and study their structure — they are the input data for the web implementation.
3. Create the monorepo and lay out the package skeleton from §10.2. The first sprint = roadmap items 1-4 in §12:
   - `@orca/config-schema`: config-schema.json + a d.ts generator (the data already exists; one day)
   - `@orca/ui-map`: translating ui-tree.json + toggle-rules.json (the §4.3 widget mapping rules)
   - `@orca/presets`: copy `resources/profiles/` + the §5.4 inheritance resolver
   - The settings form generator: join schema x ui-map -> a React form
4. For each package, land the §11.7 acceptance criteria as CI tests before starting.
5. Do not go straight to WASM for slicing — get it working with a CLI server (§10.1 track C) first.

If you get stuck: open the relevant upstream file from the file index (§13) and jump to the exact source location using the
`line` field in the generated JSON.

---

## 1. Architecture overview

OrcaSlicer has three layers. **Strip the UI away and the slicing core still works entirely on its own**,
as the CLI (`--slice`) proves.

```
┌─────────────────────────────────────────────────────────────┐
│  src/slic3r/GUI/          the GUI layer (wxWidgets + ImGui + GL)  │
│  - MainFrame/Plater/Tab   windows, tabs, sidebar                  │
│  - GLCanvas3D/Gizmos      the 3D viewport, model manipulation     │
│  - GCodeViewer            preview (delegated to libvgcode)        │
├─────────────────────────────────────────────────────────────┤
│  src/slic3r/               the GUI-core glue layer                 │
│  - BackgroundSlicingProcess  runs Print::process on a worker thread │
│  - Utils/UndoRedo            cereal-serialized snapshots          │
├─────────────────────────────────────────────────────────────┤
│  src/libslic3r/            the core (no UI dependency) ★ the port target │
│  - Model.*                 the 3D model tree                      │
│  - Config/PrintConfig      907 option definitions + value containers │
│  - Preset/PresetBundle     preset loading, inheritance, compatibility │
│  - Print/PrintObject       the slicing pipeline                   │
│  - GCode/*                 G-code generation and post-processing  │
│  - Format/*                3MF/STL/OBJ/STEP I/O                   │
├─────────────────────────────────────────────────────────────┤
│  src/libvgcode/            a standalone library just for G-code visualization ★ │
└─────────────────────────────────────────────────────────────┘
```

Dependencies (deps/): Boost, TBB, Eigen, CGAL, OpenVDB, OCCT (STEP), Clipper, Cereal,
wxWidgets, GLEW/GLFW, CURL, OpenSSL, Draco, … **For a WASM port the bottlenecks are TBB (threads),
CGAL/OpenVDB (heavy) and OCCT (effectively something to give up on)**.

An Emscripten/WASM build configuration **does not exist** in this repository today (0 hits when searching the CMakeLists).

---

## 2. How the runtime works

### 2.1 Startup sequence

```
main (src/OrcaSlicer.cpp)
 └→ GUI_App::OnInit (src/slic3r/GUI/GUI_App.cpp:2672)
     └→ on_init_inner (GUI_App.cpp:2824)
         ├→ app_config = new AppConfig()            <- loads the global app settings
         ├→ preset_bundle = new PresetBundle()       (GUI_App.cpp:3058)
         │    └→ loads every system/user preset and resolves inheritance
         └→ mainframe = new MainFrame()              (GUI_App.cpp:3324)
              └→ creates the Plater, the Tabs (Print/Filament/Printer) and the webview home
```

### 2.2 The edit -> slice -> preview loop (the heart of the app)

```
user edit (moving a model, changing a setting, switching a preset)
  → Plater::priv::update_background_process (Plater.cpp:8884)
      → Print::apply(Model, DynamicPrintConfig)     <- a diff comparison
          returns: UNCHANGED / CHANGED / INVALIDATED   (PrintBase.hpp:401)
          a graph decides which pipeline steps the changed options invalidate
  → BackgroundSlicingProcess restarts
      → the worker thread thread_proc (BackgroundSlicingProcess.cpp:330)
          → process_fff (same file:192) → Print::process() → G-code export
  → the UI is notified through a wxWidgets event
      EVT_PROCESS_COMPLETED (Plater.cpp:208, bound at 6182)
  → the GCodeProcessor result is loaded into GCodeViewer (libvgcode) → the preview tab refreshes
```

The key concept — **incremental slicing (invalidation)**: every setting option carries the set of
steps it invalidates. Changing `layer_height` -> a full re-slice;
changing `skirt_loops` -> only psSkirtBrim re-runs. Discard this invalidation graph in a web port and
every change costs a full slice, which kills the UX. The graph itself is hardcoded in `Print::invalidate_state_by_config_options`
(Print.cpp) and `PrintObject::invalidate_state_by_config_options` (PrintObject.cpp).

### 2.3 Threading model

- GUI thread: the wxWidgets event loop
- Slicing: a single worker thread owned by BackgroundSlicingProcess
- Inside the worker: TBB `parallel_for` parallelizes per layer/object (see the "beware TBB shared state" item in `AGENTS.md`)
- Cancellation: `Print::cancel()` -> cooperative cancellation checked by each step

Web equivalent: slicing = a Web Worker + WASM pthreads (SharedArrayBuffer, requiring COOP/COEP headers).

---

## 3. Core data models

### 3.1 The Model tree (src/libslic3r/Model.hpp)

```
Model (Model.hpp:1531)                    <- the document root, one per 3MF
 ├─ ModelObject[] (Model.hpp:354)         <- a logical "object" (an item in the left tree)
 │   ├─ ModelVolume[] (Model.hpp:794)     <- the actual mesh. Types: model/negative/modifier/support blocker/enforcer
 │   │   ├─ TriangleMesh                  <- the real geometry
 │   │   ├─ ModelConfigObject             <- per-volume setting overrides
 │   │   └─ painting data                  <- TriangleSelector serialization (support/seam/MMU/fuzzy skin)
 │   ├─ ModelInstance[] (Model.hpp:1256)  <- placement copies (position, rotation, scale)
 │   ├─ ModelConfigObject                 <- per-object setting overrides
 │   └─ layer_config_ranges               <- setting overrides per height band
 ├─ ModelMaterial[] (Model.hpp:161)
 └─ ModelWipeTower (Model.hpp:1429)
```

Every node inherits `ObjectBase` (ObjectID.hpp:63) -> it carries a **globally unique integer ID**.
That ID is the key for undo/redo snapshot comparison and for the `Print::apply` diff.
A web port should keep the "immutable ID per node" design as well (needed for both React keys and incremental slicing).

### 3.2 The 5-layer setting override chain

```
printer preset → filament presets (xN) → process preset
  → plate settings → ModelObject.config → ModelVolume.config → layer_config_ranges
```

Resolution (which value wins) is simple: **the later one wins**. The merged result is a
`DynamicPrintConfig`, which freezes into `PrintRegion` units (Print.hpp:115) right before
entering the slicer (volumes sharing the same setting combination are grouped together).

### 3.3 undo/redo

- [src/slic3r/Utils/UndoRedo.cpp](../slicer/src/slic3r/Utils/UndoRedo.cpp) — based on cereal serialization
- Snapshots the whole Model, but heavy objects such as TriangleMesh are shared by ObjectID (never stored twice)
- `Snapshot{name, timestamp, model_id, SnapshotData}` (UndoRedo.hpp:74)

Web equivalent: immer/Immutable.js-style structural sharing gives exactly the same effect. Mesh blobs are referenced by ID only.

---

## 4. The config system

**The real heart of this project. Extract this automatically and 90% of the web UI generates itself.**

### 4.1 Scale

- Option definitions: **907** (measured, including CLI, SLA and loop-generated ones) — all registered in [PrintConfig.cpp](../slicer/src/libslic3r/PrintConfig.cpp) (12,688 lines)
  through `this->add("key", type)` calls in the `PrintConfigDef` constructor
- Category distribution: Quality 96 · Support 59 · Strength 56 · Speed 44 · Advanced 21 ·
  Others 12 · Machine limits 10 · Extruders 8 · Flush options 3 · uncategorized 34

### 4.2 Option metadata schema — `ConfigOptionDef` (Config.hpp)

The input schema for a web form generator is defined here verbatim:

| Field | Meaning | Web mapping |
|---|---|---|
| `type` | coFloat/coInt/coBool/coString/coEnum/coPercent/coFloatOrPercent/coPoint(s)/coStrings… | which input component |
| `gui_type` | select_open, color, i_enum_open, f_enum_open, slider, one_string, legend | component variant |
| `label`, `full_label` | UI labels | label |
| `category` | search/classification | search index |
| `tooltip` | description | tooltip |
| `sidetext` | unit (mm, %, mm/s) | suffix |
| `min`, `max`, `max_literal` | value range | validation |
| `mode` | comSimple/comAdvanced/comExpert/comDevelop (Config.hpp:206) | visibility filter |
| `enum_values`, `enum_labels` | enum values / display names | `<select>` |
| `multiline`, `full_width`, `is_code`, `readonly`, `height`, `width` | layout hints | textarea/code editor |
| `nullable` | allows "inherit" in a per-extruder vector | null handling |
| `aliases`, `shortcut` | compatibility with older keys | migration |
| `printer_technology` | FFF/SLA distinction | filter |
| `cli` | CLI argument name | — |

Value containers: `DynamicPrintConfig` (a key -> ConfigOption map, used for presets and overrides) and
the `StaticPrintConfig` family (structs for the slicing hot path). On the web only the former is needed
(it is just a JS object).

Two types to watch out for:
- `coFloatOrPercent` — accepts both `"120%"` and `0.4`, where the percentage is resolved against a reference option (usually line width -> nozzle diameter). This must be reproduced in JS.
- Vector types such as `coFloats`/`coBools` — **arrays as long as the extruder/filament count**. Preset merging has array resizing rules (handled by PresetBundle).

### 4.3 GUI widget mapping (the reproduction rules)

[OptionsGroup.cpp:41-79](../slicer/src/slic3r/GUI/OptionsGroup.cpp#L41-L79) `build_field` is the single branch point:

```
gui_type == select_open | i_enum_open  → Choice (a combo box)
gui_type == color                      → ColourPicker
gui_type == slider                     → SliderCtrl
gui_type == one_string                 → TextCtrl
(then by type)
coFloat/coFloats/coPercent/coFloatOrPercent… → TextCtrl (+ a unit suffix)
coBool                                 → CheckBox
coEnum                                 → Choice
coPoints                               → PointCtrl (a coordinate list; printable_area, etc.)
```

-> On the web, 8 components render all 828 options.

### 4.4 Option dependency/toggle logic — ConfigManipulation

[ConfigManipulation.cpp](../slicer/src/slic3r/GUI/ConfigManipulation.cpp) — **198 `toggle_field` call sites**.
Rules such as "disable every support sub-option when support is off" or "force wall_loops when spiral_mode is on" —
enable/disable/auto-correct — all live here as procedural C++.

**Not automatically extractable.** This single file (plus the value-correction dialog in `update_print_fff_config`)
must be translated by hand into a JSON rule table (`{ when: {enable_support: false}, disable: [...] }`).
It is not much work (one file, around 200 rules).

---

## 5. The preset system and profile data

### 5.1 Preset types (Preset.hpp:208)

`TYPE_PRINT / TYPE_FILAMENT / TYPE_PRINTER` (plus the SLA family, PHYSICAL_PRINTER and plate config)

### 5.2 Disk layout

```
resources/profiles/                     <- system (vendor) presets, included in the repository
  <Vendor>.json                         <- the index: name, version, machine_model_list,
  │                                        process_list, filament_list, machine_list
  └─ <Vendor>/{machine,process,filament}/*.json

<data_dir>/user/<user_id>/{machine,process,filament}/*.json   <- user presets
  (PRESET_USER_DIR = "user", Preset.hpp:21; PresetBundle.cpp:996)
<data_dir>/OrcaSlicer.conf              <- app settings (JSON). Falls back to the old .ini (AppConfig.cpp:1752)
```

### 5.3 Preset JSON structure (measured: an Elegoo process profile, 92 keys)

```json
{
  "type": "process",             // machine | process | filament
  "name": "...",
  "inherits": "parent preset name",   // the inheritance chain
  "from": "system",
  "instantiation": "true|false", // false = an abstract parent (hidden from the UI)
  "compatible_printers_condition": "printer_notes=~/.../ and nozzle_diameter[0]==0.4",
  "...everything else is an option key": "value (always a string or an array of strings)"
}
```

### 5.4 Inheritance resolution algorithm (to reimplement on the web, ~200 lines)

```
resolve(preset):
  chain = []
  while preset:  chain.push(preset); preset = find(preset.inherits)
  config = {}
  for p in chain.reverse():  Object.assign(config, p.options)   // the child wins
  vector options are resized to the extruder count
```

Reference implementation: `PresetBundle::load_presets` / Preset.hpp:320-335 (`inherits()`, `normalize_inherits`).
`compatible_printers_condition` is a PlaceholderParser expression, so the expression evaluator from §9 is required.

**Important**: the vendor JSON is already web-friendly. With the 828-option schema dump (§11.1) and this resolver alone,
the profile system for every printer from all 66 vendors runs in the browser as-is.

---

## 6. Full breakdown of the UI

### 6.1 Top level (MainFrame.cpp:1315-1354)

| Tab | Implementation | Web porting verdict |
|---|---|---|
| Home | wxWebView (HTML) | already web; reference only |
| Prepare / Preview | Plater | **the core target** |
| Device | printer monitor (depends on the closed MQTT/Bambu plugin) | recommend excluding |
| Multi-device | multi-printer queue | recommend excluding |
| Project | project attachments | lower priority |
| Calibration | calibration wizard (§6.5) | lower priority |

### 6.2 Structure of the Plater (the work screen)

```
Plater
 ├─ GLCanvas3D (left, the 3D viewport)
 │   ├─ main toolbar on top: add/addplate/arrange/orient/splitobjects/splitvolumes/
 │   │                  layersediting/assembly_view/more·fewer  (GLCanvas3D.cpp)
 │   ├─ gizmo toolbar on the left: 23 of them (src/slic3r/GUI/Gizmos/) — the groups from the earlier analysis:
 │   │    transform (Move/Scale/Rotate/Flatten) · painting (FdmSupports/Seam/MmuSegmentation/FuzzySkin)
 │   │    mesh editing (Cut/AdvancedCut/MeshBoolean/Simplify) · creation (Emboss/SVG/Text)
 │   │    measurement (Measure/Assembly) · misc (BrimEars/FaceDetector) · SLA (SlaSupports/Hollow)
 │   ├─ rendering: 18 GLSL shader pairs (resources/shaders/110/: gouraud, phong, flat,
 │   │    printbed, variable_layer_height, ssao, fxaa, imgui …)
 │   └─ overlay UI: ImGui (gizmo panels, notifications, DailyTips)
 ├─ Sidebar (right, Plater.cpp:655-691)
 │   ├─ printer preset combo + edit/connect buttons + the printer image
 │   ├─ nozzle diameter/type combos, bed type combo
 │   ├─ ExtruderGroup (single / left+right dual)
 │   ├─ filament list (colors, preset combos, AMS integration)
 │   ├─ process preset combo + ParamsPanel (the settings tree embedded)
 │   └─ ObjectList (a wxDataViewCtrl tree, GUI_ObjectList.hpp:85)
 └─ bottom: slice/export buttons, the plate list
```

### 6.3 Settings editing UI — the Tab tree

Implementation: [Tab.cpp](../slicer/src/slic3r/GUI/Tab.cpp) (8,943 lines). The structure is a 3-level tree:
`Tab → add_options_page(page) → new_optgroup(group) → append_single_option_line(option key)`.
**The whole tree was extracted in this session** (summarized below; regenerate the details with the §11.2 script):

- **TabPrint** (Process): Quality / Strength / Speed / Support / Multimaterial / Others (6 pages, ~50 groups, ~400 options)
- **TabFilament**: Filament / Cooling / Advanced(G-code) / Multimaterial / Dependencies / Notes
- **TabPrinter**: Basic information / Machine G-code (12 slots) / Motion ability (limits + Input Shaping) / Multimaterial / Extruder (retraction, Z-hop) / Notes / Dependencies
- **Frequent** (the Simple mode sidebar, Tab.cpp:3340): layer_height, sparse_infill_density, wall_loops, enable_support, curr_bed_type, print order
- **Plate Settings** (Tab.cpp:3672): bed type, print_sequence, spiral_mode and 3 more (6 items)
- **Setting Overrides** (object/filament overrides, Tab.cpp:3995)

The "frequently used settings" bundle in the object right-click menu: [GUI_Factories.cpp:56-97](../slicer/src/slic3r/GUI/GUI_Factories.cpp#L56-L97)
(`FREQ_SETTINGS_BUNDLE_FFF`: Quality/Shell/Infill/Support/Flush options).

### 6.4 Custom widget library

[src/slic3r/GUI/Widgets/](../slicer/src/slic3r/GUI/Widgets/) — instead of stock wx widgets, custom skinned widgets
(Button, CheckBox, ComboBox, DropDown, SpinInput, Slider, SwitchButton, TabCtrl,
(ProgressBar, RadioGroup, TextInput, … around 30). **On the web they are all replaced by off-the-shelf components** —
use this directory only as a style reference (colors, rounding, states) and drop the code.

### 6.5 What the canvas (3D viewport) must contain

The canvas has 3 modes — `ECanvasType` (GLCanvas3D.hpp:510): `CanvasView3D` (Prepare) /
`CanvasPreview` (G-code) / `CanvasAssembleView`. Below is the complete list of render passes in
`GLCanvas3D::render()` (GLCanvas3D.cpp:1940) with a web porting verdict for each.

**Required (without these it is not a slicer canvas):**

| Pass | Upstream | Web implementation |
|---|---|---|
| Background gradient | `_render_background` | CSS / clear color |
| **Plate system** | `_render_platelist` → PartPlate.cpp: `render_background/grid/exclude_area/height_limit/logo/icons/plate_name` (lines 722-1227) | Orca's UX is centered on multiple plates. The set includes the plate rectangle, grid, exclusion areas, height limit, name label and per-plate icons (lock, settings) |
| Bed shape / origin axes | `_render_bed`, Bed3D::render_axes/render_model (3DBed.cpp:373-) | The shape data comes from the printer preset's `printable_area` (coPoints) + `bed_exclude_area` + the vendor STL/texture (PartPlate::set_shape, PartPlate.cpp:3217) |
| Model volumes (2 passes: opaque then transparent) | `_render_objects(Opaque/Transparent)` | per-instance transforms, **rendering by filament color**, a warning tint outside the build volume, hover highlighting |
| Selection markers | `_render_selection` (+ bounding box) | three.js OutlinePass or a color override |
| The active gizmo | `_render_current_gizmo` | at minimum Move/Scale/Rotate (TransformControls) |
| Camera + navigation | Camera.cpp, `_render_3d_navigator` (the view cube) | OrbitControls + a view cube, including the perspective/ortho toggle |
| Picking | `m_scene_raycaster` (GPU picking) | replaced by three.js Raycaster. Click selection, rectangle selection and drag moves all depend on it |
| **G-code toolpaths** (Preview mode) | `_render_gcode` → libvgcode | §9. Includes the dual layer/move sliders |
| Sequential print interference regions | `_render_sequential_clearance` | required once print_sequence=byObject is supported, otherwise deferred |

**Deferrable (present upstream but unnecessary for an MVP):**
shadows (`_render_shadows`), the SSAO/FXAA post-processing passes (replaced by three.js's default AA),
the wireframe overlay, the whole Assemble view (`_render_plane`, the assemble toolbars),
the painting toolbar (`_render_paint_toolbar`), variable layer height editing (layersediting),
the SLA slice display (`_render_sla_slices`) and the FPS/debug overlay.

**What to take out of the canvas (the web's advantage):** because of wx constraints, upstream draws every toolbar
inside the GL canvas with ImGui (`_render_overlays` → the main/collapse/view/canvas/gizmo/
plate-select toolbars, plus notifications). On the web, **move all of it into the DOM**. What stays on the canvas is only
what exists in 3D space (models, plates, gizmos, toolpaths). Plate labels and icons are also cheaper as a
CSS2DRenderer-style projected overlay.

#### 6.5.1 Scene data flow and the manipulation contract (reimplementation spec)

**Model → GPU data flow:**

```
Model change → GLCanvas3D::reload_scene
  → GLVolumeCollection::load_object / load_object_volume   (GLCanvas3D.cpp:2420, 2744)
     one GLVolume = one ModelVolume x ModelInstance combination  (3DScene.hpp:81, the collection at :394)
     the mesh is uploaded once per volume; instances differ only in their transform matrix
```
Web mapping: ModelVolume → create one `THREE.BufferGeometry`, place instances with `Object3D.matrix`
(or InstancedMesh). Filament color and selection state are material uniforms.

**Camera contract** ([Camera.hpp](../slicer/src/slic3r/GUI/Camera.hpp)):
- Type: `Perspective` (default) / `Ortho`, switchable (EType, :27-33)
- Manipulation: spherical rotation around the target `rotate_on_sphere(azimuth, zenith, limits)` (:151-157,
  with a zenith limit), pan = moving the target, zoom = `zoom_to_box` (:140) / `zoom_to_bed`
- Preset views `select_view(direction)` (:103) — bound to the Ctrl+0~6 shortcuts
- Web mapping: OrbitControls as-is plus a perspective/ortho toggle. `zoom_to_box` (zoom to fit the selection) must be implemented yourself

**Input events:** `GLCanvas3D::on_mouse / on_mouse_wheel / on_char / on_key`
(bindings: GLCanvas3D.cpp:3142-3145). A single on_mouse dispatches events to the active gizmo, the ImGui overlay and scene picking —
on the web the equivalent is to let the gizmo (TransformControls) consume events first and have the rest fall through
to Raycaster selection.

**Selection model** ([Selection.hpp:34](../slicer/src/slic3r/GUI/Selection.hpp#L34)):
- Two modes, `EMode { Volume, Instance }` — normally Instance (the whole object), switching to Volume when editing parts
- Ctrl multi-select, rubber-band rectangle selection, and the combined bounding box of the selection anchors the gizmo
- Commit flow: gizmo drag → Selection updates the instance/volume transform → on mouse up it is
  applied to the Model + an undo/redo snapshot + `update_background_process()` (§2.2) decides on a re-slice

**Minimum web MVP set:** OrbitControls + Raycaster click/rectangle selection + TransformControls
(Move/Rotate/Scale) + an invalidation trigger on transform commit. Those four cover half the interaction in the §6.5 required table.

**Implementation-level detail is in [reverse_engineering/SPECS.md §5](reverse_engineering/SPECS.md)** —
the geometry pipeline (the P3N3 vertex format, GLVolume's two-stage transform), the gouraud shader uniform contract
(off-bed testing, clipping and overhang slope are all computed in the fragment shader), CPU raycast picking
(the AABB tree -> three-mesh-bvh mapping), and the **8-step painting brush interaction flow**
(raycast cache → 5 cursor types → select_patch recursive splitting → smart/bucket fill → per-state overlay rendering).

### 6.5.2 Full desktop UI survey → the web reproduction roadmap

**[reverse_engineering/SPECS.md §8](reverse_engineering/SPECS.md)** — the title bar (BBLTopbar), every sidebar
member (the printer/filament/process sections, the 6 ObjectList columns, ObjectSettings/ObjectLayers, the slice
plate/all split), the Global|Objects switch in ParamsPanel and the Preview dual slider (IMSlider), all measured to
the file:line level, plus the viewer implementation order (S1~S9).

### 6.6 Calibration (calib.hpp:16-30)

12 CalibModes: PA Line/Pattern/Tower, Auto PA, Flow Rate, Temp Tower, Vol Speed,
VFA, Retraction, Input Shaping freq/damp, Cornering.
Each is a combination of "generate a test model + override specific settings + inject G-code post-processing", and
the core lives in [calib.cpp](../slicer/src/libslic3r/calib.cpp) (UI-independent -> it can be included in WASM).

---

## 7. Data persistence

### 7.1 Storage locations at a glance

| Data | Location | Format |
|---|---|---|
| App settings | `<data_dir>/OrcaSlicer.conf` | JSON (AppConfig.cpp:1752) |
| System presets | `resources/profiles/` | JSON |
| User presets | `<data_dir>/user/<id>/{machine,process,filament}` | JSON |
| Projects | `.3mf` | ZIP |
| The filament flush matrix and similar | inside the project / app settings | — |

### 7.2 Inside a 3MF project file (ZIP entries measured from bbs_3mf.cpp)

```
3D/3dmodel.model                        <- mesh + scene XML (including instance transforms)
3D/Objects/<name>_<n>.model             <- the per-object mesh, split out
Metadata/model_settings.config          <- setting overrides per object/volume/plate (XML)
Metadata/project_settings.config        <- the merged full settings snapshot (JSON, keys = option keys)
Metadata/slice_info.config              <- slice result metadata
Metadata/layer_config_ranges.xml        <- height band overrides
Metadata/layer_heights_profile.txt      <- the variable layer height curve
Metadata/custom_gcode_per_layer.xml     <- per-layer custom G-code / color changes
Metadata/cut_information.xml            <- Cut gizmo history
Metadata/brim_ear_points.txt            <- Brim Ears painting
Metadata/filament_sequence.json
Metadata/plate_N.png / plate_no_light_N.png / top_N.png / pick_N.png <- plate thumbnails
Metadata/plate_N.gcode(.md5)            <- the embedded slice result (when present)
(legacy compatibility) Metadata/Slic3r_PE*.config <- read compatibility with the PrusaSlicer family
```

**Painting data** (support/seam/MMU color) is stored as custom triangle attribute strings inside 3dmodel.model —
the encoding lives in `serialize`/`deserialize` in [TriangleSelector.cpp](../slicer/src/libslic3r/TriangleSelector.cpp)
(compressing the triangle split tree into a bitstream).
Supporting painting on the web requires porting that codec to JS (one file, self-contained).

Caution (a hard constraint from AGENTS.md): **maintain backwards compatibility for 3MF and presets**. When a web implementation rewrites a 3MF it
must preserve and copy unknown entries so the file can round-trip with the desktop app.

### 7.3 App settings (AppConfig)

Window state, recent files, vendor activation, user login, unit system, … Web equivalent: localStorage/IndexedDB.
For the schema, see `set_defaults()` in [AppConfig.cpp](../slicer/src/libslic3r/AppConfig.cpp).

---

## 8. The slicing pipeline

### 8.1 Steps (measured from Print.hpp:81-103 and Print.cpp:131-259)

```
PrintObject steps (per object, in parallel):
  posSlice                 mesh → per-layer ExPolygons (TriangleMeshSlicer)
  posPerimeters            wall generation (PerimeterGenerator: classic | Arachne variable width)
  posEstimateCurledExtrusions
  posPrepareInfill         surface classification (top/bottom/internal), anchor preparation
  posInfill                17 Fill patterns (src/libslic3r/Fill/)
  posIroning
  posContouring            (Z contour correction, ZAA)
  posSupportMaterial       normal/tree support (src/libslic3r/Support/)
  posDetectOverhangsForLift
  posSimplify*             path simplification

Print steps (per plate, global):
  psWipeTower(=psToolOrdering) → psSkirtBrim → psGCodeExport → psConflictCheck
```

### 8.2 G-code generation (GCode.cpp + src/libslic3r/GCode/)

Path ordering (ShortestPath), seam placement (SeamPlacer — including the scarf joint), retraction/wipe,
CoolingBuffer (fan/speed based on layer time), PressureEqualizer, AdaptivePA (pressure advance interpolation),
SpiralVase, FanMover, WipeTower, custom G-code substitution via PlaceholderParser, and ConflictChecker.

**Implementation-level detail on path calculation is in [reverse_engineering/SPECS.md §6](reverse_engineering/SPECS.md)** —
the ExtrusionEntity data model, the Flow cross-section -> E value math, classic/Arachne wall generation, nearest-neighbor chaining and
seam splitting, travel/retraction decisions, the speed priority at emission time, and the definitive order of the TBB post-processing pipeline.
(spiral→pressure_equalizer→cooling→fan_mover→PA).

### 8.3 PlaceholderParser (the custom G-code template language)

[PlaceholderParser.cpp](../slicer/src/libslic3r/PlaceholderParser.cpp) — a boost::spirit grammar.
`{...}` expressions, `{if cond}...{elsif}...{else}...{endif}` (measured: lines 2177-2206),
vector indexing `nozzle_diameter[0]`, arithmetic/comparison/regex matching.
**It is used in two places**: (1) the custom G-code slots (2) the preset `compatible_printers_condition`.
On the web, implementing the expression evaluator once (a few hundred lines) covers both uses.

---

## 9. G-code processing and preview

### 9.1 GCodeProcessor (src/libslic3r/GCode/GCodeProcessor.cpp)

G-code text → `GCodeProcessorResult` (GCodeProcessor.hpp:178):
an array of `MoveVertex` (type/position/width/height/speed/fan/temperature/flow/extruder), a time estimate
(simulating the printer's acceleration model), filament usage and SettingsIds.
**Because the input is text it is completely decoupled from the UI** — it can be ported to WASM/JS on its own.

### 9.2 libvgcode (src/libvgcode/) — the preview renderer

A **standalone library** whose public API is organized into 6 headers:
`Viewer::init(gl_version) / load(GCodeInputData&&) / reset()`,
`get_layers_zs / get_extrusion_roles / get_layers_estimated_times` (Viewer.hpp).
GCodeViewer.hpp:246 delegates to it through `libvgcode::Viewer m_viewer`.

- View coloring modes (measured at GCodeViewer.cpp:73-95): Feature type, Layer Height, Line Width,
  Speed, **Actual Speed**, Fan Speed, Temperature, Flow, **Actual Flow**, Tool, Filament
- 20 ExtrusionRoles (ExtrusionEntity.hpp:20-43): Perimeter, ExternalPerimeter,
  OverhangPerimeter, InternalInfill, SolidInfill, TopSolidInfill, BottomSurface, Ironing,
  BridgeInfill, InternalBridgeInfill, GapFill, Skirt, Brim, SupportMaterial(+Interface,
  Transition), WipeTower, Custom, Mixed
- Interaction: dual sliders, vertical (layers) + horizontal (moves), move tooltips, option markers (retraction/seam/tool change)

Being OpenGL based (with ES-compatible shaders) makes it **the module that ports most easily to WebGL2**. First in line for WASM.

---

## 10. npm packaging strategy

### 10.1 Strategic decision: 3 tracks

| Track | Content | Rationale |
|---|---|---|
| **A. Data/schema — native JS** | settings schema, presets, 3MF, the expression evaluator, the UI | No C++ needed. Upstream is "data + declarations", so extraction is the right answer |
| **B. Viewer — WASM (small)** | libvgcode + GCodeProcessor | Self-contained, small and GL based, so it suits WASM |
| **C. Slicing core — dual approach** | First: run the existing CLI on a server (`orca-slicer --slice`, OrcaSlicer.cpp:5651) / second: libslic3r in WASM | The CLI works today. WASM is a separate large project of removing TBB/CGAL/OCCT |

### 10.2 Proposed package layout (monorepo)

```
@orca/config-schema     828-option metadata JSON + types (d.ts generated)      [extracted]
@orca/ui-map            the Tab page/group/option tree JSON + the toggle rule table  [extracted + manual]
@orca/presets           vendor profile loader + inherits resolution + compatibility filter  [~500 lines of JS]
@orca/expr              the PlaceholderParser expression evaluator                    [~800 lines of JS]
@orca/3mf               3MF read/write (zip.js) + the TriangleSelector codec        [JS]
@orca/gcode             GCodeProcessor in WASM or ported to JS (parser + time estimate) [WASM/JS]
@orca/viewer            libvgcode WASM + a three.js/WebGL2 wrapper                  [WASM]
@orca/slicer            slicing: a cli-server driver (first) / core-wasm (second)   [Node/WASM]
@orca/react-ui          the settings form generator + plater UI (optional)          [new]
```

Dependency direction: `react-ui → ui-map → config-schema`, `presets → expr`, `slicer → everything`.
Node-only (@orca/slicer cli mode) and browser-shared code are separated with `exports` conditions.

### 10.3 Landmines to know about when building for WASM

> **Measured setup (macOS, verified 2026-07-23)**: after `brew install emscripten binaryen`, two traps —
> (1) with the system python3 (3.9) emcc fails an assert -> `export EMSDK_PYTHON=/opt/homebrew/bin/python3.14`
> (2) the auto-generated config picks up Xcode clang (which has no WASM backend) -> in `libexec/.emscripten`
> `LLVM_ROOT='/opt/homebrew/opt/emscripten/libexec/llvm/bin'`,
> set `BINARYEN_ROOT='/opt/homebrew/opt/emscripten/libexec/binaryen'` manually.
> Confirm the smoke test (emcc -> run under node) passes before proceeding.
> Clipper1 lives in [deps_src/clipper/](../slicer/deps_src/clipper/) and compiles standalone after patching just 2 Eigen/TBB include lines
> — it is the key dependency of stage 1 of the WASM kernel (progress: reverse_engineering/README.md).

- **TBB**: replace it with emscripten pthreads, or force the `Execution` abstraction layer (src/libslic3r/Execution/) to run sequentially. The latter is realistic for a first build.
- **Boost**: the header-only parts are fine, and spirit (PlaceholderParser) compiles too.
- **CGAL/OpenVDB/OCCT**: only needed for MeshBoolean, Hollow and STEP import -> **exclude them from the compile targets in the first build** (the structure allows separating them with CMake options).
- **wxWidgets/CURL/OpenSSL**: libslic3r does not depend on them — cut them, using link errors to confirm they belong only to the GUI layer.
- pthread WASM -> COOP/COEP headers are mandatory when deploying.

---

## 11. Extraction recipes

> **★ Already executed — the artifacts physically exist in [reverse_engineering/](reverse_engineering/).**
> Regenerate: `python3 reverse_engineering/extract_all.py`. For coverage and limitations see
> [reverse_engineering/README.md](reverse_engineering/README.md).
>
> | Artifact | Content | Recipe |
> |---|---|---|
> | [config-schema.json](reverse_engineering/config-schema.json) | metadata for 907 options (enums 100%, including 27 ratio_over entries) | §11.1 |
> | [ui-tree.json](reverse_engineering/ui-tree.json) | the page -> group -> option tree (11 builders / 34 pages / 587 references) | §11.2 |
> | [toggle-rules.json](reverse_engineering/toggle-rules.json) | 231 enable/disable rules (95% coverage, with the original C++ conditions) | §11.3 |
> | [invalidation-map.json](reverse_engineering/invalidation-map.json) | option -> re-slice step mapping (Print 6 + PrintObject 19 branches) | §2.2 |
> | [SPECS.md](reverse_engineering/SPECS.md) | the 3MF XML spec · painting codec · PlaceholderParser EBNF · shortcut table | §7.2, §8.3 |
>
> **(1) A build-based schema dump — achieved**: [config-schema-builddump.json](reverse_engineering/config-schema-builddump.json)
> (817 options — compiled the real PrintConfig.cpp to WASM and dumped print_config_def directly,
> cross-checked against the regex extraction with [compare_schema.mjs](reverse_engineering/compare_schema.mjs): 0 type mismatches;
> the arithmetic lines up as 907 = 800 shared + 107 CLI-only definitions and 817 = 800 + 17 loop-generated, and the 75-value `filament_type` enum is only obtainable from the build dump).
> What still does not exist (stated honestly): (2) the automatic value-correction rules in `update_print_fff_config`
> (3) the visual spec (colors/screenshots — which requires observing the running app).

### 11.1 Settings schema dump (top priority, half a day)

Do not parse PrintConfig.cpp with regexes (12,688 lines with conditional logic).
The straightforward way is a 30-line dump tool that links libslic3r:

```cpp
// tools/dump_schema.cpp — links libslic3r only
#include "libslic3r/PrintConfig.hpp"
#include <boost/property_tree/json_parser.hpp>
int main() {
    using namespace Slic3r;
    const PrintConfigDef& def = print_config_def;      // the global 828 options
    for (const auto& [key, opt] : def.options) {
        // key, opt.type, opt.label, opt.tooltip, opt.sidetext, opt.category,
        // opt.mode, opt.min/max, opt.enum_values/enum_labels, opt.gui_type,
        // opt.nullable and the default (opt.default_value->serialize()) -> emit as JSON
    }
}
```

CMake: `add_executable(dump_schema tools/dump_schema.cpp); target_link_libraries(dump_schema libslic3r)`.
The artifact is all of `@orca/config-schema`. For i18n, match the label/tooltip msgids from
`localization/i18n/*.po` and extract them separately as language pack JSON.

### 11.2 UI tree dump (Tab.cpp -> JSON)

In Tab.cpp the code is the declaration, so python regexes are enough (the patterns verified in this session):

```
add_options_page\(L\("([^"]+)"\)      → page
new_optgroup\(L\("([^"]*)"\)          → group
append_single_option_line\("([^"]+)"  → option key
```

Iterate by cutting at the `TabPrint::build / TabFilament::build / TabPrinter::build` function boundaries.
Custom widget lines (the G-code editor, the compatible_printers widget, …) need about 20 manual markings.

### 11.3 The toggle rule table (manual, 1-2 days)

Translate the 198 `toggle_field` sites in [ConfigManipulation.cpp](../slicer/src/slic3r/GUI/ConfigManipulation.cpp)
into `{condition → list of disabled fields}` JSON. print/filament/printer are already split by function,
so it is mechanical work.

### 11.4 Preset resolver (JS, the §5.4 algorithm)

Input: copy `resources/profiles/` wholesale (license: the same AGPL family as the main project — verify before distributing).
Load the `<Vendor>.json` index → load sub_path → merge the inherits chain → filter out `instantiation:"false"`
→ evaluate `compatible_printers_condition` with `@orca/expr`.

### 11.5 3MF (JS)

Open it with zip.js/fflate and parse it per the §7.2 entry mapping.
- `project_settings.config` = flat JSON (option key -> value) — a DynamicConfig as-is
- `3dmodel.model` = XML (vertices/triangles/components + the painting attribute strings)
- When writing, **preserve unknown entries byte for byte** (round-trip compatibility with the desktop app)

### 11.6 libvgcode WASM

`src/libvgcode/` already has its own CMakeLists and takes the GL context version as a string
(`Viewer::init(const std::string& opengl_context_version)`), so WebGL2 ("300 es") support is part of the design.
Build it with emscripten `-sUSE_WEBGL2 -sFULL_ES3`; the input (`GCodeInputData`) is assembled
from @orca/gcode's output.

### 11.7 Verification strategy and acceptance criteria (mandatory)

The "done" criteria per package. All defined in an automatable form.

| Package | Acceptance criteria |
|---|---|
| config-schema | The option count matches the 907 snapshot. Every coEnum has enum_values. Spot checks on `layer_height`/`seam_position`/`sparse_infill_pattern` (26 enum values) |
| ui-map | The TabPrint 6 pages, TabFilament 6 pages and TabPrinter page structure match ui-tree.json. Every option key in the tree exists in the schema (0 dangling references) |
| presets | All 66 vendor indexes load successfully. For an arbitrary vendor (e.g. Elegoo), every instantiation=true preset resolves its inherits chain and its `compatible_printers_condition` can be evaluated. Selecting the same preset on the desktop shows a diff of 0 against the on-screen values |
| expr | Unit tests over the grammar cases from the PlaceholderParser source: arithmetic, comparison, `=~` regex, if/elsif/endif, vector indexing, min/max/interpolate_table. 0 parse errors across all (several hundred) compatible conditions in the real profiles |
| 3mf | **Round-trip test**: desktop-saved .3mf → load on the web → save on the web → load on the desktop, with geometry, settings, plates and painting lossless. Confirm unknown entries are byte-preserved |
| painting codec | The SPECS.md §2.3 verification vector (`"4"` = an ENFORCER leaf) plus re-encoding a desktop-produced paint_supports string reproduces the original exactly |
| gcode/viewer | For the same G-code, the layer count, per-role color distribution and time estimate (±1%) match the desktop preview |
| slicer (CLI) | The G-code produced by `orca-slicer --slice` (OrcaSlicer.cpp:5651) and the web-triggered output have a byte diff of 0 (the same binary, so only the wrapping is verified) |

- Reuse the existing test assets: `tests/fff_print`, `tests/libslic3r`, `tests/data` (Catch2).
- Generate the golden files with the desktop CLI, pin them in the repository and compare against them in the web implementation's CI.

---

## 12. Roadmap and difficulty table

| Order | Task | Difficulty | Artifact |
|---|---|---|---|
| 1 | Schema dump tool + config-schema | ★☆☆ | 828-option JSON, d.ts |
| 2 | UI tree dump + ui-map | ★☆☆ | page/group/option JSON |
| 3 | presets + expr (inheritance, compatibility) | ★★☆ | 66 vendor profiles working |
| 4 | Settings form generator (react-ui) | ★★☆ | a settings UI equivalent to the desktop |
| 5 | 3mf reading (model + settings) + a three.js scene | ★★☆ | opening projects |
| 6 | slicer: the CLI server driver | ★☆☆ | real slicing works |
| 7 | gcode + viewer in WASM | ★★★ | web preview |
| 8 | The toggle rule table + reproducing ConfigManipulation | ★★☆ | UI consistency |
| 9 | 3mf writing + the painting codec | ★★★ | round-trip compatibility |
| 10 | libslic3r in WASM (cutting TBB/CGAL) | ★★★★★ | browser-only slicing — **through stage 13 done** ([reverse_engineering/wasm-core/](reverse_engineering/wasm-core/), with 120 invariants checked continuously). **Ported from upstream verbatim**: all of Arachne variable width (the Voronoi skeleton), 5 Fill patterns (the real TPMS gyroid), PressureEqualizer (working effectively with tag integration), Config+PrintConfig (12,688 lines — 817 options generated at runtime), WipeTower (upstream tool change markers), and **the 7,561-line GCodeProcessor itself** (the default time engine). Implemented by the kernel itself: slicing, solid shells, support (grid/tree-lite), raft, gap fill, thin walls, ironing, bridges, the scarf seam, arcs, cooling, multiple objects and multi-material basics. **Permanent exceptions (documented gates, measured)**: full TreeSupport (requires rebuilding the PrintObject object graph — 121 references to m_object) and the CGAL planarity check (native GMP linkage) |

Among the gizmos, painting, mesh booleans and STEP import are deferred until after item 10. Items 1-6 are the MVP —
"open it, configure it and slice it on the web" — and all of them are low risk.

---

## 13. Appendix: index of key files

| Area | File |
|---|---|
| Entry point / CLI | [src/OrcaSlicer.cpp](../slicer/src/OrcaSlicer.cpp) (`--slice`: line 5651) |
| App initialization | [src/slic3r/GUI/GUI_App.cpp](../slicer/src/slic3r/GUI/GUI_App.cpp) (OnInit: 2672) |
| Main window | [src/slic3r/GUI/MainFrame.cpp](../slicer/src/slic3r/GUI/MainFrame.cpp) |
| Work screen | [src/slic3r/GUI/Plater.cpp](../slicer/src/slic3r/GUI/Plater.cpp) (sidebar: 655, slice loop: 8884) |
| Settings UI tree | [src/slic3r/GUI/Tab.cpp](../slicer/src/slic3r/GUI/Tab.cpp) |
| Widget mapping | [src/slic3r/GUI/OptionsGroup.cpp](../slicer/src/slic3r/GUI/OptionsGroup.cpp):41, [Field.cpp](../slicer/src/slic3r/GUI/Field.cpp) |
| Option toggle rules | [src/slic3r/GUI/ConfigManipulation.cpp](../slicer/src/slic3r/GUI/ConfigManipulation.cpp) |
| Option definitions | [src/libslic3r/PrintConfig.cpp](../slicer/src/libslic3r/PrintConfig.cpp), schema: [Config.hpp](../slicer/src/libslic3r/Config.hpp) |
| Model tree | [src/libslic3r/Model.hpp](../slicer/src/libslic3r/Model.hpp) |
| Presets | [src/libslic3r/Preset.cpp](../slicer/src/libslic3r/Preset.cpp), [PresetBundle.cpp](../slicer/src/libslic3r/PresetBundle.cpp) |
| Pipeline | [src/libslic3r/Print.cpp](../slicer/src/libslic3r/Print.cpp), [PrintObject.cpp](../slicer/src/libslic3r/PrintObject.cpp) |
| Background slicing | [src/slic3r/GUI/BackgroundSlicingProcess.cpp](../slicer/src/slic3r/GUI/BackgroundSlicingProcess.cpp) |
| G-code generation | [src/libslic3r/GCode.cpp](../slicer/src/libslic3r/GCode.cpp), [src/libslic3r/GCode/](../slicer/src/libslic3r/GCode/) |
| G-code analysis | [src/libslic3r/GCode/GCodeProcessor.cpp](../slicer/src/libslic3r/GCode/GCodeProcessor.cpp) |
| Preview renderer | [src/libvgcode/](../slicer/src/libvgcode/), [src/slic3r/GUI/GCodeViewer.cpp](../slicer/src/slic3r/GUI/GCodeViewer.cpp) |
| 3MF | [src/libslic3r/Format/bbs_3mf.cpp](../slicer/src/libslic3r/Format/bbs_3mf.cpp) |
| Painting codec | [src/libslic3r/TriangleSelector.cpp](../slicer/src/libslic3r/TriangleSelector.cpp) |
| Template language | [src/libslic3r/PlaceholderParser.cpp](../slicer/src/libslic3r/PlaceholderParser.cpp) |
| undo/redo | [src/slic3r/Utils/UndoRedo.cpp](../slicer/src/slic3r/Utils/UndoRedo.cpp) |
| Calibration | [src/libslic3r/calib.cpp](../slicer/src/libslic3r/calib.cpp) |
| Vendor profiles | [resources/profiles/](../slicer/resources/profiles/) (66 vendors) |
| Shaders | [resources/shaders/110/](../slicer/resources/shaders/110/) |
| Tests | [tests/](tests/) (Catch2; fff_print, libslic3r) |
