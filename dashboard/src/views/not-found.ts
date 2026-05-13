import type { RouteContext, RouteRenderer } from "../router.js";

export const renderNotFound: RouteRenderer = (root: HTMLElement, ctx: RouteContext) => {
  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Seite nicht gefunden";
  card.appendChild(h1);

  const p = document.createElement("p");
  p.textContent = `Die Seite ${ctx.path} existiert (noch) nicht.`;
  card.appendChild(p);

  const link = document.createElement("a");
  link.href = "/dashboard/";
  link.textContent = "← Zur Startseite";
  card.appendChild(link);

  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(card);
};
