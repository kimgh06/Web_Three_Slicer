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
#include <mutex>     // (mt) 시간추정 오버랩 큐 — __EMSCRIPTEN_PTHREADS__ 빌드에서만 실사용
#include <condition_variable>
#include <deque>
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
// 33단계: BED_CENTER(=128.0, 256mm 베드 가정) 제거 — 선언만 있고 참조처가 없었다(실측).
//  베드 중심은 실제로 gw.offX/offY = bed_width/depth * 0.5 로 계산된다.
// TRAVEL_RETRACT_MIN 도 제거 — p.retraction_minimum_travel 로 배선.

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
  // 33단계: 하드코딩 제거 — 원본 설정 키 배선(기본값은 config-schema 원본 default 와 일치)
  double support_angle=0.0;                             // support_angle: 서포트 본체 기준 각도(°). 원본 SupportParameters::base_angle
  std::string support_base_pattern="default";           // support_base_pattern: default|rectilinear|rectilinear-grid|honeycomb|...
  std::string support_interface_pattern="auto";         // support_interface_pattern: auto|rectilinear|concentric|rectilinear_interlaced|grid
  double support_interface_spacing=0.5;                 // support_interface_spacing (mm, 0=솔리드). 원본 default 0.5
  double support_base_pattern_spacing=2.5;              // support_base_pattern_spacing (mm). density 와 함께 간격 결정
  double support_overhang_min_area=0.0;                 // 오버행 최소 면적(mm², 0=자동 w²). 형태학 열림 대체 필터
  bool   support_remove_small_overhang=true;            // support_remove_small_overhang (원본 default true)
  bool   bridge_no_support=false;                       // bridge_no_support: 브리지 영역엔 서포트 미생성
  double support_expansion=0.0;                         // support_expansion (mm): 오버행 영역 팽창
  double support_threshold_overlap=0.5;                 // support_threshold_overlap: θ=0 일 때 겹침 기준(압출폭 비율)
  bool   support_on_build_plate_only=false;             // support_on_build_plate_only: 베드까지 닿는 서포트만
  int    support_interface_bottom_layers=0;             // support_interface_bottom_layers (0=없음)
  bool   support_grid_snap=true;                        // 원본 SupportGridPattern 상당(grid 스타일 기본 동작)
  double tree_lite_shrink=0.5, tree_lite_min_radius=1.5;// tree_lite 테이퍼 상수(자체 근사 — 대응 원본 키 없음)
  // WP1: 실 트리 서포트(support_style=tree) 형상 키 — 기본값은 원본 PrintConfig 기본값과 동일
  std::string tree_style="organic";                     // organic|slim|strong|hybrid (원본 support_style smsTree*)
  double tree_support_branch_angle=40.0;                // tree_support_branch_angle_organic (deg)
  double tree_support_angle_slow=25.0;                  // tree_support_angle_slow (deg)
  double tree_support_branch_diameter=2.0;              // tree_support_branch_diameter_organic (mm)
  double tree_support_branch_distance=1.0;              // tree_support_branch_distance_organic (mm)
  double tree_support_branch_diameter_angle=5.0;        // tree_support_branch_diameter_angle (deg)
  double tree_support_tip_diameter=0.8;                 // tree_support_tip_diameter (mm)
  double tree_support_top_rate=30.0;                    // tree_support_top_rate (%)
  int    tree_support_wall_count=0;                     // tree_support_wall_count (organic 은 내부 max(1,·))
  double printable_height=250.0;                        // printable_height (mm) — 트리 BuildVolume 높이
  bool   independent_support_layer_height=false;        // 커널 z 그리드 제약상 기본 false(갭 레이어 양자화)
  double support_object_first_layer_gap=0.2;            // support_object_first_layer_gap (mm)
  int    raft_layers=0;                                // raft_layers
  double raft_expansion=1.5;                           // raft_expansion (mm). 원본 default 1.5 (기존 하드코딩 3.0)
  double raft_contact_distance=0.1;                    // raft_contact_distance (mm)
  double raft_first_layer_height=0.30;                 // 래프트 첫 레이어 높이(mm)
  int    skirt_height=1;                               // skirt_height: 스커트를 그릴 레이어 수
  double brim_object_gap=0.0;                          // brim_object_gap (mm): 브림-오브젝트 간격
  double retraction_minimum_travel=2.0;                // retraction_minimum_travel (mm): 리트랙션 발동 최소 이동
  double gcode_resolution=0.01;                        // resolution (mm): 경로 단순화 허용오차. 원본 PrintConfig default 0.01
  // wipe_tower_x/y (G-code 좌표, mm). 스키마 원본 default 는 (15, 220) 이지만 그건 256mm 베드 전제라
  //  200mm 베드에서 베드를 벗어난다. 커널 기본은 어떤 베드에서도 안전한 구석(10,10)을 유지하고,
  //  UI/소비자가 명시적으로 넘길 때만 원본 좌표를 쓴다(기존 동작 보존).
  double prime_tower_x=10.0, prime_tower_y=10.0;
  double prime_tower_ring_size=15.0;                   // 폴백 사각링 한 변(mm)
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
  // 33단계: 기본값 true 로 전환. 근거(compare_wipetower.mjs 실측, 2박스 MM):
  //  실 경로가 49/49 레이어 폴백 없이 성공, 퍼지량이 실제 계산됨(필라멘트 1098→4902mm),
  //  원본 G-code 구조 방출(CP TOOLCHANGE/WIPE_TOWER 마커 343), 성능 불이익 없음(25ms vs 31ms).
  //  기존 false 경로(15mm 사각링 3개)는 퍼지 개념이 없는 장식이라 실사용 G-code 로 부적합 — 폴백으로만 유지.
  bool   wipe_tower_real=true;                          // 12단계: MM 전환 시 6단계 사각링 대신 실 WipeTower.generate()
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
  // G003 증분: 뷰어(invalidation-map)가 판정해 지시. 0=풀, 1=지오메트리(tris) 재사용, 2=서포트까지(L[]) 재사용.
  int    reuse_stages=0;
  bool   keep_stages=false;                             // 슬라이스 후 스테이지를 캐시에 보관(조기 해제 생략 — 메모리 트레이드)
  bool   arachne_dump=false;   // 임시 진단: PASS1 arachne 입력 폴리곤을 stderr 로 덤프
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
  // 33단계: 하드코딩 제거로 신설된 키들
  p.support_angle                 = jget(j,"support_angle",p.support_angle);
  p.support_base_pattern          = jstr(j,"support_base_pattern",p.support_base_pattern);
  p.support_interface_pattern     = jstr(j,"support_interface_pattern",p.support_interface_pattern);
  p.support_interface_spacing     = jget(j,"support_interface_spacing",p.support_interface_spacing);
  p.support_base_pattern_spacing  = jget(j,"support_base_pattern_spacing",p.support_base_pattern_spacing);
  p.support_overhang_min_area     = jget(j,"support_overhang_min_area",p.support_overhang_min_area);
  p.support_remove_small_overhang = jbool(j,"support_remove_small_overhang",p.support_remove_small_overhang);
  p.bridge_no_support             = jbool(j,"bridge_no_support",p.bridge_no_support);
  p.support_expansion             = jget(j,"support_expansion",p.support_expansion);
  p.support_threshold_overlap     = jget(j,"support_threshold_overlap",p.support_threshold_overlap);
  p.support_on_build_plate_only   = jbool(j,"support_on_build_plate_only",p.support_on_build_plate_only);
  p.support_interface_bottom_layers = (int)jget(j,"support_interface_bottom_layers",p.support_interface_bottom_layers);
  p.support_grid_snap             = jbool(j,"support_grid_snap",p.support_grid_snap);
  p.tree_lite_shrink              = jget(j,"tree_lite_shrink",p.tree_lite_shrink);
  p.tree_lite_min_radius          = jget(j,"tree_lite_min_radius",p.tree_lite_min_radius);
  // WP1: 실 트리 서포트 형상 키 파싱 — 원본 UI 키(organic 접미사 포함)를 우선, 무접미사 키 폴백
  p.tree_style                    = jstr(j,"tree_style",p.tree_style);
  p.tree_support_branch_angle     = jget(j,"tree_support_branch_angle_organic",jget(j,"tree_support_branch_angle",p.tree_support_branch_angle));
  p.tree_support_angle_slow       = jget(j,"tree_support_angle_slow",p.tree_support_angle_slow);
  p.tree_support_branch_diameter  = jget(j,"tree_support_branch_diameter_organic",jget(j,"tree_support_branch_diameter",p.tree_support_branch_diameter));
  p.tree_support_branch_distance  = jget(j,"tree_support_branch_distance_organic",jget(j,"tree_support_branch_distance",p.tree_support_branch_distance));
  p.tree_support_branch_diameter_angle = jget(j,"tree_support_branch_diameter_angle",p.tree_support_branch_diameter_angle);
  p.tree_support_tip_diameter     = jget(j,"tree_support_tip_diameter",p.tree_support_tip_diameter);
  p.tree_support_top_rate         = jget(j,"tree_support_top_rate",p.tree_support_top_rate);
  p.tree_support_wall_count       = (int)jget(j,"tree_support_wall_count",p.tree_support_wall_count);
  p.printable_height              = jget(j,"printable_height",p.printable_height);
  p.independent_support_layer_height = jbool(j,"independent_support_layer_height",p.independent_support_layer_height);
  p.support_object_first_layer_gap= jget(j,"support_object_first_layer_gap",p.support_object_first_layer_gap);
  p.raft_expansion                = jget(j,"raft_expansion",p.raft_expansion);
  p.raft_contact_distance         = jget(j,"raft_contact_distance",p.raft_contact_distance);
  p.raft_first_layer_height       = jget(j,"raft_first_layer_height",p.raft_first_layer_height);
  p.skirt_height        = (int)jget(j,"skirt_height",p.skirt_height);
  p.brim_object_gap               = jget(j,"brim_object_gap",p.brim_object_gap);
  p.retraction_minimum_travel     = jget(j,"retraction_minimum_travel",p.retraction_minimum_travel);
  p.gcode_resolution              = jget(j,"gcode_resolution",p.gcode_resolution);
  p.prime_tower_x                 = jget(j,"prime_tower_x",p.prime_tower_x);
  p.prime_tower_y                 = jget(j,"prime_tower_y",p.prime_tower_y);
  p.prime_tower_ring_size         = jget(j,"prime_tower_ring_size",p.prime_tower_ring_size);
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
  p.reuse_stages                  = (int)jget(j,"reuse_stages",p.reuse_stages);
  p.keep_stages                   = jbool(j,"keep_stages",p.keep_stages);
  p.arachne_dump                  = jbool(j,"arachne_dump",p.arachne_dump);
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
// 33단계: 원본 SupportGridPattern(SupportMaterial.cpp:637~) 근사 — 서포트 영역을 격자에 스냅한다.
//  원본은 폴리곤을 압출폭 해상도로 래스터화한 뒤 support_spacing 크기 매크로 블록에 seed fill 해서,
//  블록에 조금이라도 걸친 서포트 섬을 블록 단위로 확정한다(rasterize_polygons + seed_fill_block).
//  효과: ① 기둥이 일정 격자에 정렬되고 ② **채울 수 없을 만큼 얇은 조각이 최소 한 셀로 부풀어 실제 출력 가능**해진다.
//  ②가 없으면 얇은 벽 형상(예: 실물 Benchy 굴뚝, 링 단면)의 서포트가 검출은 되어도 인필이 한 줄도
//  안 들어가 결과적으로 사라진다(실측: support_expansion 을 줘야만 생성됐다).
//  여기서는 Clipper 만으로 동치를 구현한다 — 셀이 서포트 영역과 겹치면 그 셀 전체를 채택.
//  래스터/seed fill 대신 셀-폴리곤 교차로 판정하므로 오버샘플링 세부는 근사다.
static Paths grid_snap(const Paths& region, double cell) {
  if (region.empty() || cell <= 1e-6) return region;
  double minx,miny,maxx,maxy; bbox_of(region, minx,miny,maxx,maxy);
  const long i0=(long)std::floor(minx/cell), i1=(long)std::ceil(maxx/cell);
  const long j0=(long)std::floor(miny/cell), j1=(long)std::ceil(maxy/cell);
  if ((i1-i0+1) > 2000 || (j1-j0+1) > 2000 || (i1-i0+1)*(j1-j0+1) > 200000) return region;  // 방어: 과대 격자면 원본 반환
  Paths cells;
  for (long i=i0;i<=i1;++i) for (long j=j0;j<=j1;++j) {
    const double x0=i*cell, y0=j*cell, x1=x0+cell, y1=y0+cell;
    Path c;
    c.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y0*SCALE)));
    c.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y0*SCALE)));
    c.push_back(IntPoint((cInt)std::llround(x1*SCALE),(cInt)std::llround(y1*SCALE)));
    c.push_back(IntPoint((cInt)std::llround(x0*SCALE),(cInt)std::llround(y1*SCALE)));
    if (clip_paths(Paths{c}, region, ctIntersection).empty()) continue;   // 이 셀에 서포트가 걸치는가
    cells.push_back(std::move(c));
  }
  if (cells.empty()) return region;
  return SimplifyPolygons(cells, pftNonZero);   // 인접 셀 병합
}

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
// (성능) G-code 핫패스 고정소수점 포매터 — snprintf 대비 ~5배(fmt_bench2 실측: 데이터셋 2종×2회, 불일치 0/2M).
//  반올림 경계(|frac−0.5|<1e-6)는 nullptr 반환 → 호출부가 원래 snprintf 로 폴백해 byte-identical 보장.
//  부호는 signbit(v)로 결정(−0.0 포함) — snprintf 의 "-0.000" 출력과 일치.
static const long long FMT_P10[] = {1,10,100,1000,10000,100000};
static inline char* fmt_fixed_safe(char* p, double v, int prec) {
  double av = std::fabs(v);
  double t  = av * FMT_P10[prec];
  double fr = t - std::floor(t);
  if (fr > 0.5 - 1e-6 && fr < 0.5 + 1e-6) return nullptr;   // 반올림 경계 → snprintf 폴백
  long long sc = (long long)llround(t);
  if (std::signbit(v)) *p++ = '-';
  long long ip = sc / FMT_P10[prec], fp = sc % FMT_P10[prec];
  char tmp[24]; int n = 0;
  do { tmp[n++] = (char)('0' + ip % 10); ip /= 10; } while (ip);
  while (n) *p++ = tmp[--n];
  *p++ = '.';
  for (int k = prec - 1; k >= 0; --k) { p[k] = (char)('0' + fp % 10); fp /= 10; }
  return p + prec;
}
static inline char* fmt_i(char* p, int v) {
  if (v < 0) { *p++ = '-'; v = -v; }
  char tmp[12]; int n = 0;
  do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
  while (n) *p++ = tmp[--n];
  return p;
}

