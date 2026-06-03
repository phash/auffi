# Unified "Calm Fresh" Green Design System — Design

**Date:** 2026-06-03
**Status:** Approved (design), pending implementation plan
**Scope:** All four UI surfaces — viewer marketing pages, viewer app, dashboard, sharer desktop webview.

## Context

Since 2026-05-23 (commits `4a323dd` + `b8688f7`) all four surfaces share an
"Engineering-Brief / technical-document" aesthetic: cream `--paper #f5f1e6`,
near-black `--ink #14110d`, a single amber accent `--amber #f3a300`, link/focus
cyan `--cyan #0e4c9c`, **square corners everywhere**, 1.5–2px sharp ink-rules
instead of shadows, mono tracked-caps labels, an amber `▌` heading marker, and
`[01][02]` CSS-counter nav numbering. Reference: `docs/frontend-patterns.md`.

This redesign pivots that system to a **fresh green, cool/sober, card-based,
rounded** look with a prominent hero — while preserving the engineering-brief's
sober anchors (mono eyebrow labels, structural numbering) so it reads "frisch
UND sachlich", not "playful SaaS".

The redesign **recasts visuals only**. Per the established convention, **no class
names or IDs are renamed** — existing Playwright/vitest selectors and snapshots
stay green.

## Decisions (locked with the user)

| Decision | Choice |
|---|---|
| Surfaces | **All 4** (viewer site, viewer app, dashboard, sharer) — shared tokens |
| Palette | **Emerald/Mint, clear** |
| Dark mode | **Auto** (`prefers-color-scheme`), green-tinted, **hand-tuned not a flat invert** |
| Fonts | **Keep IBM Plex** (already self-hosted; DSGVO ok). No new font download |
| Overall character | **Calm Fresh** — lots of whitespace, emerald used sparingly, mint only for subtle gradients/highlights, cards with hairline border + soft hover-shadow |
| Mono eyebrow labels | **Kept** (sober anchor) |
| Amber `▌` marker | **Replaced** with a small emerald rounded bar (≈4px wide, fully rounded ends), not dropped |

## 1. Design tokens

Token **names are preserved**; values are recast. New tokens are added. Legacy
bridges (`--accent`, `--card-bg`, `--bg`, `--text`) are repointed to the new
tokens; `--amber`/`--cyan` remain defined (mapped to emerald / brand-strong) so
any straggler reference still resolves.

### Light
```
--paper        #f6faf8   page background (green-tinted near-white)
--surface      #ffffff   NEW — card / panel background
--ink          #0f1f1a   primary text (deep green-black)
--muted        #5b6b64   NEW — secondary text
--brand        #10b981   emerald — primary accent
--brand-2      #34d399   mint — gradients / subtle highlights only
--brand-strong #047857   emerald-700 — button bg + links (AA on white)
--line         #e3ece8   NEW — hairline borders / dividers
--focus        #10b981   focus rings
```

### Dark (hand-tuned, green-tinted)
```
--paper #0c1714 · --surface #11201c · --ink #e8f1ec · --muted #9fb2aa
--brand #34d399 (mint pops on dark) · --brand-2 #10b981
--brand-strong #34d399 (on dark, used with dark text) · --line #20312b
```

### Shape & depth
```
--radius-card  16px
--radius-input 12px
--radius-pill  999px   (buttons)
--radius-sm    10px
--shadow-sm    soft, low-opacity green-tinted   (resting cards)
--shadow-lift  slightly deeper                  (hover only)
```

