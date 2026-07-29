// =============================================================================
// slicer_core.cpp — 브라우저 단독 슬라이싱 미니 커널 (트랙 C, 3단계)
//
//  1단계(뚫린 껍데기) → 2단계(솔리드셸·스커트/브림·ASCII·z_hop·심·Worker진행률)
//  → 3단계(서포트·래프트·베드·멀티오브젝트·모노토닉)
//  → 4단계(경로·G-code 레벨):
//    · 인필 패턴: rectilinear/grid/triangles/zigzag(연속경로)/gyroid(사인근사, z위상)
//    · 냉각: 팬 램프(M106 close→full 선형) + 소형 레이어 감속(slow_down_layer_time)
//    · 아크 피팅: 연속 세그먼트를 원호 근사 → G2/G3 (enable_arc_fitting)
//    · 심 위치: back/nearest/aligned/random(결정적 LCG)
//    · 스파이럴(vase): 단일 외벽 z 연속 상승 (spiral_mode)
//
//  → 5단계(품질·근사 기능):
//    · 갭필(type7): fill 의 morphological-open 잔여(얇은 틈) → 단일폭 중심선 근사
//    · 씬월 Arachne-lite(type8): 폭<2w 영역 → 벽 대신 중심선 1줄 + 국소폭 flow 보정
//    · Scarf 심(seam_slope_type=external/all): 외벽 시작 z·flow 램프업 + 끝 오버랩 램프다운, ; scarf
//    · 압력 어드밴스(enable_pressure_advance): 프리앰블 M900 K<v> (Klipper 는 주석 표기)
//    · 트리라이트 서포트(support_style=tree_lite): 하강 테이퍼(-0.5mm/층, 최소기둥 r1.5mm)+union
//    · 브리지(type9): 무지지 bottom 솔리드 → 팬100%+bridge_speed 감속
//  → 6단계(동등성 갭 축소):
//    · 아이어닝(type10, ironing_type): 노출 top 솔리드 위 저유량 재패스(간격/flow%/속도)
//    · 벽 회피 트래블(reduce_crossing_wall): 아일랜드 경계 우회 + stats.wall_crossings 검산
//    · PressureEqualizer-lite(max_volumetric_extrusion_rate_slope): 인접 세그먼트 유량 변화율 한도(속도만 조정)
//    · 멀티머티리얼 기초(extruder_count/mm_group_split): 그룹 분리 슬라이스 + T0/T1 + 프라임타워(type11)
//  → 7단계(실제 이식): wall_generator=arachne → 이식된 진짜 OrcaSlicer Arachne WallToolPaths 로 가변폭
//    벽 생성(arachne_bridge 경유). 세그먼트별 폭 → E 계산(set_e_per_mm_width) + widths[] 툴패스 배열.
//    classic 이 기본값(하위호환). ⚠ CGAL 평면성 복구만 스텁, 그 외 Arachne 알고리즘은 원본.
//  → 8단계(실제 이식 계속): 실제 OrcaSlicer Fill 패턴(gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/
//    concentric, fill_bridge 경유 — gyroid 는 진짜 TPMS 로 교체, 기존 사인 근사는 gyroid_approx 로 보존) +
//    실제 PressureEqualizer(pe_bridge, pe_lite=false 옵트인).
//  → 9단계(완전 통합): 실제 PE 완전 동작 — emit_pe_tags 시 커널이 OrcaSlicer 태그(;_EXTRUSION_ROLE/
//    ;_EXTRUDE_SET_SPEED/;_EXTRUDE_END) 방출 → 실제 PE 가 세그먼트 F 램프 삽입(G1↑·E보존), pe_strip_tags 로
//    최종 태그 제거. + TreeSupport 코어 MST(tree_bridge, 브랜치 병합) 이식 — 전체 파이프라인은 PrintObject 결합 미이식.
//  → 10단계(원본 시간추정): 이식된 GCodeProcessor 사다리꼴 플래너(gcode_time.{h,cpp} — 원본 알고리즘 verbatim
//    전사 + 머신한계 파라미터 주입)로 방출 g-code 를 파싱해 stats.time_estimate(총/레이어별/role별) 산출. 뷰어에
//    예상시간 표시. full-GCodeProcessor·WipeTower 는 config 서브시스템(실 PrintConfig.hpp) 관문 — README 기록.
//
//  ⚠ 여전히 미니 커널이다. 미구현/근사 한계 → 완전 libslic3r 포팅 필요:
//    완전한 Arachne 스켈레톤(가변폭), 오가닉 트리 서포트, 와이프타워 본격, PressureEqualizer 정밀,
//    벽 회피 완전성, non-planar.
//
//  파이프라인(multi-pass): STL → [p1] 교차·체이닝·Union·벽·표면검출 → [p1.6] 서포트
//    → [p2] 솔리드/스파스(패턴) 분리 → 래프트 → 냉각/감속/심/아크 → G-code(SPECS §6.2)
//  좌표: 모델을 XY원점 중심·minZ=0 이동. G-code 는 +(bed/2) 오프셋으로 양수화.
// =============================================================================
#include "clipper.hpp"
#include "arachne_bridge.h"   // 7단계: 실제 OrcaSlicer Arachne 이식 브릿지(가변폭 벽)
#include "fill_bridge.h"      // 8단계: 실제 OrcaSlicer Fill 패턴 이식 브릿지(gyroid TPMS 등)
#include "pe_bridge.h"        // 8단계: 실제 OrcaSlicer PressureEqualizer 이식 브릿지(세그먼트 분할)
#include "gcode_time.h"       // 10단계: 이식된 GCodeProcessor 시간추정 알고리즘(원본 사다리꼴 플래너)
#include "config_bridge.h"    // 12단계: 실 config 서브시스템(print_config_def) 경계 브릿지
#include "gcodeproc_bridge.h" // 13단계: 실 이식 GCodeProcessor 본체(time_engine=full) 경계 브릿지
#include "treesupport_bridge.h" // 17/18단계: 실 오가닉 TreeSupport(generate_tree_support_3D) 경계 브릿지
#include "selector_bridge.h"    // 20단계: 수동 서포트 페인팅(TriangleSelector enforcer/blocker) 경계 브릿지
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <emscripten/heap.h>   // 30단계: emscripten_get_heap_size() — 힙 피크 벤치(ALLOW_MEMORY_GROWTH 단조증가)
#include <emscripten/emscripten.h>  // emscripten_get_now() — 스테이지 계측
#include <thread>    // (mt) PASS 1 레이어 병렬 — __EMSCRIPTEN_PTHREADS__ 빌드에서만 실사용
#include <atomic>
#include <vector>
#include <string>
#include <unordered_map>
#include <map>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cctype>
#include <algorithm>

using namespace ClipperLib;
namespace em = emscripten;

static const double SCALE  = 1e6;          // mm → clipper 정수 좌표
static const double INV    = 1.0 / SCALE;
static const double PI     = 3.14159265358979323846;
static const double BED_CENTER = 128.0;    // 256mm 베드 중심 (G-code 양수화)
static const double TRAVEL_RETRACT_MIN = 2.0; // mm 초과 이동 시 리트랙션

// ---- 파라미터 (1단계 이름 불변 + 2단계 신규) -----------------------------------
struct Params {
  double layer_height=0.2, first_layer_height=0.2, line_width=0.42;
  // 21단계: 피처별 압출 폭(0=자동유도). 0 이면 line_width(>0) 또는 원본 Flow auto(nozzle 기반)로 파싱 시 해석.
  double outer_wall_line_width=0, inner_wall_line_width=0, top_surface_line_width=0;
  double sparse_infill_line_width=0, internal_solid_infill_line_width=0, initial_layer_line_width=0;
  int    wall_loops=2;
  double infill_density=0.15, nozzle_diameter=0.4, filament_diameter=1.75, flow_ratio=1.0;
  double print_speed=60, first_layer_speed=20, travel_speed=150;
  double nozzle_temp=210, bed_temp=60;
  // 2단계 신규 (기본값은 config-schema.json 대응 키)
  int    top_shell_layers=4, bottom_shell_layers=3;   // top_shell_layers/bottom_shell_layers
  int    skirt_loops=1;                                // skirt_loops
  double skirt_distance=2.0, brim_width=0.0;           // skirt_distance / brim_width
  double retract_length=0.8, retract_speed=30.0, z_hop=0.4; // retraction_length/speed[0], z_hop[0]
  double infill_angle=45.0;                            // infill_direction
  // 3단계 신규 (기본값은 config-schema.json 대응 키 / 좌표조정 지시)
  bool   enable_support=false;                         // enable_support
  double support_threshold_angle=30.0;                 // support_threshold_angle
  double support_density=0.15;                         // 서포트 본체 밀도
  double support_top_z_distance=0.2;                   // support_top_z_distance
  double support_bottom_z_distance=0.2;                // 32단계: 모델 상면에 얹히는 서포트 바닥 z-gap(기본 0.2=현행 1레이어 등가 → 기본동작·golden 불변)
  double support_xy_distance=0.35;                     // support_object_xy_distance
  int    support_interface_top_layers=2;               // support_interface_top_layers
  bool   support_auto=true;                             // 20단계: true=자동 오버행 검출, false=수동(페인트 enforcer만)
  double support_line_width=0.0;                        // support_line_width (0=auto; 실 트리 서포트 압출폭)
  int    raft_layers=0;                                // raft_layers
  double bed_width=256.0, bed_depth=256.0;             // 베드 크기 (오프셋=bed/2)
  // 4단계 신규 (경로·G-code 레벨)
  std::string sparse_infill_pattern="rectilinear";     // rectilinear|grid|triangles|zigzag|gyroid
  double fan_speed=100.0;                               // fan_speed (%)
  int    close_fan_the_first_x_layers=1;               // close_fan_the_first_x_layers
  int    full_fan_speed_layer=3;                        // full_fan_speed_layer
  double slow_down_layer_time=8.0;                      // slow_down_layer_time (s)
  bool   enable_arc_fitting=false;                      // enable_arc_fitting
  std::string seam_position="back";                     // nearest|aligned|back|random
  bool   spiral_mode=false;                             // spiral_mode (vase)
  // 5단계 신규 (갭필·씬월·스카프·압력어드밴스·트리라이트·브리지)
  std::string seam_slope_type="none";                   // none|external|all → scarf 심 (external/all=on)
  double scarf_length=10.0;                              // scarf z·flow 램프 길이 (mm)
  bool   enable_pressure_advance=false;                 // enable_pressure_advance[0]
  double pressure_advance=0.02;                          // pressure_advance[0]
  std::string support_style="grid";                     // grid|tree_lite
  double bridge_speed=25.0;                              // bridge_speed[0] (무지지 bottom 감속)
  // 6단계 신규 (아이어닝·벽회피·PE-lite·멀티머티리얼)
  std::string ironing_type="none";                      // none|top|topmost|solid (top류=on)
  double ironing_spacing=0.1;                           // 아이어닝 라인 간격 (mm)
  double ironing_flow=10.0;                             // 아이어닝 유량 (%)
  double ironing_speed=30.0;                            // 아이어닝 속도 (mm/s)
  bool   reduce_crossing_wall=false;                    // 벽 회피 트래블
  double max_volumetric_extrusion_rate_slope=0.0;       // PE-lite 유량 변화율 한도 (mm³/s², 0=off)
  int    extruder_count=1;                              // 멀티머티리얼: 사용 익스트루더 수(1|2)
  int    mm_group_split=0;                              // 삼각형 그룹 경계 인덱스([0,split)=T0, [split,N)=T1)
  bool   auto_center=false;                             // 28단계: true=결합 bbox 를 원점 재정렬(3단계 레거시). false(기본)=뷰어 좌표 신뢰(재정렬 없음, Z 만 안착) → 툴패스가 화면 모델과 정확히 겹침. 원본 = plate origin 오프셋만(GCode.cpp:932).
  bool   wipe_tower_real=false;                         // 12단계: MM 전환 시 6단계 사각링 대신 실 WipeTower.generate()
  double prime_tower_width=30.0;                        //  실 WipeTower 폭(mm). 사각링 폭(15)과 별개.
  // 7단계 신규 (실제 Arachne 이식)
  std::string wall_generator="classic";                // classic|arachne (arachne=이식된 실제 WallToolPaths)
  // 8단계 신규 (실제 PressureEqualizer 이식)
  //  ⚠ 기본 pe_lite=true: 실제 PE 는 OrcaSlicer 의 ;_EXTRUDE_SET_SPEED 태그 g-code 에서만 유량 조정하는데
  //    이 미니커널은 평문 g-code 를 내보내므로 실제 PE 가 통과(no-op)한다. 그래서 실효 있는 PE-lite 를
  //    기본값으로 두고, 실제 PE 는 pe_lite=false 로 옵트인(이식/링크/실행/E보존 검증됨, 태그 필요는 한계로 기록).
  bool   pe_lite=true;                                  // true=효과 있는 PE-lite(기본), false=이식된 실제 PE(태그 g-code)
  double extrusion_rate_slope_segment_length=1.0;       // 실제 PE 세그먼트 분할 길이 (mm)
  bool   pe_external_perimeter_only=false;              // 실제 PE: 외벽만 평활
  // 9단계: 실제 PE 완전 통합 — 커널이 OrcaSlicer 태그(;_EXTRUDE_SET_SPEED/;_EXTRUDE_END/;_EXTRUSION_ROLE) 방출
  bool   emit_pe_tags=false;                            // 압출 런에 PE 태그 방출(실제 PE 사용 시 자동 활성). 기본 false(하위호환)
  bool   pe_strip_tags=true;                            // 실제 PE 후처리 뒤 최종 출력에서 태그 제거
  // 10단계: 시간추정 머신 한계(원본 machine_max_*/machine_min_*, 프로파일 대표값 기본). 튜닝 가능.
  double machine_accel_print=5000, machine_accel_travel=5000, machine_accel_retract=5000; // mm/s²
  double machine_jerk_xy=9.0, machine_jerk_z=0.4, machine_jerk_e=2.5;                       // mm/s
  double machine_max_speed_xy=500, machine_max_speed_z=12, machine_max_speed_e=30;          // mm/s
  // 13단계: 시간추정 엔진. full=실 이식 GCodeProcessor 본체(신규 기본), transcribed=10단계 gcode_time 전사본.
  std::string time_engine="full";
  // 30단계: 절약(economy) 모드 — OOM 재시도 사다리의 마지막 완주 단계. 프리뷰 툴패스 방출 생략(빈 배열)
  //  + 시간추정(r.moves 대량 상주) 생략 → G-code 만 스트리밍으로 끝까지 방출. 레이어 싱크가 설정된
  //  스트리밍 경로에서만 유효(기본 false — 배치 경로 무영향).
  bool   economy=false;
};
static size_t jfind_val(const std::string& s, const char* key) {
  std::string k = std::string("\"") + key + "\"";
  size_t p = s.find(k);
  if (p == std::string::npos) return std::string::npos;
  p = s.find(':', p + k.size());
  if (p == std::string::npos) return std::string::npos;
  ++p;
  while (p < s.size() && (s[p]==' '||s[p]=='\t'||s[p]=='\n')) ++p;
  return p;
}
static double jget(const std::string& s, const char* key, double d) {
  size_t p = jfind_val(s, key);
  return (p == std::string::npos) ? d : std::strtod(s.c_str() + p, nullptr);
}
static bool jbool(const std::string& s, const char* key, bool d) {
  size_t p = jfind_val(s, key);
  if (p == std::string::npos) return d;
  if (s.compare(p, 4, "true") == 0)  return true;
  if (s.compare(p, 5, "false") == 0) return false;
  return std::strtod(s.c_str() + p, nullptr) != 0.0;   // 1/0 도 허용
}
static std::string jstr(const std::string& s, const char* key, const std::string& d) {
  size_t p = jfind_val(s, key);
  if (p == std::string::npos || p >= s.size() || s[p] != '"') return d;
  ++p; std::string out;
  while (p < s.size() && s[p] != '"') { out += s[p]; ++p; }
  return out.empty() ? d : out;
}
// 21단계: coFloatOrPercent 폭 읽기 — "120%" → nozzle*1.2; 숫자 → 그대로; 없음 → 0(자동유도 표식).
static double jwidth_raw(const std::string& s, const char* key, double nozzle) {
  size_t p = jfind_val(s, key);
  if (p == std::string::npos) return 0.0;
  if (s[p] == '"') { std::string v; size_t q = p + 1; while (q < s.size() && s[q] != '"') { v += s[q]; ++q; }
    if (!v.empty() && v.back() == '%') return std::strtod(v.c_str(), nullptr) * 0.01 * nozzle;
    return std::strtod(v.c_str(), nullptr); }
  return std::strtod(s.c_str() + p, nullptr);
}
// 원본 Flow::auto_extrusion_width (src/libslic3r/Flow.cpp:21): top-surface/support = nozzle_diameter,
//  그 외(외벽/내벽/sparse/solid) = 1.125 * nozzle_diameter.
static double auto_lw(double nozzle, bool top_or_support) { return top_or_support ? nozzle : 1.125 * nozzle; }
// 피처 폭 해석: 값>0 → 그대로 · 0 → line_width(>0) · line_width 도 0 → 원본 auto. (기본 line_width=0.42 → 기본동작 불변)
static double resolve_lw(double raw, double nozzle, double base_lw, bool top_or_support) {
  if (raw > 0) return raw;
  if (base_lw > 0) return base_lw;
  return auto_lw(nozzle, top_or_support);
}

