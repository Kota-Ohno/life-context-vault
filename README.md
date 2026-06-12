# Life Context Vault

Local-first proof of concept for a personal life-context vault that can safely feed everyday AI clients through reviewed Context Packs.

## Run

```bash
npm install
npm run dev
```

Open the printed local URL.

## Run As Desktop App

The native shell uses Tauri. If Rust is installed:

```bash
npm run tauri:dev
```

For a production binary without bundling:

```bash
npm run tauri:build
```

For a macOS `.app` bundle:

```bash
npm run tauri:bundle
```

## Verify

```bash
npm test
npm run build
npm run sidecars:prepare
npm run mcp:build
npm run relay:build
npm run agent:build
npm run capture:build
npm run tauri:build
npm run tauri:bundle
```

## PoC Scope

- Life Context Home with Background Snapshot
- Guided background setup
- Memory Inbox with candidate review
- Source ingestion from notes and text-like uploaded files
- Approved facts as canonical memory
- AI Connections control surface
- Context Request review before AI-bound context leaves the Vault
- Passive Capture simulator that creates unapproved Inbox candidates only
- Audit trail for source, candidate, request, pack, and capture events
- Search over approved facts
- Encrypted JSON backup export and restore
- Tauri desktop wrapper with SQLCipher-backed encrypted native persistence
- Normalized SQLite projection tables plus FTS foundation for product-grade retrieval
- Local MCP stdio sidecar for same-device AI clients
- App-managed AI Access Service that starts/stops the bundled HTTP MCP relay and local Vault Agent
- OAuth-capable HTTP MCP relay plus local Vault Agent WebSocket bridge, with metadata-only relay state persistence for Remote-MCP-style testing
- Chrome browser capture extension and Native Messaging host

The browser fallback uses `localStorage`. In the Tauri runtime, the same Vault state is persisted to an encrypted SQLCipher database in the app data directory, keyed by the OS secure credential store, and projected into normalized tables.

## Run Local MCP Sidecar

```bash
npm run mcp:build
```

Then open **Connections** in the Tauri desktop app and use **Install Claude config**. The app merges the `life-context-vault` MCP server into Claude Desktop's config and backs up an existing config first. Manual copy remains available as a fallback.

The MCP sidecar exposes controlled tools only:

- `life_context.request_context_pack`
- `life_context.propose_memory`
- `life_context.get_policy_summary`
- `life_context.get_request_status`

See `docs/local-mcp-sidecar.md` for setup, safety boundaries, and a stdio smoke test.

## Run HTTP MCP Relay

```bash
npm run relay:build
npm run agent:build
```

Then open **Connections** and copy the relay, pairing, and local Agent commands.

In the Tauri desktop app, open **Connections** and use **Start AI Access** to launch the bundled Relay and Agent. The manual relay, pairing, and Agent commands remain as a fallback.

For day-to-day use, **Connections** also includes operations controls to launch the app at macOS login and to auto-start AI Access when the app opens. This keeps the Agent available after reboot while preserving the same Context Pack confirmation boundary.

The relay defaults to `http://127.0.0.1:8765/mcp`, exposes OAuth metadata and dynamic client registration, persists OAuth client registrations plus request metadata only, and forwards requests through a paired local Agent WebSocket. See `docs/http-mcp-relay.md`.

## Run Browser Capture Extension

```bash
npm run capture:build
```

Then load `browser-extension/` as an unpacked Chrome extension. In the Tauri desktop app, open **Connections**, paste the generated Chrome extension id, and use **Install host** to write the Native Messaging host manifest. The manual `LCV_EXTENSION_ID=<Chrome extension id> npm run extension:host-manifest` command remains available as a fallback. See `docs/browser-capture-extension.md`.

## Try The Product-Grade Slice

1. Open **Connections** and start Passive Capture.
2. Paste an AI chat fragment into the Capture simulator.
3. Review the generated candidate in **Inbox**.
4. Save the candidate as an ApprovedFact.
5. Open **Requests** and create a simulated ChatGPT or Claude Context Request.
6. Confirm the Context Pack before generating the local answer.
7. Open **Audit** to see what was captured, saved, requested, generated, or denied.

See `docs/product-grade-implementation-status.md` for what is implemented now and what remains for the real MCP/Relay buildout.
