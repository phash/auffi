import { describe, it, expect, beforeEach } from "vitest";
import {
  confirmWithReason,
  reasonIsValid,
  MIN_REASON_LEN,
} from "../src/components/confirm-with-reason.js";

describe("reasonIsValid", () => {
  it(`requires at least ${MIN_REASON_LEN} non-whitespace chars`, () => {
    expect(reasonIsValid("")).toBe(false);
    expect(reasonIsValid("short")).toBe(false);
    expect(reasonIsValid("123456789")).toBe(false); // 9
    expect(reasonIsValid("1234567890")).toBe(true); // exactly 10
    expect(reasonIsValid("genug grund vorhanden")).toBe(true);
  });

  it("trims whitespace before measuring", () => {
    // 10 chars of whitespace must NOT count as a valid reason.
    expect(reasonIsValid("          ")).toBe(false);
    expect(reasonIsValid("  short   ")).toBe(false);
    expect(reasonIsValid("  1234567890  ")).toBe(true);
  });
});

describe("confirmWithReason modal", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("mounts a single modal and reuses the slot on a second open", async () => {
    const p1 = confirmWithReason({
      title: "A",
      message: "first",
      confirmLabel: "OK",
    });
    expect(document.querySelectorAll(".admin-modal-backdrop").length).toBe(1);
    const p2 = confirmWithReason({
      title: "B",
      message: "second",
      confirmLabel: "OK",
    });
    expect(document.querySelectorAll(".admin-modal-backdrop").length).toBe(1);
    // The first modal got remounted — its promise stays unresolved until
    // its DOM goes away (which the second open did). The new modal's
    // cancel-click closes the SECOND promise; the first one we just
    // leave hanging here — jsdom doesn't surface unsettled promises.
    const cancelBtn = document.querySelector(
      ".admin-modal-actions .btn:not(.primary):not(.danger)",
    )! as HTMLButtonElement;
    cancelBtn.click();
    await expect(p2).resolves.toBeNull();
    // Quiet the unused-Promise warning.
    void p1;
  });

  it("resolves with null on Cancel", async () => {
    const p = confirmWithReason({
      title: "Test",
      message: "x",
      confirmLabel: "Ja",
    });
    const cancelBtn = document.querySelector(
      ".admin-modal-actions .btn:not(.primary):not(.danger)",
    )! as HTMLButtonElement;
    cancelBtn.click();
    expect(await p).toBeNull();
  });

  it("resolves with null on Escape", async () => {
    const p = confirmWithReason({
      title: "Test",
      message: "x",
      confirmLabel: "Ja",
    });
    // Escape bubbles from the focused field up to the dialog (the trap
    // listens on the backdrop), so dispatch it there.
    const backdrop = document.getElementById("admin-modal-backdrop")!;
    backdrop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(await p).toBeNull();
  });

  it("resolves with null on backdrop click (outside modal)", async () => {
    const p = confirmWithReason({
      title: "Test",
      message: "x",
      confirmLabel: "Ja",
    });
    const backdrop = document.getElementById("admin-modal-backdrop")!;
    // Klick auf backdrop (Event.target === backdrop)
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(await p).toBeNull();
  });

  it("keeps the confirm button disabled until the reason is long enough", async () => {
    const p = confirmWithReason({
      title: "Test",
      message: "x",
      confirmLabel: "Ja",
    });
    const textarea = document.querySelector(".admin-modal-reason") as HTMLTextAreaElement;
    const confirm = document.querySelector(
      ".admin-modal-actions .btn.primary",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    textarea.value = "kurz";
    textarea.dispatchEvent(new Event("input"));
    expect(confirm.disabled).toBe(true);
    textarea.value = "lang genug 1234";
    textarea.dispatchEvent(new Event("input"));
    expect(confirm.disabled).toBe(false);

    // Cleanup the promise.
    document
      .getElementById("admin-modal-backdrop")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await p;
  });

  it("resolves with the trimmed reason on Confirm", async () => {
    const p = confirmWithReason({
      title: "Test",
      message: "x",
      confirmLabel: "Ja",
    });
    const textarea = document.querySelector(".admin-modal-reason") as HTMLTextAreaElement;
    const confirm = document.querySelector(
      ".admin-modal-actions .btn.primary",
    ) as HTMLButtonElement;
    textarea.value = "   weil das so ist     ";
    textarea.dispatchEvent(new Event("input"));
    confirm.click();
    expect(await p).toBe("weil das so ist");
  });
});
