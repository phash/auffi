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
  app.appendChild(videoWrapper);

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

  const freeTierToast = document.createElement("div");
  freeTierToast.id = "free-tier-warning-toast";
  app.appendChild(freeTierToast);

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
