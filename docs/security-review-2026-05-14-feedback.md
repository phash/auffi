# Auffi Security Review — 2026-05-14 (Feedback-Feature)

Scope: das gh#39-Feedback-Feature und seine Begleit-Surfaces — neue Backend-Endpunkte, Datenbank-Migration, Dashboard-FAB, Sharer-Tauri-Command, Admin-UI, plus die heutigen kleineren Surface-Erweiterungen (`/download/`-Landing-Seite, AGPL-Relizenzierung, viewer Collapse-Toggle).

Referenz-Commits: `a2b87b8`, `581996e`, `a9cbcbb`, `5b3cd1b`. Baseline: das 2026-05-13-Review (`security-review-2026-05.md`).

---

## TL;DR

| Severity | Count | Files |
|---|---|---|
| Critical | 0 | — |
| High     | 0 | — |
| Medium   | 0 | — |
| Low      | 3 | backend/migrations, purge.ts, backend/src/admin/feedback.ts |
| Info     | 4 | mailer, FAB, sharer-bearer-path, audit-log scope |

Keine blockierenden Findings. Empfehlung: die drei Low-Items in einem Follow-up-Sprint, die Info-Items sind dokumentiert-und-ok.

---

## 1. Routen-Surface

### `POST /api/feedback` — Dual-Auth (Cookie ODER Bearer)

**Auth-Resolution** (`backend/src/feedback/handlers.ts:91-117`):

| Request-Shape | Auth-Pfad | Verifikation |
|---|---|---|
| `body.source = "dashboard"` | `readSessionCookie` → `findSession` | sha256-Lookup in `sessions.token_hash`, account-soft-delete-Gate |
| `body.source = "sharer"`     | `parseBearerAuth` → `verifyBearerAuth` | shape-regex + argon2id-Verify gegen `devices.token_hash` |
| beide fehlen / nicht passend | 401 `no-auth` | — |

**Verified-Good:**

- Source-Spoofing-Schutz: ein Dashboard-User mit Session-Cookie kann nicht `source: "sharer"` setzen, weil der Bearer-Pfad ohne `Authorization`-Header 401 wirft — und ein Sharer kann nicht `source: "dashboard"` setzen, weil kein Session-Cookie da ist. Body-Field UND Auth-Modus müssen übereinstimmen.
- `account_id` für Sharer-Pfad wird aus `devices.owner_account_id` abgeleitet (`handlers.ts:117`), nicht vom Client gesetzt — IDOR-frei.
- Validation **vor** Auth-Resolution (`parseSubmitBody` läuft zuerst) — invalides Payload triggert keinen argon2-Roundtrip.
- Rate-Limit `20/min/IP` (`handlers.ts:34`) liegt **vor** dem argon2-Verify (Fastify-Preview-Hook), Abuse-Window für argon2-CPU-Burn ist gedeckelt.
- Body-Trim + Length-Cap auf 4000 Zeichen (`parseSubmitBody:103-108`).
- `parseInt`/`Number.isInteger` für `rating` lehnt `"3"`, `3.5`, `NaN`, `Infinity` ab — 6 Regression-Tests.
- CHECK-Constraints in der DB (`CHECK source IN ('dashboard','sharer')` etc.) — Defense-in-Depth gegen Bugs in der TS-Validation.

**CSRF-Surface:**

- `dashboard`-Pfad: Session-Cookie ist `__Host-auffi_session` mit `SameSite=Strict` (Sec L-1, bestehend). Cross-Site-POST trägt den Cookie nicht mit. ✓
- `sharer`-Pfad: Bearer-Token im `Authorization`-Header. Lebt im Keyring des Sharer-Prozesses, Webview hat keinen Zugriff. CSRF nicht anwendbar.

### `GET /api/admin/feedback?status=…&cursor=…&limit=…`

