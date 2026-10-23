/**
 * Minimal DOM that ui.ts's bindUI() touches — shared by the ui-* test files
 * (previously three drifting inline copies). Superset of what each test
 * needs: elements a scenario doesn't exercise are simply never toggled, and
 * bindUI null-guards the optional ones (cancel-connect, pw-prompt, session
 * summary) anyway.
 */
export function buildUiTestDOM(): void {
  const app = document.createElement("div");
  app.id = "app";

  const instruction = document.createElement("p");
  instruction.className = "instruction";
  app.appendChild(instruction);

  const inputGroup = document.createElement("div");
  inputGroup.className = "input-group";
  const codeInput = document.createElement("input");
  codeInput.id = "code";
  inputGroup.appendChild(codeInput);
  const connectBtn = document.createElement("button");
  connectBtn.id = "connect";
  inputGroup.appendChild(connectBtn);
  const cancelBtn = document.createElement("button");
  cancelBtn.id = "cancel-connect";
  cancelBtn.hidden = true;
  inputGroup.appendChild(cancelBtn);
  const refreshBtn = document.createElement("button");
  refreshBtn.id = "refresh-btn";
  inputGroup.appendChild(refreshBtn);
  app.appendChild(inputGroup);

  const statusEl = document.createElement("div");
  statusEl.id = "status";
  app.appendChild(statusEl);

  const reconnectWrap = document.createElement("div");
  reconnectWrap.id = "reconnect-wrap";
  // CSS .reconnect-wrap is display:none by default; .active toggles visible.
  reconnectWrap.classList.add("reconnect-wrap");
  const reconnectBtn = document.createElement("button");
  reconnectBtn.id = "reconnect-btn";
  reconnectWrap.appendChild(reconnectBtn);
  app.appendChild(reconnectWrap);

  const videoWrapper = document.createElement("div");
  videoWrapper.id = "video-wrapper";
  const video = document.createElement("video");
  video.id = "remote-video";
  videoWrapper.appendChild(video);
  const toolbar = document.createElement("div");
  toolbar.id = "video-toolbar";
  videoWrapper.appendChild(toolbar);
  const disconnectBtn = document.createElement("button");
  disconnectBtn.id = "disconnect";
  videoWrapper.appendChild(disconnectBtn);
  const connType = document.createElement("div");
  connType.id = "connection-type";
  videoWrapper.appendChild(connType);
  const panOverlay = document.createElement("div");
  panOverlay.id = "pan-overlay";
  panOverlay.hidden = true;
  for (const id of ["pan-up", "pan-down", "pan-left", "pan-right", "pan-reset"]) {
    const btn = document.createElement("button");
    btn.id = id;
    panOverlay.appendChild(btn);
  }
  videoWrapper.appendChild(panOverlay);
  const controls = document.createElement("div");
  controls.id = "video-controls";
  for (const id of ["zoom-out", "zoom-reset", "zoom-in", "fullscreen-btn"]) {
    const btn = document.createElement("button");
    btn.id = id;
    controls.appendChild(btn);
  }
  const zoomLevel = document.createElement("span");
  zoomLevel.id = "zoom-level";
  controls.appendChild(zoomLevel);
  videoWrapper.appendChild(controls);
  app.appendChild(videoWrapper);

  const summary = document.createElement("section");
  summary.id = "session-summary";
  summary.hidden = true;
  for (const id of ["session-summary-duration", "session-summary-conn"]) {
    const span = document.createElement("span");
    span.id = id;
    summary.appendChild(span);
  }
  const filesWrap = document.createElement("div");
  filesWrap.id = "session-summary-files-wrap";
  filesWrap.hidden = true;
  const files = document.createElement("div");
  files.id = "session-summary-files";
  filesWrap.appendChild(files);
  summary.appendChild(filesWrap);
  const summaryClose = document.createElement("button");
  summaryClose.id = "session-summary-close";
  summary.appendChild(summaryClose);
  app.appendChild(summary);

  const inputToggle = document.createElement("button");
  inputToggle.id = "input-toggle";
  inputToggle.setAttribute("aria-pressed", "false");
  const label = document.createElement("span");
  label.id = "input-toggle-label";
  inputToggle.appendChild(label);
  app.appendChild(inputToggle);

  const fileSendBtn = document.createElement("button");
  fileSendBtn.id = "file-send-btn";
  app.appendChild(fileSendBtn);

  const fileInput = document.createElement("input");
  fileInput.id = "file-input";
  fileInput.type = "file";
  app.appendChild(fileInput);

  const fileOfferToast = document.createElement("div");
  fileOfferToast.id = "file-offer-toast";
  const fileOfferBody = document.createElement("div");
  fileOfferBody.id = "file-offer-body";
  fileOfferToast.appendChild(fileOfferBody);
  const acceptBtn = document.createElement("button");
  acceptBtn.id = "file-offer-accept";
  fileOfferToast.appendChild(acceptBtn);
  const rejectBtn = document.createElement("button");
  rejectBtn.id = "file-offer-reject";
  fileOfferToast.appendChild(rejectBtn);
  app.appendChild(fileOfferToast);

  const pwToast = document.createElement("div");
  pwToast.id = "pw-prompt-toast";
  const pwMessage = document.createElement("p");
  pwMessage.id = "pw-prompt-message";
  pwToast.appendChild(pwMessage);
  const pwInput = document.createElement("input");
  pwInput.id = "pw-prompt-input";
  pwInput.type = "password";
  pwToast.appendChild(pwInput);
  const pwSubmit = document.createElement("button");
  pwSubmit.id = "pw-prompt-submit";
  pwToast.appendChild(pwSubmit);
  const pwCancel = document.createElement("button");
  pwCancel.id = "pw-prompt-cancel";
  pwToast.appendChild(pwCancel);
  app.appendChild(pwToast);

  const cardToggle = document.createElement("button");
  cardToggle.id = "card-toggle";
  app.appendChild(cardToggle);
  const compactLine = document.createElement("div");
  compactLine.className = "compact-status-line";
  for (const id of ["compact-status-text", "compact-duration", "compact-bytes"]) {
    const span = document.createElement("span");
    span.id = id;
    compactLine.appendChild(span);
  }
  app.appendChild(compactLine);

  document.body.replaceChildren(app);
}
