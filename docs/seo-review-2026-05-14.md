# Auffi — SEO/Geo + Legal Review, 2026-05-14

Scope: `https://auffi.app/` (Viewer-Landing-Seite + `/download/` + `/dashboard/`). Stand: Commit `dfd382a`.

---

## 1. Was rechtlich JETZT fehlt (hat Priorität)

| Pflicht | Vorhanden? | Quelle |
|---|---|---|
| **Impressum** (§ 5 TMG) | ❌ **fehlt komplett** | `/impressum` liefert die SPA-Fallback-HTML, keinen echten Inhalt |
| **Datenschutzerklärung** (Art. 13 DSGVO) | ❌ **fehlt komplett** | `/datenschutz` ebenfalls SPA-Fallback |
| Footer-Links zu Impressum + Datenschutz | ❌ | Viewer + Dashboard zeigen nur „powered by …" |
| Streitschlichtungs-Hinweis (Art. 14 ODR-VO) | ❌ | Pflicht für jede gewerblich-orientierte DE-Website |

**Risiko:** Abmahnfähig. Auffi spricht Endkunden in DE an, akzeptiert Konten + Mail-Adressen, hat einen kommerziellen Berührungsschutz (Spenden-Link „Buy me a coffee"). Damit greift die Impressums-Pflicht klar.

**Fix in dieser Session:** Impressum + Datenschutz aus `phash.de` als Vorlage übernehmen, Auffi-spezifisch anpassen (Backend-Logs, Account-System, SMTP-Provider, WebRTC-Datenfluss, Retention-Windows), unter `/impressum` und `/datenschutz` deployen, in den Footer beider Surfaces verlinken.

---

## 2. SEO-Befundlage (Quick-Audit)

### Was bereits gut ist ✅

| Surface | Setting | Quelle |
|---|---|---|
| `<title>` aussagekräftig + Keyword-haltig | „Auffi — Bildschirm-Sharing, Open Source, DSGVO-konform" | `viewer/index.html:6` |
| `<meta name="description">` (160 Zeichen) | präzise, USP-getrieben | `viewer/index.html:9` |
| `<link rel="canonical">` | gesetzt | `viewer/index.html:12` |
| Open-Graph + Twitter-Card | komplett | `viewer/index.html:15-25` |
| JSON-LD `SoftwareApplication` + `FAQPage` | strukturierte Daten für Rich Snippets | `viewer/index.html:28-91` |
| `robots.txt` | korrekt; `/api/*`, `/signal`, `/dashboard/verify/`, `/dashboard/reset/` disallowed | `viewer/public/robots.txt` |
| Sitemap | mit `<lastmod>` und `<changefreq>` | `viewer/public/sitemap.xml` |
| HSTS + CSP + HTTPS-only | siehe Caddyfile | Cluster-Caddy |
| Mobile-Viewport | korrekt | `viewer/index.html:5` |
| Sprache deklariert | `<html lang="de">` | `viewer/index.html:2` |
| H1-Hierarchie | „Aktuelles" / „Warum Auffi?" als H2 | `viewer/index.html` |

### Was fehlt — SEO-Lücken

| Severity | Item | Symptom heute |
|---|---|---|
| **High** | **`Organization`-JSON-LD mit Adresse** | Geo-SEO blockiert. Google zeigt für DE-Suchen lokale Anbieter bevorzugt; ohne `postalAddress` + `addressLocality` taucht Auffi in der lokalen Map nicht auf. |
| **High** | **og:image** | OG-Embed in WhatsApp, Slack, LinkedIn zeigt aktuell **gar kein Vorschaubild**. Klick-Rate auf Social-Shares deutlich niedriger. |
| **High** | **Favicon fehlt komplett** | `GET /favicon.ico` liefert SPA-Fallback (HTML, 23 kB). Browser-Tab zeigt Default-Icon. Google nutzt das Favicon in SERPs als Visual-Anker. |
| Medium | **Sitemap unvollständig** | `/download/`, `/impressum`, `/datenschutz` fehlen → Crawler sehen die Pages später (via Internal-Links erst). |
| Medium | **theme-color** | Mobile Safari + Chrome färben die URL-Bar nach `<meta name="theme-color">` — fehlt, also Default-Weiß. |
| Medium | **`/.well-known/security.txt` (RFC 9116)** | Aktuell 403 (Caddys `dotfile_protection`). Sicherheitsforscher haben keinen Standard-Pfad um Bugs zu melden. |
| Low | **JSON-LD `BreadcrumbList`** | Sub-Pages (`/download/`, später `/impressum/`) haben keine Brotkrumen → kein erweiterter SERP-Eintrag. |
| Low | **`hreflang`** | Aktuell nur deutsch — wenn EN-Version geplant ist (CLAUDE.md sagt „German first"), würde `hreflang="x-default"` Sinn machen. |
| Low | **Internal-Links zur `/download/`** vom oberen Trust-Block | Viewer-Hauptseite hat den Download-CTA nur im Topbar. Ein zweiter Visual-Anker auf der Landing-Page steigert die Klickrate. |

---

## 3. Geo-SEO — spezifische Empfehlungen

Auffi spricht primär die DACH-Region an (German-first, Server in Deutschland als USP). Geo-SEO sollte das auch in den Daten reflektieren:

1. **`Organization`-JSON-LD mit `postalAddress`** — Name, Tannenweg 6, 85405 Nandlstadt, Deutschland. Verknüpft mit `Person` (Manuel Rödig) als `founder`/`employee`. Mailto + URL `phash.de`.
2. **`SoftwareApplication.publisher` füllen** — heute nur „Phash"-Name; mit voller Adresse anreichern.
3. **Sprach-Signale verstärken** — `<meta name="language" content="German">` + `<meta http-equiv="content-language" content="de-DE">` zusätzlich zum bereits vorhandenen `<html lang="de">`.
4. **Lokal-relevante Keywords im Content** — „aus Deutschland", „Server in Frankfurt", „DSGVO-konform", „TeamViewer-Alternative DE" — meiste sind bereits da, aber nicht in H2/H3-Tags. SERP-Keyword-Matching nutzt H-Tag-Gewichtung höher als Body-Text.
5. **Backlinks** — phash.de + mr-development.de verlinken via Footer auf auffi.app. Cross-Linking innerhalb deiner Domains stärkt das Domain-Authority-Bündel ohne externen Aufwand.

---

## 4. Sitemap — neue Struktur

```xml
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://auffi.app/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <lastmod>2026-05-14</lastmod>
  </url>
  <url>
    <loc>https://auffi.app/download/</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
    <lastmod>2026-05-14</lastmod>
  </url>
  <url>
    <loc>https://auffi.app/dashboard/</loc>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>https://auffi.app/dashboard/login</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://auffi.app/dashboard/signup</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://auffi.app/impressum/</loc>
    <changefreq>yearly</changefreq>
    <priority>0.2</priority>
  </url>
  <url>
    <loc>https://auffi.app/datenschutz/</loc>
    <changefreq>yearly</changefreq>
    <priority>0.2</priority>
  </url>
</urlset>
```

---

## 5. Konkrete Fix-Liste (priorisiert)

Diese Liste arbeite ich in dieser Session ab:

1. **`/impressum/`** — Static-Page unter `viewer/public/impressum/`, Inhalt aus phash.de übernommen + Auffi-spezifisch angepasst.
2. **`/datenschutz/`** — Static-Page unter `viewer/public/datenschutz/`. Auffi-spezifische Abschnitte für:
   - Account-System (E-Mail, Passwort-Hash, Sessions)
   - Backend-Server-Logs (anonymisierte IPs, 30-Tage-Retention)
   - WebRTC (kein Server-Datenfluss für Pixel/Input)
   - TURN-Fallback (auch dort ende-zu-ende verschlüsselt)
   - SMTP via mail.mr-development.de
   - Auffi-spezifisches Cookies-Verzeichnis (`__Host-auffi_session`)
   - Retention-Windows aus `purge.ts`
3. **Footer-Links** in Viewer + Dashboard → Impressum + Datenschutz
4. **`Organization`-JSON-LD** mit voller Adresse in `viewer/index.html`
5. **Echtes `favicon.ico`** + `apple-touch-icon` + Manifest
6. **`og:image`** — eine 1200×630 PNG-Vorschau (Brand-Banner)
7. **`theme-color`** Meta-Tag
8. **`/.well-known/security.txt`** mit Kontaktdaten + Encryption-Policy
9. **Sitemap** um alle neuen Pages erweitern
10. **`hreflang="x-default"`** als forward-compatible Marker

---

## 6. Was wir NICHT machen

- **Cookie-Banner**: Auffi setzt nur einen technisch-notwendigen Cookie (`__Host-auffi_session`). Per Telemediengesetz/DSGVO ist die Einwilligung dafür **nicht erforderlich** (Art. 25 Abs. 2 TTDSG). Banner wäre Cargo-Cult.
- **Google Analytics / Matomo**: nicht eingebaut, daher kein Tracking-Hinweis nötig. Phash.de nutzt Matomo (sieht man in deren Datenschutz); Auffi tut das nicht, also weniger Pflichten.
- **AGB**: keine bezahlten Services auf Auffi, kein Vertragsverhältnis → keine AGB-Pflicht. Lizenz-Hinweis (AGPL-3.0) reicht.
- **Newsletter-Hinweis**: Auffi versendet nur Transaktions-Mails (Verify-Token, Password-Reset, E-Mail-Change). Keine Marketing-Mails → kein Newsletter-Block in der Datenschutzerklärung.
