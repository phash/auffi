// /dashboard/admin/feedback — admin-only feedback inbox (gh #39).
//
// Tabbed list (open / resolved / all), each card shows category, rating,
// body, account email, source (dashboard/sharer). Actions per card:
//   • Toggle resolved (PATCH /api/admin/feedback/:id)
//   • Inline-Antworten (POST /api/admin/feedback/:id/reply) — Backend
//     persistiert den Reply UND verschickt eine E-Mail an die User-
//     Profile-Adresse. Bei vorhandenem Reply wird die Antwort
//     read-only angezeigt mit "Neu antworten"-Button.
//   • Löschen (DELETE)
//
// 403 → admin-only guard fires when a non-admin opens the URL; the
// page shows the same friendly redirect as the other admin views.

import {
  deleteAdminFeedback,
  listAdminFeedback,
  patchAdminFeedback,
  replyAdminFeedback,
  type AdminFeedbackRow,
  type FeedbackCategory,
} from "../api.js";
import { formatAbsolute } from "../format.js";
import { confirmDialog } from "../components/confirm-dialog.js";
import { type RouteContext, type RouteRenderer } from "../router.js";

type Tab = "open" | "resolved" | "all";

const PAGE_SIZE = 100;

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

  const more = document.createElement("button");
  more.type = "button";
  more.className = "feedback-btn";
  more.style.marginTop = "0.75rem";
  more.style.display = "none";
  more.textContent = "Mehr laden";
  card.appendChild(more);

  let activeTab: Tab = "open";
  let nextCursor: number | null = null;
  // Request-generation token: every reload/load-more bumps it and each
  // response is discarded unless it still carries the latest generation
  // — fast tab switches would otherwise interleave rows of two tabs.
  let generation = 0;

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

  function appendRows(items: AdminFeedbackRow[]): void {
    for (const item of items) {
      list.appendChild(buildCard(item, () => void reload()));
    }
  }

  async function reload(): Promise<void> {
    const myGeneration = ++generation;
    status.textContent = "Lade …";
    status.className = "loading";
    while (list.firstChild) list.removeChild(list.firstChild);
    nextCursor = null;
    more.style.display = "none";
    // Reset the button — a superseded in-flight load-more may have
    // left it disabled with "Lädt …".
    more.disabled = false;
    more.textContent = "Mehr laden";

    const res = await listAdminFeedback({ status: activeTab, limit: PAGE_SIZE });
    if (myGeneration !== generation) return;
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
    appendRows(res.data.items);
    nextCursor = res.data.nextCursor;
    if (nextCursor !== null) more.style.display = "block";
  }

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    const myGeneration = ++generation;
    more.disabled = true;
    more.textContent = "Lädt …";

    const res = await listAdminFeedback({
      status: activeTab,
      cursor: nextCursor,
      limit: PAGE_SIZE,
    });
    if (myGeneration !== generation) return;
    more.disabled = false;
    more.textContent = "Mehr laden";
    if (!res.ok) {
      // Fehler sichtbar machen und den Button als Retry-Pfad stehen lassen.
      status.textContent = `Fehler: ${res.message}`;
      status.className = "error";
      return;
    }
    status.textContent = "";
    status.className = "";
    appendRows(res.data.items);
    nextCursor = res.data.nextCursor;
    more.style.display = nextCursor === null ? "none" : "block";
  }

  more.addEventListener("click", () => void loadMore());
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

  // Reply (read-only display if already answered).
  if (item.repliedAt && item.replyBody) {
    const replyBox = document.createElement("aside");
    replyBox.className = "feedback-admin-reply-shown";
    const replyHeader = document.createElement("div");
    replyHeader.className = "feedback-admin-reply-header";
    const replyLabel = document.createElement("strong");
    const sendStatus = item.replySentAt
      ? `gesendet ${formatAbsolute(item.replySentAt)}`
      : "Mail-Versand fehlgeschlagen — bitte erneut senden";
    replyLabel.textContent = `Antwort vom Admin am ${formatAbsolute(item.repliedAt)} (${sendStatus})`;
    replyHeader.appendChild(replyLabel);
    replyBox.appendChild(replyHeader);
    const replyText = document.createElement("p");
    replyText.className = "feedback-admin-reply-body";
    replyText.textContent = item.replyBody;
    replyBox.appendChild(replyText);
    card.appendChild(replyBox);
  }

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

  const replyBtn = document.createElement("button");
  replyBtn.type = "button";
  replyBtn.className = "feedback-btn";
  replyBtn.textContent = item.repliedAt ? "Neu antworten" : "Antworten";
  replyBtn.addEventListener("click", () => {
    // Toggle inline reply panel.
    const existing = card.querySelector(".feedback-admin-reply-panel");
    if (existing) {
      existing.remove();
      return;
    }
    card.appendChild(buildReplyPanel(item, onChange));
  });
  actions.appendChild(replyBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "feedback-btn";
  deleteBtn.textContent = "Löschen";
  deleteBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Feedback löschen",
      message: "Feedback-Eintrag wirklich löschen? Diese Aktion wird im Audit-Log protokolliert.",
      confirmLabel: "Löschen",
      variant: "danger",
    });
    if (!ok) return;
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