Gate: `[requireSession, requireAdmin]` — beide bekannte Middleware aus `2026-05-13`-Review. `requireAdmin` hängt sich AFTER `requireSession`, liest `accounts.admin = 1` und 403'd Non-Admins.

| Aspekt | Check |
|---|---|
| Pagination | id-cursor, `WHERE f.id < ?` — monotonic, kein Skip-Cursor-Trick |
| Limit | `Math.max(1, Math.min(rawLimit, 200))` — geclamped (`MAX_LIMIT=200`) |
| Status-Filter | nur drei whitelist-Werte, sonst 400 `bad-status` |
| Email-Join | `accounts.email` wird einmal pro Row mit-selectet; Admin sieht die Adresse für mailto-Reply |

**Info I-1:** der Email-Join liefert Plain-Text-Emails an die Admin-UI. Das ist gewollt (mailto-Reply-Button). Auf einer Multi-Tenant-Instanz mit nicht-zu-trauenden Admins müsste man die Sicht eines Admins auf die eigenen Account-IDs einschränken. Aktuell ist „Admin" eine vom Hauptbetreiber kontrollierte Rolle (über `INITIAL_ADMIN_EMAIL` oder manuelle DB-Promotion), daher okay.

### `PATCH /api/admin/feedback/:id` — Resolved-Toggle

- Body-Schema: `{ resolved: boolean }`. Andere Typen → 400.
- ID-Validation: `Number.isInteger && > 0`, sonst 400.
- 404 bei unbekannter ID — leak-frei (gleicher Code für „existiert nicht" und „existiert in anderem Account").
- **Audit-Log**: `writeAudit(db, req, 'feedback.resolve'|'feedback.reopen', 'feedback', id, before, after)` mit dem alten und neuen `resolved_at`. Vor dem UPDATE — Race zwischen Audit und Mutation ist im Test gepinnt.

### `DELETE /api/admin/feedback/:id` — Hard-Delete

**Verified-Good:**

- Audit-Log **vor** `DELETE`, mit komplettem Row-Snapshot in `before_json` (inkl. body-Text). Forensik möglich nach Löschung. (`admin/feedback.ts:152-163`)
- Audit-Log-Eintrag mit `action = 'feedback.delete'` ist getestet (`tests/feedback.test.ts:299-312`).
- 404 bei unbekannter ID → leak-frei.

---

## 2. Datenbank-Migration 0007

```sql
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('dashboard', 'sharer')),
  category TEXT NOT NULL CHECK (category IN ('bug', 'feature', 'praise', 'other')),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL,
  user_agent_hint TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX idx_feedback_created_at ON feedback(created_at DESC);
CREATE INDEX idx_feedback_resolved_at ON feedback(resolved_at);
```

**Verified-Good:**

- FK CASCADE auf `account_id` → wenn ein User gemäß DSGVO Recht-auf-Vergessenwerden ausgeübt wird, gehen seine Feedback-Rows mit.
- Drei CHECK-Constraints decken alle vier validation-relevanten Felder.
- Indexe stützen die `ORDER BY id DESC` + `resolved_at IS NULL` Filter ohne Tablescan.

**Low L-1 (DSGVO):** Keine **Retention-Policy** für `feedback`-Rows. Andere Tables (sessions, device_pairings, email_verifications, connection_log, audit_log) werden in `backend/src/purge.ts` periodisch gepurged; feedback-Rows wachsen bis zur händischen Admin-Action. Bei einer aktiven Userbase wird das problematisch — sowohl DSGVO (Daten-Minimierung) als auch operativ (DB-Tabelle wächst unbeschränkt).

**Recommendation:** Auto-purge nach 1 Jahr für `resolved_at IS NOT NULL AND resolved_at < now - 365d`, plus harter Cap für offen-aber-uralt (z.B. 2 Jahre). Eintrag in `purge.ts`, ergänze `PurgeRetention.feedbackResolvedMs` + `feedbackOpenMaxMs`.

