const STORAGE_AUTO_CAPTURE = "lcvAutoCaptureEnabled";
const STORAGE_LAST_CAPTURE_META = "lcvLastCaptureMeta";

const button = document.querySelector("#capture");
const status = document.querySelector("#status");
const autoCapture = document.querySelector("#auto-capture");
const lastCapture = document.querySelector("#last-capture");
const openApp = document.querySelector("#open-app");
const deleteSource = document.querySelector("#delete-source");

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

deleteSource.addEventListener("click", async () => {
  deleteSource.disabled = true;
  setStatus("Deleting recent captured Source...", "");
  try {
    const stored = await chrome.storage.local.get({ [STORAGE_LAST_CAPTURE_META]: null });
    const meta = stored[STORAGE_LAST_CAPTURE_META];
    if (!meta?.sourceId || meta.status === "source_purged") {
      throw new Error("No recent captured Source is available to delete.");
    }
    const result = await chrome.runtime.sendMessage({
      type: "LCV_DELETE_CAPTURED_SOURCE",
      sourceId: meta.sourceId
    });
    if (!result?.ok) {
      throw new Error(result?.error ?? "Delete failed");
    }
    await chrome.storage.local.set({
      [STORAGE_LAST_CAPTURE_META]: {
        ...meta,
        ok: false,
        status: result.status ?? "source_purged",
        candidateCount: 0,
        deletedAt: new Date().toISOString()
      }
    });
    setStatus("Recent captured Source body was deleted from the local Vault.", "ok");
    await refreshLastCapture();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Delete failed", "error");
    await refreshLastCapture();
  }
});

openApp.addEventListener("click", async () => {
  openApp.disabled = true;
  setStatus("Opening Life Context Vault...", "");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "LCV_OPEN_CONTROL_CENTER"
    });
    if (!result?.ok) {
      throw new Error(result?.error ?? "Open app failed");
    }
    setStatus("Opened Life Context Vault. Review recent candidates in Memory Inbox.", "ok");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Open app failed", "error");
  } finally {
    await refreshLastCapture();
  }
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
    openApp.disabled = true;
    deleteSource.disabled = true;
    return;
  }
  const time = meta.capturedAt ? new Date(meta.capturedAt).toLocaleTimeString() : "recently";
  const client = meta.sourceClient ? `${meta.sourceClient} ` : "";
  const mode = meta.captureMode ? ` ${meta.captureMode}` : "";
  const length = meta.textLength ? `, ${meta.textLength} chars` : "";
  lastCapture.textContent = `${time}: ${client}${meta.status}${mode} / ${meta.candidateCount ?? 0} candidate(s)${length}`;
  lastCapture.dataset.state = meta.ok ? "ok" : "attention";
  openApp.disabled = false;
  deleteSource.disabled = !meta.sourceId || meta.status === "source_purged";
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
