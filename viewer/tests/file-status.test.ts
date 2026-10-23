import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FileStatusList, FILE_STATUS_DISMISS_MS } from "../src/file-status.js";
import type { TransferStatus } from "../src/file-transfer.js";

function st(phase: TransferStatus["phase"], extra: Partial<TransferStatus> = {}): TransferStatus {
  return { id: "t1", name: "bericht.pdf", direction: "send", phase, ...extra } as TransferStatus;
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".file-status-row"));
}

describe("FileStatusList", () => {
  let list: FileStatusList;

  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.lang = "";
    vi.useFakeTimers();
    list = FileStatusList.mount(document.body);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts one polite live region", () => {
    const root = document.querySelector(".file-status-list")!;
    expect(root.getAttribute("role")).toBe("status");
    expect(root.getAttribute("aria-live")).toBe("polite");
  });

  it("walks a send through waiting, progress and done in one row", () => {
    list.update(st("waiting"));
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("„bericht.pdf“ wartet auf Annahme durch die andere Seite");

    list.update(st("progress", { percent: 42 } as Partial<TransferStatus>));
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("„bericht.pdf“ wird gesendet … 42 %");

    list.update(st("done"));
    expect(rows()[0].textContent).toContain("„bericht.pdf“ wurde gesendet.");
    expect(rows()[0].classList.contains("ok")).toBe(true);
  });

  it("finished, rejected and failed rows go away on their own", () => {
    list.update(st("rejected"));
    expect(rows()[0].textContent).toContain("„bericht.pdf“ wurde von der anderen Seite abgelehnt.");
    expect(rows()[0].classList.contains("err")).toBe(true);
    vi.advanceTimersByTime(FILE_STATUS_DISMISS_MS);
    expect(rows()).toHaveLength(0);
  });

  it("a failed receive says so", () => {
    list.update(st("failed", { direction: "receive" }));
    expect(rows()[0].textContent).toContain("Übertragung von „bericht.pdf“ fehlgeschlagen.");
  });

  it("a receive in progress says wird empfangen", () => {
    list.update(st("progress", { direction: "receive", percent: 7 } as Partial<TransferStatus>));
    expect(rows()[0].textContent).toContain("„bericht.pdf“ wird empfangen … 7 %");
  });

  // L6: an automatic a.click() download without a user gesture trips
  // Chrome's "this site wants to download multiple files" prompt from the
  // second file on. The helper clicks Speichern instead.
  it("a received file waits for Speichern and does not expire", () => {
    const save = vi.fn();
    list.update(st("done", { direction: "receive" }));
    list.offerSave("t1", save);
    const row = rows()[0];
    expect(row.textContent).toContain("„bericht.pdf“ ist angekommen.");
    vi.advanceTimersByTime(FILE_STATUS_DISMISS_MS * 10);
    expect(rows()).toHaveLength(1);

    const btn = row.querySelector<HTMLButtonElement>("button.file-status-save")!;
    expect(btn.textContent).toBe("Speichern");
    btn.click();
    expect(save).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(0);
  });

  it("the close button dismisses a row", () => {
    list.update(st("done", { direction: "receive" }));
    list.offerSave("t1", vi.fn());
    rows()[0].querySelector<HTMLButtonElement>("button.file-status-close")!.click();
    expect(rows()).toHaveLength(0);
  });

  it("clearTransient keeps unsaved received files and drops the rest", () => {
    list.update({ id: "a", name: "a.txt", direction: "send", phase: "progress", percent: 10 });
    list.update({ id: "b", name: "b.txt", direction: "receive", phase: "done" });
    list.offerSave("b", vi.fn());
    list.clearTransient();
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("b.txt")]);
  });

  it("renders English on /en/", () => {
    document.documentElement.lang = "en";
    list.update(st("failed"));
    expect(rows()[0].textContent).toContain("Transfer of “bericht.pdf” failed.");
    document.documentElement.lang = "";
  });
});
