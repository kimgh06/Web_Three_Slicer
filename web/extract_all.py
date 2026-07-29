#!/usr/bin/env python3
"""OrcaSlicer 리버스 엔지니어링 산출물 추출기.
출력: web/{ui-tree,config-schema,invalidation-map,toggle-rules}.json
33단계 재구성: 원본 소스는 slicer/, 산출 JSON 은 web/(이 스크립트 위치). 경로는 __file__ 기준 유도(절대경로 하드코딩 제거).
"""
import re, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))   # .../<repo>/web
REPO = os.path.dirname(HERE)                          # 저장소 루트
SRC  = os.path.join(REPO, 'slicer')                   # 원본 OrcaSlicer 소스(33단계 이동)
OUT  = os.path.join(HERE, 'packages', 'data')         # 33단계 Phase 3: 산출 JSON 은 @three-slicer/data 패키지로
os.makedirs(OUT, exist_ok=True)

def read(p):
    return open(os.path.join(SRC, p), encoding='utf-8', errors='replace').read()

# ---------------------------------------------------------------- ui-tree
def extract_ui_tree():
    src = read('src/slic3r/GUI/Tab.cpp')
    lines = src.split('\n')
    # 함수 경계: 모든 Tab 계열 멤버 함수
    funcs = []  # (name, start_line_idx)
    for i, l in enumerate(lines):
        m = re.match(r'(?:void|PageShp|bool)\s+(Tab\w*)::(\w+)\(', l)
        if m:
            funcs.append((f'{m.group(1)}::{m.group(2)}', i))
    result = {}
    for fi, (fname, start) in enumerate(funcs):
        end = funcs[fi + 1][1] if fi + 1 < len(funcs) else len(lines)
        pages = []
        cur_page = cur_group = None
        for ln in range(start, end):
            l = lines[ln]
            m = re.search(r'add_options_page\(L\("([^"]+)"\)(?:,\s*"([^"]*)")?', l)
            if m:
                cur_page = {'page': m.group(1), 'icon': m.group(2) or '', 'line': ln + 1, 'groups': []}
                pages.append(cur_page); cur_group = None; continue
            m = re.search(r'new_optgroup\(L\("([^"]*)"\)', l)
            if m and cur_page is not None:
                cur_group = {'group': m.group(1), 'line': ln + 1, 'options': []}
                cur_page['groups'].append(cur_group); continue
            m = re.search(r'append_single_option_line\("([^"]+)"(?:\s*,\s*"([^"]*)")?', l)
            if m and cur_group is not None:
                cur_group['options'].append(m.group(1)); continue
            # optgroup->append_line(...) 커스텀 위젯 / Option 객체 경유
            if cur_group is not None and re.search(r'optgroup->append_line\(', l) \
               and 'append_single_option_line' not in l:
                mm = re.search(r'get_option\("([^"]+)"\)', l)
                cur_group['options'].append(mm.group(1) if mm else '<custom-widget line:%d>' % (ln + 1))
        if pages:
            result[fname] = pages
    return result

# ---------------------------------------------------------------- config-schema
def _unquote(expr):
    """L("a" "b") / "a" → 파이썬 문자열. 인접 리터럴 연결."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', expr)
    if not parts:
        return None
    s = ''.join(parts)
    return s.replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')

def _parse_macros():
    """PrintConfigConstants.hpp의 #define 상수표."""
    out = {}
    try:
        for m in re.finditer(r'#define\s+(\w+)\s+([\w.\-]+)', read('src/libslic3r/PrintConfigConstants.hpp')):
            v = m.group(2)
            if v == 'true': out[m.group(1)] = True
            elif v == 'false': out[m.group(1)] = False
            else:
                try: out[m.group(1)] = float(v) if '.' in v else int(v)
                except ValueError: pass
    except FileNotFoundError:
        pass
    return out

