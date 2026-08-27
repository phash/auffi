# GEO + SEO Content Push — Design

**Date:** 2026-06-23
**Status:** Approved design → ready for implementation plan
**Author:** brainstormed with Phash / Manuel

## Problem & Motivation

Google Search Console (set up 2026-06-08, ~2 weeks of data) shows Auffi is **already
indexed and ranking** for its money-keyword cluster but converting **zero impressions
into clicks**:

| Query | Impressions | Clicks |
|---|---|---|
| `auffi` | 38 | 0 |
| `teamviewer alternative` | 8 | 0 |
| `teamviewer alternative software` | 2 | 0 |
| `alternative teamviewer` | 1 | 0 |
| `anydesk open source alternative` | 1 | 0 |
| `teamviewer alternative kommerziell` | 1 | 0 |
| `alternative zu teamviewer` | 1 | 0 |
| `teamviewer similar software` | 1 | 0 |

Reading of the data:

1. **The site ranks for the right queries** but at a position/snippet that wins no
   clicks. Position is mostly an **off-page authority** problem (directory listings,
   backlinks) — not a code change, flagged as out-of-scope below.
2. **`auffi` 0-click is partly noise**: "auffi" is Bavarian dialect ("up/upward"), so a
   chunk of those brand impressions are not product searches. Do not over-read it.
3. **The data reveals concrete intent gaps with no dedicated landing page yet**:
   - `teamviewer alternative kommerziell` → the TeamViewer "commercial-use detected"
     lockout — Auffi's single sharpest wedge, no page for it.
   - `anydesk open source alternative` / `teamviewer similar software` → open-source /
     RustDesk-class intent, no RustDesk page yet.

The technical-SEO foundation is mature (full schema.org, hreflang de/en + x-default,
`llms.txt`, AI-crawler allowlist in `robots.txt`, IndexNow auto-ping, cookieless Matomo).
So the code-side levers are **(a) new high-intent landing pages**, **(b) making every page
maximally quotable by AI engines (GEO)**, and **(c) winning more clicks at the current
rank via snippet tuning** — not re-plumbing infrastructure.

## Goals

- Add four new high-intent landing pages (DE + EN each) targeting the gaps above.
- Strengthen Generative-Engine-Optimization so ChatGPT / Perplexity / Google AI
  Overviews / Gemini cite Auffi for "free/open-source/GDPR TeamViewer alternative"
  questions (incl. the commercial-use angle).
- Reinforce geographic/DACH signals (DE/Frankfurt hosting, DSGVO) on the new surface.
- Tune existing-page snippets for click-through.
- Keep the strict CSP + inline-JSON-LD model and add an automated guard test so the
  documented 2026-05-29 CSP-hash outage cannot recur silently.

## Non-Goals (flagged, not done in code)

- **Off-page authority** — Capterra.de / G2 / AlternativeTo / OMR listings + backlinks.
  This is the real ranking-position lever but is not a repo change. Recommended as the
  immediate next step after this push ships. (It also unlocks the `aggregateRating`
  the `SoftwareApplication` rich-result wants.)
- No new OG images per page (single `/og-image.png` reused — acceptable for brand
  consistency).
- No blog/RSS section.
- No macOS-sharer claims (Linux + Windows only, per project scope).

## Page Inventory & Conventions (reference)

All marketing pages are standalone static HTML under `viewer/public/<path>/index.html`
(plus the two app homepages `viewer/index.html` and `viewer/en/index.html`). They share:

- topbar (`#top-bar`) + footer (`#site-footer`), `/topbar-footer.css`, `/legal/style.css`
- preloaded IBM Plex woff2 fonts
- `/matomo-consent.{css,js}` + `/help-overlay.js` (defer)
- inline `<style>` with the `.vs-*` comparison-table classes
- inline `<script type="application/ld+json">` blocks (Breadcrumb + FAQPage etc.)
- full meta: title, description, `robots`, canonical, hreflang de/en/x-default,
  OG, Twitter, theme-color (dark/light)

The canonical template to clone is `viewer/public/vergleich/teamviewer/index.html`.

## A. New Pages (4 × DE/EN = 8 files)

x-default always points to the DE URL. Each page reciprocal-links its EN/DE twin via
`hreflang`, and the topbar `#lang-switch` points at the twin URL.

### A1. TeamViewer kommerzielle Nutzung (problem→solution page)

