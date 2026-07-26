// Stage-11 schema cross-check: compares the build-based dump of print_config_def
// (config-schema-builddump.json, emitted by the WASM config probe — ground truth) against the
// regex-extracted config-schema.json. Reports key-set differences and, for shared keys, field-level
// mismatches in type / default / enum_values. Run: `node reverse_engineering/compare_schema.mjs`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const regex = JSON.parse(readFileSync(resolve(here, 'packages/data/config-schema.json'), 'utf8'));
const build = JSON.parse(readFileSync(resolve(here, 'packages/data/config-schema-builddump.json'), 'utf8'));

const rk = new Set(Object.keys(regex));
const bk = new Set(Object.keys(build));
const onlyRegex = [...rk].filter(k => !bk.has(k)).sort();
const onlyBuild = [...bk].filter(k => !rk.has(k)).sort();
const common    = [...bk].filter(k => rk.has(k)).sort();

const norm = v => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v).trim();
};
// numeric-tolerant equality for defaults
const defEqual = (a, b) => {
  const na = norm(a), nb = norm(b);
  if (na === nb) return true;
  const fa = parseFloat(na), fb = parseFloat(nb);
  if (!Number.isNaN(fa) && !Number.isNaN(fb) && Math.abs(fa - fb) < 1e-9) return true;
  // comma vectors: compare first element numerically ("0.4,0.4" vs "0.4")
  const first = s => String(s).split(',')[0].trim();
  const ffa = parseFloat(first(na)), ffb = parseFloat(first(nb));
  if (!Number.isNaN(ffa) && !Number.isNaN(ffb) && Math.abs(ffa - ffb) < 1e-9) return true;
  return false;
};

const typeMismatch = [], defaultMismatch = [], enumMismatch = [];
for (const k of common) {
  const r = regex[k], b = build[k];
  if (r.type && b.type && r.type !== b.type) typeMismatch.push({ k, regex: r.type, build: b.type });
  // default: regex has .default; build has .default (serialized string)
  if (r.default !== undefined && b.default !== undefined && b.default !== null && !defEqual(r.default, b.default))
    defaultMismatch.push({ k, regex: r.default, build: b.default });
  // enum_values: compare as sets when both present
  const rev = r.enum_values || [], bev = b.enum_values || [];
  if (rev.length || bev.length) {
    const rs = new Set(rev), bs = new Set(bev);
    const missing = [...bs].filter(x => !rs.has(x)); // in build, not regex
    const extra   = [...rs].filter(x => !bs.has(x)); // in regex, not build
    if (missing.length || extra.length) enumMismatch.push({ k, count_regex: rev.length, count_build: bev.length, in_build_not_regex: missing, in_regex_not_build: extra });
  }
}

console.log('=== SCHEMA CROSS-CHECK: build print_config_def (ground truth) vs regex config-schema.json ===\n');
console.log(`regex keys: ${rk.size}   build keys: ${bk.size}   common: ${common.length}\n`);

console.log(`--- ${onlyRegex.length} keys ONLY in regex (not in print_config_def) ---`);
console.log('These are CLI actions/transform/misc defs (separate cli_*_config_def globals) + placeholder-parser');
console.log('runtime read-only vars, which the regex extractor swept up from PrintConfig.cpp but which are NOT');
console.log('part of print_config_def:');
console.log('  ' + onlyRegex.join(', ') + '\n');

console.log(`--- ${onlyBuild.length} keys ONLY in build (in print_config_def, missed by regex) ---`);
console.log('Loop-generated filament_* retraction overrides (init_filament_option_keys / extruder_option_keys loop):');
console.log('  ' + onlyBuild.join(', ') + '\n');

console.log(`--- ${typeMismatch.length} TYPE mismatches (shared keys) ---`);
for (const m of typeMismatch) console.log(`  ${m.k}: regex=${m.regex} build=${m.build}`);
console.log();

console.log(`--- ${defaultMismatch.length} DEFAULT mismatches (shared keys, numeric-tolerant) ---`);
for (const m of defaultMismatch) console.log(`  ${m.k}: regex=${JSON.stringify(m.regex)} build=${JSON.stringify(m.build)}`);
console.log();

console.log(`--- ${enumMismatch.length} ENUM_VALUES mismatches (shared keys) ---`);
for (const m of enumMismatch) console.log(`  ${m.k}: regex(${m.count_regex}) build(${m.count_build}) in_build_not_regex=[${m.in_build_not_regex}] in_regex_not_build=[${m.in_regex_not_build}]`);
console.log();

console.log('=== SUMMARY ===');
console.log(`only_regex=${onlyRegex.length} only_build=${onlyBuild.length} type_mismatch=${typeMismatch.length} default_mismatch=${defaultMismatch.length} enum_mismatch=${enumMismatch.length}`);
