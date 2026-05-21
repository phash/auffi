// Dashboard entry point. Builds the route table, mounts the router,
// and renders the top-bar nav.

import { BASE_PATH, createRouter, type Route } from "./router.js";
import { installFeedbackFab } from "./components/feedback-fab.js";
import { renderAccount } from "./views/account.js";
import { renderAddDevice } from "./views/add-device.js";
import { renderAdminFeedback } from "./views/admin-feedback.js";
import { renderAdminStats } from "./views/admin-stats.js";
import { renderConnectionLog } from "./views/connection-log.js";
import { renderDeviceDetail } from "./views/device-detail.js";
import { renderDevices } from "./views/devices.js";
import { renderForgot } from "./views/forgot.js";
import { renderLogin } from "./views/login.js";
import { renderNotFound } from "./views/not-found.js";
import { renderReset } from "./views/reset.js";
import { renderSignup } from "./views/signup.js";
import { renderVerify } from "./views/verify.js";

const routes: Route[] = [
  // Default post-login destination (spec §8.3).
  { pattern: "/", navLabel: "Übersicht", render: renderDevices },
  // gh #29: auth pages
  { pattern: "/login", render: renderLogin },
  { pattern: "/signup", render: renderSignup },
  { pattern: "/verify/:token", render: renderVerify },
  // gh #30: password-reset flow
  { pattern: "/forgot", render: renderForgot },
  { pattern: "/reset/:token", render: renderReset },
  // gh #31: device list (default after login)
  { pattern: "/devices", navLabel: "Geräte", render: renderDevices },
  // gh #32: add-device modal route. Mounted as its own URL so the
  // user can deep-link / share-via-link the pairing instructions.
  { pattern: "/devices/new", render: renderAddDevice },
  // gh #33: device detail with alias-edit + auto-accept toggle.
  { pattern: "/devices/:id", render: renderDeviceDetail },
  // gh #34: paginated connection-log view per device.
  { pattern: "/devices/:id/log", render: renderConnectionLog },
  // gh #35: account settings.
  { pattern: "/account", navLabel: "Account", render: renderAccount },
  // gh #39: admin-only feedback inbox. Backend gates with requireAdmin
  // so a non-admin opening this URL gets a 403-rendered message
  // inline; the link is therefore safe to add to the nav for ALL
  // users (admin-only filtering happens server-side).
  { pattern: "/admin/feedback", navLabel: "Feedback (Admin)", render: renderAdminFeedback },
  // gh stats: admin-only operational overview — user counts, device
  // counts, connection counts, code-mint counts. Same admin-route
  // pattern: backend guards with requireAdmin, the view shows an
  // inline notice on 403 so the link is safe for ALL users in the nav.
  { pattern: "/admin/stats", navLabel: "Stats (Admin)", render: renderAdminStats },
  { pattern: "*", render: renderNotFound },
];

function buildNav(routes: Route[]): HTMLElement {
  const nav = document.getElementById("dashboard-nav");
  if (!nav) throw new Error("missing #dashboard-nav anchor in index.html");
  while (nav.firstChild) nav.removeChild(nav.firstChild);
  for (const route of routes) {
    if (!route.navLabel) continue;
    const a = document.createElement("a");
    a.href = BASE_PATH + (route.pattern === "/" ? "/" : route.pattern);
    a.textContent = route.navLabel;
    nav.appendChild(a);
  }
  return nav;
}

const root = document.getElementById("dashboard-root");
if (!root) {
  throw new Error("missing #dashboard-root anchor in index.html");
}

buildNav(routes);
createRouter(root, routes).start();

// Feedback FAB is independent of the route; install once. Errors are
// swallowed (the FAB is a nice-to-have, must not block the dashboard
// rendering on a backend hiccup).
void installFeedbackFab().catch(() => {});
