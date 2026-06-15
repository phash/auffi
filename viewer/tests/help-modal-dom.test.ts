import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

function loadDOM(): Document {
  const html = readFileSync(resolve(__dirname, "../index.html"), "utf-8");
  return new JSDOM(html).window.document;
}

describe("Help modal markup (index.html)", () => {
  let doc: Document;
  beforeEach(() => {
    doc = loadDOM();
  });

  it("the topbar trigger is a dialog-opening button wired to the modal", () => {
    const trigger = doc.getElementById("help-trigger");
    expect(trigger).not.toBeNull();
    expect(trigger!.tagName.toLowerCase()).toBe("button");
    expect(trigger!.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger!.getAttribute("aria-controls")).toBe("help-modal");
    expect(trigger!.closest(".topbar-actions")).not.toBeNull();
  });

  it("the modal is a hidden a11y dialog with a labelled title", () => {
    const modal = doc.getElementById("help-modal") as HTMLElement | null;
    expect(modal).not.toBeNull();
    expect(modal!.hasAttribute("hidden")).toBe(true);
    const dialog = modal!.querySelector(".help-modal-dialog");
    expect(dialog!.getAttribute("role")).toBe("dialog");
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(dialog!.getAttribute("aria-labelledby")).toBe("help-modal-title");
    expect(doc.getElementById("help-modal-title")).not.toBeNull();
  });

  it("offers five how-it-works sections, the first expanded by default", () => {
    const sections = doc.querySelectorAll("#help-modal .help-section");
    expect(sections.length).toBe(5);
    expect((sections[0] as HTMLDetailsElement).hasAttribute("open")).toBe(true);
    for (let i = 1; i < sections.length; i++) {
      expect((sections[i] as HTMLDetailsElement).hasAttribute("open")).toBe(false);
    }
  });

  it("has at least one element that closes the modal", () => {
    const closers = doc.querySelectorAll("#help-modal [data-help-close]");
    expect(closers.length).toBeGreaterThanOrEqual(1);
  });
});
