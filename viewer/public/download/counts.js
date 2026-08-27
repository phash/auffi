/* Auffi — /download/ Count-Decoration.
 *
 * On page load: GET /api/downloads, decorate each .download-item with a
 * "X Downloads"-Badge. Click-tracking is handled server-side by the
 * /api/downloads/file/:asset proxy route (it bumps the counter as part
 * of the actual file-stream), so this script no longer needs to fire
 * a separate POST on click.
 *
 * Asset name is derived from the href (last path segment of the
 * /api/downloads/file/ URL). Vanilla JS so the file works outside the
 * Vite bundle. Wählt die Sprache anhand <html lang>, wie help-overlay.js
 * — die Datei wird auch von /en/download/ geladen.
 */

(function () {
  var COPY = {
    de: { zero: "Noch kein Download", one: "1 Download", many: "Downloads", locale: "de-DE" },
    en: { zero: "No downloads yet", one: "1 download", many: "downloads", locale: "en-US" },
  };

  function lang() {
    return (document.documentElement.lang || "de").toLowerCase().startsWith("en")
      ? "en"
      : "de";
  }
  function init() {
    fetch("/api/downloads", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.counts) return;
        decorateAll(data.counts);
      })
      .catch(function () { /* silent — counter is decoration, not load-blocking */ });
  }

  function assetFromHref(href) {
    if (!href) return null;
    // Only decorate the proxy-route URLs; skip PKGBUILD / repository
    // links (those aren't tracked as downloads).
    if (href.indexOf("/api/downloads/file/") === -1) return null;
    // Strip query + hash BEFORE extracting the last path segment — if
    // a tracking parameter (?utm_source=…) ever sneaks onto a download
    // href, the asset name would otherwise become "Auffi_…deb?utm=…"
    // and silently miss the backend allow-list. Defence against a
    // class of future copy-paste bugs (code-review CODE-H3, 2026-05-17).
    var clean = href.split("?")[0].split("#")[0];
    var idx = clean.lastIndexOf("/");
    if (idx < 0) return null;
    try { return decodeURIComponent(clean.substring(idx + 1)); } catch { return null; }
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
    var copy = COPY[lang()];
    if (n === 0) return copy.zero;
    if (n === 1) return copy.one;
    return n.toLocaleString(copy.locale) + " " + copy.many;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
