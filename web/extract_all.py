#!/usr/bin/env python3
"""Extractor for the OrcaSlicer reverse-engineering artifacts.
Output: web/{ui-tree,config-schema,invalidation-map,toggle-rules}.json
Stage 33 restructure: upstream sources live in slicer/, generated JSON in web/ (where this script lives). Paths are derived from __file__ (no hardcoded absolute paths).
"""
import re, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))   # .../<repo>/web
REPO = os.path.dirname(HERE)                          # repository root
SRC  = os.path.join(REPO, 'slicer')                   # upstream OrcaSlicer sources (moved in stage 33)
OUT  = os.path.join(REPO, 'packages', 'data')         # stage 33 phase 3: generated JSON goes into the @three-slicer/data package
os.makedirs(OUT, exist_ok=True)

def read(p):
    return open(os.path.join(SRC, p), encoding='utf-8', errors='replace').read()

# ---------------------------------------------------------------- ui-tree
def extract_ui_tree():
    src = read('src/slic3r/GUI/Tab.cpp')
    lines = src.split('\n')
    # Function boundaries: every Tab-family member function
    funcs = []  # (name, start_line_idx)
    for i, l in enumerate(lines):
        m = re.match(r'(?:void|PageShp|bool)\s+(Tab\w*)::(\w+)\(', l)
        if m:
            funcs.append((f'{m.group(1)}::{m.group(2)}', i))
    result = {}
    for fi, (fname, start) in enumerate(funcs):
        end = funcs[fi + 1][1] if fi + 1 < len(funcs) else len(lines)
        body = '\n'.join(lines[start:end])
        # Upstream builds some groups from local string vectors instead of literal calls
        #  (Tab.cpp build_kinematics_page: `for (const auto &axis : axes) append_option_line(optgroup, "machine_max_acceleration_" + axis)`).
        #  Resolve the vectors and the loop variables bound to them so those options are recovered instead of coming out as empty groups.
        vectors = {name: re.findall(r'"([^"]+)"', items)
                   for name, items in re.findall(r'const\s+std::vector<std::string>\s+(\w+)\s*\{([^}]*)\}', body, re.S)}
        loop_vars = {var: vec for var, vec in re.findall(r'for\s*\(\s*const\s+(?:std::string|auto)\s*&\s*(\w+)\s*:\s*(\w+)\s*\)', body)
                     if vec in vectors}
        def expand(expr):
            """`"lit"` / `"prefix_" + var` / `var` -> the list of option keys it appends."""
            m = re.match(r'"([^"]*)"\s*$', expr)
            if m: return [m.group(1)]
            m = re.match(r'"([^"]*)"\s*\+\s*(\w+)\s*$', expr)
            if m and m.group(2) in loop_vars: return [m.group(1) + v for v in vectors[loop_vars[m.group(2)]]]
            if expr in loop_vars: return vectors[loop_vars[expr]]
            return []
        pages = []
        cur_page = cur_group = None
        for ln in range(start, end):
            l = lines[ln]
            if l.lstrip().startswith('//'): continue      # commented-out groups/options are not part of the UI
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
            # Free helper `append_option_line(optgroup, <expr>, ...)` — the key is the 2nd argument and may be built from a loop variable
            m = re.search(r'append_option_line\(\s*optgroup\s*,\s*([^,)]+?)\s*[,)]', l)
            if m and cur_group is not None:
                cur_group['options'].extend(expand(m.group(1).strip())); continue
            # optgroup->append_line(...) custom widgets / via an Option object
            if cur_group is not None and re.search(r'optgroup->append_line\(', l) \
               and 'append_single_option_line' not in l:
                mm = re.search(r'get_option\("([^"]+)"\)', l)
                cur_group['options'].append(mm.group(1) if mm else '<custom-widget line:%d>' % (ln + 1))
        # Rows appended by a local lambda driven by an inline brace list (the filament "Setting Overrides" page,
        #  Tab.cpp ~4035, is the only one): the scanner above sees just the lambda's append_line, so the group came
        #  out holding a placeholder instead of its 17 override keys. Attach the list to the last group opened
        #  before the loop, which is the one the lambda captures.
        for m in re.finditer(r'for\s*\(\s*const\s+std::string\s+\w+\s*:\s*\{(.*?)\}\s*\)', body, re.S):
            keys = re.findall(r'"([a-z0-9_]+)"', re.sub(r'//[^\n]*', '', m.group(1)))
            loop_line = start + body.count('\n', 0, m.start()) + 1
            target = None
            for page in pages:
                for group in page['groups']:
                    if group['line'] <= loop_line: target = group
            if not keys or target is None: continue
            target['options'] = [o for o in target['options'] if not o.startswith('<custom-widget')] + keys
        if pages:
            result[fname] = pages
    return result