- **DE:** `viewer/public/vergleich/teamviewer-kommerzielle-nutzung/index.html`
  → `https://auffi.app/vergleich/teamviewer-kommerzielle-nutzung/`
- **EN:** `viewer/public/en/compare/teamviewer-commercial-use/index.html`
  → `https://auffi.app/en/compare/teamviewer-commercial-use/`
- **Targets:** "teamviewer alternative kommerziell", "teamviewer kommerzielle nutzung
  erkannt/vermutet", "teamviewer gewerblich kostenlos", "teamviewer commercial use
  free alternative".
- **Schema:** BreadcrumbList + FAQPage.
- **Title (DE):** `TeamViewer kommerzielle Nutzung erkannt? Kostenlose Alternative — Auffi`
- **Title (EN):** `TeamViewer "commercial use" blocked? Free alternative — Auffi`
- **Content sections:**
  1. Lead: what the "kommerzielle Nutzung vermutet / Sitzung beendet" message is, why
     TeamViewer's heuristics trigger it (free tier = private only).
  2. The honest fix options (buy a TeamViewer license vs. switch to a free tool).
  3. Why Auffi removes the problem: free for **private AND commercial** use, AGPL-3.0,
     no usage limit, no license check, server in Germany.
  4. Short comparison table (Preis privat/gewerblich, Lizenz, Lockout-Risiko, Server).
  5. "Wann TeamViewer trotzdem sinnvoll ist" (honesty: enterprise features / SLA).
  6. FAQ (visible + JSON-LD, byte-synced).
  7. CTA: try Auffi + link to the full `/vergleich/teamviewer/` page.

### A2. RustDesk (head-to-head)

- **DE:** `viewer/public/vergleich/rustdesk/index.html` → `/vergleich/rustdesk/`
- **EN:** `viewer/public/en/compare/rustdesk/index.html` → `/en/compare/rustdesk/`
- **Targets:** "anydesk open source alternative", "open source teamviewer alternative",
  "rustdesk alternative", "rustdesk vs auffi".
- **Schema:** BreadcrumbList + FAQPage.
- **Title (DE):** `Auffi vs RustDesk — Open-Source-Fernwartung im Vergleich`
- **Title (EN):** `Auffi vs RustDesk — open-source remote support compared`
- **Honest framing:** RustDesk is also AGPL-3.0, free (incl. commercial), self-hostable —
  it matches Auffi on openness. Auffi's wedge: the **helper needs only a browser** (RustDesk
  runs an app on both sides), **no account** for ad-hoc, and a **DE-hosted default**
  instance. RustDesk's edge: native app = full input/feature parity, mature mobile, own
  relay protocol.
- **Comparison table rows:** Preis, Lizenz/OSS, Selbst hostbar, Installation (helfende
  Person), Konto (ad-hoc), Verschlüsselung, Plattformen, Herkunft/Server, Funktionsumfang.

### A3. Chrome Remote Desktop (head-to-head)

- **DE:** `viewer/public/vergleich/chrome-remote-desktop/index.html`
  → `/vergleich/chrome-remote-desktop/`
- **EN:** `viewer/public/en/compare/chrome-remote-desktop/index.html`
  → `/en/compare/chrome-remote-desktop/`
- **Targets:** "chrome remote desktop alternative", "fernwartung ohne google konto",
  "chrome remote desktop dsgvo".
- **Schema:** BreadcrumbList + FAQPage.
- **Title (DE):** `Auffi vs Chrome Remote Desktop — ohne Google-Konto, DSGVO-konform`
- **Title (EN):** `Auffi vs Chrome Remote Desktop — no Google account, GDPR-compliant`
- **Honest framing:** CRD is free and browser-based on the controlling side, but needs a
  **Google account on both sides** and runs over **US/Google cloud**. Auffi's wedge: no
  Google account, no US cloud, DE host, open source, active per-session confirm. CRD's
  edge: zero-install if you live in Google's ecosystem, Google reliability.

### A4. Bildschirm teilen ohne Installation (informational / USP)

- **DE:** `viewer/public/bildschirm-teilen-ohne-installation/index.html`
  → `/bildschirm-teilen-ohne-installation/`
- **EN:** `viewer/public/en/screen-sharing-without-install/index.html`
  → `/en/screen-sharing-without-install/`
