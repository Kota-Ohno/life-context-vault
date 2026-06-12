# Life Context Vault

Local-first Control Center and AI Access Layer for a personal life-context vault. The product boundary is simple: everyday AI clients can request reviewed Context Packs, but they cannot read the whole Vault, Raw Sources, or unapproved memory candidates.

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

## Current Product Slice

- Life Context Home with Background Snapshot
- Guided background setup
- Memory Inbox with candidate review
- Source ingestion from notes and text-like uploaded files
- Approved facts as canonical memory
- AI Connections control surface
- Context Request review before AI-bound context leaves the Vault
- Passive Capture controls, recent capture history, Raw transcript purge actions, and browser/manual capture paths that create unapproved Inbox candidates only
- Audit trail for source, candidate, request, pack, and capture events
- Search over approved facts, with Tauri using encrypted SQLite FTS
- Encrypted JSON backup export and restore
- Tauri desktop wrapper with SQLCipher-backed encrypted native persistence
- Normalized SQLite projection tables plus native FTS retrieval for product-grade search
- Local MCP stdio sidecar for same-device AI clients
- App-managed AI Access Service that starts/stops the bundled HTTP MCP relay and local Vault Agent
- OAuth-capable HTTP MCP relay plus local Vault Agent WebSocket bridge, with metadata-only relay state persistence for Remote-MCP-style testing
- Hosted Relay Agent connection from the Control Center using short-lived `wss://.../agent/ws?pairing_code=...` URLs
- Chrome browser capture extension and Native Messaging host
- Restore preview and typed confirmation before encrypted backup restore or destructive Vault clear

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

For a hosted HTTPS relay, deploy `deploy/relay/Dockerfile`, start pairing from the relay's trusted admin path, then paste the returned `agentWebSocketUrl` into **Connections -> Hosted Relay Agent**. The desktop app accepts only `wss://.../agent/ws?pairing_code=...`, starts the local Agent process, clears the short-lived URL from the UI, and keeps the Vault work on the user's device. The Relay sends an explicit `agent_ready` ACK after pairing succeeds; only then does the Agent write fresh local `agent-status.json` metadata without the pairing secret, and Control Center marks Hosted as ready.

## Run Browser Capture Extension

```bash
npm run capture:build
```

Then load `browser-extension/` as an unpacked Chrome extension. In the Tauri desktop app, open **Connections**, paste the generated Chrome extension id, and use **Install host** to write the Native Messaging host manifest. The manual `LCV_EXTENSION_ID=<Chrome extension id> npm run extension:host-manifest` command remains available as a fallback. See `docs/browser-capture-extension.md`.

## Try The Product-Grade Slice

1. Open **Home** and add a small piece of life background.
2. Review the generated candidate in **Inbox** and save it as an ApprovedFact.
3. Open **Connections** and choose an AI route: Claude Desktop/local MCP, ChatGPT or Claude Web via hosted HTTPS Relay, browser capture, or copy fallback.
4. Start Passive Capture only if you want AI chat fragments to become unapproved Inbox candidates.
5. Open **Requests** and prepare a Context Pack for a ChatGPT or Claude-style task.
6. Confirm exactly what will be AI-bound, or copy the Pack for an AI that cannot use MCP yet.
7. Open **Audit** to see what was captured, saved, requested, generated, copied, or denied.

See `docs/product-grade-implementation-status.md` for what is implemented now and what remains for hosted connector certification and full normalized-store migration.
