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
import { dirname, join, resolve, sep } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
// The viewer's source lives in the permissive package now; what is left beside this test is the AGPL residue
//  (the slicing hook, the kernel worker factory, the bundled catalog and three re-export shims).
const src = join(here, '..', '..', 'packages-mit', 'src')

/** Derived from upstream — cannot carry a license other than AGPL-3.0-or-later without being replaced.
 *  Each entry names the upstream work, so the reason survives without opening PROVENANCE.md. */
const DERIVED = {
  // EMPTY, as of the toolpath rewrite. The four libvgcode-derived files (toolpath_shaders, toolpath_segments,
  //  toolpath_mesh, toolpath_palette) were reimplemented from viewer/TOOLPATH_SPEC.md — a functional
  //  contract written from the published types, the consumers and a recorded run, with no upstream
  //  reference. They are listed under MIT_CLEAN below instead.
  //
  //  An entry belongs here the moment any file becomes a port again. The check below is what notices.
}

/** Files still inside the AGPL viewer that are verified clean and are candidates for a later move.
 *  The toolpath and G-code modules are no longer here — they SHIPPED, to packages-mit/. */
const MIT_CLEAN = ['core/gcode_parse.js', 'core/plate_layout.js', 'core/toolpath_segments.js']

/** The permissive package. This is where the boundary actually is now: everything under it must be
 *  installable and usable with no AGPL anywhere in its dependency tree. */
const PERMISSIVE = join(here, '..', '..', 'packages-mit')

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
// Comments are dropped before an import scan, never string literals: an import path IS a string literal, and
//  the version that stripped them saw an empty list and passed everything (it let `three-slicer/settings`
//  through in use_slicer.js after the hook moved).
const dropComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const isAgpl = (spec) => spec === 'three-slicer' || spec.startsWith('three-slicer/')

