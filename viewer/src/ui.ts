import { SignalingClient } from "./signaling-client.js";
import { ViewerPeer } from "./webrtc-client.js";
import type { ConnectionType } from "./webrtc-client.js";
import type { RelayBye, RelayIce, RelaySdp } from "./protocol.js";
import { fetchIceServers } from "./turn-config.js";
import { createConnectionTypeHandler } from "./connection-type-handler.js";
import { InputCapture } from "./input-capture.js";
import { FileTransferManager } from "./file-transfer.js";
import type { FileOffer } from "./file-transfer.js";
import { DEFAULT_ZOOM, ZOOM_STEPS, formatZoom, nextZoomLevel } from "./zoom.js";
import { ZERO_PAN, clampPan, stepPan, type PanState } from "./pan.js";
import { createIceStateHandler } from "./ice-state-handler.js";
import { CompactBarController } from "./compact-bar.js";
import { friendlyJoinError, connectTimeoutMessage } from "./connect-messages.js";
import { trapFocus } from "./focus-trap.js";
import { t } from "./i18n.js";
import type { StatusKind } from "./status-kind.js";

// gh #40: lazy singleton — initialized in setupUi() once the DOM is
// ready. Module-level so setVideoStream() (also module-level) can
// reach it without the closure dance.
let compactBar: CompactBarController | null = null;
import {
  SessionTracker,
  formatConnectionType,
  formatDuration,
} from "./session-summary.js";
import { formatBytes } from "./format.js";

// Backstop timeouts so the connect flow never dead-ends in a spinner. The
// visible Abbrechen button is the primary escape; these fire only if the user
// walks away. CONFIRM covers "waiting for the sharer to click Akzeptieren";
// MEDIA covers "confirmed, but no decoded frame arrives" (e.g. P2P blocked and
// no reachable TURN relay — surfaced as a firewall hint, see connectTimeoutMessage).
export const CONNECT_CONFIRM_TIMEOUT_MS = 60_000;
export const CONNECT_MEDIA_TIMEOUT_MS = 30_000;

function setStatus(text: string, kind: StatusKind): void {
  const el = document.getElementById("status")!;
  el.textContent = text;
  el.className = kind;
}

/**
 * Strip non-digits and reformat as `NNN-NNN-NNN` (max 9 digits).
 * Pure helper, also used by the gh #37 ?code=... prefill so the
 * dashboard can link with smart-dashes, spaces, or all kinds of
 * paste-artefacts and we'll normalise.
 */
export function normaliseCodeInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 9);
  const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(
    (s) => s.length > 0,
  );
  return parts.join("-");
}

/**
 * gh #37: extract a session code from the URL query string, if any.
 * Returns the normalised `NNN-NNN-NNN` form or `null` if no `?code`
 * was present / the input couldn't be reduced to 9 digits.
 * Pure on the input — the caller passes the live string for jsdom
 * test injection.
 */
export function codeFromQuery(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get("code");
  if (raw === null) return null;
  const normalised = normaliseCodeInput(raw);
  // Require the full 9-digit form. Partial / garbage prefills
  // would leave a confusingly-half-filled field for the user.
  if (!/^\d{3}-\d{3}-\d{3}$/.test(normalised)) return null;
  return normalised;
}

function applyCodePrefill(input: HTMLInputElement): void {
  if (input.value.length > 0) return; // user typed something first
  const code = codeFromQuery(window.location.search);
  if (code === null) return;
  input.value = code;
}

function setConnectionType(type: ConnectionType | null): void {
  const el = document.getElementById("connection-type")!;
  if (type === null) {
    el.textContent = "";
    el.className = "";
    return;
  }
  el.classList.add("active");
  if (type === "relay") {
    el.textContent = t("conn.relay");
    el.classList.add("relay");
    el.classList.remove("p2p");
  } else {
    el.textContent = t("conn.direct");
    el.classList.remove("relay");
    el.classList.add("p2p");
  }
}

type VideoElementWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

