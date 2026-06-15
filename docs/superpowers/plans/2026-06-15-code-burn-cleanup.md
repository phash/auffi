# Code-Burn-Cleanup + ehrliche Security-Claims — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die nie-feuernde Ad-hoc-Code-Burn-Maschinerie restlos entfernen und die dadurch faktisch falsche öffentliche „nach 5 Fehlversuchen verbrannt"-Security-Aussage auf die akkurate Story (Per-IP-Rate-Limit + 10-min-TTL + zwingende manuelle Bestätigung) umschreiben.

**Architecture:** Reine Subtraktion im Backend (`codes.ts`, `signaling.ts`, `server.ts`, `protocol.ts`) + im Viewer (`protocol.ts`, `connect-messages.ts`, `i18n.ts`), gefolgt von Copy-Korrekturen in 6 statischen Public-Dateien und der internen Doku. Kein neues Laufzeitverhalten — nur Entfernen von totem Code und Angleichen von Aussagen an die Realität.

**Tech Stack:** TypeScript (Vitest), statisches HTML/JSON-LD, Markdown.

**Referenz-Spec:** `docs/superpowers/specs/2026-06-15-confirm-context-und-burn-cleanup-design.md` (Teil A).

---

### Task 1: Burn-Tests aus `codes.test.ts` entfernen (Red-Schritt für eine Entfernung)

**Files:**
- Test: `backend/tests/codes.test.ts`

- [ ] **Step 1: Burn-spezifische Tests löschen**

Entferne den kompletten Test `it("burns code after maxAttempts failed joins", ...)` (um Zeile 84–91) und `it("recordFailedAttempt returns false for unknown code", ...)` (um Zeile 150–152).

- [ ] **Step 2: `maxAttempts` aus allen verbleibenden `new SessionStore({...})`-Aufrufen entfernen**

In jeder verbliebenen Zeile `new SessionStore({ ttlMs: ..., maxAttempts: N })` → `new SessionStore({ ttlMs: ... })`. Betroffen sind die Konstruktoraufrufe bei den Zeilen 57, 64, 72, 77, 95, 103, 111, 121, 126, 139, 159, 170, 177, 193, 202 (jeweils das `, maxAttempts: 5`- bzw. `, maxAttempts: 3`-Fragment streichen; bei Step-77 ist es `ttlMs: 50`).

- [ ] **Step 3: Test laufen lassen — erwartet ROT (Compile-Fehler)**

Run: `cd backend && npx vitest run tests/codes.test.ts`
Expected: FAIL — TypeScript/Vitest meldet, dass `maxAttempts` im `StoreConfig` noch Pflicht ist bzw. `recordFailedAttempt` noch existiert (Typen passen noch nicht). Das ist der erwartete Red-Zustand vor der Code-Entfernung.

---

### Task 2: Burn-Maschinerie aus `codes.ts` entfernen

**Files:**
- Modify: `backend/src/codes.ts`

- [ ] **Step 1: `failedAttempts` aus dem `Session`-Type entfernen**

In `Session` (um Zeile 19–26) die Zeile `failedAttempts: number;` streichen.

- [ ] **Step 2: `maxAttempts` aus `StoreConfig` entfernen**

In `StoreConfig` (um Zeile 28–38) die Zeile `maxAttempts: number;` streichen.

- [ ] **Step 3: `failedAttempts`-Initialisierung in `registerSharer` entfernen**

Im `session`-Objektliteral in `registerSharer` (um Zeile 60–67) die Zeile `failedAttempts: 0,` streichen.

- [ ] **Step 4: `recordFailedAttempt` ganz löschen**

Die komplette Methode entfernen:

```ts
  recordFailedAttempt(code: string): boolean {
    const session = this.sessions.get(code);
    if (!session) return false;
    session.failedAttempts += 1;
    if (session.failedAttempts >= this.cfg.maxAttempts) {
      this.dropSession(session);
      return true;
    }
    return false;
  }
```

- [ ] **Step 5: `codes.test.ts` grün**

