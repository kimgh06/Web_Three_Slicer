// Stage 25 verification (CPU): view-type coloring (computeColors) — integrity of all 6 + speed/width ranges + heatmap palette.
import createSlicer from '../engine/src/slicer_core.js'
import { buildSegmentData, computeColors, VIEW_TYPES, DEFAULT_RANGES_COLORS } from '../viewer/src/toolpath_gpu.js'
function boxTris(ox,oy,oz,sx,sy,sz){const c=[[0,0,0],[sx,0,0],[sx,sy,0],[0,sy,0],[0,0,sz],[sx,0,sz],[sx,sy,sz],[0,sy,sz]].map(v=>[v[0]+ox,v[1]+oy,v[2]+oz]);const q=(a,b,cc,d)=>[[c[a],c[b],c[cc]],[c[a],c[cc],c[d]]];return[...q(0,1,2,3),...q(4,5,6,7),...q(0,1,5,4),...q(1,2,6,5),...q(2,3,7,6),...q(3,0,4,7)]}
function trisToSTL(tris){const buf=Buffer.alloc(84+tris.length*50);buf.writeUInt32LE(tris.length,80);let off=84;for(const t of tris){off+=12;for(const p of t){buf.writeFloatLE(p[0],off);buf.writeFloatLE(p[1],off+4);buf.writeFloatLE(p[2],off+8);off+=12}buf.writeUInt16LE(0,off);off+=2}return buf}
const base={layer_height:0.2,first_layer_height:0.2,line_width:0.42,wall_loops:3,infill_density:0.15,nozzle_diameter:0.4,filament_diameter:1.75,flow_ratio:1.0,print_speed:60,first_layer_speed:20,travel_speed:150,nozzle_temp:210,bed_temp:60,top_shell_layers:3,bottom_shell_layers:3,skirt_loops:0,brim_width:0,infill_angle:45,wall_generator:'classic'}
const M=await createSlicer()
const r=M.slice(new Uint8Array(trisToSTL(boxTris(0,0,0,20,20,20))),JSON.stringify({...base,outer_wall_line_width:0.6,inner_wall_line_width:0.42}),()=>{})
const d=buildSegmentData(r.layers,0.42)
const ctx={ speedByType:{1:60,2:40,3:45,4:30,5:35,7:30,8:40,9:25,10:20,11:30}, firstLayerSpeed:20, closeFanLayers:1, fanNormal:100, tempNormal:210, tempFirst:215 }
let fail=0; const ok=(c,m)=>{console.log((c?'  ok: ':'  FAIL: ')+m);if(!c)fail++}

ok(VIEW_TYPES.length===6, `6 view types: ${VIEW_TYPES.map(v=>v.key).join(',')}`)
ok(DEFAULT_RANGES_COLORS.length===11 && DEFAULT_RANGES_COLORS[0][2]>0.4 && DEFAULT_RANGES_COLORS[10][0]>0.5,
   'desktop 11-color range palette (blue-ish→red-ish)')
ok(!!d.meta && d.meta.vType.length===d.nV, 'buildSegmentData exposes per-vertex meta')

for(const vt of ['feature','speed','height','width','fan','temp']){
  const c=computeColors(d,vt,ctx)
  let nan=false; for(let i=0;i<c.color.length;i++) if(!Number.isFinite(c.color[i])){nan=true;break}
  ok(!nan && c.color.length===d.nV*4, `${vt}: color array valid (no NaN), min=${c.min.toFixed(2)} max=${c.max.toFixed(2)}`)
}
const cs=computeColors(d,'speed',ctx)
ok(cs.cont && cs.max>cs.min, `speed is heatmap; wall(60)/infill(40) span range ${cs.min}..${cs.max}`)
const cw=computeColors(d,'width',ctx)
ok(Math.abs(cw.min-0.42)<0.05 && Math.abs(cw.max-0.6)<0.06, `width range covers 0.42..0.6 (got ${cw.min.toFixed(2)}..${cw.max.toFixed(2)})`)
const cf=computeColors(d,'feature',ctx)
ok(!cf.cont, 'feature type is discrete (fixed colors, not heatmap)')
// speed heatmap: wall vs infill get different packed colors
const wallV=d.meta.vType, packOf=(c,i)=>c.color[i*4]
let wallCol=null, infCol=null
for(let i=0;i<d.nV;i++){ if(wallV[i]===1&&wallCol===null)wallCol=packOf(cs,i); if(wallV[i]===2&&infCol===null)infCol=packOf(cs,i) }
ok(wallCol!==null && infCol!==null && wallCol!==infCol, `wall vs infill distinct heatmap colors (${wallCol} vs ${infCol})`)

console.log(fail===0?'\nVIEW TYPES TEST PASSED':`\n${fail} FAIL`)
process.exit(fail===0?0:1)