### Accessibility
- Primary buttons: `--brand-strong` bg + **white** text → meets WCAG AA (≥4.5:1).
- Raw `--brand` (#10b981) and `--brand-2` (mint) **never** carry small text on
  white; they are for fills, large UI, gradients, borders, icons.
- Links on light: `--brand-strong`. Focus rings: `--brand`, always visible.
- Dark theme contrast verified independently (light text on `--surface`).

## 2. Components

- **Buttons** — pill (`--radius-pill`). Primary: `--brand-strong` bg, white text,
  subtle `--shadow-sm`, lift on hover. Secondary/ghost: 1px `--line` border, ink
  text, transparent bg. Focus ring `--brand`.
- **Cards** — the new workhorse. `--surface` bg, `--radius-card`, 1px `--line`
  border, resting `--shadow-sm`; hover → `--shadow-lift` + 1px translateY. Used
  for feature grids, KPI tiles, download/platform tiles, comparison rows.
- **Hero / Startbereich** — full-width, generous padding, soft `--brand-2 →
  --paper` gradient backdrop. Mono eyebrow → large Plex headline → one emerald
  primary CTA + one ghost → the connect / 9-digit-code rendered as a rounded
  card. Prominent but calm.
- **Section eyebrows & headings** — keep **mono tracked-caps** labels in
  `--muted`. Replace amber `▌` with a small emerald rounded bar (≈4px, fully
  rounded ends) before `h2`.
  `[01][02]` counters kept (optionally in a rounded pill).
- **Inputs** — `--radius-input`, 1px `--line`, emerald focus ring. The code
  input gets larger, friendlier styling.
- **Overlays** — `feedback-fab` and the `matomo-consent` banner recast to
  rounded + emerald, consistent with cards.

## 3. Per-surface application (all consume the same tokens)

- **Viewer marketing pages** — hero treatment; feature/benefit card grid;
  download page = platform cards; comparison page = rounded card rows.
- **Viewer app (connect flow)** — `notch-connect` + code entry become a rounded
  card with an emerald "Verbinden".
- **Dashboard** — KPI tiles → cards; tables/rows rounded; nav numbering kept but
  softened.
- **Sharer (Tauri webview)** — buttons, password-eye fields, monitor picker,
  update banner → rounded + emerald.

## 4. Migration & constraints

- **Token-first**: a single recast token block per surface (`:root` + dark
  `@media`). Names preserved + new tokens added + legacy bridges repointed.
- **No class/ID renames.** Visuals recast only (square→rounded, amber→emerald,
  add card surfaces/shadows). Tests + selectors stay green.
- **Each surface keeps its own copy** (separate nginx containers / no shared
  volume — same situation as the font copies). They must be kept in sync.
- **DSGVO**: nothing new external. Plex already self-hosted; no new fonts, no
  CDN, no trackers, no external CSS.

### Files to touch
- `viewer/src/styles.css` (viewer app + shared tokens)
- `viewer/public/topbar-footer.css`
- `viewer/public/legal/style.css`
- `viewer/public/download/style.css`
- `viewer/public/feedback-fab.css`
- `viewer/public/matomo-consent.css`
- `dashboard/src/styles.css`
- `sharer/index.html` — inline `<style>` block (own token set incl.
  `--text-secondary`); recast tokens there + audit scattered inline
  `style="…"` attributes that reference tokens.
- Marketing-page HTML where the amber `▌`/heading-marker or hero markup needs
  small structural tweaks (no class renames).

## 5. Testing / Definition of Done

- All existing suites stay green (class preservation): viewer, backend,
  dashboard, sharer-js, sharer-lib.
- `tsc --noEmit` passes per package.
- Re-run the **visual-audit Playwright spec** (`viewer/tests/e2e/visual-audit.spec.ts`,
  24 screenshots × light/dark/mobile + flows); review the PNGs each pass.
- Contrast AA verified on all accent/text combinations (light + dark).
- Manual smoke per surface (viewer site, viewer connect flow, dashboard,
  sharer window).

## Non-goals

- No class/ID renames; no behavioural/feature changes.
- No font swap (Plex stays).
- Not addressing the pre-existing `style-src 'self'` inline-style CSP violations
  (separate issue; out of scope here).
- Standalone-mode Caddy/CSP changes unrelated to styling are out of scope.

## Open questions

None — all decisions locked above.