static Params parse_params(const std::string& j) {
  Params p;
  p.layer_height       = jget(j,"layer_height",p.layer_height);
  p.first_layer_height = jget(j,"first_layer_height",p.first_layer_height);
  p.line_width         = jget(j,"line_width",p.line_width);
  p.wall_loops         = (int)jget(j,"wall_loops",p.wall_loops);
  p.infill_density     = jget(j,"infill_density",p.infill_density);
  p.nozzle_diameter    = jget(j,"nozzle_diameter",p.nozzle_diameter);
  p.filament_diameter  = jget(j,"filament_diameter",p.filament_diameter);
  p.flow_ratio         = jget(j,"flow_ratio",p.flow_ratio);
  p.print_speed        = jget(j,"print_speed",p.print_speed);
  p.first_layer_speed  = jget(j,"first_layer_speed",p.first_layer_speed);
  p.travel_speed       = jget(j,"travel_speed",p.travel_speed);
  p.nozzle_temp        = jget(j,"nozzle_temp",p.nozzle_temp);
  p.bed_temp           = jget(j,"bed_temp",p.bed_temp);
  p.top_shell_layers   = (int)jget(j,"top_shell_layers",p.top_shell_layers);
  p.bottom_shell_layers= (int)jget(j,"bottom_shell_layers",p.bottom_shell_layers);
  p.skirt_loops        = (int)jget(j,"skirt_loops",p.skirt_loops);
  p.skirt_distance     = jget(j,"skirt_distance",p.skirt_distance);
  p.brim_width         = jget(j,"brim_width",p.brim_width);
  p.retract_length     = jget(j,"retract_length",p.retract_length);
  p.retract_speed      = jget(j,"retract_speed",p.retract_speed);
  p.z_hop              = jget(j,"z_hop",p.z_hop);
  p.infill_angle       = jget(j,"infill_angle",p.infill_angle);
  p.enable_support     = jbool(j,"enable_support",p.enable_support);
  p.support_threshold_angle       = jget(j,"support_threshold_angle",p.support_threshold_angle);
  p.support_density               = jget(j,"support_density",p.support_density);
  p.support_top_z_distance        = jget(j,"support_top_z_distance",p.support_top_z_distance);
  p.support_bottom_z_distance     = jget(j,"support_bottom_z_distance",p.support_bottom_z_distance);
  p.support_xy_distance           = jget(j,"support_xy_distance",p.support_xy_distance);
  p.support_interface_top_layers  = (int)jget(j,"support_interface_top_layers",p.support_interface_top_layers);
  p.support_line_width            = jget(j,"support_line_width",p.support_line_width);
  p.support_auto                  = jbool(j,"support_auto",p.support_auto);
  p.raft_layers        = (int)jget(j,"raft_layers",p.raft_layers);
  p.bed_width          = jget(j,"bed_width",p.bed_width);
  p.bed_depth          = jget(j,"bed_depth",p.bed_depth);
  p.sparse_infill_pattern         = jstr(j,"sparse_infill_pattern",p.sparse_infill_pattern);
  p.fan_speed                     = jget(j,"fan_speed",p.fan_speed);
  p.close_fan_the_first_x_layers  = (int)jget(j,"close_fan_the_first_x_layers",p.close_fan_the_first_x_layers);
  p.full_fan_speed_layer          = (int)jget(j,"full_fan_speed_layer",p.full_fan_speed_layer);
  p.slow_down_layer_time          = jget(j,"slow_down_layer_time",p.slow_down_layer_time);
  p.enable_arc_fitting            = jbool(j,"enable_arc_fitting",p.enable_arc_fitting);
  p.seam_position                 = jstr(j,"seam_position",p.seam_position);
  p.spiral_mode                   = jbool(j,"spiral_mode",p.spiral_mode);
  p.seam_slope_type               = jstr(j,"seam_slope_type",p.seam_slope_type);
  p.scarf_length                  = jget(j,"scarf_length",p.scarf_length);
  p.enable_pressure_advance       = jbool(j,"enable_pressure_advance",p.enable_pressure_advance);
  p.pressure_advance              = jget(j,"pressure_advance",p.pressure_advance);
  p.support_style                 = jstr(j,"support_style",p.support_style);
  p.bridge_speed                  = jget(j,"bridge_speed",p.bridge_speed);
  p.ironing_type                  = jstr(j,"ironing_type",p.ironing_type);
  p.ironing_spacing               = jget(j,"ironing_spacing",p.ironing_spacing);
  p.ironing_flow                  = jget(j,"ironing_flow",p.ironing_flow);
  p.ironing_speed                 = jget(j,"ironing_speed",p.ironing_speed);
  p.reduce_crossing_wall          = jbool(j,"reduce_crossing_wall",p.reduce_crossing_wall);
  p.max_volumetric_extrusion_rate_slope = jget(j,"max_volumetric_extrusion_rate_slope",p.max_volumetric_extrusion_rate_slope);
  p.extruder_count                = (int)jget(j,"extruder_count",p.extruder_count);
  p.mm_group_split                = (int)jget(j,"mm_group_split",p.mm_group_split);
  p.auto_center                   = jbool(j,"auto_center",p.auto_center);   // 28단계
  p.wipe_tower_real               = jbool(j,"wipe_tower_real",p.wipe_tower_real);
  p.prime_tower_width             = jget(j,"prime_tower_width",p.prime_tower_width);
  p.wall_generator                = jstr(j,"wall_generator",p.wall_generator);
  p.pe_lite                       = jbool(j,"pe_lite",p.pe_lite);
  p.extrusion_rate_slope_segment_length = jget(j,"extrusion_rate_slope_segment_length",p.extrusion_rate_slope_segment_length);
  p.pe_external_perimeter_only    = jbool(j,"pe_external_perimeter_only",p.pe_external_perimeter_only);
  p.emit_pe_tags                  = jbool(j,"emit_pe_tags",p.emit_pe_tags);
  p.pe_strip_tags                 = jbool(j,"pe_strip_tags",p.pe_strip_tags);
  p.machine_accel_print           = jget(j,"machine_accel_print",p.machine_accel_print);
  p.machine_accel_travel          = jget(j,"machine_accel_travel",p.machine_accel_travel);
  p.machine_accel_retract         = jget(j,"machine_accel_retract",p.machine_accel_retract);
  p.machine_jerk_xy               = jget(j,"machine_jerk_xy",p.machine_jerk_xy);
  p.machine_jerk_z                = jget(j,"machine_jerk_z",p.machine_jerk_z);
  p.machine_jerk_e                = jget(j,"machine_jerk_e",p.machine_jerk_e);
  p.machine_max_speed_xy          = jget(j,"machine_max_speed_xy",p.machine_max_speed_xy);
  p.machine_max_speed_z           = jget(j,"machine_max_speed_z",p.machine_max_speed_z);
  p.machine_max_speed_e           = jget(j,"machine_max_speed_e",p.machine_max_speed_e);
  p.time_engine                   = jstr(j,"time_engine",p.time_engine);
  p.economy                       = jbool(j,"economy",p.economy);
  // 21단계: 피처별 폭 해석 (nozzle 파싱 후). line_width 가 0 이면 원본 auto 로 승격(뷰어는 기본 0.42 전송 → 불변).
  {
    const double noz = p.nozzle_diameter;
    if (p.line_width <= 0) p.line_width = auto_lw(noz, false);
    p.outer_wall_line_width            = resolve_lw(jwidth_raw(j,"outer_wall_line_width",noz),            noz, p.line_width, false);
    p.inner_wall_line_width            = resolve_lw(jwidth_raw(j,"inner_wall_line_width",noz),            noz, p.line_width, false);
    p.top_surface_line_width           = resolve_lw(jwidth_raw(j,"top_surface_line_width",noz),           noz, p.line_width, true);   // top surface → nozzle auto
    p.sparse_infill_line_width         = resolve_lw(jwidth_raw(j,"sparse_infill_line_width",noz),         noz, p.line_width, false);
    p.internal_solid_infill_line_width = resolve_lw(jwidth_raw(j,"internal_solid_infill_line_width",noz), noz, p.line_width, false);
    p.initial_layer_line_width         = resolve_lw(jwidth_raw(j,"initial_layer_line_width",noz),         noz, p.line_width, false);
  }
  return p;
}

