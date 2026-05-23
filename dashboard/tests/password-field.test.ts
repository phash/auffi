import { describe, it, expect, beforeEach } from "vitest";
import { wrapPasswordField } from "../src/components/password-field.js";

function makeInput(): HTMLInputElement {
  document.body.replaceChildren();
  const input = document.createElement("input");
  input.type = "password";
  input.id = "pw";
  input.value = "secret123";
  return input;
}

describe("wrapPasswordField", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("returns a wrapper div containing the input + a button", () => {
    const input = makeInput();
    const wrap = wrapPasswordField(input);
    expect(wrap.classList.contains("password-wrap")).toBe(true);
    expect(wrap.contains(input)).toBe(true);
    expect(wrap.querySelector("button.password-toggle")).not.toBeNull();
  });

  it("preserves the input's id, name, and value so existing tests + form-auto-fill keep working", () => {
    const input = makeInput();
    input.setAttribute("name", "current_password");
    wrapPasswordField(input);
    expect(input.id).toBe("pw");
    expect(input.getAttribute("name")).toBe("current_password");
    expect(input.value).toBe("secret123");
  });

  it("starts with input.type=password + button aria-pressed=false + 'anzeigen'-label", () => {
    const input = makeInput();
    const wrap = wrapPasswordField(input);
    const btn = wrap.querySelector("button.password-toggle") as HTMLButtonElement;
    expect(input.type).toBe("password");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Passwort anzeigen");
  });

  it("button is type=button so it never accidentally submits the surrounding form", () => {
    const input = makeInput();
    const wrap = wrapPasswordField(input);
    const btn = wrap.querySelector("button.password-toggle") as HTMLButtonElement;
    expect(btn.type).toBe("button");
  });

  it("first click switches input to type=text + flips aria-pressed + 'verstecken'-label", () => {
    const input = makeInput();
    const wrap = wrapPasswordField(input);
    const btn = wrap.querySelector("button.password-toggle") as HTMLButtonElement;
    btn.click();
    expect(input.type).toBe("text");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Passwort verstecken");
  });

  it("second click toggles back to password + 'anzeigen'", () => {
    const input = makeInput();
    const wrap = wrapPasswordField(input);
    const btn = wrap.querySelector("button.password-toggle") as HTMLButtonElement;
    btn.click();
    btn.click();
    expect(input.type).toBe("password");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Passwort anzeigen");
  });

  it("swaps the SVG icon between open-eye and slashed-eye on toggle (slash line present only when visible)", () => {
    const input = makeInput();
    const wrap = wrapPasswordField(input);
    const btn = wrap.querySelector("button.password-toggle") as HTMLButtonElement;
    // Hidden state — no slash line in the SVG.
    expect(btn.querySelector("svg line")).toBeNull();
    btn.click();
    // Visible state — slash line present.
    expect(btn.querySelector("svg line")).not.toBeNull();
    btn.click();
    expect(btn.querySelector("svg line")).toBeNull();
  });

  it("does not duplicate or detach the input on multiple toggles (DOM identity stable)", () => {
    const input = makeInput();
    const wrap = wrapPasswordField(input);
    const btn = wrap.querySelector("button.password-toggle") as HTMLButtonElement;
    document.body.appendChild(wrap);
    // Reference must stay live across many toggles.
    for (let i = 0; i < 5; i++) btn.click();
    expect(document.getElementById("pw")).toBe(input);
    expect(input.parentElement).toBe(wrap);
  });
});