# ---------------------------------------------------------------- config-schema
def _unquote(expr):
    """L("a" "b") / "a" -> a Python string. Adjacent literals are concatenated."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', expr)
    if not parts:
        return None
    s = ''.join(parts)
    return s.replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')

def _parse_macros():
    """The #define constant table from PrintConfigConstants.hpp."""
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
    Entry values look like `spAligned` / `Enum::Ident` / `int(Enum::Ident)` -> matched on the last identifier."""
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
    """Inside a brace list -> a Python value list. Items that cannot be parsed keep their source text."""
    items = []
    pat = (r'"((?:[^"\\]|\\.)*)"'                                        # 1: string
           r'|FloatOrPercent\(\s*([0-9.\-]+)\s*,\s*(true|false)\s*\)'    # 2,3: FloatOrPercent
           r'|Vec2d\(\s*([0-9.\-]+)\s*,\s*([0-9.\-]+)\s*\)'              # 4,5: coordinates
           r'|([A-Za-z_][\w.]*|[0-9.\-]+)')                              # 6: identifier/number
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
    # Comment stripping happens in the tokenizer, which recognizes strings (protecting https:// inside tooltips)
    # Offset map used to track which function (init_common_params, …) a statement belongs to
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
        if c == '"':                              # consume the whole string literal
            buf.append(c); i += 1
            while i < n:
                if src[i] == '\\': buf.append(src[i:i+2]); i += 2; continue
                buf.append(src[i]); i += 1
                if src[i-1] == '"': break
            continue
        if c == "'":                              # character literal
            j = i + 1
            while j < n and src[j] != "'":
                if src[j] == '\\': j += 1
                j += 1
            buf.append(src[i:j+1]); i = j + 1; continue
        if c == '#' and (i == 0 or src[i-1] == '\n'):  # preprocessor lines are excluded from statements
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if c == '/' and i + 1 < n and src[i+1] == '/':
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if c == '/' and i + 1 < n and src[i+1] == '*':
            j = src.find('*/', i + 2); i = n if j < 0 else j + 2; continue
        if c in '([': depth += 1                  # braces are ignored: the point is to split statements inside a function body
        elif c in ')]': depth -= 1
        elif c == ';' and depth <= 0:
            stmts.append((start, ''.join(buf).strip())); buf = []; i += 1; start = i
            continue
        buf.append(c); i += 1

    options = {}
    named_defs = {}   # tracks auto def_x = def;
    cur = None
    STR_FIELDS = ['label', 'full_label', 'category', 'tooltip', 'sidetext', 'cli',
                  'cli_params', 'ratio_over', 'gui_flags', 'plugin_type']
    NUM_FIELDS = ['min', 'max', 'max_literal', 'height', 'width']
    BOOL_FIELDS = ['multiline', 'full_width', 'is_code', 'readonly', 'nullable']
    for pos, st in stmts:
        st_flat = ' '.join(st.split()).lstrip('{} ')  # drop leftover opening/closing braces of a block
        m = re.match(r'(?:auto (\w+) = )?def ?= ?this->add\(\s*"([^"]+)"\s*,\s*(co\w+)\s*\)', st_flat)
        if m:
            key, ctype = m.group(2), m.group(3)
            # With no mode given, the C++ default is comSimple (Config.hpp ConfigOptionDef)
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
                if val.startswith('{'):          # brace literal list
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
        if m:                                     # enum default: cpp identifier -> serialization key
            cur['default_type'] = 'Enum<%s>' % m.group(1)
            cur['default_raw'] = m.group(2)
            scoped = per_enum_maps.get(m.group(1), {})   # per-enum scope wins (avoids identifier collisions)
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
            elif base == 'EnumsGeneric':               # vector enum (per-extruder)
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
    # Options that have enum_keys_map but no enum_values: filled in from the s_keys_map_* tables
    for o in options.values():
        et = o.get('enum_type')
        if et and et in enum_keys_maps and not o.get('enum_values'):
            o['enum_values'] = list(enum_keys_maps[et])
            o['enum_values_from'] = 'keys_map'
    options.update(_parse_axis_limits(src))
    options.update(_parse_filament_overrides(src, options))
    return options

def _parse_filament_overrides(src, options):
    """The `filament_*` retraction overrides (PrintConfig.cpp ~7864) are generated by a loop over
    filament_extruder_override_keys that clones the machine option of the same name, so the statement scanner
    never sees them — which left the TabFilament overrides page referring to 18 keys the schema did not define.
    Upstream registers them with add_nullable: no default of their own, because an unset override means
    "keep the printer's value". That is exactly what an absent default gives here, so none is emitted."""
    m = re.search(r'filament_extruder_override_keys\s*=\s*\{(.*?)\n\s*\};', src, re.S)
    if not m: return {}
    # comSimple for the four upstream promotes out of the machine tab's develop mode, comAdvanced otherwise
    simple = {'filament_retraction_length', 'filament_z_hop',
              'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut'}
    out = {}
    for key in re.findall(r'"([a-z0-9_]+)"', m.group(1)):
        base = options.get(key[len('filament_'):])
        if not base: continue                     # the machine option is missing -> nothing to clone
        clone = {k: v for k, v in base.items()
                 if k in ('type', 'label', 'full_label', 'tooltip', 'sidetext', 'enum_values', 'enum_labels',
                          'enum_type', 'enum_values_from', 'min', 'max')}
        clone['mode'] = 'simple' if key in simple else 'advanced'
        clone['nullable'] = True
        out[key] = clone
    return out

def _parse_axis_limits(src):
    """The machine limits (machine_max_{speed,acceleration,jerk}_{x,y,z,e}) are generated by a loop over an
    AxisDefault table (PrintConfig.cpp ~4890), so the statement scanner above never sees them. Parsing them here
    keeps the labels, units, modes and per-axis defaults coming from the source instead of being spelled out."""
    m = re.search(r'std::vector<AxisDefault>\s+axes\s*\{(.*?)\n\s*\};', src, re.S)
    if not m: return {}
    # { "x", { 500., 200. }, { 1000., 1000. }, { 10., 10. } }  ->  x: [feedrate[], acceleration[], jerk[]]
    axis_defaults = {}
    for row in re.finditer(r'\{\s*"(\w+)"\s*,\s*(\{[^{}]*\})\s*,\s*(\{[^{}]*\})\s*,\s*(\{[^{}]*\})\s*\}', m.group(1)):
        axis_defaults[row.group(1)] = [[float(v) for v in re.findall(r'-?[\d.]+', g)] for g in row.groups()[1:]]
    if not axis_defaults: return {}
    # The loop body that follows the table: one `def = this->add("<family>" + axis.name, ...)` block per limit family
    body = src[m.end():]
    body = body[:body.find('\n    }\n')] if '\n    }\n' in body else body[:8000]
    # `axis.max_feedrate` is the 1st table column, `max_acceleration` the 2nd, `max_jerk` the 3rd
    COLUMN = {'max_feedrate': 0, 'max_acceleration': 1, 'max_jerk': 2}
    out = {}
    blocks = re.split(r'def\s*=\s*this->add\(\s*"([^"]+)"\s*\+\s*axis\.name\s*,\s*(co\w+)\s*\)', body)
    for i in range(1, len(blocks) - 1, 3):
        prefix, ctype, chunk = blocks[i], blocks[i + 1], blocks[i + 2]
        fields = dict(re.findall(r'def->(\w+)\s*=\s*(.+?);', chunk))
        col = next((c for f, c in COLUMN.items() if f in fields.get('set_default_value', '')
                    or ('axis.' + f) in chunk.split('set_default_value')[-1][:80]), None)
        for axis, defaults in axis_defaults.items():
            opt = {'type': ctype, 'mode': 'simple', 'defined_in': 'init_fff_params',
                   'generated_by_loop': 'PrintConfig.cpp AxisDefault loop'}
            for field, raw in fields.items():
                if field in ('full_label', 'tooltip'):
                    fmt = _unquote(raw)
                    if fmt: opt[field] = fmt.replace('%1%', axis.upper())
                elif field in ('category', 'sidetext'): opt[field] = _unquote(raw)
                elif field == 'min':
                    try: opt['min'] = float(raw) if '.' in raw else int(raw)
                    except ValueError: pass
                elif field == 'mode': opt['mode'] = raw.replace('com', '').lower()
                elif field == 'readonly': opt['readonly'] = (raw == 'true')
            if col is not None: opt['default'] = defaults[col]
            out[prefix + axis] = opt
    return out

# ---------------------------------------------------------------- printers
# Per-printer settings from resources/profiles/<Vendor>/machine/*.json. The profiles carry ~62 keys each;
# only what the kernel actually consumes is kept, because an extracted key the kernel ignores is dead weight
# in every consumer's bundle. Add a key here the moment the kernel starts reading it.
PRINTER_KEYS = [
    # Motion limits — drive the print time estimate
    'machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e',
    'machine_max_acceleration_x', 'machine_max_acceleration_y', 'machine_max_acceleration_z', 'machine_max_acceleration_e',
    'machine_max_acceleration_extruding', 'machine_max_acceleration_retracting', 'machine_max_acceleration_travel',
    'machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_jerk_z', 'machine_max_jerk_e',
    'machine_max_junction_deviation',
    # NB: default_acceleration / travel_acceleration / *_wall_acceleration are deliberately NOT here. They are the
    #  accelerations the printer is actually driven at, which upstream keeps in the process profile (1355 of them
    #  set it, against 28 machine profiles). Claiming them here would let a printer pick block a quality preset.
    # Geometry / hardware — the bed and nozzle the viewer draws and the kernel slices against
    'printable_area', 'printable_height', 'nozzle_diameter', 'z_hop', 'extruder_offset',
    # NB: machine_start_gcode / machine_end_gcode are deliberately absent. 256 of the 264 distinct vendor pairs are
    #  templates ("M140 S[bed_temperature_initial_layer]", "{if max_layer_z < printable_height}…"), and the kernel has
    #  no PlaceholderParser to expand them — emitting them verbatim produces invalid G-code. The kernel accepts both
    #  options, so a host can still supply literal G-code; wiring the vendor profiles needs the parser first.
]

def _coerce(value, ctype):
    """Profile JSON stores everything as strings ("220x0", "500"); the schema (and therefore the settings
    map the panel edits) wants the option's real type. Coercing by ctype keeps this key-agnostic."""
    def num(tok):
        try: return float(tok) if ('.' in str(tok) or 'e' in str(tok).lower()) else int(tok)
        except (TypeError, ValueError): return tok
    if ctype == 'coPoints':          # ["0x0","220x0"] -> [[0,0],[220,0]]
        pts = []
        for tok in (value if isinstance(value, list) else [value]):
            parts = str(tok).split('x')
            if len(parts) == 2: pts.append([num(parts[0]), num(parts[1])])
        return pts or None
    if ctype in ('coFloat', 'coInt', 'coPercent'):
        return num(value[0] if isinstance(value, list) and value else value)
    if ctype in ('coFloats', 'coInts', 'coPercents'):
        # Upstream repeats these per machine mode (normal/silent/…); the kernel has no silent mode and both
        # the panel and settingScalar only ever read [0], so keep one entry instead of four identical-ish ones.
        seq = value if isinstance(value, list) else [value]
        return [num(seq[0])] if seq else None
    if ctype in ('coBool', 'coBools'):
        first = value[0] if isinstance(value, list) and value else value
        return str(first) in ('1', 'true', 'True')
    return value                      # strings / enums pass through unchanged

