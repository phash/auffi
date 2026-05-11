# Screenshare Phase 1 — Signaling-Skelett

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end Signaling-Pipeline. Sharer registriert sich beim Backend und bekommt einen 9-stelligen Code. Viewer tippt den Code ein, Backend matched die beiden. Sharer zeigt Bestätigungsdialog, bei "Ja" tauschen beide Peers eine Test-Nachricht aus. **Noch kein Screen-Capture, kein WebRTC-Media, kein Input — nur das Signaling-Rückgrat.**

**Architecture:** Backend = Node.js + Fastify + `ws`. Sharer = Tauri 2 (Rust + minimal Webview). Viewer = Vite + TS. Alle Peers reden dasselbe JSON-Protokoll über WSS. Backend-State ist In-Memory (Map), kein DB.

**Tech Stack:** Node.js 20 + TypeScript 5, Fastify 4, `ws` 8, Vitest. Tauri 2 + tokio-tungstenite (Rust). Vite 5 + vanilla TS für Viewer. Alle Versionen gepinnt. Backend läuft in Docker (multi-stage build).

**Version-Strategie:** Pinned-Versions im Plan sind Major-Pin-Guidance. Vor Install via `npm view <pkg> version` bzw. `cargo search <crate>` aktuelle Stable-Patch/Minor prüfen und exakt pinnen (kein `^`/`~`).

**Clean-Code-Verpflichtung:** Siehe `/CLAUDE.md`. Keine `as any`-Casts, keine Reichweite in private Member, keine TODO/FIXME, ≥ 70 % Coverage pro Package.

---

## File Structure (Phase 1)

```
screenshare/
├── CLAUDE.md                    # Project-Conventions (Clean Code, Docker, DSGVO)
├── docker-compose.yml           # Lokales Dev-Setup
├── .env.example                 # Konfigurations-Template
├── backend/
│   ├── Dockerfile               # Multi-stage build (deps → builder → runner)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts             # entrypoint
│   │   ├── server.ts            # Fastify setup + WSS plugin
│   │   ├── signaling.ts         # WebSocket handler
│   │   ├── codes.ts             # Code-Generator + In-Memory-Session-Store
│   │   └── protocol.ts          # Message-Types
│   └── tests/
│       ├── codes.test.ts
│       └── signaling.test.ts
├── viewer/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── main.ts
│   │   ├── signaling-client.ts
│   │   ├── protocol.ts          # Kopie von backend/src/protocol.ts (s.u.)
│   │   └── ui.ts
│   └── tests/
│       └── signaling-client.test.ts
├── sharer/
│   ├── src-tauri/
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   ├── build.rs
│   │   └── src/
│   │       ├── main.rs
│   │       ├── signaling.rs
│   │       └── protocol.rs      # Message-Types in Rust
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       └── main.ts              # minimal Webview-UI
├── docs/
│   └── protocol.md              # Signaling-Protokoll-Spezifikation
└── .gitignore
```

**Protocol-Duplikation:** `protocol.ts` wird in Backend und Viewer dupliziert (zwei kleine Files, beide ~30 Zeilen). Eine geteilte Library wäre Over-Engineering im MVP. Wenn beide Files divergieren, fängt das die Integration-Test (Task 11). Späteres Extrahieren in `shared/` möglich, wenn nötig.

---

## Task 1: Workspace Setup (.gitignore + README + Docker-Compose)

**Files:**
- Create: `.gitignore`
- Create: `README.md`
- Create: `docker-compose.yml`
- Create: `.env.example`

- [x] **Step 1: Create .gitignore**

```
node_modules/
dist/
build/
target/
*.log
.env
.env.local
.DS_Store
.vite/
src-tauri/target/
coverage/
.vitest-cache/
```

- [x] **Step 2: Create README.md**

```markdown
# Screenshare

Simple, secure TeamViewer-style screen sharing. See `docs/superpowers/specs/` for design.

## Components
- `backend/` — Node.js signaling server (Dockerized)
- `viewer/` — Browser viewer (Vite + TS)
- `sharer/` — Tauri 2 desktop app

## Local Development

Backend runs in Docker:

```bash
cp .env.example .env
docker compose up backend
```

Frontend components (viewer, sharer) run on the host directly. See their READMEs.

## Project Conventions
See `CLAUDE.md` for engineering rules (clean code, TDD, ≥70% coverage, Docker conventions).
```

- [x] **Step 3: Create .env.example**

```
# Backend
BACKEND_PORT=8080
BACKEND_HOST=0.0.0.0

# Frontend (Viewer dev)
VITE_BACKEND_WS=ws://localhost:8080/signal

# Sharer (Tauri dev)
SCREENSHARE_BACKEND_WS=ws://localhost:8080/signal
```

- [x] **Step 4: Create docker-compose.yml (root)**

```yaml
services:
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    image: screenshare-backend:dev
    container_name: screenshare-backend
    restart: unless-stopped
    environment:
      - NODE_ENV=development
      - PORT=${BACKEND_PORT:-8080}
      - HOST=${BACKEND_HOST:-0.0.0.0}
    ports:
      - "${BACKEND_PORT:-8080}:8080"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/healthz"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
```

- [x] **Step 5: Commit**

```bash
git add .gitignore README.md docker-compose.yml .env.example
git commit -m "chore: workspace setup with docker compose"
```

---

## Task 2: Signaling-Protocol-Spec

**Files:**
- Create: `docs/protocol.md`

- [ ] **Step 1: Document the wire protocol**

