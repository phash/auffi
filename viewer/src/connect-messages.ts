// German user-facing copy for connection problems. Pure functions so the
// non-technical helper never sees a raw protocol code like
// `peer-rejected: declined` or `invalid-code: no such session`.
//
// The raw strings come from two places in signaling-client.ts:
//   - join() rejects with `peer-rejected: <reason>`, `<code>: <message>`,
//     `locked:<secs>`, or `rejected-by-user`
//   - onDisconnect() reports `closed` when the socket drops before the
//     session is confirmed.

export type StatusKind = "ok" | "err" | "info";

export interface JoinErrorMessage {
  text: string;
  kind: StatusKind;
}

function lockoutMessage(raw: string): JoinErrorMessage {
  const secs = Number(raw.slice("locked:".length));
  const mins = Math.max(1, Math.ceil((Number.isFinite(secs) ? secs : 0) / 60));
  return {
    text: `Zu viele Fehlversuche. Gesperrt für ca. ${mins} Min — bitte später erneut versuchen.`,
    kind: "err",
  };
}

const DECLINED: JoinErrorMessage = {
  text: "Der Sharer hat die Verbindung abgelehnt.",
  kind: "info",
};

const EXPIRED: JoinErrorMessage = {
  text: "Der Code ist abgelaufen oder wurde nach zu vielen Fehlversuchen gesperrt. Bitte beim Helfer einen neuen Code anfragen.",
  kind: "err",
};

function fromPeerRejected(reason: string): JoinErrorMessage {
  switch (reason) {
    case "declined":
      return DECLINED;
    case "sharer-gone":
      return {
        text: "Der andere Computer ist nicht mehr erreichbar. Bitte beim Helfer nachfragen und erneut verbinden.",
        kind: "err",
      };
    case "expired":
      return EXPIRED;
    default:
      return DECLINED;
  }
}

function fromErrorCode(code: string, message: string): JoinErrorMessage {
  switch (code) {
    case "invalid-code":
      if (message.includes("session full")) {
        return {
          text: "Zu dieser Sitzung ist bereits jemand verbunden. Bitte beim Helfer einen neuen Code anfragen.",
          kind: "err",
        };
      }
      return {
        text: "Dieser Code ist nicht (mehr) gültig. Bitte beim Helfer nach einem aktuellen Code fragen.",
        kind: "err",
      };
    case "code-expired":
      return {
        text: "Der Code wurde nach zu vielen Fehlversuchen gesperrt. Bitte beim Helfer einen neuen Code anfragen.",
        kind: "err",
      };
    case "rate-limit":
      return {
        text: "Zu viele Versuche in kurzer Zeit. Bitte einen Moment warten und erneut versuchen.",
        kind: "err",
      };
    case "bad-message":
      return {
        text: "Unerwartete Antwort vom Server. Bitte die Seite neu laden und erneut versuchen.",
        kind: "err",
      };
    default:
      return GENERIC;
  }
}

const GENERIC: JoinErrorMessage = {
  text: "Verbindung fehlgeschlagen. Bitte erneut versuchen.",
  kind: "err",
};

const KNOWN_ERROR_CODES = new Set([
  "invalid-code",
  "code-expired",
  "rate-limit",
  "bad-message",
]);

export function friendlyJoinError(raw: string): JoinErrorMessage {
  if (raw.startsWith("locked:")) return lockoutMessage(raw);
  if (raw === "rejected-by-user") return DECLINED;
  if (raw === "closed") {
    return {
      text: "Verbindung zum Server verloren. Bitte erneut versuchen.",
      kind: "err",
    };
  }
  if (raw.startsWith("peer-rejected:")) {
    return fromPeerRejected(raw.slice("peer-rejected:".length).trim());
  }
  const sep = raw.indexOf(":");
  if (sep > 0) {
    const code = raw.slice(0, sep).trim();
    const message = raw.slice(sep + 1).trim();
    if (KNOWN_ERROR_CODES.has(code)) return fromErrorCode(code, message);
  }
  return GENERIC;
}

export interface ConnectTimeoutContext {
  /** true once the sharer confirmed (the join promise resolved). */
  confirmed: boolean;
  /** true if a TURN relay was offered (fetchIceServers returned ≥1 server). */
  relayAvailable: boolean;
}

export function connectTimeoutMessage(ctx: ConnectTimeoutContext): string {
  if (!ctx.confirmed) {
    return "Keine Antwort vom anderen Computer. Wurde die Anfrage am anderen Computer bestätigt? Bitte erneut versuchen.";
  }
  if (ctx.relayAvailable) {
    return "Verbindung steht, aber es kommt kein Bild an. Bitte erneut versuchen.";
  }
  return "Verbindung konnte nicht hergestellt werden. Falls du in einem Firmen- oder Hochschulnetz bist, blockiert dort evtl. eine Firewall die Verbindung. Bitte erneut versuchen oder ein anderes Netzwerk nutzen.";
}
