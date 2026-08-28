// gh #54 — /admin/users — paginated/filterable/searchable user table.
//
// UX:
//   • 5 filter chips (alle / active / suspended / unverified / admin)
//   • search box, debounced 300 ms
//   • 50 rows per page, cursor-based; "Mehr laden"-Button am Tabellenende
//   • Row-Klick → /admin/users/:id
//
// Search-Debounce reset jeden Pagination-Cursor — neue Anfrage = neue
// erste Seite. Backend allow-listet status= (active|suspended|
// unverified|admin); unbekannte Werte (z.B. unser interner "alle"-
// State) werden NICHT als status= mitgesendet.

import {
  listAdminUsers,
  type AdminUserListItem,
  type AdminUserStatus,
} from "../api.js";
import { formatDate } from "../format.js";
import {
  BASE_PATH,
  navigate,
  type RouteContext,
  type RouteRenderer,
} from "../router.js";

type Filter = AdminUserStatus | "alle";

const FILTER_LABELS: Array<{ key: Filter; label: string }> = [
  { key: "alle", label: "Alle" },
  { key: "active", label: "Aktiv" },
  { key: "suspended", label: "Suspendiert" },
  { key: "unverified", label: "Unverifiziert" },
  { key: "admin", label: "Admins" },
];

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

interface ViewState {
  filter: Filter;
  search: string;
  items: AdminUserListItem[];
  nextCursor: string | null;
  loading: boolean;
}