function buildReplyPanel(item: AdminFeedbackRow, onChange: () => void): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "feedback-admin-reply-panel";

  const label = document.createElement("label");
  label.className = "feedback-admin-reply-label";
  label.textContent = "Deine Antwort (geht per E-Mail an " + item.accountEmail + ")";
  panel.appendChild(label);

  const ta = document.createElement("textarea");
  ta.className = "feedback-admin-reply-textarea";
  ta.rows = 5;
  ta.maxLength = 4000;
  ta.placeholder = "Hi, danke für dein Feedback — …";
  // Pre-fill with the previous reply when re-answering an already-replied
  // row, so the admin can edit in-place rather than re-typing the
  // shared bits of the answer.
  if (item.replyBody) ta.value = item.replyBody;
  label.appendChild(ta);

  const buttons = document.createElement("div");
  buttons.className = "feedback-admin-reply-actions";
  const sendBtn = document.createElement("button");
  sendBtn.type = "button";
  sendBtn.className = "feedback-btn feedback-btn-primary";
  sendBtn.textContent = "Senden";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "feedback-btn";
  cancelBtn.textContent = "Abbrechen";
  buttons.appendChild(sendBtn);
  buttons.appendChild(cancelBtn);
  panel.appendChild(buttons);

  const status = document.createElement("p");
  status.className = "feedback-admin-reply-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  panel.appendChild(status);

  cancelBtn.addEventListener("click", () => panel.remove());

  sendBtn.addEventListener("click", async () => {
    const text = ta.value.trim();
    if (text.length === 0) {
      status.textContent = "Bitte Text eingeben.";
      status.className = "feedback-admin-reply-status err";
      return;
    }
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    status.textContent = "Sende …";
    status.className = "feedback-admin-reply-status info";
    const res = await replyAdminFeedback(item.id, text);
    sendBtn.disabled = false;
    cancelBtn.disabled = false;
    if (!res.ok) {
      status.textContent = `Fehler: ${res.message}`;
      status.className = "feedback-admin-reply-status err";
      return;
    }
    // Backend always returns 200 if the reply persisted; sentAt may be
    // null when SMTP failed. Reload the list either way so the card
    // shows the new reply-shown box, including the "send failed" hint.
    if (res.data.sentAt === null) {
      status.textContent =
        `Antwort gespeichert, aber Mail-Versand fehlgeschlagen` +
        (res.data.sendError ? ` (${res.data.sendError})` : "") +
        ". Du kannst es gleich nochmal versuchen.";
      status.className = "feedback-admin-reply-status err";
      // Trigger reload so the "Mail-Versand fehlgeschlagen"-Badge appears
      // in the read-only block; admin then clicks "Neu antworten" to retry.
      window.setTimeout(onChange, 1500);
    } else {
      onChange();
    }
  });

  return panel;
}
