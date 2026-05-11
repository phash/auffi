import { SignalingClient } from "./signaling-client.js";

function setStatus(text: string, kind: "ok" | "err" | "info"): void {
  const el = document.getElementById("status")!;
  el.textContent = text;
  el.className = kind;
}

export function bindUI(backendWsUrl: string): void {
  const codeInput = document.getElementById("code") as HTMLInputElement;
  const connectBtn = document.getElementById("connect") as HTMLButtonElement;

  codeInput.addEventListener("input", () => {
    const digits = codeInput.value.replace(/\D/g, "").slice(0, 9);
    const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(
      (s) => s.length > 0
    );
    codeInput.value = parts.join("-");
  });

  connectBtn.addEventListener("click", () => {
    const code = codeInput.value.trim();
    if (!/^\d{3}-\d{3}-\d{3}$/.test(code)) {
      setStatus("Bitte 9-stelligen Code eingeben.", "err");
      return;
    }
    setStatus("Warte auf Bestätigung durch den Sharer…", "info");
    connectBtn.disabled = true;

    const client = new SignalingClient(backendWsUrl);
    client.onRelay((payload) => {
      setStatus(`Relay empfangen: ${JSON.stringify(payload)}`, "info");
    });
    client.onDisconnect((reason) => {
      setStatus(`Verbindung beendet: ${reason}`, "err");
      connectBtn.disabled = false;
    });

    client
      .join(code)
      .then(() => {
        setStatus("Verbunden mit Sharer. (Phase 1: kein Video — sende Test-Relay)", "ok");
        client.sendRelay({ hello: "from viewer", ts: Date.now() });
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        setStatus(`Fehler: ${message}`, "err");
        connectBtn.disabled = false;
      });
  });
}