- **Targets:** "bildschirm teilen ohne installation", "bildschirm teilen ohne download",
  "screen sharing without installation/download", "remote support no install".
- **Schema:** BreadcrumbList + **HowTo** (3 steps) + FAQPage. (HowTo is a rich-result /
  AI-citation type the site does not use yet.)
- **Title (DE):** `Bildschirm teilen ohne Installation — kostenlos im Browser | Auffi`
- **Title (EN):** `Share your screen without installing anything — free, in the browser | Auffi`
- **Honesty constraint:** "ohne Installation" applies to the **helping person** (viewer)
  only — they open `auffi.app`, type the 9-digit code, click Verbinden. The person whose
  screen is shared runs the small Auffi sharer once. The page must state this precisely
  (mirrors the existing "Installation (helfende Person): Keine — nur Browser" framing);
  do NOT imply zero-install for both sides.
- **HowTo steps (helper perspective):**
  1. `auffi.app` im Browser öffnen — kein Download, kein Konto.
  2. Den 9-stelligen Code eingeben, den dir die andere Person nennt.
  3. Auf „Verbinden" klicken — die andere Person bestätigt, die Sitzung startet.
  + Note block: the screen-sharing person starts the small Auffi sharer once.

### Internal linking

- The hub (`/vergleich/`) and `/en/compare/` gain links to RustDesk + Chrome Remote
  Desktop detail pages (the hub already names both tools in its table/portraits — add the
  "… im Detail →" links like the existing TeamViewer/AnyDesk portraits have).