**Low L-2 (Daten-Minimierung):** `user_agent_hint` wird mit voller 200-Char-UA gespeichert. Das ist mehr Browser-Fingerprint als nötig, um „aus welcher Umgebung kam das Feedback" abzuleiten. Empfehlung: vor dem `INSERT` auf `[Browser-Family, OS-Family]` reduzieren (z.B. mit `ua-parser-js` oder einer 50-Zeilen-Regex). Heute steht z.B. `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36` in der DB; sinnvoller wäre `Chrome/Linux`.

---

## 3. Dashboard-FAB + Modal

`dashboard/src/components/feedback-fab.ts` baut das gesamte Modal über DOM-API (createElement / setAttribute / textContent) **ohne `innerHTML`**. Eine Security-Hook hat den ersten Wurf abgefangen und ich habe alles auf safe DOM-Methoden umgestellt.

**Verified-Good:**

- Body-Render im Admin-View: `body.textContent = item.body` (`admin-feedback.ts:135`) — `<script>`-Inhalte landen als Text, nicht als Markup. ✓
- Toast-Render: `toast.textContent = message`, message ist hard-coded „Danke fürs Feedback!".
- Mailto-Link wird `encodeURIComponent`'d (`admin-feedback.ts:168-171`) — keine Header-Injection in `mailto:to?subject=…&body=…`.
- Quote-Body in der Mail: `body.split("\n").map(l => '> ' + l)` — Markdown-quote-style, kein HTML-Escape nötig, weil `mailto:` als text/plain interpretiert wird.

**Info I-2:** Der Toast verwendet `alert()` für PATCH/DELETE-Fehler (`admin-feedback.ts:154, 200`). Funktioniert, ist aber visually wenig konsistent mit der restlichen Dashboard-UX. Cosmetic — nicht security-relevant.

---

## 4. Sharer-Webview + Tauri-Command

`sharer/src/feedback-fab.ts` mounted nur wenn `(paired AND password-set)` — Ad-hoc-Sharer-User sehen den FAB nicht. Refresh über `auffi-unattended-state-changed` Custom-Event.

`unattended_submit_feedback` (Rust, `sharer/src-tauri/src/unattended_cmd.rs:340-409`):

- **Webview kennt keine Tokens.** Token lebt im Keyring des OS, gelesen via `KeyringTokenStore`. Webview übergibt nur `category`, `rating`, `body` an die Tauri-Bridge.
- **Lokale Validation vor Network-Roundtrip:** category-whitelist, rating in 1..5, body 1..4000 (getrimmt). Spart eine Round-Trip im Fehlerfall + entlastet das Backend.
- **HTTP-Client:** `reqwest::Client::builder().timeout(10s).build()` — explizit pro Call neu, nicht global. Kein Connection-Pooling über Calls hinweg, aber 1 Request/Klick ist sowieso selten.
- **TLS:** `mail.mr-development.de`-Style — nutzt System-Roots, kein `danger_accept_invalid_certs`. Standard-reqwest = OK.
- **Fehler-Surface:** Backend-Response-Body wird auf 200 Chars geclampt vor dem Surfacing in die Tauri-Error-String — kein verbose-HTML-Spill in die UI.

**Info I-3 (Threat-Modell):** Wer Webview-Code injizieren kann (was bedeutet: vollständige Tauri-Compromise), kann beliebige Feedback-Posts triggern. Aber jeder Tauri-Compromise ist sowieso fatal — der Angreifer hätte da bereits Keyring-Zugriff. Diese Surface erweitert das nicht.

---

## 5. Download-Seite + AGPL-Relizenzierung

`/download/` ist eine reine Static-HTML-Page:

