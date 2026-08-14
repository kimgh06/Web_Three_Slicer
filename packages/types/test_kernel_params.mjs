// Guards the kernel-parameter reference in engine/README.md.
//
// Two failure modes, both silent without this: the kernel gains a parameter and the table stops being the full
// contract, or a parameter stops being reachable from a setting and nothing tells a reader what it now is. The
// table itself is generated, so the first is a staleness check; the second needs the prose classification below
// the table to keep naming every unreachable parameter.
//   run: node packages/types/test_kernel_params.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

console.log('\n[kernel params: the table is current]')
try {
  execFileSync(process.execPath, [join(here, 'gen_kernel_params.mjs'), '--check'], { stdio: 'pipe' })
  check('engine/README.md matches the generator', true)
} catch (err) {
  check('engine/README.md matches the generator', false,
    String(err.stderr ?? err.message).trim() || 'run `node packages/types/gen_kernel_params.mjs`')
}

console.log('\n[kernel params: every unreachable parameter is classified]')
const readme = readFileSync(join(here, '..', 'engine', 'README.md'), 'utf8')
const table = readme.slice(readme.indexOf('KERNEL-PARAMS:BEGIN'), readme.indexOf('KERNEL-PARAMS:END'))
const rows = [...table.matchAll(/^\| `([a-z0-9_]+)` \|[^|]*\|[^|]*\| (—|`[^|]*) \|/gm)]
const unreachable = rows.filter(row => row[2] === '—').map(row => row[1])

check('the table has rows', rows.length > 100, `${rows.length} rows`)
check('some parameters are reachable only by hand', unreachable.length > 0)

// The prose section lives BELOW the generated block, so it is hand-written and can fall behind on purpose-built
//  additions. Every `—` row has to appear in it by name.
// Bounded at the next top-level heading: the sections after it discuss reachable parameters by name
//  (`support_filament` under Materials), which the reverse check below would otherwise read as a stale claim.
const proseStart = readme.indexOf('### The parameters no setting reaches')
const proseEnd = readme.indexOf('\n## ', proseStart)
const prose = readme.slice(proseStart, proseEnd < 0 ? undefined : proseEnd)
const unclassified = unreachable.filter(key => !prose.includes(`\`${key}\``))
check('every `—` parameter is named in "The parameters no setting reaches"',
  unclassified.length === 0, unclassified.join(' '))

// The reverse: a parameter that becomes reachable should leave the prose, or the prose claims you cannot set
//  something you now can.
const reachable = new Set(rows.filter(row => row[2] !== '—').map(row => row[1]))
const stale = [...prose.matchAll(/`([a-z0-9_]+)`/g)].map(m => m[1]).filter(key => reachable.has(key))
check('the prose names no parameter that a setting now reaches', stale.length === 0, [...new Set(stale)].join(' '))

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL KERNEL-PARAM CHECKS PASSED\n')
process.exit(failures ? 1 : 0)