Run: `cd backend && npx vitest run tests/codes.test.ts`
Expected: PASS — alle verbliebenen SessionStore-Tests grün, keine `maxAttempts`/`recordFailedAttempt`-Referenz mehr.

- [ ] **Step 6: Commit**

```bash
git add backend/src/codes.ts backend/tests/codes.test.ts
git commit -m "refactor(backend): remove never-firing ad-hoc code-burn machinery

recordFailedAttempt was only ever called for unknown codes (signaling.ts
!session branch), where it is a no-op — the burn never fired in the live
ad-hoc path. Per-IP rate-limit + 10-min TTL are the real brute-force bound.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `signaling.ts` — toten Burn-/`code-expired`-Zweig entfernen

**Files:**
- Modify: `backend/src/signaling.ts` (um Zeile 427–436)
- Test: `backend/tests/signaling.test.ts`

- [ ] **Step 1: `signaling.test.ts` auf Burn/`code-expired` prüfen und anpassen**

Run: `cd backend && grep -n "code-expired\|maxAttempts\|burned" tests/signaling.test.ts`
Entferne jede Assertion, die `code-expired` oder `burned` erwartet, und streiche `, maxAttempts: 5` aus den `new SessionStore(...)`-Aufrufen (Zeilen 373, 435).

- [ ] **Step 2: Den `recordFailedAttempt`-Block durch ein schlichtes `invalid-code` ersetzen**

Ersetze in `signaling.ts` (im `!session`-Zweig des Viewer-Join):

```ts
          // recordFailedAttempt is a no-op when no session exists (the code is
          // simply unknown), so `burned` will be false here. The branch below
          // only fires when a real session's attempt budget is exhausted.
          const burned = store.recordFailedAttempt(normalized);
          send(peer, {
            type: "error",
            code: burned ? "code-expired" : "invalid-code",
            message: burned ? "code burned after too many attempts" : "no such session",
          });
          peer.close();
          return;
```

durch:

```ts
          send(peer, { type: "error", code: "invalid-code", message: "no such session" });
          peer.close();
          return;
```

- [ ] **Step 3: Backend-Tests grün**

Run: `cd backend && npx vitest run tests/signaling.test.ts tests/codes.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/signaling.ts backend/tests/signaling.test.ts
git commit -m "refactor(backend): drop dead code-expired branch from viewer-join

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `server.ts` + Env — `maxAttempts` / `MAX_FAILED_ATTEMPTS` entfernen

**Files:**
- Modify: `backend/src/server.ts` (Zeilen 83 und 219–221)
- Prüfen: `docker-compose*.yml`, `backend/.env.example`, `ops/`

- [ ] **Step 1: `maxAttempts` aus dem SessionStore-Konstruktor entfernen**

In `server.ts` (um Zeile 219–221):

```ts
  const store = new SessionStore({
    ttlMs: codeTtlMs,
    maxAttempts: env.maxFailedAttempts,
    onCodeCreated: () => {
```
→
```ts
  const store = new SessionStore({
    ttlMs: codeTtlMs,
    onCodeCreated: () => {
```

- [ ] **Step 2: `maxFailedAttempts`-Env aus `readEnvConfig` entfernen**

In `server.ts` Zeile 83 die Zeile `maxFailedAttempts: envNumber("MAX_FAILED_ATTEMPTS", 5),` streichen.

- [ ] **Step 3: Auf verbliebene `MAX_FAILED_ATTEMPTS`-Referenzen prüfen**

Run: `cd /e/claude/screenie && grep -rn "MAX_FAILED_ATTEMPTS\|maxFailedAttempts" --include="*.yml" --include="*.yaml" --include="*.example" --include="*.sh" --include="*.env" . | grep -v node_modules`
Falls Treffer in `docker-compose*.yml` / `.env.example` / `ops/` → dort die Zeile ebenfalls entfernen. (Kein Treffer = nichts zu tun.)

- [ ] **Step 4: Typecheck + Tests**