- **Keine inline Scripts.** Die CSP `script-src 'self'` (+ JSON-LD-Hashes für die Viewer-Hauptseite) blockt eh alles andere; die Download-Page hat gar keine Scripts.
- **Keine Form-Inputs.** Nur Download-Anchors zu `*.deb`, `*.rpm` (gleicher Origin → keine CORS-Pufferung).
- **Externe Links** (`github.com/phash/auffi`) tragen `rel="noopener noreferrer"`. ✓
- **MIME-Sniffing-Schutz:** Caddy setzt `X-Content-Type-Options: nosniff` global. Die Binaries werden mit `application/octet-stream` oder `application/x-deb` etc. ausgeliefert (nginx default-mapping).

**Info I-4 (Caddyfile, Cluster):** Wenn die Cluster-Caddy für `/download/*` keine spezielle Cache-Control setzt, übernehmen die statischen Files den `Cache-Control: public, max-age=300` aus `nginx/auffi-viewer.conf:39`. Versions-Bumps in `latest.txt` propagieren also innerhalb 5 Min. Sauber genug für eine Free-Tier-Free-Download-Seite.

AGPL-Switch ist eine reine Lizenz-Frage, keine code-side Security-Implication.

---

## 6. Compact-Bar (`viewer/src/compact-bar.ts`)

Keine Network-Surface — rein client-side UI-Toggle.

- `localStorage`-Key `auffi.viewer.compactBar.collapsed` speichert genau "0" / "1". Keine User-Content-Injection.
- `getBytes()`-Closure ruft `peer.getInboundBytes()` auf — `peer.pc.getStats()` ist eine WebRTC-API, kein Network-Call.
- `formatDuration` / `formatBytes` sind pure functions, 15 Regression-Tests.

**Verified-Good.**

---

## 7. Findings Summary

| Severity | ID | Datei | Issue |
|---|---|---|---|
| Low | L-1 | `backend/src/purge.ts` | Keine Retention-Policy für `feedback`-Rows |
| Low | L-2 | `backend/src/feedback/handlers.ts:52` | `user_agent_hint` mit voller UA gespeichert — sollte auf `Family/OS` reduziert werden |
| Low | L-3 | `backend/src/admin/feedback.ts` | Audit-Log könnte zusätzlich PATCH-Operationen mit dem aktuellen body-Snapshot stempeln (nicht nur `resolved_at`-Diff) |
| Info | I-1 | `backend/src/admin/feedback.ts:74` | Email-Klartext im Admin-Response-Body — okay für Single-Tenant, neu zu bewerten falls Multi-Admin |
| Info | I-2 | `dashboard/src/views/admin-feedback.ts:154,200` | `alert()` für Fehler — UX-cosmetic |
| Info | I-3 | sharer-Bearer-Pfad | Bei voller Tauri-Compromise kann Feedback gespammed werden; nicht zusätzlich exploitable |
| Info | I-4 | nginx `/download/`-Block | `Cache-Control: public, max-age=300` — 5 min Propagation für Versions-Bumps |

**Keine High / Critical Findings.** Das Feedback-Feature respektiert die bestehenden Patterns aus der `2026-05-13`-Review (argon2id, `__Host-` Cookies, Audit-Log, requireSession+requireAdmin-Chain, Body-Length-Limits, Rate-Limits-vor-CPU-Cost, sha256-only-storage).

---

## 8. Empfohlene Follow-ups

1. **L-1 (priorität: mittel):** `purge.ts` um eine `feedback`-Branch erweitern. Quick Win, eine Stunde Arbeit + zwei Tests.
2. **L-2 (priorität: niedrig):** `truncateUserAgent` Helper, vor `INSERT`. Hat Auswirkung auf Admin-View (UA-Hint wird kürzer angezeigt) — nicht funktional kritisch.
3. **L-3 (priorität: niedrig):** PATCH-Audit erweitern, wenn die Resolve/Reopen-Flows wirklich ausgewertet werden. Aktuell sind die before/after-Snapshots minimal, weil sich nur ein Feld ändert.

Die drei Low-Items sind alle „operational cleanliness" — kein Angriffsvektor schlummert dahinter.
