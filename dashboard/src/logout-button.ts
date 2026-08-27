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
 * `.topbar-meta`). Prefers the dedicated `.topbar-actions` right-zone from
 * index.html so the button sits flush-right in the topbar's 3-zone grid;
 * falls back to appending directly when that zone is absent (tests / stripped
 * markup).
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

  const actions = container.querySelector<HTMLElement>(".topbar-actions");
  if (actions !== null) actions.appendChild(btn);
  else container.appendChild(btn);

  return btn;
}