Run: `cd backend && npx tsc --noEmit && npm test`
Expected: PASS, kein `maxFailedAttempts`/`maxAttempts` mehr referenziert.

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts
git commit -m "refactor(backend): remove MAX_FAILED_ATTEMPTS env + maxAttempts wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `code-expired` aus dem Wire-Protokoll (Backend) entfernen

**Files:**
- Modify: `backend/src/protocol.ts:49`
- Modify: `docs/protocol.md`

- [ ] **Step 1: `ErrorMessage`-Union kürzen**

In `backend/src/protocol.ts` (Zeile 47–51):

```ts
export type ErrorMessage = {
  type: "error";
  code: "invalid-code" | "code-expired" | "rate-limit" | "bad-message";
  message: string;
};
```
→
```ts
export type ErrorMessage = {
  type: "error";
  code: "invalid-code" | "rate-limit" | "bad-message";
  message: string;
};
```

- [ ] **Step 2: `docs/protocol.md` angleichen**

Run: `cd /e/claude/screenie && grep -n "code-expired" docs/protocol.md`
Jeden `code-expired`-Eintrag entfernen bzw. die Error-Code-Tabelle/-Liste auf `invalid-code | rate-limit | bad-message` reduzieren.

- [ ] **Step 3: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/src/protocol.ts docs/protocol.md
git commit -m "docs(protocol): drop code-expired error code (burn removed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `code-expired` aus dem Viewer entfernen

**Files:**
- Test: `viewer/tests/connect-messages.test.ts:54-58`
- Modify: `viewer/src/connect-messages.ts` (Zeilen 50–51, 61–66)
- Modify: `viewer/src/protocol.ts:76`
- Modify: `viewer/src/i18n.ts` (Zeilen 71 und 121)

- [ ] **Step 1: Den `code-expired`-Test löschen (Red für eine Entfernung)**

Entferne in `viewer/tests/connect-messages.test.ts` den Test `it("maps a burned code (code-expired) to a 'too many attempts' message", ...)` (um Zeile 54–58).

- [ ] **Step 2: `case "code-expired"` aus `fromErrorCode` entfernen**

In `connect-messages.ts` (Zeile 50–51) streichen:

```ts
    case "code-expired":
      return { text: t("join.codeExpired", {}, lang), kind: "err" };
```

- [ ] **Step 3: `code-expired` aus `KNOWN_ERROR_CODES` entfernen**

In `connect-messages.ts` (Zeile 61–66) die Zeile `"code-expired",` aus dem Set streichen.

- [ ] **Step 4: `ErrorMessage`-Union im Viewer kürzen**

In `viewer/src/protocol.ts` Zeile 76:
`code: "invalid-code" | "code-expired" | "rate-limit" | "bad-message";`
→ `code: "invalid-code" | "rate-limit" | "bad-message";`

- [ ] **Step 5: `join.codeExpired`-Catalog-Einträge entfernen**

In `viewer/src/i18n.ts` die DE-Zeile 71 (`"join.codeExpired": "Der Code wurde nach zu vielen Fehlversuchen gesperrt. ..."`) und die EN-Zeile 121 (`"join.codeExpired": "The code was locked after too many failed attempts. ..."`) streichen.

- [ ] **Step 6: Viewer-Tests + Typecheck grün**

Run: `cd viewer && npx tsc --noEmit && npm test`
Expected: PASS, keine `codeExpired`/`code-expired`-Referenz mehr.

- [ ] **Step 7: Commit**

