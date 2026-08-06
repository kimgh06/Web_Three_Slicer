// Stage-17 bridge: plain-type interface to the REAL organic TreeSupport pipeline (stage-16 port).
// slicer_core.cpp includes ONLY this header (no Slic3r/facade types), so the kernel's world and the
// treesupport_port world meet in exactly one translation unit (treesupport_bridge.cpp), keeping their
// (ABI-identical but separately compiled) Slic3r symbols from leaking type definitions into the kernel.
#pragma once
#include <vector>
#include <utility>
#include <string>

namespace treesupport_bridge {

// One closed ring in mm (kernel-centered coords). Winding is preserved; holes are inferred by union.
using Ring = std::vector<std::pair<double,double>>;

// One support extrusion polyline (mm) with its extrusion width (mm).
// WP3: 원본 ExtrusionPath 의 role/height/mm3_per_mm 를 보존한다 — 이전엔 XY+width 만 남기고 버려
//  base/interface 구분과 원본 E 계산 근거가 소실됐다. role 은 ExtrusionRole 정수값 그대로
//  (erSupportMaterial=14, erSupportMaterialInterface=15, erIroning=8 등).
struct Line {
    std::vector<std::pair<double,double>> pts;
    double width       = 0.0;
    int    role        = 14;   // erSupportMaterial
    double height      = 0.0;  // 레이어 높이(mm, ExtrusionPath::height)
    double mm3_per_mm  = 0.0;  // 원본 부피 유량 — 커널 E 재계산 대신 이 값 사용 가능
};

// Support toolpaths at one support layer (its print_z in mm + the polylines).
struct LayerOut { double print_z_mm; std::vector<Line> lines; };

struct Params {
    double layer_height_mm      = 0.2;
    double first_layer_height_mm = 0.0;    // WP1: 첫 레이어 높이(mm). 0 => layer_height. 원본 initial_layer_print_height 대응
    double nozzle_mm            = 0.4;
    double line_width_mm        = 0.0;     // WP1: 오브젝트 line_width. TreeSupport3D 의 lslices_extrudable 필터 + auto-threshold flow 폴백에 쓰인다
    double support_threshold_angle = 30.0; // deg (0 => auto)
    double support_top_z_distance  = 0.2;  // mm  (WP1: → SlicingParameters::gap_support_object, 원본 수식)
    double support_bottom_z_distance = 0.2;// mm  (WP1: → gap_object_support)
    double support_xy_distance     = 0.35; // mm  (WP1: → support_object_xy_distance config)
    double first_layer_gap_mm      = 0.2;  // WP1: support_object_first_layer_gap (원본 default 0.2)
    int    interface_top_layers    = 2;
    int    interface_bottom_layers = 0;    // WP1: -1 => top 과 동일(원본 규약), 기본 0
    bool   independent_support_layer_height = false; // WP1: 커널 z 그리드 제약상 기본 false(갭을 레이어 배수로 양자화 — 원본 동일 수식)
    bool   support_auto            = true; // true=auto overhang detect (stTreeAuto); false=manual (only painted enforcers)
    double support_line_width_mm   = 0.0;  // 0 => auto (line_width); >0 => explicit support extrusion width
    double support_angle_deg       = 0.0;  // WP1: 서포트 인필 기준 각(SupportParameters::base_angle)
    bool   on_build_plate_only     = false;// WP1: support_on_build_plate_only
    // WP1: 트리 형상 키 (원본 config 기본값과 동일한 기본값 — 미설정 시 기존/원본 기본 동작 유지)
    std::string tree_style         = "organic"; // organic|slim|strong|hybrid → smsTree*
    double branch_angle_deg        = 40.0; // tree_support_branch_angle_organic
    double angle_slow_deg          = 25.0; // tree_support_angle_slow
    double branch_diameter_mm      = 2.0;  // tree_support_branch_diameter_organic
    double branch_distance_mm      = 1.0;  // tree_support_branch_distance_organic
    double branch_diameter_angle_deg = 5.0;// tree_support_branch_diameter_angle
    double tip_diameter_mm         = 0.8;  // tree_support_tip_diameter
    double top_rate_pct            = 30.0; // tree_support_top_rate (%)
    int    wall_count              = 0;    // tree_support_wall_count (organic 은 내부에서 max(1,·))
    std::string interface_pattern  = "auto";    // auto|rectilinear|concentric|rectilinear_interlaced|grid
    std::string base_pattern       = "default"; // default|rectilinear|rectilinear-grid|honeycomb|lightning|none
    double interface_spacing_mm    = 0.5;  // support_interface_spacing
    double base_pattern_spacing_mm = 2.5;  // support_base_pattern_spacing
    double bed_width_mm            = 200.0;
    double bed_depth_mm            = 200.0;
    double printable_height_mm     = 250.0; // WP1: → PrintConfig::printable_height (BuildVolume 높이)
    // WP2: normal(grid/snug) 서포트 포트 전용 키 — 원본 config 기본값과 동일한 기본값
    std::string normal_style       = "grid";  // grid|snug → smsGrid|smsSnug
    double support_expansion_mm    = 0.0;     // support_expansion (detect_overhangs xy_expansion)
    bool   bridge_no_support       = false;   // bridge_no_support (perimeters 미공급 시 사실상 no-op — 문서화)
    bool   remove_small_overhang   = true;    // support_remove_small_overhang
    double threshold_overlap_pct   = 50.0;    // support_threshold_overlap (%, θ=0 일 때 겹침 기준)
    // 33단계: print_config "resolution"(경로 단순화 허용오차, mm). 원본 TreeSupportCommon.hpp:56 이
    //  TreeSupportSettings::resolution 을 여기서 받아 TreeSupport3D 의 polygons_simplify 에 쓴다.
    //  브릿지가 이 값을 안 넘기면 PrintConfig 기본값(0.01)이 적용된다 — 곡면 가지에서 현 길이 ≈0.4mm.
    //  값을 키우면 세그먼트가 줄어 G-code 가 작아진다(디테일과의 트레이드오프).
    double resolution_mm           = 0.01;
};

// object_slices_mm[layer] = the object's slice rings at that layer (mm). layer_print_z_mm[layer] = its print_z.
// Runs TreeSupport::generate() (smsTreeOrganic / stTreeAuto) on a facade PrintObject built from these slices
// and returns the generated support extrusion toolpaths per support layer. Empty vector => no support.
//
// The treesupport group is compiled fully self-contained with -fvisibility=hidden and then run through
// llvm-objcopy --localize-hidden, so every internal Slic3r symbol becomes local and cannot collide with
// (or borrow the trimmed behavior of) the main build's stubbed copies. This ONE entry point must stay
// exported (default visibility) so slicer_core.cpp can call across the boundary.
__attribute__((visibility("default")))
std::vector<LayerOut> generate(const std::vector<std::vector<Ring>>& object_slices_mm,
                               const std::vector<double>&            layer_print_z_mm,
                               const Params&                         params);

// WP2: 레이어별 표면 데이터(mm) — normal 서포트 포트의 stTop/stBottom 표면 공급용.
//  top = 위가 노출된 면(원본 stTop 대응, 커널 topSurf), bottom = 아래가 노출된 면(stBottom, 커널 botSurf).
struct LayerSurf { std::vector<Ring> top, bottom; };

// WP2: 원본 normal(grid/snug) 서포트 — PrintObjectSupportMaterial::generate() (SupportMaterial.cpp 원본
//  포트, 11단계 파이프라인: top/bottom contact → 중간층 → SupportGridPattern(AGG) → 인터페이스 → 툴패스).
//  surfs 는 슬라이스와 같은 길이(비면 stTop/stBottom 없이 동작 — bottom contact 미생성).
//  출력은 generate() 와 동일한 LayerOut(role/height/mm3 보존 툴패스).
__attribute__((visibility("default")))
std::vector<LayerOut> generate_normal(const std::vector<std::vector<Ring>>& object_slices_mm,
                                      const std::vector<double>&            layer_print_z_mm,
                                      const std::vector<LayerSurf>&         surfs,
                                      const Params&                         params);

// 서포트 실진행 카운터(tbb 스텁 atomic)의 wasm 힙 주소 — mt 에서 UI 스레드가 SAB 로 직접 폴링.
//  generate_normal 진입 시 0 리셋, parallel_for 인덱스/task_group run 완료마다 증가(≈레이어 처리 단위).
__attribute__((visibility("default")))
unsigned long progress_addr();

// 취소 플래그(u32) 주소 — slice() 진입 시 0 리셋, UI 가 SAB 로 1 기입 시 커널·포트가 조기 중단.
__attribute__((visibility("default")))
unsigned long cancel_addr();

} // namespace treesupport_bridge
