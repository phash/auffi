/* Auffi — Matomo init (self-hosted, cookieless, DNT respected).
 *
 * Loaded ONLY from static marketing pages (index.html, impressum,
 * datenschutz, download). Never loaded from the active-session state —
 * the SPA fires no further pageviews after this initial load.
 *
 * What this records:  initial page-view + referrer + (anonymised) geo
 * What this does NOT: link clicks, scrolls, mouse moves, session content
 *
 * See viewer/public/datenschutz/ and CLAUDE.md ("no third-party trackers"
 * — Matomo is self-hosted on the same VPS, not a third party).
 */
(function () {
  var _paq = (window._paq = window._paq || []);
  _paq.push(["disableCookies"]);
  _paq.push(["setDoNotTrack", true]);
  _paq.push(["trackPageView"]);
  var u = "https://musikersuche.org/matomo/";
  _paq.push(["setTrackerUrl", u + "matomo.php"]);
  _paq.push(["setSiteId", "6"]);
  var d = document;
  var g = d.createElement("script");
  var s = d.getElementsByTagName("script")[0];
  g.async = true;
  g.src = u + "matomo.js";
  s.parentNode.insertBefore(g, s);
})();
