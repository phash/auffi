// /dashboard/admin/feedback — admin-only feedback inbox (gh #39).
//
// Tabbed list (open / resolved / all), each card shows category, rating,
// body, account email, source (dashboard/sharer). Actions per card:
//   • Toggle resolved (PATCH /api/admin/feedback/:id)
//   • Antworten (mailto:account@example.com?…)
//   • Löschen (DELETE)
//
// 403 → admin-only guard fires when a non-admin opens the URL; the
// page shows the same friendly redirect as the other admin views.

import {
  deleteAdminFeedback,
  listAdminFeedback,
  patchAdminFeedback,
  type AdminFeedbackRow,
  type FeedbackCategory,
} from "../api.js";
import { formatAbsolute } from "../format.js";
import { type RouteContext, type RouteRenderer } from "../router.js";

type Tab = "open" | "resolved" | "all";

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: "Bug",
  feature: "Wunsch",
  praise: "Lob",
  other: "Sonstiges",
};

export const renderAdminFeedback: RouteRenderer = (
  root: HTMLElement,
  _ctx: RouteContext,
) => {
  while (root.firstChild) root.removeChild(root.firstChild);

  const card = document.createElement("section");
  card.className = "card";
  root.appendChild(card);

  const header = document.createElement("h1");
  header.textContent = "Feedback";
  card.appendChild(header);

  const tabs = document.createElement("div");
  tabs.className = "feedback-admin-tabs";
  card.appendChild(tabs);

  const list = document.createElement("div");
  list.className = "feedback-admin-list";
  card.appendChild(list);

  const status = document.createElement("p");
  status.className = "loading";
  status.textContent = "Lade …";
  card.appendChild(status);

  let activeTab: Tab = "open";

  function buildTab(label: string, key: Tab): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "feedback-admin-tab" + (activeTab === key ? " active" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (activeTab === key) return;
      activeTab = key;
      for (const t of tabs.querySelectorAll(".feedback-admin-tab")) {
        t.classList.remove("active");
      }
      btn.classList.add("active");
      void reload();
    });
    return btn;
  }

  tabs.appendChild(buildTab("Offen", "open"));
  tabs.appendChild(buildTab("Erledigt", "resolved"));
  tabs.appendChild(buildTab("Alle", "all"));

  async function reload(): Promise<void> {
    status.textContent = "Lade …";
    status.className = "loading";
    while (list.firstChild) list.removeChild(list.firstChild);

    const res = await listAdminFeedback({ status: activeTab, limit: 100 });
    if (!res.ok) {
      status.textContent =
        res.status === 403
          ? "Du musst Admin sein, um Feedback zu sehen."
          : `Fehler: ${res.message}`;
      status.className = "error";
      return;
    }
    if (res.data.items.length === 0) {
      status.textContent =
        activeTab === "open"
          ? "Aktuell kein offenes Feedback."
          : activeTab === "resolved"
            ? "Noch kein erledigtes Feedback."
            : "Noch kein Feedback eingegangen.";
      status.className = "muted";
      return;
    }
    status.textContent = "";
    status.className = "";
    for (const item of res.data.items) {
      list.appendChild(buildCard(item, () => void reload()));
    }
  }

  void reload();
};

function buildCard(item: AdminFeedbackRow, onChange: () => void): HTMLElement {
  const card = document.createElement("article");
  card.className = "feedback-admin-card" + (item.resolvedAt ? " resolved" : "");
  card.dataset.id = String(item.id);

  // Meta line.
  const meta = document.createElement("div");
  meta.className = "feedback-admin-meta";
  const date = document.createElement("span");
  date.textContent = formatAbsolute(item.createdAt);
  meta.appendChild(date);
  const cat = document.createElement("span");
  cat.className = "category";
  cat.textContent = CATEGORY_LABELS[item.category] ?? item.category;
  meta.appendChild(cat);
  const rating = document.createElement("span");
  rating.className = "rating";
  rating.textContent = "★".repeat(item.rating) + "☆".repeat(5 - item.rating);
  rating.setAttribute("aria-label", `Bewertung: ${item.rating} von 5`);
  meta.appendChild(rating);
  const src = document.createElement("span");
  src.textContent = item.source;
  meta.appendChild(src);
  const email = document.createElement("span");
  email.textContent = item.accountEmail;
  meta.appendChild(email);
  if (item.resolvedAt) {
    const done = document.createElement("span");
    done.textContent = `erledigt ${formatAbsolute(item.resolvedAt)}`;
    meta.appendChild(done);
  }
  card.appendChild(meta);

  // Body.
  const body = document.createElement("p");
  body.className = "feedback-admin-body";
  body.textContent = item.body;
  card.appendChild(body);

  // Actions.
  const actions = document.createElement("div");
  actions.className = "feedback-admin-actions";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "feedback-btn";
  toggleBtn.textContent = item.resolvedAt ? "Wieder öffnen" : "Erledigen";
  toggleBtn.addEventListener("click", async () => {
    toggleBtn.disabled = true;
    const res = await patchAdminFeedback(item.id, !item.resolvedAt);
    toggleBtn.disabled = false;
    if (!res.ok) {
      alert(`Fehler: ${res.message}`);
      return;
    }
    onChange();
  });
  actions.appendChild(toggleBtn);

  const replyBtn = document.createElement("a");
  replyBtn.className = "feedback-btn";
  const subject = `Auffi-Feedback: ${CATEGORY_LABELS[item.category] ?? item.category}`;
  // Quote-body the original text so the admin has context in the
  // reply window without re-typing it.
  const quoted = item.body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const bodyMail =
    `Hallo,\n\ndanke für dein Feedback:\n\n${quoted}\n\n\n— Auffi-Team`;
  replyBtn.href =
    `mailto:${encodeURIComponent(item.accountEmail)}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(bodyMail)}`;
  replyBtn.textContent = "Antworten";
  actions.appendChild(replyBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "feedback-btn";
  deleteBtn.textContent = "Löschen";
  deleteBtn.addEventListener("click", async () => {
    if (!confirm("Feedback-Eintrag wirklich löschen? Diese Aktion wird im Audit-Log protokolliert.")) {
      return;
    }
    deleteBtn.disabled = true;
    const res = await deleteAdminFeedback(item.id);
    deleteBtn.disabled = false;
    if (!res.ok) {
      alert(`Fehler: ${res.message}`);
      return;
    }
    onChange();
  });
  actions.appendChild(deleteBtn);

  card.appendChild(actions);
  return card;
}