export const renderAdminUsers: RouteRenderer = (
  root: HTMLElement,
  _ctx: RouteContext,
) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";

  const h1 = document.createElement("h1");
  h1.textContent = "Nutzer (Admin)";
  card.appendChild(h1);

  // ─ Controls ──────────────────────────────────────────────────────
  const controls = document.createElement("div");
  controls.className = "admin-users-controls";

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Email-Suche …";
  search.className = "admin-users-search";
  search.setAttribute("aria-label", "Nutzer nach Email durchsuchen");
  controls.appendChild(search);

  const chips = document.createElement("div");
  chips.className = "admin-users-chips";
  // A toggle-button group, not an ARIA tablist (there is no tabpanel and no
  // roving-tabindex/arrow-key model). role="group" + aria-pressed is the
  // honest semantic and keeps each chip in the natural tab order.
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Nutzer filtern");
  const chipBtns: Record<Filter, HTMLButtonElement> = {} as Record<Filter, HTMLButtonElement>;
  for (const { key, label } of FILTER_LABELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "admin-users-chip";
    btn.textContent = label;
    btn.setAttribute("aria-pressed", "false");
    btn.dataset.filter = key;
    chips.appendChild(btn);
    chipBtns[key] = btn;
  }
  controls.appendChild(chips);
  card.appendChild(controls);

  // ─ Status + Table host ──────────────────────────────────────────
  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Lade Nutzer …";
  card.appendChild(status);

  const tableHost = document.createElement("div");
  tableHost.style.display = "none";
  card.appendChild(tableHost);

  root.appendChild(card);

  const state: ViewState = {
    filter: "alle",
    search: "",
    items: [],
    nextCursor: null,
    loading: false,
  };

  function setActiveChip(): void {
    for (const { key } of FILTER_LABELS) {
      if (key === state.filter) {
        chipBtns[key].classList.add("active");
        chipBtns[key].setAttribute("aria-pressed", "true");
      } else {
        chipBtns[key].classList.remove("active");
        chipBtns[key].setAttribute("aria-pressed", "false");
      }
    }
  }

  // Filter/search change that arrived while a request was in flight —
  // re-run once the request settles instead of silently dropping it
  // (otherwise the active chip and the rendered rows contradict each
  // other until the next interaction).
  let pendingReset = false;

  async function fetchPage(reset: boolean): Promise<void> {
    if (state.loading) {
      if (reset) pendingReset = true;
      return;
    }
    state.loading = true;
    if (reset) {
      state.items = [];
      state.nextCursor = null;
      status.style.display = "block";
      status.className = "loading";
      status.textContent = "Lade Nutzer …";
      tableHost.style.display = "none";
    }
    const res = await listAdminUsers({
      status: state.filter === "alle" ? undefined : state.filter,
      q: state.search || undefined,
      cursor: reset ? undefined : (state.nextCursor ?? undefined),
      limit: PAGE_SIZE,
    });
    state.loading = false;
    if (pendingReset) {
      // The response belongs to the superseded filter/search — discard
      // it and fetch a fresh first page for the current state.
      pendingReset = false;
      void fetchPage(true);
      return;
    }
    if (!res.ok) {
      if (res.status === 401) {
        // Only navigate if this view is still mounted. Cancelling the debounce
        // alone left an already-dispatched request able to yank the user off
        // whatever page they opened next.
        if (!unmounted) navigate("/login");
        return;
      }
      status.className = "error";
      status.style.display = "block";
      status.textContent =
        res.status === 403
          ? "Du musst Admin sein, um die Nutzerliste zu sehen."
          : `Fehler: ${res.message}`;
      tableHost.style.display = "none";
      return;
    }
    state.items.push(...res.data.items);
    state.nextCursor = res.data.next_cursor;
    status.style.display = "none";
    tableHost.style.display = "block";
    renderTable();
  }

  function renderTable(): void {
    while (tableHost.firstChild) tableHost.removeChild(tableHost.firstChild);

    if (state.items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent =
        state.search.length > 0
          ? `Keine Nutzer für „${state.search}".`
          : "Keine Nutzer im gewählten Filter.";
      tableHost.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-users-table";
    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    for (const label of ["Email", "Status", "Geräte", "Letzter Login", "Angelegt"]) {
      const th = document.createElement("th");
      th.textContent = label;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const user of state.items) {
      const tr = document.createElement("tr");
      tr.className = "row-clickable";
      tr.addEventListener("click", (e) => {
        // The email cell is a real link (keyboard-accessible); let the
        // router handle that click so we don't navigate twice.
        if ((e.target as HTMLElement).closest("a")) return;
        navigate(`/admin/users/${user.id}`);
      });

      const tdEmail = document.createElement("td");
      const emailLink = document.createElement("a");
      emailLink.href = BASE_PATH + `/admin/users/${user.id}`;
      emailLink.textContent = user.email;
      emailLink.className = "user-row-link";
      tdEmail.appendChild(emailLink);
      tr.appendChild(tdEmail);

      const tdStatus = document.createElement("td");
      if (user.admin) tdStatus.appendChild(makeBadge("Admin", "user-badge-admin"));
      if (user.suspended_at) tdStatus.appendChild(makeBadge("Suspendiert", "user-badge-suspended"));
      if (!user.email_verified_at) tdStatus.appendChild(makeBadge("Unverifiziert", "user-badge-unverified"));
      if (!user.admin && !user.suspended_at && user.email_verified_at) {
        tdStatus.textContent = "Aktiv";
        tdStatus.style.color = "var(--text-secondary)";
      }
      tr.appendChild(tdStatus);

      const tdDevices = document.createElement("td");
      tdDevices.textContent = String(user.device_count);
      tdDevices.style.fontVariantNumeric = "tabular-nums";
      tr.appendChild(tdDevices);

      const tdLogin = document.createElement("td");
      tdLogin.textContent = user.last_login_at
        ? formatDate(user.last_login_at)
        : "—";
      tdLogin.style.color = "var(--text-secondary)";
      tr.appendChild(tdLogin);

      const tdCreated = document.createElement("td");
      tdCreated.textContent = formatDate(user.created_at);
      tdCreated.style.color = "var(--text-secondary)";
      tr.appendChild(tdCreated);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableHost.appendChild(table);

    if (state.nextCursor) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "admin-users-load-more";
      more.textContent = "Mehr laden";
      more.addEventListener("click", () => {
        more.disabled = true;
        more.textContent = "Lädt …";
        void fetchPage(false);
      });
      tableHost.appendChild(more);
    }
  }

  function makeBadge(text: string, klass: string): HTMLSpanElement {
    const s = document.createElement("span");
    s.className = `user-badge ${klass}`;
    s.textContent = text;
    return s;
  }

  // Wire chips
  for (const { key } of FILTER_LABELS) {
    chipBtns[key].addEventListener("click", () => {
      if (state.filter === key) return;
      state.filter = key;
      setActiveChip();
      void fetchPage(true);
    });
  }

  // Wire search with debounce
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let unmounted = false;
  search.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const newSearch = search.value.trim();
      if (newSearch === state.search) return;
      state.search = newSearch;
      void fetchPage(true);
    }, SEARCH_DEBOUNCE_MS);
  });

  setActiveChip();
  void fetchPage(true);

  // Router-invoked cleanup: a debounce that survives the unmount fires against
  // a view the user already left, and its 401 branch calls navigate("/login")
  // — a global history mutation they never asked for.
  return () => {
    unmounted = true;
    if (searchTimer) clearTimeout(searchTimer);
  };
};
