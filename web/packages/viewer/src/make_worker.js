// 슬라이서 워커 생성 — 이 파일은 번들되지 않고 dist/ 에 원형 복사된다 (build 스크립트).
// 이유: 소비자 번들러(Vite/webpack)가 워커를 청크로 인식하려면 `new Worker(new URL('리터럴', import.meta.url))`
// 정적 패턴이 소비자에게 보이는 파일에 그대로 남아 있어야 한다. viewer 자체 lib 빌드가 이걸 처리하면
// 사이트 루트 기준 절대경로 자산으로 굳어져 소비자 앱에서 404 가 난다.
// 경로 '../../engine/…' 은 dist/ 기준: 모노레포(packages/viewer/dist→packages/engine)와
// npm 설치(@three-slicer/ 스코프 형제 디렉토리) 양쪽에서 engine 패키지로 해석된다.
export function makeSlicerWorker() {
  return new Worker(new URL('../../engine/src/slicer.worker.js', import.meta.url), { type: 'module' })
}
