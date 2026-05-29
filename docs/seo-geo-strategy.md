# SEO & GEO Strategy — auffi.app

_Last updated: 2026-05-29._

How to make auffi.app — a German-first, free, open-source (AGPL-3.0), DSGVO-compliant
TeamViewer-style screen-sharing / remote-support tool — more discoverable in both
classic search (Google/Bing) and AI answer engines (GEO: ChatGPT, Perplexity,
Google AI Overviews/Gemini, Copilot, Claude).

Derived from a 2026-05-29 review (current-state audit + web-grounded SEO & GEO
research). Sources are linked inline; confidence is flagged where it matters.

## TL;DR

- **Technical SEO/GEO foundation is already strong** (SSR HTML, rich JSON-LD incl.
  FAQPage + geo Organization, OG tags, good `llms.txt`, all AI crawlers allowed in
  `robots.txt`, narrow bot-blocklist). Don't over-invest here.
- **The dominant gap is content depth** — only ~4 indexable pages. This caps both
  ranking breadth and the AI-citation base.
- **SEO and GEO converge on the same moves**: (1) German comparison + "ohne
  Installation/Anmeldung" content, (2) third-party/entity presence (AlternativeTo,
  Wikidata, GitHub, Reddit), (3) answer-first, quotable content.
- For a solo maintainer, highest-ROI is NOT on-page tweaks — it's content + earned
  third-party presence.

## Current state (audit 2026-05-29)

