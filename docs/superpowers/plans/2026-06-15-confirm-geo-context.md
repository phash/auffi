# Confirm-Dialog Geo-Kontext (Land) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den menschlichen Bestätigungs-Schritt (das eigentliche Zugangstor) stärken, indem der Ad-hoc-Confirm-Dialog des Sharers das Herkunftsland des Viewers anzeigt — aufgelöst über eine self-gehostete DB-IP-Lite-Country-Datenbank ohne jeden Third-Party-Call.

**Architecture:** Backend resolved das Land beim JOIN aus der vollen Viewer-IP (lokaler MMDB-Lookup via `maxmind`, graceful auf `null` degradierend) und sendet ISO-3166-1-alpha-2 im bestehenden `peer-joined.viewerInfo.country`. Die Rust-Seite hat `country` bereits deserialisiert (nur ignoriert) — sie wird ent-ignoriert und emittiert. Der Sharer-Webview rendert den deutschen Ländernamen über `Intl.DisplayNames` (kein Flag-Emoji — Windows rendert Regional-Indicator nicht).

**Tech Stack:** `maxmind` 5.0.6 (MIT), DB-IP IP-to-Country Lite (CC-BY-4.0), TypeScript (Vitest), Rust (serde), Docker.

**Referenz-Spec:** `docs/superpowers/specs/2026-06-15-confirm-context-und-burn-cleanup-design.md` (Teil B).