// ---- STL 파서 (바이너리 + ASCII) ----------------------------------------------
struct V3 { float x, y, z; };
struct Tri { V3 v[3]; };
static bool is_binary_stl(const std::vector<uint8_t>& b) {
  if (b.size() < 84) return false;
  uint32_t n; std::memcpy(&n, &b[80], 4);
  return b.size() == (size_t)84 + (size_t)n * 50;   // 정확히 맞으면 바이너리
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
// ASCII: "vertex x y z" 를 순서대로 모아 3개씩 삼각형 (facet/loop/normal 무시)
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
static std::vector<Tri> parse_stl(const std::vector<uint8_t>& b) {
  if (b.size() < 15) return {};
  return is_binary_stl(b) ? parse_binary(b) : parse_ascii(b);
}

// ---- 삼각형-평면 교차 → 세그먼트 ----------------------------------------------
struct Seg { double x0, y0, x1, y1; };
static bool tri_plane(const Tri& t, double z, Seg& out) {
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
static inline long long qkey(double x, double y) {
  long long qx=(long long)std::llround(x/1e-3), qy=(long long)std::llround(y/1e-3);
  return (qx << 32) ^ (qy & 0xffffffffLL);
}
static Paths chain_polys(std::vector<Seg>& segs) {
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

// ---- Clipper 헬퍼 --------------------------------------------------------------
static Paths offset_paths(const Paths& in, double delta_mm, JoinType jt=jtMiter) {
  Paths out; if (in.empty()) return out;
  ClipperOffset co; co.AddPaths(in, jt, etClosedPolygon); co.Execute(out, delta_mm*SCALE);
  return out;
}
static Paths clip_paths(const Paths& a, const Paths& b, ClipType ct) {
  Paths out;
  if (a.empty()) return (ct==ctUnion) ? b : Paths{};
  Clipper c; c.AddPaths(a, ptSubject, true);
  if (!b.empty()) c.AddPaths(b, ptClip, true);
  else if (ct==ctIntersection) return {};   // ∩ 빈집합 = 빈집합
  c.Execute(ct, out, pftNonZero, pftNonZero);
  return out;
}
static Paths union_paths(const Paths& a, const Paths& b) {
  if (a.empty()) return b; if (b.empty()) return a; return clip_paths(a,b,ctUnion);
}
// 특정 각도 평행선 생성 후 region 으로 클립 (열린 경로)
static void bbox_of(const Paths& ps, double& minx,double& miny,double& maxx,double& maxy){
  minx=miny=1e18; maxx=maxy=-1e18;
  for (const Path& p:ps) for (const IntPoint& pt:p){ double x=pt.x()*INV,y=pt.y()*INV;
    minx=std::min(minx,x);miny=std::min(miny,y);maxx=std::max(maxx,x);maxy=std::max(maxy,y);} }
static Paths infill_lines(const Paths& region, double angleDeg, double spacing) {
  Paths lines; if (region.empty()||spacing<=1e-6) return lines;
  double minx,miny,maxx,maxy; bbox_of(region,minx,miny,maxx,maxy);
  double a=angleDeg*PI/180.0, dx=std::cos(a),dy=std::sin(a), nx=-std::sin(a),ny=std::cos(a);
  double diag=std::hypot(maxx-minx,maxy-miny)+2.0, nmin=1e18,nmax=-1e18;
  double cx[4]={minx,maxx,minx,maxx}, cy[4]={miny,miny,maxy,maxy};
  for (int i=0;i<4;++i){ double pr=cx[i]*nx+cy[i]*ny; nmin=std::min(nmin,pr); nmax=std::max(nmax,pr); }
  for (double o=nmin;o<=nmax;o+=spacing){
    double bx=o*nx,by=o*ny; Path ln;
    ln.push_back(IntPoint((cInt)std::llround((bx-dx*diag)*SCALE),(cInt)std::llround((by-dy*diag)*SCALE)));
    ln.push_back(IntPoint((cInt)std::llround((bx+dx*diag)*SCALE),(cInt)std::llround((by+dy*diag)*SCALE)));
    lines.push_back(std::move(ln));
  }
  return lines;
}
static Paths clip_open(const Paths& lines, const Paths& region) {   // 열린 경로 ∩ region
  if (lines.empty()||region.empty()) return {};
  Clipper c; c.AddPaths(lines, ptSubject, false); c.AddPaths(region, ptClip, true);
  PolyTree pt; c.Execute(ctIntersection, pt, pftNonZero, pftNonZero);
  Paths out; OpenPathsFromPolyTree(pt, out); return out;
}
static Paths infill_clipped(const Paths& region, double angleDeg, double spacing) {
  return clip_open(infill_lines(region, angleDeg, spacing), region);
}
static void sort_monotonic(Paths& lines, double angleDeg);   // (아래 정의) zigzag 정렬용

// ---- 5단계 헬퍼: 면적·성분 분리·모폴로지 open·중심선·트리 수축 ------------------
static double paths_area(const Paths& ps){ double a=0; for (const Path& p:ps) a+=Area(p); return std::fabs(a); }
// morphological open: erode(-r) 후 dilate(+r) → 폭 <2r 인 얇은 부위 제거된 "두꺼운 코어"
static Paths morph_open(const Paths& in, double r){
  if (in.empty()||r<=1e-6) return in;
  return offset_paths(offset_paths(in, -r), r);
}
// PolyTree 재귀로 연결 성분 분리 (각 성분 = 외곽 1개 + 그 구멍들)
static void collect_component(PolyNode* n, std::vector<Paths>& out){
  Paths comp; comp.push_back(n->Contour);
  for (PolyNode* hole : n->Childs){
    comp.push_back(hole->Contour);                 // 구멍
    for (PolyNode* inner : hole->Childs) collect_component(inner, out);  // 구멍 안 섬 = 새 성분
  }
  out.push_back(std::move(comp));
}
static std::vector<Paths> split_components(const Paths& in){
  std::vector<Paths> out; if (in.empty()) return out;
  Clipper c; c.AddPaths(in, ptSubject, true);
  PolyTree tree; c.Execute(ctUnion, tree, pftNonZero, pftNonZero);
  for (PolyNode* n : tree.Childs) collect_component(n, out);
  return out;
}
// 성분의 중심선 근사: bbox 장축을 따라 무게중심 통과 직선 1개를 성분에 클립.
//  얇은 직선 막대엔 정확한 중심선. 실패(곡선 등) 시 장축 방향 rectilinear 폴백.
static Paths centerline_of(const Paths& comp, double w){
  if (comp.empty()) return {};
  double minx,miny,maxx,maxy; bbox_of(comp,minx,miny,maxx,maxy);
  double W=maxx-minx, H=maxy-miny, ang=(W>=H)?0.0:90.0;
  double cx=(minx+maxx)/2, cy=(miny+maxy)/2, a=ang*PI/180.0, dx=std::cos(a), dy=std::sin(a);
  double diag=std::hypot(W,H)+2.0;
  Path ln;
  ln.push_back(IntPoint((cInt)std::llround((cx-dx*diag)*SCALE),(cInt)std::llround((cy-dy*diag)*SCALE)));
  ln.push_back(IntPoint((cInt)std::llround((cx+dx*diag)*SCALE),(cInt)std::llround((cy+dy*diag)*SCALE)));
  Paths lns; lns.push_back(ln);
  Paths out = clip_open(lns, comp);
  if (out.empty()) out = infill_clipped(comp, ang, std::max(w, 1e-3));   // 폴백
  return out;
}
// 트리라이트 1층 수축: 성분별로 폭<2·minR 이면 유지(최소 기둥), 아니면 -shrink 수축 후 병합.
static Paths tree_taper(const Paths& in, double shrink, double minR){
  if (in.empty()) return in;
  Paths out;
  for (const Paths& comp : split_components(in)){
    Paths minTest = offset_paths(comp, -minR);
    if (minTest.empty()) { for (const Path& pp:comp) out.push_back(pp); continue; }  // 최소 기둥: 수축 안 함
    Paths s = offset_paths(comp, -shrink);
    if (s.empty()) { for (const Path& pp:comp) out.push_back(pp); }
    else           { for (const Path& pp:s) out.push_back(pp); }
  }
  return clip_paths(out, Paths{}, ctUnion);   // 겹친 기둥 union 병합
}
// gyroid 근사: 간격마다 사인 파형 라인, 위상은 z 로 회전 (층별 3D 변화)
static Paths gyroid_lines(const Paths& region, double spacing, double z) {
  Paths lines; if (region.empty()||spacing<=1e-6) return lines;
  double minx,miny,maxx,maxy; bbox_of(region,minx,miny,maxx,maxy);
  double A=spacing*0.55, lambda=spacing*2.0, phase=z*(2*PI/lambda), step=lambda/12.0;
  for (double base=miny-A; base<=maxy+A+spacing; base+=spacing) {
    Path ln;
    for (double x=minx-1.0; x<=maxx+1.0; x+=step)
      ln.push_back(IntPoint((cInt)std::llround(x*SCALE),(cInt)std::llround((base+A*std::sin(2*PI*x/lambda+phase))*SCALE)));
    if (ln.size()>=2) lines.push_back(std::move(ln));
  }
  return lines;
}
// 지그재그: 정렬된 평행선을 경계에서 연결(왕복) → 연속 경로 1개, 트래블 감소
static Paths zigzag_connect(Paths lines, double angleDeg) {
  if (lines.size()<2) return lines;
  sort_monotonic(lines, angleDeg);
  Path chain;
  for (size_t i=0;i<lines.size();++i) {
    if (lines[i].size()<2) continue;
    Path ln = lines[i];
    if (i & 1) std::reverse(ln.begin(), ln.end());
    for (auto& q:ln) chain.push_back(q);
  }
  Paths out; if (chain.size()>=2) out.push_back(std::move(chain));
  return out;
}
// 8단계: 이식된 실제 OrcaSlicer Fill 패턴 호출 (성분별 ExPolygon → fill_bridge → 열린 경로).
//  region = ClipperLib Paths(스케일 SCALE). density=분율, lineW=선폭(mm), angleDeg, z(mm).
static Paths real_fill(const Paths& region, const std::string& pat, double density, double lineW, double angleDeg, double z, int layerIdx) {
  Paths out;
  for (const Paths& comp : split_components(region)) {   // comp[0]=외곽, [1..]=구멍
    std::vector<std::vector<std::pair<double,double>>> polys;
    for (const Path& p : comp) {
      std::vector<std::pair<double,double>> poly; poly.reserve(p.size());
      for (const IntPoint& q : p) poly.push_back({ q.x()*INV, q.y()*INV });
      if (poly.size() >= 3) polys.push_back(std::move(poly));
    }
    if (polys.empty() || polys[0].size() < 3) continue;
    auto lines = fill_bridge::generate_fill(polys, pat, density, lineW, angleDeg, z, layerIdx);
    for (const auto& pl : lines) {
      Path path; path.reserve(pl.size());
      for (const auto& xy : pl) path.push_back(IntPoint((cInt)std::llround(xy.first*SCALE),(cInt)std::llround(xy.second*SCALE)));
      if (path.size() >= 2) out.push_back(std::move(path));
    }
  }
  return out;
}
// 스파스 패턴 디스패치 (열린 경로 반환). lineW=선폭, density=분율(실제 Fill 이식 패턴용).
static Paths build_sparse(const Paths& region, const std::string& pat, double base, double spacing, int layerIdx, double z, double lineW, double density) {
  if (region.empty()||spacing<=1e-6) return {};
  if (pat=="grid") {
    Paths l = infill_lines(region, base, spacing*2.0);
    for (auto& q:infill_lines(region, base+90.0, spacing*2.0)) l.push_back(q);
    return clip_open(l, region);
  }
  if (pat=="triangles") {
    Paths l = infill_lines(region, base, spacing*3.0);
    for (auto& q:infill_lines(region, base+60.0,  spacing*3.0)) l.push_back(q);
    for (auto& q:infill_lines(region, base+120.0, spacing*3.0)) l.push_back(q);
    return clip_open(l, region);
  }
  // 8단계: 이식된 실제 Fill 패턴 (gyroid 는 진짜 TPMS 로 교체, 기존 사인 근사는 gyroid_approx 로 보존)
  if (pat=="gyroid"||pat=="honeycomb"||pat=="3dhoneycomb"||pat=="crosshatch"||pat=="concentric") {
    Paths rf = real_fill(region, pat, density, lineW, base, z, layerIdx);
    if (!rf.empty()) return rf;   // 실패 시 아래 rectilinear 폴백
  }
  if (pat=="gyroid_approx") return clip_open(gyroid_lines(region, spacing, z), region);  // 하위호환: 구 사인 근사
  double a = base + (layerIdx%2 ? 90.0 : 0.0);         // 층별 교차
  if (pat=="zigzag")  return zigzag_connect(infill_clipped(region, a, spacing), a);
  return infill_clipped(region, a, spacing);           // rectilinear (기본)
}
// 경로 길이 (레이어 시간 추정용)
static double path_len(const Path& p, bool closed) {
  double L=0; for (size_t i=1;i<p.size();++i) L+=std::hypot((p[i].x()-p[i-1].x())*INV,(p[i].y()-p[i-1].y())*INV);
  if (closed && p.size()>=2) L+=std::hypot((p[0].x()-p.back().x())*INV,(p[0].y()-p.back().y())*INV);
  return L;
}
static double paths_len(const Paths& ps, bool closed){ double L=0; for (auto& p:ps) L+=path_len(p,closed); return L; }
static double vwalls_len(const std::vector<Paths>& ws){ double L=0; for (auto& w:ws) L+=paths_len(w,true); return L; }
// 냉각 팬 램프: [0,close)=0, [full,∞)=target, 사이 선형
static int fan_S(int i, const Params& p) {
  double target = 255.0 * (p.fan_speed/100.0);
  int close = std::max(0,p.close_fan_the_first_x_layers), full = std::max(close+1,p.full_fan_speed_layer);
  if (i < close) return 0;
  if (i >= full) return (int)std::llround(target);
  return (int)std::llround(target * (double)(i-close+1)/(double)(full-close+1));
}
// 모노토닉 방출: 인필 라인들을 채움 법선축 투영값 기준 정렬 (top 솔리드가 한 방향으로 진행)
static void sort_monotonic(Paths& lines, double angleDeg) {
  double a = angleDeg*PI/180.0, nx=-std::sin(a), ny=std::cos(a);
  std::stable_sort(lines.begin(), lines.end(), [&](const Path& A, const Path& B){
    if (A.empty()||B.empty()) return false;
    double pa=(A[0].x()*INV)*nx+(A[0].y()*INV)*ny, pb=(B[0].x()*INV)*nx+(B[0].y()*INV)*ny;
    return pa < pb;
  });
}
struct DPt { double x, y; };
// 3점 외접원 (center, r) — 아크 피팅용
static bool circle_from3(DPt a, DPt b, DPt c, double& cx, double& cy, double& r) {
  double d = 2.0*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));
  if (std::fabs(d) < 1e-9) return false;
  double aa=a.x*a.x+a.y*a.y, bb=b.x*b.x+b.y*b.y, cc=c.x*c.x+c.y*c.y;
  cx = (aa*(b.y-c.y)+bb*(c.y-a.y)+cc*(a.y-b.y))/d;
  cy = (aa*(c.x-b.x)+bb*(a.x-c.x)+cc*(b.x-a.x))/d;
  r  = std::hypot(a.x-cx, a.y-cy);
  return true;
}
// 심 컨텍스트 (aligned=이전 레이어 심, random=결정적 LCG)
struct SeamCtx { double lastX=0, lastY=0; bool has=false; uint32_t rng=1; };
static uint32_t lcg(uint32_t& s){ s = s*1664525u + 1013904223u; return s; }
// 심 모드: 0=back(Y최대) 1=nearest(노즐 최근접) 2=aligned(이전심) 3=random, -1=회전 안함
static void rotate_seam(Path& p, int mode, SeamCtx& sc, double nozX, double nozY) {
  if (mode < 0 || p.size() < 3) return;
  size_t best = 0;
  if (mode == 0 || (mode == 2 && !sc.has)) {          // back / aligned 첫 레이어
    cInt by=p[0].y(); for (size_t i=1;i<p.size();++i) if (p[i].y()>by){ by=p[i].y(); best=i; }
  } else if (mode == 1 || mode == 2) {                 // nearest 노즐 / aligned 이전심
    double tx = (mode==1)?nozX:sc.lastX, ty=(mode==1)?nozY:sc.lastY, bd=1e30;
    for (size_t i=0;i<p.size();++i){ double dd=std::hypot(p[i].x()*INV-tx, p[i].y()*INV-ty); if (dd<bd){bd=dd;best=i;} }
  } else {                                             // random (결정적)
    best = lcg(sc.rng) % p.size();
  }
  std::rotate(p.begin(), p.begin()+best, p.end());
}

// ---- G-code 라이터 (상대 E, z_hop, 파라미터 리트랙션) --------------------------
struct GW {
  std::string s;
  double px=0, py=0, z=0;
  double e_per_mm=0, filament=0;
  long   segments=0;
  int    curF=-1;
  double retract_len=0.8; int retractF=1800; // mm, mm/min
  double z_hop=0.0;
  double offX=128.0, offY=128.0;   // G-code XY 오프셋 = bed/2
  int    lastFan=-1;               // 냉각 팬 현재값 (변경 시만 M106)
  bool   arc_fitting=false;        // G2/G3 아크 피팅
  double scarf_len=10.0;           // scarf 심 램프 길이 (mm)
  // 6단계: PE-lite (인접 압출 체적유량 변화율 한도)
  double pe_slope=0.0;             // mm³/s² (0=off)
  double filament_area=2.405;      // π·d²/4 (프리앰블에서 설정)
  double last_vol_flow=-1.0;       // 직전 압출 체적유량 mm³/s (레이어 시작 리셋, 트래블선 미리셋)
  // 6단계: 벽 회피 트래블
  Paths  island;                   // 트래블 유지 구역(벽 안쪽). 비면 검사 안함.
  bool   avoid_walls=false;
  long   wall_crossings=0;         // 벽을 실제 횡단한 트래블 수(검산용)
  // 9단계: 실제 PE 태그 방출 (OrcaSlicer 형식)
  bool   emit_pe_tags=false;
  int    pe_cur_role=-1;
  char   buf[200];
  void pe_reset(){ last_vol_flow=-1.0; }
  // 압출 런 시작: role 전환 시 ;_EXTRUSION_ROLE, 그리고 G1 F<v> ;_EXTRUDE_SET_SPEED (블록 열기)
  //  curF=f 로 세팅해 이후 압출 G1 이 F 를 생략(SET_SPEED 속도 상속) — PE 가 블록 내 유량을 조정.
  void pe_begin_run(int role, int f){
    if (!emit_pe_tags) return;
    if (role != pe_cur_role) { std::snprintf(buf,sizeof buf,";_EXTRUSION_ROLE:%d",role); raw(buf); pe_cur_role=role; }
    std::snprintf(buf,sizeof buf,"G1 F%d ;_EXTRUDE_SET_SPEED",f); raw(buf); curF=f;
  }
  void pe_end_run(){ if (emit_pe_tags) raw(";_EXTRUDE_END"); }
  // PE-lite: 인접 압출 체적유량 변화율(mm³/s²) 한도. 세그먼트 시간 Δt=d/v_n, v_n=Fn/A 이므로
  //  slope = |Fn−Fl|·Fn/(d·A) ≤ pe_slope, S=pe_slope·d·A.
  //  가속(Fn>Fl): Fn 상한 = (Fl+√(Fl²+4S))/2.  감속(Fn<Fl): 급강하 구간(lo,hi) 이면 hi 로 제한(최소강하).
  //  세그먼트 분할 없이 세그먼트 단위 속도만 조정하는 근사(방출 시점).
  int pe_feed(double dist, int fReq){
    double A=e_per_mm*filament_area, vreq=fReq/60.0, desired=A*vreq;
    if (pe_slope<=0.0 || last_vol_flow<0.0 || dist<1e-6 || A<=1e-9) { last_vol_flow=desired; return fReq; }
    double Fl=last_vol_flow, Fn=desired, S=pe_slope*dist*A;
    if (desired > Fl) {                                     // 가속(유량↑)
      double cap=(Fl+std::sqrt(Fl*Fl+4.0*S))/2.0; if (Fn>cap) Fn=cap;
    } else if (desired < Fl) {                              // 감속(유량↓)
      double disc=Fl*Fl-4.0*S;
      if (disc>0) { double sq=std::sqrt(disc), hi=(Fl+sq)/2.0, lo=(Fl-sq)/2.0; if (Fn>lo && Fn<hi) Fn=hi; }
    }
    int fUse=(int)std::llround((Fn/A)*60.0); if (fUse<60) fUse=60;
    last_vol_flow=A*(fUse/60.0);
    return fUse;
  }
  void set_e_per_mm(double h, const Params& p) {
    double A = h * (p.line_width - h * (1.0 - PI/4.0));
    double fa = PI * p.filament_diameter * p.filament_diameter / 4.0;
    e_per_mm = A / fa * p.flow_ratio;
  }
  // 7단계: 임의 폭(가변폭 Arachne 벽)에서 유량 설정. 단면적 A=h·(w − h·(1−π/4)).
  void set_e_per_mm_width(double wseg, double h, const Params& p) {
    double A = h * (wseg - h * (1.0 - PI/4.0)); if (A < 0) A = 0;
    double fa = PI * p.filament_diameter * p.filament_diameter / 4.0;
    e_per_mm = A / fa * p.flow_ratio;
  }
  void raw(const char* c){ s += c; s += '\n'; }
  // 리트랙션 포함 직선 트래블 (원본 동작)
  void travel_raw(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    bool retract = d > TRAVEL_RETRACT_MIN && retract_len > 0;
    if (retract) {
      std::snprintf(buf,sizeof buf,"G1 E-%.4f F%d", retract_len, retractF); raw(buf);
      if (z_hop > 0) { std::snprintf(buf,sizeof buf,"G1 Z%.3f F%d", z + z_hop, fTravel); raw(buf); }
    }
    std::snprintf(buf,sizeof buf,"G0 X%.3f Y%.3f F%d", x+offX, y+offY, fTravel); raw(buf);
    if (retract) {
      if (z_hop > 0) { std::snprintf(buf,sizeof buf,"G1 Z%.3f F%d", z, fTravel); raw(buf); }
      std::snprintf(buf,sizeof buf,"G1 E%.4f F%d", retract_len, retractF); raw(buf);
    }
    px=x; py=y; curF=-1;
  }
  // 우회 내부 이동 (리트랙션 생략 — 재료 안쪽 유지, §6.5 데스크톱 동작)
  void travel_hop(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    std::snprintf(buf,sizeof buf,"G0 X%.3f Y%.3f F%d", x+offX, y+offY, fTravel); raw(buf);
    px=x; py=y; curF=-1;
  }
  // 직선 A→B 가 아일랜드(벽 안쪽) 안에 (거의) 전부 들어오면 true
  bool seg_inside(double ax,double ay,double bx,double by){
    if (island.empty()) return true;
    Path seg; seg.push_back(IntPoint((cInt)std::llround(ax*SCALE),(cInt)std::llround(ay*SCALE)));
    seg.push_back(IntPoint((cInt)std::llround(bx*SCALE),(cInt)std::llround(by*SCALE)));
    Paths one; one.push_back(seg);
    double full=std::hypot(bx-ax,by-ay), got=paths_len(clip_open(one, island), false);
    return got >= full - 0.05;
  }
  // 아일랜드 경계 우회 경로: A 최근접 폴리곤의 경계를 A근접정점→(짧은쪽)→B근접정점 으로 걷기
  std::vector<DPt> detour_path(double ax,double ay,double bx,double by){
    const Path* best=nullptr; double bestD=1e30;
    IntPoint pa((cInt)std::llround(ax*SCALE),(cInt)std::llround(ay*SCALE));
    for (const Path& poly : island){
      if (poly.size()<3 || Area(poly)<=0) continue;                 // 외곽(양수 면적)만
      if (PointInPolygon(pa, poly)!=0){ best=&poly; break; }
      for (const IntPoint& q:poly){ double dd=std::hypot(q.x()*INV-ax,q.y()*INV-ay); if(dd<bestD){bestD=dd;best=&poly;} }
    }
    if (!best) return {};
    const Path& poly=*best; int n=(int)poly.size();
    auto nearestIdx=[&](double x,double y){ int bi=0; double bd=1e30; for(int i=0;i<n;++i){double dd=std::hypot(poly[i].x()*INV-x,poly[i].y()*INV-y); if(dd<bd){bd=dd;bi=i;}} return bi; };
    int ia=nearestIdx(ax,ay), ib=nearestIdx(bx,by);
    if (ia==ib) return {};
    auto arcLen=[&](int dir){ double L=0; int i=ia; while(i!=ib){ int nx=(i+dir+n)%n; L+=std::hypot((poly[nx].x()-poly[i].x())*INV,(poly[nx].y()-poly[i].y())*INV); i=nx; } return L; };
    int dir = (arcLen(+1)<=arcLen(-1))?+1:-1;
    std::vector<DPt> way; way.push_back({poly[ia].x()*INV, poly[ia].y()*INV});
    int i=ia; while(i!=ib){ i=(i+dir+n)%n; way.push_back({poly[i].x()*INV, poly[i].y()*INV}); }
    return way;
  }
  // 스마트 트래블: 벽 횡단 검출 → (avoid 시) 경계 우회, 아니면 직선+횡단 카운트
  void travel(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    if (!island.empty() && !seg_inside(px,py,x,y)) {
      if (avoid_walls) {
        std::vector<DPt> way = detour_path(px,py,x,y);
        if (!way.empty()) { for (auto& wp:way) travel_hop(wp.x,wp.y,fTravel); travel_hop(x,y,fTravel); return; }
      }
      ++wall_crossings;                          // 우회 안 함/실패 → 실제 횡단
    }
    travel_raw(x, y, fTravel);
  }
  void extrude(double x, double y, int fPrint) {
    double d = std::hypot(x-px, y-py); if (d < 1e-9) return;
    int fUse = pe_feed(d, fPrint);               // PE-lite: 유량 변화율 한도 적용(off 면 fPrint)
    double dE = e_per_mm * d; filament += dE; ++segments;
    if (fUse != curF) { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f F%d", x+offX,y+offY,dE,fUse); curF=fUse; }
    else              { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f",     x+offX,y+offY,dE); }
    raw(buf); px=x; py=y;
  }
  // 스파이럴용: Z 를 함께 올리는 압출
  void extrude_z(double x, double y, double zz, int fPrint) {
    double d = std::hypot(x-px, y-py); if (d < 1e-9) { z=zz; return; }
    double dE = e_per_mm * d; filament += dE; ++segments;
    if (fPrint != curF) { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f F%d", x+offX,y+offY,zz,dE,fPrint); curF=fPrint; }
    else                { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f",     x+offX,y+offY,zz,dE); }
    raw(buf); px=x; py=y; z=zz;
  }
  // scarf 심용: Z 와 flow(E 배율)를 함께 적용하는 압출 (항상 Z 기입)
  void extrude_zf(double x, double y, double zz, double flowMul, int fPrint) {
    double d = std::hypot(x-px, y-py); if (d < 1e-9) { z=zz; return; }
    double dE = e_per_mm * d * flowMul; filament += dE; ++segments;
    if (fPrint != curF) { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f F%d", x+offX,y+offY,zz,dE,fPrint); curF=fPrint; }
    else                { std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f Z%.3f E%.5f",     x+offX,y+offY,zz,dE); }
    raw(buf); px=x; py=y; z=zz;
  }
  // 냉각 팬 (변경 시만 M106 방출)
  void set_fan(int S) { if (S==lastFan) return; lastFan=S; std::snprintf(buf,sizeof buf,"M106 S%d",S); raw(buf); }
  // 연속 폴리라인 방출 (pts[0]=현재 위치). arc_fitting 시 G2/G3, 아니면 G1.
  void extrude_run(const std::vector<DPt>& pts, int fPrint) {
    if (!arc_fitting) { for (size_t i=1;i<pts.size();++i) extrude(pts[i].x,pts[i].y,fPrint); return; }
    size_t i=0, n=pts.size();
    while (i+1<n) { size_t j=try_arc(pts,i,fPrint); if (j>i) i=j; else { extrude(pts[i+1].x,pts[i+1].y,fPrint); ++i; } }
  }
  // pts[i] 부터 원호 근사 (≥5점, 편차≤0.05mm, r 0.1~200, ≤~155°) → 성공 시 G2/G3 방출·끝 인덱스 반환
  size_t try_arc(const std::vector<DPt>& pts, size_t i, int fPrint) {
    const double RMIN=0.1, RMAX=200.0, MAXDEV=0.05;
    size_t n=pts.size(); if (i+4>=n) return i;
    size_t bestE=i; double bcx=0,bcy=0,br=0;
    for (size_t e=i+4; e<n; ++e) {
      size_t mid=i+(e-i)/2; double cx,cy,r;
      if (!circle_from3(pts[i],pts[mid],pts[e],cx,cy,r)) break;
      if (r<RMIN||r>RMAX) break;
      bool okAll=true;
      for (size_t k=i;k<=e;++k){ if (std::fabs(std::hypot(pts[k].x-cx,pts[k].y-cy)-r)>MAXDEV){okAll=false;break;} }
      if (!okAll) break;
      double a0=std::atan2(pts[i].y-cy,pts[i].x-cx), a1=std::atan2(pts[e].y-cy,pts[e].x-cx), sw=a1-a0;
      while(sw>PI)sw-=2*PI; while(sw<-PI)sw+=2*PI;
      if (std::fabs(sw)>2.7) break;                 // 전원(360°) 아크 회피
      bestE=e; bcx=cx; bcy=cy; br=r;
    }
    if (bestE < i+4) return i;
    DPt a=pts[i], c=pts[bestE];
    double a0=std::atan2(a.y-bcy,a.x-bcx), a1=std::atan2(c.y-bcy,c.x-bcx), sw=a1-a0;
    while(sw>PI)sw-=2*PI; while(sw<-PI)sw+=2*PI;
    bool ccw = sw>0;                                 // CCW → G3, CW → G2
    double arcLen=std::fabs(sw)*br, dE=e_per_mm*arcLen; filament+=dE; ++segments;
    double I=bcx-a.x, J=bcy-a.y;
    if (fPrint!=curF){ std::snprintf(buf,sizeof buf,"%s X%.3f Y%.3f I%.3f J%.3f E%.5f F%d",ccw?"G3":"G2",c.x+offX,c.y+offY,I,J,dE,fPrint); curF=fPrint; }
    else            { std::snprintf(buf,sizeof buf,"%s X%.3f Y%.3f I%.3f J%.3f E%.5f",   ccw?"G3":"G2",c.x+offX,c.y+offY,I,J,dE); }
    raw(buf); px=c.x; py=c.y;
    return bestE;
  }
};

// 툴패스 type: 0=travel,1=wall,2=sparse,3=solid,4=skirt/brim,5=support,6=raft,7=gap-fill,8=thin-wall,9=bridge,10=ironing,11=prime-tower
// 세그먼트별 폭 추적(7단계 가변폭 벽용). g_seg_w 가 설정돼 있으면 push_seg 마다 현재 폭을 병렬 배열에 기록.
//  (기존 paths 포맷 stride 8 불변 → 88개 테스트 무영향. widths 는 세그먼트당 1개 추가 배열, 옵션.)
static std::vector<float>* g_seg_w = nullptr;
static float g_seg_w_cur = 0.42f;
static inline void push_seg(std::vector<float>& v,double x0,double y0,double x1,double y1,double z,float type){
  v.push_back((float)x0);v.push_back((float)y0);v.push_back((float)z);v.push_back(type);
  v.push_back((float)x1);v.push_back((float)y1);v.push_back((float)z);v.push_back(type);
  if (g_seg_w) g_seg_w->push_back(g_seg_w_cur);
}
static em::val to_f32(const std::vector<float>& v){
  return em::val(em::typed_memory_view(v.size(), v.data())).call<em::val>("slice");
}
// 9단계: 툴패스 type → OrcaSlicer ExtrusionRole 정수 (PressureEqualizer 태그용, ExtrusionEntity.hpp enum)
//  0none 1perim 2extperim 4internalinfill 5solidinfill 8ironing 9bridge 11gapfill 12skirt 14support 17wipetower
static int pe_role_of(float type){
  switch ((int)type) {
    case 1: return 2;   // wall → erExternalPerimeter
    case 2: return 4;   // sparse → erInternalInfill
    case 3: return 5;   // solid → erSolidInfill
    case 4: return 12;  // skirt/brim → erSkirt
    case 5: return 14;  // support → erSupportMaterial
    case 6: return 14;  // raft → erSupportMaterial
    case 7: return 11;  // gap-fill → erGapFill
    case 8: return 1;   // thin-wall → erPerimeter
    case 9: return 9;   // bridge → erBridgeInfill
    case 10:return 8;   // ironing → erIroning
    case 11:return 17;  // prime-tower → erWipeTower
    default:return 0;   // erNone
  }
}
// 닫힌 루프(벽/스커트/래프트). seamMode: -1=회전없음, 0=back 1=nearest 2=aligned 3=random.
// updateSeam=true 면 시작점을 SeamCtx 에 기록(aligned 다음 레이어용).
static void emit_loops(GW& gw, std::vector<float>& tp, Paths loops, double z, float type, int fPrint, int fTravel,
                       int seamMode, SeamCtx& sc, bool updateSeam=false){
  bool anyRun=false;
  for (Path wp : loops) {
    if (wp.size() < 2) continue;
    if (!anyRun) { gw.pe_begin_run(pe_role_of(type), fPrint); anyRun=true; }
    rotate_seam(wp, seamMode, sc, gw.px, gw.py);
    std::vector<DPt> pts; pts.reserve(wp.size()+1);
    for (auto& q:wp) pts.push_back({q.x()*INV, q.y()*INV});
    pts.push_back(pts.front());                                   // 루프 닫기
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    gw.extrude_run(pts, fPrint);
    if (updateSeam) { sc.lastX=pts[0].x; sc.lastY=pts[0].y; sc.has=true; }
  }
  if (anyRun) gw.pe_end_run();
}
// 열린 라인(인필/서포트). 아크 피팅 적용.
static void emit_lines(GW& gw, std::vector<float>& tp, const Paths& lines, double z, float type, int fPrint, int fTravel){
  bool anyRun=false;
  for (const Path& ln : lines) {
    if (ln.size() < 2) continue;
    if (!anyRun) { gw.pe_begin_run(pe_role_of(type), fPrint); anyRun=true; }
    std::vector<DPt> pts; pts.reserve(ln.size());
    for (auto& q:ln) pts.push_back({q.x()*INV, q.y()*INV});
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    gw.extrude_run(pts, fPrint);
  }
  if (anyRun) gw.pe_end_run();
}
// 19단계: 오가닉 트리 서포트 방출 — 열린 폴리라인 + per-path 폭. 각 path 마다 set_e_per_mm_width 로 E 계산,
//  g_seg_w_cur 로 리본 렌더 폭 기록(인터페이스/본체 폭 차이가 E·렌더에 반영). 방출 후 기본 폭/E 복원.
static void emit_lines_vw(GW& gw, std::vector<float>& tp, const std::vector<std::pair<Path,float>>& lines,
                          double z, double h, const Params& p, float type, int fPrint, int fTravel){
  bool anyRun=false;
  for (const auto& lw : lines) {
    const Path& ln = lw.first;
    if (ln.size() < 2) continue;
    if (!anyRun) { gw.pe_begin_run(pe_role_of(type), fPrint); anyRun=true; }
    gw.set_e_per_mm_width(lw.second, h, p); g_seg_w_cur = lw.second;
    std::vector<DPt> pts; pts.reserve(ln.size());
    for (auto& q:ln) pts.push_back({q.x()*INV, q.y()*INV});
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    gw.extrude_run(pts, fPrint);
  }
  if (anyRun) gw.pe_end_run();
  g_seg_w_cur = (float)p.line_width; gw.set_e_per_mm(h, p);   // 기본 폭/E 복원
}
// 7단계: 이식된 실제 Arachne 가변폭 벽 방출. 세그먼트별 폭으로 E 계산(set_e_per_mm_width) + widths 기록.
static void emit_arachne_walls(GW& gw, std::vector<float>& tp, const std::vector<arachne_bridge::WLine>& walls,
                               double z, double h, const Params& p, int fPrint, int fTravel){
  bool anyRun=false;
  for (const auto& wl : walls) {
    if (wl.pts.size() < 2) continue;
    if (!anyRun) { gw.pe_begin_run(2 /*erExternalPerimeter*/, fPrint); anyRun=true; }
    push_seg(tp, gw.px, gw.py, wl.pts[0].x, wl.pts[0].y, z, 0.0f);
    gw.travel(wl.pts[0].x, wl.pts[0].y, fTravel);
    size_t n = wl.pts.size();
    for (size_t i=1;i<n;++i) {
      double sw = 0.5*(wl.pts[i-1].w + wl.pts[i].w);
      gw.set_e_per_mm_width(sw, h, p); g_seg_w_cur = (float)sw;
      push_seg(tp, wl.pts[i-1].x, wl.pts[i-1].y, wl.pts[i].x, wl.pts[i].y, z, 1.0f);
      gw.extrude(wl.pts[i].x, wl.pts[i].y, fPrint);
    }
    if (wl.closed) {
      double sw = 0.5*(wl.pts[n-1].w + wl.pts[0].w);
      gw.set_e_per_mm_width(sw, h, p); g_seg_w_cur = (float)sw;
      push_seg(tp, wl.pts[n-1].x, wl.pts[n-1].y, wl.pts[0].x, wl.pts[0].y, z, 1.0f);
      gw.extrude(wl.pts[0].x, wl.pts[0].y, fPrint);
    }
  }
  if (anyRun) gw.pe_end_run();
  g_seg_w_cur = (float)p.line_width;
}
// 스파이럴(vase): 단일 외벽을 둘레따라 z 를 z0→z0+h 로 연속 상승
static void emit_spiral(GW& gw, std::vector<float>& tp, const Paths& outerWall, double z0, double h, int fPrint, int fTravel){
  if (outerWall.empty() || outerWall[0].size()<2) return;
  const Path& wp = outerWall[0];
  std::vector<DPt> pts; for (auto& q:wp) pts.push_back({q.x()*INV, q.y()*INV}); pts.push_back(pts.front());
  push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z0, 0.0f);
  gw.travel(pts[0].x, pts[0].y, fTravel);
  double total=0; for (size_t i=1;i<pts.size();++i) total+=std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  double acc=0;
  for (size_t i=1;i<pts.size();++i){
    acc += std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
    double zz = z0 + h*(total>1e-9 ? acc/total : 0.0);
    gw.extrude_z(pts[i].x, pts[i].y, zz, fPrint);
    push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, zz, 1.0f);
  }
}
// Scarf joint 심(외벽 루프): 시작에서 z(z-h→z)·flow(0→1) 램프업, 끝에서 같은 길이 오버랩 램프다운(flow 1→0).
//  ⚠ 근사 — z-seam blob 대신 완만한 경사 조인트. seam_slope_type=external/all 시 외벽에만.
static void emit_scarf_loop(GW& gw, std::vector<float>& tp, Path wp, double z, double h,
                            int fPrint, int fTravel, int seamMode, SeamCtx& sc){
  if (wp.size() < 3) return;
  rotate_seam(wp, seamMode, sc, gw.px, gw.py);
  std::vector<DPt> pts; pts.reserve(wp.size()+1);
  for (auto& q:wp) pts.push_back({q.x()*INV, q.y()*INV});
  pts.push_back(pts.front());
  double L=0; for (size_t i=1;i<pts.size();++i) L+=std::hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  double slen = std::min(gw.scarf_len, 0.45*L); if (slen < 1e-3) slen = 0.45*L;
  push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
  gw.travel(pts[0].x, pts[0].y, fTravel);
  gw.raw("; scarf");
  double startZ = z - h;
  double sub = std::max(0.2, slen/8.0);   // 램프 세분 스텝(긴 직선벽도 z 연속 상승)
  // 램프업: 첫 slen 구간 z (z-h)→z, flow 0→1 (세그먼트 세분)
  double s=0; size_t i=1;
  for (; i<pts.size(); ++i){
    double segx=pts[i].x-pts[i-1].x, segy=pts[i].y-pts[i-1].y, seg=std::hypot(segx,segy);
    int steps = std::max(1, (int)std::ceil(seg/sub));
    for (int st=1; st<=steps; ++st){
      double f=(double)st/steps, x=pts[i-1].x+segx*f, y=pts[i-1].y+segy*f;
      double t=std::min(1.0, (s+seg*f)/slen), zz=startZ + h*t, flow=std::max(0.05, t);
      double ax=gw.px, ay=gw.py;
      gw.extrude_zf(x, y, zz, flow, fPrint);
      push_seg(tp, ax,ay, x,y, zz, 1.0f);
    }
    s+=seg; if (s>=slen) { ++i; break; }
  }
  // 평탄 중간: z, flow 1
  for (; i<pts.size(); ++i){
    double ax=gw.px, ay=gw.py;
    gw.extrude(pts[i].x, pts[i].y, fPrint);
    push_seg(tp, ax,ay, pts[i].x,pts[i].y, z, 1.0f);
  }
  // 오버랩 램프다운: 시작부터 slen 재추적, z 유지·flow 1→0 (램프업 상단 마감)
  double s2=0;
  for (size_t k=1;k<pts.size();++k){
    double segx=pts[k].x-pts[k-1].x, segy=pts[k].y-pts[k-1].y, seg=std::hypot(segx,segy);
    int steps = std::max(1, (int)std::ceil(seg/sub));
    for (int st=1; st<=steps; ++st){
      double f=(double)st/steps, x=pts[k-1].x+segx*f, y=pts[k-1].y+segy*f;
      double t=std::min(1.0,(s2+seg*f)/slen), flow=std::max(0.05, 1.0-t);
      double ax=gw.px, ay=gw.py;
      gw.extrude_zf(x, y, z, flow, fPrint);
      push_seg(tp, ax,ay, x,y, z, 1.0f);
    }
    s2+=seg; if (s2>=slen) break;
  }
  sc.lastX=pts[0].x; sc.lastY=pts[0].y; sc.has=true;
}

// 레이어 데이터 (2-pass)
struct LayerData {
  double z=0; int idx=0; double h=0;
  Paths contour;                 // 외곽 윤곽(구멍 포함)
  std::vector<Paths> walls;      // 벽 루프 (외→내 순서)
  Paths fill;                    // 인필 영역 (최내벽 -w/2)
  Paths topSurf, botSurf;        // 노출 표면 (이웃 Difference)
  Paths supBase, supIface;       // 서포트 본체(sparse) / 인터페이스(solid)
  std::vector<std::pair<Path,float>> supTree;  // 18/19단계: 실 오가닉 트리 서포트 툴패스(폴리라인+per-path 폭, type5)
  Paths thin;                    // 씬월(폭<2w) 영역 — 중심선 1줄로 처리
  std::vector<arachne_bridge::WLine> arachneWalls;  // 7단계: 실제 Arachne 가변폭 벽 (arachne 모드)
};

// 삼각형 부분집합[lo,hi) 을 z 평면에서 슬라이스 → 윤곽
static Paths slice_group(const std::vector<Tri>& tris, int lo, int hi, double z){
  std::vector<Seg> segs; Seg sg;
  for (int ti=lo; ti<hi; ++ti){ const Tri& t=tris[ti];
    double zmin=std::min({t.v[0].z,t.v[1].z,t.v[2].z}), zmax=std::max({t.v[0].z,t.v[1].z,t.v[2].z});
    if (z<zmin||z>=zmax) continue; if (tri_plane(t,z,sg)) segs.push_back(sg); }
  return SimplifyPolygons(chain_polys(segs), pftEvenOdd);
}
// =============================================================================
// 멀티머티리얼 기초 (스트레치): 삼각형 그룹 2개(mm_group_split)를 레이어 내 분리 슬라이스,
//  그룹 전환 시 T0/T1 + 간단 프라임 타워(베드 구석 15×15 사각 링, 전환 레이어에만).
//  ⚠ 와이프타워 본격 구현 아님 — 퍼지/램밍/와이프량 계산·타워 밀도 최적화 없음. 벽+스파스 인필만.
// =============================================================================
static em::val slice_multimaterial(std::vector<Tri>& tris, const Params& p, em::val onProgress,
                                   double height, bool over_bed){
  auto report=[&](int d,int t){ if(!onProgress.isUndefined()&&!onProgress.isNull()) onProgress(d,t); };
  const double w=p.line_width;
  int split=p.mm_group_split, NT=(int)tris.size();
  int N=0; for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) ++N;

  GW gw; gw.s.reserve(1<<16);
  gw.retract_len=p.retract_length; gw.retractF=(int)std::llround(p.retract_speed*60); gw.z_hop=p.z_hop;
  gw.offX=p.bed_width*0.5; gw.offY=p.bed_depth*0.5;
  gw.filament_area=PI*p.filament_diameter*p.filament_diameter/4.0;
  SeamCtx seamCtx;
  gw.raw("; OrcaSlicer RE mini-kernel (Track C stage 6) — MULTIMATERIAL (basic, NOT a real wipe tower)");
  { char h[200];
    std::snprintf(h,sizeof h,"; MM extruders=%d group_split=%d/%d  lh=%.3f lw=%.3f walls=%d infill=%.2f",
      p.extruder_count,split,NT,p.layer_height,w,p.wall_loops,p.infill_density); gw.raw(h);
    std::snprintf(h,sizeof h,"M140 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M104 S%.0f",p.nozzle_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M190 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M109 S%.0f",p.nozzle_temp); gw.raw(h); }
  gw.raw("G21 ; mm"); gw.raw("G90 ; absolute XYZ"); gw.raw("M83 ; relative E");
  gw.raw("T0 ; start extruder"); gw.raw("G92 E0");

  int fTravel=(int)std::llround(p.travel_speed*60);
  double sparse_sp=(p.infill_density>1e-4)?(w/p.infill_density):(w*3.0);
  // 프라임 타워: 베드 구석(G-code≈10,10) 15×15 동심 사각 링 (모델좌표=gcode−off)
  double ptx=10.0-gw.offX, pty=10.0-gw.offY;
  auto primeRings=[&](){ Paths ps; for(int k=0;k<3;++k){ double o=k*w; double x0=ptx+o,y0=pty+o,x1=ptx+15-o,y1=pty+15-o;
    Path r; r.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y0*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y0*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y1*SCALE)));
    r.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y1*SCALE))); ps.push_back(r);} return ps; };

  em::val layersArr=em::val::array();
  int curTool=0;
  double zShift=0.0;
  for (int i=0;i<N;++i){
    double z=p.first_layer_height + (i>0? i*p.layer_height : 0.0);   // 대략적 z
    double zE=z+zShift, h=(i==0)?p.first_layer_height:p.layer_height;
    gw.set_e_per_mm(h,p); gw.z=zE; gw.pe_reset();
    std::vector<float> tp, widths; g_seg_w = &widths; g_seg_w_cur = (float)p.line_width;   // 21단계: MM widths 기록
    char cm[64]; std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.raw(cm);
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
    int fPr=(int)std::llround(((i==0)?p.first_layer_speed:p.print_speed)*60);

    Paths c0=slice_group(tris,0,split,z), c1=slice_group(tris,split,NT,z);
    gw.island = Paths{};
    auto emitGroup=[&](const Paths& contour){
      if (contour.empty()) return;
      Paths last=contour; std::vector<Paths> walls;
      for (int wl=0; wl<p.wall_loops; ++wl){ Paths wp=offset_paths(contour,-(w*0.5+wl*w)); if(wp.empty())break; walls.push_back(wp); last=wp; }
      for (auto& wpz:walls) emit_loops(gw,tp,wpz,zE,1.0f,fPr,fTravel,-1,seamCtx);
      Paths fill = last.empty()?Paths{}:offset_paths(last,-w*0.5);
      if (!fill.empty()){ Paths lines=infill_clipped(fill,(i%2?135.0:45.0),sparse_sp); if(!lines.empty()) emit_lines(gw,tp,lines,zE,2.0f,fPr,fTravel); }
    };
    auto toolTo=[&](int t){ if(curTool!=t){ gw.raw(t==0?"T0":"T1"); curTool=t; } };

    if (!c0.empty()){ toolTo(0); emitGroup(c0); }
    if (!c1.empty()){
      if (!c0.empty()){                                   // 레이어 내 전환 → 프라임 타워
        toolTo(1);
        if (p.wipe_tower_real) {                          // 12단계: 실 WipeTower.generate()
          auto wt = config_bridge::wipe_tower_block(p.bed_width,p.bed_depth,p.first_layer_height,
                        p.layer_height, zE, i==0, 0, 1, /*tower bed x,y*/10.0, 10.0,
                        p.prime_tower_width, p.filament_diameter);
          if (wt.ok) {
            gw.raw("; wipe_tower_real: real ported WipeTower.generate()");
            gw.raw(wt.gcode.c_str());
            gw.filament += wt.filament_mm;
            for (float f : wt.toolpath) tp.push_back(f);
          } else {                                        // 실패 시 사각링 폴백
            gw.raw("; prime tower (fallback square ring)");
            emit_loops(gw,tp,primeRings(),zE,11.0f,fPr,fTravel,-1,seamCtx);
          }
        } else {
          gw.raw("; prime tower (basic — NOT a real wipe tower)");
          emit_loops(gw,tp,primeRings(),zE,11.0f,fPr,fTravel,-1,seamCtx);
        }
      } else toolTo(1);
      emitGroup(c1);
    }
    em::val Lo=em::val::object(); Lo.set("z",zE); Lo.set("paths",to_f32(tp)); Lo.set("widths",to_f32(widths)); layersArr.call<void>("push",Lo);
    report(i+1,N);
  }
  g_seg_w = nullptr;   // 21단계: MM widths(로컬) 수명 종료
  gw.raw("; end"); gw.raw("M104 S0"); gw.raw("M140 S0"); gw.raw("M107");
  { char h[64]; std::snprintf(h,sizeof h,"; filament used: %.2f mm",gw.filament); gw.raw(h); }
  em::val result=em::val::object(), stats=em::val::object();
  stats.set("layers",N); stats.set("model_layers",N); stats.set("raft_layers",0);
  stats.set("path_segments",(double)gw.segments); stats.set("filament_mm",gw.filament);
  stats.set("over_bed",over_bed); stats.set("wall_crossings",(double)gw.wall_crossings);
  stats.set("extruders",p.extruder_count);
  result.set("gcode",gw.s); result.set("stats",stats); result.set("layers",layersArr);
  return result;
}

