// "Beim Anmelden automatisch starten" toggle for the unattended
// settings view (gh #27). The @tauri-apps/plugin-autostart JS bindings
// are not bundled in the sharer webview, so the checkbox talks to the
// enable_autostart / disable_autostart / is_autostart_enabled Tauri
// commands instead. `invoke` is injected so the wiring is testable in
// jsdom without a Tauri runtime.

export interface AutostartToggleDeps {
  checkbox: HTMLInputElement;
  /** Status line for German error text; cleared on success. */
  statusEl: HTMLElement | null;
  invoke(cmd: string): Promise<unknown>;
}

export interface AutostartToggle {
  /** Read the OS-side truth into the checkbox. Call on view show. */
  sync(): Promise<void>;
}

export function wireAutostartToggle(deps: AutostartToggleDeps): AutostartToggle {
  const { checkbox, statusEl, invoke } = deps;

  function setStatus(text: string): void {
    if (statusEl) statusEl.textContent = text;
  }

  checkbox.addEventListener("change", () => {
    const wanted = checkbox.checked;
    void invoke(wanted ? "enable_autostart" : "disable_autostart")
      .then(() => {
        setStatus("");
      })
      .catch((e: unknown) => {
        // Revert so the checkbox never shows a state the OS refused.
        checkbox.checked = !wanted;
        setStatus(
          typeof e === "string" && e.trim().length > 0
            ? e
            : "Autostart konnte nicht geändert werden.",
        );
      });
  });

  return {
    async sync(): Promise<void> {
      try {
        checkbox.checked = (await invoke("is_autostart_enabled")) === true;
        setStatus("");
      } catch (e) {
        checkbox.checked = false;
        setStatus(
          typeof e === "string" && e.trim().length > 0
            ? e
            : "Autostart-Status konnte nicht gelesen werden.",
        );
      }
    },
  };
}
