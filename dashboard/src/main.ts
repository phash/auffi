// Dashboard entry point. Builds the route table, mounts the router,
// and renders the top-bar nav.

import { BASE_PATH, createRouter, type Route } from "./router.js";
import { renderHome } from "./views/home.js";
import { renderNotFound } from "./views/not-found.js";

const routes: Route[] = [
  { pattern: "/", navLabel: "Übersicht", render: renderHome },
  // Placeholder targets for the upcoming gh #29-#35 views — wired
  // into the router so the nav links don't 404 during dev:
  { pattern: "/login", render: renderHome },
  { pattern: "/signup", render: renderHome },
  { pattern: "/verify/:token", render: renderHome },
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