def _kernel_keys(schema):
    """The option keys the kernel actually consumes, read out of the settings mapping itself so the two never
    drift apart: any schema key quoted in engine/src/settings.js is a key deriveKernelParams can read."""
    path = os.path.join(REPO, 'packages', 'engine', 'src', 'settings.js')
    try:
        with open(path, encoding='utf-8') as fh: src = fh.read()
    except OSError:
        return []
    return sorted({k for k in re.findall(r"'([a-z0-9_]+)'", src) if k in schema})

def extract_processes(schema):
    """Print (process) presets — where the print-side accelerations and speeds live. Joined to printers by the
    profile's own `compatible_printers` list, which names machine profiles exactly as printers.json keys them."""
    root = os.path.join(SRC, 'resources', 'profiles')
    kernel_keys = _kernel_keys(schema)
    if not os.path.isdir(root) or not kernel_keys: return {'keys': [], 'sets': [], 'presets': [], 'byPrinter': {}}
    profiles = {}
    for vendor in sorted(os.listdir(root)):
        pdir = os.path.join(root, vendor, 'process')
        if not os.path.isdir(pdir): continue
        for fn in sorted(os.listdir(pdir)):
            if not fn.endswith('.json'): continue
            try:
                with open(os.path.join(pdir, fn), encoding='utf-8') as fh: prof = json.load(fh)
            except (ValueError, OSError): continue
            if isinstance(prof, dict) and prof.get('name'): profiles[(vendor, prof['name'])] = prof

    def resolve(vendor, prof, depth=0):
        out = {}
        parent = profiles.get((vendor, prof.get('inherits'))) if depth < 10 else None
        if parent is not None: out.update(resolve(vendor, parent, depth + 1))
        for key in kernel_keys:
            raw = prof.get(key)
            if raw is None: continue
            val = _coerce(raw, (schema.get(key) or {}).get('type', ''))
            if val is not None: out[key] = val
        return out

    entries = []
    for (vendor, name), prof in sorted(profiles.items()):
        compat = prof.get('compatible_printers')
        if not compat: continue                       # abstract parents carry no printer list
        vals = resolve(vendor, prof)
        if not vals: continue
        entries.append((name, vals, compat))

    # Only the kernel keys some process preset actually sets. The kernel key list also covers the filament-owned
    #  options (nozzle_temperature, the fan keys, …), which no process profile touches — carrying them here as
    #  all-null columns would make a consumer clear the picked material's values on every quality change.
    keys = sorted({k for _n, vals, _c in entries for k in vals})

    # Same column layout as printers.json, and byPrinter holds preset indices: a preset name averages 30 chars
    #  and each is listed by every compatible printer, so spelling them out costs more than all the values.
    sets, index, names, seen_name, by_printer = [], {}, [], {}, {}
    for name, vals, compat in entries:
        row = [vals.get(k) for k in keys]
        sig = json.dumps(row, sort_keys=True)
        if sig not in index:
            index[sig] = len(sets); sets.append(row)
        if name not in seen_name:
            seen_name[name] = len(names); names.append([name, index[sig]])
        for printer in compat:
            by_printer.setdefault(printer, []).append(seen_name[name])
    return {'keys': keys, 'sets': sets, 'presets': names, 'byPrinter': by_printer}

