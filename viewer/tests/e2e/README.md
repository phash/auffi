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
