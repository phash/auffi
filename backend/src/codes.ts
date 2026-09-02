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
  confirmed: boolean;
};

export type StoreConfig = {
  ttlMs: number;
  /**
   * Called fire-and-forget after every successful code mint. Used for
   * aggregate "are we being used" counters (see tracking/matomo.ts).
   * MUST NOT throw — the store does not catch it because the contract
   * is that this is a no-op observer. Default: undefined.
   */
  onCodeCreated?: () => void;
};

export class SessionStore {
  private sessions = new Map<string, Session>();
  private byPeer = new Map<Peer, string>();
  private onExpiredDrop: ((session: Session) => void) | null = null;
  constructor(private cfg: StoreConfig) {}

  /**
   * Register the observer notified whenever an EXPIRED session is
   * dropped (lazily in `getSession`, or by the periodic sweep). The
   * signaling layer uses this to send `peer-rejected reason:"expired"`
   * to a viewer still waiting on the sharer's confirm — the store
   * itself stays wire-agnostic. A single slot, not a list: exactly one
   * signaling registration owns a store.
   */
  setOnExpiredDrop(listener: (session: Session) => void): void {
    this.onExpiredDrop = listener;
  }

  registerSharer(sharer: Peer): { code: string; session: Session } {
    // Iteration cap so a wedged CSPRNG (or a 10^9-saturated keyspace) raises
    // an alarm instead of looping forever. 32 attempts at uniform random over
    // 10^9 codes is astronomically unlikely to collide naturally.
    let code: string | undefined;
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = generateCode();
      if (!this.sessions.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (code === undefined) {
      throw new Error("code generation failed: keyspace exhausted or RNG fault");
    }
    const session: Session = {
      code,
      sharer,
      viewer: null,
      expiresAt: Date.now() + this.cfg.ttlMs,
      confirmed: false,
    };
    this.sessions.set(code, session);
    this.byPeer.set(sharer, code);
    this.cfg.onCodeCreated?.();
    return { code, session };
  }

  attachViewer(code: string, viewer: Peer): Session | null {
    const session = this.getJoinableSession(code);
    if (!session) return null;
    session.viewer = viewer;
    this.byPeer.set(viewer, code);
    return session;
  }

  /**
   * Peer-facing lookup: a CONFIRMED session outlives its code TTL —
   * the 10-minute cap applies to the CODE, not to an established
   * pairing. Killing it here would silently drop mid-stream relay
   * frames (the viewer's courteous `bye`, ICE restarts after a Wi-Fi
   * blip); teardown of confirmed sessions belongs to the peers' close
   * handlers. An expired UNCONFIRMED session is reaped lazily, with
   * the `setOnExpiredDrop` observer told about it.
   */
  getSession(code: string): Session | null {
    const session = this.sessions.get(code);
    if (!session) return null;
    if (Date.now() > session.expiresAt && !session.confirmed) {
      this.dropExpired(session);
      return null;
    }
    return session;
  }

  /**
   * Join-gate lookup: an expired code is never joinable again, even
   * while its confirmed session is still streaming.
   */
  getJoinableSession(code: string): Session | null {
    const session = this.getSession(code);
    if (!session) return null;
    if (Date.now() > session.expiresAt) return null;
    return session;
  }

  findByPeer(peer: Peer): Session | null {
    const code = this.byPeer.get(peer);
    return code ? this.getSession(code) : null;
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
    // The accept belonged to THIS viewer. Without the reset `confirmed`
    // stays latched `true` after the first viewer leaves: the relay gate
    // (`signaling.ts` "if (!found.confirmed) return") would stand open for
    // whoever redeems the still-valid code next before any human clicked
    // Akzeptieren, and the sharer's decline (`confirm:false`, guarded by
    // "if (found.confirmed) return") would be silently swallowed — both
    // break "the sharer confirms every incoming peer". It also makes the
    // session expirable again.
    session.confirmed = false;
  }

  /**
   * Proactively delete expired sessions so the Map does not grow
   * without bound when sharers disconnect without closing cleanly.
   * Called from the server's periodic sweep. CONFIRMED sessions are
   * exempt (see `getSession`) — they are torn down by the peers'
   * close handlers, never mid-stream by the sweep.
   */
  sweepExpired(now: number = Date.now()): void {
    for (const session of this.sessions.values()) {
      if (session.expiresAt < now && !session.confirmed) {
        this.dropExpired(session);
      }
    }
  }

  private dropExpired(session: Session): void {
    this.dropSession(session);
    this.onExpiredDrop?.(session);
  }

  private dropSession(session: Session): void {
    this.sessions.delete(session.code);
    this.byPeer.delete(session.sharer);
    if (session.viewer) this.byPeer.delete(session.viewer);
  }
}
