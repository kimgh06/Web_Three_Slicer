// Stage-13 bridge: plain-type interface to the REAL ported GCodeProcessor (7561L). slicer_core.cpp
// includes ONLY this header (no Slic3r/GCodeProcessor/PrintConfig types). Mirrors gcode_time's shape
// so the kernel can swap engines by a `time_engine` param (full=this, transcribed=gcode_time).
#pragma once
#include <string>
#include <vector>
#include <map>

namespace gcodeproc_bridge {

// Machine limits (same fields/units as gcode_time::Limits) injected into the PrintConfig the real
// GCodeProcessor consumes, so both engines see identical limits (isolates algorithm differences).
struct Limits {
    float max_speed[4] = {500.f, 500.f, 12.f, 30.f};
    float max_accel[4] = {5000.f, 5000.f, 500.f, 5000.f};
    float max_jerk[4]  = {9.f, 9.f, 0.4f, 2.5f};
    float accel_print   = 5000.f;
    float accel_travel  = 5000.f;
    float accel_retract = 5000.f;
    float min_extrude_rate = 0.f;
    float min_travel_rate  = 0.f;
};

struct Result {
    double total_s = 0.0;
    std::vector<double> layer_s;
    double first_layer_s = 0.0;
    double extrude_s = 0.0, travel_s = 0.0;
    std::map<int, double> role_s;       // ExtrusionRole int -> s
    double filament_mm = 0.0;
    long   moves = 0;
    bool   ok = false;
};

// Run the real GCodeProcessor (apply_config -> process_buffer -> finalize) on the g-code and extract
// the time breakdown from GCodeProcessorResult (modes[Normal].time) + per-move aggregation.
Result estimate(const std::string& gcode, const Limits& lim);

// 30단계 스트리밍 시간추정: 커널이 레이어 청크를 만드는 대로 먹여(process_buffer 는 상태를 유지하는
//  스트리밍 파서 — 청크가 '\n' 경계라 여러 번 호출해도 한 번에 먹인 것과 동일) 전체 g-code 문자열을
//  한꺼번에 상주시키지 않는다. begin(apply_config 1회) → feed(청크마다 process_buffer + 필라멘트 누적)
//  → end(finalize + Result 추출). 한 번에 하나의 스트림만(파일 static 상태).
void   estimate_begin(const Limits& lim);
void   estimate_feed(const std::string& chunk);
Result estimate_end();

} // namespace gcodeproc_bridge