function setVideoStream(stream: MediaStream | null, onFirstFrame?: () => void): void {
  const video = document.getElementById("remote-video") as VideoElementWithFrameCallback;
  const wrapper = document.getElementById("video-wrapper")!;
  const disconnect = document.getElementById("disconnect")!;
  const toolbar = document.getElementById("video-toolbar")!;
  const controls = document.getElementById("video-controls");
  const inputGroup = document.querySelector<HTMLElement>(".input-group")!;
  const instruction = document.querySelector<HTMLElement>(".instruction")!;
  const app = document.getElementById("app")!;

  if (stream) {
    video.srcObject = stream;
    video.classList.add("active");
    wrapper.classList.add("active");
    // Show the "Verbindung wird hergestellt …" overlay until the first
    // decoded frame arrives. WebRTC ICE/DTLS handshake completes before
    // any media is actually decoded, so the gap can be a few seconds.
    wrapper.classList.add("awaiting-frames");
    disconnect.classList.add("active");
    toolbar.classList.add("active");
    controls?.classList.add("active");
    inputGroup.classList.add("hidden");
    instruction.classList.add("hidden");
    app.classList.add("streaming");
    // gh #38 — mirror the streaming flag onto <body> so the
    // landing-sections (news + trust) can be hidden via CSS while
    // the video is in the foreground.
    document.body.classList.add("streaming");
    // gh #40: Compact-Bar starten (Duration-Timer + Bytes-Poll).
    compactBar?.start();
    compactBar?.setStatus(t("status.connecting"));
    // Prevent any user-initiated PiP from auto-detaching the video.
    if ("disablePictureInPicture" in video) {
      (video as HTMLVideoElement & { disablePictureInPicture: boolean }).disablePictureInPicture = true;
    }

    const clearOverlay = (): void => {
      wrapper.classList.remove("awaiting-frames");
      // gh #82: green-dot status only after the first composited frame.
      // Until then the page reads "Verbunden — empfange Stream…" in info
      // (blue) so the spinner overlay and status colour agree.
      setStatus(t("status.streamRunning"), "ok");
      compactBar?.setStatus(t("status.streamRunning"));
      onFirstFrame?.();
    };

    // Prefer requestVideoFrameCallback — fires exactly when the first
    // composited frame is ready. Falls back to `playing` for browsers
    // without it (Firefox < 132). `playing` can fire before the very
    // first frame is painted, but the gap is imperceptible.
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => clearOverlay());
    } else {
      video.addEventListener("playing", clearOverlay, { once: true });
    }
  } else {
    video.srcObject = null;
    video.classList.remove("active");
    wrapper.classList.remove("active");
    wrapper.classList.remove("awaiting-frames");
    disconnect.classList.remove("active");
    toolbar.classList.remove("active");
    controls?.classList.remove("active");
    inputGroup.classList.remove("hidden");
    instruction.classList.remove("hidden");
    app.classList.remove("streaming");
    document.body.classList.remove("streaming");
    compactBar?.stop();
  }
}

function setInputTogglePressed(btn: HTMLButtonElement, pressed: boolean): void {
  btn.setAttribute("aria-pressed", String(pressed));
  const label = btn.querySelector<HTMLElement>("#input-toggle-label")!;
  label.textContent = pressed
    ? t("input.controlActive")
    : t("input.controlEnable");
}

function wsUrlToHttpUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/signal$/, "");
}

function showFreeTierWarning(): void {
  const el = document.getElementById("free-tier-warning-toast");
  if (el) el.classList.add("active");
}

function hideFreeTierWarning(): void {
  const el = document.getElementById("free-tier-warning-toast");
  if (el) el.classList.remove("active");
}

