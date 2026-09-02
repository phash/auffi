// /dashboard/devices/:id/log — paginated connection-log view
// (spec §8.4, gh #34).
//
// GET /api/devices/:id/log?cursor=... returns
// { items, nextCursor, maxLimit }. nextCursor === null means the
// last page; while it's a number we render a "Mehr laden" button
// that fetches the next chunk and appends the rows.

import {
  listConnectionLog,
  type ConnectionLogRow,
} from "../api.js";
import { formatAbsolute, formatBytes, formatDuration } from "../format.js";
import { BASE_PATH, navigate, type RouteContext, type RouteRenderer } from "../router.js";

export const renderConnectionLog: RouteRenderer = (root: HTMLElement, ctx: RouteContext) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const deviceId = ctx.params.id ?? "";

  const card = document.createElement("section");
  card.className = "card";

  const back = document.createElement("p");
  back.style.marginBottom = "0.75rem";
  const backLink = document.createElement("a");
  backLink.href = BASE_PATH + "/devices/" + encodeURIComponent(deviceId);
  backLink.textContent = "← Zurück zum Gerät";
  backLink.style.fontSize = "0.875rem";
  back.appendChild(backLink);
  card.appendChild(back);

  const h1 = document.createElement("h1");
  h1.textContent = "Verbindungs-Protokoll";
  card.appendChild(h1);

  const subtitle = document.createElement("p");
  subtitle.style.fontSize = "0.875rem";
  subtitle.style.color = "var(--text-secondary)";
  subtitle.style.marginBottom = "0.75rem";
  subtitle.textContent = "Letzte Verbindungen für " + deviceId;
  card.appendChild(subtitle);

  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Lade …";
  card.appendChild(status);

  const list = document.createElement("ul");
  list.style.listStyle = "none";
  list.style.padding = "0";
  list.style.margin = "0";
  card.appendChild(list);

  const more = document.createElement("button");
  more.type = "button";
  more.className = "primary";
  more.style.marginTop = "1rem";
  more.style.display = "none";
  more.textContent = "Mehr laden";
  card.appendChild(more);

  root.appendChild(card);

  if (deviceId.length === 0) {
    status.className = "error";
    status.textContent = "Geräte-ID fehlt.";
    return;
  }

  let cursor: number | undefined = undefined;
  let unmounted = false;

  const loadNext = async (): Promise<void> => {
    more.disabled = true;
    const wasEmpty = cursor === undefined;
    if (wasEmpty) {
      status.textContent = "Lade …";
      status.className = "loading";
    } else {
      more.textContent = "Lade …";
    }
    const res = await listConnectionLog(deviceId, cursor);
    if (unmounted) return;
    if (!res.ok) {
      if (res.status === 401) {
        navigate("/login");
        return;
      }
      status.className = "error";
      // The status line is display:none after the first successful page
      // — bring it back so the error is actually visible.
      status.style.display = "block";
      status.textContent = `Protokoll konnte nicht geladen werden: ${res.message}`;
      if (wasEmpty) {
        more.style.display = "none";
      } else {
        // Mid-Pagination: Button als Retry-Pfad stehen lassen.
        more.disabled = false;
        more.textContent = "Mehr laden";
      }
      return;
    }
    if (wasEmpty && res.data.items.length === 0) {
      status.className = "";
      status.style.color = "var(--text-secondary)";
      status.style.fontSize = "0.9375rem";
      status.style.padding = "1rem 0";
      status.style.textAlign = "center";
      status.textContent = "Noch keine Verbindungen aufgezeichnet.";
      more.style.display = "none";
      return;
    }
    // Hide the status line once we have something to show — this also
    // clears a previous load-more error after a successful retry.
    status.style.display = "none";
    for (const row of res.data.items) {
      list.appendChild(renderRow(row));
    }
    if (res.data.nextCursor === null) {
      more.style.display = "none";
      return;
    }
    cursor = res.data.nextCursor;
    more.style.display = "block";
    more.disabled = false;
    more.textContent = "Mehr laden";
  };

  more.addEventListener("click", () => void loadNext());
  void loadNext();

  return () => {
    unmounted = true;
  };
};

function renderRow(row: ConnectionLogRow): HTMLLIElement {
  const item = document.createElement("li");
  item.style.padding = "0.75rem 0";
  item.style.borderTop = "1px solid var(--border)";
  item.style.display = "grid";
  item.style.gridTemplateColumns = "1fr auto";
  item.style.alignItems = "start";
  item.style.gap = "0.5rem";

  const left = document.createElement("div");

  const startLine = document.createElement("div");
  startLine.style.fontWeight = "600";
  startLine.style.fontSize = "0.9375rem";
  startLine.textContent = formatAbsolute(row.startedAt);
  left.appendChild(startLine);

  const meta = document.createElement("div");
  meta.style.fontSize = "0.8125rem";
  meta.style.color = "var(--text-secondary)";
  meta.style.marginTop = "0.125rem";
  meta.textContent =
    `${formatDuration(row.startedAt, row.endedAt)} · ` +
    `${row.connectionType === "p2p" ? "P2P" : "Relay"} · ` +
    `Helfer: ${row.viewerIpPrefix}`;
  left.appendChild(meta);

  item.appendChild(left);

  const right = document.createElement("div");
  right.style.textAlign = "right";
  right.style.fontSize = "0.8125rem";
  right.style.color = "var(--text-secondary)";
  right.textContent = formatBytes(row.bytesRelayed);
  item.appendChild(right);

  return item;
}
