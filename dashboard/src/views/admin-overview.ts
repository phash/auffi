// gh #54 — Admin-Overview unter `/admin`.
//
// Verdichtete KPI-Kacheln aus /api/admin/stats + /api/admin/stats/codes.
// Bewusst KEINE Detail-Charts hier — die wohnen unter `/admin/stats`
// (renderAdminStats). Diese Page ist die Landing-Page nach dem Klick
// auf den "Admin"-Link und führt von dort weiter zu /admin/users,
// /admin/feedback, /admin/stats.

import {
  fetchAdminCodeStats,
  fetchAdminStats,
  type AdminCodeStats,
  type AdminStats,
} from "../api.js";
import { BASE_PATH, navigate, type RouteContext, type RouteRenderer } from "../router.js";

export const renderAdminOverview: RouteRenderer = (
  root: HTMLElement,
  _ctx: RouteContext,
) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";
  const h1 = document.createElement("h1");
  h1.textContent = "Admin-Übersicht";
  card.appendChild(h1);
  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Lade KPIs …";
  card.appendChild(status);
  root.appendChild(card);

  void (async (): Promise<void> => {
    const [statsRes, codesRes] = await Promise.all([
      fetchAdminStats(),
      fetchAdminCodeStats(),
    ]);

    if (
      (!statsRes.ok && statsRes.status === 401) ||
      (!codesRes.ok && codesRes.status === 401)
    ) {
      navigate("/login");
      return;
    }

    if (!statsRes.ok || !codesRes.ok) {
      const err = (!statsRes.ok ? statsRes : codesRes) as Extract<
        typeof statsRes | typeof codesRes,
        { ok: false }
      >;
      status.className = "error";
      status.textContent =
        err.status === 403
          ? "Du musst Admin sein, um diese Seite zu sehen."
          : `Fehler: ${err.message}`;
      return;
    }

    renderKpis(root, statsRes.data, codesRes.data);
  })();
};

function renderKpis(
  root: HTMLElement,
  stats: AdminStats,
  codes: AdminCodeStats,
): void {
  while (root.firstChild) root.removeChild(root.firstChild);

  const header = document.createElement("section");
  header.className = "card";
  const h1 = document.createElement("h1");
  h1.textContent = "Admin-Übersicht";
  h1.style.margin = "0 0 0.25rem 0";
  header.appendChild(h1);
  const sub = document.createElement("p");
  sub.className = "muted";
  sub.style.margin = "0";
  sub.textContent = "Wichtigste Zahlen auf einen Blick. Tiefere Aufschlüsselungen unter den jeweiligen Sektionen.";
  header.appendChild(sub);
  root.appendChild(header);

  const tiles = document.createElement("section");
  tiles.className = "kpi-grid";

  // Tile-Daten zentral als Daten-Tabelle, dann gerendert — vermeidet
  // 7× wiederholtes element-build-Boilerplate.
  const tileSpecs: Array<{
    label: string;
    value: string;
    sublabel?: string;
    href?: string;
  }> = [
    {
      label: "Code-Mints (24 h)",
      value: codes.last24h.toLocaleString("de-DE"),
      sublabel: `${codes.last7d.toLocaleString("de-DE")} / ${codes.last30d.toLocaleString("de-DE")} / ${codes.total.toLocaleString("de-DE")} (7d / 30d / total)`,
      href: "/admin/stats",
    },
    {
      label: "Nutzer (gesamt)",
      value: stats.users.total.toLocaleString("de-DE"),
      sublabel: `${stats.users.active_24h.toLocaleString("de-DE")} / ${stats.users.active_7d.toLocaleString("de-DE")} / ${stats.users.active_30d.toLocaleString("de-DE")} aktiv (24 h / 7d / 30d)`,
      href: "/admin/users",
    },
    {
      label: "Verifiziert",
      value: stats.users.verified.toLocaleString("de-DE"),
      sublabel: `${stats.users.suspended} suspendiert`,
    },
    {
      label: "Neue Nutzer (24 h)",
      value: stats.users.new_24h.toLocaleString("de-DE"),
      sublabel: `${stats.users.new_7d.toLocaleString("de-DE")} in den letzten 7 Tagen`,
    },
    {
      label: "Geräte online",
      value: stats.devices.online_now.toLocaleString("de-DE"),
      sublabel: `${stats.devices.total.toLocaleString("de-DE")} gepairt, ${stats.devices.paired_24h} neue 24 h`,
    },
    {
      label: "Verbindungen heute",
      value: stats.connections.today.toLocaleString("de-DE"),
      sublabel: `${stats.connections.p2p_today} P2P + ${stats.connections.relay_today} Relay · ${formatBytes(stats.connections.relay_bytes_today)} relayed`,
    },
  ];

  for (const spec of tileSpecs) {
    const tile = document.createElement(spec.href ? "a" : "div");
    tile.className = "kpi-tile";
    if (spec.href && tile instanceof HTMLAnchorElement) {
      tile.href = BASE_PATH + spec.href;
    }

    const labelEl = document.createElement("div");
    labelEl.className = "kpi-label";
    labelEl.textContent = spec.label;
    tile.appendChild(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "kpi-value";
    valueEl.textContent = spec.value;
    tile.appendChild(valueEl);

    if (spec.sublabel) {
      const sub = document.createElement("div");
      sub.className = "kpi-sublabel";
      sub.textContent = spec.sublabel;
      tile.appendChild(sub);
    }

    tiles.appendChild(tile);
  }

  root.appendChild(tiles);

  // Quick-links — kleine Navigation zu den anderen Admin-Subpages,
  // damit der User nach der Overview-Page Click-Weiter-Möglichkeiten
  // hat (Nav oben hat die gleichen, aber redundant ist hier OK).
  const quick = document.createElement("section");
  quick.className = "card";
  const qh = document.createElement("h2");
  qh.textContent = "Weiter …";
  quick.appendChild(qh);
  const list = document.createElement("ul");
  list.className = "admin-quicknav";
  for (const [href, label] of [
    ["/admin/users", "Nutzer-Liste durchsuchen"],
    ["/admin/stats", "Detaillierte Statistiken (Code-Mints pro Tag)"],
    ["/admin/feedback", "Feedback-Inbox"],
  ] as const) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = BASE_PATH + href;
    a.textContent = label;
    li.appendChild(a);
    list.appendChild(li);
  }
  quick.appendChild(list);
  root.appendChild(quick);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
