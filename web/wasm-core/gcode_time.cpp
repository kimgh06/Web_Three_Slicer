// Stage-10: faithful transcription of the OrcaSlicer GCodeProcessor time algorithm (see gcode_time.h
// for exact source-line citations). Constants, planner passes, trapezoid math and process_G1 block
// generation are copied verbatim; only apply_config/config-typed access is replaced by param-injected
// Limits (single Normal time mode). The parser feeds it G0/G1/G2/G3 moves from the emitted g-code.
#include "gcode_time.h"
#include <cmath>
#include <cstdlib>
#include <algorithm>

namespace gcode_time {

enum { AX=0, AY=1, AZ=2, AE=3 };
static inline float sqrf(float x){ return x*x; }

// ---- helpers: GCodeProcessor.cpp L146-175 (verbatim) ----
static float estimated_acceleration_distance(float initial_rate, float target_rate, float acceleration){
    return (acceleration == 0.0f) ? 0.0f : (sqrf(target_rate) - sqrf(initial_rate)) / (2.0f * acceleration);
}
static float intersection_distance(float initial_rate, float final_rate, float acceleration, float distance){
    return (acceleration == 0.0f) ? 0.0f : (2.0f * acceleration * distance - sqrf(initial_rate) + sqrf(final_rate)) / (4.0f * acceleration);
}
static float speed_from_distance(float initial_feedrate, float distance, float acceleration){
    const float value = std::max(0.0f, sqrf(initial_feedrate) + 2.0f * acceleration * distance);
    return std::sqrt(value);
}
static float max_allowable_speed(float acceleration, float target_velocity, float distance){
    const float value = std::max(0.0f, sqrf(target_velocity) - 2.0f * acceleration * distance);
    return std::sqrt(value);
}
static float acceleration_time_from_distance(float initial_feedrate, float distance, float acceleration){
    return (acceleration != 0.0f) ? (speed_from_distance(initial_feedrate, distance, acceleration) - initial_feedrate) / acceleration : 0.0f;
}

// ---- Trapezoid + TimeBlock: GCodeProcessor.hpp L565-620, .cpp L261-290 (verbatim) ----
struct FeedrateProfile { float entry=0, cruise=0, exit=0; };
struct Trapezoid {
    float accelerate_until=0, decelerate_after=0, cruise_feedrate=0;
    float acceleration_distance() const { return accelerate_until; }
    float cruise_distance() const { return decelerate_after - accelerate_until; }
    float deceleration_distance(float distance) const { return distance - decelerate_after; }
    float acceleration_time(float entry_feedrate, float acceleration) const {
        return acceleration_time_from_distance(entry_feedrate, acceleration_distance(), acceleration);
    }
    float cruise_time() const { return (cruise_feedrate != 0.0f) ? cruise_distance() / cruise_feedrate : 0.0f; }
    float deceleration_time(float distance, float acceleration) const {
        return acceleration_time_from_distance(cruise_feedrate, deceleration_distance(distance), -acceleration);
    }
};
struct TimeBlock {
    struct Flags { bool recalculate=false, nominal_length=false; };
    int   move_type=0;      // 0=noop 1=extrude 2=travel 3=retract 4=unretract
    int   role=0;           // ExtrusionRole int (from ;_EXTRUSION_ROLE tag) else -1
    int   layer_id=0;
    float distance=0, acceleration=0, max_entry_speed=0, safe_feedrate=0;
    Flags flags; FeedrateProfile feedrate_profile; Trapezoid trapezoid;
    void calculate_trapezoid(){
        float accelerate_distance = std::max(0.0f, estimated_acceleration_distance(feedrate_profile.entry, feedrate_profile.cruise, acceleration));
        const float decelerate_distance = std::max(0.0f, estimated_acceleration_distance(feedrate_profile.cruise, feedrate_profile.exit, -acceleration));
        float cruise_distance = distance - accelerate_distance - decelerate_distance;
        if (cruise_distance < 0.0f) {
            accelerate_distance = std::clamp(intersection_distance(feedrate_profile.entry, feedrate_profile.exit, acceleration, distance), 0.0f, distance);
            cruise_distance = 0.0f;
            trapezoid.cruise_feedrate = speed_from_distance(feedrate_profile.entry, accelerate_distance, acceleration);
        } else
            trapezoid.cruise_feedrate = feedrate_profile.cruise;
        trapezoid.accelerate_until = accelerate_distance;
        trapezoid.decelerate_after = accelerate_distance + cruise_distance;
    }
    float time() const {
        return trapezoid.acceleration_time(feedrate_profile.entry, acceleration) +
               trapezoid.cruise_time() + trapezoid.deceleration_time(distance, acceleration);
    }
};

// ---- planner passes: GCodeProcessor.cpp L332-413 (verbatim) ----
static void planner_forward_pass_kernel(const TimeBlock& prev, TimeBlock& curr){
    if (!prev.flags.nominal_length && prev.feedrate_profile.entry < curr.feedrate_profile.entry) {
        const float new_entry_speed = max_allowable_speed(-prev.acceleration, prev.feedrate_profile.entry, prev.distance);
        if (new_entry_speed < curr.feedrate_profile.entry) {
            curr.feedrate_profile.entry = new_entry_speed;
            curr.flags.recalculate = true;
        }
    }
}
static void planner_reverse_pass_kernel(TimeBlock& curr, const TimeBlock& next){
    const float max_entry_speed = curr.max_entry_speed;
    if (curr.feedrate_profile.entry != max_entry_speed || next.flags.recalculate) {
        const float new_entry_speed = curr.flags.nominal_length ? max_entry_speed :
            std::min(max_entry_speed, max_allowable_speed(-curr.acceleration, next.feedrate_profile.entry, curr.distance));
        if (curr.feedrate_profile.entry != new_entry_speed) {
            curr.feedrate_profile.entry = new_entry_speed;
            curr.flags.recalculate = true;
        }
    }
}
static void recalculate_trapezoids(std::vector<TimeBlock>& blocks){
    TimeBlock* curr = nullptr; TimeBlock* next = nullptr;
    for (size_t i = 0; i < blocks.size(); ++i) {
        TimeBlock& b = blocks[i];
        curr = next; next = &b;
        if (curr != nullptr) {
            if (curr->flags.recalculate || next->flags.recalculate) {
                curr->feedrate_profile.exit = next->feedrate_profile.entry;
                curr->calculate_trapezoid();
                curr->flags.recalculate = false;
            }
        }
    }
    if (next != nullptr) {
        next->feedrate_profile.exit = next->safe_feedrate;
        next->calculate_trapezoid();
        next->flags.recalculate = false;
    }
}

// ---- single-machine state (GCodeProcessor.hpp TimeMachine::State) ----
struct State {
    float feedrate=0, safe_feedrate=0;
    float axis_feedrate[4]={0,0,0,0}, abs_axis_feedrate[4]={0,0,0,0};
    float enter_direction[3]={0,0,0}, exit_direction[3]={0,0,0};
};

// ---- process_G1 block generation: GCodeProcessor.cpp L5007-5231 (verbatim, single Normal mode) ----
// Appends a TimeBlock for one move. delta_pos[X,Y,Z,E], m_feedrate in mm/s.
static void add_move(std::vector<TimeBlock>& blocks, State& curr, State& prev,
                     const float delta_pos[4], float m_feedrate, const Limits& lim,
                     int move_type, int role, int layer_id)
{
    auto is_extrusion_only_move = [](const float d[4]){ return d[AX]==0.f && d[AY]==0.f && d[AZ]==0.f && d[AE]!=0.f; };
    float sq_xyz = sqrf(delta_pos[AX])+sqrf(delta_pos[AY])+sqrf(delta_pos[AZ]);
    float distance = (sq_xyz > 0.0f) ? std::sqrt(sq_xyz) : std::abs(delta_pos[AE]);
    if (distance == 0.0f) return;
    float inv_distance = 1.0f / distance;

    // curr.feedrate = minimum_(travel_)feedrate(m_feedrate)
    curr.feedrate = (delta_pos[AE] == 0.0f)
        ? ((lim.min_travel_rate > 0.f) ? std::max(m_feedrate, lim.min_travel_rate) : m_feedrate)
        : ((lim.min_extrude_rate > 0.f) ? std::max(m_feedrate, lim.min_extrude_rate) : m_feedrate);

    curr.enter_direction[0]=delta_pos[AX]; curr.enter_direction[1]=delta_pos[AY]; curr.enter_direction[2]=delta_pos[AZ];
    float norm = std::sqrt(sqrf(curr.enter_direction[0])+sqrf(curr.enter_direction[1])+sqrf(curr.enter_direction[2]));
    if (!is_extrusion_only_move(delta_pos) && norm > 0.f) {
        curr.enter_direction[0]/=norm; curr.enter_direction[1]/=norm; curr.enter_direction[2]/=norm;
    }
    curr.exit_direction[0]=curr.enter_direction[0]; curr.exit_direction[1]=curr.enter_direction[1]; curr.exit_direction[2]=curr.enter_direction[2];

    TimeBlock block; block.move_type=move_type; block.role=role; block.distance=distance; block.layer_id=layer_id;

    // centripetal accel limit on cruise (L5055-5079)
    if ((prev.exit_direction[0]!=0.f || prev.exit_direction[1]!=0.f) &&
        (curr.enter_direction[0]!=0.f || curr.enter_direction[1]!=0.f)) {
        float v1[2]={prev.exit_direction[0],prev.exit_direction[1]}; float n1=std::sqrt(sqrf(v1[0])+sqrf(v1[1])); if(n1>0){v1[0]/=n1;v1[1]/=n1;}
        float v2[2]={curr.enter_direction[0],curr.enter_direction[1]}; float n2=std::sqrt(sqrf(v2[0])+sqrf(v2[1])); if(n2>0){v2[0]/=n2;v2[1]/=n2;}
        float norm_diff = std::sqrt(sqrf(v2[0]-v1[0])+sqrf(v2[1]-v1[1]));
        if (norm_diff < 0.5f && norm_diff > 0.00001f) {
            float dot=v1[0]*v2[0]+v1[1]*v2[1], cross=v1[0]*v2[1]-v1[1]*v2[0];
            float angle=(float)atan2((double)cross,(double)dot);
            float sin_theta_2=std::sqrt((1.0f-std::cos(angle))*0.5f);
            if (sin_theta_2 > 0.f) {
                float r=std::sqrt(sqrf(delta_pos[AX])+sqrf(delta_pos[AY]))*0.5f/sin_theta_2;
                curr.feedrate = std::min(curr.feedrate, std::sqrt(lim.accel_print * r));
            }
        }
    }

    // cruise feedrate: clamp to per-axis max feedrate (L5081-5103)
    float min_feedrate_factor = 1.0f;
    for (int a=AX; a<=AE; ++a) {
        curr.axis_feedrate[a] = curr.feedrate * delta_pos[a] * inv_distance;
        curr.abs_axis_feedrate[a] = std::abs(curr.axis_feedrate[a]);
        if (curr.abs_axis_feedrate[a] != 0.0f) {
            float axis_max = lim.max_speed[a];
            if (axis_max != 0.0f) min_feedrate_factor = std::min(min_feedrate_factor, axis_max / curr.abs_axis_feedrate[a]);
        }
    }
    curr.feedrate *= min_feedrate_factor;
    block.feedrate_profile.cruise = curr.feedrate;
    if (min_feedrate_factor < 1.0f)
        for (int a=AX; a<=AE; ++a) { curr.axis_feedrate[a]*=min_feedrate_factor; curr.abs_axis_feedrate[a]*=min_feedrate_factor; }

    // acceleration (L5105-5119)
    float acceleration = (move_type==2/*travel*/) ? lim.accel_travel
        : (is_extrusion_only_move(delta_pos) ? lim.accel_retract : lim.accel_print);
    for (int a=AX; a<=AE; ++a) {
        float axis_max_acc = lim.max_accel[a];
        if (axis_max_acc>0.f && acceleration * std::abs(delta_pos[a]) * inv_distance > axis_max_acc)
            acceleration = axis_max_acc / (std::abs(delta_pos[a]) * inv_distance);
    }
    block.acceleration = acceleration;

    // safe (exit) feedrate from per-axis jerk (L5121-5130)
    curr.safe_feedrate = block.feedrate_profile.cruise;
    for (int a=AX; a<=AE; ++a) {
        float axis_max_jerk = lim.max_jerk[a];
        if (curr.abs_axis_feedrate[a] > axis_max_jerk) curr.safe_feedrate = std::min(curr.safe_feedrate, axis_max_jerk);
    }
    block.feedrate_profile.exit = curr.safe_feedrate;

    static const float PREV_THRESH = 0.0001f;
    // entry feedrate via jerk junction (L5134-5214)
    float vmax_junction = curr.safe_feedrate;
    if (!blocks.empty() && prev.feedrate > PREV_THRESH) {
        bool prev_speed_larger = prev.feedrate > block.feedrate_profile.cruise;
        float smaller_speed_factor = prev_speed_larger ? (block.feedrate_profile.cruise / prev.feedrate) : (prev.feedrate / block.feedrate_profile.cruise);
        vmax_junction = prev_speed_larger ? block.feedrate_profile.cruise : prev.feedrate;
        float v_factor = 1.0f; bool limited = false;
        for (int a=AX; a<=AE; ++a) {
            if (a == AX) {
                float exit_v[3]={prev.feedrate*prev.exit_direction[0], prev.feedrate*prev.exit_direction[1], prev.feedrate*prev.exit_direction[2]};
                if (prev_speed_larger) { exit_v[0]*=smaller_speed_factor; exit_v[1]*=smaller_speed_factor; exit_v[2]*=smaller_speed_factor; }
                float entry_v[3]={block.feedrate_profile.cruise*curr.enter_direction[0], block.feedrate_profile.cruise*curr.enter_direction[1], block.feedrate_profile.cruise*curr.enter_direction[2]};
                float jerk_v[3]={std::abs(entry_v[0]-exit_v[0]), std::abs(entry_v[1]-exit_v[1]), std::abs(entry_v[2]-exit_v[2])};
                float max_xyz_jerk_v[3]={lim.max_jerk[AX], lim.max_jerk[AY], lim.max_jerk[AZ]};
                for (int k=0;k<3;k++) if (jerk_v[k] > max_xyz_jerk_v[k]) {
                    v_factor *= max_xyz_jerk_v[k] / jerk_v[k];
                    jerk_v[0]*=v_factor; jerk_v[1]*=v_factor; jerk_v[2]*=v_factor;
                    limited = true;
                }
            } else if (a == AY || a == AZ) {
                continue;
            } else {
                float v_exit = prev.axis_feedrate[a], v_entry = curr.axis_feedrate[a];
                if (prev_speed_larger) v_exit *= smaller_speed_factor;
                if (limited) { v_exit *= v_factor; v_entry *= v_factor; }
                float jerk =
                    (v_exit > v_entry) ?
                    (((v_entry > 0.0f) || (v_exit < 0.0f)) ? (v_exit - v_entry) : std::max(v_exit, -v_entry)) :
                    (((v_entry < 0.0f) || (v_exit > 0.0f)) ? (v_entry - v_exit) : std::max(-v_exit, v_entry));
                float axis_max_jerk = lim.max_jerk[a];
                if (jerk > axis_max_jerk) { v_factor *= axis_max_jerk / jerk; limited = true; }
            }
        }
        if (limited) vmax_junction *= v_factor;
        float vmax_junction_threshold = vmax_junction * 0.99f;
        if (prev.safe_feedrate > vmax_junction_threshold && curr.safe_feedrate > vmax_junction_threshold)
            vmax_junction = curr.safe_feedrate;
    }
    float v_allowable = max_allowable_speed(-acceleration, curr.safe_feedrate, block.distance);
    block.feedrate_profile.entry = std::min(vmax_junction, v_allowable);
    block.max_entry_speed = vmax_junction;
    block.flags.nominal_length = (block.feedrate_profile.cruise <= v_allowable);
    block.flags.recalculate = true;
    block.safe_feedrate = curr.safe_feedrate;
    block.calculate_trapezoid();
    prev = curr;
    blocks.push_back(block);
}

// ---- tiny g-code parser + driver ----
static bool parse_axis(const std::string& line, char ax, double& out){
    // find token "<ax><number>" preceded by start/space, ignore inside comment
    for (size_t i=0;i<line.size();++i){
        char c=line[i];
        if (c==';') break;
        if ((c==ax || c==(char)std::tolower(ax)) && (i==0 || line[i-1]==' ' || line[i-1]=='\t')) {
            char* end=nullptr; out=std::strtod(line.c_str()+i+1, &end);
            if (end != line.c_str()+i+1) return true;
        }
    }
    return false;
}

Result estimate(const std::string& gcode, const Limits& lim){
    Result R;
    std::vector<TimeBlock> blocks;
    State curr, prev;
    double pos[4]={0,0,0,0};          // absolute X,Y,Z,E
    bool have_pos[3]={false,false,false};
    double m_feedrate=0;              // mm/s (from F mm/min)
    bool e_relative=true;            // kernel emits M83
    bool xyz_absolute=true;          // kernel emits G90
    int  layer_id=-1;                 // -1 = preamble; increments on "; LAYER"
    int  cur_role=-1;

    size_t i=0, n=gcode.size();
    while (i<n) {
        size_t e=gcode.find('\n', i); if (e==std::string::npos) e=n;
        std::string line = gcode.substr(i, e-i); i=e+1;
        if (line.empty()) continue;
        // markers
        if (line.compare(0,8,"; LAYER ")==0 || line.compare(0,8,"; LAYER\t")==0) { ++layer_id; R.layer_s.push_back(0.0); continue; }
        if (line.compare(0,17,";_EXTRUSION_ROLE:")==0) { cur_role = std::atoi(line.c_str()+17); continue; }
        // mode changes
        if (line.compare(0,3,"M83")==0) { e_relative=true; continue; }
        if (line.compare(0,3,"M82")==0) { e_relative=false; continue; }
        if (line.compare(0,3,"G91")==0) { xyz_absolute=false; continue; }
        if (line.compare(0,3,"G90")==0) { xyz_absolute=true; continue; }
        // motion: G0 / G1 / G2 / G3
        bool g0 = line.compare(0,2,"G0")==0 && (line.size()<3 || !std::isalnum((unsigned char)line[2]));
        bool g1 = line.compare(0,2,"G1")==0 && (line.size()<3 || !std::isalnum((unsigned char)line[2]));
        bool g2 = line.compare(0,2,"G2")==0 && (line.size()<3 || !std::isalnum((unsigned char)line[2]));
        bool g3 = line.compare(0,2,"G3")==0 && (line.size()<3 || !std::isalnum((unsigned char)line[2]));
        if (!(g0||g1||g2||g3)) continue;

        double vx,vy,vz,ve,vf,vi,vj;
        bool hx=parse_axis(line,'X',vx), hy=parse_axis(line,'Y',vy), hz=parse_axis(line,'Z',vz);
        bool he=parse_axis(line,'E',ve), hf=parse_axis(line,'F',vf);
        if (hf) m_feedrate = vf/60.0;   // mm/min -> mm/s

        // new absolute position
        double nx = hx ? (xyz_absolute ? vx : pos[AX]+vx) : pos[AX];
        double ny = hy ? (xyz_absolute ? vy : pos[AY]+vy) : pos[AY];
        double nz = hz ? (xyz_absolute ? vz : pos[AZ]+vz) : pos[AZ];
        double de = he ? (e_relative ? ve : ve-pos[AE]) : 0.0;

        float delta[4];
        if (g2||g3) {
            // arc: distance = radius * swept angle (center from I/J relative to start)
            bool hi=parse_axis(line,'I',vi), hj=parse_axis(line,'J',vj);
            double cx=pos[AX]+(hi?vi:0.0), cy=pos[AY]+(hj?vj:0.0);
            double r=std::hypot(pos[AX]-cx, pos[AY]-cy);
            double a0=std::atan2(pos[AY]-cy, pos[AX]-cx), a1=std::atan2(ny-cy, nx-cx);
            double sweep = a1-a0;
            if (g2) { if (sweep>0) sweep-=2*M_PI; } else { if (sweep<0) sweep+=2*M_PI; }
            double arc_len = std::abs(sweep)*r;
            // treat arc as a single planar move of arc length in X (direction chord); good enough for estimate
            delta[AX]=(float)arc_len; delta[AY]=0.f; delta[AZ]=0.f; delta[AE]=(float)de;
        } else {
            delta[AX]=(float)(nx-pos[AX]); delta[AY]=(float)(ny-pos[AY]); delta[AZ]=(float)(nz-pos[AZ]); delta[AE]=(float)de;
        }

        // move type (GCodeProcessor.cpp move_type lambda L4876-4891)
        int mt;
        if (delta[AE] < 0.f) mt = (delta[AX]!=0.f||delta[AY]!=0.f||delta[AZ]!=0.f) ? 2 : 3;      // travel / retract
        else if (delta[AE] > 0.f) {
            if (delta[AX]==0.f && delta[AY]==0.f) mt = (delta[AZ]==0.f) ? 4 : 2;                 // unretract / travel
            else mt = 1;                                                                          // extrude
        } else mt = (delta[AX]!=0.f||delta[AY]!=0.f||delta[AZ]!=0.f) ? 2 : 0;                     // travel / noop

        // filament = E of real extrusion moves only (exclude unretract re-prime), to match kernel gw.filament
        if (mt == 1 && delta[AE] > 0.f) R.filament_mm += delta[AE];

        if (mt != 0) {
            int role = (mt==1) ? cur_role : -1;
            add_move(blocks, curr, prev, delta, (float)m_feedrate, lim, mt, role, std::max(0,layer_id));
            ++R.moves;
        }
        pos[AX]=nx; pos[AY]=ny; pos[AZ]=nz;
        pos[AE] = e_relative ? pos[AE] : (he ? ve : pos[AE]);
    }

    // planner over all blocks (full look-ahead; firmware uses a 64-block window — documented simplification)
    for (int k=(int)blocks.size()-1; k>0; --k) planner_reverse_pass_kernel(blocks[k-1], blocks[k]);
    for (size_t k=0; k+1<blocks.size(); ++k) planner_forward_pass_kernel(blocks[k], blocks[k+1]);
    recalculate_trapezoids(blocks);

    for (const TimeBlock& b : blocks) {
        double t = b.time();
        if (!(t==t) || t<0) t=0;   // guard NaN
        R.total_s += t;
        if (b.layer_id >=0 && b.layer_id < (int)R.layer_s.size()) R.layer_s[b.layer_id] += t;
        if (b.move_type==1) R.extrude_s += t; else if (b.move_type==2) R.travel_s += t;
        if (b.role >= 0) R.role_s[b.role] += t;
    }
    if (!R.layer_s.empty()) R.first_layer_s = R.layer_s.front();
    return R;
}

} // namespace gcode_time