```bash
git add viewer/src/connect-messages.ts viewer/src/protocol.ts viewer/src/i18n.ts viewer/tests/connect-messages.test.ts
git commit -m "refactor(viewer): remove code-expired handling (server no longer sends it)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Öffentliche Security-Claims auf die akkurate Story umschreiben

**Files:**
- Modify: `viewer/public/vergleich/anydesk/index.html` (Zeilen 93, 187, 205)
- Modify: `viewer/public/vergleich/teamviewer/index.html` (Zeile 93, 184 + „Wie sicher"-Body-Absatz)
- Modify: `viewer/public/en/compare/anydesk/index.html` (Zeilen 96, 189, 207)
- Modify: `viewer/public/en/compare/teamviewer/index.html` (Zeile 96, 187 + „How secure"-Body-Absatz)
- Modify: `viewer/public/datenschutz/index.html` (Zeilen 155–157)
- Modify: `viewer/public/llms.txt:27`

> **Wichtig:** Die Burn-Behauptung steht in den Vergleichsseiten **mehrfach** (JSON-LD-`acceptedAnswer` + sichtbarer „Wie sicher"-Absatz + Stichpunkt-Liste). Vor dem Editieren je Datei `grep -n -i "fehlversuch\|verbrannt\|gesperrt\|burned\|after 5\|failed attempt"` laufen lassen und **alle** Vorkommen ersetzen.

- [ ] **Step 1: DE-Stichpunkt-Liste (anydesk:187, teamviewer:184)**

`<li><strong>9-stelliger Verbindungscode</strong>, 10 Minuten gültig, nach 5 Fehlversuchen serverseitig gesperrt.</li>`
→
`<li><strong>9-stelliger Verbindungscode</strong>, 10 Minuten gültig, serverseitig gegen Rateraten gedrosselt (Rate-Limit pro IP).</li>`

- [ ] **Step 2: DE „Wie sicher"-Antwort (JSON-LD `acceptedAnswer` + Body-Absatz, anydesk:93/205, teamviewer:93 + Body)**

Ersetze (jedes Vorkommen, sowohl im JSON-LD-String als auch im sichtbaren `<p>`):

alt: `Jeder Stream ist Ende-zu-Ende mit DTLS-SRTP verschlüsselt (WebRTC). Der Code läuft nach 10 Minuten ab und wird nach 5 Fehlversuchen serverseitig gesperrt. Der Server vermittelt nur den Verbindungsaufbau — Bild, Maus und Dateien fließen direkt zwischen den Geräten (Peer-to-Peer).`

neu: `Jeder Stream ist Ende-zu-Ende mit DTLS-SRTP verschlüsselt (WebRTC). Der 9-stellige Code läuft nach 10 Minuten ab, der Server drosselt Verbindungsversuche serverseitig (Rate-Limit pro IP), und der Teilende bestätigt jede Verbindung aktiv. Der Server vermittelt nur den Verbindungsaufbau — Bild, Maus und Dateien fließen direkt zwischen den Geräten (Peer-to-Peer).`

- [ ] **Step 3: EN-Stichpunkt-Liste (en/compare/anydesk:189, en/compare/teamviewer:187)**

`<li><strong>9-digit connection code</strong>, valid for 10 minutes, burned server-side after 5 failed attempts.</li>`
→
`<li><strong>9-digit connection code</strong>, valid for 10 minutes, server-side rate-limited against guessing.</li>`

- [ ] **Step 4: EN „How secure"-Antwort (JSON-LD + Body, en/compare/*:96/207)**

alt: `Every stream is end-to-end encrypted with DTLS-SRTP (WebRTC). The code expires after 10 minutes and is burned server-side after 5 failed attempts. The server only brokers the connection setup — video, mouse and files flow directly between the devices (peer-to-peer).`

neu: `Every stream is end-to-end encrypted with DTLS-SRTP (WebRTC). The 9-digit code expires after 10 minutes, the server rate-limits connection attempts, and the sharer actively confirms every connection. The server only brokers the connection setup — video, mouse and files flow directly between the devices (peer-to-peer).`

- [ ] **Step 5: Datenschutz-Seite (datenschutz:155–157)**

alt:
```html
            <strong>Code-Lebensdauer:</strong> 10 Minuten, danach
            serverseitig verworfen. Nach 5 Falscheingaben wird der Code
            sofort gesperrt.
```
neu:
```html
            <strong>Code-Lebensdauer:</strong> 10 Minuten, danach
            serverseitig verworfen. Verbindungsversuche werden serverseitig
            gedrosselt (Rate-Limit pro IP).
