// 추출 JSON 4종의 유일한 import 지점.
//
// 왜 한 군데로 모으는가: JSON 은 Node 22+ ESM 에서 `with { type: 'json' }` 이 필수인데,
// Vite/esbuild 는 번들 출력에서 이 attribute 를 떼어낸다(build.target·importAttributesKey 로
// 막을 수 없음 — 실측). 그래서 같은 JSON 을 "attribute 있는 원본(engine/src/*.js)" 과
// "attribute 없는 번들(components/dist)" 이 동시에 가리키면 소비자 번들러가
// "inconsistent import attributes" 로 경고한다. 여기 한 곳만 JSON 을 잡고 나머지는
// 이 모듈을 external 로 import → 번들에 JSON import 자체가 남지 않아 불일치가 성립하지 않는다.
export { default as schema } from 'three-slicer/data/config-schema.json' with { type: 'json' }
export { default as uiTree } from 'three-slicer/data/ui-tree.json' with { type: 'json' }
export { default as toggleRules } from 'three-slicer/data/toggle-rules.json' with { type: 'json' }
export { default as invalidationMap } from 'three-slicer/data/invalidation-map.json' with { type: 'json' }
