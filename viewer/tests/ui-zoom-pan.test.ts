import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession } from "./helpers/ui-session.js";

function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

function videoVar(name: string): string {
  return (document.getElementById("remote-video") as HTMLVideoElement).style.getPropertyValue(name);
}

async function boundWithWrapper(width: number, height: number): Promise<void> {
  await startUiSession();
  const wrapper = document.getElementById("video-wrapper")!;
  wrapper.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

describe("zoom and pan controls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts at 100 % with reset and pan disabled", async () => {
    await boundWithWrapper(800, 400);
    expect(document.getElementById("zoom-level")!.textContent).toBe("100 %");
    expect(btn("zoom-reset").disabled).toBe(true);
    expect(btn("zoom-reset").getAttribute("aria-label")).toBe("Originalgröße (100 %)");
    expect(document.getElementById("pan-overlay")!.hidden).toBe(true);
  });

  it("zoom in steps through the table and clamps at 300 %", async () => {
    await boundWithWrapper(800, 400);
    btn("zoom-in").click();
    expect(document.getElementById("zoom-level")!.textContent).toBe("125 %");
    expect(videoVar("--zoom")).toBe("1.25");
    expect(btn("zoom-reset").disabled).toBe(false);
    expect(btn("zoom-reset").getAttribute("aria-label")).toBe("Originalgröße (125 %)");
    expect(document.getElementById("pan-overlay")!.hidden).toBe(false);
    for (let i = 0; i < 6; i++) btn("zoom-in").click();
    expect(document.getElementById("zoom-level")!.textContent).toBe("300 %");
    expect(btn("zoom-in").disabled).toBe(true);
  });

  it("zoom out clamps at 50 % and keeps the pan overlay hidden", async () => {
    await boundWithWrapper(800, 400);
    btn("zoom-out").click();
    btn("zoom-out").click();
    btn("zoom-out").click();
    expect(document.getElementById("zoom-level")!.textContent).toBe("50 %");
    expect(btn("zoom-out").disabled).toBe(true);
    expect(document.getElementById("pan-overlay")!.hidden).toBe(true);
  });

  it("the D-pad moves the view a quarter of the way to the edge and reset centres it", async () => {
    await boundWithWrapper(800, 400);
    for (let i = 0; i < 3; i++) btn("zoom-in").click();
    expect(document.getElementById("zoom-level")!.textContent).toBe("200 %");
    expect(btn("pan-reset").disabled).toBe(true);

    btn("pan-right").click();
    btn("pan-down").click();
    expect(videoVar("--pan-x")).toBe("-100px");
    expect(videoVar("--pan-y")).toBe("-50px");
    expect(btn("pan-reset").disabled).toBe(false);

    btn("pan-left").click();
    btn("pan-up").click();
    expect(videoVar("--pan-x")).toBe("0px");
    expect(videoVar("--pan-y")).toBe("0px");

    btn("pan-left").click();
    btn("pan-reset").click();
    expect(videoVar("--pan-x")).toBe("0px");
    expect(btn("pan-reset").disabled).toBe(true);
  });

  it("zooming back to 100 % collapses any pan offset", async () => {
    await boundWithWrapper(800, 400);
    btn("zoom-in").click();
    btn("zoom-in").click();
    btn("pan-right").click();
    expect(videoVar("--pan-x")).not.toBe("0px");
    btn("zoom-reset").click();
    expect(document.getElementById("zoom-level")!.textContent).toBe("100 %");
    expect(videoVar("--pan-x")).toBe("0px");
    expect(document.getElementById("pan-overlay")!.hidden).toBe(true);
  });

  it("the fullscreen button requests fullscreen on the video wrapper and exits it again", async () => {
    await boundWithWrapper(800, 400);
    const wrapper = document.getElementById("video-wrapper")!;
    const request = vi.fn().mockResolvedValue(undefined);
    wrapper.requestFullscreen = request;
    btn("fullscreen-btn").click();
    expect(request).toHaveBeenCalledTimes(1);

    const exit = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => wrapper });
    document.exitFullscreen = exit;
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(btn("fullscreen-btn").getAttribute("aria-pressed")).toBe("true");
    expect(btn("fullscreen-btn").getAttribute("aria-label")).toBe("Vollbild verlassen");

    btn("fullscreen-btn").click();
    expect(exit).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(btn("fullscreen-btn").getAttribute("aria-label")).toBe("Vollbild");
  });
});