// =============================================================================
// 30단계: 레이어 스트리밍 싱크. 뷰어(worker)가 set_layer_sink(cb) 로 등록하면 slice() 가 배치 상주 대신
//  레이어마다 cb(z, layerIndex, gcodeChunk, pathsF32, widthsF32) 로 방출하고 그 레이어 버퍼를 힙에서 해제한다
//  (§6.8 output 스트리밍 회귀). 싱크 미등록 시 기존 배치 경로(byte-identical). 함수-로컬 static 이라 런타임
//  기동 후 최초 호출 때 안전 초기화(전역 em::val 정적초기화 순서 문제 회피). 동시에 한 슬라이스만 가정.
static em::val& layer_sink() { static em::val s = em::val::undefined(); return s; }
static void set_layer_sink(em::val cb) { layer_sink() = cb; }
static void clear_layer_sink() { layer_sink() = em::val::undefined(); }

// PE 태그 제거(상태 없는 줄 단위 필터) — 배치는 전체 g-code, 스트리밍은 청크마다 적용(청크는 '\n' 경계라
//  줄이 잘리지 않아 동일 결과). ;_EXTRUSION_ROLE/;_EXTRUDE_END 줄 삭제 + ;_EXTRUDE_SET_SPEED/
//  ;_EXTERNAL_PERIMETER 접미 주석 제거(G1 F 라인은 보존).
static void strip_pe_tags(std::string& g) {
  std::string out; out.reserve(g.size());
  size_t i=0, n=g.size();
  while (i<n) {
    size_t e=g.find('\n', i); if (e==std::string::npos) e=n;
    std::string line=g.substr(i, e-i);
    bool drop=false;
    if (line.compare(0,17,";_EXTRUSION_ROLE:")==0) drop=true;
    else if (line.compare(0,13,";_EXTRUDE_END")==0) drop=true;
    if (!drop) {
      size_t t;
      if ((t=line.find(" ;_EXTRUDE_SET_SPEED"))!=std::string::npos) line.erase(t);
      else if ((t=line.find(";_EXTRUDE_SET_SPEED"))!=std::string::npos) line.erase(t);
      if ((t=line.find(";_EXTERNAL_PERIMETER"))!=std::string::npos) line.erase(t);
      while (!line.empty() && (line.back()==' '||line.back()=='\t')) line.pop_back();
      out += line; out += '\n';
    }
    i = e+1;
  }
  g.swap(out);
}

