// --- DataChannel types ---

export type Modifier = {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
};

export type InputEvent =
  | { kind: "mouse-move"; x: number; y: number }
  | { kind: "mouse-button"; button: "left" | "right" | "middle"; pressed: boolean }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "key"; code: string; pressed: boolean; modifiers: Modifier };

/**
 * JSON messages sent over the `files` DataChannel.
 * Binary chunk frames (ArrayBuffer with 8-byte header + payload) are handled
 * separately and are not part of this union — see docs/protocol.md for the
 * binary frame layout.
 */
export type FileEvent =
  | { kind: "file-offer"; id: string; name: string; size: number; mime: string }
  | { kind: "file-accept"; id: string }
  | { kind: "file-reject"; id: string }
  | { kind: "file-done"; id: string }
  | { kind: "file-error"; id: string; message: string };

// --- Signaling protocol types ---

export type SharerRegister = { type: "register"; role: "sharer" };
export type SharerConfirm = { type: "confirm"; accepted: boolean };
export type ViewerJoin = { type: "join"; role: "viewer"; code: string };

export type RelaySdp = { kind: "sdp"; sdp: RTCSessionDescriptionInit };
export type RelayIce = { kind: "ice"; candidate: RTCIceCandidateInit };
export type RelayHello = { kind: "hello"; ts: number };
/** Sent by the sharer when the user explicitly ends the stream, so the
 *  viewer can tear down its UI immediately with a friendly message rather
 *  than waiting for ICE to time out into a "Verbindung verloren" state. */
export type RelayBye = { kind: "bye" };
export type RelayPayload = RelaySdp | RelayIce | RelayHello | RelayBye;

export type RelayMsg = { type: "relay"; payload: RelayPayload };

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
