#!/usr/bin/env bash
# 브라우저 단독 슬라이싱 미니 커널 빌드 (트랙 C)
# 산출물: ../engine/src/slicer_core.js  (SINGLE_FILE=1 → wasm 을 base64 인라인,
#         외부 .wasm fetch 없음 → 정적 서버/vite preview 어디서든 자립 동작)
#
# 7단계: 실제 OrcaSlicer Arachne(WallToolPaths) 이식본을 함께 링크한다.
#  - 커널 자체 clipper(전역 ClipperLib)와 Arachne 이식본 clipper(Slic3r::ClipperLib / ClipperLib_Z)는
#    서로 다른 네임스페이스라 공존. arachne_bridge.cpp 만이 두 세계를 잇는다.
#  - 필요: brew boost(header-only voronoi) + brew eigen. 스텁: tbb/boost-log/cereal/SVG/Flow/Config 등.
set -euo pipefail

export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"
# ccache 래핑: 미변경 TU 재사용 → 단일 파일 수정 재빌드가 분 단위 → 수십 초. (brew install ccache)
command -v ccache >/dev/null && export EM_COMPILER_WRAPPER=ccache

cd "$(dirname "$0")"
# 34단계: deps 사본을 third_party/ 로 복사 → slicer/ 의존 제거(REPO 삭제)
AP=arachne_port/libslic3r

# --- Arachne 이식본 소스 (원본 그대로 + 문서화된 최소 수정) ---
ARACHNE_SRC="
  arachne_bridge.cpp
  $AP/Arachne/WallToolPaths.cpp
  $AP/Arachne/SkeletalTrapezoidation.cpp
  $AP/Arachne/SkeletalTrapezoidationGraph.cpp
  $AP/Arachne/utils/ExtrusionLine.cpp
  $AP/Arachne/utils/PolylineStitcher.cpp
  $AP/Arachne/utils/SquareGrid.cpp
  $AP/Arachne/BeadingStrategy/BeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/BeadingStrategyFactory.cpp
  $AP/Arachne/BeadingStrategy/DistributedBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/LimitedBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/OuterWallInsetBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/RedistributeBeadingStrategy.cpp
  $AP/Arachne/BeadingStrategy/WideningBeadingStrategy.cpp
  $AP/Point.cpp $AP/Line.cpp $AP/Polygon.cpp $AP/Polyline.cpp $AP/MultiPoint.cpp
  $AP/BoundingBox.cpp $AP/ExPolygon.cpp $AP/ClipperUtils.cpp $AP/EdgeGrid.cpp
  $AP/Surface.cpp $AP/ArcFitter.cpp $AP/libslic3r.cpp $AP/Geometry.cpp
  $AP/Geometry/VoronoiUtils.cpp $AP/Geometry/Voronoi.cpp
  $AP/Geometry/VoronoiUtilsCgal.cpp

  $AP/clipper.cpp
  third_party/deps_src/clipper/clipper_z.cpp
"
# --- 8단계: 이식된 실제 OrcaSlicer Fill 패턴 (gyroid TPMS/honeycomb/3dhoneycomb/crosshatch/concentric) ---
C2=third_party/deps_src/clipper2/Clipper2Lib
FILL_SRC="
  fill_bridge.cpp
  $AP/Fill/FillBase.cpp $AP/Fill/FillGyroid.cpp $AP/Fill/FillHoneycomb.cpp
  $AP/Fill/Fill3DHoneycomb.cpp $AP/Fill/FillCrossHatch.cpp $AP/Fill/FillConcentric.cpp
  $AP/Fill/FillRectilinear.cpp
  $AP/ShortestPath.cpp $AP/ExtrusionEntityCollection.cpp $AP/Circle.cpp $AP/Clipper2Utils.cpp
  $C2/src/clipper.engine.cpp $C2/src/clipper.offset.cpp $C2/src/clipper.rectclip.cpp
