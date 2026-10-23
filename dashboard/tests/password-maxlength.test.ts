import { describe, it, expect, afterEach, vi } from "vitest";
import { _setApiClientForTests } from "../src/api.js";
import type { RouteRenderer } from "../src/router.js";
import { renderAccount } from "../src/views/account.js";
import { renderLogin } from "../src/views/login.js";
import { renderReset } from "../src/views/reset.js";
import { renderSignup } from "../src/views/signup.js";

// The backend rejects passwords over 256 chars with 400 bad-password
// (auth/handlers.ts + account/me.ts); capping the inputs keeps a pasted
// passphrase from round-tripping into that error.
const ME = {
  id: 1,
  email: "owner@a.test",
  emailVerifiedAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
  pendingEmail: null,
  pendingEmailExpiresAt: null,
};

function makeRoot(): HTMLElement {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("password inputs cap at the backend's 256-char limit", () => {
  afterEach(() => _setApiClientForTests(null));

  it.each<[string, RouteRenderer, number]>([
    ["login", renderLogin, 1],
    ["signup", renderSignup, 1],
    ["reset", renderReset, 2],
    ["account", renderAccount, 4],
  ])("%s", async (name, render, expectedCount) => {
    _setApiClientForTests({
      base: "",
      fetch: vi.fn(async () =>
        new Response(JSON.stringify(ME), { status: 200, headers: { "content-type": "application/json" } }),
      ) as unknown as typeof fetch,
    });
    const root = makeRoot();
    render(root, {
      path: `/${name}`,
      segments: [name],
      params: { token: "tok" },
      query: new URLSearchParams(),
    });
    await new Promise((r) => setTimeout(r, 0));
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("input[type=password]"));
    expect(inputs).toHaveLength(expectedCount);
    for (const input of inputs) expect(input.maxLength).toBe(256);
  });
});
