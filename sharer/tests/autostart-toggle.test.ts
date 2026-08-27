// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { wireAutostartToggle } from "../src/autostart-toggle.js";

function harness(invokeImpl: (cmd: string) => Promise<unknown>) {
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const statusEl = document.createElement("p");
  document.body.append(checkbox, statusEl);
  const calls: string[] = [];
  const toggle = wireAutostartToggle({
    checkbox,
    statusEl,
    invoke: (cmd) => {
      calls.push(cmd);
      return invokeImpl(cmd);
    },
  });
  return { checkbox, statusEl, calls, toggle };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("wireAutostartToggle", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("sync reads is_autostart_enabled into the checkbox", async () => {
    const { checkbox, calls, toggle } = harness(async () => true);
    await toggle.sync();
    expect(calls).toEqual(["is_autostart_enabled"]);
    expect(checkbox.checked).toBe(true);
  });

  it("sync failure shows the German error and leaves the box unchecked", async () => {
    const { checkbox, statusEl, toggle } = harness(async () => {
      throw "Autostart-Status konnte nicht gelesen werden.";
    });
    await toggle.sync();
    expect(checkbox.checked).toBe(false);
    expect(statusEl.textContent).toBe("Autostart-Status konnte nicht gelesen werden.");
  });

  it("checking the box invokes enable_autostart, unchecking disable_autostart", async () => {
    const { checkbox, calls } = harness(async () => undefined);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await flush();
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));
    await flush();
    expect(calls).toEqual(["enable_autostart", "disable_autostart"]);
  });

  it("a failed enable reverts the checkbox and surfaces the German error", async () => {
    const { checkbox, statusEl } = harness(async (cmd) => {
      if (cmd === "enable_autostart") throw "Autostart konnte nicht aktiviert werden.";
      return undefined;
    });
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await flush();
    expect(checkbox.checked).toBe(false);
    expect(statusEl.textContent).toBe("Autostart konnte nicht aktiviert werden.");
  });

  it("non-string failures collapse to a generic German message", async () => {
    const { checkbox, statusEl } = harness(async () => {
      throw new Error("raw object");
    });
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await flush();
    expect(statusEl.textContent).toBe("Autostart konnte nicht geändert werden.");
  });
});
