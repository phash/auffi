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

/**
 * TURN credentials a code may mint before any viewer joined it, and how many
 * more each join adds. Every credential is a distinct TURN username and
 * coturn caps allocations server-wide, while anyone can get a code by
 * registering as a sharer — unbudgeted, one code minted credentials without
 * end. The legitimate pattern is one fetch per side per (re)join: the viewer
 * fetches BEFORE its join, the sharer after accepting it. The up-front
 * allowance covers the viewer's pre-join fetch plus a few retries that never
 * reached a join; each join refills exactly the pair it causes.
 */
export const TURN_CREDENTIALS_UP_FRONT = 4;
export const TURN_CREDENTIALS_PER_JOIN = 2;

/**
 * How long a session whose CONFIRMED viewer dropped stays joinable, even
 * past the code TTL — the product goal's "reuses the same session on
 * reconnect within 30 s". The TTL caps the code for NEW helpers; it must
 * not lock out the helper of a session that has been running for an hour.
 * The returning viewer is still confirmed by the sharer afresh.
 */
export const RECONNECT_GRACE_MS = 30_000;
/**
 * Once a viewer re-joined inside the grace window, how long the session is
 * held for the sharer's re-confirm. Matches the viewer's own 60 s
 * confirm backstop (viewer/src/ui.ts).
 */
export const RECONNECT_CONFIRM_WINDOW_MS = 60_000;

export type Session = {
  code: string;
  sharer: Peer;
  viewer: Peer | null;
  expiresAt: number;
  confirmed: boolean;
  /**
   * Set when a CONFIRMED viewer drops (RECONNECT_GRACE_MS) or re-joins
   * inside that grace (RECONNECT_CONFIRM_WINDOW_MS): until then the
   * session is joinable and not reaped, whatever the code TTL says.
   */
  reconnectUntil: number | null;
  turnCredentialsIssued: number;
  turnCredentialBudget: number;
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

function isJoinable(session: Session, now: number): boolean {
  return (
    now <= session.expiresAt || (session.reconnectUntil !== null && now <= session.reconnectUntil)
  );
}

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
      reconnectUntil: null,
      turnCredentialsIssued: 0,
      turnCredentialBudget: TURN_CREDENTIALS_UP_FRONT,
    };
    this.sessions.set(code, session);
    this.byPeer.set(sharer, code);
    this.cfg.onCodeCreated?.();
    return { code, session };
  }

  attachViewer(code: string, viewer: Peer): Session | null {
    const session = this.getJoinableSession(code);
    if (!session) return null;
    const now = Date.now();
    if (now > session.expiresAt) {
      // Joined on the reconnect grace alone: hold the session while the
      // sharer re-confirms instead of reaping it at the grace's end.
      session.reconnectUntil = now + RECONNECT_CONFIRM_WINDOW_MS;
    }
    session.viewer = viewer;
    session.turnCredentialBudget += TURN_CREDENTIALS_PER_JOIN;
    this.byPeer.set(viewer, code);
    return session;
  }

  /**
   * Gate for POST /turn-credentials: "unknown" when no live session holds
   * the code, "exhausted" when its budget (see TURN_CREDENTIALS_UP_FRONT) is
   * spent, otherwise "ok" with one credential counted against it.
   */
  claimTurnCredential(code: string): "ok" | "exhausted" | "unknown" {
    const session = this.getSession(code);
    if (!session) return "unknown";
    if (session.turnCredentialsIssued >= session.turnCredentialBudget) return "exhausted";
    session.turnCredentialsIssued += 1;
    return "ok";
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
    if (!session.confirmed && !isJoinable(session, Date.now())) {
      this.dropExpired(session);
      return null;
    }
    return session;
  }

  /**
   * Join-gate lookup: an expired code is not joinable again — even while
   * its confirmed session is still streaming — except inside the reconnect
   * grace of a session whose confirmed viewer dropped.
   */
  getJoinableSession(code: string): Session | null {
    const session = this.getSession(code);
    if (!session) return null;
    return isJoinable(session, Date.now()) ? session : null;
  }

  findByPeer(peer: Peer): Session | null {
    const code = this.byPeer.get(peer);
    return code ? this.getSession(code) : null;
  }

  markConfirmed(code: string): boolean {
    const session = this.sessions.get(code);
    if (!session) return false;
    session.confirmed = true;
    session.reconnectUntil = null;
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
    // session expirable again — after the reconnect grace, if this viewer
    // had been accepted.
    if (session.confirmed) session.reconnectUntil = Date.now() + RECONNECT_GRACE_MS;
    session.confirmed = false;
  }

  /**
   * Proactively delete expired sessions so the Map does not grow
   * without bound when sharers disconnect without closing cleanly.
   * Called from the server's periodic sweep. CONFIRMED sessions are
   * exempt (see `getSession`) — they are torn down by the peers'
   * close handlers, never mid-stream by the sweep — and so are sessions
   * inside their reconnect grace.
   */
  sweepExpired(now: number = Date.now()): void {
    for (const session of this.sessions.values()) {
      if (!session.confirmed && !isJoinable(session, now)) {
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
