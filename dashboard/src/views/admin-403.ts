// gh #53 — "Du bist kein Admin"-Seite.
//
// Wird vom Router substituiert, wenn eine `adminOnly: true`-Route
// ohne aktive Admin-Session aufgerufen wird (direkt-navigiert via URL,
// nicht via Nav-Link — die admin-Nav-Links werden für non-Admins
// erst gar nicht aufgebaut). Backend bleibt die echte Grenze:
// jedes /api/admin/*-Endpoint hat `requireAdmin` als preHandler.

import { BASE_PATH, type RouteContext, type RouteRenderer } from "../router.js";

export const renderAdmin403: RouteRenderer = (
  root: HTMLElement,
  _ctx: RouteContext,
) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Kein Admin-Zugang";
  card.appendChild(h1);

  const p = document.createElement("p");
  p.textContent =
    "Diese Seite ist nur für Admins. Wenn du denkst, das ist ein Fehler, melde dich beim Betreiber.";
  card.appendChild(p);

  const back = document.createElement("a");
  back.className = "btn primary";
  back.href = `${BASE_PATH}/`;
  back.textContent = "Zur Übersicht";
  card.appendChild(back);

  root.appendChild(card);
};
