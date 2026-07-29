// 25단계 S5.1: toggle-rules 부분 번역 — 원본 C++ toggle_options 조건식(enable_if) → JS.
//  범위: 뷰어가 다루는 키에 관련된 규칙 중, 아래 하드코딩 로컬로 "완전히" 번역 가능한 것만 적용.
//  번역 불가(모르는 로컬/enum 비교 등)는 fail-open(활성 유지) — 잘못된 비활성 방지(정직한 부분 구현).
//  전체 907키·231규칙 완역은 범위 외(README 기록). 참조: toggle-rules.json 의 toggle_print_fff_options.locals.
import toggles from '@three-slicer/data/toggle-rules.json'
import schema from '@three-slicer/data/config-schema.json'

// 설정값 접근기 (settings 맵 우선, 없으면 스키마 default). 퍼센트("15%")는 숫자로.
export function makeCfg(settings) {
  const val = k => {
    let v = settings ? settings[k] : undefined
    if (v === undefined || v === '') { const d = schema[k]?.default; v = Array.isArray(d) ? d[0] : d }
    return v
  }
  const num = k => { const v = val(k); const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
  return {
    bool: k => { const v = val(k); return v === true || v === 1 || v === '1' || v === 'true' },
    int: k => Math.trunc(num(k)),
    float: k => num(k),
    has: k => k in schema,
  }
}

// 원본 locals 를 인라인 번역(뷰어 관련 조건만). 각 값은 boolean.
function makeLocals(cfg) {
  const have_raft = cfg.int('raft_layers') > 0
  const has_spiral_vase = cfg.bool('spiral_mode')
  const has_top_shell = cfg.int('top_shell_layers') > 0 || (has_spiral_vase && cfg.int('bottom_shell_layers') > 1)
  const has_bottom_shell = cfg.int('bottom_shell_layers') > 0
  return {
    have_raft,
    have_perimeters: cfg.int('wall_loops') > 0,
    have_infill: cfg.float('sparse_infill_density') > 0,
    has_spiral_vase,
    has_top_shell,
    has_bottom_shell,
    has_solid_infill: has_top_shell || has_bottom_shell,
    have_skirt: cfg.int('skirt_loops') > 0,
    have_support_material: cfg.bool('enable_support') || have_raft,
    have_support_interface: cfg.int('support_interface_top_layers') > 0 || cfg.int('support_interface_bottom_layers') > 0,
    have_prime_tower: cfg.bool('enable_prime_tower'),
  }
}

// enable_if(첫 콤마부) 를 boolean 으로 평가. 완전 번역 불가하면 null(=활성 유지).
export function evalEnableIf(expr, locals, cfg) {
  let s = String(expr).split(',')[0].trim()
  if (!s) return null
  // 직접 config 접근 패턴 → 값 치환
  s = s.replace(/config->opt_bool\(\s*"([^"]+)"\s*\)/g, (_, k) => cfg.bool(k) ? 'true' : 'false')
  s = s.replace(/config->opt_int\(\s*"([^"]+)"\s*\)/g, (_, k) => String(cfg.int(k)))
  s = s.replace(/config->opt_float\(\s*"([^"]+)"\s*\)/g, (_, k) => String(cfg.float(k)))
  // 알려진 로컬 치환(긴 이름 먼저 — 부분매칭 방지)
  for (const name of Object.keys(locals).sort((a, b) => b.length - a.length))
    s = s.replace(new RegExp('\\b' + name + '\\b', 'g'), locals[name] ? 'true' : 'false')
  // 남은 문자열이 안전한 boolean 식인지(true/false/숫자/연산자/괄호만) — 아니면 미지 → null
  const stripped = s.replace(/\btrue\b|\bfalse\b/g, '1')
  if (!/^[\s()!<>=&|0-9.]*$/.test(stripped)) return null
  try { return !!Function('"use strict";return (' + s + ')')() } catch { return null }
}

// 현재 설정에서 비활성 키 맵 { key: 조건식 }. 조건이 명확히 false 인 규칙만.
export function disabledKeys(cfg) {
  const locals = makeLocals(cfg)
  const groups = ['toggle_print_fff_options', 'toggle_filament_options', 'toggle_printer_options',
    'TabFilament::toggle_options', 'TabPrinter::toggle_options']
  const out = {}
  for (const gname of groups) {
    const g = toggles[gname]
    if (!g || !Array.isArray(g.rules)) continue
    for (const rule of g.rules) {
      if (!rule.enable_if || !Array.isArray(rule.fields)) continue
      const en = evalEnableIf(rule.enable_if, locals, cfg)
      if (en === false) for (const k of rule.fields) if (!(k in out)) out[k] = rule.enable_if
    }
  }
  return out
}
