// Stage-20 probe: exercise the selector_bridge path (construct/paint/project_layers) with printf,
// replicating the wasm scenario exactly to isolate the footprint-projection behavior.
#include <cstdio>
#include <vector>
#include <map>
#include <array>
#include <cmath>
#include "../selector_bridge.h"

// build a welded (verts,tris) table mesh like slicer_core::selector_prepare (XY-centered, z-min=0).
static void weld_table(std::vector<float>& verts, std::vector<int>& tris) {
    auto box=[&](std::vector<std::array<double,9>>& out,double ox,double oy,double oz,double sx,double sy,double sz){
        double c[8][3]={{0,0,0},{sx,0,0},{sx,sy,0},{0,sy,0},{0,0,sz},{sx,0,sz},{sx,sy,sz},{0,sy,sz}};
        int q[12][3]={{0,1,2},{0,2,3},{4,6,5},{4,7,6},{0,1,5},{0,5,4},{1,2,6},{1,6,5},{2,3,7},{2,7,6},{3,0,4},{3,4,7}};
        for(auto&f:q){ std::array<double,9> t; for(int k=0;k<3;k++){t[k*3]=c[f[k]][0]+ox;t[k*3+1]=c[f[k]][1]+oy;t[k*3+2]=c[f[k]][2]+oz;} out.push_back(t);} };
    std::vector<std::array<double,9>> soup; box(soup,7,7,0,6,6,10); box(soup,0,0,10,20,20,4);
    double minx=1e18,miny=1e18,minz=1e18,maxx=-1e18,maxy=-1e18;
    for(auto&t:soup)for(int k=0;k<3;k++){minx=std::min(minx,t[k*3]);maxx=std::max(maxx,t[k*3]);miny=std::min(miny,t[k*3+1]);maxy=std::max(maxy,t[k*3+1]);minz=std::min(minz,t[k*3+2]);}
    double cx=(minx+maxx)/2, cy=(miny+maxy)/2;
    std::map<std::array<long long,3>,int> vmap;
    auto add=[&](double x,double y,double z)->int{std::array<long long,3> k{(long long)std::llround(x*1e4),(long long)std::llround(y*1e4),(long long)std::llround(z*1e4)};auto it=vmap.find(k);if(it!=vmap.end())return it->second;int id=(int)(verts.size()/3);verts.push_back(x);verts.push_back(y);verts.push_back(z);vmap[k]=id;return id;};
    for(auto&t:soup)for(int k=0;k<3;k++) tris.push_back(add(t[k*3]-cx,t[k*3+1]-cy,t[k*3+2]-minz));
}

int main() {
    std::vector<float> verts; std::vector<int> tris; weld_table(verts, tris);
    selector_bridge::construct(verts, tris);
    printf("selector: facet_count=%d verts=%zu\n", selector_bridge::facet_count(), verts.size()/3);
    selector_bridge::paint(12, 0,0,10, 0,0,-40, 20.f, true);   // enforcer on cap underside
    printf("enforcer painted facets=%d\n", selector_bridge::painted_count(true));
    std::vector<float> ov = selector_bridge::overlay(true);
    printf("overlay tris=%zu\n", ov.size()/9);
    std::vector<double> zs; for(double z=0.1; z<14; z+=0.2) zs.push_back(z);
    auto proj = selector_bridge::project_layers(zs, true);
    int nz=0; for(size_t i=0;i<proj.size();++i) if(!proj[i].empty()){ if(nz<4) printf("  layer z=%.2f rings=%zu\n",zs[i],proj[i].size()); nz++; }
    printf("footprint nonzero layers=%d\n", nz);
    printf("CHECK: %s\n", (selector_bridge::facet_count()>0 && selector_bridge::painted_count(true)>0 && nz>0) ? "PASS" : "FAIL");
    return 0;
}
