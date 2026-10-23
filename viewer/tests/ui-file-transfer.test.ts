import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { startUiSession, flush, type MockPC } from "./helpers/ui-session.js";

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function chunk(id: string, seq: number, payload: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(8 + payload.length);
  const view = new DataView(buf);
  view.setUint32(0, fnv1a32(id), true);
  view.setUint32(4, seq, true);
  new Uint8Array(buf, 8).set(payload);
  return buf;
}

async function liveSession(): Promise<MockPC> {
  const session = await startUiSession();
  const pc = await session.confirm();
  session.track(pc);
  (document.getElementById("remote-video") as HTMLVideoElement).dispatchEvent(new Event("playing"));
  await session.openChannels(pc);
  return pc;
}

function rows(): string[] {
  return Array.from(document.querySelectorAll(".file-status-row")).map((r) => r.textContent ?? "");
}

function sentOffer(pc: MockPC): { id: string; name: string } {
  const offer = pc.channel("files").sentJson().find((m) => m.kind === "file-offer");
  if (!offer) throw new Error("no file-offer sent");
  return { id: offer.id as string, name: offer.name as string };
}

describe("file transfer feedback in the viewer", () => {
  let anchorClicks: HTMLAnchorElement[];

  beforeEach(() => {
    anchorClicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      anchorClicks.push(this);
    });
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function receive(pc: MockPC, id: string, name: string, bytes: number[]): Promise<void> {
    const files = pc.channel("files");
    files.fakeMessage(JSON.stringify({ kind: "file-offer", id, name, size: bytes.length, mime: "text/plain" }));
    await flush();
    (document.getElementById("file-offer-accept") as HTMLButtonElement).click();
    await flush();
    files.fakeMessage(chunk(id, 0, bytes));
    files.fakeMessage(JSON.stringify({ kind: "file-done", id }));
    await flush();
  }

  it("a received file waits for Speichern instead of downloading on its own", async () => {
    const pc = await liveSession();
    await receive(pc, "r1", "notiz.txt", [104, 105]);

    expect(anchorClicks).toHaveLength(0);
    expect(rows()).toEqual([expect.stringContaining("„notiz.txt“ ist angekommen.")]);

    document.querySelector<HTMLButtonElement>(".file-status-save")!.click();
    expect(anchorClicks).toHaveLength(1);
    expect(anchorClicks[0].download).toBe("notiz.txt");
    expect(anchorClicks[0].href).toBe("blob:fake");
    expect(rows()).toEqual([]);
  });

  it("an unsaved received file can still be saved after the session ended", async () => {
    const pc = await liveSession();
    await receive(pc, "r1", "notiz.txt", [104, 105]);
    (document.getElementById("disconnect") as HTMLButtonElement).click();
    await flush();

    expect(rows()).toEqual([expect.stringContaining("notiz.txt")]);
    document.querySelector<HTMLButtonElement>(".file-status-save")!.click();
    expect(anchorClicks).toHaveLength(1);
  });

  it("an incomplete receive is reported and answered with file-error", async () => {
    const pc = await liveSession();
    const files = pc.channel("files");
    files.fakeMessage(JSON.stringify({ kind: "file-offer", id: "r2", name: "halb.txt", size: 10, mime: "text/plain" }));
    await flush();
    (document.getElementById("file-offer-accept") as HTMLButtonElement).click();
    await flush();
    files.fakeMessage(chunk("r2", 0, [1, 2, 3]));
    files.fakeMessage(JSON.stringify({ kind: "file-done", id: "r2" }));
    await flush();

    expect(rows()).toEqual([expect.stringContaining("Übertragung von „halb.txt“ fehlgeschlagen.")]);
    expect(files.sentJson()).toContainEqual({ kind: "file-error", id: "r2", message: "incomplete-transfer" });
  });

  it("sending via the picker shows waiting, then the other side's rejection", async () => {
    const pc = await liveSession();
    const input = document.getElementById("file-input") as HTMLInputElement;
    const pick = vi.spyOn(input, "click").mockImplementation(() => {});
    (document.getElementById("file-send-btn") as HTMLButtonElement).click();
    expect(pick).toHaveBeenCalledTimes(1);

    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File([new Uint8Array([1, 2, 3])], "rechnung.pdf")],
    });
    input.dispatchEvent(new Event("change"));
    await flush();

    const offer = sentOffer(pc);
    expect(offer.name).toBe("rechnung.pdf");
    expect(rows()).toEqual([expect.stringContaining("wartet auf Annahme")]);

    pc.channel("files").fakeMessage(JSON.stringify({ kind: "file-reject", id: offer.id }));
    await flush();
    expect(rows()).toEqual([expect.stringContaining("„rechnung.pdf“ wurde von der anderen Seite abgelehnt.")]);
  });

  it("a file dropped on the video is offered, streamed after accept and reported as sent", async () => {
    const pc = await liveSession();
    const wrapper = document.getElementById("video-wrapper")!;

    const over = new Event("dragover", { cancelable: true });
    wrapper.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(wrapper.classList.contains("drop-over")).toBe(true);
    wrapper.dispatchEvent(new Event("dragleave"));
    expect(wrapper.classList.contains("drop-over")).toBe(false);

    const drop = new Event("drop", { cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { files: [new File([new Uint8Array([9, 8, 7])], "bild.png")], types: ["Files"] },
    });
    wrapper.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    await flush();

    const offer = sentOffer(pc);
    expect(offer.name).toBe("bild.png");
    pc.channel("files").fakeMessage(JSON.stringify({ kind: "file-accept", id: offer.id }));
    await vi.waitFor(() => {
      expect(rows()).toEqual([expect.stringContaining("„bild.png“ wurde gesendet.")]);
    });
    const binary = pc.channel("files").sent.filter((d) => d instanceof ArrayBuffer);
    expect(binary).toHaveLength(1);
    expect(pc.channel("files").sentJson().at(-1)).toEqual({ kind: "file-done", id: offer.id });
  });

  it("a send cut off by Beenden leaves no stale 'fehlgeschlagen' notice behind", async () => {
    const pc = await liveSession();
    const input = document.getElementById("file-input") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File([new Uint8Array([1])], "a.txt")],
    });
    input.dispatchEvent(new Event("change"));
    await flush();
    expect(sentOffer(pc).name).toBe("a.txt");

    (document.getElementById("disconnect") as HTMLButtonElement).click();
    await flush();
    expect(rows()).toEqual([]);
  });
});
