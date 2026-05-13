export type SharerRegister = { type: "register"; role: "sharer" };
export type SharerConfirm = { type: "confirm"; accepted: boolean };
export type ViewerJoin = { type: "join"; role: "viewer"; code: string };

export type SdpDescription = {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
};
export type IceCandidateInit = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type RelaySdp = { kind: "sdp"; sdp: SdpDescription };
export type RelayIce = { kind: "ice"; candidate: IceCandidateInit };
export type RelayHello = { kind: "hello"; ts: number };
export type RelayPayload = RelaySdp | RelayIce | RelayHello;

export type RelayMsg = { type: "relay"; payload: RelayPayload };

export type IncomingMessage =
  | SharerRegister
  | SharerConfirm
  | ViewerJoin
  | RelayMsg
  | { type: "pw-attempt"; password: string }
  | { type: "pw-check-result"; result: "ok" | "fail" | "rejected" };

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

/**
 * Acknowledgement sent to an unattended sharer after its bearer
 * credentials verify on /signal upgrade (gh #16). Confirms that
 * `last_seen_at` has been bumped and the connection is registered;
 * the sharer can now idle waiting for `pw-check` frames (gh #17).
 */
export type UnattendedHello = {
  type: "unattended-hello";
  deviceId: string;
};

/**
 * Viewer joined with a code that resolved to a registered unattended
 * device. Prompts the viewer UI to show a password input. The viewer
 * then replies with `{type: "pw-attempt", password}` (gh #17).
 */
export type NeedsPassword = {
  type: "needs-password";
};

/**
 * Viewer's password attempt failed argon2-verify on the sharer side.
 * `attemptsLeft` counts down toward the per-device lockout threshold
 * (5 fails → 15-min lockout per spec section 6).
 */
export type WrongPassword = {
  type: "wrong-password";
  attemptsLeft: number;
};

/**
 * Per-device password attempts are exhausted. `retryAfterSec` is the
 * server-side lockout window remaining; clients SHOULD display this
 * to the user so they don't keep retrying through it.
 */
export type LockedOut = {
  type: "locked";
  retryAfterSec: number;
};

/**
 * Sharer-side decline: pw-verify succeeded but the user clicked
 * "ablehnen" in the confirm-toast (auto_accept = false case).
 */
export type RejectedByUser = {
  type: "rejected-by-user";
};

/**
 * Viewer's password attempt for an unattended-mode device.
 * Routes via the backend to the corresponding sharer's WSS as
 * `{type: "pw-check", attempt}` (gh #17).
 */
export type PwAttempt = {
  type: "pw-attempt";
  password: string;
};

/**
 * Backend → unattended sharer: a viewer is trying to connect with
 * this attempted password. Sharer argon2-verifies locally and
 * responds with `pw-check-result`.
 */
export type PwCheck = {
  type: "pw-check";
  attempt: string;
};

/**
 * Sharer → backend: result of the local argon2-verify (and the
 * optional manual-confirm dialog when auto_accept is off).
 *   - "ok"        — verified AND accepted; backend pairs the peers
 *                   for the normal SDP/ICE exchange
 *   - "fail"      — argon2-verify said no; backend increments
 *                   rate_limit_buckets, sends wrong-password
 *   - "rejected"  — argon2-verify said yes but the user clicked
 *                   ablehnen; backend forwards rejected-by-user
 */
export type PwCheckResult = {
  type: "pw-check-result";
  result: "ok" | "fail" | "rejected";
};

export type IncomingMessageUnattended = PwAttempt | PwCheckResult;

export type OutgoingMessage =
  | CodeAssigned
  | PeerJoined
  | PeerConfirmed
  | PeerRejected
  | RelayMsg
  | ErrorMessage
  | UnattendedHello
  | NeedsPassword
  | WrongPassword
  | LockedOut
  | RejectedByUser
  | PwCheck;
