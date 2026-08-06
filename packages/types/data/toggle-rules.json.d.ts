// three-slicer/data/toggle-rules.json — enable_if expressions extracted from upstream toggle_options().
// Top-level key = group name (e.g. 'toggle_print_fff_options', 'TabPrinter::toggle_options').

export interface ToggleRule {
  /** The raw C++ expression string. Evaluated by evalEnableIf in three-slicer/toggle. */
  enable_if?: string
  /** The config-schema keys governed by this condition */
  fields?: string[]
  line?: number
}

export interface ToggleGroup {
  /** Local variable name -> the upstream C++ expression (string). Translation is hardcoded in toggle_eval.js. */
  locals: Record<string, string>
  rules: ToggleRule[]
  stats?: { toggle_calls_in_source: number; rules_extracted: number }
}

declare const toggles: Record<string, ToggleGroup>
export default toggles
