import "./styles.css";
import { bindUI } from "./ui.js";

function deriveBackendWsUrl(): string {
  const explicit = import.meta.env.VITE_BACKEND_WS;
  if (explicit) return explicit;

  // When the page is served over HTTP(S), assume the signaling server lives at
  // the same origin behind a reverse proxy — this matches the production
  // deployment where Caddy reverse-proxies /signal to the backend container.
  // Falls back to the dev backend on plain localhost when neither file:// nor
  // a remote origin is detected.
  const { protocol, host } = window.location;
  if (protocol === "https:") return `wss://${host}/signal`;
  if (protocol === "http:" && host && host !== "localhost") return `ws://${host}/signal`;
  return "ws://localhost:8080/signal";
}

bindUI(deriveBackendWsUrl());
