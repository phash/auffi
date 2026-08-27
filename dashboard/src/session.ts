// Cached session/admin state for the SPA (gh review 2026-08).
//
// The dashboard probes /api/me exactly here — nowhere else. Boot and
// every auth-changing transition (login, logout, password change,
// account deletion) call `refreshSession()`; interested modules
// (main.ts nav-gate, feedback FAB, router admin-gate) read the cached
// flags via `isAdmin()`/`isLoggedIn()` and react to transitions via
// `onSessionChange`. This replaces the old one-shot bootstrap probe
// that left nav/gates/FAB stale after SPA-only login/logout.
//
// Anonymous (401) and network errors both collapse into
// { loggedIn: false, admin: false } — UX-safe default; the backend's
// requireAdmin stays the real gate.

import { getMe } from "./api.js";

export interface SessionState {
  loggedIn: boolean;
  admin: boolean;
}

const ANONYMOUS: SessionState = { loggedIn: false, admin: false };

let current: SessionState = ANONYMOUS;

type Listener = (state: SessionState) => void;
const listeners = new Set<Listener>();

export function isLoggedIn(): boolean {
  return current.loggedIn;
}

export function isAdmin(): boolean {
  return current.admin;
}

/**
 * Subscribe to session-state transitions. The callback fires only when
 * a `refreshSession()` probe actually changes the cached state (so a
 * re-probe confirming the status quo stays silent). Returns an
 * unsubscribe function.
 */
export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Re-probe /api/me and update the cached state. Call after every
 * auth-changing transition; safe to fire-and-forget (`void`) — errors
 * collapse into the anonymous state instead of throwing.
 */
export async function refreshSession(): Promise<SessionState> {
  const me = await getMe();
  const next: SessionState = me.ok
    ? { loggedIn: true, admin: me.data.admin === true }
    : ANONYMOUS;
  if (next.loggedIn !== current.loggedIn || next.admin !== current.admin) {
    current = next;
    for (const listener of listeners) listener(next);
  } else {
    current = next;
  }
  return next;
}

/** Test seam — reset to the anonymous boot state and drop listeners. */
export function _resetSessionForTests(): void {
  current = ANONYMOUS;
  listeners.clear();
}
