// slice_planes.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  The static helpers became `inline`.
#pragma once
#include "clip_util.h"
#include "stl_parse.h"

#include <cmath>
#include <unordered_map>
#include <vector>

// ---- Triangle-plane intersection -> segments ------------------------------------
struct Seg { double x0, y0, x1, y1; };
inline bool tri_plane(const Tri& t, double z, Seg& out) {
  double px[3], py[3]; int c = 0;
  for (int e = 0; e < 3; ++e) {
    const V3& a = t.v[e]; const V3& b = t.v[(e + 1) % 3];
    if ((a.z < z && b.z >= z) || (b.z < z && a.z >= z)) {
      double f = (z - a.z) / (b.z - a.z);
      if (c < 2) { px[c] = a.x + f*(b.x-a.x); py[c] = a.y + f*(b.y-a.y); }
      ++c;
    }
  }
  if (c == 2) { out = { px[0],py[0],px[1],py[1] }; return true; }
  return false;
}
inline long long qkey(double x, double y) {
  long long qx=(long long)std::llround(x/1e-3), qy=(long long)std::llround(y/1e-3);
  return (qx << 32) ^ (qy & 0xffffffffLL);
}
inline Paths chain_polys(std::vector<Seg>& segs) {
  int N=(int)segs.size();
  std::vector<char> used(N,0);
  std::unordered_map<long long,std::vector<int>> m; m.reserve(N*2);
  for (int i=0;i<N;++i){ m[qkey(segs[i].x0,segs[i].y0)].push_back(i*2); m[qkey(segs[i].x1,segs[i].y1)].push_back(i*2+1); }
  Paths out;
  for (int i=0;i<N;++i){
    if (used[i]) continue; used[i]=1;
    double sx=segs[i].x0, sy=segs[i].y0, cx=segs[i].x1, cy=segs[i].y1;
    Path poly;
    poly.push_back(IntPoint((cInt)std::llround(sx*SCALE),(cInt)std::llround(sy*SCALE)));
    poly.push_back(IntPoint((cInt)std::llround(cx*SCALE),(cInt)std::llround(cy*SCALE)));
    for (int g=0;g<N;++g){
      if (qkey(cx,cy)==qkey(sx,sy)) break;
      auto it=m.find(qkey(cx,cy)); int nxt=-1,ne=-1;
      if (it!=m.end()) for (int ref:it->second){ int si=ref/2; if(used[si])continue; nxt=si; ne=ref%2; break; }
      if (nxt<0) break; used[nxt]=1;
      if (ne==0){ cx=segs[nxt].x1; cy=segs[nxt].y1; } else { cx=segs[nxt].x0; cy=segs[nxt].y0; }
      poly.push_back(IntPoint((cInt)std::llround(cx*SCALE),(cInt)std::llround(cy*SCALE)));
    }
    if (poly.size()>=3) out.push_back(std::move(poly));
  }
  return out;
}
