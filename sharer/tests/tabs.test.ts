import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupTabs } from "../src/tabs.js";

// @vitest-environment jsdom

// Builds a minimal tablist DOM for the test. Uses createElement instead of
// innerHTML so we don't accidentally pull untrusted-string XSS patterns
// into the test surface (the security-reminder hook flags innerHTML).
function buildTablistDOM(): { tabs: HTMLButtonElement[] } {
  document.body.replaceChildren();

  const nav = document.createElement("nav");
  nav.className = "tabs";
  nav.setAttribute("role", "tablist");

  const labels = ["A", "B", "C"];
  const panelKeys = ["a", "b", "c"];
  for (let i = 0; i < labels.length; i++) {
    const btn = document.createElement("button");
    btn.className = i === 0 ? "tab-btn active" : "tab-btn";
    btn.setAttribute("role", "tab");
    btn.dataset.panel = panelKeys[i]!;
    btn.setAttribute("aria-selected", i === 0 ? "true" : "false");
    btn.textContent = labels[i]!;
    nav.appendChild(btn);
  }
  document.body.appendChild(nav);

  for (let i = 0; i < panelKeys.length; i++) {
    const panel = document.createElement("div");
    panel.id = `panel-${panelKeys[i]}`;
    panel.className = i === 0 ? "panel active" : "panel";
    document.body.appendChild(panel);
  }

  return {
    tabs: Array.from(document.querySelectorAll<HTMLButtonElement>(".tab-btn")),
  };
}

function fire(key: string, target: HTMLElement): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

describe("setupTabs — WAI-ARIA tablist keyboard navigation (#77)", () => {
  let tabs: HTMLButtonElement[];

  beforeEach(() => {
    ({ tabs } = buildTablistDOM());
    setupTabs({ tabs });
  });

  it("initializes the single-tab focus model: active=0, others=-1", () => {
    expect(tabs[0]!.tabIndex).toBe(0);
    expect(tabs[1]!.tabIndex).toBe(-1);
    expect(tabs[2]!.tabIndex).toBe(-1);
  });

  it("ArrowRight on the active tab moves activation + focus to the next tab", () => {
    tabs[0]!.focus();
    fire("ArrowRight", tabs[0]!);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]!.classList.contains("active")).toBe(true);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("false");
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.tabIndex).toBe(0);
    expect(tabs[0]!.tabIndex).toBe(-1);
  });

  it("ArrowLeft on the first tab wraps to the last", () => {
    tabs[0]!.focus();
    fire("ArrowLeft", tabs[0]!);
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowRight on the last tab wraps to the first", () => {
    tabs[2]!.focus();
    fire("ArrowRight", tabs[2]!);
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("Home jumps to the first tab", () => {
    tabs[2]!.focus();
    fire("Home", tabs[2]!);
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("End jumps to the last tab", () => {
    tabs[0]!.focus();
    fire("End", tabs[0]!);
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
  });

  it("click activates a tab without moving focus", () => {
    tabs[0]!.focus();
    tabs[1]!.click();
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("#panel-b")!.classList.contains("active")).toBe(true);
    expect(document.querySelector("#panel-a")!.classList.contains("active")).toBe(false);
  });

  it("activating a tab toggles the matching panel", () => {
    tabs[0]!.focus();
    fire("ArrowRight", tabs[0]!);
    expect(document.querySelector("#panel-b")!.classList.contains("active")).toBe(true);
    expect(document.querySelector("#panel-a")!.classList.contains("active")).toBe(false);
  });

  it("onActivate is called with the panel key", () => {
    const onActivate = vi.fn();
    ({ tabs } = buildTablistDOM());
    setupTabs({ tabs, onActivate });
    tabs[1]!.click();
    expect(onActivate).toHaveBeenCalledWith("b");
  });

  it("unrelated keys (Tab, letters) are ignored", () => {
    tabs[0]!.focus();
    fire("Tab", tabs[0]!);
    fire("a", tabs[0]!);
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });
});
