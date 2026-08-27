/** Der Ausschnitt von `window.location`, den die Ableitung braucht —
 *  als Parameter, damit die Funktion pur und ohne jsdom-Stubs testbar ist. */
export interface LocationParts {
  protocol: string;
  host: string;
  hostname: string;
}

/**
 * Leitet die Signaling-WebSocket-URL aus der Seiten-URL ab.
 *
 * Über HTTP(S) ausgelieferte Seiten nehmen den eigenen Origin an — das
 * entspricht dem Production-Deployment, wo Caddy `/signal` auf den
 * Backend-Container reverse-proxied. Auf plain localhost / 127.0.0.1
 * (vite dev, egal auf welchem Port) und file:// fällt die Ableitung auf
 * den dev-Backend-Port 8080 zurück — der vite-Server hat keinen
 * /signal-Proxy.
 */
export function deriveBackendWsUrl(
  loc: LocationParts,
  explicit: string | undefined,
): string {
  if (explicit) return explicit;
  const isLoopback = loc.hostname === "localhost" || loc.hostname === "127.0.0.1";
  if (loc.protocol === "https:") return `wss://${loc.host}/signal`;
  if (loc.protocol === "http:" && loc.hostname && !isLoopback) {
    return `ws://${loc.host}/signal`;
  }
  return "ws://localhost:8080/signal";
}
