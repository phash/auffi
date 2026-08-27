// Feedback FAB + Modal in the sharer's webview (gh #39).
//
// Mounted at app boot. Only made visible when the sharer is paired
// (unattended_is_paired returns a device-id) AND a device-password
// is set — i.e. when the user has a real account context. Ad-hoc
// users have no account to attach feedback to and therefore see
// nothing.
//
// On submit the Rust side handles the HTTP call (device-Bearer
// header lives in the Rust process; the webview never sees the
// token). The webview only knows the form values.

import { invoke } from "@tauri-apps/api/core";

const FAB_ID = "auffi-feedback-fab";
const MODAL_ID = "auffi-feedback-modal";
const TOAST_ID = "auffi-feedback-toast";

type Category = "bug" | "feature" | "praise" | "other";
const CATEGORY_LABELS: Record<Category, string> = {
  bug: "Bug / Fehler",
  feature: "Funktionswunsch",
  praise: "Lob",
  other: "Sonstiges",
};
const CATEGORY_ORDER: Category[] = ["bug", "feature", "praise", "other"];

/**
 * Install or remove the FAB based on the paired-state of this
 * sharer. Call at app boot and on every Unattended-mode toggle.
 */
export async function refreshFeedbackFab(): Promise<void> {
  removeExisting();
  const paired = (await invoke<string | null>("unattended_is_paired").catch(() => null));
  const pwSet = (await invoke<boolean>("unattended_is_password_set").catch(() => false));
  if (!paired || !pwSet) return;
  document.body.appendChild(buildFab());
}

function removeExisting(): void {
  for (const id of [FAB_ID, MODAL_ID, TOAST_ID]) {
    const node = document.getElementById(id);
    if (node) node.remove();
  }
}

function buildFab(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = FAB_ID;
  btn.className = "feedback-fab";
  btn.type = "button";
  btn.title = "Feedback geben";
  btn.setAttribute("aria-label", "Feedback geben");
  // Inline SVG via DOM API (innerHTML is XSS-flagged by our hook).
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

function openModal(): void {
  const existing = document.getElementById(MODAL_ID);
  if (existing) existing.remove();

  // Restore focus to the opener (the FAB) on close, mirroring
  // confirm-dialog.ts — bodyArea.focus() below moves focus into the modal.
  const opener = document.activeElement as HTMLElement | null;

  const state = { category: "bug" as Category, rating: 4 };

  const overlay = document.createElement("div");
  overlay.id = MODAL_ID;
  overlay.className = "feedback-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "auffi-feedback-modal-title");

  const card = document.createElement("div");
  card.className = "feedback-modal";
  overlay.appendChild(card);

  // Header.
  const header = document.createElement("header");
  header.className = "feedback-modal-header";
  const h2 = document.createElement("h2");
  h2.id = "auffi-feedback-modal-title";
  h2.textContent = "Feedback geben";
  header.appendChild(h2);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "feedback-modal-close";
  closeBtn.setAttribute("aria-label", "Schließen");
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);
  card.appendChild(header);

  const form = document.createElement("form");
  form.className = "feedback-modal-form";
  form.noValidate = true;
  card.appendChild(form);

  // Category.
  const catLabel = document.createElement("label");
  catLabel.className = "feedback-field";
  const catSpan = document.createElement("span");
  catSpan.className = "feedback-field-label";
  catSpan.textContent = "Kategorie";
  catLabel.appendChild(catSpan);
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

  // Rating.
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

  // Body.
  const bodyLabel = document.createElement("label");
  bodyLabel.className = "feedback-field";
  const bodySpan = document.createElement("span");
  bodySpan.className = "feedback-field-label";
  bodySpan.textContent = "Nachricht";
  bodyLabel.appendChild(bodySpan);
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
  cancelBtn.textContent = "Abbrechen";
  actions.appendChild(cancelBtn);
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "feedback-btn feedback-btn-primary";
  submitBtn.textContent = "Senden";
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  // Status.
  const status = document.createElement("p");
  status.className = "feedback-modal-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  form.appendChild(status);

  document.body.appendChild(overlay);

  // Wiring.
  const close = (): void => {
    overlay.remove();
    opener?.focus?.();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  // Escape closes, like every other dialog in the sharer (the global
  // handler in main.ts only knows the static dialogs, not this one).
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);

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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const category = (fd.get("category") ?? "bug") as Category;
    const body = String(fd.get("body") ?? "").trim();
    if (body.length === 0) {
      status.textContent = "Bitte Text eingeben.";
      status.className = "feedback-modal-status err";
      return;
    }
    submitBtn.disabled = true;
    status.textContent = "Sende …";
    status.className = "feedback-modal-status info";
    try {
      await invoke("unattended_submit_feedback", {
        category,
        rating: state.rating,
        body,
      });
      close();
      showToast("Danke fürs Feedback!");
    } catch (err) {
      submitBtn.disabled = false;
      status.textContent = String(err);
      status.className = "feedback-modal-status err";
    }
  });

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