**Good:** server-rendered HTML on all public pages; valid JSON-LD
(`SoftwareApplication` + `Organization` w/ DACH `areaServed` + `FAQPage`); complete
OG on the landing; 1200×630 OG image; high-quality `llms.txt`; `robots.txt`
explicitly allows GPTBot/OAI-SearchBot/ClaudeBot/PerplexityBot/Google-Extended/…;
Caddy bot-blocklist is narrow (doesn't catch real crawlers); `lang=de`, canonicals,
sitemap, security.txt.

**Gaps:** thin content (no blog/docs/comparison/use-case pages); German-only (no
hreflang/en); FAQ schema was landing-only; subpage OG was incomplete; sitemap
`lastmod` was stale + listed auth-gated `/dashboard/`.

## Roadmap

### P0 — Quick wins ✅ DONE 2026-05-29 (commit batch "SEO/GEO P0")

- Sitemap: refreshed `lastmod`, dropped `/dashboard/`, added `/vergleich/teamviewer/`.
- OG/Twitter cards completed on `/download/`, `/impressum/`, `/datenschutz/`.
- `FAQPage` + `SoftwareApplication` JSON-LD added to `/download/`; `sameAs`
  (GitHub) + `downloadUrl` added to the landing `SoftwareApplication`.
- Hygiene: removed dead `meta keywords`, fixed stale Matomo comment.
- **IndexNow** key hosted at `/<key>.txt` + `ops/indexnow-ping.sh` (notifies Bing →
  feeds ChatGPT Search, which uses Bing's index). Run after deploy / on publish.
- Verified: all AI search crawlers allowed (robots.txt) and NOT caught by the Caddy
  anti-scraper regex.

**User actions (cannot be automated — need account access):**
- **Google Search Console** — verify domain property, submit `sitemap.xml`, watch
  Performance (real query data) + Page Indexing + Core Web Vitals.
  ([guide](https://searchengineland.com/guide/google-search-console-guide))
- **Bing Webmaster Tools** — one-click import from GSC. Matters because **ChatGPT
  Search uses Bing's index**.
  ([why](https://www.blogseo.io/blog/bing-webmaster-tools-ai-search-visibility-2025))

### P1 — Content (the dominant lever)

Write German, **answer-first**, declarative, with honest comparison tables, FAQ Q&A,
on-page specs/stats, and a visible "Stand"-date. **Do NOT keyword-stuff** (measurably
backfires — Princeton GEO study).

- **Comparison pages** (highest ROI; convert well + get lifted into AI answers):
  - ✅ `/vergleich/teamviewer/` — shipped 2026-05-29 (use as the template).
  - `/vergleich/anydesk/`, `/vergleich/rustdesk/`, `/vergleich/chrome-remote-desktop/`.
- **Hub page**: "TeamViewer-Alternative: kostenlos, Open Source & DSGVO-konform".
- **USP pages** (almost no competition — literally the product):
  "Bildschirm teilen ohne Installation", "Fernwartung ohne Anmeldung".
- **Use-case**: "Oma/Eltern am PC helfen — Schritt für Schritt" (long-tail, sharable).
- **Light `/hilfe` or `/docs`** + turn the landing "Aktuelles" news into permalinked
  `/news/<slug>/` or `/changelog/` pages (near-free content from existing copy).

Minimum viable footprint: 4 comparison pages + 1 hub + 2 USP pages + small docs.
~7–8 focused pages beat 30 thin ones.

Keyword clusters (DE), bottom-of-funnel first:
`TeamViewer Alternative kostenlos/Open Source/DSGVO` · `Bildschirm teilen ohne
Installation/Anmeldung` · `Oma am PC helfen` · `Fernwartung kostenlos` ·
`RustDesk/AnyDesk Alternative`. Validate volumes free via Google Keyword Planner,
Ahrefs Free Keyword Generator, LowFruits, or — best — Search Console once live.
Note: **keywords don't translate** — do German-native research.

### P2 — Distribution & entity (compounding, do-once-then-maintain)

- **AlternativeTo + SaaSHub + Capterra.de** — list as alternative to TeamViewer/
  AnyDesk/RustDesk/Chrome Remote Desktop. Dofollow + exactly the pages AI engines
  cite for "best free … alternative".
- **GitHub repo SEO** — keyword-rich description + up to **20 topics**
  (`teamviewer-alternative`, `fernwartung`, `screen-sharing`, `remote-support`,
  `dsgvo`, `self-hosted`, `webrtc`, `tauri`, `agpl`…) + README headers + screenshots.
- **Wikidata item** for Auffi (notability bar = verifiable existence; GitHub +
  AlternativeTo + own site qualify). Trusted entity anchor for Google Knowledge
  Graph AND LLMs. Then add the Wikidata URL to the `sameAs` arrays.
  ([path](https://www.mlforseo.com/knowledge-graph-strategy/wikidata-for-brands-notability-criteria-and-a-realistic-path/))
- **Compound launch**: Show HN + Reddit (r/selfhosted, r/datenschutz, r/degoogle,
  dt. subs) day 0 → AlternativeTo/directories day +1. Beats a single Product Hunt spike.
- **Awesome-lists** (awesome-selfhosted, awesome-privacy); **German FOSS/privacy
  press** ("Made in Germany, AGPL, DSGVO-konforme TeamViewer-Alternative" is
  newsworthy in DE).
- **YouTube demo** (60-second German walkthrough + full description/transcript) —
  among the strongest correlates with Google AI-Overview visibility.

### P3 — Defer

- **English version / hreflang** — see the i18n note below; do it natively, not
  machine-translated (75% of hreflang setups have errors). International reach comes
  via GitHub/HN/Reddit (English) without a parallel site.
- **Wikipedia article** — notability bar not met yet; use Wikidata instead.
- **Paid AEO tools** (Profound etc.) — overkill until there's meaningful traffic.

## GEO (AI answer engines) — what actually works

Confidence flags: **[PROVEN]** peer-reviewed/large-N · **[EMERGING]** consistent
correlational studies · **[SPECULATIVE]** vendor claims.

- **The biggest lever is third-party "earned" sources, not your own site.** AI search
  cites 81–92% earned/third-party sources (Reddit, Wikipedia, YouTube, G2/Capterra,
  AlternativeTo). Getting auffi *mentioned* on those matters more than any on-page
  tweak. **[PROVEN/EMERGING]**
  ([Profound](https://www.tryprofound.com/blog/ai-platform-citation-patterns),
  [study](https://arxiv.org/html/2509.08919v1))
- **On-page (Princeton GEO, KDD 2024 — the only causal study):** adding **quotations
  +41%**, **statistics +33%**, **cite sources +28%**, fluency +29%; **keyword-stuffing
  −9%**. Lower-ranked sites benefit most. **[PROVEN]**
  ([paper](https://arxiv.org/html/2311.09735v3))
- **Answer-first, self-contained, quotable.** ~44% of LLM citations come from the
  first 30% of a page; comparison tables + FAQ Q&A + visible dates extract well.
  **[EMERGING]**
- **Brand mentions across the web** correlate with AI visibility far more than
  backlinks (r≈0.66 vs 0.22). **Freshness** matters (AI-cited content is ~26% fresher).
  **[EMERGING]**
- **Crawlers: allow the search/citation bots** (OAI-SearchBot, PerplexityBot,
  ClaudeBot, Perplexity-User, ChatGPT-User, Google-Extended, Bingbot). Blocking the
  *training* bot (GPTBot) does NOT stop citations. auffi already allows all. **[PROVEN]**
  ([taxonomy](https://momenticmarketing.com/blog/ai-search-crawlers-bots))
- **German market**: AI Overviews still limited in DE (~15–25% of queries, full
  rollout ~Q2 2026) — building entity presence now is well-timed; being a *cited*
  source can lift CTR up to ~80%. ([SISTRIX](https://www.sistrix.com/blog/ai-overviews-in-germany/))

### Reality checks (don't waste effort)

- **`llms.txt` is cargo-cult for citations.** No major AI engine consumes it for
  retrieval as of 2026 (Google/Mueller say so explicitly; log studies show ~0.1% bot
  hits). **Keep the lean one we have (near-zero cost, minor dev-agent value for an
  OSS project); do NOT invest further.** **[PROVEN]**
  ([debunk](https://medium.com/@kaispriestersbach/the-llms-txt-is-dead-more-precisely-a-dud-ab7bee4f469c))
- **FAQ/HowTo rich results are being removed by Google in 2026** — keep the markup
  (it still aids AI extraction) but don't expect blue-link rich snippets.
  ([SEJ](https://www.searchenginejournal.com/google-drops-faq-rich-results-from-search/574429/))
- **The classic-ranking → AI-citation link is weakening** (AI-Overview/top-10 overlap
  fell from ~76% to ~38% over 2025–26). Quotable structure + third-party presence are
  now independent levers. ([SEJ](https://www.searchenginejournal.com/google-ai-overview-citations-from-top-ranking-pages-drop-sharply/568637/))

## Measurement

- **GSC + Bing Webmaster + IndexNow** (P0 above). Bing because ChatGPT Search uses it.
- **Server-side AI-referrer aggregation** — best fit for auffi's no-third-party-tracker
  DSGVO posture: log/aggregate `Referer` for marketing-page hits matching
  `chatgpt.com | perplexity.ai | claude.ai | gemini.google.com | copilot.microsoft.com`.
  First-party, anonymous, survives client-side referrer stripping. **[EMERGING — most
  reliable available]**
- **Matomo segment** on the same referrers (floor, not truth — opt-in only).
- **Monthly manual citation check** — run the P1 keywords on each engine, record
  whether auffi appears. Track *trends*, never absolute numbers (per-query AI
  visibility is non-deterministic; 60–70% of ChatGPT referrals hide in "Direct").
  ([why](https://authoritytech.io/blog/llm-referral-traffic-tracking))
- Skip paid AI-visibility tools until there's meaningful traffic.

## Notes for maintainers

- New marketing pages: copy the topbar+footer shell from an existing static page
  (e.g. `viewer/public/impressum/index.html`), add `canonical`, full OG/Twitter, and
  page-appropriate JSON-LD (`FAQPage` for Q&A content). Add the URL to
  `viewer/public/sitemap.xml` with today's `lastmod`. Internal-link it from the
  landing.
- Run `ops/indexnow-ping.sh` after deploying new/changed content (or wire it into
  `ops/deploy.sh` as a best-effort post-deploy step).
- When the Wikidata item exists, add its URL to every `sameAs` array.

### Key sources

Princeton GEO (causal): https://arxiv.org/html/2311.09735v3 · Evidence review:
https://www.radiantelephant.com/geo-tactics-what-works-evidence-based-research-review/
· AI citation patterns: https://www.tryprofound.com/blog/ai-platform-citation-patterns
· Crawler taxonomy: https://momenticmarketing.com/blog/ai-search-crawlers-bots ·
SoftwareApplication schema: https://developers.google.com/search/docs/appearance/structured-data/software-app
· FAQ rich-results dropped: https://www.searchenginejournal.com/google-drops-faq-rich-results-from-search/574429/
· German AIO: https://www.sistrix.com/blog/ai-overviews-in-germany/ ·
GitHub SEO: https://dev.to/infrasity-learning/the-ultimate-guide-to-github-seo-for-2025-38kl
· Wikidata entity SEO: https://www.mlforseo.com/knowledge-graph-strategy/wikidata-for-brands-notability-criteria-and-a-realistic-path/
· llms.txt debunk: https://medium.com/@kaispriestersbach/the-llms-txt-is-dead-more-precisely-a-dud-ab7bee4f469c
