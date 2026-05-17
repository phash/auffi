/* Auffi — /download/ Count-Decoration.
 *
 * On page load: GET /api/downloads, decorate each .download-item with a
 * "X Downloads"-Badge. On click of any .download-btn: fire-and-forget
 * POST /api/downloads/:asset, then continue the navigation normally
 * (browser already loaded the GH-redirect, the POST is best-effort and
 * never blocks the click).
 *
 * Asset name is derived from the href (last path segment of the GH
 * release URL). Vanilla JS so the file works outside the Vite bundle.
 */

(function () {
  function init() {
    fetch("/api/downloads", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.counts) return;
        decorateAll(data.counts);
      })
      .catch(function () { /* silent — counter is decoration, not load-blocking */ });

    // Click-tracking: intercept .download-btn clicks. We don't
    // preventDefault — the browser still navigates to GitHub. The POST
    // is fire-and-forget; the body is a no-op on failure.
    document.querySelectorAll(".download-btn[href]").forEach(function (a) {
      a.addEventListener("click", function () {
        var asset = assetFromHref(a.getAttribute("href"));
        if (!asset) return;
        // sendBeacon is the canonical fire-and-forget API — survives
        // page navigation in a way that plain fetch() may not.
        if (navigator.sendBeacon) {
          navigator.sendBeacon("/api/downloads/" + encodeURIComponent(asset));
        } else {
          fetch("/api/downloads/" + encodeURIComponent(asset), {
            method: "POST",
            keepalive: true,
            credentials: "same-origin",
          }).catch(function () {});
        }
      });
    });
  }

  function assetFromHref(href) {
    if (!href) return null;
    // Only count clicks on the GH-releases redirect; skip PKGBUILD /
    // repository links (those don't count as a "download").
    if (href.indexOf("/releases/latest/download/") === -1) return null;
    // Strip query + hash BEFORE extracting the last path segment — if
    // a tracking parameter (?utm_source=…) ever sneaks onto a download
    // href, the asset name would otherwise become "Auffi_…deb?utm=…"
    // and silently miss the backend allow-list. Defence against a
    // class of future copy-paste bugs (code-review CODE-H3, 2026-05-17).
    var clean = href.split("?")[0].split("#")[0];
    var idx = clean.lastIndexOf("/");
    return idx >= 0 ? clean.substring(idx + 1) : null;
  }

  function decorateAll(counts) {
    document.querySelectorAll(".download-btn[href]").forEach(function (a) {
      var asset = assetFromHref(a.getAttribute("href"));
      if (!asset) return;
      var n = counts[asset];
      if (typeof n !== "number") return;
      var item = a.closest(".download-item");
      if (!item) return;
      var meta = item.querySelector(".download-meta");
      if (!meta) return;
      // Avoid stacking badges if init() ever runs twice.
      var existing = meta.querySelector(".download-count");
      if (existing) existing.remove();
      var badge = document.createElement("p");
      badge.className = "download-count";
      badge.textContent = formatCount(n);
      meta.appendChild(badge);
    });
  }

  function formatCount(n) {
    if (n === 0) return "Noch kein Download";
    if (n === 1) return "1 Download";
    return n.toLocaleString("de-DE") + " Downloads";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
