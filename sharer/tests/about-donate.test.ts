// @vitest-environment jsdom
//
// The Info tab offers both donation links. They open through the Tauri
// opener, whose URL scope (capabilities/default.json) blocks anything not
// listed — main.ts swallows that rejection, so a missing scope entry would
// make the button silently do nothing. The Rust test
// webview_may_open_exactly_the_links_it_uses_and_nothing_via_shell pins the
// scope; this test pins what the buttons ask for.
import { describe, it, expect, vi } from "vitest";
import html from "../index.html?raw";

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    Promise.resolve(
      ({
        unattended_get_mode: "adhoc",
        list_monitors: [],
        check_for_update: { available: false, latest: "", download_url: "" },
      } as Record<string, unknown>)[cmd],
    ),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () => Promise.resolve({ get: () => Promise.resolve(undefined), set: () => Promise.resolve() }),
}));

describe("Info tab donations", () => {
  it("offers Buy me a coffee and PayPal and opens the exact URLs", async () => {
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"));
    await import("../src/main.js");
    const about = document.getElementById("panel-about")!;
    const bmc = about.querySelector<HTMLButtonElement>("#bmc-btn");
    const paypal = about.querySelector<HTMLButtonElement>("#paypal-btn");
    expect(bmc).not.toBeNull();
    expect(paypal).not.toBeNull();

    bmc!.click();
    paypal!.click();
    expect(openUrlMock.mock.calls).toEqual([
      ["https://buymeacoffee.com/phash"],
      ["https://www.paypal.com/paypalme/mroedig"],
    ]);
  });

  it("shows the agreed donation text", () => {
    const text = document.querySelector("#panel-about .about-donate-text")?.textContent?.replace(/\s+/g, " ").trim();
    expect(text).toBe(
      "Server, Relay und Domain zahlt ein einzelner Entwickler. Wenn Auffi dir geholfen hat, freut sich das Projekt über einen Kaffee.",
    );
  });
});
