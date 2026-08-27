// Logout control — mounts an "Abmelden" button into `container`.
//
// Placed in its own module so it is tree-shakeable and, more importantly,
// unit-testable independent of the `main.ts` bootstrap wiring layer
// (main.ts is excluded from vitest coverage per vitest.config.ts).
//
// Behaviour on click:
//   1. POST /api/auth/logout (best-effort — session cookie may already be
//      gone on a shared browser; we don't block on the result).
//   2. navigate('/login') unconditionally — even when the API rejects.
//      The user is always sent to login so they can confirm they're out.

import { logout } from "./api.js";
import { navigate } from "./router.js";
import { refreshSession } from "./session.js";

/**
 * Mount an "Abmelden" ghost-pill button inside `container` (expected to be
 * `.topbar-meta`).  Groups the existing `.topbar-viewer-link` and the new
 * button in a `.topbar-actions` flex wrapper so both sit flush to the right
 * without the brand drifting to the centre.
 *
 * Returns the created button so callers can adjust aria attributes if needed.
 */
export function mountLogoutButton(container: HTMLElement): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "topbar-logout-btn";
  btn.textContent = "Abmelden";

  btn.addEventListener("click", () => {
    void logout().finally(() => {
      navigate("/login");
      // Re-probe so nav/admin-gate/FAB drop the ended session.
      void refreshSession();
    });
  });

  // Group the viewer-link (already in the topbar-meta from index.html) and
  // the new logout button in a single flex row so space-between keeps them
  // flush-right as a unit.
  const viewerLink = container.querySelector<HTMLElement>(".topbar-viewer-link");
  if (viewerLink !== null) {
    const actions = document.createElement("div");
    actions.className = "topbar-actions";
    container.insertBefore(actions, viewerLink);
    actions.appendChild(viewerLink);
    actions.appendChild(btn);
  } else {
    // Viewer link not present (e.g. in tests or stripped HTML) — just append.
    container.appendChild(btn);
  }

  return btn;
}