```markdown
# Screenshare Signaling Protocol

Transport: WebSocket Secure (WSS) to `/signal` on the backend.
All messages are JSON. Each message has a `type` field.

## Roles

A client identifies as either `sharer` or `viewer` in its first message.

## Sharer-Initiated Messages

### `register`
Sent immediately after connect. Backend responds with `code-assigned`.
```json
{ "type": "register", "role": "sharer" }
```

### `confirm`
After viewer joins, sharer shows a confirmation dialog. On "Yes":
```json
{ "type": "confirm", "accepted": true }
```
On "No":
```json
{ "type": "confirm", "accepted": false }
```

### `relay` (any peer → any peer)
Used for arbitrary peer-to-peer messages relayed by the backend.
In later phases this carries SDP offers/answers and ICE candidates.
In Phase 1 it carries "hello" test payloads.
```json
{ "type": "relay", "payload": { "...": "..." } }
```

## Viewer-Initiated Messages

### `join`
Viewer sends this with the code it has typed in.
```json
{ "type": "join", "role": "viewer", "code": "284-915-073" }
```

## Server-Sent Messages

### `code-assigned` (→ sharer)
```json
{ "type": "code-assigned", "code": "284-915-073", "expiresInSec": 600 }
```

### `peer-joined` (→ sharer)
Viewer has connected. Sharer must show confirmation dialog and reply with `confirm`.
```json
{ "type": "peer-joined", "viewerInfo": { "ipPrefix": "84.xxx", "country": "DE" } }
```

### `peer-confirmed` (→ viewer)
After sharer accepted.
```json
{ "type": "peer-confirmed" }
```

### `peer-rejected` (→ viewer)
After sharer declined or session ended.
```json
{ "type": "peer-rejected", "reason": "declined" | "expired" | "sharer-gone" }
```

### `relay` (→ peer)
Forwarded `relay` message from the other peer.
```json
{ "type": "relay", "payload": { "...": "..." } }
```

### `error` (→ any)
```json
{ "type": "error", "code": "invalid-code" | "code-expired" | "rate-limit" | "bad-message", "message": "human readable" }
```

## State Machine (Backend)

```
[no session]
   ↓ sharer connects + register
[code-assigned, waiting]   ── 10 min TTL → [expired]
   ↓ viewer connects + join (code matches)
[matched, awaiting-confirm]
   ↓ sharer sends confirm:accepted
[active]   ←→ relay messages flow
   ↓ either side disconnects
[ended]
```
```

- [ ] **Step 2: Commit**

```bash
git add docs/protocol.md
git commit -m "docs: signaling protocol spec"
```

---

## Task 3: Backend — Project Setup

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/vitest.config.ts`
- Create: `backend/src/index.ts`

- [ ] **Step 1: Init package.json**

```bash
cd backend && npm init -y
```

Then edit `backend/package.json` to:

```json
{
  "name": "screenshare-backend",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "fastify": "4.28.1",
    "@fastify/websocket": "10.0.1",
    "@fastify/rate-limit": "9.1.0"
  },
  "devDependencies": {
    "@types/node": "20.14.10",
    "tsx": "4.16.2",
    "typescript": "5.5.3",
    "vitest": "2.0.3"
  }
}
```

Then run:

```bash
cd backend && npm install
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Stub entrypoint**

`backend/src/index.ts`:

```ts
console.log("Screenshare backend (Phase 1) — not implemented yet");
```

- [ ] **Step 5: Verify build works**

```bash
cd backend && npm run build && node dist/index.js
```

Expected output: `Screenshare backend (Phase 1) — not implemented yet`

- [ ] **Step 6: Create Dockerfile (multi-stage)**

`backend/Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:20.18-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20.18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/healthz || exit 1
CMD ["node", "dist/index.js"]
```

- [ ] **Step 7: Add .dockerignore**

`backend/.dockerignore`:

```
node_modules
dist
coverage
.vitest-cache
tests
*.log
.env
.env.local
.git
```

- [ ] **Step 8: Verify docker compose build works**

```bash
docker compose build backend
docker compose up -d backend
sleep 3
curl -fsS http://localhost:8080/healthz
docker compose down
```

> **Note**: this step will fail until Task 7 (Fastify server) wires `/healthz`. Re-run after Task 7 — for now just verify `docker compose build backend` completes without error.

- [ ] **Step 9: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/tsconfig.json backend/vitest.config.ts backend/src/index.ts backend/Dockerfile backend/.dockerignore
git commit -m "feat(backend): project scaffolding with docker build"
```

---

## Task 4: Backend — Protocol Types

**Files:**
- Create: `backend/src/protocol.ts`

- [ ] **Step 1: Define TypeScript types matching docs/protocol.md**

```ts
export type SharerRegister = { type: "register"; role: "sharer" };
export type SharerConfirm = { type: "confirm"; accepted: boolean };
export type ViewerJoin = { type: "join"; role: "viewer"; code: string };
export type RelayMsg = { type: "relay"; payload: unknown };

export type IncomingMessage =
  | SharerRegister
  | SharerConfirm
  | ViewerJoin
  | RelayMsg;

export type CodeAssigned = {
  type: "code-assigned";
  code: string;
  expiresInSec: number;
};
export type PeerJoined = {
  type: "peer-joined";
  viewerInfo: { ipPrefix: string; country: string | null };
};
export type PeerConfirmed = { type: "peer-confirmed" };
export type PeerRejected = {
  type: "peer-rejected";
  reason: "declined" | "expired" | "sharer-gone";
};
export type ErrorMessage = {
  type: "error";
  code: "invalid-code" | "code-expired" | "rate-limit" | "bad-message";
  message: string;
};

export type OutgoingMessage =
  | CodeAssigned
  | PeerJoined
  | PeerConfirmed
  | PeerRejected
  | RelayMsg
  | ErrorMessage;
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/protocol.ts
git commit -m "feat(backend): protocol types"
```

---

## Task 5: Backend — Code Generator (TDD)

**Files:**
- Create: `backend/src/codes.ts`
- Create: `backend/tests/codes.test.ts`

- [ ] **Step 1: Write failing tests for code generator**

`backend/tests/codes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateCode, normalizeCode } from "../src/codes.js";

describe("generateCode", () => {
  it("produces 11-character code in format DDD-DDD-DDD", () => {
    const code = generateCode();
    expect(code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
  });

  it("produces different codes on repeated calls", () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(90); // collisions extremely unlikely
  });
});

