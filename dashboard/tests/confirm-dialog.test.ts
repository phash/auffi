import { describe, it, expect, beforeEach } from "vitest";
import { confirmDialog } from "../src/components/confirm-dialog.js";

function backdrop(): HTMLElement {
  return document.getElementById("admin-modal-backdrop")!;
}
function byText(text: string): HTMLButtonElement {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("#admin-modal-backdrop button"),
  ).find((b) => b.textContent === text)!;
}

describe("confirmDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves true when the confirm button is clicked and removes the modal", async () => {
    const p = confirmDialog({ title: "T", message: "m", confirmLabel: "Löschen", variant: "danger" });
    expect(backdrop()).toBeTruthy();
    byText("Löschen").click();
    expect(await p).toBe(true);
    expect(document.getElementById("admin-modal-backdrop")).toBeNull();
  });

  it("resolves false on Abbrechen", async () => {
    const p = confirmDialog({ title: "T", message: "m", confirmLabel: "Ja" });
    byText("Abbrechen").click();
    expect(await p).toBe(false);
  });

  it("resolves false on Escape", async () => {
    const p = confirmDialog({ title: "T", message: "m", confirmLabel: "Ja" });
    backdrop().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await p).toBe(false);
  });

  it("resolves false on backdrop click", async () => {
    const p = confirmDialog({ title: "T", message: "m", confirmLabel: "Ja" });
    backdrop().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await p).toBe(false);
  });

  it("is single-slot: a second dialog replaces the first", async () => {
    const p1 = confirmDialog({ title: "First", message: "m", confirmLabel: "Ja" });
    const p2 = confirmDialog({ title: "Second", message: "m", confirmLabel: "Ja" });
    expect(document.querySelectorAll("#admin-modal-backdrop").length).toBe(1);
    expect(document.getElementById("admin-modal-title")!.textContent).toBe("Second");
    byText("Ja").click();
    await p2;
    // The first promise was orphaned (its modal was replaced) — never resolves;
    // assert only that no stray modal remains.
    expect(document.getElementById("admin-modal-backdrop")).toBeNull();
    void p1;
  });

  it("returns focus to the opener after Escape", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const p = confirmDialog({ title: "T", message: "m", confirmLabel: "Ok" });
    expect(document.activeElement).not.toBe(opener);
    backdrop().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await p;
    expect(document.activeElement).toBe(opener);
  });

  it("danger variant marks the confirm button", () => {
    confirmDialog({ title: "T", message: "m", confirmLabel: "Weg", variant: "danger" });
    expect(byText("Weg").classList.contains("danger")).toBe(true);
  });
});