export function bindUI(backendWsUrl: string): void {
  const codeInput = document.getElementById("code") as HTMLInputElement;
  const connectBtn = document.getElementById("connect") as HTMLButtonElement;
  const disconnectBtn = document.getElementById("disconnect") as HTMLButtonElement;
  const cancelConnectBtn = document.getElementById("cancel-connect") as HTMLButtonElement | null;
  const inputToggleBtn = document.getElementById("input-toggle") as HTMLButtonElement;
  const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement | null;
  const reconnectWrap = document.getElementById("reconnect-wrap") as HTMLElement | null;
  const reconnectBtn = document.getElementById("reconnect-btn") as HTMLButtonElement | null;

  const fileSendBtn = document.getElementById("file-send-btn") as HTMLButtonElement;
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const fileOfferToast = document.getElementById("file-offer-toast")!;
  const fileOfferBody = document.getElementById("file-offer-body")!;
  const fileOfferAccept = document.getElementById("file-offer-accept") as HTMLButtonElement;
  const fileOfferReject = document.getElementById("file-offer-reject") as HTMLButtonElement;
  const videoWrapper = document.getElementById("video-wrapper")!;
  const zoomInBtn = document.getElementById("zoom-in") as HTMLButtonElement | null;
  const zoomOutBtn = document.getElementById("zoom-out") as HTMLButtonElement | null;
  const zoomResetBtn = document.getElementById("zoom-reset") as HTMLButtonElement | null;
  const zoomLevelLabel = document.getElementById("zoom-level");
  const fullscreenBtn = document.getElementById("fullscreen-btn") as HTMLButtonElement | null;
  const panOverlay = document.getElementById("pan-overlay");
  const panUpBtn = document.getElementById("pan-up") as HTMLButtonElement | null;
  const panDownBtn = document.getElementById("pan-down") as HTMLButtonElement | null;
  const panLeftBtn = document.getElementById("pan-left") as HTMLButtonElement | null;
  const panRightBtn = document.getElementById("pan-right") as HTMLButtonElement | null;
  const panResetBtn = document.getElementById("pan-reset") as HTMLButtonElement | null;

  let currentZoom = DEFAULT_ZOOM;
  let currentPan: PanState = ZERO_PAN;

  function applyZoom(): void {
    const remote = document.getElementById("remote-video") as HTMLVideoElement | null;
    if (!remote) return;
    // Re-clamp pan so a previous offset at higher zoom collapses cleanly
    // when the user zooms back out (gh #98). At zoom=1 this snaps to (0,0).
    const wrapperRect = videoWrapper.getBoundingClientRect();
    currentPan = clampPan(currentPan, currentZoom, wrapperRect.width, wrapperRect.height);
    remote.style.setProperty("--zoom", String(currentZoom));
    // Translate the video by -pan so positive pan = viewport-shifted-right.
    remote.style.setProperty("--pan-x", `${-currentPan.panX}px`);
    remote.style.setProperty("--pan-y", `${-currentPan.panY}px`);
    if (zoomLevelLabel) zoomLevelLabel.textContent = formatZoom(currentZoom);
    if (zoomInBtn) zoomInBtn.disabled = currentZoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
    if (zoomOutBtn) zoomOutBtn.disabled = currentZoom <= ZOOM_STEPS[0];
    if (zoomResetBtn) {
      zoomResetBtn.disabled = currentZoom === DEFAULT_ZOOM;
      // Screen-reader announcement should match the visible zoom level
      // (gh #76). Without this update, NVDA / VoiceOver still announce
      // "Originalgröße (100 %)" while the button visibly reads 150 %.
      zoomResetBtn.setAttribute("aria-label", t("zoom.resetAria", { zoom: formatZoom(currentZoom) }));
    }
    if (panOverlay) {
      const showPan = currentZoom > 1;
      if (showPan) panOverlay.removeAttribute("hidden");
      else panOverlay.setAttribute("hidden", "");
      if (panResetBtn)
        panResetBtn.disabled = currentPan.panX === 0 && currentPan.panY === 0;
    }
  }

  function resetZoom(): void {
    currentZoom = DEFAULT_ZOOM;
    currentPan = ZERO_PAN;
    applyZoom();
  }

  function pan(dirX: -1 | 0 | 1, dirY: -1 | 0 | 1): void {
    const wrapperRect = videoWrapper.getBoundingClientRect();
    currentPan = stepPan(
      currentPan,
      currentZoom,
      wrapperRect.width,
      wrapperRect.height,
      dirX,
      dirY,
    );
    applyZoom();
  }

  zoomInBtn?.addEventListener("click", () => {
    currentZoom = nextZoomLevel(currentZoom, "in");
    applyZoom();
  });

  zoomOutBtn?.addEventListener("click", () => {
    currentZoom = nextZoomLevel(currentZoom, "out");
    applyZoom();
  });

  zoomResetBtn?.addEventListener("click", () => {
    resetZoom();
  });

  panUpBtn?.addEventListener("click", () => pan(0, -1));
  panDownBtn?.addEventListener("click", () => pan(0, 1));
  panLeftBtn?.addEventListener("click", () => pan(-1, 0));
  panRightBtn?.addEventListener("click", () => pan(1, 0));
  panResetBtn?.addEventListener("click", () => {
    currentPan = ZERO_PAN;
    applyZoom();
  });

  function toggleFullscreen(): void {
    const root = document.getElementById("video-wrapper");
    if (!root) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      const req = root.requestFullscreen?.bind(root);
      if (req) void req();
    }
  }

  fullscreenBtn?.addEventListener("click", () => {
    toggleFullscreen();
  });

  // gh #75: 'f' toggles fullscreen while a stream is active. Ignored when
  // the user is typing in a text field so it doesn't hijack the code input,
  // and while Steuerung is active: InputCapture binds on the video, forwards
  // every key to the remote machine and lets the event bubble here, so an
  // 'f' typed over there would also flip the local viewer's fullscreen. The
  // toolbar button stays available for fullscreen while controlling.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "f" && e.key !== "F") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.defaultPrevented) return;
    if (inputToggleBtn.getAttribute("aria-pressed") === "true") return;
    const target = e.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
    }
    const wrapper = document.getElementById("video-wrapper");
    if (!wrapper?.classList.contains("active")) return;
    e.preventDefault();
    toggleFullscreen();
  });

  document.addEventListener("fullscreenchange", () => {
    if (!fullscreenBtn) return;
    fullscreenBtn.setAttribute("aria-pressed", String(!!document.fullscreenElement));
    fullscreenBtn.title = document.fullscreenElement ? t("fullscreen.exit") : t("fullscreen.enter");
    fullscreenBtn.setAttribute(
      "aria-label",
      document.fullscreenElement ? t("fullscreen.exit") : t("fullscreen.enter"),
    );
  });

  applyZoom();

  let signaling: SignalingClient | null = null;
  let peer: ViewerPeer | null = null;
  // gh #40: Initialize the module-level compact-bar singleton with a
  // closure that reads the current `peer`. The Controller doesn't
  // know about WebRTC — it just polls getBytes() once per second.
  compactBar = new CompactBarController({
    app: document.getElementById("app")!,
    toggle: document.getElementById("card-toggle") as HTMLButtonElement,
    durationEl: document.getElementById("compact-duration")!,
    bytesEl: document.getElementById("compact-bytes")!,
    statusTextEl: document.getElementById("compact-status-text")!,
    getBytes: async () => (peer ? await peer.getInboundBytes() : 0),
  });
  let capture: InputCapture | null = null;
  let fileManager: FileTransferManager | null = null;
  let lastCode: string | null = null;
  let manualDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const MANUAL_DISCONNECT_RECONNECT_WINDOW_MS = 30_000;

  function clearManualDisconnectTimer(): void {
    if (manualDisconnectTimer !== null) {
      clearTimeout(manualDisconnectTimer);
      manualDisconnectTimer = null;
    }
  }

  // Backstop timer for the connect phase (see CONNECT_*_TIMEOUT_MS). Cleared
  // once the first frame arrives, on teardown, and while we're waiting on the
  // human (password prompt).
  let connectTimeout: ReturnType<typeof setTimeout> | null = null;

  // Bumped on every doConnect and every teardown. The async fetchIceServers()
  // continuation captures its generation and bails if it's stale — otherwise a
  // cancel/teardown that fires while the TURN-credentials fetch is in flight
  // would be undone when the late `.then` re-creates the peer + WS.
  let connectGeneration = 0;

  function clearConnectTimeout(): void {
    if (connectTimeout !== null) {
      clearTimeout(connectTimeout);
      connectTimeout = null;
    }
  }

  function showConnectingControls(): void {
    if (cancelConnectBtn) cancelConnectBtn.hidden = false;
  }

  function hideConnectingControls(): void {
    if (cancelConnectBtn) cancelConnectBtn.hidden = true;
  }

  // Session-summary tracker (gh #73). Reset whenever a new session begins.
  let sessionTracker = new SessionTracker();
  let sessionSummaryDismissTimer: ReturnType<typeof setTimeout> | null = null;
  const SESSION_SUMMARY_AUTO_DISMISS_MS = 30_000;

  function clearSessionSummaryTimer(): void {
    if (sessionSummaryDismissTimer !== null) {
      clearTimeout(sessionSummaryDismissTimer);
      sessionSummaryDismissTimer = null;
    }
  }

  const sessionSummaryEl = document.getElementById("session-summary") as HTMLElement | null;
  const sessionSummaryDurationEl = document.getElementById("session-summary-duration");
  const sessionSummaryConnEl = document.getElementById("session-summary-conn");
  const sessionSummaryFilesWrap = document.getElementById("session-summary-files-wrap");
  const sessionSummaryFilesEl = document.getElementById("session-summary-files");
  const sessionSummaryCloseBtn = document.getElementById("session-summary-close") as HTMLButtonElement | null;

  function hideSessionSummary(): void {
    clearSessionSummaryTimer();
    if (sessionSummaryEl) sessionSummaryEl.hidden = true;
  }

  function renderSessionSummary(): void {
    if (!sessionSummaryEl) return;
    const summary = sessionTracker.summary();
    if (!summary) return;
    if (sessionSummaryDurationEl) {
      sessionSummaryDurationEl.textContent = formatDuration(summary.durationMs);
    }
    if (sessionSummaryConnEl) {
      sessionSummaryConnEl.textContent = formatConnectionType(summary.connectionType);
    }
    if (sessionSummaryFilesWrap && sessionSummaryFilesEl) {
      if (summary.receivedFiles.length === 0) {
        sessionSummaryFilesWrap.hidden = true;
      } else {
        sessionSummaryFilesWrap.hidden = false;
        const ul = document.createElement("ul");
        ul.className = "session-summary-files-list";
        for (const f of summary.receivedFiles) {
          const li = document.createElement("li");
          li.textContent = `${f.name} — ${formatBytes(f.size)}`;
          ul.appendChild(li);
        }
        sessionSummaryFilesEl.replaceChildren(ul);
      }
    }
    sessionSummaryEl.hidden = false;
    clearSessionSummaryTimer();
    sessionSummaryDismissTimer = setTimeout(() => {
      hideSessionSummary();
    }, SESSION_SUMMARY_AUTO_DISMISS_MS);
  }

  sessionSummaryCloseBtn?.addEventListener("click", () => hideSessionSummary());

  // Detached, unit-testable handler for ICE-state events (see #74).
  const iceState = createIceStateHandler({
    teardown: (reason, kind, canReconnect) => teardown(reason, kind, canReconnect),
    // Mirror into the compact bar: while streaming, #status is hidden inside
    // the collapsed card and the compact line is the only status visible.
    setStatus: (text, kind) => {
      setStatus(text, kind);
      compactBar?.setStatus(text);
    },
  });
  const clearIceGraceTimer = (): void => iceState.clear();

  // Detached, unit-testable handler for relay ⇄ p2p switches: owns the
  // free-tier timer so a relay→p2p switch stops the cutoff (and clears the
  // warning), and a relay re-entry can never leak a replaced timer whose
  // onCutoff would kill a later session.
  const connectionTypeHandler = createConnectionTypeHandler({
    onWarning: () => showFreeTierWarning(),
    onCutoff: () => teardown(t("teardown.relayLimit"), "info"),
    onLeftRelay: () => hideFreeTierWarning(),
  });

  // The sharer sends the next file-offer without waiting for our answer to
  // the previous one, so offers are shown one at a time from a FIFO. A bare
  // "current offer" slot would drop the earlier resolver (that offer is
  // never answered) and leak its focus-trap's document keydown listener,
  // which then hijacks Tab on the whole page.
  const offerQueue: Array<{ offer: FileOffer; resolve: (accepted: boolean) => void }> = [];
  let fileOfferTrapRelease: (() => void) | null = null;

  const showNextOffer = (): void => {
    const next = offerQueue[0];
    if (!next) {
      fileOfferToast.classList.remove("active");
      return;
    }
    const sizeMb = (next.offer.size / (1024 * 1024)).toFixed(2);
    fileOfferBody.textContent = `"${next.offer.name}" (${sizeMb} MB)`;
    fileOfferToast.classList.add("active");
    // Confine Tab to the dialog (it declares aria-modal) and make Escape
    // reject the offer. Focus the safe default (reject).
    fileOfferTrapRelease = trapFocus(fileOfferToast, () => closeFileOffer(false));
    fileOfferReject.focus();
  };

  // Answer the offer on screen, release its focus-trap and move on to the
  // next queued one. Used by the accept/reject buttons and the Escape key.
  // The old trap is released BEFORE the next one is installed so the next
  // trap's "previously focused" element is the page, not a toast button.
  const closeFileOffer = (accepted: boolean): void => {
    fileOfferTrapRelease?.();
    fileOfferTrapRelease = null;
    offerQueue.shift()?.resolve(accepted);
    showNextOffer();
  };

  // Teardown: reject everything still queued, not just the visible offer.
  const rejectAllOffers = (): void => {
    fileOfferTrapRelease?.();
    fileOfferTrapRelease = null;
    for (const entry of offerQueue.splice(0)) entry.resolve(false);
    fileOfferToast.classList.remove("active");
  };

  const escapeHandler = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && inputToggleBtn.getAttribute("aria-pressed") === "true") {
      capture?.disable();
      setInputTogglePressed(inputToggleBtn, false);
    }
  };

  // gh #36: unattended-mode password prompt. Hoisted to bindUI level
  // (mirroring closeFileOffer) so the generic teardown() can close the modal
  // and release its focus trap — otherwise a cancel/timeout while the prompt
  // is open leaves a password dialog for a session that no longer exists.
  // Only submitPw lives in doConnect: it needs the per-connect backstop.
  const pwToast = document.getElementById("pw-prompt-toast");
  const pwInput = document.getElementById("pw-prompt-input") as HTMLInputElement | null;
  const pwSubmit = document.getElementById("pw-prompt-submit") as HTMLButtonElement | null;
  const pwCancel = document.getElementById("pw-prompt-cancel") as HTMLButtonElement | null;
  const pwMessage = document.getElementById("pw-prompt-message");
  // The pw-prompt scaffolding lives in index.html and is missing only in
  // test-DOM stubs. In production all five are present; guarding makes the
  // existing test fixtures keep working without every one of them having to
  // be updated.
  const havePwPrompt = !!(pwToast && pwInput && pwSubmit && pwCancel && pwMessage);
  let pwTrapRelease: (() => void) | null = null;
  const showPwPrompt = (text: string, wrong: boolean): void => {
    if (!havePwPrompt) return;
    pwMessage!.textContent = text;
    pwMessage!.classList.toggle("wrong", wrong);
    pwInput!.value = "";
    pwToast!.classList.add("active");
    pwSubmit!.disabled = false;
    pwInput!.focus();
    // Confine Tab to the dialog; Escape cancels (same as the Cancel button).
    pwTrapRelease?.();
    pwTrapRelease = trapFocus(pwToast!, () => pwCancel!.click());
  };
  const hidePwPrompt = (): void => {
    if (!pwToast || !pwInput) return;
    pwTrapRelease?.();
    pwTrapRelease = null;
    pwToast.classList.remove("active");
    pwInput.value = "";
  };
  if (havePwPrompt) {
    pwCancel!.onclick = (): void => {
      hidePwPrompt();
      teardown(t("teardown.cancelledByHelper"), "info", true);
    };
  }

  codeInput.addEventListener("input", () => {
    codeInput.value = normaliseCodeInput(codeInput.value);
  });

  // gh #37: ?code=NNN-NNN-NNN prefill — lets the dashboard's
  // "Verbinden"-Button link directly to auffi.app/?code=… and land
  // the user on a populated input. We do NOT auto-submit: the
  // explicit click stays an intentional consent step, and a code
  // pasted from a phishing email shouldn't immediately initiate
  // a session.
  applyCodePrefill(codeInput);

  // Pressing Enter in the code input is the same as clicking Verbinden.
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !connectBtn.disabled) {
      e.preventDefault();
      connectBtn.click();
    }
  });

  function showReconnect(): void {
    if (reconnectWrap) reconnectWrap.classList.add("active");
  }

  function hideReconnect(): void {
    if (reconnectWrap) reconnectWrap.classList.remove("active");
  }

  function teardown(reason: string, kind: StatusKind = "info", canReconnect = false): void {
    // Invalidate any in-flight doConnect continuation (see connectGeneration).
    connectGeneration++;
    clearIceGraceTimer();
    clearConnectTimeout();
    hideConnectingControls();
    connectionTypeHandler.stop();
    hideFreeTierWarning();
    capture?.disable();
    capture = null;
    fileManager?.cancelAll();
    fileManager = null;
    rejectAllOffers();
    hidePwPrompt();
    setInputTogglePressed(inputToggleBtn, false);
    peer?.close();
    signaling?.close();
    peer = null;
    signaling = null;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {
        // Ignore — fullscreen may already be exiting via user gesture.
      });
    }
    resetZoom();
    setVideoStream(null);
    setConnectionType(null);
    setStatus(reason, kind);
    connectBtn.disabled = false;
    if (canReconnect && lastCode) {
      showReconnect();
    }
    // Only show the summary if the session actually went live (>=1 frame
    // received). Failed handshakes leave the tracker empty and we render
    // nothing — there's no information worth showing.
    sessionTracker.markEnded();
    if (sessionTracker.isLive()) {
      renderSessionSummary();
    }
  }

  disconnectBtn.addEventListener("click", () => {
    // Tell the sharer we're leaving so it shows "Helfer hat die
    // Verbindung beendet" instead of waiting for the ICE timeout to
    // surface as the less-friendly "Verbindung verloren". Best-effort —
    // if the WS already closed the message is dropped silently.
    try {
      signaling?.sendRelay({ kind: "bye" } satisfies RelayBye);
    } catch {
      /* ignore */
    }
    // Keep lastCode for a short window so a misclick on Beenden is recoverable.
    const hadCode = lastCode !== null;
    teardown(
      hadCode
        ? t("teardown.endedCanReconnect")
        : t("teardown.disconnected"),
      "info",
      hadCode,
    );
    if (!hadCode) return;
    clearManualDisconnectTimer();
    manualDisconnectTimer = setTimeout(() => {
      lastCode = null;
      hideReconnect();
      manualDisconnectTimer = null;
    }, MANUAL_DISCONNECT_RECONNECT_WINDOW_MS);
  });

  cancelConnectBtn?.addEventListener("click", () => {
    // Abbrechen is visible until the first frame. Before the sharer
    // confirmed, the backend drops viewer relays, so this bye never reaches
    // it — what dismisses the sharer's confirm dialog is the WS close in
    // teardown(), which makes the backend synthesise a bye. After confirm
    // (waiting for media) the relay does get through and the sharer shows
    // "Helfer hat die Verbindung beendet" instead of an ICE timeout.
    try {
      signaling?.sendRelay({ kind: "bye" } satisfies RelayBye);
    } catch {
      /* ignore */
    }
    teardown(t("teardown.cancelled"), "info", true);
  });

  refreshBtn?.addEventListener("click", () => {
    clearManualDisconnectTimer();
    hideSessionSummary();
    lastCode = null;
    hideReconnect();
    codeInput.value = "";
    codeInput.focus();
    setStatus("", "info");
  });

  fileOfferAccept.addEventListener("click", () => closeFileOffer(true));
  fileOfferReject.addEventListener("click", () => closeFileOffer(false));

  fileSendBtn.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file && fileManager) {
      fileManager.send(file).catch(() => {
        // Transfer was rejected or failed; no user-visible error needed here
      });
    }
    fileInput.value = "";
  });

  // A file dragged anywhere over the app must never trigger the browser
  // default of navigating to the dropped file — that unloads the page and
  // kills a live session when the helper misses the video wrapper by a few
  // pixels (toolbar, status bar, background). Text drags keep their native
  // behavior so dragging the 9-digit code into the input still works.
  const guardFileDrag = (e: DragEvent): void => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
    }
  };
  document.addEventListener("dragover", guardFileDrag);
  document.addEventListener("drop", guardFileDrag);

  videoWrapper.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!fileManager) return;
    videoWrapper.classList.add("drop-over");
  });

  videoWrapper.addEventListener("dragleave", () => {
    videoWrapper.classList.remove("drop-over");
  });

  videoWrapper.addEventListener("drop", (e) => {
    // Unconditional preventDefault: before the data channels are ready
    // (fileManager still null) the drop is swallowed, not navigated to.
    e.preventDefault();
    videoWrapper.classList.remove("drop-over");
    if (!fileManager) return;
    const file = e.dataTransfer?.files[0];
    if (file) {
      fileManager.send(file).catch(() => {
        // Transfer was rejected or failed; no user-visible error needed here
      });
    }
  });

  const enableControl = (): void => {
    const videoEl = document.getElementById("remote-video") as HTMLVideoElement;
    capture?.enable();
    setInputTogglePressed(inputToggleBtn, true);
    videoEl.focus();
  };

  inputToggleBtn.addEventListener("click", () => {
    if (inputToggleBtn.getAttribute("aria-pressed") === "true") {
      capture?.disable();
      setInputTogglePressed(inputToggleBtn, false);
    } else {
      enableControl();
    }
  });

  document.addEventListener("keydown", escapeHandler);

  function doConnect(code: string): void {
    clearManualDisconnectTimer();
    clearConnectTimeout();
    hideSessionSummary();
    sessionTracker = new SessionTracker();
    lastCode = code;
    hideReconnect();
    setStatus(t("status.awaitingConfirm"), "info");
    connectBtn.disabled = true;
    showConnectingControls();

    // Closure state the backstop timer reads when it fires: whether the
    // sharer has confirmed yet, and whether a TURN relay was on offer.
    let confirmed = false;
    let relayAvailable = false;
    const armConnectTimeout = (ms: number): void => {
      clearConnectTimeout();
      connectTimeout = setTimeout(() => {
        connectTimeout = null;
        teardown(connectTimeoutMessage({ confirmed, relayAvailable }), "err", true);
      }, ms);
    };
    armConnectTimeout(CONNECT_CONFIRM_TIMEOUT_MS);

    const connectGen = ++connectGeneration;
    const backendHttpUrl = wsUrlToHttpUrl(backendWsUrl);

    void fetchIceServers(backendHttpUrl, code).then((iceServers) => {
      // The user cancelled / a teardown fired while the fetch was in flight —
      // don't resurrect the connection.
      if (connectGen !== connectGeneration) return;
      relayAvailable = iceServers.length > 0;
      signaling = new SignalingClient(backendWsUrl);
      peer = new ViewerPeer({ iceServers });

      const videoEl = document.getElementById("remote-video") as HTMLVideoElement;

      peer.onTrack((stream) => {
        setVideoStream(stream, () => {
          // First decoded frame: the session is genuinely live. Stop the
          // connect backstop and drop the Abbrechen control.
          clearConnectTimeout();
          hideConnectingControls();
          sessionTracker.markStreamStarted();
        });
        const hub = peer!.getDataHub();
        const hubGen = connectGen;
        hub.ready().then(() => {
          // Guard against teardown firing between enqueue and microtask.
          // If the generation changed, peer/signaling are already null and
          // these new objects would become ghost listeners on a closed hub.
          if (hubGen !== connectGeneration || peer === null || signaling === null) return;
          capture = new InputCapture(videoEl, (ev) => hub.sendInput(ev));
          // The toolbar is reachable from the track event on — seconds
          // before the channels open, longer over TURN — so the helper may
          // already have asked for control; the toggle state is the intent.
          if (inputToggleBtn.getAttribute("aria-pressed") === "true") enableControl();

          fileManager = new FileTransferManager(
            (ev) => hub.sendFile(ev),
            (buf) => hub.sendFileChunk(buf),
            () => hub.filesBufferedAmount(),
            (threshold) => hub.awaitFilesBufferedLow(threshold),
          );

          fileManager.onIncomingOffer((offer: FileOffer) => {
            return new Promise<boolean>((resolve) => {
              offerQueue.push({ offer, resolve });
              if (offerQueue.length === 1) showNextOffer();
            });
          });

          fileManager.onIncomingComplete((file: File) => {
            sessionTracker.recordReceivedFile({ name: file.name, size: file.size });
            const url = URL.createObjectURL(file);
            const a = document.createElement("a");
            a.href = url;
            a.download = file.name;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          });

          hub.onFile((ev) => fileManager?.handle(ev));
          hub.onFileChunk((buf) => fileManager?.handleChunk(buf));
        }).catch(() => {
          // DataChannel setup failed; input control unavailable
        });
      });
      peer.onIceCandidate((candidate) => {
        if (candidate) signaling?.sendRelay({ kind: "ice", candidate } satisfies RelayIce);
      });
      peer.onIceState((state) => iceState.handle(state));
      peer.onConnectionType((type) => {
        setConnectionType(type);
        sessionTracker.setConnectionType(type);
        connectionTypeHandler.handle(type);
      });

      signaling.onRelay((payload) => {
        if (payload.kind === "sdp") {
          peer?.acceptAnswer(payload.sdp).catch((e: unknown) => {
            // The browser's DOMException text is English protocol jargon;
            // keep it in the console for diagnosis, not in the status line.
            console.error("setRemoteDescription failed", e);
            teardown(t("join.generic"), "err", true);
          });
        } else if (payload.kind === "ice") {
          peer?.addRemoteIceCandidate(payload.candidate).catch(() => {
            teardown(t("teardown.iceError"), "err");
          });
        } else if (payload.kind === "bye") {
          teardown(t("teardown.sharerEnded"), "info", true);
        }
      });

      // gh #36: unattended-mode password prompt. The backend emits
      // `needs-password` after the JOIN when the code resolves to a
      // registered device. We don't tear down on this; we show the
      // (bindUI-level) modal and `sendPwAttempt` the typed password back.
      // wrong-password keeps the modal up and shows attempts-left; the
      // terminal failures (locked, rejected-by-user) are caught by the
      // join() .catch below. Only the submit wiring lives here — it re-arms
      // this connect's backstop.
      const submitPw = (): void => {
        if (!havePwPrompt) return;
        // The button is disabled while an attempt is in flight; Enter shares
        // that gate so key-repeat can neither re-arm the backstop nor send a
        // duplicate pw-attempt (the backend answers that with a fatal
        // bad-message). showPwPrompt re-enables it on wrong-password.
        if (pwSubmit!.disabled) return;
        const password = pwInput!.value;
        if (password.length === 0) return;
        pwSubmit!.disabled = true;
        setStatus(t("status.checkingPassword"), "info");
        // Re-arm the backstop for the pw-check round-trip: a wrong-password /
        // locked / confirmed response clears or replaces it. The round-trip
        // may include the remote user clicking Akzeptieren (autoAccept off),
        // so it gets the confirm window, not the shorter media window.
        armConnectTimeout(CONNECT_CONFIRM_TIMEOUT_MS);
        signaling?.sendPwAttempt(password);
        // Don't hide the toast yet — wrong-password may bring it
        // back. peer-confirmed (join resolves) will hide it.
      };
      if (havePwPrompt) {
        pwSubmit!.onclick = submitPw;
        pwInput!.onkeydown = (e: KeyboardEvent): void => {
          if (e.key === "Enter") submitPw();
        };
      }

      signaling.onNeedsPassword(() => {
        // Now waiting on the human to type a password — pause the backstop
        // so a slow typist isn't torn down mid-entry. submitPw re-arms it.
        clearConnectTimeout();
        showPwPrompt(t("pw.prompt"), false);
      });
      signaling.onWrongPassword((attemptsLeft) => {
        clearConnectTimeout();
        showPwPrompt(
          t("pw.wrong", { n: attemptsLeft }),
          true,
        );
      });

      signaling.onDisconnect((reason) => {
        hidePwPrompt();
        const friendly = friendlyJoinError(reason);
        teardown(friendly.text, friendly.kind, true);
      });

      signaling
        .join(code)
        .then(async () => {
          if (!peer || !signaling) return;
          // Sharer confirmed. Switch the backstop from the (generous)
          // confirmation window to the shorter media window: we now expect a
          // decoded frame promptly, or it's a relay/firewall problem.
          confirmed = true;
          armConnectTimeout(CONNECT_MEDIA_TIMEOUT_MS);
          hidePwPrompt();
          const offer = await peer.start();
          signaling.sendRelay({ kind: "sdp", sdp: offer } satisfies RelaySdp);
          // Spec gh #82: green dot only AFTER the first frame is composited;
          // until then the spinner overlay is still up so the status must
          // stay informational (blue dot). setVideoStream() flips this to
          // "ok" via the first-frame callback.
          setStatus(t("status.connectedReceiving"), "info");
        })
        .catch((e: unknown) => {
          hidePwPrompt();
          const msg = e instanceof Error ? e.message : String(e);
          // Map every terminal failure (wrong/expired code, decline, lockout,
          // rate-limit, protocol error) to friendly German copy so the
          // non-technical helper never sees a raw protocol token.
          const friendly = friendlyJoinError(msg);
          teardown(friendly.text, friendly.kind, true);
        });
    });
  }

  connectBtn.addEventListener("click", () => {
    const code = codeInput.value.trim();
    if (!/^\d{3}-\d{3}-\d{3}$/.test(code)) {
      setStatus(t("status.enterCode"), "err");
      return;
    }
    doConnect(code);
  });

  reconnectBtn?.addEventListener("click", () => {
    if (!lastCode) return;
    hideReconnect();
    doConnect(lastCode);
  });
}
