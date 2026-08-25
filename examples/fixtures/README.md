# fixtures

Sample models the demos use. All of them are generated inside this repository — no external marketplace
models are included. Licensed the same as the repository (AGPL-3.0-or-later).

Each demo has to work when copied out of the repository (DEMOS.md §11), so it copies the fixtures it
needs under its own `public/`. This directory is the source of truth.

| File | Contents | How it is made |
| --- | --- | --- |
| `calibration-cube.stl` | 20 × 20 × 20 mm cube, 12 facets, 684 B | the script below |

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

## Not here yet

The remaining fixtures DEMOS.md §3 calls for are made when the demo that needs them is implemented.

| File | Demo that needs it | How to make it |
| --- | --- | --- |
| `benchy-small.stl` | instant-quote (a medium-size slice) | a model of our own — no external Benchy file is dropped in as-is |
| `multi-object.3mf` | printer-showcase, farm-dashboard | arrange several objects in the viewer, save the project |
| `multi-color.3mf` | marketplace | paint in the viewer, save the project |
| `multi-plate.3mf` | marketplace | set up two plates in the viewer, save the project |