# ---------------------------------------------------------------- filaments
def extract_filaments(schema):
    """Filament (material) presets. Same column layout and same `compatible_printers` join as the process presets,
    with three differences:
      - the profiles nest one folder deeper (<Vendor>/filament/<Brand>/*.json), so this walks instead of listdir;
      - `filament_type` / `filament_vendor` ride on the entry, so a picker can group by material without a second
        file. Both are declared on the abstract `@base` parent, hence the inherits walk;
      - `defaultsByModel` is the vendor's recommended material list, which upstream keeps on the machine_model
        (not on the filament and not on the nozzle-variant machine profile) — joined by printers.json's model field.
    Preset names are globally unique across vendors (verified: 6282 instantiable profiles, 0 collisions), so the
    name-keyed lookup the process presets use holds here too."""
    root = os.path.join(SRC, 'resources', 'profiles')
    kernel_keys = _kernel_keys(schema)
    empty = {'keys': [], 'sets': [], 'presets': [], 'byPrinter': {}, 'defaultsByModel': {}}
    if not os.path.isdir(root) or not kernel_keys: return empty

    profiles, model_materials = {}, {}
    for vendor in sorted(os.listdir(root)):
        for dirpath, _dirs, files in os.walk(os.path.join(root, vendor, 'filament')):
            for fn in sorted(files):
                if not fn.endswith('.json'): continue
                try:
                    with open(os.path.join(dirpath, fn), encoding='utf-8') as fh: prof = json.load(fh)
                except (ValueError, OSError): continue
                if isinstance(prof, dict) and prof.get('name'): profiles[(vendor, prof['name'])] = prof
        mdir = os.path.join(root, vendor, 'machine')
        if not os.path.isdir(mdir): continue
        for fn in sorted(os.listdir(mdir)):
            if not fn.endswith('.json'): continue
            try:
                with open(os.path.join(mdir, fn), encoding='utf-8') as fh: model = json.load(fh)
            except (ValueError, OSError): continue
            if isinstance(model, dict) and model.get('type') == 'machine_model' and model.get('default_materials'):
                model_materials[model.get('name', '')] = [m.strip() for m in model['default_materials'].split(';') if m.strip()]

    def resolve(vendor, prof, depth=0):
        out = {}
        parent = profiles.get((vendor, prof.get('inherits'))) if depth < 10 else None
        if parent is not None: out.update(resolve(vendor, parent, depth + 1))
        for key in kernel_keys:
            raw = prof.get(key)
            if raw is None: continue
            first = raw[0] if isinstance(raw, list) and raw else raw
            # "nil" on a nullable override means "keep the machine's value", and it has to clear what an
            #  ancestor set rather than be skipped — 51 profiles state nil over a parent that named a number.
            if str(first) == 'nil': out.pop(key, None); continue
            val = _coerce(raw, (schema.get(key) or {}).get('type', ''))
            if val is not None: out[key] = val
        return out

    def inherited(vendor, prof, key, depth=0):
        """Metadata (not a kernel key) from the nearest ancestor that declares it."""
        if key in prof: return prof[key]
        parent = profiles.get((vendor, prof.get('inherits'))) if depth < 10 else None
        return inherited(vendor, parent, key, depth + 1) if parent is not None else None

    def label(raw):     # filament_type/vendor are per-extruder arrays upstream; one material per preset here
        first = raw[0] if isinstance(raw, list) and raw else raw
        return first if isinstance(first, str) else ''

    # `instantiation:false` profiles are abstract parents that exist only to be inherited. A preset that sets none
    #  of the kernel keys is still kept: its name and material type are what the picker shows, and it dedupes into
    #  the one all-null row. As settings.js grows filament keys, those presets fill in with no change here.
    entries = []
    for (vendor, name), prof in sorted(profiles.items()):
        if str(prof.get('instantiation')) != 'true': continue
        compat = inherited(vendor, prof, 'compatible_printers')
        if not compat: continue                       # nothing to attach it to
        entries.append((name, resolve(vendor, prof),
                        label(inherited(vendor, prof, 'filament_type')),
                        label(inherited(vendor, prof, 'filament_vendor')), compat))

    # Only the kernel keys some filament actually sets: this list is what a consumer clears before applying a
    #  different material, so carrying process-owned keys here would wipe the print preset on every switch.
    keys = sorted({k for _n, vals, _t, _v, _c in entries for k in vals})

    sets, index, presets, seen_name, by_printer = [], {}, [], {}, {}
    for name, vals, ftype, fvendor, compat in entries:
        row = [vals.get(k) for k in keys]
        sig = json.dumps(row, sort_keys=True)
        if sig not in index:
            index[sig] = len(sets); sets.append(row)
        if name not in seen_name:
            seen_name[name] = len(presets); presets.append([name, index[sig], ftype, fvendor])
        for printer in compat:
            by_printer.setdefault(printer, []).append(seen_name[name])

    # Recommendations name presets that may not exist (typos, materials pulled from a newer profile set) — drop those
    #  rather than emit an index the consumer has to guard.
    defaults_by_model = {}
    for model, materials in sorted(model_materials.items()):
        idx = [seen_name[m] for m in materials if m in seen_name]
        if idx: defaults_by_model[model] = idx
    return {'keys': keys, 'sets': sets, 'presets': presets, 'byPrinter': by_printer, 'defaultsByModel': defaults_by_model}

