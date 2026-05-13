// Dashboard entry point. Builds the route table, mounts the router,
// and renders the top-bar nav.

import { BASE_PATH, createRouter, type Route } from "./router.js";
import { renderDevices } from "./views/devices.js";
import { renderForgot } from "./views/forgot.js";
import { renderHome } from "./views/home.js";
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
  // Placeholders for gh #32-#35 until those views land:
  { pattern: "/devices/:id", render: renderHome },
  { pattern: "/account", navLabel: "Account", render: renderHome },
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
