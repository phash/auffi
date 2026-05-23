/* Auffi — Matomo-Consent-Banner.
 *
 * Geladen von den 4 Marketing-Pages (index, impressum, datenschutz,
 * download). Implementiert die Cookie-/Tracking-Einwilligung für die
 * selbst-gehostete Matomo-Instanz:
 *
 *   - Do-Not-Track gesetzt → kein Banner, kein Matomo (User hat im
 *     Browser bereits opt-out, das respektieren wir ohne Nachfrage).
 *   - localStorage 'auffi_matomo_consent' === 'ok' → Matomo wird sofort
 *     geladen, kein Banner.
 *   - === 'no' → kein Matomo, kein Banner (User hat schon abgelehnt).
 *   - unbekannt → Banner unten zeigen mit „Statistik OK" + „Ablehnen".
 *
 * Die Entscheidungslogik ist parallel in viewer/src/matomo-consent-
 * decision.ts gepflegt + getestet. Diese vanilla-JS-Datei dupliziert
 * die paar Zeilen, damit sie ohne Vite-Bundling auf den statischen
 * Marketing-Pages funktioniert.
 *
 * Kein Cookie für die Consent-Speicherung selbst — wir nutzen
 * localStorage, das nach TTDSG §25 für Funktionalität gespeichert
 * werden darf, sobald der User aktiv klickt.
 */

(function () {
  var STORAGE_KEY = "auffi_matomo_consent";
  var TRACKER_URL = "https://musikersuche.org/matomo/";
  var SITE_ID = "6";

  function readConsent() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === "ok" || v === "no" ? v : null;
    } catch (_e) {
      return null;
    }
  }

  function writeConsent(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch (_e) {
      /* localStorage disabled — ignore; banner wird beim nächsten Load wieder erscheinen */
    }
  }

  function dntActive() {
    var nav = navigator;
    return (
      nav.doNotTrack === "1" ||
      window.doNotTrack === "1" ||
      (nav.msDoNotTrack && nav.msDoNotTrack === "1")
    );
  }

  function loadMatomo() {
    if (window.__matomoLoaded) return;
    window.__matomoLoaded = true;
    var _paq = (window._paq = window._paq || []);
    _paq.push(["disableCookies"]);
    _paq.push(["setDoNotTrack", true]);
    _paq.push(["trackPageView"]);
    _paq.push(["setTrackerUrl", TRACKER_URL + "matomo.php"]);
    _paq.push(["setSiteId", SITE_ID]);
    var script = document.createElement("script");
    script.async = true;
    script.src = TRACKER_URL + "matomo.js";
    document.head.appendChild(script);
  }

  function buildBanner() {
    var banner = document.createElement("div");
    banner.id = "matomo-consent-banner";
    banner.className = "matomo-consent-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-live", "polite");
    banner.setAttribute("aria-label", "Datenschutz-Hinweis zur Reichweitenmessung");

    var text = document.createElement("p");
    text.className = "matomo-consent-text";
    text.appendChild(
      document.createTextNode(
        "Wir messen anonym, wie oft auffi.app aufgerufen wird — selbst-gehostetes Matomo, ohne Cookies, ohne IP-Speicherung. ",
      ),
    );
    var link = document.createElement("a");
    link.href = "/datenschutz/#matomo";
    link.className = "matomo-consent-link";
    link.textContent = "Mehr Info";
    text.appendChild(link);
    text.appendChild(document.createTextNode("."));
    banner.appendChild(text);

    var actions = document.createElement("div");
    actions.className = "matomo-consent-actions";

    var no = document.createElement("button");
    no.type = "button";
    no.className = "matomo-consent-btn matomo-consent-no";
    no.textContent = "Ablehnen";
    no.addEventListener("click", function () {
      writeConsent("no");
      dismissBanner(banner);
    });

    var ok = document.createElement("button");
    ok.type = "button";
    ok.className = "matomo-consent-btn matomo-consent-ok";
    ok.textContent = "Statistik OK";
    ok.addEventListener("click", function () {
      writeConsent("ok");
      dismissBanner(banner);
      loadMatomo();
    });

    actions.appendChild(no);
    actions.appendChild(ok);
    banner.appendChild(actions);
    return banner;
  }

  function showBanner() {
    if (document.getElementById("matomo-consent-banner")) return;
    document.body.appendChild(buildBanner());
    // Reserve vertical space at the bottom of the page so the
    // fixed-positioned banner doesn't overlap the last paragraph
    // of content. CSS rule lives in matomo-consent.css.
    document.body.classList.add("matomo-consent-shown");
  }

  function dismissBanner(banner) {
    banner.remove();
    document.body.classList.remove("matomo-consent-shown");
  }

  /**
   * Entscheidungs-Tabelle — Synchronisation mit viewer/src/matomo-
   * consent-decision.ts (decideAction()). Anyone, der hier was ändert,
   * sollte auch die TS-Variante + ihre Tests anpassen.
   */
  function decideAction(consent, dnt) {
    if (dnt) return "skip";
    if (consent === "ok") return "load";
    if (consent === "no") return "skip";
    return "banner";
  }

  function init() {
    var action = decideAction(readConsent(), dntActive());
    if (action === "load") loadMatomo();
    else if (action === "banner") showBanner();
    /* "skip" — nothing to do */
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
