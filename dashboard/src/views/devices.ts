// /dashboard/devices — default post-login view (spec §8.3).
//
// GETs /api/devices and renders one card per registered device.
// Empty state nudges the user toward the (not-yet-built) add-device
// modal (gh #32). A 401 redirects the user to /login so the typical
// "I opened the dashboard tab from yesterday and the cookie expired"
// case lands them on the right page.

import { listDevices, type Device } from "../api.js";
import { formatRelative } from "../format.js";
import { BASE_PATH, navigate, type RouteContext, type RouteRenderer } from "../router.js";

export const renderDevices: RouteRenderer = (root: HTMLElement, _ctx: RouteContext) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";
  const h1 = document.createElement("h1");
  h1.textContent = "Geräte";
  card.appendChild(h1);

  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Lade Geräte …";
  card.appendChild(status);

  root.appendChild(card);

  let unmounted = false;

  void (async (): Promise<void> => {
    const res = await listDevices();
    if (unmounted) return;
    if (!res.ok) {
      if (res.status === 401) {
        // Cookie expired or never logged in — bounce to /login
        // without a full reload.
        navigate("/login");
        return;
      }
      status.className = "error";
      status.textContent = `Geräte konnten nicht geladen werden: ${res.message}`;
      return;
    }
    renderList(root, res.data.items);
  })();

  // Router-invoked cleanup. The router's per-render container already
  // isolates late DOM writes, but the 401 branch's navigate("/login") is a
  // global history mutation: landing after the user moved on (and maybe
  // logged in again) would yank them back to the login form.
  return () => {
    unmounted = true;
  };
};

function renderList(root: HTMLElement, items: Device[]): void {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";

  const headerRow = document.createElement("div");
  headerRow.style.display = "flex";
  headerRow.style.alignItems = "center";
  headerRow.style.justifyContent = "space-between";
  headerRow.style.marginBottom = "0.75rem";

  const h1 = document.createElement("h1");
  h1.textContent = "Geräte";
  h1.style.margin = "0";
  headerRow.appendChild(h1);

  const addLink = document.createElement("a");
  addLink.href = BASE_PATH + "/devices/new";
  // Use the shared pill-button class instead of re-inlining the design
  // system (radius/colour/padding all come from .btn.primary).
  addLink.className = "btn primary";
  addLink.textContent = "+ Neues Gerät";
  headerRow.appendChild(addLink);

  card.appendChild(headerRow);

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.style.color = "var(--text-secondary)";
    empty.style.fontSize = "0.9375rem";
    empty.style.padding = "1.5rem 0";
    empty.style.textAlign = "center";
    empty.textContent = "Noch keine Geräte gepairt.";
    card.appendChild(empty);
    root.appendChild(card);
    return;
  }

  const list = document.createElement("ul");
  list.style.listStyle = "none";
  list.style.padding = "0";
  list.style.margin = "0";

  for (const dev of items) {
    list.appendChild(renderDeviceItem(dev));
  }

  card.appendChild(list);
  root.appendChild(card);
}

function renderDeviceItem(dev: Device): HTMLLIElement {
  const item = document.createElement("li");
  item.style.display = "flex";
  item.style.alignItems = "center";
  item.style.justifyContent = "space-between";
  item.style.padding = "0.75rem 0";
  item.style.borderTop = "1px solid var(--border)";

  const left = document.createElement("div");
  const alias = document.createElement("a");
  alias.href = BASE_PATH + "/devices/" + encodeURIComponent(dev.id);
  alias.style.fontWeight = "600";
  alias.style.color = "var(--text)";
  alias.style.textDecoration = "none";
  alias.style.fontSize = "1rem";
  alias.textContent = dev.alias;
  left.appendChild(alias);

  const sub = document.createElement("div");
  sub.style.fontSize = "0.8125rem";
  sub.style.color = "var(--text-secondary)";
  sub.style.fontFamily = "monospace";
  sub.style.marginTop = "0.125rem";
  sub.textContent = dev.id;
  left.appendChild(sub);

  item.appendChild(left);

  const right = document.createElement("div");
  right.style.textAlign = "right";
  right.style.fontSize = "0.8125rem";

  const onlineDot = document.createElement("span");
  onlineDot.style.display = "inline-block";
  onlineDot.style.width = "0.5rem";
  onlineDot.style.height = "0.5rem";
  onlineDot.style.borderRadius = "50%";
  onlineDot.style.marginRight = "0.375rem";
  onlineDot.style.background = dev.online ? "var(--success)" : "var(--text-secondary)";
  onlineDot.setAttribute("aria-hidden", "true");

  const onlineText = document.createElement("span");
  onlineText.textContent = dev.online ? "Online" : "Offline";
  onlineText.style.color = dev.online ? "var(--success)" : "var(--text-secondary)";

  right.appendChild(onlineDot);
  right.appendChild(onlineText);

  const lastSeen = document.createElement("div");
  lastSeen.style.color = "var(--text-secondary)";
  lastSeen.style.marginTop = "0.125rem";
  lastSeen.textContent = dev.lastSeenAt === null
    ? "Noch nie verbunden"
    : `Zuletzt: ${formatRelative(dev.lastSeenAt)}`;
  right.appendChild(lastSeen);

  item.appendChild(right);
  return item;
}
