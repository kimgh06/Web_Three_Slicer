// three-slicer/wasm, three-slicer/wasm-mt — emscripten 글루(생성물, 3.5MB+).
// ponytail: 여기에 정확한 타입을 쓰지 않는다. 글루는 재빌드 때마다 바뀌고, 공개 API 는
//   three-slicer 의 createSlicer() 다. 직접 쓰는 쪽은 이미 커널 내부를 아는 쪽.
declare const factory: (opts?: Record<string, unknown>) => Promise<any>
export default factory