"
# --- 8단계: 이식된 실제 PressureEqualizer ---
PE_SRC="pe_bridge.cpp $AP/GCode/PressureEqualizer.cpp $AP/GCodeFormatter_impl.cpp"
# --- 10단계: 이식된 GCodeProcessor 시간추정 알고리즘 ---
TIME_SRC="gcode_time.cpp"
# --- 12단계: 실 config 서브시스템(Config.cpp + PrintConfig.cpp)을 본선 빌드에 병합 ---
#  config_bridge.cpp 만이 커널↔실 PrintConfig 경계(arachne_bridge 와 동일 격리). config 소스는 자기
#  디렉터리의 실 헤더를 "" 상대 include 로 얻고, Arachne/Fill/PE 는 stub PrintConfig.hpp 를 그대로 사용
#  (enum 은 verbatim 동일 → ODR 안전). 어떤 main TU 도 boost/thread 를 include 하지 않으므로 config/stubs
#  의 boost/thread 빈 스텁은 PrintConfig.cpp 에만 영향.
CP=arachne_port/config/libslic3r
CONFIG_SRC="config_bridge.cpp $CP/Config.cpp $CP/PrintConfig.cpp $CP/MaterialType.cpp"
CONFIG_INC="-Iarachne_port/config/stubs"
# --- 12단계 item 2: 실 WipeTower 를 본선에 링크(wipe_tower_real). WipeTower.cpp 는 자기 디렉터리의
#  GCodeProcessor 스텁(→실 PrintConfig)·wipetower/inc 의 TriangleMesh/Triangulation 스텁을 사용.
#  role_to_string/localesutils_wasm 는 단일함수/유니티 래퍼(전체 TU 의 Flow/PCH 의존 회피). Arachne/Fill/PE
#  는 여전히 stub PrintConfig — wipetower/inc 는 libslic3r/TriangleMesh(prefix)·Triangulation 만 섀도우하며
#  본선 어떤 컴파일 TU 도 이를 include 하지 않음(실측). Circle/ArcFitter/geometry 는 이미 링크됨.
WT=arachne_port/wipetower
WIPETOWER_SRC="$WT/GCode/WipeTower.cpp $WT/role_to_string.cpp $WT/localesutils_wasm.cpp"
CONFIG_INC="$CONFIG_INC -Iarachne_port/wipetower/inc"
# --- 13단계: 실 이식 GCodeProcessor 본체(time_engine=full). gcodeproc_bridge.cpp 가 커널↔GCodeProcessor
#  경계. GCodeProcessor.cpp 는 gcodeproc/inc 의 Print 스텁(2심볼)·gcodeproc/stubs 의 boost::nowide/filesystem
#  스텁 사용, PrintConfig 는 forwarder→real. GCodeReader/MultiNozzleUtils/ArcWelder/Elegoo 이식, string_to_role
#  단일함수 추출. ProjectTask 는 FilamentInfo 스텁. 본선 어떤 기존 TU 도 이 스텁들을 include 안 함(실측).
GP=arachne_port/gcodeproc
GCODEPROC_SRC="gcodeproc_bridge.cpp $GP/GCode/GCodeProcessor.cpp $GP/GCode/ElegooGCodeProcessorHelper.cpp $GP/extrusion_role_helper.cpp $AP/GCodeReader.cpp $AP/MultiNozzleUtils.cpp $AP/Geometry/ArcWelder.cpp"
CONFIG_INC="$CONFIG_INC -Iarachne_port/gcodeproc/inc -Iarachne_port/gcodeproc/stubs"
# Arachne/Fill 이식본용 include (커널 소스에는 영향 없음 — 커널은 arachne_bridge.h/fill_bridge.h 만 include)
# 14단계: 실 CGAL 평면성 검사(VoronoiUtilsCgal). cgal_stubs 는 boost wasm.hpp 오버라이드(BOOST_NO_FENV_H
#  제거 → Boost.Multiprecision interval c99 rounding). CGAL 6.x 헤더온리(brew), GMP/MPFR 링크 없음.
# --- 18단계: 실 오가닉 TreeSupport 본선 통합 (treesupport_bridge, 옵션 (a) 승인) ---
#  17단계 ODR 실측 결론: 공유-심볼 방식은 ODR-clean 링크 + 120 그린을 이미 달성했고, 유일한 런타임 벽은 본선
#  FillBase 팩토리의 STAGE-8 트림(new_from_type→ipSupportBase/ipRectilinear nullptr)이었다. 18단계에서 그 트림을
#  가산적으로 원복(위 FillBase.cpp STAGE-18 UNTRIM + FILL_SRC 에 FillRectilinear.cpp 추가; 골든 byte-diff 0 로
#  기본 경로 무영향 실증)하여 트리 경로도 실 필러를 받는다. 트리 고유 소스만 별도 릴로케이터블 오브젝트로 격리
#  컴파일(파일-상대 include 로 포트 헤더 해소)한 뒤 본선 링크에 합류. 공유 소스(Point/Polygon/PrintConfig/Arachne/
#  Fill*/Geometry/Voronoi/clipper…)는 재컴파일 안 함(헤더 ABI 동일 실측; FillRectilinear/SupportBase 는 이제 본선
#  제공). 충돌 2심볼(ExtrusionEntity::role_to_string/string_to_role)은 -DTS_BRIDGE_EXCLUDE_ROLE_FNS 로 가드(본선이
#  role_to_string.cpp+extrusion_role_helper.cpp 로 제공). 커널↔브릿지는 plain 타입만. -DNDEBUG 는 트리 그룹만.
TS=treesupport_port; TL=$TS/libslic3r
TS_UNIQUE_SRC="
  $TL/treesupport_bridge_impl.cpp $TL/selector_bridge_impl.cpp $TL/TriangleSelector.cpp
  $TL/Support/SupportCommon.cpp $TL/Support/TreeModelVolumes.cpp $TL/Support/TreeSupport3D.cpp $TL/Support/TreeSupport.cpp
  $TL/Flow.cpp $TL/Layer.cpp $TL/MutablePolygon.cpp $TL/BuildVolume.cpp $TL/SurfaceCollection.cpp
  $TL/TriangleMesh.cpp $TL/TriangleMeshSlicer.cpp
  $TL/Fill/FillLightning.cpp $TL/MinimumSpanningTree.cpp $TL/ExtrusionEntity.cpp
  $TL/Geometry/ConvexHull.cpp $TL/Geometry/Circle.cpp
  $TL/Fill/Lightning/DistanceField.cpp $TL/Fill/Lightning/Generator.cpp $TL/Fill/Lightning/Layer.cpp $TL/Fill/Lightning/TreeNode.cpp