describe("normalizeCode", () => {
  it("strips spaces and dashes", () => {
    expect(normalizeCode("284 915 073")).toBe("284-915-073");
    expect(normalizeCode("284915073")).toBe("284-915-073");
    expect(normalizeCode("284-915-073")).toBe("284-915-073");
  });

  it("returns null for invalid codes", () => {
    expect(normalizeCode("abc")).toBeNull();
    expect(normalizeCode("123")).toBeNull();
    expect(normalizeCode("1234567890")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd backend && npm test
```

Expected: tests fail with "Cannot find module '../src/codes.js'".

- [ ] **Step 3: Implement codes.ts (minimal — just generateCode + normalizeCode)**

```ts
import { randomInt } from "node:crypto";

export function generateCode(): string {
  const segments = Array.from({ length: 3 }, () =>
    randomInt(0, 1000).toString().padStart(3, "0")
  );
  return segments.join("-");
}

export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{9}$/.test(digits)) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd backend && npm test
```

Expected: all tests in `codes.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/codes.ts backend/tests/codes.test.ts
git commit -m "feat(backend): code generator and normalizer"
```

---

## Task 6: Backend — Code State Store (TDD)

**Files:**
- Modify: `backend/src/codes.ts`
- Modify: `backend/tests/codes.test.ts`

- [ ] **Step 1: Write failing tests for SessionStore**

Append to `backend/tests/codes.test.ts`:

```ts
import { SessionStore } from "../src/codes.js";

describe("SessionStore", () => {
  it("registers a sharer and returns a code", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as any;
    const { code } = store.registerSharer(sharer);
    expect(code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
  });

  it("retrieves session by code", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as any;
    const { code } = store.registerSharer(sharer);
    const session = store.getSession(code);
    expect(session?.sharer).toBe(sharer);
  });

  it("returns null for unknown code", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    expect(store.getSession("000-000-000")).toBeNull();
  });

  it("expires sessions after ttl", async () => {
    const store = new SessionStore({ ttlMs: 50, maxAttempts: 5 });
    const sharer = { id: "s1" } as any;
    const { code } = store.registerSharer(sharer);
    await new Promise((r) => setTimeout(r, 80));
    expect(store.getSession(code)).toBeNull();
  });

  it("burns code after maxAttempts failed joins", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 3 });
    const sharer = { id: "s1" } as any;
    const { code } = store.registerSharer(sharer);
    expect(store.recordFailedAttempt(code)).toBe(false); // not burned
    expect(store.recordFailedAttempt(code)).toBe(false);
    expect(store.recordFailedAttempt(code)).toBe(true); // 3rd burns
    expect(store.getSession(code)).toBeNull();
  });

  it("removes session on disconnect", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.removeBySharer(sharer);
    expect(store.getSession(code)).toBeNull();
  });

  it("findByPeer locates session by sharer reference", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    store.registerSharer(sharer);
    const session = store.findByPeer(sharer);
    expect(session?.sharer).toBe(sharer);
  });

  it("findByPeer locates session by viewer reference", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    const sharer = { id: "s1" } as unknown as object;
    const viewer = { id: "v1" } as unknown as object;
    const { code } = store.registerSharer(sharer);
    store.attachViewer(code, viewer);
    const session = store.findByPeer(viewer);
    expect(session?.viewer).toBe(viewer);
  });

  it("findByPeer returns null for unknown peer", () => {
    const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
    expect(store.findByPeer({} as object)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd backend && npm test
```

Expected: `SessionStore` is not exported.

- [ ] **Step 3: Implement SessionStore in codes.ts**

Append to `backend/src/codes.ts`:

```ts
export type Peer = object;

export type Session = {
  code: string;
  sharer: Peer;
  viewer: Peer | null;
  expiresAt: number;
  failedAttempts: number;
};

export type StoreConfig = { ttlMs: number; maxAttempts: number };

export class SessionStore {
  private sessions = new Map<string, Session>();
  private byPeer = new Map<Peer, string>();
  constructor(private cfg: StoreConfig) {}

  registerSharer(sharer: Peer): { code: string; session: Session } {
    let code: string;
    do {
      code = generateCode();
    } while (this.sessions.has(code));
    const session: Session = {
      code,
      sharer,
      viewer: null,
      expiresAt: Date.now() + this.cfg.ttlMs,
      failedAttempts: 0,
    };
    this.sessions.set(code, session);
    this.byPeer.set(sharer, code);
    return { code, session };
  }

  attachViewer(code: string, viewer: Peer): Session | null {
    const session = this.getSession(code);
    if (!session) return null;
    session.viewer = viewer;
    this.byPeer.set(viewer, code);
    return session;
  }

  getSession(code: string): Session | null {
    const session = this.sessions.get(code);
    if (!session) return null;
    if (Date.now() > session.expiresAt) {
      this.dropSession(session);
      return null;
    }
    return session;
  }

  findByPeer(peer: Peer): Session | null {
    const code = this.byPeer.get(peer);
    return code ? this.getSession(code) : null;
  }

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

  removeBySharer(sharer: Peer): void {
    const code = this.byPeer.get(sharer);
    if (!code) return;
    const session = this.sessions.get(code);
    if (session) this.dropSession(session);
  }

  detachViewer(viewer: Peer): void {
    const session = this.findByPeer(viewer);
    if (!session || session.viewer !== viewer) return;
    session.viewer = null;
    this.byPeer.delete(viewer);
  }

  private dropSession(session: Session): void {
    this.sessions.delete(session.code);
    this.byPeer.delete(session.sharer);
    if (session.viewer) this.byPeer.delete(session.viewer);
  }
}
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
cd backend && npm test
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/codes.ts backend/tests/codes.test.ts
git commit -m "feat(backend): session store with TTL and attempt limits"
```

---

## Task 7: Backend — Fastify Server Skeleton

**Files:**
- Create: `backend/src/server.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Implement server.ts**

```ts
import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";

export type ServerConfig = {
  port: number;
  host: string;
};

export async function createServer(_cfg: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(websocketPlugin);

  app.get("/healthz", async () => ({ status: "ok" }));

  // /signal handler will be wired in Task 8
  return app;
}
```

- [ ] **Step 2: Wire entrypoint**

`backend/src/index.ts`:

```ts
import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

const app = await createServer({ port, host });
await app.listen({ port, host });
console.log(`Listening on ${host}:${port}`);
```

- [ ] **Step 3: Manually verify**

```bash
cd backend && npm run dev
```

In another terminal:

```bash
curl http://localhost:8080/healthz
```

Expected: `{"status":"ok"}`

Stop the dev server (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add backend/src/server.ts backend/src/index.ts
git commit -m "feat(backend): fastify server with healthz"
```

---

## Task 8: Backend — Signaling Handler (TDD)

**Files:**
- Create: `backend/src/signaling.ts`
- Modify: `backend/src/server.ts`
- Create: `backend/tests/signaling.test.ts`

- [ ] **Step 1: Write integration test for the full handshake**

`backend/tests/signaling.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { createServer } from "../src/server.js";

let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  app = await createServer({ port: 0, host: "127.0.0.1" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  url = `ws://127.0.0.1:${addr.port}/signal`;
});

afterAll(async () => {
  await app.close();
});

function recv(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

describe("signaling handshake", () => {
  it("sharer registers and gets a code", async () => {
    const sharer = new WebSocket(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const msg = await recv(sharer);
    expect(msg.type).toBe("code-assigned");
    expect(msg.code).toMatch(/^\d{3}-\d{3}-\d{3}$/);
    sharer.close();
  });

  it("viewer joins with valid code and sharer receives peer-joined", async () => {
    const sharer = new WebSocket(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const assigned = await recv(sharer);
    const code = assigned.code;

    const viewer = new WebSocket(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));

    const peerJoined = await recv(sharer);
    expect(peerJoined.type).toBe("peer-joined");

    sharer.close();
    viewer.close();
  });

  it("viewer with invalid code receives error", async () => {
    const viewer = new WebSocket(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(
      JSON.stringify({ type: "join", role: "viewer", code: "000-000-000" })
    );
    const err = await recv(viewer);
    expect(err.type).toBe("error");
    expect(err.code).toBe("invalid-code");
    viewer.close();
  });

  it("sharer confirms, viewer receives peer-confirmed", async () => {
    const sharer = new WebSocket(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer = new WebSocket(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined

    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    const confirmed = await recv(viewer);
    expect(confirmed.type).toBe("peer-confirmed");

    sharer.close();
    viewer.close();
  });

  it("relay message flows from viewer to sharer", async () => {
    const sharer = new WebSocket(url);
    await new Promise((r) => sharer.once("open", r));
    sharer.send(JSON.stringify({ type: "register", role: "sharer" }));
    const { code } = await recv(sharer);

    const viewer = new WebSocket(url);
    await new Promise((r) => viewer.once("open", r));
    viewer.send(JSON.stringify({ type: "join", role: "viewer", code }));
    await recv(sharer); // peer-joined

    sharer.send(JSON.stringify({ type: "confirm", accepted: true }));
    await recv(viewer); // peer-confirmed

    viewer.send(
      JSON.stringify({ type: "relay", payload: { hello: "world" } })
    );
    const relayed = await recv(sharer);
    expect(relayed.type).toBe("relay");
    expect(relayed.payload).toEqual({ hello: "world" });

    sharer.close();
    viewer.close();
  });
});
```

- [ ] **Step 2: Run tests — they should fail because /signal isn't wired**

```bash
cd backend && npm test
```

Expected: tests fail (timeout or "no /signal handler").

- [ ] **Step 3: Implement signaling.ts**

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { SessionStore, Peer } from "./codes.js";
import type {
  IncomingMessage,
  OutgoingMessage,
} from "./protocol.js";

export function registerSignaling(
  app: FastifyInstance,
  store: SessionStore
): void {
  function send(peer: WebSocket, msg: OutgoingMessage): void {
    if (peer.readyState === peer.OPEN) peer.send(JSON.stringify(msg));
  }

  function ipPrefix(req: FastifyRequest): string {
    const ip = req.ip;
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.xxx`;
    return ip.split(":").slice(0, 2).join(":") + ":xxx";
  }

  app.get("/signal", { websocket: true }, (socket, req) => {
    const peer = socket as WebSocket;
    let role: "sharer" | "viewer" | null = null;

    peer.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(peer, { type: "error", code: "bad-message", message: "invalid JSON" });
        return;
      }

      if (msg.type === "register" && msg.role === "sharer" && role === null) {
        role = "sharer";
        const { code, session } = store.registerSharer(peer as Peer);
        const ttlSec = Math.floor((session.expiresAt - Date.now()) / 1000);
        send(peer, { type: "code-assigned", code, expiresInSec: ttlSec });
        return;
      }

      if (msg.type === "join" && msg.role === "viewer" && role === null) {
        const session = store.getSession(msg.code);
        if (!session) {
          const burned = store.recordFailedAttempt(msg.code);
          send(peer, {
            type: "error",
            code: burned ? "code-expired" : "invalid-code",
            message: burned ? "code burned after too many attempts" : "no such session",
          });
          peer.close();
          return;
        }
        if (session.viewer) {
          send(peer, { type: "error", code: "invalid-code", message: "session full" });
          peer.close();
          return;
        }
        role = "viewer";
        store.attachViewer(msg.code, peer as Peer);
        send(session.sharer as WebSocket, {
          type: "peer-joined",
          viewerInfo: { ipPrefix: ipPrefix(req), country: null },
        });
        return;
      }

      if (msg.type === "confirm" && role === "sharer") {
        const found = store.findByPeer(peer as Peer);
        if (!found) return;
        if (msg.accepted) {
          if (found.viewer) send(found.viewer as WebSocket, { type: "peer-confirmed" });
        } else {
          if (found.viewer) {
            const viewerSocket = found.viewer as WebSocket;
            send(viewerSocket, { type: "peer-rejected", reason: "declined" });
            viewerSocket.close();
          }
          store.removeBySharer(peer as Peer);
          peer.close();
        }
        return;
      }

      if (msg.type === "relay") {
        const found = store.findByPeer(peer as Peer);
        if (!found) return;
        const other = found.sharer === peer ? found.viewer : found.sharer;
        if (other) send(other as WebSocket, { type: "relay", payload: msg.payload });
        return;
      }

      send(peer, { type: "error", code: "bad-message", message: "unexpected message" });
    });

    peer.on("close", () => {
      const found = store.findByPeer(peer as Peer);
      if (!found) return;
      if (found.sharer === peer) {
        if (found.viewer) {
          const viewerSocket = found.viewer as WebSocket;
          send(viewerSocket, { type: "peer-rejected", reason: "sharer-gone" });
          viewerSocket.close();
        }
        store.removeBySharer(peer as Peer);
      } else if (found.viewer === peer) {
        store.detachViewer(peer as Peer);
      }
    });
  });
}
```

- [ ] **Step 4: Wire signaling into server.ts**

Modify `backend/src/server.ts`:

```ts
import Fastify, { FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import { SessionStore } from "./codes.js";
import { registerSignaling } from "./signaling.js";

export type ServerConfig = {
  port: number;
  host: string;
};

export async function createServer(_cfg: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(websocketPlugin);

  const store = new SessionStore({ ttlMs: 600_000, maxAttempts: 5 });
  registerSignaling(app, store);

  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}
```

- [ ] **Step 5: Run tests — verify all pass**

```bash
cd backend && npm test
```

Expected: all signaling tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/signaling.ts backend/src/server.ts backend/tests/signaling.test.ts
git commit -m "feat(backend): signaling handler with full handshake"
```

---

## Task 9: Backend — Rate Limiting

**Files:**
- Modify: `backend/src/server.ts`
- Create: `backend/tests/rate-limit.test.ts`

- [ ] **Step 1: Write test for join-attempt rate limit**

`backend/tests/rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { createServer } from "../src/server.js";

let app: FastifyInstance;
let url: string;

beforeAll(async () => {
  app = await createServer({ port: 0, host: "127.0.0.1" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no address");
  url = `ws://127.0.0.1:${addr.port}/signal`;
});

afterAll(async () => {
  await app.close();
});

it("rate-limits more than 5 invalid joins per minute from same IP", async () => {
  const attempts = [];
  for (let i = 0; i < 7; i++) {
    const ws = new WebSocket(url);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "join", role: "viewer", code: "000-000-000" }));
    const msg = await new Promise<any>((r) =>
      ws.once("message", (d) => r(JSON.parse(d.toString())))
    );
    attempts.push(msg);
    ws.close();
  }
  // First 5 should be "invalid-code", 6th+ should be "rate-limit"
  expect(attempts.slice(0, 5).every((m) => m.code === "invalid-code")).toBe(true);
  expect(attempts.slice(5).every((m) => m.code === "rate-limit")).toBe(true);
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd backend && npm test rate-limit
```

Expected: 6th attempt still returns "invalid-code", not "rate-limit".

- [ ] **Step 3: Add per-IP rate-limit in signaling.ts**

In `backend/src/signaling.ts`, add at the top:

```ts
const attemptCounts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attemptCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    attemptCounts.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 5;
}
```

Then in the `join` handler, before checking the session:

```ts
if (msg.type === "join" && msg.role === "viewer" && role === null) {
  if (!checkRateLimit(req.ip ?? "unknown")) {
    send(peer, { type: "error", code: "rate-limit", message: "too many attempts" });
    peer.close();
    return;
  }
  // ... existing logic
}
```

- [ ] **Step 4: Run tests — verify pass**

```bash
cd backend && npm test
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/signaling.ts backend/tests/rate-limit.test.ts
git commit -m "feat(backend): per-IP rate limit on join attempts"
```

---

## Task 10: Viewer — Project Setup

**Files:**
- Create: `viewer/package.json`
- Create: `viewer/tsconfig.json`
- Create: `viewer/vite.config.ts`
- Create: `viewer/index.html`
- Create: `viewer/src/main.ts`

- [ ] **Step 1: package.json**

```bash
cd viewer && npm init -y
```

Then edit `viewer/package.json`:

```json
{
  "name": "screenshare-viewer",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "5.5.3",
    "vite": "5.3.4",
    "vitest": "2.0.3"
  }
}
```

```bash
cd viewer && npm install
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: vite.config.ts**

