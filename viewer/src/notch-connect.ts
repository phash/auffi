// gh #104 — Notch-CTA: scrollt sanft zum Code-Input und fokussiert es.
// Aus main.ts extrahiert, damit das Verhalten unit-testbar bleibt; main.ts
// selbst ist vom Coverage-Tracking ausgeschlossen (siehe vitest.config.ts).

/**
 * Fokussiere das Verbindungscode-Eingabefeld und scrolle es in den
 * sichtbaren Bereich. `smooth=true` ist für den Klick auf den Notch, der
 * dem User visuell folgt; `smooth=false` ist für den initialen Page-Load
 * mit `#code`-Hash (wo wir keinen unnötigen Animations-Frame wollen).
 *
 * `preventScroll: true` auf `focus()` verhindert, dass der Browser den
 * scrollIntoView-Pfad mit einem zweiten, harten Scroll überlagert.
 */
export function focusCodeInput(code: HTMLInputElement, smooth: boolean): void {
  code.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  code.focus({ preventScroll: true });
  code.select();
}

/**
 * Verdrahtet den Notch-Button mit einem Click-Handler, der das
 * Code-Input fokussiert. Wenn entweder das Notch-Element oder das
 * Code-Input fehlt, wird nichts verdrahtet (no-op). Setzt die URL via
 * `history.replaceState` auf `#code`, damit die Adresszeile dem
 * scrollten Anchor folgt, ohne dass ein History-Eintrag entsteht.
 */
export function attachNotchHandler(
  notch: HTMLElement | null,
  code: HTMLInputElement | null,
): void {
  if (!notch || !code) return;
  notch.addEventListener("click", (e) => {
    e.preventDefault();
    history.replaceState(null, "", "#code");
    focusCodeInput(code, true);
  });
}
