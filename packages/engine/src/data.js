// The single import site for the 4 extracted JSON files.
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