def _parse_enum_maps(src):
    """s_keys_map_<Enum> { {"key", cppIdent}, ... }
    엔트리 값은 `spAligned` / `Enum::Ident` / `int(Enum::Ident)` 등 → 마지막 식별자로 매칭."""
    ident2key, enum_keys, per_enum = {}, {}, {}
    for m in re.finditer(r'static (?:const )?t_config_enum_values s_keys_map_(\w+)\s*=?\s*\{(.*?)\n\};', src, re.S):
        name, body = m.group(1), m.group(2)
        keys, scoped = [], {}
        for e in re.finditer(r'\{\s*"([^"]+)"\s*,\s*[^,}]*?(\w+)\s*\)?\s*\}', body):
            keys.append(e.group(1))
            ident2key[e.group(2)] = e.group(1)
            scoped[e.group(2)] = e.group(1)
        enum_keys[name] = keys
        per_enum[name] = scoped
    return ident2key, enum_keys, per_enum

def _parse_list_items(raw, macros):
    """중괄호 리스트 내부 → 파이썬 값 리스트. 해석 불가 항목은 원문 문자열 유지."""
    items = []
    pat = (r'"((?:[^"\\]|\\.)*)"'                                        # 1: 문자열
           r'|FloatOrPercent\(\s*([0-9.\-]+)\s*,\s*(true|false)\s*\)'    # 2,3: FloatOrPercent
           r'|Vec2d\(\s*([0-9.\-]+)\s*,\s*([0-9.\-]+)\s*\)'              # 4,5: 좌표
           r'|([A-Za-z_][\w.]*|[0-9.\-]+)')                              # 6: 식별자/숫자
    for m in re.finditer(pat, raw):
        s, fov, fob, vx, vy, ident = m.groups()
        if s is not None:
            items.append(s)
        elif fov is not None:
            items.append(fov + ('%' if fob == 'true' else ''))
        elif vx is not None:
            items.append([float(vx), float(vy)])
        elif ident is not None:
            if ident in ('true', 'false'): items.append(ident == 'true')
            elif ident in macros: items.append(macros[ident])
            else:
                try: items.append(float(ident) if '.' in ident else int(ident))
                except ValueError: items.append(ident)
    return items

