// /dashboard/devices/:id — single-device detail page.
//
// Surface (spec §8.4):
//   • Alias edit (PATCH /api/devices/:id {alias})
//   • Auto-accept toggle (PATCH /api/devices/:id {auto_accept})
//   • Delete with confirm (DELETE /api/devices/:id; forces the
//     sharer's live WSS to close with 4401 per gh #16).
//
// Backend has no single-device GET endpoint, so we read the list
// and filter — the result is cached in-memory for the lifetime of
// the view. Refreshing fetches fresh state.

import {
  deleteDevice,
  listDevices,
  patchDevice,
  type Device,
} from "../api.js";
import { formatRelative } from "../format.js";
import { BASE_PATH, type RouteContext, type RouteRenderer } from "../router.js";

export const renderDeviceDetail: RouteRenderer = (root: HTMLElement, ctx: RouteContext) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";

  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Lade Gerät …";
  card.appendChild(status);

  root.appendChild(card);

  const id = ctx.params.id ?? "";
  if (id.length === 0) {
    status.className = "error";
    status.textContent = "Geräte-ID fehlt.";
    return;
  }

  void (async (): Promise<void> => {
    const res = await listDevices();
    if (!res.ok) {
      if (res.status === 401) {
        window.history.pushState({}, "", BASE_PATH + "/login");
        window.dispatchEvent(new PopStateEvent("popstate"));
        return;
      }
      status.className = "error";
      status.textContent = `Gerät konnte nicht geladen werden: ${res.message}`;
      return;
    }
    const dev = res.data.items.find((d) => d.id === id);
    if (!dev) {
      status.className = "error";
      status.textContent = "Gerät nicht gefunden.";
      const link = document.createElement("p");
      link.style.marginTop = "0.75rem";
      const back = document.createElement("a");
      back.href = BASE_PATH + "/devices";
      back.textContent = "← Zur Geräte-Liste";
      link.appendChild(back);
      card.appendChild(link);
      return;
    }
    renderEditor(root, dev);
  })();
};

