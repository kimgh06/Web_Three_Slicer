// Stage-11: node driver for the embind config-probe. Verifies the ported real Config/PrintConfig
// subsystem exposes a sane print_config_def + FullPrintConfig, and writes the build-based schema
// dump to reverse_engineering/config-schema-builddump.json for the config-schema cross-check.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import createConfigProbe from './config_probe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok' : 'FAIL'}: ${m}`); if (!c) fail++; };

const M = await createConfigProbe();

const optCount = M.option_count();
const fpcKeys  = M.full_print_config_keys();
console.log(`[stage11 config port]`);
console.log(`  option_count (print_config_def) = ${optCount}`);
console.log(`  full_print_config_keys          = ${fpcKeys}`);
ok(optCount > 700, `print_config_def option count is substantial (${optCount})`);
ok(fpcKeys  > 500, `FullPrintConfig instantiated with keys (${fpcKeys})`);

// Spot checks (task-specified expected values)
ok(M.default_of('layer_height') === '0.2', `layer_height default == 0.2 (got '${M.default_of('layer_height')}')`);
ok(M.default_of('seam_position') === 'aligned', `seam_position default == aligned (got '${M.default_of('seam_position')}')`);
ok(M.enum_count('sparse_infill_pattern') === 26, `sparse_infill_pattern enum count == 26 (got ${M.enum_count('sparse_infill_pattern')})`);

// A few more sanity spot checks
ok(M.default_of('wall_loops') !== '', `wall_loops has a default ('${M.default_of('wall_loops')}')`);
ok(M.enum_count('seam_position') > 0, `seam_position is an enum (${M.enum_count('seam_position')} values)`);

// Write the build-based schema dump
const dump = M.dump_schema_json();
const parsed = JSON.parse(dump); // validates JSON
const outPath = resolve(__dirname, '../../config-schema-builddump.json');
writeFileSync(outPath, JSON.stringify(parsed, null, 1));
console.log(`  wrote build dump: ${outPath} (${Object.keys(parsed).length} keys)`);
ok(Object.keys(parsed).length === optCount, `dump key count == option_count (${Object.keys(parsed).length})`);

console.log(fail === 0 ? '\nCONFIG PROBE OK' : `\nCONFIG PROBE FAILED (${fail})`);
process.exit(fail === 0 ? 0 : 1);
