// German/English user-facing copy for connection problems. Pure functions so
// the non-technical helper never sees a raw protocol code like
// `peer-rejected: declined` or `invalid-code: no such session`.
//
// The raw strings come from two places in signaling-client.ts:
//   - join() rejects with `peer-rejected: <reason>`, `<code>: <message>`,
//     `locked:<secs>`, or `rejected-by-user`
//   - onDisconnect() reports `closed` when the socket drops before the
//     session is confirmed.
//
// The actual text lives in the i18n catalog (i18n.ts); these functions only
// decide WHICH message + status-kind applies. Language defaults to the page
// language (German on /, English on /en/).

import { t, currentLang, type Lang } from "./i18n.js";

export type StatusKind = "ok" | "err" | "info";

export interface JoinErrorMessage {
  text: string;
  kind: StatusKind;
}

function lockoutMessage(raw: string, lang: Lang): JoinErrorMessage {
  const secs = Number(raw.slice("locked:".length));
  const mins = Math.max(1, Math.ceil((Number.isFinite(secs) ? secs : 0) / 60));
  return { text: t("join.lockout", { mins }, lang), kind: "err" };
}

function fromPeerRejected(reason: string, lang: Lang): JoinErrorMessage {
  switch (reason) {
    case "declined":
      return { text: t("join.declined", {}, lang), kind: "info" };
    case "sharer-gone":
      return { text: t("join.sharerGone", {}, lang), kind: "err" };
    case "expired":
      return { text: t("join.expired", {}, lang), kind: "err" };
    default:
      return { text: t("join.declined", {}, lang), kind: "info" };
  }
}

function fromErrorCode(code: string, message: string, lang: Lang): JoinErrorMessage {
  switch (code) {
    case "invalid-code":
      if (message.includes("session full")) {
        return { text: t("join.sessionFull", {}, lang), kind: "err" };
      }
      return { text: t("join.invalidCode", {}, lang), kind: "err" };
    case "rate-limit":
      return { text: t("join.rateLimit", {}, lang), kind: "err" };
    case "bad-message":
      return { text: t("join.badMessage", {}, lang), kind: "err" };
    default:
      return { text: t("join.generic", {}, lang), kind: "err" };
  }
}

const KNOWN_ERROR_CODES = new Set([
  "invalid-code",
  "rate-limit",
  "bad-message",
]);

export function friendlyJoinError(raw: string, lang: Lang = currentLang()): JoinErrorMessage {
  if (raw.startsWith("locked:")) return lockoutMessage(raw, lang);
  if (raw === "rejected-by-user") return { text: t("join.declined", {}, lang), kind: "info" };
  if (raw === "closed") return { text: t("join.connectionLost", {}, lang), kind: "err" };
  if (raw.startsWith("peer-rejected:")) {
    return fromPeerRejected(raw.slice("peer-rejected:".length).trim(), lang);
  }
  const sep = raw.indexOf(":");
  if (sep > 0) {
    const code = raw.slice(0, sep).trim();
    const message = raw.slice(sep + 1).trim();
    if (KNOWN_ERROR_CODES.has(code)) return fromErrorCode(code, message, lang);
  }
  return { text: t("join.generic", {}, lang), kind: "err" };
}

export interface ConnectTimeoutContext {
  /** true once the sharer confirmed (the join promise resolved). */
  confirmed: boolean;
  /** true if a TURN relay was offered (fetchIceServers returned ≥1 server). */
  relayAvailable: boolean;
}

export function connectTimeoutMessage(ctx: ConnectTimeoutContext, lang: Lang = currentLang()): string {
  if (!ctx.confirmed) return t("timeout.notConfirmed", {}, lang);
  if (ctx.relayAvailable) return t("timeout.media", {}, lang);
  return t("timeout.firewall", {}, lang);
}
