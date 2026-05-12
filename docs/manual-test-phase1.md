# Phase 1 Manual Smoke Test — Auffi (formerly Screenie)

## Setup

Three terminals.

**Terminal 1 — Backend:**
```bash
cd backend && npm run dev
```
Expected: `Listening on 0.0.0.0:8080`.

**Terminal 2 — Sharer (Tauri):**
```bash
cd sharer && npm run tauri:dev
```
Expected: native window opens, displays a 9-digit code like `284-915-073`. Status: "Warte auf Verbindung…".

**Terminal 3 — Viewer (Browser):**
```bash
cd viewer && npm run dev
```
Open http://localhost:5173.

## Test Cases

### TC1 — Happy path
1. Read code from sharer window.
2. Type it into viewer's input. Format should auto-add dashes.
3. Click "Verbinden".
4. Expected: sharer window shows confirmation dialog with "Verbindungsanfrage von 127.x".
5. Click "Verbinden zulassen" in sharer.
6. Expected: viewer status shows "Verbunden mit Sharer. (Phase 1: kein Video — sende Test-Relay)".
7. Expected: sharer status shows "Verbunden. Relay empfangen: ...".

### TC2 — Decline
1. Repeat steps 1–4 of TC1.
2. Click "Ablehnen".
3. Expected: viewer status shows "Verbindung beendet: declined".

### TC3 — Invalid code
1. Type `000-000-000` in viewer.
2. Click "Verbinden".
3. Expected: viewer status shows "Fehler: invalid-code: no such session".

### TC4 — Sharer leaves
1. Complete TC1 happy path.
2. Close sharer window.
3. Expected: viewer status shows "Verbindung beendet: sharer-gone".

### TC5 — Rate limit
1. With no sharer running, type any 9 digits in viewer.
2. Click "Verbinden". Expected: "invalid-code".
3. Repeat 6 times rapidly.
4. Expected: after 5 attempts, error message becomes "rate-limit: too many attempts".

## Pass Criteria
- All 5 test cases pass.
- No console errors in browser DevTools (warnings ok).
- Backend logs show clean WebSocket open/close, no exceptions.

---

**Phase 1 Status:** Document only; manual smoke test pending on host with webkit2gtk-4.1 installed (Linux dev box) — to be run before declaring Phase 1 fully complete.
