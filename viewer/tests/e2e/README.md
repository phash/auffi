# Viewer E2E Tests

Prereqs (run in separate terminals before invoking the test):
1. Backend: `cd <repo-root> && docker compose up backend`
2. Viewer dev server: `cd viewer && npm run dev`
3. Mock sharer: spawned automatically by the test.

Then: `cd viewer && npx playwright test`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BACKEND_WS_URL` | `ws://localhost:8080/signal` | WebSocket URL of the signaling server |
| `VIEWER_URL` | `http://localhost:5173` | Base URL of the viewer dev server |
| `MANAGE_BACKEND` | unset | Set to `1` to let the test start/stop Docker backend |
| `MANAGE_VIEWER` | unset | Set to `1` to let the test start/stop the Vite dev server |

## Self-contained mode

To run everything from the test itself (no separate terminals needed):

```bash
cd viewer && MANAGE_BACKEND=1 MANAGE_VIEWER=1 npx playwright test
```

This requires Docker to be available and port 8080 + 5173 to be free.

## Production smoke (opt-in)

`production.spec.ts` runs against the live `auffi.app` and is skipped unless
`AUFFI_PROD_E2E=1` is set. Every run mints a real session code on the
production backend, which writes a permanent `code_events` row (the reliable
usage counter) and fires a Matomo `code_created` event — so it inflates real
usage statistics. Run it only for a deliberate diagnostic:

```bash
cd viewer && AUFFI_PROD_E2E=1 npx playwright test production.spec.ts
```

## Known gaps

Two unattended-access tiers have no e2e coverage yet:

- **Pairing-code roundtrip** (signup → verify → mint code → dashboard shows
  it): needs a `NODE_ENV=test`-only backend hook that exposes the captured
  verify-mail token (the backend already has `captureTransport`).
- **Full sharer-paired roundtrip** (mock unattended sharer pairs → viewer
  connects with `?code=` → password prompt → stream): needs a
  `scripts/mock-unattended-sharer.mjs` that speaks the pw-check protocol
  (docs/protocol.md, unattended message family).

Until both land, that flow is covered by the backend's
`unattended-connect.test.ts` and the viewer's `ui-password-prompt.test.ts`.
