// Compact-Status-Bar während des Streams (gh #40).
//
// Während eines aktiven Streams wird das Viewer-Card auf eine
// einzeilige Status-Zeile zusammengefaltet (Toggle oben rechts).
// Die Zeile zeigt: grüner Punkt, Status-Text, Verbindungsdauer
// (mm:ss / h:mm:ss), empfangene Datenmenge.
//
// Der Bytes-Counter pollt RTCPeerConnection.getStats() einmal pro
// Sekunde — selbe Frequenz wie die Duration, damit die UI nicht
// flackert. Der Caller liefert eine `getBytes()`-Funktion (typisch
// `() => peer.getInboundBytes()`) damit dieses Modul nichts über
// die WebRTC-Peer-Implementation weiß.

import { t } from "./i18n.js";

const STORAGE_KEY = "auffi.viewer.compactBar.collapsed";

export interface CompactBarOpts {
  app: HTMLElement | null; // #app element — bekommt .compact-Klasse
  toggle: HTMLButtonElement | null;
  durationEl: HTMLElement | null;
  bytesEl: HTMLElement | null;
  statusTextEl: HTMLElement | null;
  /** Liefert die aktuell empfangenen Bytes; Fehler => 0 zurückgeben. */
  getBytes: () => Promise<number>;
}

export class CompactBarController {
  private opts: CompactBarOpts;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private startedAt: number | null = null;

  constructor(opts: CompactBarOpts) {
    this.opts = opts;
    // Defensive: viewer tests often build a minimal DOM fixture
    // that doesn't include the compact-bar elements. Null-safe
    // construction keeps those tests passing without forcing every
    // fixture to grow.
    this.opts.toggle?.addEventListener("click", () => this.toggle());
  }

  /**
   * Stream beginnt: Timer starten, Bytes pollen, Toggle aktiv schalten,
   * letzten User-Wunsch (collapsed / expanded) aus localStorage holen.
   */
  start(): void {
    this.stop(); // idempotent
    this.startedAt = Date.now();
    this.tick(); // sofort initialwerte zeichnen
    this.tickTimer = setInterval(() => this.tick(), 1000);

    // Default-Status: expanded. Nur wenn der User vorher selbst
    // collapsed hatte, übernehmen wir das.
    const prefersCollapsed = readPrefersCollapsed();
    this.setCollapsed(prefersCollapsed);
  }

  /**
   * Stream endet: Timer stoppen, expanded-Default wiederherstellen
   * (der Card zeigt sonst beim nächsten Start kurz Stale-Werte).
   */
  stop(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.startedAt = null;
    if (this.opts.durationEl) this.opts.durationEl.textContent = "00:00";
    if (this.opts.bytesEl) this.opts.bytesEl.textContent = "0 B";
    // Card immer expanded zurückgeben — sonst wirkt der nächste
    // Pre-Stream-Screen kaputt.
    this.opts.app?.classList.remove("compact");
    this.updateAria(false);
  }

  /** Status-Text in der kompakten Zeile aktualisieren. */
  setStatus(text: string): void {
    if (this.opts.statusTextEl) this.opts.statusTextEl.textContent = text;
  }

  private toggle(): void {
    if (!this.opts.app) return;
    const next = !this.opts.app.classList.contains("compact");
    this.setCollapsed(next);
    writePrefersCollapsed(next);
  }

  private setCollapsed(collapsed: boolean): void {
    this.opts.app?.classList.toggle("compact", collapsed);
    this.updateAria(collapsed);
  }

  private updateAria(collapsed: boolean): void {
    if (!this.opts.toggle) return;
    this.opts.toggle.setAttribute("aria-expanded", String(!collapsed));
    this.opts.toggle.setAttribute(
      "aria-label",
      collapsed ? t("compactBar.expand") : t("compactBar.collapse"),
    );
  }

  private tick(): void {
    if (this.startedAt === null) return;
    const elapsedMs = Date.now() - this.startedAt;
    if (this.opts.durationEl) {
      this.opts.durationEl.textContent = formatDuration(elapsedMs);
    }
    void this.opts.getBytes().then((bytes) => {
      if (this.opts.bytesEl) this.opts.bytesEl.textContent = formatBytes(bytes);
    });
  }
}

/** mm:ss bis 1 h, danach h:mm:ss. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** Binär-präfixe (KiB/MiB/GiB) — passt zu wie OS-Datei-Größen anzeigen. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function readPrefersCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writePrefersCollapsed(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* private mode / disabled storage — silently ignore */
  }
}
