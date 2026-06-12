# Browser Capture Extension

Last updated: 2026-06-12

Life Context Vault includes a Chrome Manifest V3 extension plus a Native Messaging host.

The extension captures the current ChatGPT, Claude, or Gemini chat page and sends the text to the local native host. The native host then delegates to shared Rust Vault Core, which writes a `passive_capture` Source, `PassiveCaptureEvent`, audit records, and unapproved `MemoryCandidate` records to the encrypted local Vault.

## Safety Boundary

- Capture is explicit from the popup button.
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
- Secrets are redacted by Vault Core before storage when detected.
- The host does not implement its own extraction, redaction, persistence, or audit logic.

## Build Native Host

```bash
npm run capture:build
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
3. Click **Install host**.

The app writes the Native Messaging host manifest for the bundled `lcv-capture-host`, backs up any previous manifest with the same host name, and refuses invalid extension IDs.

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
6. Click **Capture current chat**.
7. Return to the app. The desktop app polls the native Vault for capture updates; **Sync** remains available as a manual refresh.
8. Review the generated candidate in **Memory Inbox**.

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

The host replies:

```json
{
  "ok": true,
  "status": "candidate_generated",
  "candidateCount": 1
}
```