// slice(Uint8Array stl, string paramsJson, function onProgress) → { gcode, stats, layers[] }
// =============================================================================
em::val slice(em::val stl_bytes, std::string params_json, em::val onProgress) {
  auto report = [&](int done, int total){ if (!onProgress.isUndefined() && !onProgress.isNull()) onProgress(done, total); };
  Params p = parse_params(params_json);
  if (p.spiral_mode) p.wall_loops = 1;                 // vase: 단일 외벽
  std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl_bytes);
  std::vector<Tri> tris = parse_stl(bytes);

  em::val result = em::val::object();
  if (tris.empty()) { result.set("error", std::string("STL 파싱 실패 또는 삼각형 0개")); return result; }

  // 모델을 XY원점 중심·minZ=0 이동
  double minx=1e18,miny=1e18,minz=1e18,maxx=-1e18,maxy=-1e18,maxz=-1e18;
  for (auto& t:tris) for (int k=0;k<3;++k){
    minx=std::min(minx,(double)t.v[k].x);maxx=std::max(maxx,(double)t.v[k].x);
    miny=std::min(miny,(double)t.v[k].y);maxy=std::max(maxy,(double)t.v[k].y);
    minz=std::min(minz,(double)t.v[k].z);maxz=std::max(maxz,(double)t.v[k].z); }
  double cx=(minx+maxx)/2, cy=(miny+maxy)/2;
  // 28단계 P2: auto_center=true 면 결합 bbox 를 원점 재정렬(레거시). false(기본)=XY 뷰어 좌표 그대로, Z 만 안착.
  if (p.auto_center) { for (auto& t:tris) for (int k=0;k<3;++k){ t.v[k].x-=cx; t.v[k].y-=cy; t.v[k].z-=minz; } }
  else               { for (auto& t:tris) for (int k=0;k<3;++k){ t.v[k].z-=minz; } }
  double height = maxz - minz;
  double modelW = maxx - minx, modelD = maxy - miny;
  // over_bed: 크기 초과 || (뷰어 좌표 모드) G-code(+bed/2) 가 베드[0,bed]를 벗어나는 위치(원좌표 [-bed/2,bed/2] 밖)
  bool over_bed = (modelW > p.bed_width) || (modelD > p.bed_depth);
  if (!p.auto_center) over_bed = over_bed || maxx > p.bed_width*0.5 || minx < -p.bed_width*0.5
                                          || maxy > p.bed_depth*0.5 || miny < -p.bed_depth*0.5;

  const double w = p.line_width;
  const double sparse_spacing  = (p.infill_density > 1e-4) ? (w / p.infill_density) : 0.0;
  const double solid_spacing   = w;   // 솔리드 = 100% 채움
  const double support_spacing = (p.support_density > 1e-4) ? (w / p.support_density) : (w*3.0);

  // 멀티머티리얼(스트레치): 그룹 2개면 분리 슬라이스 + T0/T1 + 프라임 타워 경로로 분기
  if (p.extruder_count >= 2 && p.mm_group_split > 0 && p.mm_group_split < (int)tris.size())
    return slice_multimaterial(tris, p, onProgress, height, over_bed);

  // z 레벨 수 세기 (진행률 total)
  int N = 0; for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) ++N;
  int total = 2*N;

  // 스테이지 계측 (stats 로만 노출 — g-code 무영향, golden 안전)
  double tw0 = emscripten_get_now(), tw_p1 = 0, tw_p15 = 0, tw_sup = 0;

  // ---- PASS 1: 레이어별 윤곽·벽·인필영역 ----
  //  레이어 간 의존 0 (읽기: tris/p 공유 불변, 쓰기: L[i] 독립) → -pthread 빌드에서 레이어 병렬.
  //  z 는 기존 누적 루프(z+=layer_height)와 동일하게 직렬 선계산 — FP 누적 순서 보존(golden 안전).
  std::vector<LayerData> L(N);
  { std::vector<double> zsv; zsv.reserve(N);
    for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) zsv.push_back(z);
    auto computeLayer = [&](int i) {
      const double z = zsv[i];
      LayerData ld; ld.z=z; ld.idx=i; ld.h=(i==0)?p.first_layer_height:p.layer_height;
      std::vector<Seg> segs; Seg sg;
      for (const Tri& t:tris){ double zmin=std::min({t.v[0].z,t.v[1].z,t.v[2].z}),zmax=std::max({t.v[0].z,t.v[1].z,t.v[2].z});
        if (z<zmin||z>=zmax) continue; if (tri_plane(t,z,sg)) segs.push_back(sg); }
      Paths loops = chain_polys(segs);
      ld.contour = SimplifyPolygons(loops, pftEvenOdd);
      if (!ld.contour.empty()) {
        // 씬월(Arachne-lite): 폭<2w 라 벽 오프셋이 소실되는 영역 검출 → 벽 대신 중심선 1줄.
        //  두꺼운 코어(morph_open, 폭≥2w)에서만 벽 생성 → 얇은 부위 이중압출 방지.
        //  ⚠ 완전한 Arachne(가변폭 스켈레톤) 아님 — 단일 중심선 근사.
        Paths wallBase = ld.contour;
        Paths core = morph_open(ld.contour, w);
        Paths thin = clip_paths(ld.contour, core, ctDifference);
        thin = offset_paths(offset_paths(thin, -w*0.15), w*0.15);   // <0.3w 슬리버 노이즈 제거
        if (!thin.empty() && paths_area(thin) > w*w) { ld.thin = thin; wallBase = core; }
        Paths last = wallBase;
        for (int wl=0; wl<p.wall_loops; ++wl) {
          Paths wpaths = offset_paths(wallBase, -(w*0.5 + wl*w));
          if (wpaths.empty()) break;
          ld.walls.push_back(wpaths); last = wpaths;
        }
        if (!last.empty()) ld.fill = offset_paths(last, -(w*0.5));
        // 7단계: arachne 모드 → 실제 이식된 WallToolPaths 로 가변폭 벽 생성(벽만 대체, fill 은 classic 유지).
        if (p.wall_generator == "arachne") {
          std::vector<std::vector<std::pair<double,double>>> polys;
          for (const Path& pth : ld.contour) {
            std::vector<std::pair<double,double>> poly; poly.reserve(pth.size());
            for (const IntPoint& q : pth) poly.push_back({q.x()*INV, q.y()*INV});
            if (poly.size() >= 3) polys.push_back(std::move(poly));
          }
          ld.arachneWalls = arachne_bridge::generate_walls(polys, w, p.wall_loops, ld.h);
          ld.thin.clear();   // arachne 가 얇은 영역을 가변폭 벽으로 직접 처리 → classic 씬월 비활성
        }
      }
      L[i] = std::move(ld);
    };
