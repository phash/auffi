// Placeholder home view shown at /dashboard/. The real flow lands
// here when the user is logged in (device list, gh #31); when not
// logged in we redirect to /dashboard/login (gh #29).

import type { RouteContext, RouteRenderer } from "../router.js";

export const renderHome: RouteRenderer = (root: HTMLElement, _ctx: RouteContext) => {
  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Auffi Dashboard";
  card.appendChild(h1);

  const p = document.createElement("p");
  p.textContent =
    "Hier verwaltest du deine Geräte und Verbindungen. Login, Pairing-Codes, Connection-Log und Account-Einstellungen folgen in den nächsten Iterationen (gh #29-#35).";
  card.appendChild(p);

  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(card);
};
