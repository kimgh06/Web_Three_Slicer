// Printer profiles for vendors upstream does not ship (data/printers-vendor.json).
//
// The thing this guards is provenance. printers.json is regenerated in full by web/extract_all.py, so a profile
// added there by hand disappears on the next run — these live in a separate file and are merged at load. The merge
// is where it can go quietly wrong: a mis-shaped row writes values into the wrong columns (a bed size landing on a
// jerk limit), and an "absent" value that arrives as 0 tells the kernel the machine cannot accelerate.
//   run: node packages/engine/test_vendor_printers.mjs
import { printers, vendorPrinters } from './src/data.js'
import { printersByVendor, printerSettings, printerKeys, deriveKernelParams } from './src/settings.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok: ${label}`)
  else { console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); failures++ }
}

const PROFILE = 'STELLAMOVE FA550 0.4 nozzle'

console.log('\n[vendor printers: the merge]')
check('the vendor file is separate from the extracted one', !printers.byVendor.STELLAMOVE)
check('...and the merged view carries it', !!printersByVendor.STELLAMOVE?.[PROFILE])
check('every extracted vendor survives the merge',
  Object.keys(printers.byVendor).every(vendor => vendor in printersByVendor),
  `${Object.keys(printers.byVendor).length} extracted vs ${Object.keys(printersByVendor).length} merged`)
// The merge appends rows and indexes into the combined array; an off-by-one here would hand every upstream
//  profile the wrong machine.
check('an upstream profile still resolves to its own bed',
  JSON.stringify(printerSettings('Cubicon xCeler-I 0.4 nozzle')?.printable_area)
    === JSON.stringify([[0, 0], [250, 0], [250, 250], [0, 250]]))

console.log('\n[vendor printers: only what the vendor published]')
const settings = printerSettings(PROFILE)
check('the profile resolves', !!settings)
check('the published bed is exact', JSON.stringify(settings.printable_area)
  === JSON.stringify([[0, 0], [550, 0], [550, 550], [0, 550]]))
check('the published height is exact', settings.printable_height === 500)
check('the published nozzle is exact', JSON.stringify(settings.nozzle_diameter) === JSON.stringify([0.4]))
check('the published max speed is exact', JSON.stringify(settings.machine_max_speed_x) === JSON.stringify([500]))
// The spec sheet gives no acceleration. Absent means the kernel default applies; 0 would mean "cannot accelerate"
//  and would wreck every time estimate the profile produces.
check('an unpublished key is ABSENT, not zero', !('machine_max_acceleration_x' in settings))
check('...and not null either', settings.machine_max_acceleration_x === undefined)
check('every key it does set is a real printer key',
  Object.keys(settings).every(key => printerKeys.includes(key)),
  Object.keys(settings).filter(key => !printerKeys.includes(key)).join(' '))

console.log('\n[vendor printers: it reaches the kernel]')
const params = deriveKernelParams(settings)
check('the bed reaches the kernel', params.bed_width === 550 && params.bed_depth === 550)
check('the printable height reaches the kernel', params.printable_height === 500)
check('the published speed reaches the kernel', params.machine_max_speed_xy === 500)
// Not asserting a value: only that the kernel HAS one, i.e. the omission fell through to a default rather than
//  leaving the estimator without a limit.
check('an unpublished limit still arrives as a default', Number.isFinite(params.machine_max_accel_xy))

console.log('\n[vendor printers: the file itself]')
for (const [vendor, bundle] of Object.entries(vendorPrinters.vendors)) {
  for (const [name, entry] of Object.entries(bundle.models)) {
    check(`${name}: every setting key is a printer key`,
      Object.keys(entry.settings).every(key => printerKeys.includes(key)),
      Object.keys(entry.settings).filter(key => !printerKeys.includes(key)).join(' '))
    // Written down so a vendor conversation has an agenda, and so nobody reads absence as "not applicable".
    check(`${name}: records what is still unpublished`, Array.isArray(entry.unpublished) && entry.unpublished.length > 0)
    check(`${name}: names where the numbers came from`, typeof bundle.source === 'string' && bundle.source.length > 0)
  }
}

console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : '\nALL VENDOR-PRINTER CHECKS PASSED\n')
process.exit(failures ? 1 : 0)