```ts
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
});
```

- [ ] **Step 4: index.html**

```html
<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Screenshare — Viewer</title>
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Stub main.ts**

```ts
document.getElementById("app")!.textContent = "Screenshare Viewer (Phase 1) — stub";
```

- [ ] **Step 6: Verify dev server runs**

```bash
cd viewer && npm run dev
```

Open http://localhost:5173 in browser. Expected: "Screenshare Viewer (Phase 1) — stub".
Stop with Ctrl+C.

- [ ] **Step 7: Commit**

```bash
git add viewer/package.json viewer/package-lock.json viewer/tsconfig.json viewer/vite.config.ts viewer/index.html viewer/src/main.ts
git commit -m "feat(viewer): project scaffolding"
```

---

## Task 11: Viewer — Protocol + Signaling Client (TDD)

**Files:**
- Create: `viewer/src/protocol.ts` (copy of backend's)
- Create: `viewer/src/signaling-client.ts`
- Create: `viewer/tests/signaling-client.test.ts`

- [ ] **Step 1: Copy protocol types**

Copy `backend/src/protocol.ts` to `viewer/src/protocol.ts` verbatim.

- [ ] **Step 2: Write failing test using mock WebSocket**

`viewer/tests/signaling-client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { SignalingClient } from "../src/signaling-client.js";

