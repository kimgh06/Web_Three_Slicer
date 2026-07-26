#!/usr/bin/env bash
# 브라우저 단독 슬라이싱 미니 커널 빌드 (트랙 C)
# 산출물: ../packages/engine/src/slicer_core.js  (SINGLE_FILE=1 → wasm 을 base64 인라인,
#         외부 .wasm fetch 없음 → 정적 서버/vite preview 어디서든 자립 동작)
#
# 7단계: 실제 OrcaSlicer Arachne(WallToolPaths) 이식본을 함께 링크한다.
#  - 커널 자체 clipper(전역 ClipperLib)와 Arachne 이식본 clipper(Slic3r::ClipperLib / ClipperLib_Z)는
#    서로 다른 네임스페이스라 공존. arachne_bridge.cpp 만이 두 세계를 잇는다.
#  - 필요: brew boost(header-only voronoi) + brew eigen. 스텁: tbb/boost-log/cereal/SVG/Flow/Config 등.
set -euo pipefail

export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
export PATH="/opt/homebrew/opt/emscripten/bin:$PATH"

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
TS_GROUP_OBJ=/tmp/ts_group.o
echo "compiling treesupport group (isolated) -> $TS_GROUP_OBJ"
em++ -O2 -std=c++17 -r -DNDEBUG -DTS_BRIDGE_EXCLUDE_ROLE_FNS -DCGAL_DISABLE_ROUNDING_MATH_CHECK $TS_INC $TS_UNIQUE_SRC -o $TS_GROUP_OBJ

ARACHNE_INC="-Iarachne_port/cgal_stubs $CONFIG_INC -Iarachne_port/stubs -Iarachne_port -I$AP -Ithird_party/deps_src -I$C2/include -I/opt/homebrew/include/eigen3 -I/opt/homebrew/include"

em++ -O2 --bind -std=c++17 \
  -DCGAL_DISABLE_ROUNDING_MATH_CHECK \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s SINGLE_FILE=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORT_NAME=createSlicer \
  -s ENVIRONMENT=web,worker,node \
  $ARACHNE_INC \
  -o ../packages/engine/src/slicer_core.js \
  slicer_core.cpp clipper.cpp $ARACHNE_SRC $FILL_SRC $PE_SRC $TIME_SRC $CONFIG_SRC $WIPETOWER_SRC $GCODEPROC_SRC $TS_GROUP_OBJ

echo "built -> ../packages/engine/src/slicer_core.js"
ls -la ../packages/engine/src/slicer_core.js
