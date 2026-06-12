const MAX_CAPTURE_CHARS = 8000;
const MIN_CAPTURE_CHARS = 80;
const MIN_DELTA_OVERLAP_CHARS = 120;
const AUTO_CAPTURE_DEBOUNCE_MS = 12000;
const STORAGE_AUTO_CAPTURE = "lcvAutoCaptureEnabled";
const STORAGE_LAST_HASH = "lcvLastCaptureHash";
const STORAGE_DELTA_CHECKPOINTS = "lcvDeltaCheckpoints";
const MAX_DELTA_CHECKPOINTS = 20;

let autoCaptureEnabled = false;
let observer = null;
let captureTimer = null;
let lastCaptureHash = "";
let lastAcceptedUrl = "";
let lastAcceptedText = "";
let statusBadge = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "LCV_COLLECT_PAGE_TEXT") {
    sendResponse(collectPagePayload());
    return true;
  }
  if (message?.type === "LCV_CAPTURE_SETTINGS_CHANGED") {
    void setAutoCapture(Boolean(message.autoCaptureEnabled));
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "LCV_CAPTURE_STATUS_REQUEST") {
    sendResponse({ ok: true, autoCaptureEnabled, url: location.href });
    return true;
  }
  return false;
});

void initializeAutoCapture();

async function initializeAutoCapture() {
  ensureStatusBadge();
  const stored = await chrome.storage.local.get({
    [STORAGE_AUTO_CAPTURE]: false,
    [STORAGE_LAST_HASH]: ""
  });
  lastCaptureHash = typeof stored[STORAGE_LAST_HASH] === "string" ? stored[STORAGE_LAST_HASH] : "";
  await setAutoCapture(Boolean(stored[STORAGE_AUTO_CAPTURE]));
}

async function setAutoCapture(enabled) {
  autoCaptureEnabled = enabled;
  ensureStatusBadge();
  if (!enabled) {
    stopObserver();
    renderStatus("LCV Capture paused", "paused");
    return;
  }

  startObserver();
  renderStatus("LCV Capture watching", "ready");
  scheduleAutoCapture("enabled");
}

function startObserver() {
  if (observer || !document.body) return;
  observer = new MutationObserver(() => scheduleAutoCapture("page_changed"));
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function stopObserver() {
  if (captureTimer) {
    clearTimeout(captureTimer);
    captureTimer = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function scheduleAutoCapture(reason) {
  if (!autoCaptureEnabled) return;
  if (captureTimer) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    void autoCapture(reason);
  }, AUTO_CAPTURE_DEBOUNCE_MS);
}

async function autoCapture(reason) {
  if (!autoCaptureEnabled) return;
  const page = collectPagePayload();
  if (!page.ok || page.text.length < MIN_CAPTURE_CHARS) {
    renderStatus("LCV Capture waiting", "paused");
    return;
  }

  const captureHash = stableHash(`${page.url}\n${page.text}`);
  if (captureHash === lastCaptureHash) {
    renderStatus("LCV Capture watching", "ready");
    return;
  }
  if (await checkpointMatchesFullText(page, captureHash)) {
    lastCaptureHash = captureHash;
    await chrome.storage.local.set({ [STORAGE_LAST_HASH]: captureHash });
    renderStatus("LCV Capture watching", "ready");
    return;
  }

  const prepared = await prepareAutoCapturePayload(page, captureHash);
  if (!prepared) {
    renderStatus("LCV Capture waiting", "paused");
    return;
  }

  renderStatus("LCV Capture saving", "sending");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "LCV_CAPTURE_PAGE_FRAGMENT",
      page: prepared.page,
      reason: prepared.captureMode === "delta" ? "auto_delta" : reason
    });
    if (result?.ok) {
      lastCaptureHash = captureHash;
      lastAcceptedUrl = page.url;
      lastAcceptedText = page.text;
      await chrome.storage.local.set({ [STORAGE_LAST_HASH]: captureHash });
      await storeDeltaCheckpoint(page, captureHash);
      const label = prepared.captureMode === "delta" ? "delta" : "full";
      renderStatus(`LCV captured ${label} ${result.candidateCount ?? 0}`, "ok");
    } else {
      renderStatus(`LCV ${result?.status ?? "not saved"}`, "attention");
    }
  } catch (error) {
    renderStatus(error instanceof Error ? `LCV ${error.message}` : "LCV Capture failed", "error");
  }
}

async function prepareAutoCapturePayload(page, captureHash = stableHash(`${page.url}\n${page.text}`)) {
  const delta = await autoCaptureDelta(page, captureHash);
  if (delta === null) {
    return {
      captureMode: "full",
      page: {
        ...page,
        captureMode: "full",
        textLength: page.text.length
      }
    };
  }
  if (delta.length < MIN_CAPTURE_CHARS) return null;

  return {
    captureMode: "delta",
    page: {
      ...page,
      text: delta,
      selected: false,
      captureMode: "delta",
      textLength: delta.length,
      fullTextHash: stableHash(`${page.url}\n${page.text}`)
    }
  };
}