console.log('[license: the derived list matches what is on disk]')
check('sources were found', sources.length > 50, `${sources.length}`)
for (const [path, reason] of Object.entries(DERIVED)) {
  check(`${path} exists`, existsSync(join(src, path)), `derived from ${reason}`)
}
if (Object.keys(DERIVED).length === 0)
  console.log('  ok: nothing in this viewer is currently derived from upstream')

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
  const text = dropComments(readFileSync(join(src, path), 'utf8'))
  const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1])
  const agpl = imports.filter(isAgpl)
  check(`${path}: no three-slicer import`, agpl.length === 0, agpl.join(' '))
  // A relative import can reach a derived file; resolve each one against the DERIVED paths.
  const dir = dirname(path)
  const reaches = imports
    .filter(spec => spec.startsWith('.'))
    .map(spec => join(dir, spec).replace(/^\.\//, ''))
    .filter(resolved => resolved in DERIVED)
  check(`${path}: reaches no derived file`, reaches.length === 0, reaches.join(' '))
}

console.log('\n[license: the permissive package carries no AGPL]')
// The split only means something if this holds. A single import of the AGPL package from here would make the
//  permissive tarball a combined work, and the MIT grant on it would be one nobody had the right to give.
if (!existsSync(PERMISSIVE)) {
  check('packages-mit exists', false, 'the permissive package is missing')
} else {
  const manifest = JSON.parse(readFileSync(join(PERMISSIVE, 'package.json'), 'utf8'))
  check('declares a permissive license', manifest.license === 'MIT', manifest.license)
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies }
  const agplDeps = Object.keys(deps).filter(name => name === 'three-slicer' || name.startsWith('three-slicer/'))
  check('depends on nothing AGPL', agplDeps.length === 0, agplDeps.join(' '))

  // Every surface a reverse dependency could ride in on, not only .js/.jsx: type-only imports in .d.ts, CSS
  //  @import/url(), string values in JSON, and worker URLs. The reviewer of the split named each of these as a
  //  gap; the negative tests below plant one of each.
  const permissiveSources = []
  const walkPermissive = (dir, prefix) => {
    for (const entry of readdirSync(join(PERMISSIVE, dir), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'dist') walkPermissive(join(dir, entry.name), rel) }
      else if (/\.(jsx?|mjs|ts|css|json)$/.test(entry.name))
        permissiveSources.push([rel, readFileSync(join(PERMISSIVE, dir, entry.name), 'utf8')])
    }
  }
  for (const top of ['src', 'types', 'data']) if (existsSync(join(PERMISSIVE, top))) walkPermissive(top, top)
  permissiveSources.push(['styles.css', readFileSync(join(PERMISSIVE, 'styles.css'), 'utf8')])
  check('has sources', permissiveSources.length > 0, `${permissiveSources.length}`)
  // A `// from 'three-slicer/x'` in prose cannot trip this (comments dropped); the negative test pins both directions.
  for (const [rel, text] of permissiveSources) {
    const code = dropComments(text)
    // import/export … from, dynamic import(), require(), type-only imports (same syntax), worker URLs, and
    //  CSS @import / url(). JSON has no comments, so every string value is a candidate.
    const specs = rel.endsWith('.json')
      ? [...code.matchAll(/"((?:three-slicer)[^"]*)"/g)].map(m => m[1])
      : [...code.matchAll(/(?:from|import|require|new\s+URL|@import|url)\s*\(?\s*['"]([^'"]+)['"]/g)].map(m => m[1])
    const bad = specs.filter(isAgpl)
    check(`${rel}: imports no AGPL package`, bad.length === 0, bad.join(' '))
    const escapes = specs.filter(spec => spec.startsWith('.') && !resolve(join(PERMISSIVE, dirname(rel)), spec).startsWith(PERMISSIVE + sep))
    check(`${rel}: reaches nothing outside the package`, escapes.length === 0, escapes.join(' '))
  }
  // What SHIPS is dist/, not src/: a source import that the bundler resolves gets inlined, and only tree-shaking
  //  stood between an AGPL import in use_slicer.js and an AGPL bundle. So the built output is scanned too —
  //  skipped, not failed, when there is no build to scan.
  const dist = join(PERMISSIVE, 'dist')
  if (existsSync(dist)) {
    for (const name of readdirSync(dist).filter(n => n.endsWith('.js'))) {
      const built = readFileSync(join(dist, name), 'utf8')
      const specs = [...built.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(m => m[1])
      const bad = specs.filter(isAgpl)
      const inlined = /slicer_core|printers\.sets|loadProcesses|loadFilaments/.test(built)
      check(`dist/${name}: no AGPL import and no inlined kernel or catalog code`, bad.length === 0 && !inlined,
        bad.join(' ') || (inlined ? 'AGPL code was bundled in' : ''))
    }
  } else console.log('  skip: packages-mit/dist not built — the shipped bundle was not scanned')

  // The pair is published together (packages/RELICENSE.md section 3); a mismatch here would publish a
  //  combination nobody built.
  const agpl = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  check('versions are a locked pair', agpl.version === manifest.version, `${agpl.version} vs ${manifest.version}`)
  check('the AGPL package pins it exactly', agpl.dependencies?.[manifest.name] === manifest.version,
    String(agpl.dependencies?.[manifest.name]))
}

console.log('\n[license: the verdict is written down where it can be read]')
const provenance = join(here, '..', 'PROVENANCE.md')
check('packages/PROVENANCE.md exists', existsSync(provenance))
if (existsSync(provenance)) {
  const text = readFileSync(provenance, 'utf8')
  for (const path of Object.keys(DERIVED))
    check(`PROVENANCE.md names ${path}`, text.includes(path.split('/').pop()))
  check('PROVENANCE.md records the rewrite', text.includes('TOOLPATH_SPEC'),
    'section 2 should point at the spec the replacement was written from')
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL LICENSE BOUNDARY CHECKS PASSED')
assert.equal(failures, 0)