#ifdef __EMSCRIPTEN_PTHREADS__
    { unsigned hw = std::thread::hardware_concurrency();
      unsigned nt = std::max(1u, std::min<unsigned>(hw ? hw : 4, (unsigned)N));
      std::atomic<int> nextIdx{0};
      auto workfn = [&]{ int i; while ((i = nextIdx.fetch_add(1)) < N) computeLayer(i); };
      std::vector<std::thread> ths; ths.reserve(nt-1);
      for (unsigned t=1; t<nt; ++t) ths.emplace_back(workfn);
      workfn();                                  // 메인 스레드도 참여
      for (auto& th : ths) th.join();
      report(N, total);                          // JS 콜백은 메인 스레드 전용 → 코스 단위 보고
    }
#else
    for (int i=0;i<N;++i){ computeLayer(i); report(i+1, total); }
#endif
  }

  tw_p1 = emscripten_get_now();

  // ---- PASS 1.5: 표면 검출 (이 레이어 fill − 이웃 contour) ----
  for (int i=0;i<N;++i) {
    if (L[i].fill.empty()) continue;
    Paths above = (i+1<N) ? L[i+1].contour : Paths{};
    Paths below = (i-1>=0) ? L[i-1].contour : Paths{};
    L[i].topSurf = clip_paths(L[i].fill, above, ctDifference);  // 위가 비면 top 표면
    L[i].botSurf = clip_paths(L[i].fill, below, ctDifference);  // 아래가 비면 bottom 표면
  }

  tw_p15 = emscripten_get_now();

  // ---- PASS 1.6: 서포트 (오버행 검출 → 수직 투영 → iface/base) ----
  double treeZMaxResid = -1.0; int treeSupLayers = 0;   // 19단계: 트리 서포트 z 정합 진단(오브젝트 z 그리드와 오차)
  if (p.enable_support) {
   if (p.support_style == "tree") {
    // 18단계: 실 오가닉 TreeSupport(generate_tree_support_3D) — 커널 lslices(mm)로 파사드 PrintObject
    //  그래프 구성 → TreeSupport::generate() → SupportLayer::support_fills(브랜치 툴패스)를 type5 로 방출.
    //  grid/tree_lite(단순 하강 근사)와 별개 경로. treesupport_bridge 가 ODR 경계(포트 타입 격리).
    // 28단계 P2: 뷰어 좌표(auto_center=false)면 모델이 원점 밖 → 트리 브릿지(generate_tree_support_3D 포트)가
    //  원점 밖 좌표에서 메모리 접근 위반. 링을 모델 XY중심 만큼 원점으로 이동해 브릿지에 넘기고, 브랜치 출력은
    //  그만큼 되돌려(모델 위치) 방출 → 크래시 회피 + P2 겹침 보존(왕복: 입력 −tcx, 출력 +tcx). auto_center=true 면 이미 원점.
    // 31단계: 모델은 원점 중심(작은 좌표 = 안전 영역)으로 유지한다. 서포트가 한쪽만 나오던 버그는 브릿지의
    //  printable_area(=machine_border) 가 [0,bed] 양수 사분면이라 원점중심 모델의 음수-X/Y 절반 서포트를
    //  intersection_ex 로 클립하던 것 → treesupport_bridge_impl.cpp 에서 border 를 **원점 중심**([-bed/2,bed/2])으로
    //  변경해 해결(모델 좌표는 그대로 작게 유지 → 큰 좌표에서 재발한 교차-슬라이스 OOB 도 회피).
    const double tcx = p.auto_center ? 0.0 : cx, tcy = p.auto_center ? 0.0 : cy;
    std::vector<std::vector<treesupport_bridge::Ring>> slices(N);
    std::vector<double> zs(N);
    for (int j=0;j<N;++j) {
      zs[j] = L[j].z;
      for (const Path& ring : L[j].contour) {
        treesupport_bridge::Ring r; r.reserve(ring.size());
        for (const IntPoint& pt : ring) r.emplace_back(pt.x()*INV - tcx, pt.y()*INV - tcy);
        if (r.size()>=3) slices[j].push_back(std::move(r));
      }
    }
    treesupport_bridge::Params tsp;
    tsp.layer_height_mm=p.layer_height; tsp.nozzle_mm=p.nozzle_diameter;
    tsp.support_threshold_angle=p.support_threshold_angle;
    tsp.support_top_z_distance=p.support_top_z_distance;
    tsp.support_xy_distance=p.support_xy_distance;
    tsp.interface_top_layers=p.support_interface_top_layers;
    tsp.support_auto=p.support_auto;                                // 20단계: 자동/수동(페인트 enforcer만)
    tsp.support_line_width_mm=p.support_line_width;                 // 19단계: 실 서포트 압출폭(config→flow→per-path)
    tsp.bed_width_mm=p.bed_width; tsp.bed_depth_mm=p.bed_depth;
    std::vector<treesupport_bridge::LayerOut> tlayers = treesupport_bridge::generate(slices, zs, tsp);
    for (const treesupport_bridge::LayerOut& lo : tlayers) {
      // 19단계 z 정합: 서포트 레이어는 오브젝트 레이어와 동기(layer_z 가 동일 slicing_params 사용)되므로
      //  print_z 가 오브젝트 z 그리드 위에 정확히 놓인다. 최소잔차 오브젝트 레이어에 바인딩하고 잔차를 기록
      //  → treeZMaxResid≈0 이면 "nearest"가 곧 "exact"임을 실증(오차 0). 방출 Z 는 그 오브젝트 레이어의 print_z.
      int best=-1; double bestd=1e18;
      for (int j=0;j<N;++j){ double d=std::fabs(L[j].z - lo.print_z_mm); if(d<bestd){bestd=d;best=j;} }
      if (best<0) continue;
      treeZMaxResid = std::max(treeZMaxResid, bestd); ++treeSupLayers;
      for (const treesupport_bridge::Line& ln : lo.lines) {
        Path pl; pl.reserve(ln.pts.size());
        for (const auto& xy : ln.pts)
          pl.push_back(IntPoint((cInt)std::llround((xy.first+tcx)*SCALE),(cInt)std::llround((xy.second+tcy)*SCALE)));  // 28단계: 모델 위치로 복귀
        if (pl.size()>=2) L[best].supTree.push_back({std::move(pl), (float)ln.width});  // per-path 폭 보존(19단계)
      }
    }
   } else {
    double maxStep = std::tan(p.support_threshold_angle * PI/180.0) * p.layer_height; // 층당 허용 수평 이동
    double openR = w * 0.6;                                                            // 슬리버 제거 반경
    int gap = std::max(1, (int)std::llround(p.support_top_z_distance / p.layer_height)); // 접촉 z 간격(층)
    int ifaceN = std::max(1, p.support_interface_top_layers);
    // 20단계: 수동 페인트 enforcer/blocker → 레이어별 폴리곤(slice_mesh_slabs 투영, facade 와 동일 slice_z)
    std::vector<double> sliceZs(N); for (int j=0;j<N;++j) sliceZs[j]=L[j].z - p.layer_height*0.5;
    auto projToPaths=[&](bool enf)->std::vector<Paths>{
      auto pl = selector_bridge::project_layers(sliceZs, enf);
      std::vector<Paths> out(N);
      for (int j=0;j<N && j<(int)pl.size();++j) for (auto& ring:pl[j]) {
        Path pa; pa.reserve(ring.size());
        for (auto& xy:ring) pa.push_back(IntPoint((cInt)std::llround(xy.first*SCALE),(cInt)std::llround(xy.second*SCALE)));
        if (pa.size()>=3) out[j].push_back(std::move(pa));
      }
      return out;
    };
    std::vector<Paths> enfL = projToPaths(true), blkL = projToPaths(false);
    // 오버행: contour_i − offset(contour_{i-1}, +maxStep), open 으로 노이즈 제거 (수동 모드면 자동검출 생략)
    std::vector<Paths> overhang(N);
    if (p.support_auto) for (int i=1;i<N;++i) {
      // 32단계 Fix A: 하층이 비어도(부유 파트, 풀 z-gap 위) skip 하지 않는다 — 하층 없으면
      //  offset(empty)=empty 라 clip 결과가 contour_i 전체 = 전면 오버행 → 그 아래 서포트 생성.
      if (L[i].contour.empty()) continue;
      Paths oh = clip_paths(L[i].contour, offset_paths(L[i-1].contour, maxStep), ctDifference);
      if (oh.empty()) continue;
      oh = offset_paths(oh, -openR); oh = offset_paths(oh, openR);
      overhang[i] = oh;
    }
    // enforcer: 페인트 영역을 오버행으로 강제 추가(아래로 서포트 컬럼 투영). blocker: 오버행에서 차감(그 아래
    //  컬럼 미생성) — tree generate_overhangs 와 동일 의미(overhangs -= blockers).
    for (int i=0;i<N;++i) if (!enfL[i].empty()) overhang[i] = union_paths(overhang[i], enfL[i]);
    for (int i=0;i<N;++i) if (!blkL[i].empty()) overhang[i] = clip_paths(overhang[i], blkL[i], ctDifference);
    // 하강 투영: 위→아래. grid = 수직 union(일정 단면). tree_lite = 층마다 -0.5mm 수축(최소
    //  기둥 반경 1.5mm 유지) 후 union 병합 → 위 넓고 아래 좁은 나무형.
    //  ⚠ 오가닉 트리(가지 분기/각도 최적화) 아님 — 단순 하강 테이퍼 근사.
    bool treeLite = (p.support_style == "tree_lite");
    std::vector<Paths> column(N);
    Paths accum;
    if (!treeLite) {
      for (int j=N-1;j>=0;--j) { int src=j+gap; if (src<N) accum = union_paths(accum, overhang[src]); column[j]=accum; }
    } else {
      const double shrink=0.5, minR=1.5;
      for (int j=N-1;j>=0;--j) {
        accum = tree_taper(accum, shrink, minR);                       // 층당 테이퍼(최소기둥 유지)
        int src=j+gap; if (src<N) accum = union_paths(accum, overhang[src]);  // 이 층 오버행 추가(상단 넓음)
        column[j]=accum;
      }
    }
    // 32단계 Fix B: 바닥 z-gap(support_bottom_z_distance) — 모델 상면에 얹히는 서포트 바닥과 상면 사이 간격.
    //  botGap 레이어 = round(dist/lh). 기본 0.2/0.2=1 → 아래 추가 클립 루프 미실행 → 현행과 동일(golden byte-identical).
    int botGap = std::max(1, (int)std::llround(p.support_bottom_z_distance / p.layer_height));
    // 레이어별 iface(solid)/base(sparse) 분리 + 모델 회피
    for (int j=0;j<N;++j) {
      if (column[j].empty()) continue;
      Paths modelClear = offset_paths(L[j].contour, p.support_xy_distance);
      // 바닥 z-gap: 바로 아래 (botGap-1) 레이어의 모델 상면 위 서포트도 제거 → 서포트가 모델 상면에서 botGap 만큼 떠서 시작.
      for (int k=1;k<botGap;++k){ int b=j-k; if (b>=0 && !L[b].contour.empty()) modelClear = union_paths(modelClear, offset_paths(L[b].contour, p.support_xy_distance)); }
      Paths col = clip_paths(column[j], modelClear, ctDifference);
      if (col.empty()) continue;
      Paths iface;
      for (int k=0;k<ifaceN;++k){ int s=j+gap+k; if (s<N) iface = union_paths(iface, overhang[s]); }
      iface = clip_paths(iface, col, ctIntersection);
      L[j].supIface = iface;
      L[j].supBase  = clip_paths(col, iface, ctDifference);
    }
   }
  }

  // ---- 프리앰블 ----
  GW gw; gw.s.reserve(1<<17);
  gw.retract_len = p.retract_length;
  gw.retractF    = (int)std::llround(p.retract_speed * 60);
  gw.z_hop       = p.z_hop;
  gw.offX        = p.bed_width  * 0.5;
  gw.offY        = p.bed_depth  * 0.5;
  gw.arc_fitting = p.enable_arc_fitting;
  gw.scarf_len   = p.scarf_length;
  gw.pe_slope    = (p.pe_lite ? std::max(0.0, p.max_volumetric_extrusion_rate_slope) : 0.0);   // in-kernel PE-lite only when pe_lite; else real PE post-processes
  gw.filament_area = PI * p.filament_diameter * p.filament_diameter / 4.0;
  gw.avoid_walls = p.reduce_crossing_wall;                                 // 벽 회피 트래블
  bool realPE    = (!p.pe_lite && p.max_volumetric_extrusion_rate_slope > 0);
  gw.emit_pe_tags = p.emit_pe_tags || realPE;                             // 실제 PE 사용 시 태그 자동 방출
  bool ironOn    = (p.ironing_type=="top" || p.ironing_type=="topmost" || p.ironing_type=="solid");
  bool scarfOn   = (p.seam_slope_type=="external" || p.seam_slope_type=="all");
  int seamMode = (p.seam_position=="nearest")?1 : (p.seam_position=="aligned")?2 : (p.seam_position=="random")?3 : 0; // 기본 back
  SeamCtx seamCtx;
  gw.raw("; OrcaSlicer RE mini-kernel (Track C stage 6) — NOT full libslic3r");
  { char h[320];
    std::snprintf(h,sizeof h,"; params: lh=%.3f flh=%.3f lw=%.3f walls=%d infill=%.2f@%.0fdeg top=%d bottom=%d",
      p.layer_height,p.first_layer_height,p.line_width,p.wall_loops,p.infill_density,p.infill_angle,p.top_shell_layers,p.bottom_shell_layers); gw.raw(h);
    std::snprintf(h,sizeof h,"; skirt=%d@%.1fmm brim=%.1fmm retract=%.2fmm@%.0fmm/s zhop=%.2fmm",
      p.skirt_loops,p.skirt_distance,p.brim_width,p.retract_length,p.retract_speed,p.z_hop); gw.raw(h);
    std::snprintf(h,sizeof h,"; support=%d angle=%.0f density=%.2f topz=%.2f xy=%.2f iface=%d  raft=%d  bed=%.0fx%.0f off=%.1f,%.1f",
      p.enable_support?1:0,p.support_threshold_angle,p.support_density,p.support_top_z_distance,p.support_xy_distance,
      p.support_interface_top_layers,p.raft_layers,p.bed_width,p.bed_depth,gw.offX,gw.offY); gw.raw(h);
    if (treeSupLayers > 0) {   // 19단계: 트리 서포트 z 정합 진단(오브젝트 z 그리드 대비 최대 잔차, mm)
      std::snprintf(h,sizeof h,"; tree_support layers=%d z_resid_max=%.6fmm", treeSupLayers, treeZMaxResid); gw.raw(h);
    }
    std::snprintf(h,sizeof h,"; pattern=%s fan=%.0f%% closeFan=%d fullFan=%d slowT=%.0fs arc=%d seam=%s spiral=%d",
      p.sparse_infill_pattern.c_str(),p.fan_speed,p.close_fan_the_first_x_layers,p.full_fan_speed_layer,
      p.slow_down_layer_time,p.enable_arc_fitting?1:0,p.seam_position.c_str(),p.spiral_mode?1:0); gw.raw(h);
    std::snprintf(h,sizeof h,"; speeds(mm/s): print=%.0f first=%.0f travel=%.0f  temps: nozzle=%.0f bed=%.0f",
      p.print_speed,p.first_layer_speed,p.travel_speed,p.nozzle_temp,p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"; scarf=%s@%.0fmm support_style=%s bridge=%.0fmm/s PA=%d@%.3f",
      p.seam_slope_type.c_str(),p.scarf_length,p.support_style.c_str(),p.bridge_speed,
      p.enable_pressure_advance?1:0,p.pressure_advance); gw.raw(h);
    std::snprintf(h,sizeof h,"; ironing=%s@%.2fmm flow=%.0f%% spd=%.0f  reduce_crossing_wall=%d  PE_slope=%.1f  extruders=%d",
      p.ironing_type.c_str(),p.ironing_spacing,p.ironing_flow,p.ironing_speed,
      p.reduce_crossing_wall?1:0,p.max_volumetric_extrusion_rate_slope,p.extruder_count); gw.raw(h);
    std::snprintf(h,sizeof h,"M140 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M104 S%.0f",p.nozzle_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M190 S%.0f",p.bed_temp); gw.raw(h);
    std::snprintf(h,sizeof h,"M109 S%.0f",p.nozzle_temp); gw.raw(h);
  }
  gw.raw("G21 ; mm"); gw.raw("G90 ; absolute XYZ"); gw.raw("M83 ; relative E");
  // 압력 어드밴스: Marlin M900 K<v>. Klipper 는 SET_PRESSURE_ADVANCE 인데 여기선 주석 표기만.
  if (p.enable_pressure_advance) {
    char h[96];
    std::snprintf(h,sizeof h,"M900 K%.3f ; pressure advance (Marlin/RRF)",p.pressure_advance); gw.raw(h);
    std::snprintf(h,sizeof h,"; SET_PRESSURE_ADVANCE ADVANCE=%.3f  ; (Klipper 대체 — 주석 표기)",p.pressure_advance); gw.raw(h);
  }
  gw.raw("; (no G28 homing — mini-kernel preamble)"); gw.raw("G92 E0");

  int fTravel = (int)std::llround(p.travel_speed*60);
  int fFirst  = (int)std::llround(p.first_layer_speed*60);
  em::val layersArr = em::val::array();

  // 30단계: 스트리밍 설정 — 레이어 싱크가 등록됐고 실제 PE(전체-문자열 교차레이어 평활)를 쓰지 않을 때만
  //  스트리밍(청크 방출 후 gw.s 해제). realPE 는 전체 g-code 가 필요해 배치로 폴백(옵트인·golden 경로 밖).
  em::val& sink = layer_sink();
  bool streaming = (!sink.isUndefined() && !sink.isNull() && !realPE);
  bool economy   = streaming && p.economy;      // 절약: 툴패스·시간추정(r.moves 대량 상주) 생략, G-code 만
  bool streamTime = streaming && !economy;      // 스트리밍 시간추정(청크 피드) — 절약 모드는 생략
  // 시간추정 머신 한계(스트리밍/배치 공용) — p 에만 의존하므로 루프 전에 1회 구성.
  gcode_time::Limits glim;
  glim.max_speed[0]=glim.max_speed[1]=(float)p.machine_max_speed_xy;
  glim.max_speed[2]=(float)p.machine_max_speed_z; glim.max_speed[3]=(float)p.machine_max_speed_e;
  glim.max_jerk[0]=glim.max_jerk[1]=(float)p.machine_jerk_xy;
  glim.max_jerk[2]=(float)p.machine_jerk_z; glim.max_jerk[3]=(float)p.machine_jerk_e;
  glim.accel_print=(float)p.machine_accel_print; glim.accel_travel=(float)p.machine_accel_travel; glim.accel_retract=(float)p.machine_accel_retract;
  gcodeproc_bridge::Limits gl;
  for (int k=0;k<4;++k){ gl.max_speed[k]=glim.max_speed[k]; gl.max_accel[k]=glim.max_accel[k]; gl.max_jerk[k]=glim.max_jerk[k]; }
  gl.accel_print=glim.accel_print; gl.accel_travel=glim.accel_travel; gl.accel_retract=glim.accel_retract;
  gl.min_extrude_rate=glim.min_extrude_rate; gl.min_travel_rate=glim.min_travel_rate;
  if (streamTime) gcodeproc_bridge::estimate_begin(gl);
  // 레이어 방출: 배치=layersArr 누적, 스트리밍=청크(gw.s 직전 flush 이후분)+툴패스 방출 후 gw.s 해제.
  //  프리앰블은 첫 flush 청크에, 마무리는 마지막 flush 청크에 포함 → 청크 이어붙이면 배치 gw.s 와 byte-identical.
  auto flush_layer = [&](double z, int idx, std::vector<float>& tp, std::vector<float>& widths) {
    if (!streaming) {
      em::val Lo=em::val::object(); Lo.set("z",z); Lo.set("paths",to_f32(tp)); Lo.set("widths",to_f32(widths));
      layersArr.call<void>("push", Lo); return;
    }
    std::string chunk; chunk.swap(gw.s);                 // 누적분 인출 + gw.s 비움(힙 해제)
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(chunk);   // 줄 단위 무상태 필터(청크=배치 동일)
    if (streamTime) gcodeproc_bridge::estimate_feed(chunk);
    em::val paths = economy ? em::val::array() : to_f32(tp);
    em::val wid   = economy ? em::val::array() : to_f32(widths);
    sink(z, idx, chunk, paths, wid);
  };

  // ---- 래프트 (모델 아래 삽입, 모델 z 시프트) ----
  double zShift = 0.0;
  int nraft = std::max(0, p.raft_layers);
  if (nraft > 0 && !L.empty() && !L[0].contour.empty()) {
    const double raftFirstH = 0.30;
    Paths base = L[0].contour;
    base = union_paths(base, L[0].supIface);
    base = union_paths(base, L[0].supBase);
    Paths raftArea = offset_paths(base, 3.0);   // +3mm 팽창 베이스
    double rz = raftFirstH;
    gw.set_fan(0);                               // 래프트(첫 레이어들)는 팬 off
    for (int k=0;k<nraft;++k) {
      double rh = (k==0) ? raftFirstH : p.layer_height;
      gw.set_e_per_mm(rh, p); gw.z = rz;
      std::vector<float> tp, widths; g_seg_w = &widths; g_seg_w_cur = (float)w;   // 21단계: 래프트 widths 기록
      char cm[64]; std::snprintf(cm,sizeof cm,"; raft %d Z%.3f",k,rz); gw.raw(cm);
      std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",rz,fTravel); gw.raw(cm);
      if (k==0) {
        for (int s=0;s<p.skirt_loops;++s){ Paths r=offset_paths(raftArea,(p.skirt_distance+w*0.5+s*w)); emit_loops(gw,tp,r,rz,4.0f,fFirst,fTravel,-1,seamCtx); }
        emit_lines(gw, tp, infill_clipped(raftArea, 0.0, w), rz, 6.0f, fFirst, fTravel);        // 첫 래프트: solid
      } else {
        emit_lines(gw, tp, infill_clipped(raftArea, (k%2)?90.0:0.0, w/0.5), rz, 6.0f, fFirst, fTravel); // 이후: sparse
      }
      flush_layer(rz, k, tp, widths);
      rz += p.layer_height;
    }
    g_seg_w = nullptr;   // 21단계: 래프트 widths(로컬) 수명 종료 → 댕글링 방지
    zShift = raftFirstH + (nraft-1)*p.layer_height;   // 모델 첫 레이어 Z = zShift + first_layer_height
  }

  tw_sup = emscripten_get_now();

  // ---- PASS 2: 솔리드/스파스 인필 분리 + 서포트 + 방출 ----
  for (int i=0;i<N;++i) {
    LayerData& ld = L[i];
    double zE = ld.z + zShift;                                        // 실제 방출 Z (래프트 시프트)
    gw.set_e_per_mm(ld.h, p);
    gw.z = zE;
    gw.pe_reset();                                                    // PE-lite: 레이어 시작 유량 컨텍스트 리셋
    gw.island = ld.contour.empty() ? Paths{} : offset_paths(ld.contour, -w*0.5);  // 벽 회피: 트래블 유지 구역(항상 검출, avoid 시만 우회)
    seamCtx.rng = 2654435761u * (uint32_t)(i+1);                      // 레이어별 결정적 난수 시드(random 심)
    std::vector<float> tp;
    std::vector<float> widths; g_seg_w = &widths; g_seg_w_cur = (float)w;  // 7단계: 세그먼트별 폭 병렬 기록

    char cm[72];
    if (ld.contour.empty()) {
      std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f (empty)",i,zE); gw.raw(cm);
      flush_layer(zE, i, tp, widths);
      report(N+i+1, total); continue;
    }
    std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.raw(cm);
    gw.set_fan(fan_S(i, p));                                          // 냉각 팬 램프

    // ===== 스파이럴(vase): 단일 외벽 z-램프 (인필/솔리드/서포트 없음) =====
    if (p.spiral_mode) {
      std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
      int fSp = (int)std::llround(((i==0&&nraft==0)?p.first_layer_speed:p.print_speed)*60);
      emit_spiral(gw, tp, ld.walls.empty()?Paths{}:ld.walls[0], zE, ld.h, fSp, fTravel);
      flush_layer(zE, i, tp, widths);
      report(N+i+1, total); continue;
    }
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);

    // --- 방출 경로 미리 계산 (레이어 시간 추정 → 슬로다운 속도) ---
    // 갭필: 최내벽 안쪽 fill 의 morphological-open 잔여(폭<w 얇은 틈) → 중심선 근사(단일폭 라인).
    //  ⚠ 근사 — 메디얼축/가변폭 아님. open(X)=dilate(erode(X)), 잔여=X−open. fillCore 에서 제외해 이중압출 방지.
    Paths gap, fillCore = ld.fill;
    if (!ld.fill.empty()) {
      Paths opened = morph_open(ld.fill, w*0.5);
      gap = clip_paths(ld.fill, opened, ctDifference);
      gap = offset_paths(offset_paths(gap, -w*0.1), w*0.1);            // <0.2w 노이즈 제거
      if (!gap.empty()) fillCore = clip_paths(ld.fill, gap, ctDifference);
    }
    Paths gapLines = gap.empty() ? Paths{} : infill_clipped(gap, p.infill_angle, w);

    // 씬월 중심선(폭<2w 영역) — 성분별 장축 중심선 1줄 + 국소폭 flow 보정
    struct ThinRun { Paths line; double flow; };
    std::vector<ThinRun> thinRuns;
    if (!ld.thin.empty()) {
      for (const Paths& comp : split_components(ld.thin)) {
        Paths line = centerline_of(comp, w);
        if (line.empty()) continue;
        double A = paths_area(comp), Ln = paths_len(line,false);
        double width = (Ln>1e-3) ? A/Ln : w;
        thinRuns.push_back({std::move(line), std::min(2.0, std::max(0.4, width/w))});
      }
    }

    Paths topSolid, botSolid;
    for (int j=i; j<=std::min(N-1, i + p.top_shell_layers - 1); ++j) topSolid = union_paths(topSolid, L[j].topSurf);
    for (int j=std::max(0, i - p.bottom_shell_layers + 1); j<=i; ++j) botSolid = union_paths(botSolid, L[j].botSurf);
    Paths solid  = clip_paths(union_paths(topSolid, botSolid), fillCore, ctIntersection);
    // 브리지: 이 층(i>0) 노출 bottom ∩ 솔리드 중 서포트로 받쳐지지 않는 부분 → 팬100%+bridge_speed 감속
    Paths bridge;
    if (i>0 && !ld.botSurf.empty()) {
      bridge = clip_paths(solid, ld.botSurf, ctIntersection);
      if (p.enable_support && !L[i-1].supIface.empty())
        bridge = clip_paths(bridge, offset_paths(L[i-1].supIface, w), ctDifference);   // 서포트 접촉면은 브리지 아님
      if (!bridge.empty()) solid = clip_paths(solid, bridge, ctDifference);            // 일반 솔리드에서 분리
    }
    Paths sparse = clip_paths(fillCore, solid, ctDifference);
    double sa = (i%2==0) ? 45.0 : 135.0;
    // 21단계: 피처별 폭(첫 레이어는 initial_layer 로 일괄). 기본(모든 피처 0→line_width) 시 값 동일 → 무회귀.
    bool firstL = (i==0 && nraft==0);
    double wOuter  = firstL ? p.initial_layer_line_width : p.outer_wall_line_width;
    double wInner  = firstL ? p.initial_layer_line_width : p.inner_wall_line_width;
    double wSolid  = firstL ? p.initial_layer_line_width : p.internal_solid_infill_line_width;
    double wTop    = firstL ? p.initial_layer_line_width : p.top_surface_line_width;
    double wSparse = firstL ? p.initial_layer_line_width : p.sparse_infill_line_width;
    // top-surface 를 solid 에서 분리(top_surface_line_width 적용)는 폭이 다를 때만 — 같으면 단일 solid(무회귀).
    Paths topPart, restSolid = solid;
    if (!topSolid.empty() && std::abs(wTop - wSolid) > 1e-6) {
      topPart   = clip_paths(solid, topSolid, ctIntersection);
      restSolid = clip_paths(solid, topPart, ctDifference);
    }
    Paths solidLines = restSolid.empty() ? Paths{} : infill_clipped(restSolid, sa, solid_spacing);
    if (!solidLines.empty()) sort_monotonic(solidLines, sa);
    Paths topLines  = topPart.empty() ? Paths{} : infill_clipped(topPart, sa, solid_spacing);
    if (!topLines.empty()) sort_monotonic(topLines, sa);
    Paths bridgeLines = bridge.empty() ? Paths{} : infill_clipped(bridge, sa, solid_spacing);
    Paths sparseLines = (sparse_spacing>0 && !sparse.empty())
        ? build_sparse(sparse, p.sparse_infill_pattern, p.infill_angle, sparse_spacing, i, zE, w, p.infill_density) : Paths{};
    Paths supI = (p.enable_support && !ld.supIface.empty()) ? infill_clipped(ld.supIface, 0.0, solid_spacing)   : Paths{};
    Paths supB = (p.enable_support && !ld.supBase.empty())  ? infill_clipped(ld.supBase,  0.0, support_spacing) : Paths{};
    Paths flExtra; bool brim=false;                                    // 첫 레이어 스커트/브림
    if (i==0 && nraft==0) {
      int brimRings = (int)std::llround(p.brim_width / w); brim = brimRings>0;
      for (int k=0; k<p.skirt_loops; ++k) { Paths r=offset_paths(ld.contour,(p.skirt_distance+w*0.5+k*w)); for (auto& q:r) flExtra.push_back(q); }
      for (int k=1; k<=brimRings; ++k)     { Paths r=offset_paths(ld.contour,(w*0.5+k*w));                for (auto& q:r) flExtra.push_back(q); }
    }

    double thinLen=0; for (auto& tr:thinRuns) thinLen += paths_len(tr.line,false);
    double layerLen = vwalls_len(ld.walls) + paths_len(solidLines,false) + paths_len(sparseLines,false)
                    + paths_len(supI,false) + paths_len(supB,false) + paths_len(flExtra,true)
                    + paths_len(gapLines,false) + paths_len(bridgeLines,false) + thinLen;
    double baseSpeed = (i==0 && nraft==0) ? p.first_layer_speed : p.print_speed;
    double useSpeed = baseSpeed;
    if (p.slow_down_layer_time > 0 && layerLen > 1e-6 && layerLen/baseSpeed < p.slow_down_layer_time)
      useSpeed = std::min(baseSpeed, std::max(20.0, layerLen / p.slow_down_layer_time));   // 소형 레이어 감속(최저 20mm/s)
    int fPrint = (int)std::llround(useSpeed*60);
    int fBridge = (int)std::llround(std::max(5.0, p.bridge_speed)*60);

    // 21단계: 피처 폭 적용 헬퍼 — set_e_per_mm_width(E)+g_seg_w_cur(리본) 동시. 기본(0.42) 시 기존과 동일값.
    auto setW = [&](double ww){ gw.set_e_per_mm_width(ww, ld.h, p); g_seg_w_cur = (float)ww; };

    // --- 방출: 서포트 → 스커트/브림 → 벽(심/scarf) → 씬월 → 갭필 → 브리지 → 솔리드 → 스파스 ---
    if (!supI.empty() || !supB.empty()) {
      gw.raw("; support");
      if (!supI.empty()) emit_lines(gw, tp, supI, zE, 5.0f, fPrint, fTravel);
      if (!supB.empty()) emit_lines(gw, tp, supB, zE, 5.0f, fPrint, fTravel);
    }
    if (p.enable_support && !ld.supTree.empty()) {                    // 18/19단계: 실 오가닉 트리 서포트(per-path 폭)
      gw.raw("; support (organic tree — real ported TreeSupport)");
      emit_lines_vw(gw, tp, ld.supTree, zE, ld.h, p, 5.0f, fPrint, fTravel);
    }
    if (!flExtra.empty()) { gw.raw(brim ? "; skirt/brim" : "; skirt"); emit_loops(gw, tp, flExtra, zE, 4.0f, fPrint, fTravel, -1, seamCtx); }
    if (p.wall_generator=="arachne" && !ld.arachneWalls.empty()) {
      gw.raw("; walls (Arachne — real ported WallToolPaths, variable width)");
      emit_arachne_walls(gw, tp, ld.arachneWalls, zE, ld.h, p, fPrint, fTravel);
      gw.set_e_per_mm(ld.h, p); g_seg_w_cur=(float)w;   // 폭/유량 기본값 복원(이후 인필용)
    } else {
      for (size_t wi=0; wi<ld.walls.size(); ++wi) {
        setW(wi==0 ? wOuter : wInner);   // 21단계: 외벽(wi==0)=outer_wall_line_width, 내벽=inner_wall_line_width
        if (wi==0 && scarfOn) { for (Path wp : ld.walls[wi]) emit_scarf_loop(gw, tp, wp, zE, ld.h, fPrint, fTravel, seamMode, seamCtx); }
        else                    emit_loops(gw, tp, ld.walls[wi], zE, 1.0f, fPrint, fTravel, seamMode, seamCtx, wi==0);  // 외벽(wi==0)만 심 기록
      }
    }
    if (!thinRuns.empty()) {
      gw.raw("; thin-wall (Arachne-lite: single centerline, NOT full Arachne)");
      gw.pe_reset();                                 // 저유량 씬월은 PE 유량매칭 대상서 제외(단면 급변 회피)
      double saved = gw.e_per_mm;
      for (auto& tr : thinRuns) { gw.e_per_mm = saved * tr.flow; emit_lines(gw, tp, tr.line, zE, 8.0f, fPrint, fTravel); }
      gw.e_per_mm = saved; gw.pe_reset();
    }
    setW(firstL ? p.initial_layer_line_width : p.line_width);   // 21단계: gap/bridge 는 기본 폭
    if (!gapLines.empty()) { gw.raw("; gap-fill"); emit_lines(gw, tp, gapLines, zE, 7.0f, fPrint, fTravel); }
    if (!bridgeLines.empty()) {
      gw.raw("; bridge (unsupported bottom: fan 100% + bridge_speed)");
      int savedFan = gw.lastFan; gw.set_fan(255);
      emit_lines(gw, tp, bridgeLines, zE, 9.0f, fBridge, fTravel);
      gw.set_fan(savedFan < 0 ? 0 : savedFan);
    }
    if (!solidLines.empty()) { setW(wSolid); emit_lines(gw, tp, solidLines, zE, 3.0f, fPrint, fTravel); }   // 21단계: internal solid 폭
    if (!topLines.empty())   { setW(wTop);   emit_lines(gw, tp, topLines,   zE, 3.0f, fPrint, fTravel); }   // 21단계: top-surface 폭
    if (!sparseLines.empty()){ setW(wSparse);emit_lines(gw, tp, sparseLines,zE, 2.0f, fPrint, fTravel); }   // 21단계: sparse infill 폭

    // 아이어닝(type10): 노출 top 솔리드 위에 같은 z 로 저유량 재패스(간격 ironing_spacing, flow%, ironing_speed).
    if (ironOn && !ld.topSurf.empty()) {
      Paths ironArea = clip_paths(ld.topSurf, fillCore, ctIntersection);
      Paths ironLines = ironArea.empty() ? Paths{} : infill_clipped(ironArea, sa+45.0, std::max(0.05, p.ironing_spacing));
      if (!ironLines.empty()) {
        gw.raw("; ironing");
        gw.pe_reset();                               // 저유량 아이어닝은 PE 유량매칭 대상서 제외
        int fIron = (int)std::llround(std::max(5.0, p.ironing_speed)*60);
        double saved = gw.e_per_mm; gw.e_per_mm = saved * std::max(0.0, p.ironing_flow/100.0);
        emit_lines(gw, tp, ironLines, zE, 10.0f, fIron, fTravel);
        gw.e_per_mm = saved; gw.pe_reset();
      }
    }

    flush_layer(zE, i, tp, widths);
    report(N+i+1, total);
  }
  g_seg_w = nullptr;   // 7단계: 폭 추적 종료(로컬 widths 수명 종료)

  // ---- 종료 ----
  gw.raw("; end"); gw.raw("M104 S0"); gw.raw("M140 S0"); gw.raw("M107");
  { char h[64]; std::snprintf(h,sizeof h,"; filament used: %.2f mm", gw.filament); gw.raw(h); }

  gcode_time::Result te; std::string engine_used;
  auto absorb = [&](const gcodeproc_bridge::Result& fr){
    te.total_s=fr.total_s; te.first_layer_s=fr.first_layer_s; te.extrude_s=fr.extrude_s; te.travel_s=fr.travel_s;
    te.filament_mm=fr.filament_mm; te.moves=fr.moves; te.layer_s=fr.layer_s; te.role_s=fr.role_s;
  };
  if (streaming) {
    // 30단계: 마무리 청크(; end … 필라멘트 주석) 방출 후 스트리밍 시간추정 종료. G-code/layers 는 콜백으로
    //  이미 방출됐고 gw.s 는 비어 있음(레이어별 해제). 절약 모드는 시간추정 자체를 건너뛴다.
    { std::vector<float> empty; flush_layer(gw.z, N + nraft, empty, empty); }
    if (streamTime) {
      gcodeproc_bridge::Result fr = gcodeproc_bridge::estimate_end();
      if (fr.ok) { absorb(fr); engine_used = "full-stream"; } else engine_used = "stream-notime";
    } else engine_used = "economy";
  } else {
    // 배치: 실제 PressureEqualizer(옵트인) → 태그 제거 → 전체 g-code 시간추정(byte-identical 경로 불변).
    if (realPE)
      gw.s = pe_bridge::equalize(gw.s, p.filament_diameter, p.max_volumetric_extrusion_rate_slope,
                                 p.extrusion_rate_slope_segment_length, /*relative_e*/true, p.pe_external_perimeter_only);
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(gw.s);
    if (p.time_engine == "transcribed") {
      te = gcode_time::estimate(gw.s, glim); engine_used = "transcribed";
    } else {
      gcodeproc_bridge::Result fr = gcodeproc_bridge::estimate(gw.s, gl);
      if (fr.ok) { absorb(fr); engine_used = "full"; }
      else { te = gcode_time::estimate(gw.s, glim); engine_used = "full-fallback-transcribed"; }
    }
  }

  em::val stats = em::val::object();
  stats.set("layers", N + nraft);          // 총 방출 레이어(래프트 포함) = layers 배열 길이
  stats.set("model_layers", N);
  stats.set("raft_layers", nraft);
  stats.set("path_segments", (double)gw.segments);
  stats.set("filament_mm", gw.filament);
  stats.set("wall_crossings", (double)gw.wall_crossings);   // 벽 횡단 트래블 수(reduce_crossing_wall 검산)
  { double tw_end = emscripten_get_now();                    // 스테이지 계측(ms) — 병렬화 대상 판정용
    stats.set("t_pass1_ms",   tw_p1  - tw0);
    stats.set("t_surface_ms", tw_p15 - tw_p1);
    stats.set("t_support_ms", tw_sup - tw_p15);
    stats.set("t_emit_ms",    tw_end - tw_sup); }
  stats.set("over_bed", over_bed);
  // 원본 시간추정 결과
  stats.set("time_estimate", te.total_s);                   // 총 예상 출력 시간(초)
  stats.set("first_layer_time", te.first_layer_s);
  stats.set("time_extrude", te.extrude_s);
  stats.set("time_travel", te.travel_s);
  stats.set("time_filament_mm", te.filament_mm);            // 파싱 기반 필라멘트 사용량(gw.filament 대조용)
  stats.set("time_moves", (double)te.moves);
  { em::val lt=em::val::array(); for (size_t k=0;k<te.layer_s.size();++k) lt.call<void>("push", te.layer_s[k]);
    stats.set("layer_times", lt); }
  { em::val rt=em::val::object(); for (auto& kv:te.role_s) rt.set(std::to_string(kv.first), kv.second);
    stats.set("role_times", rt); }
  stats.set("time_engine", engine_used);                    // 13단계: 사용된 시간추정 엔진(full|transcribed|fallback)
  stats.set("streamed", streaming);                          // 30단계: true 면 g-code/layers 는 콜백으로 방출됨(result 에 없음)
  stats.set("economy", economy);                             // 30단계: 절약 모드(툴패스·시간추정 생략)로 완주했는지
  result.set("stats", stats);
  if (!streaming) { result.set("gcode", gw.s); result.set("layers", layersArr); }  // 스트리밍은 상주분 방출 안 함
  return result;
}

