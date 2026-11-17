import { describe, it, expect, vi, afterEach } from "vitest";
import { startUiSession, flush } from "./helpers/ui-session.js";

const CREDS = { urls: ["turn:relay.example"], username: "u", credential: "c" };

function turnResponse(ok: boolean): unknown {
  return { ok, status: ok ? 200 : 403, json: () => Promise.resolve(ok ? CREDS : { error: "no active session" }) };
}

function stubTurnFetch(...answers: boolean[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const ok of answers) fetchMock.mockResolvedValueOnce(turnResponse(ok));
  fetchMock.mockResolvedValue(turnResponse(false));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function turnCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/turn-credentials"));
}

// gh #149: the backend issues a device id's TURN credentials only once a
// password verified, so the viewer's pre-join fetch finds nothing on the
// unattended path and the relay has to be fetched again after peer-confirmed.
describe("unattended TURN credentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the relay again after the password verified and offers with it", async () => {
    const { ws, confirm } = await startUiSession();
    const fetchMock = stubTurnFetch(true);
    ws.fakeMessage({ type: "needs-password" });
    const input = document.getElementById("pw-prompt-input") as HTMLInputElement;
    input.value = "geheim";
    (document.getElementById("pw-prompt-submit") as HTMLButtonElement).click();

    const pc = await confirm("tok-152");

    expect(turnCalls(fetchMock)).toHaveLength(1);
    const [, init] = turnCalls(fetchMock)[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({ code: "123-456-789", turnToken: "tok-152" });
    expect(pc.config.iceServers).toEqual([{ urls: "turn:relay.example", username: "u", credential: "c" }]);
    await flush();
    expect(ws.sentOfType("relay")).toHaveLength(1);
  });

  it("still offers STUN-less when the post-confirm fetch fails", async () => {
    const { ws, confirm } = await startUiSession();
    stubTurnFetch(false);
    ws.fakeMessage({ type: "needs-password" });

    const pc = await confirm();

    expect(pc.config.iceServers).toEqual([]);
    await flush();
    expect(ws.sentOfType("relay")).toHaveLength(1);
  });

  it("an ad-hoc code keeps its pre-join credentials and fetches only once", async () => {
    const { confirm } = await startUiSession();
    const fetchMock = stubTurnFetch();

    const pc = await confirm();

    expect(turnCalls(fetchMock)).toHaveLength(0);
    expect(pc.config.iceServers).toEqual([{ urls: "turn:relay.example", username: "u", credential: "c" }]);
  });
});
