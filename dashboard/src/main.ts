// Dashboard entry point. Builds the route table, mounts the router,
// and renders the top-bar nav.

import { BASE_PATH, createRouter, type Route } from "./router.js";
import { renderHome } from "./views/home.js";
import { renderLogin } from "./views/login.js";
import { renderNotFound } from "./views/not-found.js";
import { renderSignup } from "./views/signup.js";
import { renderVerify } from "./views/verify.js";

const routes: Route[] = [
  { pattern: "/", navLabel: "Übersicht", render: renderHome },
  // gh #29: auth pages
  { pattern: "/login", render: renderLogin },
  { pattern: "/signup", render: renderSignup },
  { pattern: "/verify/:token", render: renderVerify },
  // Placeholders for gh #30, #31-#35 — wired so the nav doesn't 404:
  { pattern: "/forgot", render: renderHome },
  { pattern: "/reset/:token", render: renderHome },
  { pattern: "/devices", navLabel: "Geräte", render: renderHome },
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