def extract_printers(schema):
    root = os.path.join(SRC, 'resources', 'profiles')
    if not os.path.isdir(root): return {'keys': PRINTER_KEYS, 'sets': [], 'byVendor': {}}
    # Load every machine profile first: `inherits` points at a sibling profile by name and chains up to 5 deep
    profiles = {}   # (vendor, name) -> dict
    for vendor in sorted(os.listdir(root)):
        mdir = os.path.join(root, vendor, 'machine')
        if not os.path.isdir(mdir): continue
        for fn in sorted(os.listdir(mdir)):
            if not fn.endswith('.json'): continue
            try:
                with open(os.path.join(mdir, fn), encoding='utf-8') as fh: prof = json.load(fh)
            except (ValueError, OSError): continue
            if isinstance(prof, dict) and prof.get('name'): profiles[(vendor, prof['name'])] = prof

    def resolve(vendor, prof, keys, depth=0):
        """Flatten the inherits chain down to the given keys, in the schema's own representation."""
        out = {}
        parent = profiles.get((vendor, prof.get('inherits'))) if depth < 10 else None
        if parent is not None: out.update(resolve(vendor, parent, keys, depth + 1))
        for key in keys:
            raw = prof.get(key)
            if raw is None: continue
            val = _coerce(raw, (schema.get(key) or {}).get('type', ''))
            if val is not None: out[key] = val
        return out

    # Column layout: the key names are written once and each printer's values are a positional row.
    #  Repeating ~20 long key names per set costs several hundred KB — more than the values themselves.
    sets, index, by_vendor = [], {}, {}
    for (vendor, name), prof in sorted(profiles.items()):
        # Abstract "…_common" parents carry no printer_model/variant — they exist only to be inherited
        if not (prof.get('printer_model') or prof.get('printer_variant')): continue
        vals = resolve(vendor, prof, PRINTER_KEYS)
        if not vals: continue
        row = [vals.get(k) for k in PRINTER_KEYS]
        sig = json.dumps(row, sort_keys=True)
        if sig not in index:
            index[sig] = len(sets); sets.append(row)
        nozzle = vals.get('nozzle_diameter')
        nozzle = str(nozzle[0]) if isinstance(nozzle, list) and nozzle else ''
        # model = the profile name minus the nozzle suffix, so the UI can offer model and nozzle separately.
        # default_print_profile is the vendor's recommended process preset — profile metadata, not a setting,
        #  so it rides on the entry rather than in the value row.
        model = re.sub(r'\s+[\d.]+\s*nozzle$', '', name).strip()
        default_preset = prof.get('default_print_profile') or ''
        if not default_preset:      # only the concrete leaf carries it in some vendors; walk the chain
            cur, depth = prof, 0
            while cur is not None and depth < 10 and not default_preset:
                default_preset = cur.get('default_print_profile') or ''
                cur = profiles.get((vendor, cur.get('inherits'))); depth += 1
        by_vendor.setdefault(vendor, {})[name] = [nozzle, index[sig], model, default_preset]
    return {'keys': PRINTER_KEYS, 'sets': sets, 'byVendor': by_vendor}

