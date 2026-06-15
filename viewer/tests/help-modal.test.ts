import { describe, it, expect, beforeEach } from "vitest";
import { wireHelpModal } from "../src/help-modal.js";

function mount(): { trigger: HTMLButtonElement; modal: HTMLElement; close: HTMLButtonElement; backdrop: HTMLElement } {
  document.body.replaceChildren();
  const trigger = document.createElement("button");
  trigger.id = "help-trigger";
  trigger.textContent = "?";

  const modal = document.createElement("div");
  modal.id = "help-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="help-modal-backdrop" data-help-close></div>
    <div class="help-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="help-modal-title">
      <div class="help-modal-head">
        <h2 id="help-modal-title">Hilfe</h2>
        <button type="button" class="help-modal-close" data-help-close aria-label="Schließen">x</button>
      </div>
      <div class="help-modal-body">
        <details open><summary>A</summary><p>a</p></details>
        <details><summary>B</summary><p>b</p></details>
      </div>
    </div>`;
  document.body.append(trigger, modal);
  const close = modal.querySelector(".help-modal-close") as HTMLButtonElement;
  const backdrop = modal.querySelector(".help-modal-backdrop") as HTMLElement;
  return { trigger, modal, close, backdrop };
}

describe("wireHelpModal", () => {
  beforeEach(() => mount());

  it("opens the modal and moves focus inside the dialog on trigger click", () => {
    const { trigger, modal } = mount();
    wireHelpModal(trigger, modal);
    trigger.focus();
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(modal.hidden).toBe(false);
    const dialog = modal.querySelector(".help-modal-dialog") as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and restores focus to the trigger", () => {
    const { trigger, modal } = mount();
    wireHelpModal(trigger, modal);
    trigger.focus();
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const dialog = modal.querySelector(".help-modal-dialog") as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(modal.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the close button is clicked", () => {
    const { trigger, modal, close } = mount();
    wireHelpModal(trigger, modal);
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(modal.hidden).toBe(true);
  });

  it("closes when the backdrop is clicked", () => {
    const { trigger, modal, backdrop } = mount();
    wireHelpModal(trigger, modal);
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(modal.hidden).toBe(true);
  });

  it("is a no-op when trigger or modal is missing", () => {
    expect(() => wireHelpModal(null, null)).not.toThrow();
  });
});
