# Browser Capture Extension

Last updated: 2026-06-13

Life Context Vault includes a Chrome Manifest V3 extension plus a Native Messaging host.

The extension captures the current ChatGPT, Claude, or Gemini chat page and sends the text to the local native host. Users can run an explicit popup capture or turn on opt-in Auto Capture for supported AI pages. The native host then delegates to shared Rust Vault Core, which writes a `passive_capture` Source, `PassiveCaptureEvent`, audit records, and unapproved `MemoryCandidate` records to the encrypted local Vault.

## Safety Boundary

- Capture is explicit from the popup button unless the user turns on the extension's Auto Capture toggle.
- Auto Capture is off by default, shows a small in-page status badge, debounces page changes, skips writes when the captured text hash has not changed, and sends only appended delta text after the first successful page capture when the current page grows normally.
- Chrome extension storage keeps Auto Capture preference, the last text hash, recent capture status metadata, the latest captured `sourceId`, and recent delta checkpoint metadata only; it does not store captured transcript text. Delta checkpoints store `conversationId`, source client, full-text hash, text length, and timestamp so reloads can resume delta capture only when the current prefix hash matches the last accepted capture.
- The extension only runs on:
  - `chatgpt.com`
  - `chat.openai.com`
  - `claude.ai`
  - `gemini.google.com`
- The native host refuses capture when Passive Capture is off in the app.
- The native host calls Vault Core, and Vault Core checks the app's allowed site list before writing.
- The native host opens the same SQLCipher Vault as the app, using the OS secure credential store for the Vault key.
- Captured text becomes an Inbox candidate only.
- ApprovedFact creation still requires review in the app.
- Raw captured Source text follows the app's Passive Capture retention policy.
- The popup can delete the latest captured Source body from the local Vault by `sourceId`. The native host only allows this for browser passive-capture Sources.
- The popup can ask the native host to open the Life Context Vault Control Center after a capture. This returns only launch status metadata, not Vault content, Source body text, or candidate text.
- Secrets are redacted by Vault Core before storage when detected.
- The host does not implement its own extraction, redaction, persistence, or audit logic.

## Build Native Host

> **Note:** `lcv-capture-host` was removed in Simplify 1.1. The `capture:build` script no longer exists.

```bash
# npm run capture:build  # (removed in Simplify 1.1)
```

## Load Extension

1. Open Chrome Extensions.
2. Enable Developer mode.
3. Load unpacked extension from:

```text
browser-extension/
```

4. Copy the generated extension id.

## Install Native Host Manifest

Use the Tauri desktop app for the normal path:

1. Open **Connections**.
2. Paste the generated Chrome extension id into **Chrome拡張ID**.
3. Click **Native Hostを追加**.

The app writes the Native Messaging host manifest for the bundled `lcv-capture-host`. **Note: the `lcv-capture-host` binary was removed in Simplify 1.1. The browser-extension code remains, but the native host sidecar no longer exists. The install flow described below applies to the pre-Simplify 1.1 state.**

Manual fallback:

```bash
LCV_EXTENSION_ID=<Chrome extension id> npm run extension:host-manifest
```

This writes:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.life_context_vault.capture.json
```

It also writes a copy to:

```text
browser-extension/native-host.dev.json
```

## Use

1. Open the Life Context Vault app.
2. Go to **Connections**.
3. Turn Passive Capture on.
4. Open ChatGPT, Claude, or Gemini in Chrome.
5. Click the Life Context Vault extension.
6. Click **Capture current chat**, or turn on **Auto capture supported AI pages** for debounced page-change capture.
7. Click **Open app to review Inbox** to bring the Control Center forward.
8. If the last capture was wrong, click **Delete recent captured Source** in the popup to purge that captured Source body from the local Vault.
9. Return to the app. The desktop app polls the native Vault for capture updates; **Sync** remains available as a manual refresh.
10. Review the generated candidate in **Memory Inbox**.

## Native Message

The extension sends:

```json
{
  "type": "capture_fragment",
  "sourceClient": "chatgpt",
  "conversationId": "browser_abcd1234",
  "url": "https://chatgpt.com/c/...",
  "pageTitle": "ChatGPT",
  "text": "captured conversation text",
  "selected": false
}
```

Auto Capture sends the same message shape with `selected: false`. After the first successful page capture, it may send only appended delta text with `captureMode: "delta"` and a metadata-only `textLength`; it falls back to `captureMode: "full"` when the page is rewritten, the overlap is unclear, or the reload-safe checkpoint hash does not match the current page prefix. The Native host and Vault Core still enforce the app-level Passive Capture switch, allowed-site policy, retention policy, and candidate-only boundary.

The host replies:

```json
{
  "ok": true,
  "status": "candidate_generated",
  "sourceId": "src_...",
  "candidateCount": 1
}
```

The popup delete action sends:

```json
{
  "type": "delete_capture_source",
  "sourceId": "src_..."
}
```

The host refuses this action unless the Source is a browser `passive_capture` Source.

The popup open-app action sends:

```json
{
  "type": "open_control_center"
}
```

The host opens the bundled Life Context Vault app when it can resolve the app bundle or sibling app binary, and replies with launch status metadata only.