// 12단계: 실 config 서브시스템이 본선 모듈에 링크됐음을 노출/증명(dead-strip 방지 + node 검증용).
static double heap_size() { return (double)emscripten_get_heap_size(); }   // 30단계: 현재 WASM 힙 크기(바이트)=피크
static int config_option_count() { return config_bridge::option_count(); }
static std::string config_option_default(const std::string& key) { return config_bridge::option_default(key); }

// ---- 20단계: 수동 서포트 페인팅 (TriangleSelector) 커널 배선 ----
// selector 는 slice() 와 동일한 변환(XY 바운딩박스 중심·minZ=0)의 용접(weld) 메시로 구성 → 페이셋 인덱스·
// 좌표가 슬라이스와 정합. 뷰어는 로드 시 selector_prepare(stl) 1회 → 드래그마다 selector_paint → slice().
static void selector_prepare(em::val stl) {
  std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl);
  std::vector<Tri> tris = parse_stl(bytes);
  if (tris.empty()) { selector_bridge::construct({}, {}); return; }
  double minx=1e18,miny=1e18,minz=1e18,maxx=-1e18,maxy=-1e18,maxz=-1e18;
  for (auto& t:tris) for (int k=0;k<3;++k){
    minx=std::min(minx,(double)t.v[k].x);maxx=std::max(maxx,(double)t.v[k].x);
    miny=std::min(miny,(double)t.v[k].y);maxy=std::max(maxy,(double)t.v[k].y);
    minz=std::min(minz,(double)t.v[k].z);maxz=std::max(maxz,(double)t.v[k].z); }
  // 28단계 P2: 슬라이스 기본(auto_center=false)과 정합 — XY 재정렬 없이 Z 만 안착(뷰어 좌표 신뢰).
  // weld: dedup vertices (quantized, EXACT tuple key — an XOR hash collides and destroys topology)
  //  preserving triangle order → facet i == parse order i (viewer raycast face index match).
  std::vector<float> verts; std::vector<int> idx; std::map<std::array<long long,3>,int> vmap;
  auto add=[&](double x,double y,double z)->int{
    std::array<long long,3> k{ (long long)std::llround(x*1e4), (long long)std::llround(y*1e4), (long long)std::llround(z*1e4) };
    auto it=vmap.find(k); if(it!=vmap.end()) return it->second;
    int id=(int)(verts.size()/3); verts.push_back((float)x);verts.push_back((float)y);verts.push_back((float)z); vmap[k]=id; return id; };
  for (auto& t:tris) for (int k=0;k<3;++k)
    idx.push_back(add(t.v[k].x, t.v[k].y, t.v[k].z-minz));   // 28단계: XY 그대로(뷰어 좌표), Z 안착
  selector_bridge::construct(verts, idx);
}
static void selector_paint(int facet, float hx,float hy,float hz, float cx,float cy,float cz, float radius, bool enforcer) {
  selector_bridge::paint(facet, hx,hy,hz, cx,cy,cz, radius, enforcer);
}
static void selector_clear() { selector_bridge::clear(); }
static int  selector_facet_count() { return selector_bridge::facet_count(); }
static int  selector_painted_count(bool enforcer) { return selector_bridge::painted_count(enforcer); }
static em::val selector_overlay(bool enforcer) { return to_f32(selector_bridge::overlay(enforcer)); }
static em::val selector_project_counts(em::val zsVal, bool enforcer) {   // debug: #polys per z
  std::vector<double> zs = em::convertJSArrayToNumberVector<double>(zsVal);
  auto pl = selector_bridge::project_layers(zs, enforcer);
  std::vector<float> counts; counts.reserve(pl.size());
  for (auto& layer : pl) counts.push_back((float)layer.size());
  return to_f32(counts);
}

