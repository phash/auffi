import type WebSocket from "ws";

/**
 * Deterministic replacements for "sleep, then check nothing arrived".
 *
 * The server handles one socket's frames in order and writes each socket's
 * frames in order. So after a round trip on a socket — a probe frame the
 * server answers — everything the server sent that socket for an EARLIER
 * event has already arrived. A watch must start BEFORE the event whose
 * effect is checked; frames that land before the watch exists are not seen.
 */
export interface FrameWatch {
  /** Probe the socket and resolve with every frame recorded before the answer. */
  settle(): Promise<any[]>;
}

function watch(
  ws: WebSocket,
  probe: string,
  isAnswer: (frame: any) => boolean,
): FrameWatch {
  const frames: any[] = [];
  let onAnswer: (() => void) | null = null;
  const onMessage = (data: WebSocket.RawData): void => {
    const frame = JSON.parse(data.toString());
    if (onAnswer && isAnswer(frame)) {
      ws.off("message", onMessage);
      onAnswer();
      return;
    }
    frames.push(frame);
  };
  ws.on("message", onMessage);
  return {
    settle() {
      return new Promise((resolve) => {
        onAnswer = () => resolve(frames);
        ws.send(probe);
      });
    },
  };
}

/** Ad-hoc sockets (sharer or viewer): an unparseable frame is answered with an error. */
export function watchFrames(ws: WebSocket): FrameWatch {
  return watch(
    ws,
    "not json",
    (frame) => frame.type === "error" && frame.message === "invalid JSON",
  );
}

/**
 * Unattended sharer: probe with `turn-credentials-request` — an `error` frame
 * would be a fatal disconnect for a real heartbeat, the TURN reply is not.
 */
export function watchUnattendedSharer(sharer: WebSocket): FrameWatch {
  return watch(
    sharer,
    JSON.stringify({ type: "turn-credentials-request" }),
    (frame) => frame.type === "turn-credentials",
  );
}

/** Poll `cond` (a DB row, a store entry) instead of sleeping a fixed time. */
export async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
