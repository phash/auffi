// WAI-ARIA tablist keyboard navigation.
//
// Implements the single-tab focus model: only the active tab is in the Tab
// order (tabindex=0); ArrowLeft/ArrowRight cycle through siblings with
// wrap-around, Home/End jump to first/last. Activating a tab also activates
// its panel; consumers pass an `onActivate` callback for any side effects
// they want to run when a panel becomes visible.
//
// Spec: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/

export interface SetupTabsOptions {
  tabs: HTMLButtonElement[];
  onActivate?: (panelKey: string) => void;
}

export function setupTabs({ tabs, onActivate }: SetupTabsOptions): void {
  function activate(target: HTMLButtonElement, focus: boolean): void {
    for (const b of tabs) {
      const isActive = b === target;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", String(isActive));
      b.tabIndex = isActive ? 0 : -1;
    }
    for (const p of document.querySelectorAll(".panel")) p.classList.remove("active");
    const panelKey = target.dataset.panel ?? "";
    document.getElementById(`panel-${panelKey}`)?.classList.add("active");
    onActivate?.(panelKey);
    if (focus) target.focus();
  }

  for (const b of tabs) {
    b.tabIndex = b.classList.contains("active") ? 0 : -1;
  }

  for (const btn of tabs) {
    btn.addEventListener("click", () => activate(btn, false));
    btn.addEventListener("keydown", (e) => {
      let nextIndex = -1;
      switch (e.key) {
        case "ArrowLeft":
          nextIndex = (tabs.indexOf(btn) - 1 + tabs.length) % tabs.length;
          break;
        case "ArrowRight":
          nextIndex = (tabs.indexOf(btn) + 1) % tabs.length;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = tabs.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      activate(tabs[nextIndex]!, true);
    });
  }
}
