// 슬라이스를 메인 스레드 밖에서 실행 (UI 논블록) + 30단계 레이어 스트리밍.
// Vite module worker: new Worker(new URL('./slicer.worker.js', import.meta.url), { type: 'module' }).
// SINGLE_FILE 이라 slicer_core.js 안에 wasm 이 인라인 → worker 에서도 외부 fetch 없음.
//
// 30단계(OOM 내성): set_layer_sink 로 커널이 레이어를 만드는 대로 방출받아 즉시 메인으로 transfer 하고
//  (Float32Array 버퍼 이전 → worker 사본 즉시 해제) 커널은 그 레이어 버퍼를 힙에서 해제한다. 결과 상주
//  (전체 gw.s + 전체 layersArr)가 사라져 WASM 힙 피크가 급감 → 대형 모델 OOM 회피. 최종 'done' 은 stats 만.
//  절약 모드(params.economy)면 툴패스 없이 g-code 청크만 방출(프리뷰 없이 완주). MM/실PE 경로는 배치 폴백.
import createSlicer from './slicer_core.js'

let modPromise = null

self.onmessage = async (e) => {
  const d = e.data
  try {
    if (!modPromise) modPromise = createSlicer()
    const Module = await modPromise
    // 20단계: 수동 서포트 페인팅 — selector 상태는 이 worker Module 에 지속(슬라이스도 같은 Module).
    if (d.cmd === 'prepare') { Module.selector_prepare(new Uint8Array(d.stl)); self.postMessage({ type: 'prepared', facets: Module.selector_facet_count() }); return }
    if (d.cmd === 'paint')   { Module.selector_paint(d.facet, d.hx, d.hy, d.hz, d.cx, d.cy, d.cz, d.radius, d.enforcer);
                               self.postMessage({ type: 'painted', enf: Module.selector_painted_count(true), blk: Module.selector_painted_count(false) }); return }
    if (d.cmd === 'clear')   { Module.selector_clear(); self.postMessage({ type: 'painted', enf: 0, blk: 0 }); return }
    if (d.cmd === 'overlay')  { self.postMessage({ type: 'overlay', enf: Array.from(Module.selector_overlay(true)), blk: Array.from(Module.selector_overlay(false)) }); return }

    if (d.stall) return   // 30단계 테스트 훅: 무응답(행) 시뮬 → 메인 워치독 발동 검증(프로덕션 미설정)
    // 기본: 슬라이스. 레이어 싱크 등록 → 커널이 레이어마다 콜백(z, idx, gcodeChunk, pathsF32, widthsF32).
    //  각 레이어를 즉시 메인으로 transfer(툴패스 버퍼 이전) → worker 사본 해제 → 다음 레이어 전 힙 여유.
    const onProgress = (done, total) => self.postMessage({ type: 'progress', done, total })
    Module.set_layer_sink((z, idx, gcode, paths, widths) => {
      const transfer = []
      if (paths && paths.buffer) transfer.push(paths.buffer)     // 절약 모드는 빈 배열(.buffer 없음) → 미이전
      if (widths && widths.buffer) transfer.push(widths.buffer)
      self.postMessage({ type: 'layer', z, idx, gcode, paths, widths }, transfer)
    })
    let r
    try { r = Module.slice(new Uint8Array(d.stl), d.params, onProgress) }
    finally { Module.clear_layer_sink() }
    if (r && r.error) { self.postMessage({ type: 'error', error: String(r.error) }); return }
    // streamed=true → g-code/layers 는 'layer' 로 이미 방출됨(result 엔 stats 만). batch/MM 는 result 에 그대로.
    self.postMessage({ type: 'done', result: r })
  } catch (err) {
    // WASM abort("memory access out of bounds") 포함 — 메인의 OOM 사다리가 재생성/절약 재시도 판정.
    self.postMessage({ type: 'error', error: String((err && err.message) || err) })
  }
}
