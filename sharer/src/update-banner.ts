// gh new-feature 2026-05-21 — Update-Notifier-Banner.
// Pure DOM-Helpers; das Wiring (Tauri-Command-Aufruf + shell-open) sitzt
// in main.ts und ist von Coverage ausgenommen.

/** UpdateInfo-Form (kommt vom Rust-Command `check_for_update`). */
export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  download_url: string;
}

/**
 * Macht den Banner sichtbar und füllt die Version ein.
 * Idempotent — mehrmaliger Aufruf legt nicht doppelt etwas an.
 */
export function showBanner(
  banner: HTMLElement,
  versionEl: HTMLElement,
  latestVersion: string,
): void {
  versionEl.textContent = latestVersion;
  banner.classList.add("visible");
}

/** Versteckt den Banner. */
export function hideBanner(banner: HTMLElement): void {
  banner.classList.remove("visible");
}

/**
 * Verdrahtet Dismiss-Button + Download-Button.
 * Der Download-Callback wird mit der gesetzten URL aufgerufen; in
 * Production ist das `shell.open(...)` aus `@tauri-apps/plugin-shell`.
 * Der Test darf einen einfachen Spy injizieren.
 */
export function attachBannerHandlers(opts: {
  banner: HTMLElement;
  dismissBtn: HTMLElement;
  downloadBtn: HTMLElement;
  downloadUrl: string;
  openUrl: (url: string) => void | Promise<void>;
}): void {
  opts.dismissBtn.addEventListener("click", () => hideBanner(opts.banner));
  opts.downloadBtn.addEventListener("click", () => {
    void opts.openUrl(opts.downloadUrl);
  });
}
