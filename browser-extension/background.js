const NATIVE_HOST = "dev.life_context_vault.capture";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "LCV_CAPTURE_ACTIVE_TAB") return false;
  captureActiveTab().then(sendResponse).catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Capture failed"
    });
  });
  return true;
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

  return chrome.runtime.sendNativeMessage(NATIVE_HOST, {
    type: "capture_fragment",
    sourceClient: page.sourceClient,
    conversationId: page.conversationId,
    url: page.url,
    pageTitle: page.title,
    text: page.text,
    selected: page.selected
  });
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
