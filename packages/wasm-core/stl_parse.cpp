// stl_parse.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "stl_parse.h"

#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static bool is_binary_stl(const std::vector<uint8_t>& b) {
  if (b.size() < 84) return false;
  uint32_t n; std::memcpy(&n, &b[80], 4);
  return b.size() == (size_t)84 + (size_t)n * 50;   // an exact match means binary
}
static std::vector<Tri> parse_binary(const std::vector<uint8_t>& b) {
  std::vector<Tri> tris;
  uint32_t n; std::memcpy(&n, &b[80], 4);
  size_t need = 84 + (size_t)n * 50;
  if (b.size() < need) n = (uint32_t)((b.size() - 84) / 50);
  tris.reserve(n);
  size_t off = 84;
  for (uint32_t i = 0; i < n; ++i) {
    Tri t; off += 12;
    for (int k = 0; k < 3; ++k) { float xyz[3]; std::memcpy(xyz, &b[off], 12); off += 12; t.v[k]={xyz[0],xyz[1],xyz[2]}; }
    off += 2; tris.push_back(t);
  }
  return tris;
}
// ASCII: collect "vertex x y z" in order, three at a time into a triangle (facet/loop/normal ignored)
static std::vector<Tri> parse_ascii(const std::vector<uint8_t>& b) {
  std::vector<Tri> tris;
  std::string s((const char*)b.data(), b.size());
  std::vector<V3> verts;
  size_t pos = 0;
  while ((pos = s.find("vertex", pos)) != std::string::npos) {
    pos += 6;
    char* end = nullptr;
    double x = std::strtod(s.c_str()+pos, &end); if (end==s.c_str()+pos) break; pos = end - s.c_str();
    double y = std::strtod(s.c_str()+pos, &end); pos = end - s.c_str();
    double z = std::strtod(s.c_str()+pos, &end); pos = end - s.c_str();
    verts.push_back({(float)x,(float)y,(float)z});
  }
  for (size_t i = 0; i + 2 < verts.size(); i += 3) { Tri t; t.v[0]=verts[i]; t.v[1]=verts[i+1]; t.v[2]=verts[i+2]; tris.push_back(t); }
  return tris;
}
std::vector<Tri> parse_stl(const std::vector<uint8_t>& b) {
  if (b.size() < 15) return {};
  return is_binary_stl(b) ? parse_binary(b) : parse_ascii(b);
}
