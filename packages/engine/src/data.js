// The single import site for the extracted JSON files.
//
// Why funnel them through one module: JSON requires `with { type: 'json' }` in Node 22+ ESM, but
// Vite/esbuild strip that attribute from bundle output (neither build.target nor importAttributesKey
// prevents it — measured). So if the same JSON is pointed at by both "the original with the attribute
// (engine/src/*.js)" and "the bundle without it (components/dist)", the consumer's bundler warns with
// "inconsistent import attributes". Only this file holds the JSON; everything else imports this module
// as external -> no JSON import survives in the bundle, so the mismatch cannot arise.
export { default as schema } from 'three-slicer/data/config-schema.json' with { type: 'json' }
export { default as uiTree } from 'three-slicer/data/ui-tree.json' with { type: 'json' }
export { default as toggleRules } from 'three-slicer/data/toggle-rules.json' with { type: 'json' }
export { default as invalidationMap } from 'three-slicer/data/invalidation-map.json' with { type: 'json' }
export { default as printers } from 'three-slicer/data/printers.json' with { type: 'json' }
// Which option keys belong to which preset type, straight from upstream's Preset.cpp. Small (17KB) and needed by
// anything that writes or reads a preset FILE, so it is static rather than lazy like the two big catalogs.
export { default as presetKeys } from 'three-slicer/data/preset-keys.json' with { type: 'json' }
// processes is the largest artifact (~800 KB) and is only needed once a printer is picked, so it stays a dynamic
// import. It is generated as a JS module rather than JSON precisely because of the attribute problem above, in its
// other direction: a dynamic JSON import needs the attribute in Node, and that same attribute makes browsers
// reject the text/javascript response a dev server gives for .json.
export const loadProcesses = () => import('three-slicer/data/processes.js').then(m => m.default)
// Same story for the filament presets (~540 KB, only needed once a material picker opens).
export const loadFilaments = () => import('three-slicer/data/filaments.js').then(m => m.default)