class MockWS {
  static OPEN = 1;
  readyState = 0;
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({}); }
  fakeOpen() { this.readyState = MockWS.OPEN; this.onopen?.({}); }
  fakeMessage(data: any) { this.onmessage?.({ data: JSON.stringify(data) }); }
}

describe("SignalingClient", () => {
  it("sends join after connect", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as any });
    await client.join("284-915-073");
    mock.fakeOpen();
    expect(JSON.parse(mock.sent[0])).toEqual({
      type: "join",
      role: "viewer",
      code: "284-915-073",
    });
  });

  it("resolves connect promise on peer-confirmed", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as any });
    const p = client.join("284-915-073");
    mock.fakeOpen();
    mock.fakeMessage({ type: "peer-confirmed" });
    await expect(p).resolves.toBeUndefined();
  });

  it("rejects on invalid-code error", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as any });
    const p = client.join("000-000-000");
    mock.fakeOpen();
    mock.fakeMessage({ type: "error", code: "invalid-code", message: "no such session" });
    await expect(p).rejects.toThrow(/invalid-code/);
  });

  it("emits relay events to listeners", async () => {
    const mock = new MockWS();
    const client = new SignalingClient("ws://x", { factory: () => mock as any });
    const fn = vi.fn();
    client.onRelay(fn);
    const p = client.join("284-915-073");
    mock.fakeOpen();
    mock.fakeMessage({ type: "peer-confirmed" });
    await p;
    mock.fakeMessage({ type: "relay", payload: { hi: 1 } });
    expect(fn).toHaveBeenCalledWith({ hi: 1 });
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

```bash
cd viewer && npm test
```

- [ ] **Step 4: Implement signaling-client.ts**

```ts
import type { IncomingMessage, OutgoingMessage } from "./protocol.js";

export type WSFactory = (url: string) => WebSocket;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private relayListeners: Array<(payload: unknown) => void> = [];
  private rejectionListeners: Array<(reason: string) => void> = [];

  constructor(
    private url: string,
    private opts: { factory?: WSFactory } = {}
  ) {}

  join(code: string): Promise<void> {
    const factory = this.opts.factory ?? ((u) => new WebSocket(u));
    const ws = factory(this.url);
    this.ws = ws;

    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", role: "viewer", code }));
      };
      ws.onmessage = (ev: MessageEvent) => {
        const msg = JSON.parse(ev.data) as OutgoingMessage;
        if (msg.type === "peer-confirmed") {
          resolve();
        } else if (msg.type === "peer-rejected") {
          reject(new Error(`peer-rejected: ${msg.reason}`));
        } else if (msg.type === "error") {
          reject(new Error(`${msg.code}: ${msg.message}`));
        } else if (msg.type === "relay") {
          for (const l of this.relayListeners) l(msg.payload);
        }
      };
      ws.onclose = () => {
        for (const l of this.rejectionListeners) l("closed");
      };
    });
  }

  sendRelay(payload: unknown): void {
    this.ws?.send(JSON.stringify({ type: "relay", payload }));
  }

  onRelay(fn: (payload: unknown) => void): void {
    this.relayListeners.push(fn);
  }

  onDisconnect(fn: (reason: string) => void): void {
    this.rejectionListeners.push(fn);
  }

  close(): void {
    this.ws?.close();
  }
}
```

- [ ] **Step 5: Run tests — verify all pass**

```bash
cd viewer && npm test
```

- [ ] **Step 6: Commit**

```bash
git add viewer/src/protocol.ts viewer/src/signaling-client.ts viewer/tests/signaling-client.test.ts
git commit -m "feat(viewer): signaling client with unit tests"
```

---

## Task 12: Viewer — Minimal UI (Code Input + Status)

**Files:**
- Modify: `viewer/src/main.ts`
- Create: `viewer/src/ui.ts`
- Modify: `viewer/index.html` (add CSS)

- [ ] **Step 1: Add minimal CSS to index.html**

Replace `<body>` in `viewer/index.html`:

```html
<body>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }
    input { font-size: 1.5rem; padding: 0.5rem; width: 100%; text-align: center; letter-spacing: 0.1em; }
    button { font-size: 1rem; padding: 0.5rem 1rem; margin-top: 1rem; cursor: pointer; }
    #status { margin-top: 1.5rem; padding: 1rem; border-radius: 4px; }
    #status.ok { background: #e6ffe6; }
    #status.err { background: #ffe6e6; }
    #status.info { background: #e6f0ff; }
  </style>
  <main id="app">
    <h1>Screenshare</h1>
    <p>Code vom Sharer eingeben:</p>
    <input id="code" maxlength="11" placeholder="284-915-073" />
    <button id="connect">Verbinden</button>
    <div id="status"></div>
  </main>
  <script type="module" src="/src/main.ts"></script>
</body>
```

- [ ] **Step 2: Implement ui.ts**

```ts
import { SignalingClient } from "./signaling-client.js";

function setStatus(text: string, kind: "ok" | "err" | "info") {
  const el = document.getElementById("status")!;
  el.textContent = text;
  el.className = kind;
}

export function bindUI(backendWsUrl: string): void {
  const codeInput = document.getElementById("code") as HTMLInputElement;
  const connectBtn = document.getElementById("connect") as HTMLButtonElement;

  // auto-format input as user types: insert dashes
  codeInput.addEventListener("input", () => {
    const digits = codeInput.value.replace(/\D/g, "").slice(0, 9);
    const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)]
      .filter((s) => s.length > 0);
    codeInput.value = parts.join("-");
  });

  connectBtn.addEventListener("click", async () => {
    const code = codeInput.value.trim();
    if (!/^\d{3}-\d{3}-\d{3}$/.test(code)) {
      setStatus("Bitte 9-stelligen Code eingeben.", "err");
      return;
    }
    setStatus("Warte auf Bestätigung durch den Sharer…", "info");
    connectBtn.disabled = true;

    const client = new SignalingClient(backendWsUrl);
    client.onRelay((payload) => {
      setStatus(`Relay empfangen: ${JSON.stringify(payload)}`, "info");
    });
    client.onDisconnect((reason) => {
      setStatus(`Verbindung beendet: ${reason}`, "err");
      connectBtn.disabled = false;
    });

    try {
      await client.join(code);
      setStatus("Verbunden mit Sharer. (Phase 1: kein Video — sende Test-Relay)", "ok");
      client.sendRelay({ hello: "from viewer", ts: Date.now() });
    } catch (e: any) {
      setStatus(`Fehler: ${e.message}`, "err");
      connectBtn.disabled = false;
    }
  });
}
```

- [ ] **Step 3: Wire main.ts**

```ts
import { bindUI } from "./ui.js";

const backendWsUrl =
  (import.meta as any).env?.VITE_BACKEND_WS ?? "ws://localhost:8080/signal";

bindUI(backendWsUrl);
```

- [ ] **Step 4: Manual end-to-end check (Backend must be running)**

```bash
# Terminal 1
cd backend && npm run dev
# Terminal 2
cd viewer && npm run dev
```

- Open http://localhost:5173.
- Without a sharer running, type any 9 digits. Click "Verbinden".
- Expected: "Fehler: invalid-code: no such session".

- [ ] **Step 5: Commit**

```bash
git add viewer/src/main.ts viewer/src/ui.ts viewer/index.html
git commit -m "feat(viewer): minimal UI with code input and status"
```

---

## Task 13: Sharer — Tauri Scaffolding

**Files:**
- Create: `sharer/package.json`, `sharer/index.html`, `sharer/vite.config.ts`, `sharer/src/main.ts`
- Create: `sharer/src-tauri/Cargo.toml`, `sharer/src-tauri/tauri.conf.json`, `sharer/src-tauri/build.rs`, `sharer/src-tauri/src/main.rs`

- [ ] **Step 1: Init Tauri project**

```bash
cd sharer
npm init -y
npm install --save-dev typescript@5.5.3 vite@5.3.4 @tauri-apps/cli@2.0.0-rc.0
npm install @tauri-apps/api@2.0.0-rc.0
```

> If `@tauri-apps/cli@2.0.0-rc.0` is no longer in the registry by the time you run this, use the latest `2.x` stable release. Adjust pinning accordingly.

- [ ] **Step 2: package.json scripts**

Set `sharer/package.json`:

```json
{
  "name": "screenshare-sharer",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  }
}
```

(Keep the dependencies that `npm install` populated; add scripts to the existing file.)

- [ ] **Step 3: index.html (Webview UI)**

```html
<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <title>Screenshare — Sharer</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 2rem; }
      #code { font-size: 2.5rem; letter-spacing: 0.15em; text-align: center; margin: 2rem 0; user-select: all; }
      #status { padding: 1rem; border-radius: 4px; background: #eef; }
      #confirm { display: none; padding: 1rem; background: #ffe; border: 1px solid #cc9; margin-top: 1rem; }
      button { font-size: 1rem; padding: 0.5rem 1rem; margin-right: 0.5rem; cursor: pointer; }
    </style>
  </head>
  <body>
    <h1>Screenshare — Sharer</h1>
    <p>Diesen Code an die Person geben, die helfen soll:</p>
    <div id="code">…</div>
    <div id="status">Verbinde mit Backend…</div>
    <div id="confirm">
      <p id="confirm-text">Verbindungsanfrage</p>
      <button id="accept">Verbinden zulassen</button>
      <button id="decline">Ablehnen</button>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: vite.config.ts**

```ts
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 5174, strictPort: true },
});
```

- [ ] **Step 5: src/main.ts (Webview ↔ Rust bridge stub)**

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const codeEl = document.getElementById("code")!;
const statusEl = document.getElementById("status")!;
const confirmEl = document.getElementById("confirm")!;
const confirmTextEl = document.getElementById("confirm-text")!;

listen<{ code: string }>("code-assigned", (e) => {
  codeEl.textContent = e.payload.code;
  statusEl.textContent = "Warte auf Verbindung…";
});

listen<{ ipPrefix: string }>("peer-joined", (e) => {
  confirmTextEl.textContent = `Verbindungsanfrage von ${e.payload.ipPrefix}`;
  confirmEl.style.display = "block";
});

listen<{ payload: unknown }>("relay", (e) => {
  statusEl.textContent = "Verbunden. Relay empfangen: " + JSON.stringify(e.payload);
});

listen<{ reason: string }>("disconnected", (e) => {
  statusEl.textContent = "Getrennt: " + e.payload.reason;
  confirmEl.style.display = "none";
});

document.getElementById("accept")!.addEventListener("click", () => {
  invoke("confirm_peer", { accepted: true });
  confirmEl.style.display = "none";
  statusEl.textContent = "Verbunden. Sende Test-Relay…";
});

document.getElementById("decline")!.addEventListener("click", () => {
  invoke("confirm_peer", { accepted: false });
  confirmEl.style.display = "none";
  statusEl.textContent = "Abgelehnt.";
});

invoke("start_signaling");
```

