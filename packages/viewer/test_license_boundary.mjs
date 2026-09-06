// The license boundary, as a check rather than a document.
//   Run: node packages/viewer/test_license_boundary.mjs
//
// packages/PROVENANCE.md decides which files in this viewer are derived from upstream (OrcaSlicer /
// PrusaSlicer, AGPL) and which are our own. That verdict is what a permissive relicense of the viewer rests
// on, and it is expensive to re-derive: it took reading 299 upstream references across 57 files. Written
// down and nowhere else, it rots — a new port lands, nothing objects, and the verdict is quietly wrong.
//
// So the three things the verdict actually depends on are asserted here:
//   1. the DERIVED list still matches the files on disk (a rename cannot drop a file off it),
//   2. each derived file still says so in its own header (nobody strips the provenance note), and
//   3. no NEW file describes itself as a port without being on the list.
//
// (3) is the one that earns this file. The derived set is four files today; the cost of a permissive
// relicense is exactly the cost of replacing them, and that cost grows silently unless something watches.
//
// What is NOT asserted yet: that the MIT-bound set imports no AGPL. It cannot be — the viewer still reaches
// into `three-slicer/settings` (11 sites) and `three-slicer/data` (2), which is goal G003. MIT_CLEAN below
// holds the files that already pass that bar, and grows as the inversion lands.
import assert from 'node:assert'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, 'src')

/** Derived from upstream — cannot carry a license other than AGPL-3.0-or-later without being replaced.
 *  Each entry names the upstream work, so the reason survives without opening PROVENANCE.md. */
const DERIVED = {
  'core/toolpath_shaders.js': 'libvgcode Segments_Vertex_Shader_ES',
  'core/toolpath_segments.js': 'libvgcode toolpath renderer (SegmentTemplate, ViewerImpl)',
  'scene/toolpath_mesh.js': 'libvgcode SegmentTemplate.cpp VERTEX_DATA',
  'core/toolpath_palette.js': 'libvgcode ColorRange (DEFAULT_RANGES_COLORS, get_color_at)',
}

/** Verified independently authored AND free of AGPL imports today. Grows as G003 lands. */
const MIT_CLEAN = ['core/gcode_parse.js']

/** The machine-readable marker a derived file must carry. Prose is not a reliable signal in either
 *  direction — `toolpath_palette.js` never used the word "port" (its derivation is a copied colour table),
 *  so sniffing for it missed a genuinely derived file. An explicit line cannot be missed or paraphrased. */
const PROVENANCE_MARKER = 'LICENSE-PROVENANCE:'

/** Phrases that mean "this file is a port". Deliberately narrow in two directions, both learned by getting
 *  it wrong: "upstream does the same" is a design citation and cleared 53 files, and bare "verbatim" is
 *  ordinary English about copying files and passing data through — it matched six innocent files
 *  (`copies it verbatim into dist/`, `take them verbatim`, `writes its keys in verbatim`). `\bported`
 *  needs its word boundary too, or it fires inside "imported from". */
const PORT_CLAIM = /(faithful|straight|exact|verbatim)\s+port\b|\bported\s+(as-is|verbatim)\b|\bport\s+of\s+(the\s+)?upstream/i

/** Files that legitimately MENTION a port without being one — a pointer to where the code went. Listed
 *  rather than pattern-matched, so a real port cannot hide behind a plausible-looking sentence. */
const CROSS_REFERENCES = {
  'scene/use_three_scene.js': 'points at toolpath_gpu.js, where the ported toolpath code lives',
}

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

/** Every .js/.jsx under src/, as [relative path, text]. */
const allSources = () => {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(join(src, dir), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), rel)
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx'))
        out.push([rel, readFileSync(join(src, dir, entry.name), 'utf8')])
    }
  }
  walk('.', '')
  return out
}

const sources = allSources()
const stripStrings = (text) => text.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''")

console.log('[license: the derived list matches what is on disk]')
check('sources were found', sources.length > 50, `${sources.length}`)
for (const [path, reason] of Object.entries(DERIVED)) {
  check(`${path} exists`, existsSync(join(src, path)), `derived from ${reason}`)
}

console.log('\n[license: each derived file still admits it in its own header]')
// The header is what a reader (or a future audit) sees first. If a refactor drops it, the file looks clean
//  while still being derived — the exact failure this whole boundary exists to prevent.
for (const path of Object.keys(DERIVED)) {
  if (!existsSync(join(src, path))) continue
  const head = readFileSync(join(src, path), 'utf8').split('\n').slice(0, 8).join('\n')
  check(`${path} carries its ${PROVENANCE_MARKER} marker`, head.includes(PROVENANCE_MARKER))
}

console.log('\n[license: no new file becomes a port without being listed]')
// The derived set is the price of a permissive relicense. It must not grow by accident.
const unlisted = sources
  .filter(([path]) => !(path in DERIVED) && !(path in CROSS_REFERENCES))
  .filter(([, text]) => PORT_CLAIM.test(text) || text.includes(PROVENANCE_MARKER))
  .map(([path]) => path)
check('every self-declared port is on the DERIVED list', unlisted.length === 0,
  unlisted.length ? `unlisted: ${unlisted.join(', ')} — either replace the port or add it to DERIVED (and PROVENANCE.md §2)` : '')

console.log('\n[license: the MIT-bound files import nothing that is not MIT-able]')
for (const path of MIT_CLEAN) {
  const text = stripStrings(readFileSync(join(src, path), 'utf8'))
  const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
  const agpl = imports.filter(spec => spec.startsWith('three-slicer'))
  check(`${path}: no three-slicer import`, agpl.length === 0, agpl.join(' '))
  // A relative import can reach a derived file; resolve each one against the DERIVED paths.
  const dir = dirname(path)
  const reaches = imports
    .filter(spec => spec.startsWith('.'))
    .map(spec => join(dir, spec).replace(/^\.\//, ''))
    .filter(resolved => resolved in DERIVED)
  check(`${path}: reaches no derived file`, reaches.length === 0, reaches.join(' '))
}

console.log('\n[license: the verdict is written down where it can be read]')
const provenance = join(here, '..', 'PROVENANCE.md')
check('packages/PROVENANCE.md exists', existsSync(provenance))
if (existsSync(provenance)) {
  const text = readFileSync(provenance, 'utf8')
  for (const path of Object.keys(DERIVED))
    check(`PROVENANCE.md names ${path}`, text.includes(path.split('/').pop()))
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LICENSE BOUNDARY CHECKS PASSED')
assert.equal(failures, 0)
