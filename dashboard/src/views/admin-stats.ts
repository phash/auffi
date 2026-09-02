// /dashboard/admin/stats — admin-only operational overview.
//
// Aggregiert /api/admin/stats (Users, Devices, Connections, System) und
// /api/admin/stats/codes (Code-Mints — DB-Tracking, parallel zu Matomo).
// Non-Admin-Aufruf landet auf einem 403 vom Backend; der UI zeigt das
// dann inline genauso wie der admin-feedback-View.

import {
  fetchAdminCodeStats,
  fetchAdminStats,
  type AdminCodeStats,
  type AdminStats,
} from "../api.js";
import { formatBytes, formatUptime } from "../format.js";
import { navigate, type RouteContext, type RouteRenderer } from "../router.js";

export const renderAdminStats: RouteRenderer = (
  root: HTMLElement,
  _ctx: RouteContext,
) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Stats (Admin)";
  card.appendChild(h1);

  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Lade Statistiken …";
  card.appendChild(status);

  root.appendChild(card);

  let unmounted = false;

  void (async (): Promise<void> => {
    const [statsRes, codesRes] = await Promise.all([
      fetchAdminStats(),
      fetchAdminCodeStats(),
    ]);
    if (unmounted) return;

    // Auth-first: 401 → Login. Beim 401 sind wir auf dem zweiten Aufruf
    // wahrscheinlich noch nicht weitergeroutet; die zweite Antwort
    // wird ignoriert weil navigate() den Routenwechsel triggert.
    if (
      (!statsRes.ok && statsRes.status === 401) ||
      (!codesRes.ok && codesRes.status === 401)
    ) {
      navigate("/login");
      return;
    }

    if (!statsRes.ok || !codesRes.ok) {
      const which = !statsRes.ok ? statsRes : codesRes;
      // .ok ist hier garantiert false weil der Außen-If das prüft —
      // TS narrowt das aber nicht über die `||`-Verzweigung, also
      // cast über den Discriminant.
      const err = which as Extract<typeof which, { ok: false }>;
      status.className = "error";
      status.textContent =
        err.status === 403
          ? "Du musst Admin sein, um die Statistiken zu sehen."
          : `Fehler: ${err.message}`;
      return;
    }

    renderSections(root, statsRes.data, codesRes.data);
  })();

  return () => {
    unmounted = true;
  };
};

function renderSections(
  root: HTMLElement,
  stats: AdminStats,
  codes: AdminCodeStats,
): void {
  while (root.firstChild) root.removeChild(root.firstChild);

  const header = document.createElement("section");
  header.className = "card";
  const h1 = document.createElement("h1");
  h1.textContent = "Stats (Admin)";
  h1.style.margin = "0";
  header.appendChild(h1);
  root.appendChild(header);

  appendDlSection(root, "Code-Mints (DB)", [
    ["Gesamt", String(codes.total)],
    ["Letzte 24 h", String(codes.last24h)],
    ["Letzte 7 Tage", String(codes.last7d)],
    ["Letzte 30 Tage", String(codes.last30d)],
  ]);

  appendPerDaySection(root, codes.perDay);

  appendDlSection(root, "Nutzer", [
    ["Gesamt", String(stats.users.total)],
    ["Verifiziert", String(stats.users.verified)],
    ["Suspendiert", String(stats.users.suspended)],
    ["Aktiv 24 h / 7 d / 30 d", `${stats.users.active_24h} / ${stats.users.active_7d} / ${stats.users.active_30d}`],
    ["Neu 24 h / 7 d", `${stats.users.new_24h} / ${stats.users.new_7d}`],
  ]);

  appendDlSection(root, "Geräte (Unattended)", [
    ["Gesamt gepairt", String(stats.devices.total)],
    ["Online jetzt", String(stats.devices.online_now)],
    ["Gepairt 24 h", String(stats.devices.paired_24h)],
  ]);

  appendDlSection(root, "Verbindungen", [
    ["Heute", String(stats.connections.today)],
    ["Diese Woche", String(stats.connections.week)],
    ["Heute P2P", String(stats.connections.p2p_today)],
    ["Heute Relay", String(stats.connections.relay_today)],
    ["Heute Relay-Bytes", formatBytes(stats.connections.relay_bytes_today)],
  ]);

  appendDlSection(root, "System", [
    ["DB-Größe", formatBytes(stats.system.db_size_bytes)],
    ["Uptime", formatUptime(stats.system.uptime_seconds)],
  ]);
}

function appendDlSection(
  root: HTMLElement,
  title: string,
  rows: Array<[string, string]>,
): void {
  const card = document.createElement("section");
  card.className = "card";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  card.appendChild(h2);

  const dl = document.createElement("dl");
  dl.className = "stat-grid";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  card.appendChild(dl);
  root.appendChild(card);
}

function appendPerDaySection(
  root: HTMLElement,
  perDay: AdminCodeStats["perDay"],
): void {
  const card = document.createElement("section");
  card.className = "card";
  const h2 = document.createElement("h2");
  h2.textContent = "Code-Mints pro Tag (letzte 30 Tage)";
  card.appendChild(h2);

  if (perDay.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Noch keine Code-Mints im 30-Tage-Fenster.";
    card.appendChild(p);
    root.appendChild(card);
    return;
  }

  const max = perDay.reduce((m, r) => (r.count > m ? r.count : m), 0);
  const list = document.createElement("ul");
  list.className = "perday-list";
  for (const row of perDay) {
    const li = document.createElement("li");
    li.className = "perday-row";

    const label = document.createElement("span");
    label.className = "perday-day";
    label.textContent = row.day;

    const bar = document.createElement("span");
    bar.className = "perday-bar";
    // Inline-Width statt CSS-Class — der prozentuale Wert ist
    // datenabhängig und gehört nicht in den Stylesheet.
    const pct = max > 0 ? (row.count / max) * 100 : 0;
    bar.style.width = `${pct}%`;

    const count = document.createElement("span");
    count.className = "perday-count";
    count.textContent = String(row.count);

    li.appendChild(label);
    li.appendChild(bar);
    li.appendChild(count);
    list.appendChild(li);
  }
  card.appendChild(list);
  root.appendChild(card);
}