# ---------------------------------------------------------------- invalidation
def extract_invalidation():
    def parse(path, fn_sig):
        src = read(path)
        i = src.find(fn_sig)
        if i < 0:
            return None
        # Function body: from the first { to the balanced }
        j = src.find('{', i); depth = 0; k = j
        while k < len(src):
            if src[k] == '{': depth += 1
            elif src[k] == '}':
                depth -= 1
                if depth == 0: break
            k += 1
        body = src[j:k]
        base_line = src.count('\n', 0, i) + 1
        # if/else-if chains: the opt_key == "..." values in conditions + the ps*/pos* tokens inside the block
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
        'note': 'An opt_key absent from the conditions (the default branch) invalidates everything. steps are the step tokens referenced in the branch block.'
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
        # local bool variable = condition
        for m in re.finditer(r'\b(?:const\s+)?(?:bool|auto)\s+(\w+)\s*=\s*((?:[^;{]|\{[^}]*\})+);', body):
            if re.search(r'config->|opt_|have_|is_|==|!=|&&|\|\|', m.group(2)):
                rec['locals'][m.group(1)] = ' '.join(m.group(2).split())
        # for (auto el : {"a","b"}) ... toggle_xxx(el, cond)
        for m in re.finditer(r'for \(auto (?:const\s*&?\s*)?(\w+) : \{([^}]*)\}\)\s*(?:\{)?\s*' + call_pat + r'\(\s*\1\s*,\s*([^;]+?)\)\s*;', body):
            keys = re.findall(r'"([^"]+)"', m.group(2))
            rec['rules'].append({'fields': keys, 'enable_if': ' '.join(m.group(4).split()),
                                 'kind': m.group(3), 'line': base + body.count('\n', 0, m.start())})
        # single toggle_xxx("key", cond[, idx])
        for m in re.finditer(call_pat + r'\(\s*"([^"]+)"\s*,\s*((?:[^();]|\([^()]*\))+?)\)\s*;', body):
            rec['rules'].append({'fields': [m.group(2)], 'enable_if': ' '.join(m.group(3).split()),
                                 'kind': m.group(1), 'line': base + body.count('\n', 0, m.start())})
        # count of toggle calls that were not parsed (honesty)
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

    pr = extract_printers(sch)
    json.dump(pr, open(os.path.join(OUT, 'printers.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    nprinters = sum(len(v) for v in pr['byVendor'].values())

    # Emitted as a JS module, not JSON: this one is dynamically imported, and a dynamic JSON import needs
    #  `with { type: 'json' }` in Node while that same attribute makes browsers reject Vite's text/javascript
    #  response. A plain module satisfies both and still code-splits.
    proc = extract_processes(sch)
    with open(os.path.join(OUT, 'processes.js'), 'w', encoding='utf-8') as fh:
        fh.write('// Generated by web/extract_all.py — do not edit. See types/data/processes.js.d.ts.\nexport default ')
        json.dump(proc, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write('\n')

    fil = extract_filaments(sch)          # a JS module for the same reason as processes.js above
    with open(os.path.join(OUT, 'filaments.js'), 'w', encoding='utf-8') as fh:
        fh.write('// Generated by web/extract_all.py — do not edit. See types/data/filaments.js.d.ts.\nexport default ')
        json.dump(fil, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write('\n')

    print(f"ui-tree: {len(ui)} builders, {npages} pages, {nopts} option refs")
    print(f"schema: {len(sch)} options; with enum_values: {sum(1 for o in sch.values() if o.get('enum_values'))}; with tooltip: {sum(1 for o in sch.values() if o.get('tooltip'))}")
    pb = inv['Print'] or []; pob = inv['PrintObject'] or []
    print(f"invalidation: Print {len(pb)} branches / PrintObject {len(pob)} branches")
    print(f"printers: {nprinters} printers across {len(pr['byVendor'])} vendors; {len(pr['sets'])} distinct setting sets")
    print(f"processes: {len(proc['presets'])} presets over {len(proc['keys'])} kernel keys; {len(proc['sets'])} distinct sets; {len(proc['byPrinter'])} printers mapped")
    print(f"filaments: {len(fil['presets'])} presets over {len(fil['keys'])} kernel keys; {len(fil['sets'])} distinct sets; "
          f"{len(fil['byPrinter'])} printers mapped; {len(set(p[2] for p in fil['presets']))} material types; {len(fil['defaultsByModel'])} models with recommendations")
    print(f"toggle: {sum(len(v['rules']) for v in tog.values())} rules across {len(tog)} functions; "
          f"calls in source: {sum(v['stats']['toggle_calls_in_source'] for v in tog.values())}")
