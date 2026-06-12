const MAX_CAPTURE_CHARS = 8000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "LCV_COLLECT_PAGE_TEXT") return false;

  const selected = window.getSelection()?.toString().trim() ?? "";
  const pageText = selected || collectConversationText();
  sendResponse({
    ok: Boolean(pageText),
    text: pageText.slice(-MAX_CAPTURE_CHARS),
    selected: Boolean(selected),
    title: document.title,
    url: location.href,
    sourceClient: detectSourceClient(location.hostname),
    conversationId: stableConversationId(location.href)
  });
  return true;
});

function collectConversationText() {
  const candidates = [
    ...document.querySelectorAll(
      [
        "[data-testid*='conversation']",
        "[data-message-author-role]",
        "main",
        "[role='main']",
        "article"
      ].join(",")
    )
  ];
  const blocks = candidates
    .map((element) => normalizeText(element.textContent ?? ""))
    .filter((text) => text.length > 40);

  if (blocks.length > 0) {
    return blocks.sort((a, b) => b.length - a.length)[0];
  }
  return normalizeText(document.body?.innerText ?? "");
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function detectSourceClient(hostname) {
  if (hostname.includes("chatgpt") || hostname.includes("openai")) return "chatgpt";
  if (hostname.includes("claude")) return "claude_remote";
  if (hostname.includes("gemini")) return "gemini";
  return "generic_mcp";
}

function stableConversationId(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `browser_${(hash >>> 0).toString(16)}`;
}
