// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { confirmDialog, dismissConfirmDialog } from "../src/confirm-dialog.js";

function backdrop(): HTMLElement {
  return document.getElementById("sharer-confirm-backdrop")!;
}
function btn(text: string): HTMLButtonElement {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("#sharer-confirm-backdrop button"),
  ).find((b) => b.textContent === text)!;
}

describe("confirmDialog (sharer)", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("mounts a labelled modal and resolves true on confirm", async () => {
    const p = confirmDialog({ title: "Entkoppeln", message: "Sicher?", confirmLabel: "Entkoppeln", danger: true });
    const bd = backdrop();
    expect(bd.getAttribute("role")).toBe("dialog");
    expect(bd.getAttribute("aria-modal")).toBe("true");
    expect(bd.getAttribute("aria-labelledby")).toBe("sharer-confirm-title");
    expect(btn("Entkoppeln").classList.contains("btn-danger")).toBe(true);
    btn("Entkoppeln").click();
    expect(await p).toBe(true);
    expect(document.getElementById("sharer-confirm-backdrop")).toBeNull();
  });

  it("resolves false on Abbrechen, Escape, and backdrop click", async () => {
    const p1 = confirmDialog({ title: "T", message: "m", confirmLabel: "Ja" });
    btn("Abbrechen").click();
    expect(await p1).toBe(false);

    const p2 = confirmDialog({ title: "T", message: "m", confirmLabel: "Ja" });
    backdrop().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await p2).toBe(false);

    const p3 = confirmDialog({ title: "T", message: "m", confirmLabel: "Ja" });
    backdrop().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await p3).toBe(false);
  });

  it("is single-slot: opening a second dialog removes the first", () => {
    confirmDialog({ title: "First", message: "m", confirmLabel: "Ja" });
    confirmDialog({ title: "Second", message: "m", confirmLabel: "Ja" });
    expect(document.querySelectorAll("#sharer-confirm-backdrop").length).toBe(1);
    expect(document.getElementById("sharer-confirm-title")!.textContent).toBe("Second");
  });

  it("resolves the displaced dialog's promise with false", async () => {
    const p1 = confirmDialog({ title: "First", message: "m", confirmLabel: "Ja" });
    const p2 = confirmDialog({ title: "Second", message: "m", confirmLabel: "Ja" });
    expect(await p1).toBe(false);
    btn("Ja").click();
    expect(await p2).toBe(true);
  });

  it("dismissConfirmDialog closes the open dialog resolving false", async () => {
    const p = confirmDialog({ title: "T", message: "m", confirmLabel: "Ja" });
    dismissConfirmDialog();
    expect(await p).toBe(false);
    expect(document.getElementById("sharer-confirm-backdrop")).toBeNull();
  });

  it("dismissConfirmDialog without an open dialog is a no-op", () => {
    expect(() => dismissConfirmDialog()).not.toThrow();
  });
});
