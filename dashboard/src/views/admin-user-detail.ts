// gh #54 — /admin/users/:id — Detail-Page mit Aktionen + Audit-Trail.
//
// Lädt /api/admin/users/:id (Stammdaten + Devices + recent_connections
// + recent_audits). Header zeigt Email + Badges; daneben Action-Bar
// mit Suspend/Unsuspend, Promote/Demote, Löschen. Jeder Klick öffnet
// das geteilte Confirm-Mit-Reason-Modal (min 10 Zeichen). Nach
// erfolgreichem PATCH/DELETE wird die ganze Seite refetched (außer
// bei DELETE — dort zurück zur Liste).

import {
  deleteAdminUser,
  getAdminUser,
  patchAdminUser,
  type AdminUserAction,
  type AdminUserConnection,
  type AdminUserDetail,
} from "../api.js";
import { confirmWithReason } from "../components/confirm-with-reason.js";
import {
  formatAbsolute,
  formatBytes,
  formatDate,
  formatDuration,
} from "../format.js";
import {
  BASE_PATH,
  navigate,
  type RouteContext,
  type RouteRenderer,
} from "../router.js";

export const renderAdminUserDetail: RouteRenderer = (
  root: HTMLElement,
  ctx: RouteContext,
) => {
  while (root.firstChild) root.removeChild(root.firstChild);
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) {
    const err = document.createElement("p");
    err.className = "error";
    err.textContent = "Ungültige User-ID.";
    root.appendChild(err);
    return;
  }

  const card = document.createElement("section");
  card.className = "card";
  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Lade Nutzer …";
  card.appendChild(status);
  root.appendChild(card);

  let inFlight = false;
  let unmounted = false;

  async function load(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    const res = await getAdminUser(id);
    inFlight = false;
    if (unmounted) return;
    if (!res.ok) {
      if (res.status === 401) {
        navigate("/login");
        return;
      }
      while (root.firstChild) root.removeChild(root.firstChild);
      const err = document.createElement("section");
      err.className = "card";
      const h1 = document.createElement("h1");
      h1.textContent = "Nutzer";
      err.appendChild(h1);
      const p = document.createElement("p");
      p.className = "error";
      p.textContent =
        res.status === 403
          ? "Du musst Admin sein."
          : res.status === 404
            ? `Nutzer #${id} nicht gefunden.`
            : `Fehler: ${res.message}`;
      err.appendChild(p);
      root.appendChild(err);
      return;
    }
    renderDetail(res.data);
  }

  function renderDetail(user: AdminUserDetail): void {
    while (root.firstChild) root.removeChild(root.firstChild);

    // ─ Back-link ─
    const back = document.createElement("a");
    back.href = BASE_PATH + "/admin/users";
    back.className = "muted";
    back.textContent = "← Zurück zur Nutzer-Liste";
    back.style.display = "inline-block";
    back.style.marginBottom = "0.75rem";
    root.appendChild(back);

    // ─ Header ─
    const head = document.createElement("section");
    head.className = "card";
    const h1 = document.createElement("h1");
    h1.textContent = user.email;
    h1.style.margin = "0 0 0.5rem 0";
    head.appendChild(h1);

    const badges = document.createElement("div");
    if (user.admin) badges.appendChild(badge("Admin", "user-badge-admin"));
    if (user.suspended_at) badges.appendChild(badge("Suspendiert", "user-badge-suspended"));
    if (!user.email_verified_at) badges.appendChild(badge("Unverifiziert", "user-badge-unverified"));
    if (badges.children.length === 0) {
      const ok = document.createElement("span");
      ok.className = "muted";
      ok.textContent = "Aktiv";
      badges.appendChild(ok);
    }
    head.appendChild(badges);

    const meta = document.createElement("p");
    meta.className = "muted";
    meta.style.fontSize = "0.8125rem";
    meta.style.marginTop = "0.5rem";
    meta.textContent = `Account #${user.id} · Angelegt am ${formatDate(user.created_at)}`;
    head.appendChild(meta);
    root.appendChild(head);

    // ─ Action bar ─
    const actions = document.createElement("section");
    actions.className = "card";
    const ah = document.createElement("h2");
    ah.textContent = "Aktionen";
    actions.appendChild(ah);

    const bar = document.createElement("div");
    bar.style.display = "flex";
    bar.style.gap = "0.5rem";
    bar.style.flexWrap = "wrap";

    const suspendBtn = actionButton(
      user.suspended_at ? "Reaktivieren" : "Suspendieren",
      user.suspended_at ? "primary" : "danger",
      () =>
        runAction(user.suspended_at ? "unsuspend" : "suspend", {
          title: user.suspended_at ? "Reaktivieren?" : "Suspendieren?",
          message: user.suspended_at
            ? `Reaktivierung erlaubt dem Account wieder Login. Bitte Grund eintragen.`
            : `Suspendierung beendet alle Sessions sofort und sperrt Login. Grund nötig.`,
          confirmLabel: user.suspended_at ? "Reaktivieren" : "Suspendieren",
          variant: user.suspended_at ? "primary" : "danger",
        }),
    );
    bar.appendChild(suspendBtn);

    const promoteBtn = actionButton(
      user.admin ? "Admin-Rechte entziehen" : "Zum Admin machen",
      user.admin ? "danger" : "primary",
      () =>
        runAction(user.admin ? "demote" : "promote", {
          title: user.admin ? "Demote?" : "Promote?",
          message: user.admin
            ? "Admin-Rechte werden entzogen. Backend lehnt ab, wenn dies der letzte Admin wäre."
            : "Vergibt Admin-Rechte (Zugriff auf alle Admin-Endpoints).",
          confirmLabel: user.admin ? "Demoten" : "Befördern",
          variant: user.admin ? "danger" : "primary",
        }),
    );
    bar.appendChild(promoteBtn);

    const deleteBtn = actionButton("Löschen", "danger", () =>
      runDelete({
        title: "Account hart löschen?",
        message:
          "Endgültige Löschung: alle Geräte, Sessions und Verbindungs-Logs werden via FK-Cascade entfernt. Nicht reversibel.",
        confirmLabel: "Endgültig löschen",
        variant: "danger",
      }),
    );
    bar.appendChild(deleteBtn);

    actions.appendChild(bar);

    // Inline error surface for the action bar — the backend's codes
    // ("last-admin" etc.) are diagnostic enough, but a blocking native
    // alert() swallows focus and sits outside the design system.
    const actionError = document.createElement("p");
    actionError.setAttribute("role", "alert");
    actionError.hidden = true;
    actions.appendChild(actionError);
    root.appendChild(actions);

    // ─ Devices ─
    const dev = document.createElement("section");
    dev.className = "card";
    const dh = document.createElement("h2");
    dh.textContent = `Geräte (${user.devices.length})`;
    dev.appendChild(dh);
    if (user.devices.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Keine gepairten Geräte.";
      dev.appendChild(empty);
    } else {
      const ul = document.createElement("ul");
      ul.style.listStyle = "none";
      ul.style.padding = "0";
      ul.style.margin = "0";
      for (const d of user.devices) {
        const li = document.createElement("li");
        li.style.padding = "0.375rem 0";
        li.style.borderBottom = "1px solid var(--border)";
        li.style.display = "flex";
        li.style.justifyContent = "space-between";
        li.style.gap = "0.5rem";
        const left = document.createElement("span");
        left.textContent = `${d.alias} (${d.id})`;
        const right = document.createElement("span");
        right.className = "muted";
        right.style.fontSize = "0.8125rem";
        right.textContent = d.online
          ? "● Online"
          : d.last_seen_at
            ? `Zuletzt gesehen: ${formatDate(d.last_seen_at)}`
            : "Noch nie verbunden";
        if (d.online) right.style.color = "var(--success)";
        li.appendChild(left);
        li.appendChild(right);
        ul.appendChild(li);
      }
      dev.appendChild(ul);
    }
    root.appendChild(dev);

    // ─ Recent connections ─
    const conn = document.createElement("section");
    conn.className = "card";
    const ch = document.createElement("h2");
    ch.textContent = `Letzte Verbindungen (${user.recent_connections.length})`;
    conn.appendChild(ch);
    if (user.recent_connections.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Noch keine Verbindungen.";
      conn.appendChild(empty);
    } else {
      conn.appendChild(connectionsTable(user.recent_connections));
    }
    root.appendChild(conn);

    // ─ Audit trail ─
    const audit = document.createElement("section");
    audit.className = "card";
    const auh = document.createElement("h2");
    auh.textContent = `Admin-Audit-Spur (${user.recent_audits.length})`;
    audit.appendChild(auh);
    if (user.recent_audits.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Keine Admin-Aktionen auf diesen Account.";
      audit.appendChild(empty);
    } else {
      const ul = document.createElement("ul");
      ul.style.listStyle = "none";
      ul.style.padding = "0";
      ul.style.margin = "0";
      for (const a of user.recent_audits) {
        const li = document.createElement("li");
        li.style.padding = "0.375rem 0";
        li.style.borderBottom = "1px solid var(--border)";
        const time = document.createElement("span");
        time.className = "muted";
        time.style.fontSize = "0.75rem";
        time.style.marginRight = "0.5rem";
        time.textContent = formatAbsolute(a.created_at);
        const action = document.createElement("strong");
        action.textContent = a.action;
        const admin = document.createElement("span");
        admin.className = "muted";
        admin.style.fontSize = "0.8125rem";
        admin.textContent = ` · Admin #${a.admin_id}`;
        li.appendChild(time);
        li.appendChild(action);
        li.appendChild(admin);
        // Reason aus after_json extrahieren, falls vorhanden.
        if (a.after_json) {
          try {
            const after = JSON.parse(a.after_json);
            if (after.reason) {
              const reason = document.createElement("p");
              reason.className = "muted";
              reason.style.margin = "0.25rem 0 0 0";
              reason.style.fontSize = "0.8125rem";
              reason.textContent = `Grund: ${after.reason}`;
              li.appendChild(reason);
            }
          } catch {
            /* malformed JSON in older audit rows — ignorieren */
          }
        }
        ul.appendChild(li);
      }
      audit.appendChild(ul);
    }
    root.appendChild(audit);

    async function runAction(
      action: AdminUserAction,
      modalOpts: Parameters<typeof confirmWithReason>[0],
    ): Promise<void> {
      const reason = await confirmWithReason(modalOpts);
      if (reason === null) return;
      setBarDisabled(true);
      const res = await patchAdminUser(user.id, action, reason);
      setBarDisabled(false);
      if (!res.ok) {
        showActionError(res.message);
        return;
      }
      void load(); // refetch
    }

    async function runDelete(modalOpts: Parameters<typeof confirmWithReason>[0]): Promise<void> {
      const reason = await confirmWithReason(modalOpts);
      if (reason === null) return;
      setBarDisabled(true);
      const res = await deleteAdminUser(user.id, reason);
      setBarDisabled(false);
      if (!res.ok) {
        showActionError(res.message);
        return;
      }
      navigate("/admin/users");
    }

    function showActionError(message: string): void {
      actionError.className = "error";
      actionError.textContent = `Fehler: ${message}`;
      actionError.hidden = false;
    }

    function setBarDisabled(disabled: boolean): void {
      if (disabled) {
        actionError.className = "";
        actionError.textContent = "";
        actionError.hidden = true;
      }
      for (const btn of [suspendBtn, promoteBtn, deleteBtn]) {
        btn.disabled = disabled;
      }
    }
  }

  void load();

  return () => {
    unmounted = true;
  };
};

function badge(text: string, klass: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = `user-badge ${klass}`;
  s.textContent = text;
  return s;
}

function actionButton(label: string, klass: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn ${klass}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function connectionsTable(rows: AdminUserConnection[]): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "admin-users-table";
  const thead = document.createElement("thead");
  const trH = document.createElement("tr");
  for (const label of ["Gerät", "Start", "Dauer", "Typ", "Relay-Bytes"]) {
    const th = document.createElement("th");
    th.textContent = label;
    trH.appendChild(th);
  }
  thead.appendChild(trH);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const c of rows) {
    const tr = document.createElement("tr");
    addCell(tr, c.device_id);
    addCell(tr, formatAbsolute(c.started_at));
    addCell(tr, c.ended_at ? formatDuration(c.started_at, c.ended_at) : "läuft");
    addCell(tr, c.connection_type);
    addCell(tr, formatBytes(c.bytes_relayed));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function addCell(tr: HTMLTableRowElement, text: string): void {
  const td = document.createElement("td");
  td.textContent = text;
  tr.appendChild(td);
}