def extract_schema():
    src = read('src/libslic3r/PrintConfig.cpp')
    macros = _parse_macros()
    ident2key, enum_keys_maps, per_enum_maps = _parse_enum_maps(src)
    # 주석 제거는 토크나이저에서 문자열 인식하며 수행 (툴팁 속 https:// 보호)
    # 어느 함수(init_common_params 등) 소속인지 추적용 오프셋 맵
    func_marks = [(m.start(), m.group(1)) for m in
                  re.finditer(r'void\s+\w+ConfigDef::(\w+)\(\)|(?:^|\n)(\w+ConfigDef)::\1?\(\)', src)]
    func_marks = [(m.start(), m.group(1) or 'ctor') for m in
                  re.finditer(r'void\s+(?:\w+)ConfigDef::(\w+)\(\)', src)]
    def func_of(pos):
        name = 'unknown'
        for p, n in func_marks:
            if p <= pos: name = n
            else: break
        return name
    line_of = lambda pos: src.count('\n', 0, pos) + 1

    stmts = []  # (pos, stmt_text)
    buf, depth, start, i, n = [], 0, 0, 0, len(src)
    while i < n:
        c = src[i]
        if c == '"':                              # 문자열 리터럴 통째로 소비
            buf.append(c); i += 1
            while i < n:
                if src[i] == '\\': buf.append(src[i:i+2]); i += 2; continue
                buf.append(src[i]); i += 1
                if src[i-1] == '"': break
            continue
        if c == "'":                              # 문자 리터럴
            j = i + 1
            while j < n and src[j] != "'":
                if src[j] == '\\': j += 1
                j += 1
            buf.append(src[i:j+1]); i = j + 1; continue
        if c == '#' and (i == 0 or src[i-1] == '\n'):  # 전처리기 라인은 문장에서 제외
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if c == '/' and i + 1 < n and src[i+1] == '/':
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if c == '/' and i + 1 < n and src[i+1] == '*':
            j = src.find('*/', i + 2); i = n if j < 0 else j + 2; continue
        if c in '([': depth += 1                  # 중괄호는 무시: 함수 본문 안 문장을 자르기 위함
        elif c in ')]': depth -= 1
        elif c == ';' and depth <= 0:
            stmts.append((start, ''.join(buf).strip())); buf = []; i += 1; start = i
            continue
        buf.append(c); i += 1

    options = {}
    named_defs = {}   # auto def_x = def; 추적
    cur = None
    STR_FIELDS = ['label', 'full_label', 'category', 'tooltip', 'sidetext', 'cli',
                  'cli_params', 'ratio_over', 'gui_flags', 'plugin_type']
    NUM_FIELDS = ['min', 'max', 'max_literal', 'height', 'width']
    BOOL_FIELDS = ['multiline', 'full_width', 'is_code', 'readonly', 'nullable']
    for pos, st in stmts:
        st_flat = ' '.join(st.split()).lstrip('{} ')  # 블록 여는/닫는 중괄호 잔재 제거
        m = re.match(r'(?:auto (\w+) = )?def ?= ?this->add\(\s*"([^"]+)"\s*,\s*(co\w+)\s*\)', st_flat)
        if m:
            key, ctype = m.group(2), m.group(3)
            # mode 미지정 시 C++ 기본값 comSimple (Config.hpp ConfigOptionDef)
            cur = {'type': ctype, 'mode': 'simple', 'defined_in': func_of(pos), 'line': line_of(pos)}
            options[key] = cur
            if m.group(1):                      # auto def_x = def = this->add(...)
                named_defs[m.group(1)] = cur
            continue
        if cur is None:
            continue
        m = re.match(r'auto (\w+) = def$', st_flat)
        if m:
            named_defs[m.group(1)] = cur
            continue
        m = re.match(r'def->(\w+) = (.*)$', st_flat, re.S)
        if m:
            field, val = m.group(1), m.group(2).strip()
            if field in STR_FIELDS:
                cur[field] = _unquote(val) if '"' in val else val
            elif field in NUM_FIELDS:
                try: cur[field] = float(val) if '.' in val else int(val)
                except ValueError: cur[field] = val
            elif field in BOOL_FIELDS:
                cur[field] = (val == 'true')
            elif field == 'mode':
                cur['mode'] = val.replace('com', '').lower()
            elif field == 'gui_type':
                cur['gui_type'] = val.split('::')[-1]
            elif field in ('enum_values', 'enum_labels'):
                if val.startswith('{'):          # 중괄호 리터럴 리스트
                    cur[field] = re.findall(r'"((?:[^"\\]|\\.)*)"', val)
                else:
                    mm = re.match(r'(\w+)->enum_(?:values|labels)$', val)
                    if mm and mm.group(1) in named_defs:
                        cur[field] = list(named_defs[mm.group(1)].get(field, []))
                        cur[field + '_copied_from'] = mm.group(1)
            elif field == 'enum_keys_map':
                mm = re.search(r'ConfigOptionEnum<(\w+)>|s_keys_map_(\w+)', val)
                cur['enum_type'] = (mm.group(1) or mm.group(2)) if mm else val
            elif field in ('aliases', 'shortcut'):
                cur[field] = re.findall(r'"([^"]+)"', val)
            continue
        m = re.match(r'def->enum_(values|labels)\.(?:push_back|emplace_back)\((.*)\)$', st_flat, re.S)
        if m:
            cur.setdefault('enum_' + m.group(1), []).append(_unquote(m.group(2)) or m.group(2))
            continue
        m = re.match(r'def->set_default_value\(\s*new ConfigOptionEnum<(\w+)>\s*\(\s*(?:\w+::)?(\w+)\s*\)\s*\)$', st_flat)
        if m:                                     # enum 기본값: cpp 식별자 → 직렬화 키
            cur['default_type'] = 'Enum<%s>' % m.group(1)
            cur['default_raw'] = m.group(2)
            scoped = per_enum_maps.get(m.group(1), {})   # enum별 스코프 우선 (식별자 충돌 방지)
            key = scoped.get(m.group(2), ident2key.get(m.group(2)))
            if key is not None:
                cur['default'] = key
            continue
        m = re.match(r'def->set_default_value\(\s*new ConfigOption(\w+)\s*[\({](.*)[\)}]\s*\)$', st_flat, re.S)
        if m:
            t, raw = m.group(1), m.group(2).strip()
            cur['default_type'] = t
            cur['default_raw'] = raw
            base = t[:-8] if t.endswith('Nullable') else t   # FloatsNullable → Floats
            if base in ('Float', 'Int', 'Percent'):
                v = macros.get(raw)
                if v is None:
                    lit = raw.rstrip('fF')          # 1.f → 1.
                    try: v = float(lit) if '.' in lit else int(lit)
                    except ValueError: v = None
                if v is not None: cur['default'] = v
            elif base == 'Bool':
                if raw in ('true', 'false'): cur['default'] = (raw == 'true')
                elif raw in ('0', '1'): cur['default'] = (raw == '1')
                elif isinstance(macros.get(raw), bool): cur['default'] = macros[raw]
            elif base == 'Point':
                mm = re.match(r'Vec2d\(\s*([0-9.\-]+)\s*,\s*([0-9.\-]+)\s*\)$', raw)
                if mm: cur['default'] = [float(mm.group(1)), float(mm.group(2))]
            elif base == 'EnumsGeneric':               # 벡터형 enum (per-extruder)
                idents = re.findall(r'\w+', raw)
                key = next((ident2key[i] for i in reversed(idents) if i in ident2key), None)
                if key is not None: cur['default'] = [key]
            elif base == 'String':
                cur['default'] = _unquote(raw) if '"' in raw else ''
            elif base == 'FloatOrPercent':
                mm = re.match(r'([0-9.\-]+)\s*,\s*(true|false)', raw)
                if mm: cur['default'] = mm.group(1) + ('%' if mm.group(2) == 'true' else '')
            elif base in ('Floats', 'Ints', 'Percents', 'Bools', 'Strings',
                          'FloatsOrPercents', 'Points'):
                cur['default'] = _parse_list_items(raw, macros)
            continue
    # enum_keys_map만 있고 enum_values가 없는 옵션: s_keys_map_* 테이블에서 보충
    for o in options.values():
        et = o.get('enum_type')
        if et and et in enum_keys_maps and not o.get('enum_values'):
            o['enum_values'] = list(enum_keys_maps[et])
            o['enum_values_from'] = 'keys_map'
    # 루프 생성 키 수동 전개: PrintConfig.cpp:4900- (for axis in X,Y,Z,E)
    for fam, label in [('machine_max_speed_', 'Maximum speed %s'),
                       ('machine_max_acceleration_', 'Maximum acceleration %s'),
                       ('machine_max_jerk_', 'Maximum jerk %s')]:
        for ax in 'xyze':
            k = fam + ax
            if k not in options:
                options[k] = {'type': 'coFloats', 'defined_in': 'init_fff_params',
                              'category': 'Machine limits', 'full_label': label % ax.upper(),
                              'generated_by_loop': 'PrintConfig.cpp:4900 axis loop'}
    return options

