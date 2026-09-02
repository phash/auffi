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
// False until the first probe has answered. Before that, "anonymous" is a
// placeholder, not a fact — the router's admin gate must not treat it as one.
let resolved = false;

type Listener = (state: SessionState) => void;
const listeners = new Set<Listener>();

export function isLoggedIn(): boolean {
  return current.loggedIn;
}

export function isAdmin(): boolean {
  return current.admin;
}

/** Whether at least one `refreshSession()` probe has answered yet. */
export function sessionResolved(): boolean {
  return resolved;
}

/**
 * Subscribe to session-state transitions. The callback fires when a
 * `refreshSession()` probe changes the cached state, plus once when the
 * very first probe answers even if the state stays anonymous — a 401 boot
 * probe changes nothing, but gates that waited for the probe (the admin
 * route-gate's placeholder) still have to re-evaluate. A later re-probe
 * confirming the status quo stays silent. Returns an unsubscribe function.
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
  const changed =
    !resolved || next.loggedIn !== current.loggedIn || next.admin !== current.admin;
  current = next;
  resolved = true;
  if (changed) {
    for (const listener of listeners) listener(next);
  }
  return next;
}

/** Test seam — reset to the unresolved anonymous boot state and drop listeners. */
export function _resetSessionForTests(): void {
  current = ANONYMOUS;
  resolved = false;
  listeners.clear();
}
