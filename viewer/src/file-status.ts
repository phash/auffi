import type { TransferStatus } from "./file-transfer.js";
import { t } from "./i18n.js";

/** How long a finished / rejected / failed row stays before it fades out. */
export const FILE_STATUS_DISMISS_MS = 8_000;

type Row = {
  el: HTMLElement;
  text: HTMLElement;
  actions: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  /** A received file still waiting for Speichern — survives teardown. */
  savable: boolean;
};

function message(s: TransferStatus): { text: string; kind: "info" | "ok" | "err" } {
  const name = s.name;
  switch (s.phase) {
    case "waiting":
      return { text: t("file.waiting", { name }), kind: "info" };
    case "progress":
      return {
        text: t(s.direction === "send" ? "file.sending" : "file.receiving", { name, percent: s.percent }),
        kind: "info",
      };
    case "done":
      return { text: t(s.direction === "send" ? "file.sent" : "file.received", { name }), kind: "ok" };
    case "rejected":
      return { text: t("file.rejected", { name }), kind: "err" };
    case "failed":
      return { text: t("file.failed", { name }), kind: "err" };
  }
}

/**
 * One line per file transfer (wird gesendet / empfangen / fertig / abgelehnt
 * / fehlgeschlagen), so the helper is never left guessing whether a file
 * went anywhere. A received file gets a Speichern button: the download has
 * to start from a click, or Chrome asks "allow multiple downloads?" from the
 * second file on.
 */
export class FileStatusList {
  private rows = new Map<string, Row>();

  private constructor(private root: HTMLElement) {}

  static mount(parent: HTMLElement): FileStatusList {
    const root = document.createElement("div");
    root.className = "file-status-list";
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    parent.appendChild(root);
    return new FileStatusList(root);
  }

  update(status: TransferStatus): void {
    const row = this.row(status.id);
    const { text, kind } = message(status);
    row.text.textContent = text;
    row.el.classList.remove("info", "ok", "err");
    row.el.classList.add(kind);
    this.clearTimer(row);
    // Progress and a received file awaiting Speichern stay; every other
    // outcome is a one-off notice.
    const terminal = status.phase !== "waiting" && status.phase !== "progress";
    const awaitsSave = status.direction === "receive" && status.phase === "done";
    if (terminal && !awaitsSave) {
      row.timer = setTimeout(() => this.remove(status.id), FILE_STATUS_DISMISS_MS);
    }
  }

  /** Attach Speichern to a received file's row; the row goes once used. */
  offerSave(id: string, save: () => void): void {
    const row = this.row(id);
    this.clearTimer(row);
    row.savable = true;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-btn toast-btn-accept file-status-save";
    btn.textContent = t("file.save");
    btn.addEventListener("click", () => {
      save();
      this.remove(id);
    });
    row.actions.prepend(btn);
  }

  /** Session ended: in-flight and finished notices go, unsaved files stay. */
  clearTransient(): void {
    for (const [id, row] of this.rows) {
      if (!row.savable) this.remove(id);
    }
  }

  private row(id: string): Row {
    const existing = this.rows.get(id);
    if (existing) return existing;
    const el = document.createElement("div");
    el.className = "file-status-row";
    const text = document.createElement("span");
    text.className = "file-status-text";
    const actions = document.createElement("span");
    actions.className = "file-status-actions";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "file-status-close";
    close.textContent = "×";
    close.setAttribute("aria-label", t("file.dismiss"));
    close.addEventListener("click", () => this.remove(id));
    actions.appendChild(close);
    el.append(text, actions);
    this.root.appendChild(el);
    const row: Row = { el, text, actions, timer: null, savable: false };
    this.rows.set(id, row);
    return row;
  }

  private clearTimer(row: Row): void {
    if (row.timer !== null) {
      clearTimeout(row.timer);
      row.timer = null;
    }
  }

  private remove(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.clearTimer(row);
    row.el.remove();
    this.rows.delete(id);
  }
}
