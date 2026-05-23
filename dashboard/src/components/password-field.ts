// gh frontend-design — Reusable password-field with eye-toggle.
//
// Wraps an existing `<input type="password">` in a div, appends an
// absolute-positioned "Eye"-Button that toggles input.type between
// "password" and "text". The button never submits a form (type=
// "button"); aria-label + aria-pressed reflect the current state so
// screen-readers announce the action correctly.
//
// Why a wrapper-helper instead of a custom-element: existing tests +
// view code rely on `document.getElementById(inputId)` returning the
// same DOM-node. We preserve that — the input's id, name, and DOM
// identity are unchanged; only its containing element changes (input
// gains a parent <div class="password-wrap">).
//
// Usage:
//   const input = document.createElement("input");
//   input.type = "password"; input.id = "pw";
//   const wrap = wrapPasswordField(input);
//   form.appendChild(wrap);          // append wrap, NOT input
//
//   // input.value / input.id still work as before.
//   // Toggle: user clicks the eye — input.type flips to "text".

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Build an SVG eye icon. `slashed=true` renders the icon with a
 * diagonal slash overlay (= password is currently visible, click
 * to hide). `slashed=false` is the open eye (= password hidden,
 * click to reveal).
 *
 * Stroked, currentColor — picks up the surrounding button color.
 */
function makeEyeIcon(slashed: boolean): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  // Eye outline: lens (ellipse) + pupil (circle).
  const lens = document.createElementNS(SVG_NS, "path");
  lens.setAttribute("d", "M1.5 12s4-7 10.5-7 10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z");
  svg.appendChild(lens);

  const pupil = document.createElementNS(SVG_NS, "circle");
  pupil.setAttribute("cx", "12");
  pupil.setAttribute("cy", "12");
  pupil.setAttribute("r", "3");
  svg.appendChild(pupil);

  if (slashed) {
    const slash = document.createElementNS(SVG_NS, "line");
    slash.setAttribute("x1", "3");
    slash.setAttribute("y1", "3");
    slash.setAttribute("x2", "21");
    slash.setAttribute("y2", "21");
    svg.appendChild(slash);
  }
  return svg;
}

/**
 * Wrap a password input in a `.password-wrap` div with an
 * absolute-positioned eye-toggle button on the right.
 *
 * Returns the wrapper. Callers should append the WRAPPER (not the
 * raw input) to the containing form/section.
 */
export function wrapPasswordField(input: HTMLInputElement): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "password-wrap";
  wrap.appendChild(input);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "password-toggle";
  btn.setAttribute("aria-label", "Passwort anzeigen");
  btn.setAttribute("aria-pressed", "false");
  // Initial icon = open eye (password hidden, click to reveal).
  btn.appendChild(makeEyeIcon(false));

  btn.addEventListener("click", () => {
    const showing = input.type === "text";
    if (showing) {
      input.type = "password";
      btn.setAttribute("aria-label", "Passwort anzeigen");
      btn.setAttribute("aria-pressed", "false");
    } else {
      input.type = "text";
      btn.setAttribute("aria-label", "Passwort verstecken");
      btn.setAttribute("aria-pressed", "true");
    }
    // Swap icon — replace child with the right glyph.
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.appendChild(makeEyeIcon(!showing));
  });

  wrap.appendChild(btn);
  return wrap;
}
