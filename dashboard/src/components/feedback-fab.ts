// Feedback Floating Action Button + Modal (gh #39).
//
// Mounted once at app boot. Visibility is tied to the session: the
// FAB only appears when `getMe()` returns 200, i.e. the user is
// logged in. Click → opens a modal with category dropdown, 1–5
// rating, free-text body, submit button. On success the modal
// closes and a small "Danke!" toast shows for 3 s.
//
// The form posts to POST /api/feedback with source="dashboard".
// Auth flows via the existing __Host-auffi_session cookie.

import { getMe, submitFeedback, type FeedbackCategory } from "../api.js";

const FAB_ID = "feedback-fab";
const MODAL_ID = "feedback-modal";
const TOAST_ID = "feedback-toast";

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: "Bug / Fehler",
  feature: "Funktionswunsch",
  praise: "Lob",
  other: "Sonstiges",
};
const CATEGORY_ORDER: FeedbackCategory[] = ["bug", "feature", "praise", "other"];

/**
 * Install the FAB into the DOM if the user is logged in. Idempotent:
 * a second call replaces the existing FAB rather than stacking.
 */
export async function installFeedbackFab(): Promise<void> {
  // Probe login state before injecting anything — anonymous visitors
  // on /login / /signup never see the FAB.
  const me = await getMe();
  removeExistingNodes();
  if (!me.ok) return;

  const fab = buildFab();
  document.body.appendChild(fab);
}

function removeExistingNodes(): void {
  for (const id of [FAB_ID, MODAL_ID, TOAST_ID]) {
    const old = document.getElementById(id);
    if (old) old.remove();
  }
}

function buildFab(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = FAB_ID;
  btn.className = "feedback-fab";
  btn.type = "button";
  btn.setAttribute("aria-label", "Feedback geben");
  btn.title = "Feedback geben";
  // Inline SVG (chat-bubble) constructed via DOM API so the
  // innerHTML lint-rule stays happy. Same shape as Lucide's
  // `message-square`.
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svgNs, "path");
  path.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
  svg.appendChild(path);
  btn.appendChild(svg);
  btn.addEventListener("click", () => openModal());
  return btn;
}

interface ModalState {
  category: FeedbackCategory;
  rating: number;
  body: string;
}

function openModal(): void {
  const existing = document.getElementById(MODAL_ID);
  if (existing) existing.remove();

  const state: ModalState = { category: "bug", rating: 4, body: "" };

  const overlay = document.createElement("div");
  overlay.id = MODAL_ID;
  overlay.className = "feedback-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "feedback-modal-title");

  const card = document.createElement("div");
  card.className = "feedback-modal";
  overlay.appendChild(card);

  // Header.
  const header = document.createElement("header");
  header.className = "feedback-modal-header";
  const h2 = document.createElement("h2");
  h2.id = "feedback-modal-title";
  h2.textContent = "Feedback geben";
  header.appendChild(h2);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "feedback-modal-close";
  closeBtn.setAttribute("aria-label", "Schließen");
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);
  card.appendChild(header);

  // Form.
  const form = document.createElement("form");
  form.className = "feedback-modal-form";
  form.noValidate = true;
  card.appendChild(form);

  // Category field.
  const catLabel = document.createElement("label");
  catLabel.className = "feedback-field";
  const catLabelSpan = document.createElement("span");
  catLabelSpan.className = "feedback-field-label";
  catLabelSpan.textContent = "Kategorie";
  catLabel.appendChild(catLabelSpan);
  const catSelect = document.createElement("select");
  catSelect.name = "category";
  catSelect.className = "feedback-select";
  for (const key of CATEGORY_ORDER) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = CATEGORY_LABELS[key];
    if (key === state.category) opt.selected = true;
    catSelect.appendChild(opt);
  }
  catLabel.appendChild(catSelect);
  form.appendChild(catLabel);

  // Rating fieldset.
  const ratingField = document.createElement("fieldset");
  ratingField.className = "feedback-field feedback-rating-field";
  const ratingLegend = document.createElement("legend");
  ratingLegend.className = "feedback-field-label";
  ratingLegend.textContent = "Bewertung";
  ratingField.appendChild(ratingLegend);
  const ratingGroup = document.createElement("div");
  ratingGroup.className = "feedback-rating";
  ratingGroup.setAttribute("role", "radiogroup");
  ratingGroup.setAttribute("aria-label", "Bewertung");
  for (const n of [1, 2, 3, 4, 5]) {
    const star = document.createElement("button");
    star.type = "button";
    star.className = "feedback-star" + (n <= state.rating ? " active" : "");
    star.dataset.rating = String(n);
    star.setAttribute("role", "radio");
    star.setAttribute("aria-checked", String(n === state.rating));
    star.setAttribute("aria-label", `${n} Stern${n === 1 ? "" : "e"}`);
    star.textContent = "★";
    ratingGroup.appendChild(star);
  }
  ratingField.appendChild(ratingGroup);
  form.appendChild(ratingField);

  // Body textarea.
  const bodyLabel = document.createElement("label");
  bodyLabel.className = "feedback-field";
  const bodyLabelSpan = document.createElement("span");
  bodyLabelSpan.className = "feedback-field-label";
  bodyLabelSpan.textContent = "Nachricht";
  bodyLabel.appendChild(bodyLabelSpan);
  const bodyArea = document.createElement("textarea");
  bodyArea.name = "body";
  bodyArea.rows = 5;
  bodyArea.maxLength = 4000;
  bodyArea.placeholder = "Was funktioniert nicht / was fehlt / was magst du?";
  bodyArea.required = true;
  bodyLabel.appendChild(bodyArea);
  form.appendChild(bodyLabel);

  // Actions.
  const actions = document.createElement("div");
  actions.className = "feedback-modal-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "feedback-btn feedback-btn-secondary";
  cancelBtn.dataset.action = "cancel";
  cancelBtn.textContent = "Abbrechen";
  actions.appendChild(cancelBtn);
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "feedback-btn feedback-btn-primary";
  submitBtn.dataset.action = "submit";
  submitBtn.textContent = "Senden";
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  // Status line.
  const status = document.createElement("p");
  status.className = "feedback-modal-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  form.appendChild(status);

  document.body.appendChild(overlay);

  // ── Wiring ────────────────────────────────────────────────────
  const close = (): void => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);

  // Rating stars.
  ratingGroup.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-rating]");
    if (!target) return;
    const n = Number(target.dataset.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) return;
    state.rating = n;
    for (const star of ratingGroup.querySelectorAll<HTMLButtonElement>(".feedback-star")) {
      const v = Number(star.dataset.rating);
      star.classList.toggle("active", v <= n);
      star.setAttribute("aria-checked", String(v === n));
    }
  });

  // Submit.
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const category = (fd.get("category") ?? "bug") as FeedbackCategory;
    const body = String(fd.get("body") ?? "").trim();
    if (body.length === 0) {
      status.textContent = "Bitte Text eingeben.";
      status.className = "feedback-modal-status err";
      return;
    }
    submitBtn.disabled = true;
    status.textContent = "Sende …";
    status.className = "feedback-modal-status info";
    const res = await submitFeedback({
      source: "dashboard",
      category,
      rating: state.rating,
      body,
    });
    if (res.ok) {
      close();
      showToast("Danke fürs Feedback!");
    } else {
      submitBtn.disabled = false;
      status.textContent = res.message;
      status.className = "feedback-modal-status err";
    }
  });

  // Focus the textarea so a keyboard user lands on the primary input.
  bodyArea.focus();
}

function showToast(message: string): void {
  const existing = document.getElementById(TOAST_ID);
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.className = "feedback-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3000);
}
