// Pure decision function for the Matomo-Consent-Banner. Wird sowohl von
// der Vanilla-JS-Implementierung in viewer/public/matomo-consent.js
// (statische Marketing-Pages) referenziert (logisch — die Datei dupliziert
// die paar Zeilen) als auch direkt vom Vite-Bundle der Haupt-Seite testbar.
//
// Halte beide Stellen synchron, wenn du hier etwas änderst.

export type Consent = "ok" | "no" | null;
export type Action = "load" | "banner" | "skip";

/**
 * Entscheidet, was der Banner / Matomo-Loader beim Page-Load tun soll.
 *
 * - DNT gesetzt → niemals tracken, kein Banner zeigen (User hat es im
 *   Browser bereits abgelehnt — wir respektieren das ohne nachzufragen).
 * - Consent "ok" → Matomo laden.
 * - Consent "no" → nicht laden, Banner versteckt halten (User hat schon
 *   abgelehnt; der Banner würde ihn nur nerven).
 * - Consent null (unentschieden, erster Besuch) → Banner zeigen, Matomo
 *   wartet auf den Klick.
 */
export function decideAction(consent: Consent, dnt: boolean): Action {
  if (dnt) return "skip";
  if (consent === "ok") return "load";
  if (consent === "no") return "skip";
  return "banner";
}
