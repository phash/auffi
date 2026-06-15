// Lightweight runtime i18n for the viewer app's DYNAMIC strings (status
// messages, connection errors, button labels generated in TS). Static page
// copy lives in the HTML itself (German in index.html, English in
// /en/index.html). The language is taken from <html lang> so the SAME bundle
// renders German on / and English on /en/; navigator language is a fallback.
//
// `de` entries MUST match the previously-hardcoded German strings verbatim —
// the existing tests assert them, and in jsdom `document.documentElement.lang`
// is empty, so currentLang() falls back to "de".

export type Lang = "de" | "en";

export function currentLang(): Lang {
  // Language is determined by the PAGE (the English mirror under /en/ sets
  // <html lang="en">); German is the default for every other page. We do NOT
  // sniff navigator.language — that would make the same URL render
  // inconsistently for crawlers vs users and break per-URL SEO/hreflang.
  if (typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("en")) {
    return "en";
  }
  return "de";
}

type Params = Record<string, string | number>;
type Entry = string | ((p: Params) => string);

const MESSAGES: Record<Lang, Record<string, Entry>> = {
  de: {
    // status / teardown (ui.ts)
    "status.awaitingConfirm": "Warte auf Bestätigung durch den Sharer…",
    "status.connectedReceiving": "Verbunden — empfange Stream…",
    "status.streamRunning": "Stream läuft.",
    "status.connecting": "Verbindung wird hergestellt …",
    "status.enterCode": "Bitte 9-stelligen Code eingeben.",
    "status.checkingPassword": "Passwort wird geprüft…",
    "teardown.endedCanReconnect": "Verbindung beendet. Möchtest du doch nochmal verbinden?",
    "teardown.disconnected": "Getrennt.",
    "teardown.cancelled": "Verbindung abgebrochen.",
    "teardown.relayLimit": "Relay-Limit erreicht — Premium kommt bald.",
    "teardown.sharerEnded": "Der Sharer hat den Stream beendet.",
    "teardown.cancelledByHelper": "Vom Helfer abgebrochen.",
    "pw.prompt": "Dieses Gerät ist passwortgeschützt. Bitte das Geräte-Passwort eingeben.",
    "pw.wrong": (p) => `Falsches Passwort. Noch ${p.n} Versuch${p.n === 1 ? "" : "e"}.`,
    "input.controlActive": "Steuerung aktiv (Esc zum Beenden)",
    "input.controlEnable": "Steuerung aktivieren",
    "compactBar.expand": "Bereich ausklappen",
    "compactBar.collapse": "Bereich einklappen",
    "zoom.resetAria": (p) => `Originalgröße (${p.zoom})`,
    "conn.relay": "Über Relay",
    "conn.direct": "Direkt",
    "fullscreen.enter": "Vollbild",
    "fullscreen.exit": "Vollbild verlassen",
    "teardown.sdpError": (p) => `SDP-Fehler: ${p.msg}`,
    "teardown.iceError": "ICE-Fehler.",
    "summary.connDirect": "Direkt (peer-to-peer)",
    "summary.connRelay": "Über Relay-Server",
    "summary.connUnknown": "Unbekannt",
    "signup.created": "Konto angelegt — bitte E-Mail-Eingang prüfen.",
    "signup.body": "Wir haben dir einen Bestätigungs-Link an deine Adresse geschickt. Erst nach Klick auf den Link kannst du dich einloggen.",
    "signup.dismiss": "Hinweis schließen",
    // ICE (ice-state-handler.ts)
    "ice.unstable": "Verbindung instabil — versuche, sie wiederherzustellen…",
    "ice.lost": "Verbindung verloren.",
    // join errors (connect-messages.ts)
    "join.declined": "Der Sharer hat die Verbindung abgelehnt.",
    "join.expired": "Der Code ist abgelaufen. Bitte beim Helfer einen neuen Code anfragen.",
    "join.lockout": (p) => `Zu viele Fehlversuche. Gesperrt für ca. ${p.mins} Min — bitte später erneut versuchen.`,
    "join.sharerGone": "Der andere Computer ist nicht mehr erreichbar. Bitte beim Helfer nachfragen und erneut verbinden.",
    "join.invalidCode": "Dieser Code ist nicht (mehr) gültig. Bitte beim Helfer nach einem aktuellen Code fragen.",
    "join.sessionFull": "Zu dieser Sitzung ist bereits jemand verbunden. Bitte beim Helfer einen neuen Code anfragen.",
    "join.rateLimit": "Zu viele Versuche in kurzer Zeit. Bitte einen Moment warten und erneut versuchen.",
    "join.badMessage": "Unerwartete Antwort vom Server. Bitte die Seite neu laden und erneut versuchen.",
    "join.connectionLost": "Verbindung zum Server verloren. Bitte erneut versuchen.",
    "join.generic": "Verbindung fehlgeschlagen. Bitte erneut versuchen.",
    // connect timeout (connect-messages.ts)
    "timeout.notConfirmed": "Keine Antwort vom anderen Computer. Wurde die Anfrage am anderen Computer bestätigt? Bitte erneut versuchen.",
    "timeout.media": "Verbindung steht, aber es kommt kein Bild an. Bitte erneut versuchen.",
    "timeout.firewall": "Verbindung konnte nicht hergestellt werden. Falls du in einem Firmen- oder Hochschulnetz bist, blockiert dort evtl. eine Firewall die Verbindung. Bitte erneut versuchen oder ein anderes Netzwerk nutzen.",
  },
  en: {
    "status.awaitingConfirm": "Waiting for the other computer to accept…",
    "status.connectedReceiving": "Connected — receiving stream…",
    "status.streamRunning": "Stream is running.",
    "status.connecting": "Connecting …",
    "status.enterCode": "Please enter the 9-digit code.",
    "status.checkingPassword": "Checking password…",
    "teardown.endedCanReconnect": "Connection ended. Would you like to reconnect?",
    "teardown.disconnected": "Disconnected.",
    "teardown.cancelled": "Connection cancelled.",
    "teardown.relayLimit": "Relay limit reached — premium coming soon.",
    "teardown.sharerEnded": "The other side ended the stream.",
    "teardown.cancelledByHelper": "Cancelled.",
    "pw.prompt": "This device is password-protected. Please enter the device password.",
    "pw.wrong": (p) => `Wrong password. ${p.n} attempt${p.n === 1 ? "" : "s"} left.`,
    "input.controlActive": "Control active (Esc to stop)",
    "input.controlEnable": "Enable control",
    "compactBar.expand": "Expand section",
    "compactBar.collapse": "Collapse section",
    "zoom.resetAria": (p) => `Original size (${p.zoom})`,
    "conn.relay": "Via relay",
    "conn.direct": "Direct",
    "fullscreen.enter": "Fullscreen",
    "fullscreen.exit": "Exit fullscreen",
    "teardown.sdpError": (p) => `SDP error: ${p.msg}`,
    "teardown.iceError": "ICE error.",
    "summary.connDirect": "Direct (peer-to-peer)",
    "summary.connRelay": "Via relay server",
    "summary.connUnknown": "Unknown",
    "signup.created": "Account created — please check your inbox.",
    "signup.body": "We've sent a confirmation link to your address. You can only log in after clicking that link.",
    "signup.dismiss": "Dismiss",
    "ice.unstable": "Connection unstable — trying to recover…",
    "ice.lost": "Connection lost.",
    "join.declined": "The other side declined the connection.",
    "join.expired": "The code has expired. Please ask the other person for a new code.",
    "join.lockout": (p) => `Too many failed attempts. Locked for about ${p.mins} min — please try again later.`,
    "join.sharerGone": "The other computer is no longer reachable. Please check and try connecting again.",
    "join.invalidCode": "This code is not (or no longer) valid. Please ask the other person for a current code.",
    "join.sessionFull": "Someone is already connected to this session. Please ask the other person for a new code.",
    "join.rateLimit": "Too many attempts in a short time. Please wait a moment and try again.",
    "join.badMessage": "Unexpected response from the server. Please reload the page and try again.",
    "join.connectionLost": "Lost connection to the server. Please try again.",
    "join.generic": "Connection failed. Please try again.",
    "timeout.notConfirmed": "No response from the other computer. Was the request accepted on the other side? Please try again.",
    "timeout.media": "Connected, but no picture is coming through. Please try again.",
    "timeout.firewall": "Could not establish a connection. If you're on a corporate or university network, a firewall may be blocking it. Please try again or use a different network.",
  },
};

export function t(key: string, params: Params = {}, lang: Lang = currentLang()): string {
  const entry = MESSAGES[lang][key] ?? MESSAGES.de[key];
  if (entry === undefined) return key;
  return typeof entry === "function" ? entry(params) : entry;
}