# ---------------------------------------------------------------- invalidation
def extract_invalidation():
    def parse(path, fn_sig):
        src = read(path)
        i = src.find(fn_sig)
        if i < 0:
            return None
        # 함수 본문: 첫 { 부터 균형 } 까지
        j = src.find('{', i); depth = 0; k = j
        while k < len(src):
            if src[k] == '{': depth += 1
            elif src[k] == '}':
                depth -= 1
                if depth == 0: break
            k += 1
        body = src[j:k]
        base_line = src.count('\n', 0, i) + 1
        # if/else-if 체인: 조건 안의 opt_key == "..." 들 + 블록 안의 ps*/pos* 토큰
        branches = []
        for m in re.finditer(r'(?:else\s+)?if\s*\(((?:[^()]|\([^()]*\))*)\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}', body):
            cond, blk = m.group(1), m.group(2)
            keys = re.findall(r'opt_key == "([^"]+)"', cond)
            if not keys:
                continue
            steps = sorted(set(re.findall(r'\b(ps[A-Z]\w+|pos[A-Z]\w+)\b', blk)))
            special = []
            if 'invalidate_all_steps' in blk: special.append('invalidate_all_steps')
            if 'm_force_update' in blk or 'osteps' in blk: pass
            branches.append({'keys': keys, 'steps': steps, 'special': special,
                             'line': base_line + body.count('\n', 0, m.start())})
        return branches
    return {
        'Print':  parse('src/libslic3r/Print.cpp',
                        'Print::invalidate_state_by_config_options'),
        'PrintObject': parse('src/libslic3r/PrintObject.cpp',
                        'PrintObject::invalidate_state_by_config_options'),
        'note': '조건에 없는 opt_key(기본 분기)는 전체 무효화. steps는 분기 블록에서 참조된 단계 토큰.'
    }