"
TS_INC="-Iarachne_port/cgal_stubs -I$TS -I$TL -I$TL/Support -Ithird_party/deps_src -Ithird_party/deps_src/libnest2d/include -Ithird_party/deps_src/libigl -Ithird_party/deps_src/clipper2/Clipper2Lib/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"
# ---- 병렬 컴파일 헬퍼: 소스별 .o 를 코어 수만큼 동시 컴파일 (기존: em++ 1회 호출 = 순차 컴파일) ----
#  ccache(EM_COMPILER_WRAPPER)가 헤더 의존 포함 캐싱을 담당하므로 mtime 증분 로직 없이 매번 전체 호출
#  — 미변경 TU 는 캐시 히트로 ~0.1s. 링크는 소스 나열 순서 그대로 .o 를 넘겨 결정성(golden) 유지.
NCPU=$(sysctl -n hw.ncpu 2>/dev/null || echo 8)
pcompile() {  # $1=objdir  $2=컴파일 플래그(문자열)  이후=소스 목록
  local objdir="$1" flags="$2"; shift 2
  mkdir -p "$objdir"
  printf '%s\n' "$@" | OBJDIR="$objdir" CFLAGS="$flags" xargs -P "$NCPU" -I SRC bash -c '
    em++ $CFLAGS -c "SRC" -o "$OBJDIR/$(printf "%s" "SRC" | tr "/" "_").o"'
}
objs() {  # $1=objdir  이후=소스 목록 → 소스 순서 그대로 .o 경로 출력
  local objdir="$1"; shift; local s
  for s in "$@"; do printf '%s/%s.o ' "$objdir" "$(printf '%s' "$s" | tr '/' '_')"; done
}

TS_GROUP_OBJ=/tmp/ts_group.o
TS_CFLAGS="-O2 -std=c++17 -DNDEBUG -DTS_BRIDGE_EXCLUDE_ROLE_FNS -DCGAL_DISABLE_ROUNDING_MATH_CHECK $TS_INC"
echo "compiling treesupport group (isolated, parallel x$NCPU) -> $TS_GROUP_OBJ"
pcompile /tmp/ws_obj/ts_st "$TS_CFLAGS" $TS_UNIQUE_SRC
em++ -O2 -r $(objs /tmp/ws_obj/ts_st $TS_UNIQUE_SRC) -o $TS_GROUP_OBJ