function renderEditor(root: HTMLElement, dev: Device): void {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";

  const back = document.createElement("p");
  back.style.marginBottom = "0.75rem";
  const backLink = document.createElement("a");
  backLink.href = BASE_PATH + "/devices";
  backLink.textContent = "← Zur Geräte-Liste";
  backLink.style.fontSize = "0.875rem";
  back.appendChild(backLink);
  card.appendChild(back);

  const h1 = document.createElement("h1");
  h1.textContent = dev.alias;
  card.appendChild(h1);

  const idLine = document.createElement("p");
  idLine.style.fontFamily = "monospace";
  idLine.style.fontSize = "0.875rem";
  idLine.style.color = "var(--text-secondary)";
  idLine.style.marginBottom = "0.75rem";
  idLine.textContent = dev.id;
  card.appendChild(idLine);

  const statusLine = document.createElement("p");
  statusLine.style.fontSize = "0.875rem";
  statusLine.style.marginBottom = "1rem";
  const dot = document.createElement("span");
  dot.style.display = "inline-block";
  dot.style.width = "0.5rem";
  dot.style.height = "0.5rem";
  dot.style.borderRadius = "50%";
  dot.style.background = dev.online ? "var(--success)" : "var(--text-secondary)";
  dot.style.marginRight = "0.375rem";
  dot.setAttribute("aria-hidden", "true");
  statusLine.appendChild(dot);
  statusLine.appendChild(
    document.createTextNode(
      (dev.online ? "Online" : "Offline") +
        " · Zuletzt: " +
        (dev.lastSeenAt === null ? "—" : formatRelative(dev.lastSeenAt)),
    ),
  );
  card.appendChild(statusLine);

  // ── Alias edit ──────────────────────────────────────────────────
  const aliasForm = document.createElement("form");
  aliasForm.style.marginBottom = "1rem";
  const aliasLabel = document.createElement("label");
  aliasLabel.htmlFor = "dev-alias";
  aliasLabel.textContent = "Geräte-Name";
  const aliasInput = document.createElement("input");
  aliasInput.type = "text";
  aliasInput.id = "dev-alias";
  aliasInput.value = dev.alias;
  aliasInput.maxLength = 80;
  aliasInput.required = true;
  const aliasSubmit = document.createElement("button");
  aliasSubmit.type = "submit";
  aliasSubmit.className = "primary";
  aliasSubmit.textContent = "Name speichern";
  const aliasStatus = document.createElement("p");
  aliasStatus.setAttribute("role", "status");
  aliasStatus.setAttribute("aria-live", "polite");
  aliasStatus.style.fontSize = "0.875rem";
  aliasStatus.style.marginTop = "0.5rem";
  aliasForm.append(aliasLabel, aliasInput, aliasSubmit, aliasStatus);

  aliasForm.addEventListener("submit", async (e: SubmitEvent) => {
    e.preventDefault();
    const next = aliasInput.value.trim();
    if (next.length < 1 || next.length > 80) {
      aliasStatus.style.color = "var(--error)";
      aliasStatus.textContent = "Name muss 1–80 Zeichen haben.";
      return;
    }
    if (next === dev.alias) {
      aliasStatus.style.color = "var(--text-secondary)";
      aliasStatus.textContent = "Keine Änderung.";
      return;
    }
    aliasSubmit.disabled = true;
    const old = aliasSubmit.textContent;
    aliasSubmit.textContent = "Speichere …";
    const res = await patchDevice(dev.id, { alias: next });
    aliasSubmit.disabled = false;
    aliasSubmit.textContent = old;
    if (res.ok) {
      dev.alias = next;
      h1.textContent = next;
      aliasStatus.style.color = "var(--success)";
      aliasStatus.textContent = "Name gespeichert.";
      return;
    }
    aliasStatus.style.color = "var(--error)";
    aliasStatus.textContent = `Fehler: ${res.message}`;
  });
  card.appendChild(aliasForm);

  // ── Auto-accept toggle ──────────────────────────────────────────
  const autoRow = document.createElement("div");
  autoRow.style.display = "flex";
  autoRow.style.alignItems = "flex-start";
  autoRow.style.justifyContent = "space-between";
  autoRow.style.gap = "1rem";
  autoRow.style.padding = "0.75rem 0";
  autoRow.style.borderTop = "1px solid var(--border)";
  autoRow.style.borderBottom = "1px solid var(--border)";

  const autoCol = document.createElement("div");
  const autoLabel = document.createElement("div");
  autoLabel.textContent = "Auto-Akzeptieren";
  autoLabel.style.fontWeight = "600";
  autoCol.appendChild(autoLabel);
  const autoDesc = document.createElement("div");
  autoDesc.style.fontSize = "0.8125rem";
  autoDesc.style.color = "var(--text-secondary)";
  autoDesc.style.marginTop = "0.125rem";
  autoDesc.textContent =
    "Bei eingeschaltetem Toggle verbindet sich der Helfer ohne Bestätigung " +
    "auf dem Gerät, sobald das Passwort stimmt.";
  autoCol.appendChild(autoDesc);
  autoRow.appendChild(autoCol);

  const autoToggle = document.createElement("input");
  autoToggle.type = "checkbox";
  autoToggle.id = "dev-auto-accept";
  autoToggle.checked = dev.autoAccept;
  autoToggle.setAttribute("aria-label", "Auto-Akzeptieren umschalten");
  autoToggle.style.transform = "scale(1.4)";
  autoToggle.style.cursor = "pointer";
  autoRow.appendChild(autoToggle);
  card.appendChild(autoRow);

  const autoStatus = document.createElement("p");
  autoStatus.setAttribute("role", "status");
  autoStatus.setAttribute("aria-live", "polite");
  autoStatus.style.fontSize = "0.8125rem";
  autoStatus.style.marginTop = "0.25rem";
  card.appendChild(autoStatus);

  autoToggle.addEventListener("change", async () => {
    const next = autoToggle.checked;
    autoToggle.disabled = true;
    autoStatus.style.color = "var(--text-secondary)";
    autoStatus.textContent = "Speichere …";
    const res = await patchDevice(dev.id, { auto_accept: next });
    autoToggle.disabled = false;
    if (res.ok) {
      dev.autoAccept = next;
      autoStatus.style.color = "var(--success)";
      autoStatus.textContent = next
        ? "Auto-Akzeptieren aktiviert."
        : "Auto-Akzeptieren deaktiviert.";
      return;
    }
    // Roll the toggle back so the visible state always matches the
    // server's truth.
    autoToggle.checked = !next;
    autoStatus.style.color = "var(--error)";
    autoStatus.textContent = `Fehler: ${res.message}`;
  });

  // ── Danger zone: delete ─────────────────────────────────────────
  const danger = document.createElement("div");
  danger.style.marginTop = "1.5rem";
  danger.style.padding = "0.75rem 0";

  const dangerTitle = document.createElement("p");
  dangerTitle.style.fontWeight = "600";
  dangerTitle.style.color = "var(--error)";
  dangerTitle.style.marginBottom = "0.25rem";
  dangerTitle.textContent = "Gerät entkoppeln";
  danger.appendChild(dangerTitle);

  const dangerDesc = document.createElement("p");
  dangerDesc.style.fontSize = "0.8125rem";
  dangerDesc.style.color = "var(--text-secondary)";
  dangerDesc.style.marginBottom = "0.5rem";
  dangerDesc.textContent =
    "Das Token wird widerrufen, eine laufende Sitzung wird sofort getrennt. " +
    "Auf dem Gerät kann ein neues Pairing gemacht werden.";
  danger.appendChild(dangerDesc);

  const dangerBtn = document.createElement("button");
  dangerBtn.type = "button";
  dangerBtn.textContent = "Gerät entkoppeln";
  dangerBtn.style.background = "var(--error)";
  dangerBtn.style.color = "#fff";
  dangerBtn.style.border = "none";
  dangerBtn.style.padding = "0.5rem 0.875rem";
  dangerBtn.style.borderRadius = "6px";
  dangerBtn.style.cursor = "pointer";
  dangerBtn.style.fontSize = "0.9375rem";

  const dangerStatus = document.createElement("p");
  dangerStatus.setAttribute("role", "status");
  dangerStatus.setAttribute("aria-live", "polite");
  dangerStatus.style.fontSize = "0.875rem";
  dangerStatus.style.marginTop = "0.5rem";

  dangerBtn.addEventListener("click", async () => {
    if (!window.confirm(`Gerät "${dev.alias}" wirklich entkoppeln?`)) return;
    dangerBtn.disabled = true;
    dangerBtn.textContent = "Entkoppeln …";
    const res = await deleteDevice(dev.id);
    if (res.ok) {
      window.history.pushState({}, "", BASE_PATH + "/devices");
      window.dispatchEvent(new PopStateEvent("popstate"));
      return;
    }
    dangerBtn.disabled = false;
    dangerBtn.textContent = "Gerät entkoppeln";
    dangerStatus.style.color = "var(--error)";
    dangerStatus.textContent = `Fehler: ${res.message}`;
  });

  danger.appendChild(dangerBtn);
  danger.appendChild(dangerStatus);
  card.appendChild(danger);

  root.appendChild(card);
  queueMicrotask(() => aliasInput.focus());
}
