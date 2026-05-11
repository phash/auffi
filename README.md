# Screenie

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