EMSCRIPTEN_BINDINGS(slicer) {
  em::function("slice", &slice);
  em::function("set_layer_sink", &set_layer_sink);           // 30단계: cb(z,idx,gcodeChunk,pathsF32,widthsF32) 등록 → 스트리밍
  em::function("clear_layer_sink", &clear_layer_sink);       //  등록 해제(다음 slice 는 배치)
  em::function("heap_size", &heap_size);                     // 30단계: WASM 힙 피크 측정용(바이트)
  em::function("config_option_count", &config_option_count);
  em::function("config_option_default", &config_option_default);
  em::function("cgal_planar_check_count", &arachne_bridge::cgal_planar_check_count); // 14단계: 실 CGAL 평면성 검사 호출 수
  em::function("selector_prepare", &selector_prepare);       // 20단계: 로드 시 메시 등록
  em::function("selector_paint", &selector_paint);           //  드래그마다 sphere 커서 페인트
  em::function("selector_clear", &selector_clear);
  em::function("selector_facet_count", &selector_facet_count);
  em::function("selector_painted_count", &selector_painted_count);
  em::function("selector_overlay", &selector_overlay);       //  오버레이 삼각형(enforcer=파랑/blocker=빨강)
  em::function("selector_project_counts", &selector_project_counts); // 디버그: z별 투영 폴리곤 수
}
