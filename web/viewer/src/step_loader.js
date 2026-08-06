// STEP(.step/.stp) 임포트 — occt-import-js(OCCT WASM, LGPL-2.1) 로 BREP 를 테셀레이션한다.
// 패키지(three-slicer)가 아니라 **앱**에 두는 이유: wasm 7.6MB 짜리 의존성이라 커널·뷰어의 "런타임 의존성 0" 을
//  깨지 않기 위해서다. 다른 소비자도 아래 6줄만 흉내내면 같은 방식으로 임의 포맷을 붙일 수 있다.
// 동적 import — .step 을 실제로 열 때만 glue+wasm 을 받는다(초기 번들 영향 0).
import { registerLoader } from 'three-slicer/viewer/loaders'

let occtP = null
const getOcct = () => (occtP ||= (async () => {
  const [{ default: occtimportjs }, { default: wasmUrl }] = await Promise.all([
    import('occt-import-js'),
    import('occt-import-js/dist/occt-import-js.wasm?url'),
  ])
  return occtimportjs({ locateFile: () => wasmUrl })
})())

registerLoader('step,stp', async (buffer, name) => {
  const occt = await getOcct()
  const r = occt.ReadStepFile(new Uint8Array(buffer), null)   // null = 기본 테셀레이션 편차
  if (!r?.success) throw new Error('STEP 파싱 실패')

  // occt 결과: meshes[].attributes.position.array(Float32, 정점) + index.array(삼각형 인덱스).
  //  좌표계는 파일 원좌표 — STEP 은 CAD 관례상 z-up mm 이라 STL/3MF 와 동일하게 그대로 쓴다.
  const out = []
  for (const m of r.meshes || []) {
    const pos = m.attributes?.position?.array, idx = m.index?.array
    if (!pos || !idx || idx.length < 3) continue
    const tris = new Float32Array(idx.length * 3)
    for (let i = 0; i < idx.length; i++) {
      const o = idx[i] * 3
      tris[i * 3] = pos[o]; tris[i * 3 + 1] = pos[o + 1]; tris[i * 3 + 2] = pos[o + 2]
    }
    out.push({ name: r.meshes.length > 1 ? `${name}#${out.length + 1}` : name, modelPos: tris })
  }
  return out
})
