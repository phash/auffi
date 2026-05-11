import { randomInt } from "node:crypto";

export function generateCode(): string {
  const segments = Array.from({ length: 3 }, () =>
    randomInt(0, 1000).toString().padStart(3, "0")
  );
  return segments.join("-");
}

export function normalizeCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 20) return null;
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{9}$/.test(digits)) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`;
}

export type Peer = object;

export type Session = {
  code: string;
  sharer: Peer;
  viewer: Peer | null;
  expiresAt: number;
  failedAttempts: number;
  confirmed: boolean;
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
      confirmed: false,
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

  markConfirmed(code: string): boolean {
    const session = this.sessions.get(code);
    if (!session) return false;
    session.confirmed = true;
    return true;
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
