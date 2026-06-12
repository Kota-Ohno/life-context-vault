const STORAGE_AUTO_CAPTURE = "lcvAutoCaptureEnabled";
const STORAGE_LAST_CAPTURE_META = "lcvLastCaptureMeta";

const button = document.querySelector("#capture");
const status = document.querySelector("#status");
const autoCapture = document.querySelector("#auto-capture");
const lastCapture = document.querySelector("#last-capture");

void initializePopup();

button.addEventListener("click", async () => {
  button.disabled = true;
  setStatus("Capturing...", "");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "LCV_CAPTURE_ACTIVE_TAB"
    });
    if (!result?.ok) {
      throw new Error(result?.error ?? "Capture failed");
    }
    setStatus(`Added ${result.candidateCount ?? 0} candidate(s) to Memory Inbox.`, "ok");
    await refreshLastCapture();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Capture failed", "error");
  } finally {
    button.disabled = false;
  }
});

autoCapture.addEventListener("change", async () => {
  const enabled = autoCapture.checked;
  await chrome.storage.local.set({ [STORAGE_AUTO_CAPTURE]: enabled });
  await notifyActiveTab(enabled);
  setStatus(enabled ? "Auto capture is on for supported AI pages." : "Auto capture is paused.", enabled ? "ok" : "");
});

async function initializePopup() {
  const stored = await chrome.storage.local.get({
    [STORAGE_AUTO_CAPTURE]: false,
    [STORAGE_LAST_CAPTURE_META]: null
  });
  autoCapture.checked = Boolean(stored[STORAGE_AUTO_CAPTURE]);
  renderLastCapture(stored[STORAGE_LAST_CAPTURE_META]);
}

async function notifyActiveTab(enabled) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !isAllowedUrl(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "LCV_CAPTURE_SETTINGS_CHANGED",
      autoCaptureEnabled: enabled
    });
  } catch {
    // The supported page may not have loaded the content script yet.
  }
}

async function refreshLastCapture() {
  const stored = await chrome.storage.local.get({ [STORAGE_LAST_CAPTURE_META]: null });
  renderLastCapture(stored[STORAGE_LAST_CAPTURE_META]);
}

function renderLastCapture(meta) {
  if (!meta) {
    lastCapture.textContent = "No recent capture in this browser.";
    delete lastCapture.dataset.state;
    return;
  }
  const time = meta.capturedAt ? new Date(meta.capturedAt).toLocaleTimeString() : "recently";
  lastCapture.textContent = `${time}: ${meta.status} / ${meta.candidateCount ?? 0} candidate(s)`;
  lastCapture.dataset.state = meta.ok ? "ok" : "attention";
}

function setStatus(text, state) {
  status.textContent = text;
  if (state) {
    status.dataset.state = state;
  } else {
    delete status.dataset.state;
  }
}

function isAllowedUrl(url) {
  try {
    const host = new URL(url).hostname;
    return (
      host === "chatgpt.com" ||
      host === "chat.openai.com" ||
      host === "claude.ai" ||
      host === "gemini.google.com"
    );
  } catch {
    return false;
  }
}