- [ ] **Step 6: src-tauri/Cargo.toml**

```toml
[package]
name = "screenshare-sharer"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2.0.0-rc", features = [] }

[dependencies]
tauri = { version = "2.0.0-rc", features = [] }
tokio = { version = "1.39", features = ["rt-multi-thread", "macros", "sync"] }
tokio-tungstenite = { version = "0.23", features = ["native-tls"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
url = "2.5"
futures-util = "0.3"
```

> Same pinning caveat as `@tauri-apps/cli` — if `2.0.0-rc` of `tauri` and `tauri-build` is no longer published when this is executed, upgrade to the matching stable 2.x and adjust feature flags if needed.

- [ ] **Step 7: src-tauri/build.rs**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 8: src-tauri/tauri.conf.json**

```json
{
  "$schema": "https://schema.tauri.app/config/2.0.0-rc",
  "productName": "Screenshare",
  "version": "0.1.0",
  "identifier": "de.mr-development.screenshare",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5174",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "Screenshare — Sharer",
        "width": 480,
        "height": 600
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all"
  }
}
```

- [ ] **Step 9: Stub main.rs (will be expanded next task)**

```rust
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error running tauri");
}
```

- [ ] **Step 10: Verify Tauri dev build runs**

```bash
cd sharer && npm run tauri:dev
```

