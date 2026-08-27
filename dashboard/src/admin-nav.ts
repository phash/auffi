// gh #53 — Admin-Nav-Gate.
//
// Zwei kleine Pure-Helper, die main.ts orchestriert:
//   - `visibleRoutes`: filtert Admin-Only-Routes raus wenn der User
//     kein Admin ist. Backend gated ohnehin mit requireAdmin, das hier
//     ist reines UX (Link gar nicht erst zeigen).
//   - `updateActiveNav`: setzt `.active` + `aria-current="page"` auf
//     den Nav-Link, dessen `href` der aktuellen URL entspricht.
//
// Backend-Enforcement (`requireAdmin` in den Routes) bleibt die echte
// Sicherheitsgrenze — diese Helpers verhindern nur, dass ein
// non-Admin nutzlose UI sieht.

import type { Route } from "./router.js";

/**
 * Filter the route table down to nav-eligible routes for the given
 * admin state. Routes without `navLabel` (auth pages, deep-links)
 * never show in the nav regardless. Routes flagged `adminOnly` only
 * show when `isAdmin` is true.
 */
export function visibleRoutes(routes: Route[], isAdmin: boolean): Route[] {
  return routes.filter((r) => {
    if (!r.navLabel) return false;
    if (r.adminOnly && !isAdmin) return false;
    return true;
  });
}

/**
 * Update the `aria-current` + `.active` markers on the nav anchors to
 * reflect the current URL path. Idempotent; safe to call on every
 * route change. `currentPath` is expected to be the full pathname
 * incl. BASE_PATH (e.g. `/dashboard/devices`).
 */
export function updateActiveNav(nav: HTMLElement, currentPath: string): void {
  for (const link of Array.from(nav.querySelectorAll("a"))) {
    const href = link.getAttribute("href");
    if (href === currentPath) {
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
    } else {
      link.classList.remove("active");
      link.removeAttribute("aria-current");
    }
  }
}