# ---------------------------------------------------------------- toggle-rules
def _extract_toggles_from(src, func_pat, call_pat):
    funcs = [(m.group(1), src.count('\n', 0, m.start()) + 1, m.start())
             for m in re.finditer(func_pat, src)]
    out = {}
    for fi, (fname, fline, fpos) in enumerate(funcs):
        fend = funcs[fi + 1][2] if fi + 1 < len(funcs) else len(src)
        body = src[fpos:fend]
        base = fline
        rec = {'locals': {}, 'rules': []}
        # 지역 bool 변수 = 조건식
        for m in re.finditer(r'\b(?:const\s+)?(?:bool|auto)\s+(\w+)\s*=\s*((?:[^;{]|\{[^}]*\})+);', body):
            if re.search(r'config->|opt_|have_|is_|==|!=|&&|\|\|', m.group(2)):
                rec['locals'][m.group(1)] = ' '.join(m.group(2).split())
        # for (auto el : {"a","b"}) ... toggle_xxx(el, cond)
        for m in re.finditer(r'for \(auto (?:const\s*&?\s*)?(\w+) : \{([^}]*)\}\)\s*(?:\{)?\s*' + call_pat + r'\(\s*\1\s*,\s*([^;]+?)\)\s*;', body):
            keys = re.findall(r'"([^"]+)"', m.group(2))
            rec['rules'].append({'fields': keys, 'enable_if': ' '.join(m.group(4).split()),
                                 'kind': m.group(3), 'line': base + body.count('\n', 0, m.start())})
        # 단건 toggle_xxx("key", cond[, idx])
        for m in re.finditer(call_pat + r'\(\s*"([^"]+)"\s*,\s*((?:[^();]|\([^()]*\))+?)\)\s*;', body):
            rec['rules'].append({'fields': [m.group(2)], 'enable_if': ' '.join(m.group(3).split()),
                                 'kind': m.group(1), 'line': base + body.count('\n', 0, m.start())})
        # 파싱 안 된 toggle 호출 카운트(정직성)
        total = len(re.findall(call_pat + r'\(', body))
        covered = sum(len(r['fields']) if r['fields'] and r['fields'][0] != '<var>' else 1
                      for r in rec['rules'])
        rec['stats'] = {'toggle_calls_in_source': total, 'rules_extracted': len(rec['rules'])}
        if rec['rules'] or rec['locals']:
            out[fname] = rec
    return out

def extract_toggles():
    out = _extract_toggles_from(read('src/slic3r/GUI/ConfigManipulation.cpp'),
                                r'void\s+ConfigManipulation::(\w+)\(', r'toggle_(field|line)')
    tab = _extract_toggles_from(read('src/slic3r/GUI/Tab.cpp'),
                                r'void\s+(Tab\w*::toggle_options)\(', r'toggle_(option)')
    out.update(tab)
    return out

# ---------------------------------------------------------------- main
if __name__ == '__main__':
    ui = extract_ui_tree()
    json.dump(ui, open(os.path.join(OUT, 'ui-tree.json'), 'w'), ensure_ascii=False, indent=1)
    npages = sum(len(v) for v in ui.values())
    nopts = sum(len(g['options']) for v in ui.values() for p in v for g in p['groups'])

    sch = extract_schema()
    json.dump(sch, open(os.path.join(OUT, 'config-schema.json'), 'w'), ensure_ascii=False, indent=1)

    inv = extract_invalidation()
    json.dump(inv, open(os.path.join(OUT, 'invalidation-map.json'), 'w'), ensure_ascii=False, indent=1)

    tog = extract_toggles()
    json.dump(tog, open(os.path.join(OUT, 'toggle-rules.json'), 'w'), ensure_ascii=False, indent=1)

    print(f"ui-tree: {len(ui)} builders, {npages} pages, {nopts} option refs")
    print(f"schema: {len(sch)} options; with enum_values: {sum(1 for o in sch.values() if o.get('enum_values'))}; with tooltip: {sum(1 for o in sch.values() if o.get('tooltip'))}")
    pb = inv['Print'] or []; pob = inv['PrintObject'] or []
    print(f"invalidation: Print {len(pb)} branches / PrintObject {len(pob)} branches")
    print(f"toggle: {sum(len(v['rules']) for v in tog.values())} rules across {len(tog)} functions; "
          f"calls in source: {sum(v['stats']['toggle_calls_in_source'] for v in tog.values())}")
