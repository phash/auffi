import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession, type MockPC, type UiSession } from "./helpers/ui-session.js";
import { flush } from "./helpers/ui-session.js";

async function liveSession(): Promise<{ session: UiSession; pc: MockPC }> {
  const session = await startUiSession();
  const pc = await session.confirm();
  session.track(pc);
  await session.openChannels(pc);
  return { session, pc };
}

async function offer(pc: MockPC, id: string, name: string): Promise<void> {
  pc.channel("files").fakeMessage(
    JSON.stringify({ kind: "file-offer", id, name, size: 1024, mime: "text/plain" }),
  );
  await flush();
}

function fileEvents(pc: MockPC, kind: string): string[] {
  return pc
    .channel("files")
    .sentJson()
    .filter((m) => m.kind === kind)
    .map((m) => m.id as string);
}

type ListenerSpy = { mock: { calls: unknown[][] } };

/** Document-level keydown listeners currently registered by trapFocus. */
function keydownTrapListeners(add: ListenerSpy, remove: ListenerSpy): number {
  const count = (spy: ListenerSpy): number =>
    spy.mock.calls.filter((c) => c[0] === "keydown").length;
  return count(add) - count(remove);
}

describe("overlapping file offers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // The sharer never waits for file-accept before it sends the next offer,
  // so a second "Datei senden" while the helper's toast is still up used to
  // overwrite the pending resolver (first offer never answered) and leak the
  // first focus-trap's document keydown listener for the page's lifetime.
  it("shows offers one at a time and answers each of them", async () => {
    const { pc } = await liveSession();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");

    await offer(pc, "a", "erstes.txt");
    await offer(pc, "b", "zweites.txt");

    const toast = document.getElementById("file-offer-toast")!;
    const body = document.getElementById("file-offer-body")!;
    expect(toast.classList.contains("active")).toBe(true);
    expect(body.textContent).toContain("erstes.txt");
    expect(keydownTrapListeners(add, remove)).toBe(1);

    (document.getElementById("file-offer-reject") as HTMLButtonElement).click();
    await flush();
    expect(fileEvents(pc, "file-reject")).toEqual(["a"]);
    expect(toast.classList.contains("active")).toBe(true);
    expect(body.textContent).toContain("zweites.txt");
    expect(keydownTrapListeners(add, remove)).toBe(1);

    (document.getElementById("file-offer-accept") as HTMLButtonElement).click();
    await flush();
    expect(fileEvents(pc, "file-accept")).toEqual(["b"]);
    expect(toast.classList.contains("active")).toBe(false);
    expect(keydownTrapListeners(add, remove)).toBe(0);
  });

  it("does not hijack Tab on the page after overlapping offers were closed", async () => {
    const { pc } = await liveSession();
    await offer(pc, "a", "erstes.txt");
    await offer(pc, "b", "zweites.txt");
    (document.getElementById("file-offer-reject") as HTMLButtonElement).click();
    (document.getElementById("file-offer-reject") as HTMLButtonElement).click();
    await flush();

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it("teardown drains every queued offer and releases the trap", async () => {
    const { pc } = await liveSession();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    await offer(pc, "a", "erstes.txt");
    await offer(pc, "b", "zweites.txt");

    (document.getElementById("disconnect") as HTMLButtonElement).click();
    await flush();

    expect(document.getElementById("file-offer-toast")!.classList.contains("active")).toBe(false);
    expect(fileEvents(pc, "file-accept")).toEqual([]);
    expect(keydownTrapListeners(add, remove)).toBe(0);

    // A later offer on a fresh session must start from a clean queue.
    const next = await liveSession();
    await offer(next.pc, "c", "drittes.txt");
    expect(document.getElementById("file-offer-body")!.textContent).toContain("drittes.txt");
  });
});
