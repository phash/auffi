/* Auffi — Floating Feedback Action Button.
 *
 * Loaded on the 4 marketing pages (index, impressum, datenschutz,
 * download). Only renders when /api/me returns 200 (= logged-in user
 * with a __Host-auffi_session cookie). Anonymous visitors see nothing.
 *
 * Click → modal with a single textarea + send/cancel. Submit hits
 * POST /api/feedback with source="viewer", category="other", rating=5.
 * Category + rating are silently fixed (the marketing-page audience
 * isn't going to triage their own bug class) — the admin UI still has
 * the full schema for filtering.
 *
 * Standalone vanilla JS, no Vite, no TS — so the same file works
 * unchanged on the static legal/download pages outside the SPA bundle.
 * CSS sibling at /feedback-fab.css.
 */

(function () {
  const FAB_ID = "feedback-fab";
  const MODAL_ID = "feedback-modal";
  const TOAST_ID = "feedback-toast";
  const SVG_NS = "http://www.w3.org/2000/svg";

  function init() {
    // Probe login state. /api/me is the canonical "who am I" endpoint;
    // 200 = session cookie valid, 401 = anon, anything else = ignore
    // (we don't want a transient server error to popup the FAB and
    // then bail on submit).
    fetch("/api/me", { credentials: "same-origin" })
      .then((r) => {
        if (r.ok) mount();
      })
      .catch(() => {
        /* network error — silently skip; FAB is optional UX */
      });
  }

  function mount() {
    if (document.getElementById(FAB_ID)) return;
    const btn = document.createElement("button");
    btn.id = FAB_ID;
    btn.className = "feedback-fab";
    btn.type = "button";
    btn.setAttribute("aria-label", "Feedback geben");
    btn.title = "Feedback geben";

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "22");
    svg.setAttribute("height", "22");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
    svg.appendChild(path);
    btn.appendChild(svg);
    const label = document.createElement("span");
    label.className = "feedback-fab-label";
    label.textContent = "Feedback";
    btn.appendChild(label);

    btn.addEventListener("click", openModal);
    document.body.appendChild(btn);
  }

  function openModal() {
    const existing = document.getElementById(MODAL_ID);
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.className = "feedback-modal-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "feedback-modal-title");

    const card = document.createElement("div");
    card.className = "feedback-modal";
    overlay.appendChild(card);

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

    const form = document.createElement("form");
    form.className = "feedback-modal-form";
    form.noValidate = true;
    card.appendChild(form);

    const label = document.createElement("label");
    label.className = "feedback-modal-label";
    const labelText = document.createElement("span");
    labelText.textContent = "Was funktioniert nicht / was fehlt / was magst du?";
    label.appendChild(labelText);
    const ta = document.createElement("textarea");
    ta.name = "body";
    ta.rows = 5;
    ta.maxLength = 4000;
    ta.required = true;
    ta.placeholder = "Schreib uns ein paar Sätze — wir antworten per Mail.";
    label.appendChild(ta);
    form.appendChild(label);

    const actions = document.createElement("div");
    actions.className = "feedback-modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "feedback-modal-btn feedback-modal-btn-secondary";
    cancelBtn.textContent = "Abbrechen";
    actions.appendChild(cancelBtn);
    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.className = "feedback-modal-btn feedback-modal-btn-primary";
    submitBtn.textContent = "Senden";
    actions.appendChild(submitBtn);
    form.appendChild(actions);

    const status = document.createElement("p");
    status.className = "feedback-modal-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    form.appendChild(status);

    document.body.appendChild(overlay);
    // Remember the element that had focus before the modal opened, so we
    // can return focus to it on close — accessibility default (a11y
    // CODE-H2, 2026-05-17).
    const previouslyFocused = document.activeElement;
    ta.focus();

    const close = function () {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        try {
          previouslyFocused.focus();
        } catch (_) {
          /* element gone, ignore */
        }
      }
    };
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    closeBtn.addEventListener("click", close);
    cancelBtn.addEventListener("click", close);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const text = ta.value.trim();
      if (text.length === 0) {
        status.textContent = "Bitte Text eingeben.";
        status.className = "feedback-modal-status err";
        return;
      }
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      status.textContent = "Sende …";
      status.className = "feedback-modal-status info";
      // Separate the network-error path (.catch on fetch) from the
      // HTTP-error path (response.ok=false). Without this split, any
      // throw inside the .then() — e.g. a future close()-throw — would
      // surface as a misleading "Netzwerkfehler" toast (code-review
      // CODE-H4, 2026-05-17).
      let response;
      fetch("/api/feedback", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "viewer",
          category: "other",
          rating: 5,
          body: text,
        }),
      })
        .catch(function () {
          submitBtn.disabled = false;
          cancelBtn.disabled = false;
          status.textContent = "Netzwerkfehler. Bitte später erneut.";
          status.className = "feedback-modal-status err";
          return null;
        })
        .then(function (r) {
          if (r === null) return;
          response = r;
          if (r.ok) {
            close();
            showToast("Danke für dein Feedback!");
            return;
          }
          return r.json().then(
            function (j) {
              submitBtn.disabled = false;
              cancelBtn.disabled = false;
              status.textContent =
                (j && j.message) || "Konnte nicht gesendet werden.";
              status.className = "feedback-modal-status err";
            },
            function () {
              submitBtn.disabled = false;
              cancelBtn.disabled = false;
              status.textContent = "Konnte nicht gesendet werden.";
              status.className = "feedback-modal-status err";
            },
          );
        });
    });
  }

  function showToast(message) {
    const existing = document.getElementById(TOAST_ID);
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.className = "feedback-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.textContent = message;
    document.body.appendChild(toast);
    window.setTimeout(function () {
      toast.remove();
    }, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
