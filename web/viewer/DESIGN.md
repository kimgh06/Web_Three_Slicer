# Web Three Slicer Viewer Design System

## 1. Atmosphere & Identity

The viewer landing page feels like a quiet engineering console: dark, precise, and ready to open the real slicer. The signature is a compact package cockpit where npm, source, demo, and usage routes are visible before the heavy WebGL/WASM slicer shell loads.

## 2. Color

### Palette

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Surface/primary | `--lp-bg` | `#0e1216` | Landing page background |
| Surface/secondary | `--lp-panel` | `#141a20` | Link and code panels |
| Surface/elevated | `--lp-panel-strong` | `#1a2027` | Buttons and emphasized panels |
| Surface/hover | `--lp-panel-hover` | `#222a33` | Hovered secondary buttons |
| Text/primary | `--lp-text` | `#e9f1f7` | Main headings |
| Text/body | `--lp-body` | `#c2ced8` | Body and feature text |
| Text/muted | `--lp-muted` | `#8d9daa` | Supporting copy |
| Text/subtle | `--lp-subtle` | `#626e79` | Footer and labels |
| Text/on-accent | `--lp-on-accent` | `#ffffff` | Text on primary green |
| Text/code | `--lp-code` | `#9fe3bd` | Commands and import paths |
| Border/default | `--lp-border` | `#2c353d` | Buttons and panels |
| Border/subtle | `--lp-border-subtle` | `#191f25` | Row dividers |
| Border/dot | `--lp-dot` | `#4a555f` | Inline feature separators |
| Accent/primary | `--lp-accent` | `#00ae42` | Primary CTA, badges, links |
| Accent/hover | `--lp-accent-hover` | `#039b3c` | Primary hover |
| Accent/soft | `--lp-accent-soft` | `#143121` | Muted accent background |

### Rules

- Accent green is reserved for primary actions, active links, and package identity.
- Dark surfaces separate by tonal shift first, then subtle borders.
- Do not introduce decorative gradients; this page should read as a tool surface, not a marketing splash.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
| --- | --- | --- | --- | --- |
| Display | `34px` | 700 | 1.16 | 0 | Landing title |
| H2 | `18px` | 700 | 1.35 | 0 | Section headings |
| H3 | `14px` | 700 | 1.4 | 0 | Package card headings |
| Body | `15px` | 400 | 1.7 | 0 | Main prose |
| Body/sm | `14px` | 400 | 1.55 | 0 | Feature rows and cards |
| Caption | `12.5px` | 600 | 1.4 | 0 | Labels and metadata |
| Mono | `13px` | 500 | 1.55 | 0 | Import paths and commands |

### Font Stack

- Primary: `system-ui, -apple-system, "Segoe UI", sans-serif`
- Mono: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

### Rules

- Korean copy must avoid one-character orphan lines at mobile widths.
- README/API snippets use mono text inside constrained, wrapping-safe code blocks.

## 4. Spacing & Layout

### Base Unit

All spacing derives from a base of 4px.

| Token | Value | Usage |
| --- | --- | --- |
| `--space-2` | `8px` | Tight inline groups |
| `--space-3` | `12px` | Button/card compact padding |
| `--space-4` | `16px` | Row and card spacing |
| `--space-5` | `20px` | Card inner padding |
| `--space-6` | `24px` | Section gutters |
| `--space-8` | `32px` | Group gaps |
| `--space-12` | `48px` | Major section breaks |
| `--space-16` | `64px` | Landing block separation |
| `--space-24` | `96px` | Desktop top offset |

### Grid

- Max content width: `920px`.
- Primary layout: single-column stack with compact two-column grids for package routes and import paths.
- Breakpoints: mobile below `640px`, compact desktop above `760px`.

### Rules

- The landing page owns document scrolling; `/slice` owns the absolute WebGL app shell.
- Use responsive CSS mechanics such as `minmax(min(...), 1fr)` for package grids.

## 5. Components

### Link Button

- **Structure**: `<a>` or router `<Link>` with `.lp-btn`.
- **Variants**: primary, secondary.
- **Spacing**: `--space-3` vertical, `--space-5` horizontal.
- **States**: hover darkens tonal surface; focus-visible uses accent outline.
- **Accessibility**: text labels must name the destination.
- **Motion**: color and transform transition at 140ms.
- **Layout**: cluster.

### Section Block

- **Structure**: heading, optional short body, then grid/list content.
- **Spacing**: `--space-12` between blocks, `--space-4` inside compact blocks.
- **States**: static.
- **Accessibility**: headings preserve document order.
- **Motion**: none.
- **Layout**: stack.

### Package Route Card

- **Structure**: title, description, code path.
- **Variants**: normal, emphasized.
- **Spacing**: `--space-5`.
- **States**: hover border shifts to accent for linked cards only.
- **Accessibility**: no card-only click areas unless the card is an anchor.
- **Motion**: hover uses transform and border color only.
- **Layout**: responsive grid.

### Feature Row

- **Structure**: `<dt>` label plus `<dd>` inline feature chips.
- **Spacing**: `--space-4` vertical row rhythm.
- **States**: static.
- **Accessibility**: native description list semantics.
- **Motion**: none.
- **Layout**: sidebar row that collapses to stack on mobile.

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
| --- | --- | --- | --- |
| Micro | `140ms` | `ease-out` | Link buttons and cards |

Rules:

- Only animate `transform`, `background-color`, `border-color`, and `color`.
- Respect `prefers-reduced-motion` by disabling transforms.
- Do not add decorative idle animations.

## 7. Depth & Surface

### Strategy

Mixed tonal-shift and subtle borders.

| Level | Value | Usage |
| --- | --- | --- |
| Subtle border | `1px solid var(--lp-border-subtle)` | Feature row dividers |
| Default border | `1px solid var(--lp-border)` | Buttons, cards |
| Soft panel | `var(--lp-panel)` | Content blocks |
| Strong panel | `var(--lp-panel-strong)` | Primary interactive surfaces |

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA.
- Every link/button has a visible focus state.
- Keyboard users can reach the slicer CTA, npm, GitHub, and demo links.
- Responsive layout must fit at 375px without horizontal page scroll.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
| --- | --- | --- | --- |
| None | N/A | N/A | N/A |