async function autoCaptureDelta(page, captureHash) {
  if (lastAcceptedUrl === page.url && lastAcceptedText) {
    return incrementalText(lastAcceptedText, page.text);
  }

  const checkpoint = await deltaCheckpointForPage(page);
  if (!checkpoint || checkpoint.fullTextHash === captureHash) return "";
  if (!Number.isFinite(checkpoint.textLength) || checkpoint.textLength <= 0) return null;
  if (checkpoint.textLength >= page.text.length) return "";

  const currentPrefixHash = stableHash(`${page.url}\n${page.text.slice(0, checkpoint.textLength)}`);
  if (currentPrefixHash !== checkpoint.fullTextHash) return null;

  return page.text.slice(checkpoint.textLength).trim();
}

async function deltaCheckpointForPage(page) {
  const checkpoints = await loadDeltaCheckpoints();
  return checkpoints.find((checkpoint) => checkpoint.conversationId === page.conversationId) ?? null;
}

async function checkpointMatchesFullText(page, captureHash) {
  const checkpoint = await deltaCheckpointForPage(page);
  return checkpoint?.fullTextHash === captureHash;
}

async function storeDeltaCheckpoint(page, fullTextHash) {
  const checkpoint = {
    conversationId: page.conversationId,
    sourceClient: page.sourceClient,
    fullTextHash,
    textLength: page.text.length,
    capturedAt: new Date().toISOString()
  };
  const checkpoints = (await loadDeltaCheckpoints())
    .filter((existing) => existing.conversationId !== checkpoint.conversationId);
  checkpoints.unshift(checkpoint);
  await chrome.storage.local.set({
    [STORAGE_DELTA_CHECKPOINTS]: checkpoints.slice(0, MAX_DELTA_CHECKPOINTS)
  });
}

async function loadDeltaCheckpoints() {
  const stored = await chrome.storage.local.get({ [STORAGE_DELTA_CHECKPOINTS]: [] });
  const checkpoints = stored[STORAGE_DELTA_CHECKPOINTS];
  if (!Array.isArray(checkpoints)) return [];
  return checkpoints.filter((checkpoint) =>
    checkpoint &&
    typeof checkpoint.conversationId === "string" &&
    typeof checkpoint.fullTextHash === "string" &&
    typeof checkpoint.textLength === "number"
  );
}

function incrementalText(previous, current) {
  if (!previous || current === previous) return "";
  if (current.startsWith(previous)) return current.slice(previous.length).trim();

  const directIndex = current.indexOf(previous);
  if (directIndex >= 0) {
    return current.slice(directIndex + previous.length).trim();
  }

  const maxOverlap = Math.min(previous.length, current.length);
  for (let overlap = maxOverlap; overlap >= MIN_DELTA_OVERLAP_CHARS; overlap -= 1) {
    if (previous.slice(previous.length - overlap) === current.slice(0, overlap)) {
      return current.slice(overlap).trim();
    }
  }

  return null;
}

function collectPagePayload() {
  const selected = window.getSelection()?.toString().trim() ?? "";
  const pageText = selected || collectConversationText();
  return {
    ok: Boolean(pageText),
    text: pageText.slice(-MAX_CAPTURE_CHARS),
    selected: Boolean(selected),
    title: document.title,
    url: location.href,
    sourceClient: detectSourceClient(location.hostname),
    conversationId: stableConversationId(location.href)
  };
}

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
  const statusText = statusBadge?.textContent ?? "";
  return normalizeText(document.body?.innerText ?? "").replace(statusText, "").trim();
}

function ensureStatusBadge() {
  if (statusBadge || !document.body) return;
  statusBadge = document.createElement("div");
  statusBadge.dataset.lcvCaptureUi = "true";
  statusBadge.setAttribute("aria-live", "polite");
  Object.assign(statusBadge.style, {
    position: "fixed",
    right: "14px",
    bottom: "14px",
    zIndex: "2147483647",
    maxWidth: "220px",
    padding: "7px 9px",
    border: "1px solid #c9d5c8",
    borderRadius: "8px",
    background: "#fbfcfa",
    color: "#26352b",
    boxShadow: "0 6px 18px rgba(20, 28, 22, 0.12)",
    font: "12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    overflowWrap: "anywhere",
    pointerEvents: "none"
  });
  document.body.append(statusBadge);
}

function renderStatus(text, state) {
  ensureStatusBadge();
  if (!statusBadge) return;
  statusBadge.textContent = text;
  statusBadge.dataset.state = state;
  const colors = {
    ok: ["#eaf7ee", "#8ebf9a", "#245b35"],
    ready: ["#fbfcfa", "#c9d5c8", "#26352b"],
    paused: ["#f7f8f5", "#d6ded4", "#5a665e"],
    sending: ["#fffaf0", "#dfc28d", "#6f4c10"],
    attention: ["#fffaf0", "#dfc28d", "#6f4c10"],
    error: ["#fff6f2", "#d7b8ad", "#8b2f1d"]
  };
  const [background, border, color] = colors[state] ?? colors.ready;
  statusBadge.style.background = background;
  statusBadge.style.borderColor = border;
  statusBadge.style.color = color;
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
  return `browser_${stableHash(value)}`;
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