**Reconciliation ggü. Spec:** Der Confirm-Dialog hat bereits eine `.confirm-safety-note` („Nur erlauben, wenn du die Person kennst und gerade um Hilfe gebeten hast.") — das ist die im Spec geplante Warn-Copy. Es wird **keine** zweite Warnzeile (`#confirm-warning`) hinzugefügt; B beschränkt sich auf die Land-Anreicherung von `#confirm-text`.

---

### Task 1: `maxmind` als Dependency hinzufügen + exakt pinnen

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Installieren und exakt pinnen**

Run: `cd backend && npm install --save-exact maxmind@5.0.6`
Expected: `package.json` bekommt `"maxmind": "5.0.6"` (kein `^`/`~`); `package-lock.json` aktualisiert.

- [ ] **Step 2: Verifizieren**

Run: `cd backend && node -e "const {Reader}=require('maxmind'); console.log(typeof Reader)"`
Expected: `function`.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "build(backend): add maxmind 5.0.6 for self-hosted country lookup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `geoip.ts` (Lookup-Modul mit injizierbarem Reader)

**Files:**
- Create: `backend/src/geoip.ts`
- Test: `backend/tests/geoip.test.ts`

Der `maxmind`-`Reader` erfüllt das schmale `CountryLookup`-Interface (`get(ip)`), sodass Unit-Tests einen In-Memory-Fake injizieren — keine Binär-Fixture nötig (`mmdbwriter` ist in dieser Registry nicht verfügbar). Der reale Reader wird synchron aus einem `Buffer` gebaut, damit `createServer` nicht async werden muss.

- [ ] **Step 1: Failing test schreiben**

Create `backend/tests/geoip.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { lookupCountry, openCountryDb, type CountryLookup } from "../src/geoip.js";

const fakeReader: CountryLookup = {
  get(ip: string) {
    if (ip === "84.1.2.3") return { country: { iso_code: "DE" } };
    if (ip === "8.8.8.8") return { country: { iso_code: "US" } };
    if (ip === "10.0.0.1") return null; // private — not in DB
    throw new Error("invalid ip"); // maxmind throws on malformed input
  },
};

describe("lookupCountry", () => {
  it("returns the ISO code for a known IP", () => {
    expect(lookupCountry(fakeReader, "84.1.2.3")).toBe("DE");
    expect(lookupCountry(fakeReader, "8.8.8.8")).toBe("US");
  });

  it("returns null for a private/unknown IP", () => {
    expect(lookupCountry(fakeReader, "10.0.0.1")).toBeNull();
  });

  it("returns null (never throws) for a malformed IP", () => {
    expect(lookupCountry(fakeReader, "not-an-ip")).toBeNull();
  });

  it("returns null when no reader is configured", () => {
    expect(lookupCountry(null, "84.1.2.3")).toBeNull();
  });
});

describe("openCountryDb", () => {
  it("returns null for an undefined path", () => {
    expect(openCountryDb(undefined)).toBeNull();
  });

  it("returns null (never throws) for a missing file", () => {
    expect(openCountryDb("/nonexistent/dbip.mmdb")).toBeNull();
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet ROT**

Run: `cd backend && npx vitest run tests/geoip.test.ts`
Expected: FAIL — `../src/geoip.js` existiert nicht.

- [ ] **Step 3: `geoip.ts` implementieren**

Create `backend/src/geoip.ts`:

```ts
import { readFileSync } from "node:fs";
import { Reader } from "maxmind";

/**
 * Minimal slice of the maxmind Reader we depend on. Lets the lookup logic be
 * unit-tested with an in-memory fake — a country MMDB is an in-process file
 * reader, not a database service, so dependency injection is the right shape.
 */
export interface CountryLookup {
  get(ip: string): { country?: { iso_code?: string } } | null;
}

/**
 * Resolve an IP to its ISO-3166-1-alpha-2 country code, or null when the
 * reader is absent, the IP is private/unknown, or the input is malformed.
 * Never throws: country context is a nice-to-have for the confirm dialog,
 * never load-bearing for signaling.
 */
export function lookupCountry(reader: CountryLookup | null, ip: string): string | null {
  if (!reader) return null;
  try {
    const iso = reader.get(ip)?.country?.iso_code;
    return typeof iso === "string" && iso.length === 2 ? iso.toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Open the country MMDB synchronously from disk. Returns null (with a single
 * warning) when the path is unset or unreadable, so a build without the DB
 * (local dev) silently disables country resolution.
 */
export function openCountryDb(path: string | undefined): CountryLookup | null {
  if (!path) return null;
  try {
    return new Reader(readFileSync(path));
  } catch {
    // eslint-disable-next-line no-console -- one-shot startup degradation notice
    console.warn(`[geoip] country DB not loaded from ${path}; country disabled`);
    return null;
  }
}
```

- [ ] **Step 4: Test grün**

Run: `cd backend && npx vitest run tests/geoip.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/geoip.ts backend/tests/geoip.test.ts
git commit -m "feat(backend): country lookup module over an injectable MMDB reader

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `geoip` in den Signaling-JOIN verdrahten

**Files:**
- Modify: `backend/src/signaling.ts` (Signatur ~88–113; ad-hoc peer-joined ~452–455)
- Modify: `backend/src/server.ts` (Open ~vor 253; Aufruf 253–264)
- Test: `backend/tests/signaling.test.ts`

> Das ad-hoc `peer-joined` ist der Send um Zeile 452–455 (`country: null`). Der zweite `country: null`-Send (~246, Unattended-Mirror nach pw-confirm) bleibt **unverändert** — Unattended ist password-gated und außerhalb des Scopes.

- [ ] **Step 1: Failing test — ad-hoc peer-joined trägt das Land**

In `backend/tests/signaling.test.ts` einen Test ergänzen, der `registerSignaling` mit einem injizierten `CountryLookup` aufruft (als **letztes** Argument, nach `bearerCounts`), einen Sharer registriert, einen Viewer mit dessen Code joinen lässt und prüft, dass der `peer-joined`-Frame an den Sharer `viewerInfo.country` aus dem Lookup trägt. Muster für den Fake:

```ts
const country = { get: (_ip: string) => ({ country: { iso_code: "DE" } }) };
// registerSignaling(app, store, rlCfg, attemptCounts, perPeer, regCfg,
//   regCounts, unattended, bearerCfg, bearerCounts, country)
```
Assertion: der an den Sharer gesendete `peer-joined` hat `viewerInfo.country === "DE"`.

- [ ] **Step 2: Test laufen lassen — erwartet ROT**

Run: `cd backend && npx vitest run tests/signaling.test.ts`
Expected: FAIL — `registerSignaling` nimmt noch keinen `countryLookup`-Parameter; `country` ist `null`.

- [ ] **Step 3: `countryLookup`-Parameter zur Signatur hinzufügen**

In `signaling.ts` nach `bearerCounts` (Zeile 112) einen finalen optionalen Parameter ergänzen und `CountryLookup`/`lookupCountry` importieren:

```ts
  bearerCfg: RateLimitConfig = DEFAULT_BEARER_AUTH_LIMIT,
  bearerCounts: Map<string, RateLimitEntry> = new Map(),
  countryLookup: CountryLookup | null = null,
): Map<string, RateLimitEntry> {
```

Import oben in `signaling.ts` ergänzen:
```ts
import { lookupCountry, type CountryLookup } from "./geoip.js";
```

- [ ] **Step 4: Land beim ad-hoc peer-joined einsetzen**

In `signaling.ts` (um Zeile 450–455):

```ts
        role = "viewer";
        store.attachViewer(normalized, peer as Peer);
        send(session.sharer as WebSocket, {
          type: "peer-joined",
          viewerInfo: { ipPrefix: ipPrefix(req), country: null },
        });
```
→
```ts
        role = "viewer";
        store.attachViewer(normalized, peer as Peer);
        send(session.sharer as WebSocket, {
          type: "peer-joined",
          viewerInfo: {
            ipPrefix: ipPrefix(req),
            country: lookupCountry(countryLookup, stripIpv4Mapped(req.ip ?? "")),
          },
        });
```
(`stripIpv4Mapped` ist in `signaling.ts` bereits importiert — von `ipPrefix` genutzt.)

- [ ] **Step 5: In `server.ts` die DB öffnen und durchreichen**

In `server.ts` vor dem `registerSignaling(`-Aufruf (vor Zeile 253) ergänzen:

```ts
  const countryLookup = openCountryDb(process.env.GEOIP_DB_PATH);
```
und `openCountryDb` importieren (`import { openCountryDb } from "./geoip.js";`).

Den Aufruf (Zeile 253–264) um das letzte Argument erweitern:

```ts
    { windowMs: env.bearerAuthRateLimitWindowMs, max: env.bearerAuthRateLimitMax },
    bearerCounts,
    countryLookup,
  );
```

- [ ] **Step 6: Tests + Typecheck grün**

Run: `cd backend && npx vitest run tests/signaling.test.ts && npx tsc --noEmit`
Expected: PASS (neuer Land-Test grün; bestehende `registerSignaling`-Aufrufe ohne `countryLookup` nutzen den `null`-Default).

- [ ] **Step 7: Commit**

```bash
git add backend/src/signaling.ts backend/src/server.ts backend/tests/signaling.test.ts
git commit -m "feat(backend): resolve viewer country at ad-hoc join for the confirm dialog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Rust — `country` ent-ignorieren und emittieren

**Files:**
- Modify: `sharer/src-tauri/src/protocol.rs` (Zeilen 36–47 + Tests 49–84)
- Modify: `sharer/src-tauri/src/signaling.rs` (Zeilen 129–133)

- [ ] **Step 1: Tests auf `country` (statt `_country`) umstellen — Red**

In `protocol.rs` in beiden Tests `viewer_info._country` → `viewer_info.country` ändern (Zeilen 63, 78).

- [ ] **Step 2: `cargo test` — erwartet ROT (Compile-Fehler)**

Run: `cd sharer/src-tauri && cargo test --lib protocol`
(Hinweis Windows-Host: vorher `export VCPKG_ROOT=C:/tools/vcpkg`.)
Expected: FAIL — Feld heißt noch `_country`.

- [ ] **Step 3: `ViewerInfo._country` → `country` (und Kommentar straffen)**

In `protocol.rs` (Zeilen 36–47):

```rust
#[derive(Deserialize, Debug)]
pub struct ViewerInfo {
    #[serde(rename = "ipPrefix")]
    pub ip_prefix: String,
    // Without #[serde(default)] an absent `country` key would fail the whole
    // struct (older backends sent no field) and silently drop every PeerJoined.
    #[serde(rename = "country", default)]
    pub country: Option<String>,
}
```

- [ ] **Step 4: `country` im Event-Emit weiterreichen**

In `signaling.rs` (Zeilen 129–133):

```rust
                        Incoming::PeerJoined { viewer_info } => {
                            let _ = app.emit(
                                "peer-joined",
                                serde_json::json!({ "ipPrefix": viewer_info.ip_prefix }),
                            );
                        }
```
→
```rust
                        Incoming::PeerJoined { viewer_info } => {
                            let _ = app.emit(
                                "peer-joined",
                                serde_json::json!({
                                    "ipPrefix": viewer_info.ip_prefix,
                                    "country": viewer_info.country,
                                }),
                            );
                        }
```

- [ ] **Step 5: Rust-Tests + Clippy grün**

Run: `cd sharer/src-tauri && cargo test --lib protocol && cargo clippy --lib -- -D warnings`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sharer/src-tauri/src/protocol.rs sharer/src-tauri/src/signaling.rs
git commit -m "feat(sharer): forward viewer country from peer-joined to the webview

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Sharer-Webview — Land im Confirm-Dialog rendern

**Files:**
- Create: `sharer/src/connect-format.ts`
- Test: `sharer/tests/connect-format.test.ts`
- Modify: `sharer/src/main.ts` (Import; Zeilen 651, 686–689)

- [ ] **Step 1: Failing test für den pure Helper**

Create `sharer/tests/connect-format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { countryName, formatConnectionRequest } from "../src/connect-format";

describe("countryName", () => {
  it("maps an ISO code to a German region name", () => {
    expect(countryName("DE")).toBe("Deutschland");
    expect(countryName("us")).toBe("Vereinigte Staaten");
  });
  it("falls back to the upper-case code for unknown/invalid input", () => {
    expect(countryName(null)).toBeNull();
    expect(countryName("ZZ")).toBe("ZZ");
    expect(countryName("123")).toBeNull();
  });
});

describe("formatConnectionRequest", () => {
  it("includes the country when present", () => {
    expect(formatConnectionRequest({ ipPrefix: "84.xxx", country: "DE", trusted: false }))
      .toBe("Verbindungsanfrage aus Deutschland · 84.xxx");
  });
  it("falls back to ip-only without a country", () => {
    expect(formatConnectionRequest({ ipPrefix: "84.xxx", country: null, trusted: false }))
      .toBe("Verbindungsanfrage von 84.xxx");
  });
  it("appends the trusted hint", () => {
    expect(formatConnectionRequest({ ipPrefix: "84.xxx", country: "DE", trusted: true }))
      .toBe("Verbindungsanfrage aus Deutschland · 84.xxx · bekannter Helfer (frühere Verbindung)");
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet ROT**

Run: `cd sharer && npx vitest run tests/connect-format.test.ts`
Expected: FAIL — `../src/connect-format` existiert nicht.

- [ ] **Step 3: Helper implementieren**

Create `sharer/src/connect-format.ts`:

```ts
export interface PeerOrigin {
  ipPrefix: string;
  country: string | null;
  trusted: boolean;
}

/**
 * ISO-3166-1-alpha-2 → German region name via Intl.DisplayNames. Falls back to
 * the upper-cased code for unknown regions, and null for absent/invalid input.
 * No flag emoji on purpose — Windows does not render regional-indicator flags.
 */
export function countryName(iso: string | null): string | null {
  if (!iso || !/^[A-Za-z]{2}$/.test(iso)) return null;
  const code = iso.toUpperCase();
  try {
    const name = new Intl.DisplayNames(["de"], { type: "region" }).of(code);
    return name && name.toUpperCase() !== code ? name : code;
  } catch {
    return code;
  }
}

export function formatConnectionRequest(o: PeerOrigin): string {
  const name = countryName(o.country);
  const origin = name
    ? `Verbindungsanfrage aus ${name} · ${o.ipPrefix}`
    : `Verbindungsanfrage von ${o.ipPrefix}`;
  return o.trusted ? `${origin} · bekannter Helfer (frühere Verbindung)` : origin;
}
```

- [ ] **Step 4: Test grün**

Run: `cd sharer && npx vitest run tests/connect-format.test.ts`
Expected: PASS. (Node liefert volle ICU → `Intl.DisplayNames(['de'])` ist verfügbar.)

- [ ] **Step 5: In `main.ts` verdrahten**

Import oben ergänzen:
```ts
import { formatConnectionRequest } from "./connect-format.js";
```

Den `listen`-Typ (Zeile 651) erweitern:
```ts
listen<{ ipPrefix: string }>("peer-joined", async (e) => {
```
→
```ts
listen<{ ipPrefix: string; country: string | null }>("peer-joined", async (e) => {
```

Den Confirm-Text-Block (Zeilen 686–690) ersetzen:
```ts
  const trusted = await isTrustedPeer(e.payload.ipPrefix);
  confirmTextEl.textContent = trusted
    ? `Verbindungsanfrage von ${e.payload.ipPrefix} — bekannter Helfer (frühere Verbindung)`
    : `Verbindungsanfrage von ${e.payload.ipPrefix}`;
  rememberPeerCheckbox.checked = trusted;
```
→
```ts
  const trusted = await isTrustedPeer(e.payload.ipPrefix);
  confirmTextEl.textContent = formatConnectionRequest({
    ipPrefix: e.payload.ipPrefix,
    country: e.payload.country,
    trusted,
  });
  rememberPeerCheckbox.checked = trusted;
```
(Der `SECURITY:`-Kommentar oberhalb bleibt unverändert erhalten.)

- [ ] **Step 6: Sharer-JS-Tests + Typecheck grün**

Run: `cd sharer && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sharer/src/connect-format.ts sharer/tests/connect-format.test.ts sharer/src/main.ts
git commit -m "feat(sharer): show viewer country in the ad-hoc confirm dialog

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Docker — MMDB-Build-Stage + `GEOIP_DB_PATH`

**Files:**
- Modify: `backend/Dockerfile`

- [ ] **Step 1: Dedizierte `geoip`-Download-Stage hinzufügen**

In `backend/Dockerfile` vor der `runner`-Stage (nach Zeile 20) einfügen:

```dockerfile
# DB-IP IP-to-Country Lite (CC-BY-4.0). Pinned per month for reproducible
# builds; bump DBIP_MONTH monthly (see docs/ops-runbook.md). Build fails loudly
# if the pinned month 404s so a roll-off is noticed.
FROM alpine:3.23 AS geoip
ARG DBIP_MONTH=2026-06
WORKDIR /geoip
RUN wget -qO dbip.mmdb.gz "https://download.db-ip.com/free/dbip-country-lite-${DBIP_MONTH}.mmdb.gz" \
    && gunzip dbip.mmdb.gz \
    && test -s dbip.mmdb
```

- [ ] **Step 2: MMDB in die runner-Stage kopieren + Env setzen**

In der `runner`-Stage nach `COPY --from=builder /app/dist ./dist` (Zeile 26) ergänzen:

```dockerfile
COPY --from=geoip /geoip/dbip.mmdb /app/data/dbip-country-lite.mmdb
ENV GEOIP_DB_PATH=/app/data/dbip-country-lite.mmdb
```
(Die `chown -R app:app /app`-Zeile weiter unten deckt `/app/data` mit ab.)

- [ ] **Step 3: Docker-Build verifizieren**

Run: `cd backend && docker build -t auffi-backend-geoiptest .`
Expected: Build erfolgreich; die `geoip`-Stage lädt + entpackt die MMDB ohne Fehler. (Schlägt der Download fehl, ist der gepinnte Monat zu prüfen/zu erhöhen.)

- [ ] **Step 4: Lookup im Container smoke-testen**

Run: `docker run --rm auffi-backend-geoiptest node -e "const {openCountryDb,lookupCountry}=require('./dist/geoip.js'); const r=openCountryDb(process.env.GEOIP_DB_PATH); console.log(lookupCountry(r,'8.8.8.8'))"`
Expected: Ausgabe `US` (oder ein plausibler ISO-Code) — beweist, dass die reale MMDB im Image korrekt geladen + abgefragt wird.

- [ ] **Step 5: Commit**

```bash
git add backend/Dockerfile
git commit -m "build(backend): bundle DB-IP-Lite country MMDB into the image

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Lizenz-Attribution (CC-BY-4.0) + Doku

**Files:**
- Create: `NOTICE`
- Modify: `viewer/public/impressum/index.html`
- Modify: `docs/protocol.md`, `docs/footguns.md`, `docs/ops-runbook.md`, `docs/security-review-2026-05.md`

- [ ] **Step 1: `NOTICE`-Datei mit der DB-IP-Attribution anlegen**

Create `NOTICE`:

```
Auffi — third-party data attribution

IP-to-country geolocation data: IP-to-Country Lite by DB-IP (https://db-ip.com),
licensed under Creative Commons Attribution 4.0 International (CC-BY-4.0).
```

- [ ] **Step 2: Attribution im Impressum sichtbar machen**

In `viewer/public/impressum/index.html` einen kurzen Abschnitt ergänzen (am Ende des Inhalts, vor `</main>`/Footer), z. B.:

```html
        <h2>Datenquellen</h2>
        <p>
          IP-Geolokalisierung (Land) auf Basis von
          <a href="https://db-ip.com" rel="noopener" target="_blank">IP-to-Country Lite by DB-IP</a>,
          lizenziert unter <a href="https://creativecommons.org/licenses/by/4.0/" rel="noopener" target="_blank">CC-BY-4.0</a>.
        </p>
```
(Vorher die bestehende Überschriften-/Klassen-Struktur der Seite kurz prüfen und das Markup daran angleichen.)

- [ ] **Step 3: Protokoll-Doku — `viewerInfo.country` ist jetzt befüllt**

In `docs/protocol.md` beim `peer-joined`-Eintrag dokumentieren: `viewerInfo.country` = ISO-3166-1-alpha-2 des Viewer-Landes oder `null` (Lookup serverseitig lokal, kein Third-Party-Call; nur im Ad-hoc-Pfad gesetzt, Unattended bleibt `null`).

- [ ] **Step 4: Footguns + Ops-Runbook**

- `docs/footguns.md`: kurzer Abschnitt „GeoIP" — Modul `geoip.ts`, MMDB im Image unter `GEOIP_DB_PATH`, graceful Degradation auf `null`, lokal (ohne Docker) deaktiviert.
- `docs/ops-runbook.md`: „GeoIP-MMDB-Bump" — `DBIP_MONTH`-Build-ARG monatlich erhöhen; Build schlägt fehl, wenn der Monat 404t.

- [ ] **Step 5: Security-Review-Notiz (DSGVO)**

In `docs/security-review-2026-05.md` festhalten: Land-Lookup ist lokal (volle IP verlässt die VPS nicht, kein Dritter), das Land wird nur live an den Sharer für den Confirm gesendet und **nicht** geloggt/persistiert; MMDB = statische Referenzdaten (keine Retention-Policy nötig).

- [ ] **Step 6: Commit**

```bash
git add NOTICE viewer/public/impressum/index.html docs
git commit -m "docs: attribute DB-IP (CC-BY-4.0) + document geoip path/retention

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: End-to-End-Verifikation

- [ ] **Step 1: Alle Gates grün**

Run nacheinander:
- `cd backend && npm test && npx tsc --noEmit`
- `cd sharer && npx vitest run && npx tsc --noEmit`
- `cd sharer/src-tauri && cargo test --lib && cargo clippy --lib --tests -- -D warnings` (Windows-Host: vorher `export VCPKG_ROOT=C:/tools/vcpkg`)

Expected: überall PASS.

- [ ] **Step 2: Manueller Smoke-Test (UI)**

Sharer starten (`cd sharer && npm run tauri:dev`), eine echte Verbindung mit einem Viewer aufbauen und prüfen: Der Confirm-Dialog zeigt „Verbindungsanfrage aus &lt;Land&gt; · &lt;ip&gt;.xxx". Ohne geladene MMDB (lokaler Dev-Build) muss der Dialog sauber auf „Verbindungsanfrage von &lt;ip&gt;.xxx" zurückfallen.

---

## Self-Review (Plan B)

**Spec-Coverage (Teil B):** `geoip.ts` + DI-Tests (Task 2) ✓, Signaling-Wiring (Task 3) ✓, Rust un-ignore + emit (Task 4) ✓, Sharer-Helper + UI (Task 5) ✓, MMDB-Delivery (Task 6) ✓, Attribution + Doku (Task 7) ✓, Verifikation (Task 8) ✓. Scope-Grenzen gewahrt: nur Ad-hoc-Pfad, kein Datacenter/VPN-Flag, kein Flag-Emoji.

**Placeholder-Scan:** Neue Module/Tests/Helper sind als vollständiger Code gezeigt; Edits als exakte alt→neu-Blöcke mit Zeilenankern. Die zwei „Struktur kurz prüfen"-Hinweise (Impressum-Markup, signaling-Testaufbau) betreffen Anpassung an bestehendes Markup/Testmuster, nicht unspezifizierte Logik.

**Typkonsistenz:** `CountryLookup`/`lookupCountry`/`openCountryDb` (Task 2) werden in Task 3 mit exakt dieser Signatur konsumiert; `country: string | null` ist über Backend-`protocol.ts` (bereits vorhanden), Rust `ViewerInfo.country: Option<String>` (Task 4) und das `main.ts`-`listen`-Generic (Task 5) durchgängig konsistent. `PeerOrigin`/`countryName`/`formatConnectionRequest` (Task 5) matchen Test und Aufrufstelle.

**Abhängigkeit zwischen den Plänen:** Plan A und Plan B sind unabhängig und können in beliebiger Reihenfolge / parallel umgesetzt werden — sie berühren keine gemeinsamen Codezeilen (A entfernt Burn/`code-expired`, B fügt geoip/country hinzu). Beide leben auf dem Branch `feat/confirm-geo-context-burn-cleanup`.
