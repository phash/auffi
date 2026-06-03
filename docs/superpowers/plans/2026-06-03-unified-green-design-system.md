# Unified "Calm Fresh" Green Design System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recast all four UI surfaces (viewer site, viewer app, dashboard, sharer) from the amber engineering-brief look to a fresh emerald/mint, card-based, rounded "Calm Fresh" system with a prominent hero — without renaming any class/ID.

**Architecture:** Token-first. One canonical token contract (light + hand-tuned dark) is applied into each surface's own CSS (separate copies, kept in sync). Visuals are recast (square→rounded, amber→emerald, add card surfaces + soft shadows); selectors and markup structure are preserved so existing suites stay green. A new contrast unit test pins the accessibility decision permanently.

**Tech Stack:** Vanilla CSS custom properties, IBM Plex (already self-hosted), Vite + TypeScript (viewer/dashboard/sharer), Vitest (unit), Playwright (visual audit), Tauri webview (sharer).

**Spec:** `docs/superpowers/specs/2026-06-03-unified-green-design-system-design.md`

---

## Conventions for this plan (read first)

- **"TDD" for CSS recasting** = regression gates, not new unit tests per file. After each surface: (a) the surface's unit suite stays green (class preservation guarantees this), (b) `npx tsc --noEmit` passes, (c) `npm run build` succeeds, (d) dev-server visual smoke. The one genuinely unit-testable invariant — palette contrast — is pinned in Task 1.
- **No class/ID renames.** Recast values only. If a selector must change, stop and reconsider.
- **Each surface keeps its own copy** of tokens; the canonical blocks below are the single source of truth — paste identical values into each surface.
- **DSGVO:** no new external resources. Do not add fonts/CDNs/trackers.
- Commit after every task with a Conventional Commit message ending in the repo's `Co-Authored-By` trailer.

## Canonical token contract (single source of truth — paste into each surface)

**Light `:root` (must appear before the dark block):**
```css
:root {
  --paper: #f6faf8;
  --surface: #ffffff;
  --ink: #0f1f1a;
  --muted: #5b6b64;
  --brand: #10b981;
  --brand-2: #34d399;
  --brand-strong: #047857;
  --line: #e3ece8;
  --focus: #10b981;

  --radius-card: 16px;
  --radius-input: 12px;
  --radius-pill: 999px;
  --radius-sm: 10px;
  --shadow-sm: 0 1px 2px rgba(15, 31, 26, 0.05), 0 2px 8px rgba(16, 185, 129, 0.06);
  --shadow-lift: 0 4px 12px rgba(15, 31, 26, 0.08), 0 8px 24px rgba(16, 185, 129, 0.10);

  /* Legacy bridges — keep old class users working */
  --bg: var(--paper);
  --text: var(--ink);
  --card-bg: var(--surface);
  --accent: var(--brand-strong);
  --amber: var(--brand-strong);
  --cyan: var(--brand-strong);
}
```

