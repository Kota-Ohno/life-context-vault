const button = document.querySelector("#capture");
const status = document.querySelector("#status");

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
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Capture failed", "error");
  } finally {
    button.disabled = false;
  }
});

function setStatus(text, state) {
  status.textContent = text;
  if (state) {
    status.dataset.state = state;
  } else {
    delete status.dataset.state;
  }
}