Expected: a window opens with "Screenshare — Sharer" and the empty placeholder code "…".
Stop with Ctrl+C.

- [ ] **Step 11: Commit**

```bash
git add sharer/
git commit -m "feat(sharer): tauri scaffolding"
```

---

## Task 14: Sharer — Rust Signaling Client

**Files:**
- Modify: `sharer/src-tauri/src/main.rs`
- Create: `sharer/src-tauri/src/signaling.rs`
- Create: `sharer/src-tauri/src/protocol.rs`

- [ ] **Step 1: protocol.rs (Rust message types)**

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Outgoing {
    Register { role: &'static str },
    Confirm { accepted: bool },
    Relay { payload: serde_json::Value },
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Incoming {
    CodeAssigned { code: String, #[serde(rename = "expiresInSec")] expires_in_sec: u64 },
    PeerJoined { #[serde(rename = "viewerInfo")] viewer_info: ViewerInfo },
    PeerConfirmed,
    PeerRejected { reason: String },
    Relay { payload: serde_json::Value },
    Error { code: String, message: String },
}

#[derive(Deserialize, Debug)]
pub struct ViewerInfo {
    #[serde(rename = "ipPrefix")] pub ip_prefix: String,
    pub country: Option<String>,
}
```

- [ ] **Step 2: signaling.rs (WebSocket client + Tauri-event bridge)**

```rust
use crate::protocol::{Incoming, Outgoing};
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub struct Signaling {
    pub tx: mpsc::Sender<Outgoing>,
}

pub async fn run(app: AppHandle, url: String) -> Signaling {
    let (tx, mut rx) = mpsc::channel::<Outgoing>(16);
    let tx_for_handle = tx.clone();

    tauri::async_runtime::spawn(async move {
        let (ws, _) = match connect_async(&url).await {
            Ok(v) => v,
            Err(e) => {
                let _ = app.emit("disconnected", serde_json::json!({ "reason": format!("connect failed: {e}") }));
                return;
            }
        };
        let (mut write, mut read) = ws.split();

        let register = Outgoing::Register { role: "sharer" };
        let _ = write
            .send(Message::Text(serde_json::to_string(&register).unwrap()))
            .await;

        loop {
            tokio::select! {
                Some(out) = rx.recv() => {
                    let txt = serde_json::to_string(&out).unwrap();
                    if write.send(Message::Text(txt)).await.is_err() { break; }
                }
                Some(Ok(msg)) = read.next() => {
                    let Message::Text(txt) = msg else { continue };
                    let Ok(parsed) = serde_json::from_str::<Incoming>(&txt) else { continue };
                    match parsed {
                        Incoming::CodeAssigned { code, .. } => {
                            let _ = app.emit("code-assigned", serde_json::json!({ "code": code }));
                        }
                        Incoming::PeerJoined { viewer_info } => {
                            let _ = app.emit("peer-joined", serde_json::json!({ "ipPrefix": viewer_info.ip_prefix }));
                        }
                        Incoming::PeerConfirmed => {}
                        Incoming::PeerRejected { reason } => {
                            let _ = app.emit("disconnected", serde_json::json!({ "reason": reason }));
                        }
                        Incoming::Relay { payload } => {
                            let _ = app.emit("relay", serde_json::json!({ "payload": payload }));
                        }
                        Incoming::Error { code, message } => {
                            let _ = app.emit("disconnected", serde_json::json!({ "reason": format!("{code}: {message}") }));
                        }
                    }
                }
                else => break,
            }
        }
    });

    Signaling { tx: tx_for_handle }
}
```

- [ ] **Step 3: Wire commands in main.rs**

```rust
mod protocol;
mod signaling;

use std::sync::Mutex;
use signaling::Signaling;
use tauri::{Manager, State};

struct SignalingState(Mutex<Option<Signaling>>);

#[tauri::command]
async fn start_signaling(app: tauri::AppHandle, state: State<'_, SignalingState>) -> Result<(), String> {
    let url = std::env::var("SCREENSHARE_BACKEND_WS")
        .unwrap_or_else(|_| "ws://localhost:8080/signal".to_string());
    let sig = signaling::run(app, url).await;
    *state.0.lock().unwrap() = Some(sig);
    Ok(())
}

#[tauri::command]
async fn confirm_peer(accepted: bool, state: State<'_, SignalingState>) -> Result<(), String> {
    let tx = {
        let guard = state.0.lock().unwrap();
        guard.as_ref().map(|s| s.tx.clone())
    };
    if let Some(tx) = tx {
        tx.send(protocol::Outgoing::Confirm { accepted }).await.map_err(|e| e.to_string())?;
        if accepted {
            tx.send(protocol::Outgoing::Relay {
                payload: serde_json::json!({ "hello": "from sharer" }),
            }).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(SignalingState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![start_signaling, confirm_peer])
        .run(tauri::generate_context!())
        .expect("error running tauri");
}
```

- [ ] **Step 4: Build and verify Rust compiles**

```bash
cd sharer && npm run tauri:dev
```

Expected: window opens, sharer connects to backend (if running), code appears.

- [ ] **Step 5: Commit**

```bash
git add sharer/src-tauri/src/protocol.rs sharer/src-tauri/src/signaling.rs sharer/src-tauri/src/main.rs
git commit -m "feat(sharer): rust signaling client with tauri event bridge"
```

---

## Task 15: End-to-End Manual Smoke Test

**Files:**
- Create: `docs/manual-test-phase1.md`

- [ ] **Step 1: Document the manual test procedure**

```markdown
# Phase 1 Manual Smoke Test

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
```

- [ ] **Step 2: Run the manual test procedure**

Walk through TC1–TC5. Document any failures and fix them before commit.

- [ ] **Step 3: Commit**

```bash
git add docs/manual-test-phase1.md
git commit -m "docs: phase 1 manual smoke test procedure"
```

---

## Phase 1 — Done When

- All 15 tasks above complete and committed.
- `npm test` passes in `backend/` and `viewer/`.
- `cargo check` passes in `sharer/src-tauri/`.
- Manual smoke test (Task 15) passes all 5 cases.
- No `TODO` / `FIXME` markers in shipped code (only in this plan).

## What's NOT in Phase 1 (Reminder)

- No screen capture
- No `<video>` element on viewer
- No WebRTC `RTCPeerConnection` — relay is JSON-only over backend
- No input injection
- No file transfer
- No TURN server
- No HTTPS/WSS — `localhost` HTTP/WS only (TLS comes in Phase 4 with deployment)

These are deliberate; they belong to Phases 2–4.
