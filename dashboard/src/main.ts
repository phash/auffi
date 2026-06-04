// Dashboard entry point. Builds the route table, mounts the router,
// and renders the top-bar nav. gh #53: admin nav-gate — probe
// /api/me once at bootstrap to decide whether to render admin nav
// links, then thread an `isAdmin()` closure into the router so direct-
// URL access to `/admin/*` substitutes the 403 view for non-admins.

import { getMe } from "./api.js";
import {
  isAdminGatedPath,
  updateActiveNav,
  visibleRoutes,
} from "./admin-nav.js";
import { BASE_PATH, createRouter, pathUnderBase, type Route } from "./router.js";
import { installFeedbackFab } from "./components/feedback-fab.js";
import { mountLogoutButton } from "./logout-button.js";
import { renderAccount } from "./views/account.js";
import { renderAddDevice } from "./views/add-device.js";
import { renderAdmin403 } from "./views/admin-403.js";
import { renderAdminFeedback } from "./views/admin-feedback.js";
import { renderAdminOverview } from "./views/admin-overview.js";
import { renderAdminStats } from "./views/admin-stats.js";
import { renderAdminUserDetail } from "./views/admin-user-detail.js";
import { renderAdminUsers } from "./views/admin-users.js";
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
  // gh #53/#54: Admin-only routes — `adminOnly: true` triggers the
  // router's 403 substitution when isAdmin()===false AND hides the
  // link from the nav. Backend's requireAdmin remains the real gate.
  //
  // Single "Admin" top-nav entry → /admin landing page. From there
  // the user navigates to /admin/users, /admin/stats, /admin/feedback
  // via inline quick-nav. Keeps the top-bar tidy (1 admin link instead
  // of 4).
  {
    pattern: "/admin",
    navLabel: "Admin",
    adminOnly: true,
    render: renderAdminOverview,
  },
  {
    pattern: "/admin/users",
    adminOnly: true,
    render: renderAdminUsers,
  },
  {
    pattern: "/admin/users/:id",
    adminOnly: true,
    render: renderAdminUserDetail,
  },
  {
    pattern: "/admin/feedback",
    adminOnly: true,
    render: renderAdminFeedback,
  },
  {
    pattern: "/admin/stats",
    adminOnly: true,
    render: renderAdminStats,
  },
  { pattern: "*", render: renderNotFound },
];

function buildNav(routes: Route[], isAdmin: boolean): HTMLElement {
  const nav = document.getElementById("dashboard-nav");
  if (!nav) throw new Error("missing #dashboard-nav anchor in index.html");
  while (nav.firstChild) nav.removeChild(nav.firstChild);
  for (const route of visibleRoutes(routes, isAdmin)) {
    const a = document.createElement("a");
    a.href = BASE_PATH + (route.pattern === "/" ? "/" : route.pattern);
    a.textContent = route.navLabel ?? "";
    nav.appendChild(a);
  }
  return nav;
}

const root = document.getElementById("dashboard-root");
if (!root) {
  throw new Error("missing #dashboard-root anchor in index.html");
}

async function bootstrap(rootEl: HTMLElement): Promise<void> {
  // Probe /api/me once. Anonymous (401) and network errors both
  // collapse into isAdmin=false — UX-safe default.
  const me = await getMe();
  const isAdminFlag = me.ok && me.data.admin === true;

  // If a not-logged-in user lands directly on an admin URL, the router
  // would otherwise hit the route's render() which usually starts with
  // an authenticated fetch — preflight that case here for a friendlier
  // path (they see the same 403-style nudge a non-admin sees, instead
  // of a fetch-401-redirect-loop). The renderAdmin403 view is also
  // the substituted view for logged-in non-admins via the router.
  const here = pathUnderBase(window.location.pathname);
  const anonymousOnAdmin = !me.ok && me.status === 401 && isAdminGatedPath(here);

  const nav = buildNav(routes, isAdminFlag);

  // Mount "Abmelden" in the topbar-meta row (right side, next to the viewer
  // link) — visible on every authed page so shared-computer users can always
  // end their session.
  const topbarMeta = document.querySelector<HTMLElement>(".topbar-meta");
  if (topbarMeta) mountLogoutButton(topbarMeta);

  createRouter(rootEl, routes, undefined, undefined, {
    isAdmin: () => isAdminFlag,
    renderAdminForbidden: renderAdmin403,
  }).start();

  // Active-route highlighting — listen for the custom event the
  // router dispatches after every render. Initial call covers the
  // first render that happened inside start().
  window.addEventListener("dashboard:rendered", () => {
    updateActiveNav(nav, window.location.pathname);
  });
  updateActiveNav(nav, window.location.pathname);

  // Silent fallback for anonymous users hitting an admin URL —
  // renderAdmin403 is the right end-state. The router would have
  // routed normally (anonymous isn't adminOnly-blocked in itself);
  // overwrite with the 403 view so the user doesn't see a 401 toast.
  if (anonymousOnAdmin) {
    renderAdmin403(rootEl, {
      path: here,
      segments: here === "/" ? [] : here.slice(1).split("/"),
      params: {},
      query: new URLSearchParams(window.location.search),
    });
  }
}

void bootstrap(root);

// Feedback FAB is independent of the route; install once. Errors are
// swallowed (the FAB is a nice-to-have, must not block the dashboard
// rendering on a backend hiccup).
void installFeedbackFab().catch(() => {});
