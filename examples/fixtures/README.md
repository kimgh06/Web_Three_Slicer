# fixtures

데모가 쓰는 샘플 모델. 전부 이 저장소에서 자체 생성한 것이며 외부 마켓플레이스 모델은 포함하지
않는다. 라이선스는 저장소와 같다 (AGPL-3.0-or-later).

각 데모는 저장소 밖으로 복사해도 동작해야 하므로 (DEMOS.md §11) 필요한 fixture를 자기
`public/` 아래에 복사해 둔다. 이 디렉터리가 원본이다.

| 파일 | 내용 | 생성 방법 |
| --- | --- | --- |
| `calibration-cube.stl` | 20 × 20 × 20 mm 정육면체, 12 facet, 684 B | 아래 스크립트 |

```bash
node -e '
const S=10, corners=[[-S,-S,0],[S,-S,0],[S,S,0],[-S,S,0],[-S,-S,2*S],[S,-S,2*S],[S,S,2*S],[-S,S,2*S]]
const faces=[[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]]
const view=new DataView(new ArrayBuffer(84+faces.length*50)); view.setUint32(80,faces.length,true)
faces.forEach(([a,b,c],t)=>{const o=84+t*50, A=corners[a],B=corners[b],C=corners[c]
  const u=[B[0]-A[0],B[1]-A[1],B[2]-A[2]], v=[C[0]-A[0],C[1]-A[1],C[2]-A[2]]
  const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]], L=Math.hypot(...n)||1
  n.forEach((x,i)=>view.setFloat32(o+i*4,x/L,true))
  ;[A,B,C].flat().forEach((x,i)=>view.setFloat32(o+12+i*4,x,true))})
require("fs").writeFileSync("calibration-cube.stl",Buffer.from(view.buffer))'
```

## 아직 없는 것

DEMOS.md §3이 요구하는 나머지 fixture는 해당 데모를 구현할 때 만든다.

| 파일 | 필요한 데모 | 만드는 방법 |
| --- | --- | --- |
| `benchy-small.stl` | instant-quote (중간 크기 슬라이스) | 자체 제작 모델 — 외부 Benchy 파일을 그대로 넣지 않는다 |
| `multi-object.3mf` | printer-showcase, farm-dashboard | 뷰어에서 객체 여러 개 배치 후 프로젝트 저장 |
| `multi-color.3mf` | marketplace | 뷰어에서 페인팅 후 프로젝트 저장 |
| `multi-plate.3mf` | marketplace | 뷰어에서 플레이트 2장 구성 후 프로젝트 저장 |