ARACHNE_INC="-Iarachne_port/cgal_stubs $CONFIG_INC -Iarachne_port/stubs -Iarachne_port -I$AP -Ithird_party/deps_src -I$C2/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"

# 속도 플래그 실측 (2026-07-29, big_cyl arachne+support): -O3 -msimd128 은 5183ms vs -O2 5149ms —
#  이득 0.7%(노이즈) 에 크기 +9%(3.43→3.74MB) 라 -O2 유지. -flto 는 wasm-ld SIGSEGV(-r 부분링크 충돌).
#  -ffast-math 는 금지(golden byte-identical 깨짐). 병목은 스칼라 정수 폴리곤 연산 — 실 레버는 스레딩.
MAIN_SRC="slicer_core.cpp clipper.cpp $ARACHNE_SRC $FILL_SRC $PE_SRC $TIME_SRC $CONFIG_SRC $WIPETOWER_SRC $GCODEPROC_SRC"
MAIN_CFLAGS="-O2 --bind -std=c++17 -DCGAL_DISABLE_ROUNDING_MATH_CHECK $ARACHNE_INC"
echo "compiling main sources (st, parallel x$NCPU)"
pcompile /tmp/ws_obj/st "$MAIN_CFLAGS" $MAIN_SRC
em++ -O2 --bind -std=c++17 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=4GB \
  -s STACK_SIZE=2MB \
  -s EXPORT_NAME=createSlicer \
  -s ENVIRONMENT=web,worker,node \
  -o ../engine/src/slicer_core.js \
  $(objs /tmp/ws_obj/st $MAIN_SRC) $TS_GROUP_OBJ

# webpack 호환: ENVIRONMENT_IS_NODE 가드 안의 동적 import("node:module") 를 webpack 이
# 정적 해석하다 실패(node: 스킴) → webpackIgnore 매직 코멘트로 제외. 런타임 동작 불변(Vite/Node 무영향).
sed -i '' 's|await import("node:module")|await import(/* webpackIgnore: true */ "node:module")|' ../engine/src/slicer_core.js

echo "built -> ../engine/src/slicer_core.js"
ls -la ../engine/src/slicer_core.js

# ---- 멀티스레드(mt) 빌드: PASS 1 레이어 병렬 (__EMSCRIPTEN_PTHREADS__) ----
#  별도 산출물 — 기본(st)은 zero-config 유지, mt 는 브라우저에서 COOP/COEP(crossOriginIsolated) 필요.
#  ALLOW_MEMORY_GROWTH+pthreads 조합은 emscripten 이 성능 경고를 내지만 기능상 유효(측정으로 판단).
echo "compiling treesupport group (mt, parallel x$NCPU) -> /tmp/ts_group_mt.o"
pcompile /tmp/ws_obj/ts_mt "-pthread $TS_CFLAGS" $TS_UNIQUE_SRC
em++ -O2 -pthread -r $(objs /tmp/ws_obj/ts_mt $TS_UNIQUE_SRC) -o /tmp/ts_group_mt.o

echo "compiling main sources (mt, parallel x$NCPU)"
pcompile /tmp/ws_obj/mt "-pthread $MAIN_CFLAGS" $MAIN_SRC
em++ -O2 -pthread --bind -std=c++17 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=4GB \
  -s STACK_SIZE=2MB \
  -s DEFAULT_PTHREAD_STACK_SIZE=2MB \
  -s MALLOC=mimalloc \
  -s PTHREAD_POOL_SIZE='(typeof navigator!=="undefined"&&navigator.hardwareConcurrency)||4' \
  -s EXPORT_NAME=createSlicer \
  -s ENVIRONMENT=web,worker,node \
  -o ../engine/src/slicer_core.mt.js \
  $(objs /tmp/ws_obj/mt $MAIN_SRC) /tmp/ts_group_mt.o

sed -i '' 's|await import("node:module")|await import(/* webpackIgnore: true */ "node:module")|' ../engine/src/slicer_core.mt.js
# mt 글루의 pthread 부트스트랩에도 동일 케이스: Node 가드 안의 동적 import("node:worker_threads")
sed -i '' 's|await import("node:worker_threads")|await import(/* webpackIgnore: true */ "node:worker_threads")|' ../engine/src/slicer_core.mt.js

echo "built -> ../engine/src/slicer_core.mt.js"
ls -la ../engine/src/slicer_core.mt.js