struct GW {
  bool dry=false;   // G003 E1 드라이런: 문자열/토폴패스 생략, 위치·curF·팬·심 상태만 갱신(진입상태 체인용)
  std::string s;
  double px=0, py=0, z=0;
  double e_per_mm=0, filament=0;
  long   segments=0;
  int    curF=-1;
  double retract_len=0.8; int retractF=1800; // mm, mm/min
  double retract_min_travel=2.0;             // 33단계: retraction_minimum_travel(기존 TRAVEL_RETRACT_MIN 상수)
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
  // WP3: 원본 부피 유량(mm³/mm, ExtrusionPath::mm3_per_mm) 직접 설정 — 트리 서포트가 원본 Flow 가 계산한
  //  유량(브리징 접촉층 등 폭·높이 사각근사와 다른 경우 포함)을 그대로 재현한다.
  void set_e_per_mm_vol(double mm3, const Params& p) {
    if (mm3 < 0) mm3 = 0;
    double fa = PI * p.filament_diameter * p.filament_diameter / 4.0;
    e_per_mm = mm3 / fa * p.flow_ratio;
  }
  void raw(const char* c){ if (dry) return; s += c; s += '\n'; }
  // 핫패스 라인 방출 — fast path(고정소수점) 실패 시 원래 snprintf 포맷으로 폴백(byte-identical).
  inline void line_xyf(const char* head, double a, double b, int f, const char* fbfmt) {
    char* q = buf; size_t hl = strlen(head); memcpy(q, head, hl); q += hl;
    char* r = fmt_fixed_safe(q, a, 3);
    if (r) { memcpy(r, " Y", 2); r = fmt_fixed_safe(r+2, b, 3); }
    if (r) { memcpy(r, " F", 2); r = fmt_i(r+2, f); *r = '\0'; raw(buf); return; }
    std::snprintf(buf, sizeof buf, fbfmt, a, b, f); raw(buf);
  }
  inline void line_vf(const char* head, double v, int prec, int f, const char* fbfmt) {
    char* q = buf; size_t hl = strlen(head); memcpy(q, head, hl); q += hl;
    char* r = fmt_fixed_safe(q, v, prec);
    if (r) { memcpy(r, " F", 2); r = fmt_i(r+2, f); *r = '\0'; raw(buf); return; }
    std::snprintf(buf, sizeof buf, fbfmt, v, f); raw(buf);
  }
  // 리트랙션 포함 직선 트래블 (원본 동작)
  void travel_raw(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    bool retract = d > retract_min_travel && retract_len > 0;
    if (retract) {
      line_vf("G1 E-", retract_len, 4, retractF, "G1 E-%.4f F%d");
      if (z_hop > 0) line_vf("G1 Z", z + z_hop, 3, fTravel, "G1 Z%.3f F%d");
    }
    line_xyf("G0 X", x+offX, y+offY, fTravel, "G0 X%.3f Y%.3f F%d");
    if (retract) {
      if (z_hop > 0) line_vf("G1 Z", z, 3, fTravel, "G1 Z%.3f F%d");
      line_vf("G1 E", retract_len, 4, retractF, "G1 E%.4f F%d");
    }
    px=x; py=y; curF=-1;
  }
  // 우회 내부 이동 (리트랙션 생략 — 재료 안쪽 유지, §6.5 데스크톱 동작)
  void travel_hop(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    line_xyf("G0 X", x+offX, y+offY, fTravel, "G0 X%.3f Y%.3f F%d");
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
  // 빠른 가드(통계 전용) — avoid_walls=false 면 판정이 wall_crossings 카운터에만 쓰인다(G-code 무영향).
  //  Clipper clip_open(트래블당 ~20µs, 방출 직렬부 최대 단일 비용으로 실측)을 정수 orientation 교차판정
  //  + 중점 even-odd PIP 로 대체. 접선·공선 등 경계 케이스만 clip 판정과 다를 수 있음(카운터 오차 허용).
  //  avoid_walls=true 는 우회 경로(G-code)가 판정에 의존 → 기존 seg_inside(clip_open) 유지.
  bool seg_inside_fast(double ax,double ay,double bx,double by){
    const cInt x1=(cInt)std::llround(ax*SCALE), y1=(cInt)std::llround(ay*SCALE);
    const cInt x2=(cInt)std::llround(bx*SCALE), y2=(cInt)std::llround(by*SCALE);
    auto orient=[](cInt ox,cInt oy,cInt px_,cInt py_,cInt qx,cInt qy)->int{
      long long v=(long long)(px_-ox)*(long long)(qy-oy)-(long long)(py_-oy)*(long long)(qx-ox);
      return v>0?1:(v<0?-1:0); };
    for (const Path& poly : island){
      size_t n=poly.size(); if (n<3) continue;
      for (size_t i=0;i<n;++i){
        const IntPoint& c=poly[i]; const IntPoint& d=poly[(i+1)%n];
        int o1=orient(x1,y1,x2,y2,c.x(),c.y()), o2=orient(x1,y1,x2,y2,d.x(),d.y());
        if (o1*o2>=0) continue;
        int o3=orient(c.x(),c.y(),d.x(),d.y(),x1,y1), o4=orient(c.x(),c.y(),d.x(),d.y(),x2,y2);
        if (o3*o4<0) return false;               // 진성 교차 → 경계 횡단
      }
    }
    IntPoint m((x1+x2)/2,(y1+y2)/2);             // 비횡단 → 중점 포함 여부로 전체 판정
    int cnt=0;
    for (const Path& poly : island){ int r=PointInPolygon(m,poly); if (r==-1) return true; if (r!=0) ++cnt; }
    return (cnt&1)==1;
  }
  void travel(double x, double y, int fTravel) {
    double d = std::hypot(x-px, y-py); if (d < 1e-6) return;
    if (dry) { px=x; py=y; curF=-1; return; }   // G003: 디투어도 종점 동일 → 위치만
    if (!island.empty() && !(avoid_walls ? seg_inside(px,py,x,y) : seg_inside_fast(px,py,x,y))) {
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
    if (dry) { px=x; py=y; curF=fPrint; return; }   // G003 드라이런(pe off 전제 — 병렬 모드 가드)
    int fUse = pe_feed(d, fPrint);               // PE-lite: 유량 변화율 한도 적용(off 면 fPrint)
    double dE = e_per_mm * d; filament += dE; ++segments;
    char* r = buf; memcpy(r, "G1 X", 4); r += 4;
    r = fmt_fixed_safe(r, x+offX, 3);
    if (r) { memcpy(r, " Y", 2); r = fmt_fixed_safe(r+2, y+offY, 3); }
    if (r) { memcpy(r, " E", 2); r = fmt_fixed_safe(r+2, dE, 5); }
    if (r) {                                     // fast path 성공 — F 는 변경 시만
      if (fUse != curF) { memcpy(r, " F", 2); r = fmt_i(r+2, fUse); }
      *r = '\0';
    } else if (fUse != curF) std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f F%d", x+offX,y+offY,dE,fUse);
    else                     std::snprintf(buf,sizeof buf,"G1 X%.3f Y%.3f E%.5f",     x+offX,y+offY,dE);
    curF = fUse;
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
  void set_fan(int S) { if (S==lastFan) return; lastFan=S; if (dry) return; std::snprintf(buf,sizeof buf,"M106 S%d",S); raw(buf); }
  // 연속 폴리라인 방출 (pts[0]=현재 위치). arc_fitting 시 G2/G3, 아니면 G1.
  void extrude_run(const std::vector<DPt>& pts, int fPrint) {
    if (dry) { if (pts.size()>1) { px=pts.back().x; py=pts.back().y; curF=fPrint; } return; }
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
// G003: 병렬 작가(레이어별 GW)가 각자 widths 를 기록하도록 thread_local — st/직렬 경로 의미 불변.
static bool g_keep_island = false;   // G003: 캐시 보존 시 emit 이 island 를 move 대신 복사(캐시 반복 재사용)
static thread_local std::vector<float>* g_seg_w = nullptr;
static thread_local float g_seg_w_cur = 0.42f;
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
  if (gw.dry) {   // G003 E1: 심 회전·위치·curF 만 — 작가 패스가 동일 진입상태에서 바이트를 재현
    for (Path wp : loops) {
      if (wp.size() < 2) continue;
      rotate_seam(wp, seamMode, sc, gw.px, gw.py);
      gw.px = wp[0].x()*INV; gw.py = wp[0].y()*INV; gw.curF = fPrint;
      if (updateSeam) { sc.lastX=gw.px; sc.lastY=gw.py; sc.has=true; }
    }
    return;
  }
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
  if (gw.dry) {
    for (const Path& ln : lines) if (ln.size() >= 2) { gw.px = ln.back().x()*INV; gw.py = ln.back().y()*INV; gw.curF = fPrint; }
    return;
  }
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
// 19단계→WP3: 실 트리 서포트 툴패스 1개 — per-path 폭 + 원본 ExtrusionPath 의 role/height/mm3_per_mm 보존.
struct TreePath { Path pl; float w; int role; float h; float mm3; };
// 19단계→WP3: 트리 서포트 방출 — 열린 폴리라인 + per-path 폭. E 는 원본 mm3_per_mm 가 있으면 그대로
//  (set_e_per_mm_vol — 브리징 접촉층 등 원본 Flow 유량 재현), 없으면 기존 폭×높이 사각근사.
//  PE role 은 path 별 원본 role(base 14 / interface 15)로 런을 나눠 원본 역할 구분을 유지한다.
static void emit_lines_vw(GW& gw, std::vector<float>& tp, const std::vector<TreePath>& lines,
                          double z, double h, const Params& p, float type, int fPrint, int fTravel){
  if (gw.dry) {   // G003 E1: 위치·curF 만 (E/유량 상태는 레이어 시작마다 재설정되어 체인 무관)
    for (const auto& lw : lines) if (lw.pl.size() >= 2) { gw.px = lw.pl.back().x()*INV; gw.py = lw.pl.back().y()*INV; gw.curF = fPrint; }
    return;
  }
  int curRole = -1;
  for (const auto& lw : lines) {
    const Path& ln = lw.pl;
    if (ln.size() < 2) continue;
    const int role = (lw.role > 0) ? lw.role : pe_role_of(type);
    if (role != curRole) { if (curRole >= 0) gw.pe_end_run(); gw.pe_begin_run(role, fPrint); curRole = role; }
    const double ph = (lw.h > 1e-6) ? lw.h : h;
    if (lw.mm3 > 1e-9) gw.set_e_per_mm_vol(lw.mm3, p);
    else               gw.set_e_per_mm_width(lw.w, ph, p);
    g_seg_w_cur = lw.w;
    std::vector<DPt> pts; pts.reserve(ln.size());
    for (auto& q:ln) pts.push_back({q.x()*INV, q.y()*INV});
    push_seg(tp, gw.px, gw.py, pts[0].x, pts[0].y, z, 0.0f);
    gw.travel(pts[0].x, pts[0].y, fTravel);
    for (size_t i=1;i<pts.size();++i) push_seg(tp, pts[i-1].x,pts[i-1].y, pts[i].x,pts[i].y, z, type);
    gw.extrude_run(pts, fPrint);
  }
  if (curRole >= 0) gw.pe_end_run();
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
  // 18/19단계→WP3: 실 트리 서포트 툴패스(TreePath: 폭+원본 role/height/mm3_per_mm 보존)
  std::vector<TreePath> supTree;
  Paths thin;                    // 씬월(폭<2w) 영역 — 중심선 1줄로 처리
  Paths island;                  // 트래블 유지 구역(contour −w/2) — PASS1(병렬)에서 선계산, 방출 시 move
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
  gw.retract_min_travel=p.retraction_minimum_travel;
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
  // 프라임 타워 폴백(사각 링). 33단계: 위치(10,10)·크기 15 하드코딩 → prime_tower_x/y/ring_size 배선.
  //  ※ 기본 경로는 wipe_tower_real(실 WipeTower) 이고 이 링은 그 실패 시 폴백이다.
  double ptx=p.prime_tower_x-gw.offX, pty=p.prime_tower_y-gw.offY;
  const double ptSize=p.prime_tower_ring_size;
  auto primeRings=[&](){ Paths ps; for(int k=0;k<3;++k){ double o=k*w; double x0=ptx+o,y0=pty+o,x1=ptx+ptSize-o,y1=pty+ptSize-o;
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
                        p.layer_height, zE, i==0, 0, 1, p.prime_tower_x, p.prime_tower_y,   // 33단계: 10,10 상수 → wipe_tower_x/y
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

#ifdef __EMSCRIPTEN_PTHREADS__
// (mt) 시간추정 오버랩 — 방출 스레드(생산자)가 '\n' 경계 청크를 큐에 넣고, 워커 1개(소비자)가
//  gcodeproc_bridge::estimate_begin/feed 를 전담 실행한다. 브릿지 상태(file-static g_gp)는 begin~feed 동안
//  워커만 접근, finish() 의 join 이 happens-before 를 보장한 뒤 estimate_end() 를 호출자 스레드에서 수행.
//  청크 내용·순서 불변 → 추정 결과 동일, G-code 무영향(golden 안전). 방출과 파싱이 겹쳐 벽시계만 단축.
struct TimeFeeder {
  std::thread th; std::mutex mu; std::condition_variable cv;
  std::deque<std::string> q; bool done = false;
  void begin(const gcodeproc_bridge::Limits& gl) {
    th = std::thread([this, gl]{
      gcodeproc_bridge::estimate_begin(gl);
      for (;;) {
        std::string c;
        { std::unique_lock<std::mutex> lk(mu);
          cv.wait(lk, [&]{ return !q.empty() || done; });
          if (q.empty()) break;                       // done && 큐 소진 → 종료
          c = std::move(q.front()); q.pop_front(); }
        gcodeproc_bridge::estimate_feed(c);
      }
    });
  }
  void feed(std::string c) {
    if (c.empty()) return;
    { std::lock_guard<std::mutex> lk(mu); q.push_back(std::move(c)); }
    cv.notify_one();
  }
  gcodeproc_bridge::Result finish() {
    { std::lock_guard<std::mutex> lk(mu); done = true; }
    cv.notify_one(); th.join();
    return gcodeproc_bridge::estimate_end();
  }
};
#endif

// PASS2 레이어별 사전계산(기하 분리·인필 라인 생성) 결과 — 방출(직렬, gw/seam 상태)과 분리.
//  레이어별 결정적·독립 계산만 담으므로 mt 빌드에서 워커 선계산 가능(결과 동일, golden 로 검증).
struct ThinRun { Paths line; double flow; };
struct EmitPre {
  Paths gapLines, solidLines, topLines, bridgeLines, sparseLines, supI, supB, flExtra, ironLines;
  std::vector<ThinRun> thinRuns;
  bool brim=false; int fPrint=0, fBridge=0, fSup=0;
};

// G003 1단계: 정상 레이어 방출 본문 추출 — 직렬 경로와 (2단계) 병렬 작가가 공유하는 단일 구현.
//  동작 무변경(이동만) — golden/st↔mt 게이트로 등가 검증.
static void emit_layer_full(GW& gw, std::vector<float>& tp, std::vector<float>& widths,
                            int i, LayerData& ld, EmitPre& pre, const Params& p,
                            double zE, double w, int N, int nraft, int fTravel,
                            int seamMode, bool scarfOn, bool ironOn, SeamCtx& seamCtx) {
    char cm[72]; (void)cm; (void)widths; (void)N;
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);

    // --- 방출 경로: compute_pre 선계산 결과 언패킹(방출 코드 무변경 유지용 별칭) ---
    Paths& gapLines = pre.gapLines;       std::vector<ThinRun>& thinRuns = pre.thinRuns;
    Paths& solidLines = pre.solidLines;   Paths& topLines = pre.topLines;
    Paths& bridgeLines = pre.bridgeLines; Paths& sparseLines = pre.sparseLines;
    Paths& supI = pre.supI; Paths& supB = pre.supB; Paths& flExtra = pre.flExtra;
    const bool brim = pre.brim; const int fPrint = pre.fPrint, fBridge = pre.fBridge;
    // 21단계: 피처별 폭(첫 레이어는 initial_layer 로 일괄) — 스칼라라 방출 시 재계산(수식 동일).
    bool firstL = (i==0 && nraft==0);
    double wOuter  = firstL ? p.initial_layer_line_width : p.outer_wall_line_width;
    double wInner  = firstL ? p.initial_layer_line_width : p.inner_wall_line_width;
    double wSolid  = firstL ? p.initial_layer_line_width : p.internal_solid_infill_line_width;
    double wTop    = firstL ? p.initial_layer_line_width : p.top_surface_line_width;
    double wSparse = firstL ? p.initial_layer_line_width : p.sparse_infill_line_width;

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

    // 아이어닝(type10): 노출 top 솔리드 위에 같은 z 로 저유량 재패스(라인은 compute_pre 선계산분).
    {
      Paths& ironLines = pre.ironLines;
      if (!ironLines.empty()) {
        gw.raw("; ironing");
        gw.pe_reset();                               // 저유량 아이어닝은 PE 유량매칭 대상서 제외
        int fIron = (int)std::llround(std::max(5.0, p.ironing_speed)*60);
        double saved = gw.e_per_mm; gw.e_per_mm = saved * std::max(0.0, p.ironing_flow/100.0);
        emit_lines(gw, tp, ironLines, zE, 10.0f, fIron, fTravel);
        gw.e_per_mm = saved; gw.pe_reset();
      }
    }

}

// G003 2단계: 레이어 1개의 전체 방출(셋업 + 빈/정상 분기) — 직렬 경로와 병렬 작가가 공유하는 단일 구현.
//  스파이럴은 호출부 인라인(병렬 제외 가드), 스카프/PE태그/PE-lite/아라크네/실PE 도 parEmit 가드로 직렬 폴백.
static void emit_layer_any(GW& gw, std::vector<float>& tp, std::vector<float>& widths,
                           int i, LayerData& ld, EmitPre& pre, const Params& p,
                           double zE, double w, int N, int nraft, int fTravel,
                           int seamMode, bool scarfOn, bool ironOn, SeamCtx& seamCtx) {
  gw.set_e_per_mm(ld.h, p);
  gw.z = zE;
  gw.pe_reset();
  if (!gw.dry) gw.island = g_keep_island ? ld.island : std::move(ld.island);   // G003: 캐시 보존 시 복사
  seamCtx.rng = 2654435761u * (uint32_t)(i+1);
  g_seg_w = gw.dry ? nullptr : &widths; g_seg_w_cur = (float)w;
  char cm[72];
  if (ld.contour.empty()) {
    // 33단계 [부유 모델 수정] 모델이 없는 레이어라도 서포트는 방출해야 한다.
    std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f (no model)",i,zE); gw.raw(cm);
    std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
    gw.z = zE; gw.set_e_per_mm(ld.h, p); gw.pe_reset();
    gw.set_fan(fan_S(i, p));
    const int fSup = pre.fSup;
    Paths& eI = pre.supI;
    Paths& eB = pre.supB;
    if (!eI.empty() || !eB.empty()) {
      gw.raw("; support");
      if (!eI.empty()) emit_lines(gw, tp, eI, zE, 5.0f, fSup, fTravel);
      if (!eB.empty()) emit_lines(gw, tp, eB, zE, 5.0f, fSup, fTravel);
    }
    if (p.enable_support && !ld.supTree.empty()) {
      gw.raw("; support (organic tree — real ported TreeSupport)");
      emit_lines_vw(gw, tp, ld.supTree, zE, ld.h, p, 5.0f, fSup, fTravel);
    }
    return;
  }
  std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.raw(cm);
  gw.set_fan(fan_S(i, p));
  emit_layer_full(gw, tp, widths, i, ld, pre, p, zE, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, seamCtx);
}

// G003 증분 재슬라이스: 슬라이스 간 스테이지 캐시. keep_stages 로 채우고 reuse_stages 로 재사용.
//  유효성은 뷰어(지오메트리 다이제스트 + invalidation-map)가 1차 판정, 커널은 layerKey(레이어링·서포트
//  파라미터 스냅샷) 불일치 시 재사용 거부로 2차 방어. 캐시 상주는 메모리 트레이드(간소화 후 수십 MB 급).
static struct StageCache {
  bool valid = false;
  std::vector<Tri> tris; double height = 0, cx = 0, cy = 0; bool over_bed = false;
  int N = 0; std::string layerKey;
  int treeSupLayers = 0; double treeZMaxResid = -1.0;   // 프리앰블 진단 라인 재현용
  std::vector<LayerData> L;
} g_scache;
static std::string make_layer_key(const Params& p) {
  char k[512];
  std::snprintf(k, sizeof k, "%.6f|%.6f|%.6f|%d|%d|%s|%d|%.3f|%.3f|%.3f|%.3f|%d|%d|%s|%s|%.3f|%d|%.4f|%d",
    p.layer_height, p.first_layer_height, p.line_width, p.wall_loops, (int)p.enable_support,
    p.support_style.c_str(), (int)p.support_auto, p.support_threshold_angle, p.support_top_z_distance,
    p.support_xy_distance, p.support_density, p.support_interface_top_layers, p.raft_layers,
    p.wall_generator.c_str(), p.sparse_infill_pattern.c_str(), p.infill_density,
    (int)p.auto_center, p.gcode_resolution, (int)p.spiral_mode);
  return std::string(k);
}

// slice(Uint8Array stl, string paramsJson, function onProgress) → { gcode, stats, layers[] }
// =============================================================================
em::val slice(em::val stl_bytes, std::string params_json, em::val onProgress) {
  auto report = [&](int done, int total){ if (!onProgress.isUndefined() && !onProgress.isNull()) onProgress(done, total); };
  Params p = parse_params(params_json);
  if (p.spiral_mode) p.wall_loops = 1;                 // vase: 단일 외벽
  // G002: 취소 플래그 — UI 가 SAB 로 1 기입. 진입 시 0 리셋, 루프들이 반복 단위 폴링.
  auto* cxp = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::cancel_addr();
  cxp->store(0);
  auto CX = [cxp]{ return cxp->load(std::memory_order_relaxed) != 0; };
  // G003 증분: 재사용 판정(뷰어 1차 + layerKey 2차 방어). MM 은 미지원.
  const std::string lk = make_layer_key(p);
  const bool reuseGeom = p.reuse_stages >= 1 && g_scache.valid && p.extruder_count < 2;
  const bool reuseSup  = p.reuse_stages >= 2 && g_scache.valid && g_scache.layerKey == lk && p.extruder_count < 2;
  std::vector<Tri> trisOwn;
  if (!reuseGeom) {
    std::vector<uint8_t> bytes = em::convertJSArrayToNumberVector<uint8_t>(stl_bytes);
    trisOwn = parse_stl(bytes);
  }
  std::vector<Tri>& tris = reuseGeom ? g_scache.tris : trisOwn;

  em::val result = em::val::object();
  if (tris.empty()) { result.set("error", std::string("STL 파싱 실패 또는 삼각형 0개")); return result; }

  // 모델을 XY원점 중심·minZ=0 이동 (reuseGeom 이면 캐시본이 이미 정규화됨)
  double minx=1e18,miny=1e18,minz=1e18,maxx=-1e18,maxy=-1e18,maxz=-1e18;
  if (reuseGeom) { minx=miny=minz=0; maxx=maxy=maxz=0; }
  else
  for (auto& t:tris) for (int k=0;k<3;++k){
    minx=std::min(minx,(double)t.v[k].x);maxx=std::max(maxx,(double)t.v[k].x);
    miny=std::min(miny,(double)t.v[k].y);maxy=std::max(maxy,(double)t.v[k].y);
    minz=std::min(minz,(double)t.v[k].z);maxz=std::max(maxz,(double)t.v[k].z); }
  double cx=(minx+maxx)/2, cy=(miny+maxy)/2;
  if (reuseGeom) { cx = g_scache.cx; cy = g_scache.cy; }
  // 28단계 P2: auto_center=true 면 결합 bbox 를 원점 재정렬(레거시). false(기본)=XY 뷰어 좌표 그대로, Z 만 안착.
  //  G003: reuseGeom 이면 캐시 tris 가 이미 정규화됨 — 재이동 금지(이중 이동 방지).
  if (!reuseGeom) {
    if (p.auto_center) { for (auto& t:tris) for (int k=0;k<3;++k){ t.v[k].x-=cx; t.v[k].y-=cy; t.v[k].z-=minz; } }
    else               { for (auto& t:tris) for (int k=0;k<3;++k){ t.v[k].z-=minz; } }
  }
  double height = reuseGeom ? g_scache.height : (maxz - minz);
  double modelW = maxx - minx, modelD = maxy - miny;
  // over_bed: 크기 초과 || (뷰어 좌표 모드) G-code(+bed/2) 가 베드[0,bed]를 벗어나는 위치(원좌표 [-bed/2,bed/2] 밖)
  bool over_bed = (modelW > p.bed_width) || (modelD > p.bed_depth);
  if (!p.auto_center) over_bed = over_bed || maxx > p.bed_width*0.5 || minx < -p.bed_width*0.5
                                          || maxy > p.bed_depth*0.5 || miny < -p.bed_depth*0.5;
  if (reuseGeom) over_bed = g_scache.over_bed;

  const double w = p.line_width;
  const double sparse_spacing  = (p.infill_density > 1e-4) ? (w / p.infill_density) : 0.0;
  const double solid_spacing   = w;   // 솔리드 = 100% 채움
  const double support_spacing = (p.support_density > 1e-4) ? (w / p.support_density) : (w*3.0);

  // 멀티머티리얼(스트레치): 그룹 2개면 분리 슬라이스 + T0/T1 + 프라임 타워 경로로 분기
  if (p.extruder_count >= 2 && p.mm_group_split > 0 && p.mm_group_split < (int)tris.size())
    return slice_multimaterial(tris, p, onProgress, height, over_bed);

  // z 레벨 수 세기 (진행률 total)
  int N = 0; for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) ++N;
  int total = 2*N + 2;   // +2 = 표면·서포트 완료 틱. 종전엔 PASS1(50%) 후 서포트가 끝날 때까지 무보고 → "50%에서 멈춤"으로 보였다.

  // 스테이지 계측 (stats 로만 노출 — g-code 무영향, golden 안전)
  double tw0 = emscripten_get_now(), tw_p1 = 0, tw_p15 = 0, tw_sup = 0;
  double t_flush = 0;          // flush_layer(JS 경계: to_f32/layersArr/sink + 추정 피드) 누적 — 나머지가 G1 포매팅 몫

  // ---- PASS 1: 레이어별 윤곽·벽·인필영역 ----
  //  레이어 간 의존 0 (읽기: tris/p 공유 불변, 쓰기: L[i] 독립) → -pthread 빌드에서 레이어 병렬.
  //  z 는 기존 누적 루프(z+=layer_height)와 동일하게 직렬 선계산 — FP 누적 순서 보존(golden 안전).
  const bool keepStages = (p.keep_stages || reuseSup) && p.extruder_count < 2;
  g_keep_island = keepStages;
  double treeZMaxResid = -1.0; int treeSupLayers = 0;   // 19단계: 트리 서포트 z 정합 진단 (G003: 호이스트)
  std::vector<LayerData> Lown;
  if (!reuseSup) Lown.resize(N);
  std::vector<LayerData>& L = reuseSup ? g_scache.L : Lown;
  if (reuseSup) {
    // G003: 지오메트리·서포트 설정 불변 — PASS1/표면/서포트 전부 캐시 재사용, 방출만 재실행.
    tw_p1 = tw_p15 = emscripten_get_now();
    treeSupLayers = g_scache.treeSupLayers; treeZMaxResid = g_scache.treeZMaxResid;
    report(N, total); report(N+1, total);
  } else {
  { std::vector<double> zsv; zsv.reserve(N);
    for (double z=p.first_layer_height; z<height-1e-4; z+=p.layer_height) zsv.push_back(z);
    // [facet-major 세그 수집 — 원본 정합] 원본 slice_facet_at_zs(TriangleMeshSlicer.cpp:476)처럼
    //  삼각형→이진탐색으로 "걸치는 레이어만" 방문(작업량=실교차수). 기존 레이어×전수스캔은 657×775k
    //  ≈ 5억 방문이었다. 포함 조건은 기존과 동일(zmin<=z<zmax → lower_bound + *it<zmax), tri_plane
    //  입력도 동일 → 세그 값 불변. 스레드별 '연속 삼각형 레인지' + 레인지 순 병합으로 레이어 내 세그
    //  순서 = 삼각형 인덱스 오름차순(기존 전수스캔과 동일) → chain_polys 입력 불변 = byte-identical.
    std::vector<std::vector<Seg>> layerSegs(N);
    if (N > 0) {
      auto collect = [&](size_t a, size_t b, std::vector<std::vector<Seg>>& out){
        Seg sg;
        for (size_t ti = a; ti < b; ++ti) {
          const Tri& t = tris[ti];
          double zmin=std::min({t.v[0].z,t.v[1].z,t.v[2].z}), zmax=std::max({t.v[0].z,t.v[1].z,t.v[2].z});
          for (auto it = std::lower_bound(zsv.begin(), zsv.end(), zmin); it != zsv.end() && *it < zmax; ++it)
            if (tri_plane(t, *it, sg)) out[(size_t)(it - zsv.begin())].push_back(sg);
        }
      };
#ifdef __EMSCRIPTEN_PTHREADS__
      unsigned shw = std::thread::hardware_concurrency(); if (!shw) shw = 4;
      unsigned snt = (unsigned)std::min<size_t>(shw, std::max<size_t>(1, tris.size() / 4096));
      if (snt > 1) {
        std::vector<std::vector<std::vector<Seg>>> tb(snt, std::vector<std::vector<Seg>>(N));
        size_t schunk = (tris.size() + snt - 1) / snt;
        std::vector<std::thread> sths; sths.reserve(snt);
        for (unsigned t2 = 0; t2 < snt; ++t2) {
          size_t a = t2*schunk, b = std::min(tris.size(), a+schunk);
          if (a >= b) break;
          sths.emplace_back([&, a, b, t2]{ collect(a, b, tb[t2]); });
        }
        for (auto& th : sths) th.join();
        for (int li = 0; li < N; ++li) {
          size_t tot = 0; for (auto& tbt : tb) tot += tbt[li].size();
          layerSegs[li].reserve(tot);
          for (auto& tbt : tb) { layerSegs[li].insert(layerSegs[li].end(), tbt[li].begin(), tbt[li].end()); std::vector<Seg>().swap(tbt[li]); }
        }
      } else
#endif
      collect(0, tris.size(), layerSegs);
    }
    auto computeLayer = [&](int i) {
      const double z = zsv[i];
      LayerData ld; ld.z=z; ld.idx=i; ld.h=(i==0)?p.first_layer_height:p.layer_height;
      std::vector<Seg> segs; segs.swap(layerSegs[i]);
      Paths loops = chain_polys(segs);
      ld.contour = SimplifyPolygons(loops, pftEvenOdd);
      // [조기 단순화 — 원본 정합] 원본은 메시 슬라이스 직후 모든 윤곽을 resolution 으로 단순화한다
      //  (TriangleMeshSlicer.cpp:2042 ex.simplify). 커널은 원시 윤곽을 그대로 흘려 하류 전체(벽·인필·
      //  서포트·방출 클립)가 고밀도 폴리곤 비용을 냈다. CleanPolygons(수직거리 기반 제거)로 등가 감량 —
      //  DP 와 알고리즘은 다르나 목적 동일. 저밀도 픽스처(골든)는 코너 간격 >> resolution 이라 무변경.
      if (p.gcode_resolution > 1e-9) {
        CleanPolygons(ld.contour, SCALE * p.gcode_resolution);
        ld.contour.erase(std::remove_if(ld.contour.begin(), ld.contour.end(),
                                        [](const Path& q){ return q.size() < 3; }), ld.contour.end());
      }
      if (!ld.contour.empty()) {
        ld.island = offset_paths(ld.contour, -w*0.5);   // 트래블 가드 구역 — 방출 루프의 직렬 offset 을 여기(병렬)로 이동
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
          // [초고밀도 윤곽 가드] 300만 tri급 모델의 원시 슬라이스 윤곽(레이어당 수만 점)을 그대로 먹이면
          //  이식 Arachne(SkeletalTrapezoidation)가 와일드 포인터 trap 으로 죽는다(실측: 레이어 0 즉발,
          //  ASAN 리포트 없는 raw OOB; classic 은 동일 모델 완주). 원본 OrcaSlicer 는 resolution 단순화를
          //  거친 윤곽을 넘기지만 커널 PASS1 은 생략하므로, 점수 임계 초과 시에만 5µm 톨러런스로 감량.
          //  임계 미만(골든 픽스처 포함)은 무변경 → golden byte-identical 유지.
          // [Arachne 입력 위생] 원본은 resolution(0.012mm) 단순화된 strictly-simple 윤곽을 먹지만
          //  커널 PASS1 은 원시 슬라이스 윤곽을 그대로 넘긴다. 비다양체 모델(셸 겹침·자가접촉)의
          //  레이어에는 µm 엣지·자가교차·슬리버가 남아 이식 SkeletalTrapezoidation 이 와일드 포인터로
          //  즉사한다(실측: 300만 tri 모델, 크래시 레이어 입력에 1µm 엣지 10개 + 자가교차 폴리곤).
          //  원본 규칙에 맞춰 3단 위생: ①10µm Clean(µm 엣지 붕괴) ②재-Simplify(Clean 이 만들 수 있는
          //  자가교차 해소, strictly-simple 재확립) ③노즐 미만 슬리버(<0.02mm²) 제거.
          //  정상 윤곽(골든 픽스처 포함)은 3단 모두 무변경 통과.
          Paths arachneSrc = ld.contour;
          CleanPolygons(arachneSrc, SCALE * 0.01);
          arachneSrc = SimplifyPolygons(arachneSrc, pftEvenOdd);
          { const double minA = 0.02 * SCALE * SCALE;
            arachneSrc.erase(std::remove_if(arachneSrc.begin(), arachneSrc.end(),
              [&](const Path& q){ return q.size() < 3 || std::fabs(Area(q)) < minA; }), arachneSrc.end()); }
          std::vector<std::vector<std::pair<double,double>>> polys;
          for (const Path& pth : arachneSrc) {
            std::vector<std::pair<double,double>> poly; poly.reserve(pth.size());
            for (const IntPoint& q : pth) poly.push_back({q.x()*INV, q.y()*INV});
            if (poly.size() >= 3) polys.push_back(std::move(poly));
          }
          if (p.arachne_dump) {   // 임시 진단: 크래시 직전 입력 캡처(마지막 출력 = 죽는 레이어)
            fprintf(stderr, "ARACHNE_IN L=%d npolys=%d\n", i, (int)polys.size());
            for (size_t pi=0; pi<polys.size(); ++pi) {
              fprintf(stderr, "P%d[%d]:", (int)pi, (int)polys[pi].size());
              for (auto& q : polys[pi]) fprintf(stderr, " %.6f,%.6f", q.first, q.second);
              fprintf(stderr, "\n");
            }
            fflush(stderr);
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
      // [PASS1 실진행] mt 는 PASS1 을 한 번에 보고해 브라우저에서 2.8s(실측) 동안 0% 정지로 보였다.
      //  서포트와 같은 SAB 카운터(진행 퍼밀 0..1000)를 워커가 갱신 → UI 스레드가 폴링해 0→35% 밴드 표시.
      std::atomic<unsigned> p1done{0};
      auto* p1prog = (std::atomic<unsigned>*)(uintptr_t)treesupport_bridge::progress_addr();
      p1prog->store(0);
      auto workfn = [&]{ int i; while (!CX() && (i = nextIdx.fetch_add(1)) < N) { computeLayer(i);
        unsigned d = p1done.fetch_add(1) + 1; p1prog->store((unsigned)((unsigned long long)d * 1000u / (unsigned)N)); } };
      std::vector<std::thread> ths; ths.reserve(nt-1);
      for (unsigned t=1; t<nt; ++t) ths.emplace_back(workfn);
      workfn();                                  // 메인 스레드도 참여
      for (auto& th : ths) th.join();
      p1prog->store(0);                          // 서포트 밴드 오염 방지(ParallelScope 리셋 전 잔존값 제거)
      if (CX()) { em::val r=em::val::object(); r.set("error", std::string("canceled")); return r; }   // G002
      report(N, total);                          // JS 콜백은 메인 스레드 전용 → 코스 단위 보고
    }
#else
    for (int i=0;i<N;++i){ if (CX()) { em::val r=em::val::object(); r.set("error", std::string("canceled")); return r; } computeLayer(i); report(i+1, total); }
#endif
  }

  tw_p1 = emscripten_get_now();

  // ---- PASS 1.5: 표면 검출 (이 레이어 fill − 이웃 contour) ----
  //  레이어 독립(읽기: 이웃 contour 불변, 쓰기: 자기 topSurf/botSurf) → PASS1 과 동일한 레이어 병렬.
  {
    auto surfOne = [&](int i){
      if (L[i].fill.empty()) return;
      Paths above = (i+1<N) ? L[i+1].contour : Paths{};
      Paths below = (i-1>=0) ? L[i-1].contour : Paths{};
      L[i].topSurf = clip_paths(L[i].fill, above, ctDifference);  // 위가 비면 top 표면
      L[i].botSurf = clip_paths(L[i].fill, below, ctDifference);  // 아래가 비면 bottom 표면
    };
#ifdef __EMSCRIPTEN_PTHREADS__
    { unsigned hw = std::thread::hardware_concurrency();
      unsigned nt = std::max(1u, std::min<unsigned>(hw ? hw : 4, (unsigned)std::max(1, N)));
      std::atomic<int> nextIdx{0};
      auto workfn = [&]{ int i; while ((i = nextIdx.fetch_add(1)) < N) surfOne(i); };
      std::vector<std::thread> ths; ths.reserve(nt-1);
      for (unsigned t=1; t<nt; ++t) { try { ths.emplace_back(workfn); } catch (...) { break; } }
      workfn();
      for (auto& th : ths) th.join(); }
#else
    for (int i=0;i<N;++i) surfOne(i);
#endif
  }

  tw_p15 = emscripten_get_now();
  report(N+1, total);                            // 표면 검출 완료 틱 (서포트 생성 진입 표시)

  // ---- PASS 1.6: 서포트 (오버행 검출 → 수직 투영 → iface/base) ----
  // (G003: 스킵 블록 밖 preamble 에서 사용 → 위로 호이스트됨)
  if (p.enable_support) {
   // WP2: "grid"/"snug" 도 이제 원본 포트(PrintObjectSupportMaterial) 경로 — 자체 재구현은 tree_lite
   //  (및 명시적 "grid_kernel" 폴백)만 사용한다. tree 와 동일한 파사드/좌표 변환/rebind 를 공유한다.
   const bool portNormal = (p.support_style == "grid" || p.support_style == "snug");
   if (p.support_style == "tree" || portNormal) {
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
    // [초고밀도 윤곽 가드] arachne 가드와 동일 규칙: 레이어당 2만 점 초과 시에만 5µm 감량.
    //  원본 OrcaSlicer 는 resolution 단순화를 거친 윤곽을 서포트에 넘기지만 커널 PASS1 은 생략하므로
    //  대형 모델(774k tri 실측)에서 포트 서포트 비용이 점수에 비례 폭증. 임계 미만(골든 픽스처)은 무변경.
    auto sanitized = [&](const Paths& src) -> Paths {
      size_t npts = 0; for (const Path& q : src) npts += q.size();
      if (npts <= 20000) return src;
      Paths out = src; CleanPolygons(out, SCALE * 0.005); return out;
    };
    for (int j=0;j<N;++j) {
      zs[j] = L[j].z;
      for (const Path& ring : sanitized(L[j].contour)) {
        treesupport_bridge::Ring r; r.reserve(ring.size());
        for (const IntPoint& pt : ring) r.emplace_back(pt.x()*INV - tcx, pt.y()*INV - tcy);
        if (r.size()>=3) slices[j].push_back(std::move(r));
      }
    }
    treesupport_bridge::Params tsp;
    tsp.layer_height_mm=p.layer_height; tsp.nozzle_mm=p.nozzle_diameter;
    tsp.first_layer_height_mm=p.first_layer_height;                 // WP1: 원본 initial_layer_print_height 대응
    tsp.line_width_mm=p.line_width;                                 // WP1: lslices_extrudable 필터 + auto-threshold flow
    tsp.support_threshold_angle=p.support_threshold_angle;
    tsp.support_top_z_distance=p.support_top_z_distance;
    tsp.support_bottom_z_distance=p.support_bottom_z_distance;      // WP1: → gap_object_support
    tsp.support_xy_distance=p.support_xy_distance;
    tsp.first_layer_gap_mm=p.support_object_first_layer_gap;        // WP1
    tsp.interface_top_layers=p.support_interface_top_layers;
    tsp.interface_bottom_layers=p.support_interface_bottom_layers;  // WP1: -1 => top 과 동일
    tsp.independent_support_layer_height=p.independent_support_layer_height; // WP1: 갭 양자화 스위치
    tsp.support_auto=p.support_auto;                                // 20단계: 자동/수동(페인트 enforcer만)
    tsp.support_line_width_mm=p.support_line_width;                 // 19단계: 실 서포트 압출폭(config→flow→per-path)
    tsp.support_angle_deg=p.support_angle;                          // WP1: SupportParameters::base_angle
    tsp.on_build_plate_only=p.support_on_build_plate_only;          // WP1
    tsp.tree_style=p.tree_style;                                    // WP1: organic|slim|strong|hybrid
    tsp.branch_angle_deg=p.tree_support_branch_angle;               // WP1: 트리 형상 키 일괄 배선
    tsp.angle_slow_deg=p.tree_support_angle_slow;
    tsp.branch_diameter_mm=p.tree_support_branch_diameter;
    tsp.branch_distance_mm=p.tree_support_branch_distance;
    tsp.branch_diameter_angle_deg=p.tree_support_branch_diameter_angle;
    tsp.tip_diameter_mm=p.tree_support_tip_diameter;
    tsp.top_rate_pct=p.tree_support_top_rate;
    tsp.wall_count=p.tree_support_wall_count;
    tsp.interface_pattern=p.support_interface_pattern;              // WP1: 인터페이스/베이스 패턴·간격
    tsp.base_pattern=p.support_base_pattern;
    tsp.interface_spacing_mm=p.support_interface_spacing;
    tsp.base_pattern_spacing_mm=p.support_base_pattern_spacing;
    tsp.bed_width_mm=p.bed_width; tsp.bed_depth_mm=p.bed_depth;
    tsp.printable_height_mm=p.printable_height;                     // WP1: BuildVolume 높이(이전 기본 100mm 고정)
    tsp.resolution_mm=p.gcode_resolution;   // 33단계: 트리 경로 단순화 허용오차(원본 print_config "resolution")
    std::vector<treesupport_bridge::LayerOut> tlayers;
    if (portNormal) {
      // WP2: 원본 normal(grid/snug) 서포트 — PASS 1.5 표면(topSurf/botSurf)을 stTop/stBottom 으로 공급
      //  (bottom contact 검출·sharp-tail 이 원본 그대로 동작). 좌표는 슬라이스와 동일하게 −tcx/−tcy 이동.
      tsp.normal_style = p.support_style;                           // grid|snug → smsGrid|smsSnug
      tsp.support_expansion_mm = p.support_expansion;
      tsp.bridge_no_support    = p.bridge_no_support;
      tsp.remove_small_overhang= p.support_remove_small_overhang;
      tsp.threshold_overlap_pct= p.support_threshold_overlap * 100.0; // 커널 비율(0.5) → 원본 %(50)
      std::vector<treesupport_bridge::LayerSurf> surfs(N);
      auto toRings=[&](const Paths& psRaw, std::vector<treesupport_bridge::Ring>& out){
        Paths ps = sanitized(psRaw);               // 표면도 동일 가드(대형 모델 한정 감량)
        for (const Path& ring : ps) {
          treesupport_bridge::Ring r; r.reserve(ring.size());
          for (const IntPoint& pt : ring) r.emplace_back(pt.x()*INV - tcx, pt.y()*INV - tcy);
          if (r.size()>=3) out.push_back(std::move(r));
        }
      };
      for (int j=0;j<N;++j) { toRings(L[j].topSurf, surfs[j].top); toRings(L[j].botSurf, surfs[j].bottom); }
      tlayers = treesupport_bridge::generate_normal(slices, zs, surfs, tsp);
    } else {
      tlayers = treesupport_bridge::generate(slices, zs, tsp);
    }
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
        if (pl.size()>=2) L[best].supTree.push_back({std::move(pl), (float)ln.width,
                              ln.role, (float)ln.height, (float)ln.mm3_per_mm});  // WP3: role/height/mm3 보존
      }
    }
   } else {
    // 층당 허용 수평 이동 = layer_height / tan(θ). 원본 detect_overhangs(SupportMaterial.cpp:1439)
    //  lower_layer_offset = scale_(lower_layer.height / tan(threshold_rad)) 와 동일.
    //  θ 는 "기울기 각(90°=수직)" 이라 작을수록 완만 → 확장량이 커져 서포트가 줄어든다(원본 툴팁 정합).
    //  ※ 33단계 이전에는 tan 이 분자에 있어 방향이 반대였다(30°에서 3배 과다 검출). 45°에서만 우연히 일치.
    //  경계: 원본과 같이 89° 로 클램프(tan→∞ 방지), θ<=0 은 "전면 서포트"(확장 0)로 처리.
    const double thrDeg = std::min(89.0, p.support_threshold_angle);
    // 33단계: θ=0 은 "자동" — 원본은 각도 대신 겹침 기준을 쓴다(detect_overhangs):
    //   lower_layer_offset = fw - scale_(support_threshold_overlap.get_abs_value(fw))
    //  기존엔 0 을 그대로 써 하층 확장이 0(=모든 상층 증가분이 오버행)이 되는 과다검출이었다.
    double maxStep = (thrDeg > 0.0) ? (p.layer_height / std::tan(thrDeg * PI/180.0))
                                    : std::max(0.0, w - p.support_threshold_overlap * w);
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
    // 오버행: contour_i − offset(contour_{i-1}, +maxStep)
    // 33단계: 기존의 형태학 열림(offset -openR → +openR)을 제거한다. 열림은 폭 2*openR(=1.26w) 미만의
    //  띠를 통째로 지워, 완만한 경사(실측 25° 이상)에서 서포트가 아예 생성되지 않게 만들고 있었다
    //  (support_threshold_angle 을 사실상 무력화). 원본 detect_overhangs 는 오버행 결과를 침식하지 않고,
    //  ① 하층 slice 중 압출폭 미만의 섬을 먼저 걸러내고(offset(-fw/2) 가 비면 제외; "Do not use offset2()")
    //  ② 결과는 면적 기준으로 정리한다. 여기서도 동일하게 한다.
    const double minOhArea = (p.support_overhang_min_area > 1e-9) ? p.support_overhang_min_area : (w*w);
    std::vector<Paths> overhang(N);
    if (p.support_auto) for (int i=1;i<N;++i) {
      // 32단계 Fix A: 하층이 비어도(부유 파트, 풀 z-gap 위) skip 하지 않는다 — 하층 없으면
      //  offset(empty)=empty 라 clip 결과가 contour_i 전체 = 전면 오버행 → 그 아래 서포트 생성.
      if (L[i].contour.empty()) continue;
      // ① 하층 섬 필터: 압출폭 미만으로 얇은 하층 조각은 지지력이 없으므로 하층에서 제외(원본 규칙)
      Paths lower;
      for (const Path& isl : L[i-1].contour) {
        Paths one{isl};
        if (!offset_paths(one, -w*0.5).empty()) lower.push_back(isl);
      }
      Paths oh = clip_paths(L[i].contour, offset_paths(lower, maxStep), ctDifference);
      if (oh.empty()) continue;
      // 33단계: bridge_no_support — 브리지로 걸쳐 출력될 영역엔 서포트를 만들지 않는다(원본 동명 옵션).
      //  브리지 후보 = 이 레이어의 노출 바닥면(botSurf, PASS 1.5 산출). 커널은 이미 반대 방향
      //  (서포트 접촉면은 브리지 아님)을 처리하고 있었고, 이쪽 방향이 빠져 있었다.
      if (p.bridge_no_support && !L[i].botSurf.empty()) {
        oh = clip_paths(oh, L[i].botSurf, ctDifference);
        if (oh.empty()) continue;
      }
      // 33단계: support_expansion — 오버행 영역을 넓혀 접촉면을 키운다(원본 xy_expansion).
      if (p.support_expansion > 1e-9) oh = offset_paths(oh, p.support_expansion);
      // ② 성분별 선별(침식이 아니라 판정 — 통과한 성분은 원형 그대로 보존된다)
      //   ⓐ 면적: 최소면적 미만은 수치 노이즈
      //   ⓑ support_remove_small_overhang(원본 default true, SupportMaterial.cpp:2244):
      //      원본은 오버행을 층간 클러스터로 묶고 1×압출폭 침식 후 bbox 가 2×압출폭 미만이면 버린다.
      //      여기서는 성분 단위 근사 — offset(-w) 가 비면 "두 줄도 못 놓는 조각"이라 버린다.
      //      ※ 이건 모양을 깎지 않는다(판정만). 기존 openR 열림은 모양 자체를 침식해 띠를 지웠다.
      // 부유 아일랜드 면제: 아래(lower)가 통째로 비면 이 층은 공중에서 시작하는 섬이다.
      //  크기와 무관하게 서포트가 없으면 출력 자체가 불가하므로 작은-오버행 제거 대상에서 뺀다.
      //  원본은 같은 상황을 cantilever/sharp-tail 예외로 살린다(SupportMaterial.cpp:2270 부근) —
      //  그 검출기가 없는 우리는 "아래가 비었는가"로 근사한다.
      //  ※ 실측: 이 면제가 없으면 실물 Benchy 굴뚝(얇은 벽 링, z40.4)이 offset(-w) 에서 사라져
      //    서포트가 전혀 생기지 않고 공중에 떴다.
      const bool floatingIsland = lower.empty();
      Paths keep;
      for (const Paths& comp : split_components(oh)) {
        if (paths_area(comp) < minOhArea) continue;
        if (p.support_remove_small_overhang && !floatingIsland) {
          // 원본이 작은-오버행 제거에서 면제하는 두 부류(SupportMaterial.cpp:2270 부근)를 구현한다.
          //  ⓐ sharp tail: 면적 < 36mm²(=6×6, area_thresh_well_supported) 이면서 0.1×fw 침식에
          //     살아남는 얇고 뾰족한 섬. 지지 없이는 무너지므로 유지.  (원본 :1484)
          const bool sharpTail = paths_area(comp) < 36.0 && !offset_paths(comp, -0.1*w).empty();
          //  ⓑ cantilever: 하층에 붙어 있으나 그 접합부에서 3mm 넘게 뻗어나간 외팔보. (원본 :1524-1542)
          //     원본은 접합부까지의 최대 거리를 재지만, 여기서는 동치인 집합 연산으로 판정한다 —
          //     접합부를 3mm 팽창시켜도 남는 부분이 있으면 3mm 초과로 뻗은 것이다.
          bool cantilever = false;
          {
            Paths base = clip_paths(comp, offset_paths(lower, std::max(w, maxStep) + 0.1), ctIntersection);
            if (!base.empty()) cantilever = !clip_paths(comp, offset_paths(base, 3.0), ctDifference).empty();
          }
          if (!sharpTail && !cantilever && offset_paths(comp, -w).empty()) continue;
        }
        for (const Path& q : comp) keep.push_back(q);
      }
      if (!keep.empty()) overhang[i] = keep;
    }
    // enforcer: 페인트 영역을 오버행으로 강제 추가(아래로 서포트 컬럼 투영). blocker: 오버행에서 차감(그 아래
    //  컬럼 미생성) — tree generate_overhangs 와 동일 의미(overhangs -= blockers).
    for (int i=0;i<N;++i) if (!enfL[i].empty()) overhang[i] = union_paths(overhang[i], enfL[i]);
    for (int i=0;i<N;++i) if (!blkL[i].empty()) overhang[i] = clip_paths(overhang[i], blkL[i], ctDifference);
    // 하강 투영: 위→아래.
    // 33단계 [공중 뜬 서포트 수정] 원본 project_support_to_grid(SupportMaterial.cpp) 규칙을 따른다:
    //   Polygons trimming = offset(layer.lslices, EPS);
    //   overhangs_projection = diff(overhangs, trimming);   // ← 투영 자체를 깎아서 아래로 넘긴다
    //   ...  out.second(=깎인 투영) 가 다음(아래) 레이어의 overhangs_projection 이 된다
    // 즉 모델에 닿은 투영은 거기서 영구히 소멸한다(= 그 지점이 bottom contact, 서포트가 모델 위에 착지).
    // 기존 구현은 accum 을 모델 차감 없이 누적만 하고 클립을 "나중에 레이어별로" 했기 때문에,
    //  레이어 j 에서 모델에 가려 지워진 영역이 모델이 사라지는 j-1 에서 되살아나 **공중에 뜬 서포트**가 됐다.
    // ※ 원본의 "얇아진 컬럼 전파 중단"(column_propagation_filtering_radius 로 opening)은 실제로는
    //   주석 처리되어 비활성이다(SupportMaterial.cpp:2701). 여기서도 하지 않는다 —
    //   레이어 j 에서 컬럼을 지우면 그 위 j+1 의 서포트가 받칠 것을 잃어 오히려 부유가 생긴다(실측 확인).
    bool treeLite = (p.support_style == "tree_lite");
    // 33단계: support_on_build_plate_only — 원본 project_support_to_grid 는 이 옵션이 켜지면
    //  trimming 을 "이 레이어의 모델"이 아니라 buildplate_covered(아래에서 누적된 모델 발자국)로 바꾼다.
    //  결과적으로 모델이 한 번이라도 있었던 XY 에는 투영이 살아남지 못해, 베드까지 곧장 내려가는 기둥만 남는다.
    std::vector<Paths> covered;
    if (p.support_on_build_plate_only) {
      covered.resize(N); Paths cov;
      for (int j=0;j<N;++j) { if (!L[j].contour.empty()) cov = union_paths(cov, L[j].contour); covered[j]=cov; }
    }
    std::vector<Paths> column(N);
    Paths accum;
    for (int j=N-1;j>=0;--j) {
      if (treeLite) accum = tree_taper(accum, p.tree_lite_shrink, p.tree_lite_min_radius);  // 층당 테이퍼(최소기둥 유지)
      int src=j+gap; if (src<N) accum = union_paths(accum, overhang[src]);
      // ★ 원본 diff(overhangs, trimming): 이 레이어의 모델을 투영에서 빼고, 그 결과가 아래로 계속된다.
      //   이 한 줄이 "모델에 착지한 서포트는 거기서 끝난다"(bottom contact)를 만든다.
      const Paths& trim = p.support_on_build_plate_only ? covered[j] : L[j].contour;
      if (!trim.empty()) accum = clip_paths(accum, offset_paths(trim, p.support_xy_distance), ctDifference);
      column[j]=accum;
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
      // 33단계: 그리드 스냅(원본 SupportGridPattern). 스냅 후 모델 영역으로 다시 트리밍한다 —
      //  원본도 support_grid_pattern(support_polygons, trimming_polygons) 로 두 인자를 함께 넘긴다.
      //  grid style 에만 적용(tree_lite 는 테이퍼 형상이 목적이라 스냅하면 의미가 사라진다).
      if (!treeLite && p.support_grid_snap) {
        Paths snapped = grid_snap(col, support_spacing);
        snapped = clip_paths(snapped, modelClear, ctDifference);   // 스냅으로 부푼 부분이 모델을 침범하지 않게
        if (!snapped.empty()) col = snapped;
      }
      Paths iface;
      for (int k=0;k<ifaceN;++k){ int s=j+gap+k; if (s<N) iface = union_paths(iface, overhang[s]); }
      iface = clip_paths(iface, col, ctIntersection);
      // 33단계: support_interface_bottom_layers — 서포트가 모델 상면에 얹히는 쪽(bottom contact)의
      //  인터페이스. 원본 generate_interface_layers 는 top/bottom 인터페이스를 따로 만든다
      //  (SupportParameters.hpp:37 num_bottom_interface_layers). 우리는 top 만 있었다.
      //  판정: 이 층의 서포트 바로 아래(botGap 만큼 띄운 지점) 근방에 모델이 있으면 그 부분이 바닥 접촉면.
      if (p.support_interface_bottom_layers > 0) {
        Paths under;
        for (int k=botGap;k<botGap+p.support_interface_bottom_layers;++k) {
          int b=j-k; if (b>=0 && !L[b].contour.empty()) under = union_paths(under, offset_paths(L[b].contour, p.support_xy_distance));
        }
        if (!under.empty()) {
          Paths botIface = clip_paths(col, under, ctIntersection);
          if (!botIface.empty()) iface = union_paths(iface, botIface);
        }
      }
      L[j].supIface = iface;
      L[j].supBase  = clip_paths(col, iface, ctDifference);
    }
   }
  }

  // ---- 프리앰블 ----
  }                                              // G003: reuseSup 스킵 블록 끝 (PASS1~1.6 만 스킵 — 프리앰블·래프트·방출은 공용)

  GW gw; gw.s.reserve(1<<17);
  gw.retract_len = p.retract_length;
  gw.retract_min_travel = p.retraction_minimum_travel;
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
#ifdef __EMSCRIPTEN_PTHREADS__
  // (mt) 오버랩 대상: 스트리밍 full 추정 + 배치 full 추정(realPE 는 전체 문자열 후처리가 필요해 제외,
  //  transcribed 는 다른 엔진이라 기존 경로 유지). 배치는 gw.s 누적분을 flush 시점마다 잘라 피드한다.
  TimeFeeder feeder;
  const bool overlapBatch = !streaming && !realPE && p.time_engine != "transcribed";
  size_t fedOff = 0;                            // 배치 오버랩: gw.s 에서 이미 피드한 오프셋
  if (streamTime || overlapBatch) feeder.begin(gl);
  auto feed_batch_tail = [&]{                   // 마지막 flush 이후분(푸터 포함) 피드
    std::string c = gw.s.substr(fedOff); fedOff = gw.s.size();
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(c);   // 배치도 추정 입력은 스트리밍과 동일하게 태그 제거
    feeder.feed(std::move(c));
  };
#else
  if (streamTime) gcodeproc_bridge::estimate_begin(gl);
#endif
  // 레이어 방출: 배치=layersArr 누적, 스트리밍=청크(gw.s 직전 flush 이후분)+툴패스 방출 후 gw.s 해제.
  //  프리앰블은 첫 flush 청크에, 마무리는 마지막 flush 청크에 포함 → 청크 이어붙이면 배치 gw.s 와 byte-identical.
  auto flush_layer = [&](double z, int idx, std::vector<float>& tp, std::vector<float>& widths) {
    double tf0 = emscripten_get_now();
    struct TF { double& acc, t0; ~TF(){ acc += emscripten_get_now() - t0; } } tf{t_flush, tf0};
    if (!streaming) {
      em::val Lo=em::val::object(); Lo.set("z",z); Lo.set("paths",to_f32(tp)); Lo.set("widths",to_f32(widths));
      layersArr.call<void>("push", Lo);
#ifdef __EMSCRIPTEN_PTHREADS__
      if (overlapBatch) feed_batch_tail();               // 레이어 경계('\n' 정렬)마다 추정 워커에 증분 피드
#endif
      return;
    }
    std::string chunk; chunk.swap(gw.s);                 // 누적분 인출 + gw.s 비움(힙 해제)
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(chunk);   // 줄 단위 무상태 필터(청크=배치 동일)
#ifdef __EMSCRIPTEN_PTHREADS__
    if (streamTime) feeder.feed(chunk);                  // 복사 피드 — chunk 는 이후 sink 로도 전달
#else
    if (streamTime) gcodeproc_bridge::estimate_feed(chunk);
#endif
    em::val paths = economy ? em::val::array() : to_f32(tp);
    em::val wid   = economy ? em::val::array() : to_f32(widths);
    sink(z, idx, chunk, paths, wid);
  };

  // ---- 래프트 (모델 아래 삽입, 모델 z 시프트) ----
  double zShift = 0.0;
  int nraft = std::max(0, p.raft_layers);
  if (nraft > 0 && !L.empty() && !L[0].contour.empty()) {
    const double raftFirstH = p.raft_first_layer_height;   // 33단계: 0.30 상수 → 파라미터
    Paths base = L[0].contour;
    base = union_paths(base, L[0].supIface);
    base = union_paths(base, L[0].supBase);
    Paths raftArea = offset_paths(base, p.raft_expansion); // 33단계: +3.0 상수 → raft_expansion(원본 default 1.5)
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
    // 33단계: raft_contact_distance 배선 — 래프트 최상면과 모델 첫 레이어 사이 간격(분리용 에어갭).
    zShift = raftFirstH + (nraft-1)*p.layer_height + p.raft_contact_distance;   // 모델 첫 레이어 Z = zShift + first_layer_height
  }

  tw_sup = emscripten_get_now();
  if (CX()) { em::val r=em::val::object(); r.set("error", std::string("canceled")); return r; }   // G002 (이 지점까지 스레드 없음)
  report(N+2, total);                            // 서포트 생성 완료 틱

  // ---- PASS 2 사전계산: 레이어별 기하 분리·인필 라인 생성 (아래 방출 루프에서 분리) ----
  //  기존 방출 루프 내 계산 블록의 verbatim 이동 — 수식·호출 순서 불변(golden byte-identical 로 검증).
  auto compute_pre = [&](int i) -> EmitPre {
    EmitPre ep;
    LayerData& ld = L[i];
    const double zE = ld.z + zShift;
    ep.fSup = (int)std::llround(((i==0)?p.first_layer_speed:p.print_speed)*60);
    // 서포트 라인 — 모델 유무 공통(빈 레이어 분기와 동일 수식: angB==supBaseAng, ifSp==ifaceSp)
    const double supBaseAng  = p.support_angle + (i % 2 ? -45.0 : 45.0);
    const double supIfaceAng = supBaseAng + 90.0;
    auto resolvePat = [](const std::string& s) { return (s=="default"||s=="auto"||s=="rectilinear-grid") ? std::string("rectilinear") : s; };
    const double ifaceSp = (p.support_interface_spacing > 1e-6) ? (w + p.support_interface_spacing) : solid_spacing;
    ep.supI = (p.enable_support && !ld.supIface.empty())
      ? build_sparse(ld.supIface, resolvePat(p.support_interface_pattern), supIfaceAng, ifaceSp, i, zE, w, 1.0) : Paths{};
    ep.supB = (p.enable_support && !ld.supBase.empty())
      ? build_sparse(ld.supBase, resolvePat(p.support_base_pattern), supBaseAng, support_spacing, i, zE, w, p.support_density) : Paths{};
    if (ld.contour.empty() || p.spiral_mode) return ep;   // 빈 레이어=서포트만, 스파이럴=ep 미사용

    // 갭필: 최내벽 안쪽 fill 의 morphological-open 잔여(폭<w 얇은 틈) → 중심선 근사(단일폭 라인).
    //  ⚠ 근사 — 메디얼축/가변폭 아님. open(X)=dilate(erode(X)), 잔여=X−open. fillCore 에서 제외해 이중압출 방지.
    Paths gap, fillCore = ld.fill;
    if (!ld.fill.empty()) {
      Paths opened = morph_open(ld.fill, w*0.5);
      gap = clip_paths(ld.fill, opened, ctDifference);
      gap = offset_paths(offset_paths(gap, -w*0.1), w*0.1);            // <0.2w 노이즈 제거
      if (!gap.empty()) fillCore = clip_paths(ld.fill, gap, ctDifference);
    }
    ep.gapLines = gap.empty() ? Paths{} : infill_clipped(gap, p.infill_angle, w);

    // 씬월 중심선(폭<2w 영역) — 성분별 장축 중심선 1줄 + 국소폭 flow 보정
    if (!ld.thin.empty()) {
      for (const Paths& comp : split_components(ld.thin)) {
        Paths line = centerline_of(comp, w);
        if (line.empty()) continue;
        double A = paths_area(comp), Ln = paths_len(line,false);
        double width = (Ln>1e-3) ? A/Ln : w;
        ep.thinRuns.push_back({std::move(line), std::min(2.0, std::max(0.4, width/w))});
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
    double wSolid  = firstL ? p.initial_layer_line_width : p.internal_solid_infill_line_width;
    double wTop    = firstL ? p.initial_layer_line_width : p.top_surface_line_width;
    // top-surface 를 solid 에서 분리(top_surface_line_width 적용)는 폭이 다를 때만 — 같으면 단일 solid(무회귀).
    Paths topPart, restSolid = solid;
    if (!topSolid.empty() && std::abs(wTop - wSolid) > 1e-6) {
      topPart   = clip_paths(solid, topSolid, ctIntersection);
      restSolid = clip_paths(solid, topPart, ctDifference);
    }
    ep.solidLines = restSolid.empty() ? Paths{} : infill_clipped(restSolid, sa, solid_spacing);
    if (!ep.solidLines.empty()) sort_monotonic(ep.solidLines, sa);
    ep.topLines  = topPart.empty() ? Paths{} : infill_clipped(topPart, sa, solid_spacing);
    if (!ep.topLines.empty()) sort_monotonic(ep.topLines, sa);
    ep.bridgeLines = bridge.empty() ? Paths{} : infill_clipped(bridge, sa, solid_spacing);
    ep.sparseLines = (sparse_spacing>0 && !sparse.empty())
        ? build_sparse(sparse, p.sparse_infill_pattern, p.infill_angle, sparse_spacing, i, zE, w, p.infill_density) : Paths{};
    // 스커트/브림 — 33단계: skirt_height 배선 + brim_object_gap 배선
    if (i < std::max(1, p.skirt_height) && nraft==0) {
      int brimRings = (int)std::llround(p.brim_width / w); ep.brim = brimRings>0 && i==0;   // 브림은 첫 레이어만
      for (int k=0; k<p.skirt_loops; ++k) { Paths r=offset_paths(ld.contour,(p.skirt_distance+w*0.5+k*w)); for (auto& q:r) ep.flExtra.push_back(q); }
      if (i==0) for (int k=1; k<=brimRings; ++k) { Paths r=offset_paths(ld.contour,(p.brim_object_gap+w*0.5+k*w)); for (auto& q:r) ep.flExtra.push_back(q); }
    }

    double thinLen=0; for (auto& tr:ep.thinRuns) thinLen += paths_len(tr.line,false);
    double layerLen = vwalls_len(ld.walls) + paths_len(ep.solidLines,false) + paths_len(ep.sparseLines,false)
                    + paths_len(ep.supI,false) + paths_len(ep.supB,false) + paths_len(ep.flExtra,true)
                    + paths_len(ep.gapLines,false) + paths_len(ep.bridgeLines,false) + thinLen;
    double baseSpeed = (i==0 && nraft==0) ? p.first_layer_speed : p.print_speed;
    double useSpeed = baseSpeed;
    if (p.slow_down_layer_time > 0 && layerLen > 1e-6 && layerLen/baseSpeed < p.slow_down_layer_time)
      useSpeed = std::min(baseSpeed, std::max(20.0, layerLen / p.slow_down_layer_time));   // 소형 레이어 감속(최저 20mm/s)
    ep.fPrint = (int)std::llround(useSpeed*60);
    ep.fBridge = (int)std::llround(std::max(5.0, p.bridge_speed)*60);

    // 아이어닝(type10) 라인 사전계산 — 방출 시 pre.ironLines 사용
    if (ironOn && !ld.topSurf.empty()) {
      Paths ironArea = clip_paths(ld.topSurf, fillCore, ctIntersection);
      ep.ironLines = ironArea.empty() ? Paths{} : infill_clipped(ironArea, sa+45.0, std::max(0.05, p.ironing_spacing));
    }
    return ep;
  };

#ifdef __EMSCRIPTEN_PTHREADS__
  // (mt) PASS2 계산부 병렬 — 워커들이 소비자(방출)보다 최대 PRE_WINDOW 레이어 앞서 선계산.
  //  안전성: 소비자가 i 를 처리 중이면 in-flight 워커는 항상 k>i(잡은 순서대로 완료 대기하므로),
  //  워커가 읽는 L[j] 는 j ≥ k−bottom_shell+1 > 조기해제 지점 old=i−max(bsl,1)−1 → 해제와 무충돌.
  //  윈도우로 상주 메모리 유계(레이어 라인 W개분) — 조기 해제 OOM 완화 유지.
  std::vector<EmitPre> preBuf(N);
  std::vector<uint8_t> preDone(N, 0);
  std::mutex pmu; std::condition_variable cv_done, cv_room;
  int preNext = 0, preConsumed = -1;
  unsigned preHW = std::thread::hardware_concurrency(); if (!preHW) preHW = 4;
  const bool parEmit = !p.spiral_mode && !scarfOn && gw.pe_slope <= 0.0 && !gw.emit_pe_tags
                       && p.wall_generator != "arachne" && !realPE;   // G003 병렬 방출 가능 조건(그 외 직렬 폴백)
  unsigned preNT = std::min<unsigned>(std::max(1u, parEmit ? preHW / 2 : preHW - 1), (unsigned)std::max(1, N));
  const int PRE_WINDOW = (int)preNT * 2 + 4;
  auto preWork = [&]{
    for (;;) {
      int k = -1;
      { std::unique_lock<std::mutex> lk(pmu);
        cv_room.wait(lk, [&]{ return preNext >= N || preNext <= preConsumed + PRE_WINDOW; });
        if (preNext >= N) break;
        k = preNext++;
      }
      EmitPre ep = compute_pre(k);
      { std::lock_guard<std::mutex> lk(pmu); preBuf[k] = std::move(ep); preDone[k] = 1; }
      cv_done.notify_all();
    }
  };
  std::vector<std::thread> preThs; preThs.reserve(preNT);
  for (unsigned t=0; t<preNT; ++t) preThs.emplace_back(preWork);
#endif

  // ---- PASS 2: 솔리드/스파스 인필 분리 + 서포트 + 방출 ----
#ifdef __EMSCRIPTEN_PTHREADS__
  if (parEmit) {
    // G003: E1(직렬 드라이런 — 심·위치·curF·팬 진입상태 체인) → 작가 풀(레이어별 G-code/툴패스 생성)
    //  → 순서 플러시. E 는 상대(M83)라 레이어-로컬, 교차 상태는 진입 커서로 완결 → st(직렬)와 byte-identical
    //  (게이트: golden + 대형모델 cmp). filament 는 레이어 부분합의 순서 합산(결합순서만 상이 — 푸터 %.2f 반올림
    //  경계 이론 리스크는 골든으로 검증). 창(FW)으로 상주 유계 → 스트리밍 OOM 완화 유지.
    struct Cursor { double px, py; int curF, lastFan; SeamCtx sc; };
    struct EmitJob {
      EmitPre pre; Cursor entry; Paths island;
      std::string gcode; std::vector<float> tp, widths;
      double filament = 0; long segments = 0, crossings = 0;
      std::atomic<int> jst{0};   // 0=준비 1=디스패치 2=완료
    };
    std::vector<std::unique_ptr<EmitJob>> jobs(N);
    for (int k = 0; k < N; ++k) jobs[k] = std::make_unique<EmitJob>();
    std::mutex emu; std::condition_variable ecv;
    int wNext = 0, dispatched = 0;
    GW base = gw; base.s.clear(); base.island.clear(); base.dry = false;   // 작가 GW 설정 원본
    unsigned wHW = std::thread::hardware_concurrency(); if (!wHW) wHW = 4;
    unsigned WN = std::max(1u, wHW / 2);
    auto writerFn = [&]{
      for (;;) {
        int k = -1;
        { std::unique_lock<std::mutex> lk(emu);
          ecv.wait(lk, [&]{ return wNext < dispatched || wNext >= N; });
          if (wNext >= N) break;
          k = wNext++; }
        EmitJob& J = *jobs[k];
        GW g = base;
        g.px = J.entry.px; g.py = J.entry.py; g.curF = J.entry.curF; g.lastFan = J.entry.lastFan;
        g.island = std::move(J.island);
        SeamCtx sc = J.entry.sc;
        LayerData& ldk = L[k];
        emit_layer_any(g, J.tp, J.widths, k, ldk, J.pre, p, ldk.z + zShift, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, sc);
        J.gcode.swap(g.s); J.filament = g.filament; J.segments = g.segments; J.crossings = g.wall_crossings;
        J.jst.store(2, std::memory_order_release);
        ecv.notify_all();
      }
    };
    std::vector<std::thread> wths; wths.reserve(WN);
    for (unsigned t = 0; t < WN; ++t) { try { wths.emplace_back(writerFn); } catch (...) { break; } }
    const int FW = (int)std::max<size_t>(1, wths.size()) * 2 + 2;
    int fl = 0;
    auto flushJob = [&](int k){
      EmitJob& J = *jobs[k];
      if (wths.empty()) {   // 작가 스폰 전멸(풀 고갈) 폴백: 메인이 직접 생성
        GW g = base; g.px=J.entry.px; g.py=J.entry.py; g.curF=J.entry.curF; g.lastFan=J.entry.lastFan;
        g.island = std::move(J.island); SeamCtx sc = J.entry.sc; LayerData& ldk = L[k];
        emit_layer_any(g, J.tp, J.widths, k, ldk, J.pre, p, ldk.z + zShift, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, sc);
        J.gcode.swap(g.s); J.filament = g.filament; J.segments = g.segments; J.crossings = g.wall_crossings;
        J.jst.store(2);
      }
      { std::unique_lock<std::mutex> lk(emu); ecv.wait(lk, [&]{ return J.jst.load(std::memory_order_acquire) == 2; }); }
      double zk = L[k].z + zShift;
      gw.filament += J.filament; gw.segments += J.segments; gw.wall_crossings += J.crossings;
      if (!streaming) {
        em::val Lo = em::val::object(); Lo.set("z", zk); Lo.set("paths", to_f32(J.tp)); Lo.set("widths", to_f32(J.widths));
        layersArr.call<void>("push", Lo);
        gw.s += J.gcode;
        if (overlapBatch) feed_batch_tail();
      } else {
        if (streamTime) feeder.feed(J.gcode);
        em::val paths = economy ? em::val::array() : to_f32(J.tp);
        em::val wid   = economy ? em::val::array() : to_f32(J.widths);
        sink(zk, k, J.gcode, paths, wid);
      }
      J.gcode = std::string(); J.tp = {}; J.widths = {}; J.pre = EmitPre{};
      if (!keepStages) { int old = k - std::max(p.bottom_shell_layers, 1) - 1 - FW;   // 작가·드라이 참조범위 밖만 해제
        if (old >= 0) L[old] = LayerData{}; }
      report(N+2+k+1, total);
    };
    gw.dry = true;
    bool __cxAborted = false;
    std::vector<float> dtp, dwv;   // 드라이 더미(미기록)
    for (int i = 0; i < N; ++i) {
      if (CX()) { __cxAborted = true; break; }   // G002: 신규 디스패치 중단 → 기존 셧다운 경로로 합류
      EmitPre pre;
      { std::unique_lock<std::mutex> lk(pmu);
        cv_done.wait(lk, [&]{ return preDone[i] != 0; });
        pre = std::move(preBuf[i]);
        preConsumed = i; }
      cv_room.notify_all();
      LayerData& ld = L[i];
      EmitJob& J = *jobs[i];
      J.entry = { gw.px, gw.py, gw.curF, gw.lastFan, seamCtx };
      J.island = g_keep_island ? ld.island : std::move(ld.island);   // G003
      emit_layer_any(gw, dtp, dwv, i, ld, pre, p, ld.z + zShift, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, seamCtx);
      J.pre = std::move(pre);
      { std::lock_guard<std::mutex> lk(emu); dispatched = i + 1; J.jst.store(1); }
      ecv.notify_all();
      if (i - FW >= fl) { flushJob(fl); ++fl; }
    }
    gw.dry = false;
    while (!__cxAborted && fl < N) { flushJob(fl); ++fl; }   // G002: 취소 시 미디스패치 잡 대기 금지(데드락 방지)
    { std::lock_guard<std::mutex> lk(emu); wNext = std::max(wNext, N); dispatched = N; }
    ecv.notify_all();
    for (auto& th : wths) th.join();
  } else
#endif
  for (int i=0;i<N;++i) {
    if (CX()) break;   // G002
    if (!keepStages) { int old = i - std::max(p.bottom_shell_layers, 1) - 1;
      if (old >= 0) L[old] = LayerData{}; }
    EmitPre pre;
#ifdef __EMSCRIPTEN_PTHREADS__
    { std::unique_lock<std::mutex> lk(pmu);
      cv_done.wait(lk, [&]{ return preDone[i] != 0; });
      pre = std::move(preBuf[i]);
      preConsumed = i; }
    cv_room.notify_all();
#else
    pre = compute_pre(i);
#endif
    LayerData& ld = L[i];
    double zE = ld.z + zShift;
    std::vector<float> tp;
    std::vector<float> widths;
    if (p.spiral_mode && !ld.contour.empty()) {
      // ===== 스파이럴(vase): 단일 외벽 z-램프 — 병렬 제외, 기존 인라인 유지 =====
      gw.set_e_per_mm(ld.h, p); gw.z = zE; gw.pe_reset();
      gw.island = g_keep_island ? ld.island : std::move(ld.island);   // G003
      seamCtx.rng = 2654435761u * (uint32_t)(i+1);
      g_seg_w = &widths; g_seg_w_cur = (float)w;
      char cm[72];
      std::snprintf(cm,sizeof cm,"; LAYER %d Z%.3f",i,zE); gw.raw(cm);
      gw.set_fan(fan_S(i, p));
      std::snprintf(cm,sizeof cm,"G1 Z%.3f F%d",zE,fTravel); gw.raw(cm);
      int fSp = (int)std::llround(((i==0&&nraft==0)?p.first_layer_speed:p.print_speed)*60);
      emit_spiral(gw, tp, ld.walls.empty()?Paths{}:ld.walls[0], zE, ld.h, fSp, fTravel);
    } else {
      emit_layer_any(gw, tp, widths, i, ld, pre, p, zE, w, N, nraft, fTravel, seamMode, scarfOn, ironOn, seamCtx);
    }
    flush_layer(zE, i, tp, widths);
    report(N+2+i+1, total);
  }
#ifdef __EMSCRIPTEN_PTHREADS__
  { std::lock_guard<std::mutex> lk(pmu); preNext = std::max(preNext, N); }   // 남은 워커 기상 → 종료
  cv_room.notify_all();
  for (auto& th : preThs) th.join();
#endif
  g_seg_w = nullptr;   // 7단계: 폭 추적 종료(로컬 widths 수명 종료)
  if (CX()) {          // G002: 모든 스레드 조인 완료 — 피더만 정리하고 취소 반환
#ifdef __EMSCRIPTEN_PTHREADS__
    if (streamTime || overlapBatch) (void)feeder.finish();
#else
    if (streamTime) (void)gcodeproc_bridge::estimate_end();
#endif
    em::val r = em::val::object(); r.set("error", std::string("canceled")); return r;
  }

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
#ifdef __EMSCRIPTEN_PTHREADS__
      gcodeproc_bridge::Result fr = feeder.finish();   // (mt) 큐 소진 대기(join) 후 종료 — 결과는 동기 피드와 동일
#else
      gcodeproc_bridge::Result fr = gcodeproc_bridge::estimate_end();
#endif
      if (fr.ok) { absorb(fr); engine_used = "full-stream"; } else engine_used = "stream-notime";
    } else engine_used = "economy";
  } else {
    // 배치: 실제 PressureEqualizer(옵트인) → 태그 제거 → 전체 g-code 시간추정(byte-identical 경로 불변).
#ifdef __EMSCRIPTEN_PTHREADS__
    if (overlapBatch) feed_batch_tail();   // 푸터 피드 — fedOff 는 무변형 gw.s 오프셋이라 아래 strip 전에 완료해야 함
#endif
    if (realPE)
      gw.s = pe_bridge::equalize(gw.s, p.filament_diameter, p.max_volumetric_extrusion_rate_slope,
                                 p.extrusion_rate_slope_segment_length, /*relative_e*/true, p.pe_external_perimeter_only);
    if (gw.emit_pe_tags && p.pe_strip_tags) strip_pe_tags(gw.s);
    if (p.time_engine == "transcribed") {
      te = gcode_time::estimate(gw.s, glim); engine_used = "transcribed";
    } else {
#ifdef __EMSCRIPTEN_PTHREADS__
      // (mt) overlapBatch 면 피드 완료분으로 종료(방출과 겹쳐 파싱 끝). realPE 등 비대상은 기존 일괄 추정.
      gcodeproc_bridge::Result fr = overlapBatch ? feeder.finish() : gcodeproc_bridge::estimate(gw.s, gl);
#else
      gcodeproc_bridge::Result fr = gcodeproc_bridge::estimate(gw.s, gl);
#endif
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
    stats.set("t_emit_ms",    tw_end - tw_sup);
    stats.set("t_flush_ms", t_flush);                    // emit 중 JS 경계(to_f32/sink/피드) 몫
    }
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
  // G003: 스테이지 캐시 갱신 — keep 이면 보관(다음 슬라이스 재사용), 아니면 새 지오메트리로 낡은 캐시 무효.
  if (keepStages && !CX()) {
    if (!reuseSup) {
      if (!reuseGeom) g_scache.tris = std::move(trisOwn);
      g_scache.height = height; g_scache.cx = cx; g_scache.cy = cy; g_scache.over_bed = over_bed;
      g_scache.N = N; g_scache.layerKey = lk; g_scache.L = std::move(Lown);
      g_scache.treeSupLayers = treeSupLayers; g_scache.treeZMaxResid = treeZMaxResid;
    }
    g_scache.valid = true;
  } else if (!reuseSup && !reuseGeom) g_scache.valid = false;
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
  em::function("sup_progress_ptr", +[]() -> double {         // 서포트 실진행 카운터(u32)의 힙 주소 — mt SAB 폴링용
    return (double)treesupport_bridge::progress_addr(); });
  em::function("sup_progress_view", +[]() -> em::val {       // 같은 카운터의 Uint32Array 뷰 — .buffer 로 SAB 획득
    return em::val(em::typed_memory_view((size_t)1, (const unsigned int*)(uintptr_t)treesupport_bridge::progress_addr())); });
  em::function("cancel_flag_view", +[]() -> em::val {        // G002: 취소 플래그(u32) 뷰 — UI 가 SAB 로 직접 기입
    return em::val(em::typed_memory_view((size_t)1, (const unsigned int*)(uintptr_t)treesupport_bridge::cancel_addr())); });
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