```

- [ ] **Step 6: `llms.txt:27`**

alt-Fragment: `Session-Codes 10 min TTL, nach 5 falschen Versuchen serverseitig verbrannt.`
neu-Fragment: `Session-Codes 10 min TTL, serverseitig gegen Rateraten gedrosselt (Rate-Limit pro IP), Sharer bestätigt jede Verbindung.`

- [ ] **Step 7: Verifizieren, dass keine Burn-Behauptung mehr steht**

Run: `cd /e/claude/screenie && grep -rn -i "fehlversuch\|verbrannt\|nach 5\|burned\|after 5 failed" viewer/public | grep -v node_modules`
Expected: keine Treffer mehr (außer evtl. unkritischen, die nicht die Burn-Behauptung sind — manuell prüfen).

- [ ] **Step 8: Commit**

```bash
git add viewer/public
git commit -m "docs(marketing): correct the false 'burned after 5 attempts' security claim

The ad-hoc code burn never fired; brute-force is bounded by the per-IP
rate-limit + 10-min TTL + mandatory sharer confirmation. Rewrites the claim
across comparison pages (body + JSON-LD), privacy page and llms.txt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Interne Doku + Test-Baseline angleichen

**Files:**
- Modify: `CLAUDE.md` (Product-Goal-3-Bullet + Test-Baseline-Zeile)
- Modify: `docs/security-review-2026-05.md`, `docs/security-review-2026-05-11.md`, `docs/security-review-2026-05-14-feedback.md` (nur falls sie die Burn-Behauptung enthalten)
- Modify: `docs/footguns.md` (nur falls relevant)

- [ ] **Step 1: CLAUDE.md Product-Goal-3 korrigieren**

In `CLAUDE.md` die Formulierung „Session codes are server-burned after 5 wrong attempts and TTL-capped at 10 minutes." ersetzen durch: „Session codes are bounded by a per-IP rate-limit (5/min) and TTL-capped at 10 minutes; the 5-attempt lockout applies to the password surfaces (account + per-device unattended), not the ad-hoc code."

- [ ] **Step 2: Security-Review-Docs prüfen/angleichen**

Run: `cd /e/claude/screenie && grep -rn -i "burn\|5 wrong\|5 fehl\|nach 5\|after 5" docs/security-review-2026-05*.md docs/footguns.md`
Jede Stelle, die den Ad-hoc-Code-Burn als wirksam beschreibt, auf die akkurate Story (Per-IP-Rate-Limit) korrigieren.

- [ ] **Step 3: Test-Baseline-Zahlen in CLAUDE.md nachziehen**

Run: `cd backend && npm test 2>&1 | tail -5` und `cd viewer && npm test 2>&1 | tail -5`
Die neuen Test-Zahlen ablesen und in der CLAUDE.md-„Definition of Done"-Baseline-Zeile (backend/viewer) aktualisieren (Burn-Tests entfernt → Backend- und Viewer-Counts sinken leicht).

- [ ] **Step 4: Volle Gates grün**

Run: `cd backend && npm test && npx tsc --noEmit` und `cd viewer && npm test && npx tsc --noEmit`
Expected: PASS in beiden.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs
git commit -m "docs: align internal docs + test baseline with code-burn removal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (Plan A)

**Spec-Coverage (Teil A):** Code-Entfernung backend (Task 2–4) ✓, Wire-Protokoll backend+viewer (Task 5–6) ✓, 6 öffentliche Claims (Task 7) ✓, interne Doku + Baseline (Task 8) ✓.

**Placeholder-Scan:** Alle Steps zeigen exakte alt→neu-Snippets oder exakte `grep`-Befehle; die HTML-„alle Vorkommen"-Stellen sind durch einen vorgeschalteten `grep` abgesichert (keine versteckten TODOs).

**Typkonsistenz:** `ErrorMessage`-Union wird in Backend (`protocol.ts`) und Viewer (`protocol.ts`) identisch auf `invalid-code | rate-limit | bad-message` reduziert; `code-expired` verschwindet überall synchron (Sender entfernt in Task 3, Typ in Task 5/6, Catalog in Task 6).
