const NATIVE_HOST = "dev.life_context_vault.capture";
const STORAGE_LAST_CAPTURE_META = "lcvLastCaptureMeta";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "LCV_CAPTURE_ACTIVE_TAB") {
    captureActiveTab().then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Capture failed"
      });
    });
    return true;
  }

  if (message?.type === "LCV_CAPTURE_PAGE_FRAGMENT") {
    capturePageFragment(message.page, message.reason ?? "auto").then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Capture failed"
      });
    });
    return true;
  }

  if (message?.type === "LCV_DELETE_CAPTURED_SOURCE") {
    deleteCapturedSource(message.sourceId).then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Delete failed"
      });
    });
    return true;
  }

  if (message?.type === "LCV_OPEN_CONTROL_CENTER") {
    openControlCenter().then(sendResponse).catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Open app failed"
      });
    });
    return true;
  }

  return false;
});

async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active AI chat tab was found.");
  }
  if (!isAllowedUrl(tab.url)) {
    throw new Error("Open ChatGPT, Claude, or Gemini before capturing.");
  }

  const page = await chrome.tabs.sendMessage(tab.id, {
    type: "LCV_COLLECT_PAGE_TEXT"
  });
  if (!page?.ok || !page.text) {
    throw new Error("No conversation text was found on this page.");
  }

  return capturePageFragment(page, page.selected ? "selection" : "manual");
}

async function capturePageFragment(page, reason) {
  if (!page?.url || !isAllowedUrl(page.url)) {
    throw new Error("Open ChatGPT, Claude, or Gemini before capturing.");
  }
  if (!page.text) {
    throw new Error("No conversation text was found on this page.");
  }

  const result = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    type: "capture_fragment",
    sourceClient: page.sourceClient,
    conversationId: page.conversationId,
    url: page.url,
    pageTitle: page.title,
    text: page.text,
    selected: Boolean(page.selected)
  });
  await recordCaptureMeta(page, result, reason);
  return result;
}

async function deleteCapturedSource(sourceId) {
  if (!sourceId) {
    throw new Error("No recent captured Source is available to delete.");
  }
  const result = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    type: "delete_capture_source",
    sourceId
  });
  if (!result?.ok) {
    throw new Error(result?.error ?? result?.message ?? "Delete failed");
  }
  return result;
}

async function openControlCenter() {
  const result = await chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    type: "open_control_center"
  });
  if (!result?.ok) {
    throw new Error(result?.error ?? result?.message ?? "Open app failed");
  }
  return result;
}

async function recordCaptureMeta(page, result, reason) {
  const meta = {
    ok: Boolean(result?.ok),
    status: result?.status ?? (result?.ok ? "captured" : "failed"),
    candidateCount: result?.candidateCount ?? 0,
    sourceId: result?.sourceId ?? null,
    eventId: result?.eventId ?? null,
    retentionUntil: result?.retentionUntil ?? null,
    sourceClient: page.sourceClient,
    conversationId: page.conversationId,
    url: page.url,
    pageTitle: page.title,
    captureMode: page.captureMode ?? (page.selected ? "selection" : "full"),
    textLength: page.textLength ?? page.text.length,
    reason,
    capturedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [STORAGE_LAST_CAPTURE_META]: meta });
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