**Dark block (append after light):**
```css
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0c1714;
    --surface: #11201c;
    --ink: #e8f1ec;
    --muted: #9fb2aa;
    --brand: #34d399;
    --brand-2: #10b981;
    --brand-strong: #34d399;
    --line: #20312b;
    --focus: #34d399;
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-lift: 0 6px 20px rgba(0, 0, 0, 0.5);
  }
}
```
Note: in dark, `--brand-strong` (#34d399) is light, so any element using it as a **background** must pair it with dark text (`--ink` is light → use `#06231b` for on-brand text in dark; see button recipe).

## Canonical component recipes (paste/adapt per surface)

**Buttons (pill):**
```css
.btn, button.primary, .btn-primary {
  border-radius: var(--radius-pill);
  background: var(--brand-strong);
  color: #ffffff;
  border: none;
  box-shadow: var(--shadow-sm);
  transition: transform .12s ease, box-shadow .12s ease, background .12s ease;
}
.btn:hover, button.primary:hover, .btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-lift);
}
.btn-secondary, .btn.ghost {
  background: transparent; color: var(--ink);
  border: 1px solid var(--line); border-radius: var(--radius-pill);
}
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  .btn, button.primary, .btn-primary { color: #06231b; }
}
```

**Card:**
```css
.card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-sm);
  transition: transform .14s ease, box-shadow .14s ease;
}
.card:hover { transform: translateY(-1px); box-shadow: var(--shadow-lift); }
```

**Heading marker (replaces amber `▌`):**
```css
h2::before {
  content: "";
  display: inline-block;
  width: 4px; height: 1em;
  margin-right: .5em;
  vertical-align: -0.12em;
  border-radius: var(--radius-pill);
  background: var(--brand);
}
```

**Mono eyebrow label (keep — sober anchor):**
```css
.eyebrow, .section-label {
  font-family: "IBM Plex Mono", monospace;
  text-transform: uppercase;
  letter-spacing: .12em;
  font-size: .75rem;
  color: var(--muted);
}
```

**Inputs:**
```css
input, select, textarea {
  border-radius: var(--radius-input);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink);
}
input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--focus); outline-offset: 1px; border-color: var(--brand);
}
```

**Hero / Startbereich:**
```css
.hero {
  background: linear-gradient(180deg, color-mix(in srgb, var(--brand-2) 16%, var(--paper)) 0%, var(--paper) 70%);
  border-radius: var(--radius-card);
  padding: clamp(2rem, 6vw, 5rem);
  text-align: center;
}
.hero h1 { font-size: clamp(2rem, 5vw, 3.25rem); line-height: 1.08; letter-spacing: -0.01em; }
```

---

## Phase 0 — Token contract + accessibility guard

### Task 1: Contrast guard test + canonical tokens in the viewer

**Files:**
- Create: `viewer/tests/design-tokens.test.ts`
- Modify: `viewer/src/styles.css` (`:root` token block + dark `@media`)

- [ ] **Step 1: Write the failing test**

```ts
// viewer/tests/design-tokens.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  fileURLToPath(new URL("../src/styles.css", import.meta.url)),
  "utf8",
);

function token(name: string): string {
  const m = css.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`));
  if (!m) throw new Error(`token ${name} not found in styles.css`);
  return m[1];
}
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const lin = [0, 2, 4]
    .map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const ls = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (ls[0] + 0.05) / (ls[1] + 0.05);
}