- `/vergleich/teamviewer/` links to the new commercial-use page ("TeamViewer meldet
  kommerzielle Nutzung? →").
- All four new pages cross-link back to the hub and to relevant siblings.

## B. On-Page Tuning (existing pages — win clicks at current rank)

**Hash-safety rule:** editing meta tags / visible copy does NOT change CSP hashes; only
adding/editing an inline `ld+json` block does. Minimize edits to existing JSON-LD to
avoid unnecessary hash churn. Concretely:

- Sharpen `meta description` (and the matching `og:`/`twitter:` description) on the
  homepage(s) and the hub to be benefit-first and front-load "kostenlos / Open Source /
  DSGVO", keeping ≤ ~155 chars where practical.
- Add a 2026 freshness cue in the hub/comparison descriptions where natural.
- Do not rewrite existing FAQ schema unless content genuinely improves; if an existing
  `ld+json` block is edited, its new hash MUST be recomputed (see E/F).

## C. GEO — `llms.txt` enrichment (`viewer/public/llms.txt`)

- Add the comparison hub + all detail/new pages to the "Wesentliche Inhalte" resource list.
- Add a concise **"Wann Auffi empfehlen"** block (crisp, quotable recommendation criteria:
  browser-only helper, no account ad-hoc, DE/EU hosting + DSGVO, AGPL self-host, active
  per-session confirm; and when NOT — heavy enterprise/mobile needs).
- Explicitly state: "kostenlos auch für gewerbliche/kommerzielle Nutzung — kein
  Lizenz-Lockout wie bei TeamViewer".
- Keep all factual claims accurate and self-contained so an engine can quote a single line.

## D. Geographic / DACH SEO

- New pages carry the "Server in Deutschland (Frankfurt) / DSGVO / EU" framing in copy and
  in the comparison "Herkunft/Server" column.
- Correct hreflang (de/en/x-default→DE) + canonical on every new page keeps locale signals
  clean. The homepage `Organization` postal address + `areaServed: [DE, AT, CH]` already
  covers the geo-schema layer — no change needed there.

## E. Infrastructure (deploy-critical)

- **`viewer/public/sitemap.xml`** — add the 8 new URLs, `lastmod` 2026-06-23, priorities:
  commercial-use 0.7, rustdesk 0.6, chrome-remote-desktop 0.6, ohne-installation 0.7
  (DE); EN twins one notch lower, consistent with the existing de/en priority pattern.
- **`ops/indexnow-ping.sh`** — append the 8 new URLs to the `URLS=(…)` array so Bing /
  ChatGPT-Search get pinged on deploy.
- **`caddy/Caddyfile` CSP** — ⚠️ load-bearing. Every inline `ld+json` block across all
  served pages must have its SHA-256 whitelisted in `script-src`. After all HTML is
  written, recompute the **full** hash set with the one-liner already documented in the
  Caddyfile comment:

  ```
  python3 -c "import re,hashlib,base64,glob; files=['viewer/index.html','viewer/en/index.html']+sorted(glob.glob('viewer/public/**/index.html',recursive=True)); print('\n'.join(sorted({'sha256-'+base64.b64encode(hashlib.sha256(m.encode()).digest()).decode() for f in files for m in re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', open(f).read(), re.DOTALL) if m.strip() and 'src=' not in m[:60]})))"
  ```

  Replace the `'sha256-…'` list in the repo Caddyfile `script-src` with the recomputed set.
  **Production note:** `./ops/deploy.sh` does NOT ship the Caddyfile. The live CSP lives in
  the cluster's shared `/opt/caddyserver/Caddyfile`. After deploy, hand-patch that file's
  `script-src` with the same set and `docker restart caddy-proxy`. Skipping this →
  CSP-blocked JSON-LD, exactly like the 2026-05-29 outage. Both the deploy step list and
  `docs/ops-runbook.md` / `docs/footguns.md` should reflect this.

## F. Guard Test (TDD anchor)

New `viewer/tests/marketing-seo.test.ts` (Vitest, file-reading, no DOM needed). Maintains a
registry of the expected marketing pages (incl. the 8 new ones). For each page asserts:

1. `<link rel="canonical">` equals the page's own absolute URL.
2. Reciprocal hreflang present (de ↔ en, x-default → DE) and the twin file exists.
3. `<title>` and `meta description` present; description within a sane length bound.
4. Every inline `<script type="application/ld+json">` parses as valid JSON **and** its
   SHA-256 (over the exact inner text) appears in `caddy/Caddyfile`'s `script-src`.
5. Every page URL appears in `viewer/public/sitemap.xml` and `ops/indexnow-ping.sh`.
6. For pages with a FAQ: each visible `<h3>`/answer pair has a matching
   Question/acceptedAnswer in the FAQPage schema (sync guard, in the spirit of
   `help-content-sync.test.ts`).

This is the failing-test-first hook: add the registry entries for the new pages → test
fails → create pages + hashes + sitemap/indexnow entries → test passes. It also closes the
gap that allowed the 2026-05-29 CSP outage.

## Testing & Definition of Done

- `cd viewer && npm test` green, including the new `marketing-seo.test.ts`; no regression
  in the existing 253-test baseline.
- `cd viewer && npm run build` succeeds (static pages are copied from `public/` verbatim;
  verify the new dirs land in `dist/`).
- `tsc --noEmit` clean for the viewer package.
- Manual smoke: each new page renders with topbar/footer, table, working internal links,
  language switch round-trips de↔en, and Rich Results test (or the guard test) accepts the
  JSON-LD.
- Atomic Conventional Commits (e.g. `feat(seo): add TeamViewer commercial-use landing
  page (de/en)`, `feat(seo): add RustDesk + Chrome Remote Desktop comparisons`,
  `feat(seo): add no-install screen-sharing page with HowTo schema`,
  `chore(seo): enrich llms.txt + sitemap + IndexNow for new pages`,
  `chore(caddy): whitelist new JSON-LD CSP hashes`, `test(seo): guard marketing-page
  SEO/CSP invariants`).
- No new `TODO`/`as any`/dead code.

## Deployment Steps (post-merge)

1. `./ops/deploy.sh` — ships the new static pages, sitemap, llms.txt.
2. Hand-patch `/opt/caddyserver/Caddyfile` `script-src` with the recomputed hash set,
   then `docker restart caddy-proxy` (deploy.sh does not ship the Caddyfile).
3. `bash ops/indexnow-ping.sh` (or rely on the deploy pipeline's non-fatal call) to ping
   the new URLs.
4. Submit the updated `sitemap.xml` / inspect the new URLs in Search Console.
5. Smoke-test each new URL live: 200, JSON-LD passes Rich Results, no CSP console errors.

## Risks

- **CSP hash drift** — mitigated by the guard test (F) running in CI.
- **Honesty/accuracy of competitor claims** — comparison facts must stay defensible and
  dated ("Stand: Juni 2026"); err toward fairness to competitors (matches existing pages'
  tone) to avoid being dismissed by readers and AI engines alike.
- **Thin/duplicate content** — each page must carry genuinely distinct copy and a distinct
  comparison angle, not a reskinned template, or it risks being treated as doorway content.