describe("design tokens", () => {
  it("defines the emerald/mint palette", () => {
    expect(token("--brand")).toBe("#10b981");
    expect(token("--brand-strong")).toBe("#047857");
  });
  it("primary button (brand-strong bg + white text) meets WCAG AA", () => {
    expect(contrast(token("--brand-strong"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
  it("body text (ink on paper) meets WCAG AA", () => {
    expect(contrast(token("--ink"), token("--paper"))).toBeGreaterThanOrEqual(4.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd viewer && npx vitest run tests/design-tokens.test.ts`
Expected: FAIL — `token --brand not found` (styles.css still has amber tokens).

- [ ] **Step 3: Replace the viewer `:root` token block with the canonical light block**

In `viewer/src/styles.css`, replace the existing `:root { … }` (the amber/paper block) with the **canonical light `:root`** from the contract above. Keep it as the first `:root` in the file.

- [ ] **Step 4: Add / replace the dark block**

Replace the existing `@media (prefers-color-scheme: dark)` `:root` overrides with the **canonical dark block** above.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd viewer && npx vitest run tests/design-tokens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
cd viewer && npx tsc --noEmit
git add viewer/tests/design-tokens.test.ts viewer/src/styles.css
git commit -m "feat(design): emerald/mint tokens + WCAG contrast guard (viewer)"
```

---

## Phase 1 — Viewer (site + app)

### Task 2: Recast viewer app components (`viewer/src/styles.css`)

**Files:** Modify `viewer/src/styles.css`

- [ ] **Step 1: Read the file** and list every selector currently using square radius (`border-radius: 0`/none), `--amber`/`--cyan`, sharp ink-rules (`border: 1.5px`/`2px solid var(--ink)`), and the `h2::before { content: "▌ " }` marker.
- [ ] **Step 2: Apply component recipes.** Add/merge the **Card, Button, Heading-marker, Eyebrow, Input, Hero** recipes from the contract. Convert square corners to the radius tokens; swap accent usages to `--brand`/`--brand-strong`; replace sharp ink-rule separators with 1px `--line` + (where it was a panel) a `.card` surface. Style the connect/`notch-connect` + code input as a rounded card with an emerald primary "Verbinden".
- [ ] **Step 3: Run the viewer unit suite (regression gate)**

Run: `cd viewer && npm test`
Expected: PASS, **219 tests** (216 baseline + Task 1's 3 token tests; must not drop).

- [ ] **Step 4: Typecheck + build**

Run: `cd viewer && npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 5: Visual smoke**

Run `cd viewer && npm run dev`, open `http://localhost:5173`, verify: rounded cards, emerald primary button, hero gradient, emerald heading marker, focus rings visible. Toggle OS dark mode and re-check.

- [ ] **Step 6: Commit**

```bash
git add viewer/src/styles.css
git commit -m "feat(design): recast viewer app to Calm Fresh cards + hero"
```

### Task 3: Recast shared topbar/footer (`viewer/public/topbar-footer.css`)

**Files:** Modify `viewer/public/topbar-footer.css`

- [ ] **Step 1: Read the file.** Replace its `:root` token block (if present) with the canonical light + dark blocks (keep in sync with Task 1).
- [ ] **Step 2:** Recast topbar/footer: rounded buttons/links, `--brand` accents, 1px `--line` separators instead of sharp rules, pill CTA.
- [ ] **Step 3: Regression + build**

Run: `cd viewer && npm test && npx tsc --noEmit && npm run build`
Expected: PASS (219) + build ok.

- [ ] **Step 4: Commit**

```bash
git add viewer/public/topbar-footer.css
git commit -m "feat(design): recast topbar/footer to emerald + rounded"
```

### Task 4: Recast marketing-page CSS (`legal/style.css`, `download/style.css`)

**Files:** Modify `viewer/public/legal/style.css`, `viewer/public/download/style.css`

- [ ] **Step 1: Read both files.** Sync their `:root` token blocks to the canonical blocks.
- [ ] **Step 2:** Legal pages: rounded content cards, emerald links (`--brand-strong`), emerald heading marker. Download page: each platform becomes a `.card` (rounded, hairline, hover lift) in a responsive grid.
- [ ] **Step 3: Build smoke**

Run: `cd viewer && npm run build` then `npm run dev` and check `/download/`, `/impressum/`, `/datenschutz/`.
Expected: rounded platform cards, consistent palette.

- [ ] **Step 4: Commit**

```bash
git add viewer/public/legal/style.css viewer/public/download/style.css
git commit -m "feat(design): recast legal + download pages to cards"
```

### Task 5: Recast overlays (`feedback-fab.css`, `matomo-consent.css`)

**Files:** Modify `viewer/public/feedback-fab.css`, `viewer/public/matomo-consent.css`

- [ ] **Step 1: Read both.** Sync `:root` tokens. Recast the FAB to a rounded pill/`--radius-pill` with `--brand-strong`; the consent banner to rounded corners, `--surface` bg, `--brand-strong` "Statistik OK" button, ghost "Ablehnen".
- [ ] **Step 2:** Confirm no class/ID changed (the consent JS in `matomo-consent.js` references `.matomo-consent-*` classes — keep them).
- [ ] **Step 3: Regression + build**

Run: `cd viewer && npm test && npm run build`
Expected: PASS (219) + build ok. (CSS changes don't affect CSP inline-script hashes.)

- [ ] **Step 4: Commit**

```bash
git add viewer/public/feedback-fab.css viewer/public/matomo-consent.css
git commit -m "feat(design): recast FAB + consent banner to rounded emerald"
```

### Task 6: Hero + heading-marker HTML tweaks (marketing pages)

**Files:** Modify `viewer/index.html`, `viewer/en/index.html`, and any marketing page needing hero structure (no class/ID renames; **do not touch the inline `<script type="application/ld+json">` blocks** — that would change CSP hashes).

- [ ] **Step 1: Read `viewer/index.html`.** Identify the hero/start section. Add the `.hero` wrapper structure (eyebrow → h1 → CTA row → connect card) using existing classes where possible; only add new classes, never rename.
- [ ] **Step 2:** Mirror the same structural tweak in `viewer/en/index.html`.
- [ ] **Step 3: Verify CSP hashes unchanged**

Run:
```bash
cd /home/manuel/claude/screenshare && python3 -c "import re,hashlib,base64,glob; files=['viewer/index.html','viewer/en/index.html']+sorted(glob.glob('viewer/public/**/index.html',recursive=True)); print('\n'.join(sorted({'sha256-'+base64.b64encode(hashlib.sha256(m.encode()).digest()).decode() for f in files for m in re.findall(r'<script(?:\\s[^>]*)?>(.*?)</script>', open(f).read(), re.DOTALL) if m.strip() and 'src=' not in m[:60]})))"
```
Expected: the **same 14 hashes** as currently in `caddy/Caddyfile`. If any changed, an inline JSON-LD block was accidentally edited — revert that part. (If hero copy genuinely must change inline JSON-LD later, the cluster Caddyfile + repo Caddyfile both need the new hash — see `docs/footguns.md` § Cluster-Ops.)

- [ ] **Step 4: Regression + build + smoke**

Run: `cd viewer && npm test && npm run build && npm run dev` → check hero on `/` and `/en/`.
Expected: PASS (219), prominent rounded hero.

- [ ] **Step 5: Commit**

```bash
git add viewer/index.html viewer/en/index.html
git commit -m "feat(design): prominent rounded hero on de + en home"
```

---

## Phase 2 — Dashboard

### Task 7: Recast dashboard (`dashboard/src/styles.css`)

**Files:** Modify `dashboard/src/styles.css`

- [ ] **Step 1: Read the file.** Replace its `:root` + dark blocks with the canonical blocks (dashboard has its own font copy — fonts unchanged).
- [ ] **Step 2:** KPI tiles → `.card`; admin tables/rows rounded (`--radius-sm`), hairline `--line` separators; nav `[01][02]` counters kept but in a rounded pill; buttons → pill emerald; reuse Card/Button/Input/Eyebrow recipes.
- [ ] **Step 3: Regression**

Run: `cd dashboard && npm test`
Expected: PASS, **122 tests** (baseline; must not drop).

- [ ] **Step 4: Typecheck + build + smoke**

Run: `cd dashboard && npx tsc --noEmit && npm run build && npm run dev` → open `http://localhost:5174`, check login/signup + an admin view if reachable.
Expected: all succeed; cards rounded, emerald accents.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/styles.css
git commit -m "feat(design): recast dashboard to Calm Fresh cards + emerald"
```

---

## Phase 3 — Sharer (Tauri webview)

### Task 8: Recast sharer styles (`sharer/index.html` inline `<style>`)

**Files:** Modify `sharer/index.html` (the `<style>` block starting ~line 6; audit scattered inline `style="…"` attributes that reference tokens like `--text-secondary`).

- [ ] **Step 1: Read the `<style>` block.** Map the sharer's own token names (e.g. `--text-secondary`, accent, bg) to the canonical palette: set bg→`--paper`, panels→`--surface`, text→`--ink`, secondary→`--muted`, accent→`--brand`/`--brand-strong`. Add the radius/shadow tokens.
- [ ] **Step 2:** Recast: buttons → pill emerald; the password-eye fields, monitor picker, and update banner → rounded `--radius-input`/`--radius-card`; sharp rules → 1px `--line`. Update the scattered inline `style="…color: var(--text-secondary)…"` only if the token was renamed (prefer keeping `--text-secondary` defined as an alias of `--muted` to avoid touching every inline attribute).
- [ ] **Step 3: Regression**

Run: `cd sharer && npm test`
Expected: PASS, **34 tests** (sharer-js baseline; must not drop).

- [ ] **Step 4: Typecheck + build**

Run: `cd sharer && npx tsc --noEmit && npm run build`
Expected: both succeed. (Rust unaffected; no `cargo` change needed, but `cd sharer/src-tauri && cargo check` should still pass.)

- [ ] **Step 5: Manual smoke (host with display)**

Run: `cd sharer && npm run tauri:dev`. Verify the window: rounded panels/buttons, emerald accents, password-eye toggle, monitor picker, update banner, light + dark.

- [ ] **Step 6: Commit**

```bash
git add sharer/index.html
git commit -m "feat(design): recast sharer webview to Calm Fresh emerald"
```

---

## Phase 4 — Cross-surface verification

### Task 9: Full verification pass

**Files:** none (verification); update screenshot baselines only if intentionally changed.

- [ ] **Step 1: All unit suites green**

```bash
cd viewer && npm test          # expect 219 (216 baseline + 3 token tests)
cd ../dashboard && npm test    # expect 122
cd ../sharer && npm test       # expect 34
cd ../backend && npm test      # expect 395 (unchanged — sanity)
```

- [ ] **Step 2: All typechecks**

```bash
for d in viewer dashboard sharer; do (cd $d && npx tsc --noEmit) || echo "FAIL $d"; done
```
Expected: no FAIL lines.

- [ ] **Step 3: Contrast guard still green** — already covered by viewer suite (Task 1). Confirm no token drift across surfaces by eyeballing the `:root` blocks match the canonical values in all of: `viewer/src/styles.css`, `viewer/public/topbar-footer.css`, `viewer/public/legal/style.css`, `viewer/public/download/style.css`, `viewer/public/feedback-fab.css`, `viewer/public/matomo-consent.css`, `dashboard/src/styles.css`, `sharer/index.html`.

- [ ] **Step 4: Local screenshots (optional but recommended)** — run each dev server and capture light/dark with a short Playwright script against `localhost`, or set `VIEWER_URL=http://localhost:5173` and run the e2e suite. Review the images for consistency (same green, same radii, same card style across surfaces).

- [ ] **Step 5: Manual smoke checklist** — viewer home + connect flow, a legal page, download page, dashboard login, sharer window. Confirm one coherent system.

- [ ] **Step 6: Final commit (if any baseline/cleanup)**

```bash
git add -A && git commit -m "test(design): cross-surface verification + screenshot baselines"
```

- [ ] **Step 7: Deploy (separate, when ready)** — `./ops/deploy.sh` ships viewer/dashboard dist. Then run the prod visual-audit: `cd viewer && npx playwright test tests/e2e/visual-audit.spec.ts --workers=1` and review `/tmp/visual-audit/`. The sharer ships via its own release process (`docs/ops-runbook.md`), not the web deploy. **Note:** any CSS-only change is served by the cluster nginx sidecars (no Caddy edit needed); the cluster-Caddy hand-edit from `docs/footguns.md` § Cluster-Ops is only required if an inline-script hash changes.

---

## Self-review notes

- **Spec coverage:** tokens (Task 1), buttons/cards/hero/eyebrow/inputs/overlays (Tasks 2–5), per-surface viewer/dashboard/sharer (Tasks 2–8), hero (Task 6), dark mode (Task 1 dark block + per-surface), accessibility (Task 1 contrast test), testing/DoD (Task 9). All spec sections mapped.
- **Class preservation:** enforced by the regression-gate steps (216/122/34 must not drop) in every task.
- **CSP safety:** Task 6 Step 3 explicitly re-verifies the 14 inline-script hashes are unchanged.
- **Token consistency:** Task 9 Step 3 cross-checks identical `:root` values across all 8 files.
