# Life Context Vault Product-Grade Implementation Status

Last updated: 2026-06-12

## Implemented In This Slice

- Expanded the Vault state from PoC-only memory objects to product-grade AI access objects:
  - `ContextPackRequest`
  - `AccessPolicy`
  - `ConnectorSession`
  - `PassiveCaptureEvent`
  - `MemoryProposal`-compatible candidate fields
- Preserved the core trust boundary:
  - `MemoryCandidate` is not trusted context.
  - `ApprovedFact` remains the canonical memory unit.
  - `ContextPack` remains the only AI-bound context payload.
- Added Control Center UI surfaces:
  - AI Connections
  - Context Requests
  - Passive Capture simulator
  - Audit trail
- Reworked the local Ask flow into a simulated external AI request flow:
  - create a `ContextPackRequest`
  - generate a short-lived `ContextPack`
  - confirm or deny before answer generation
- Added passive capture behavior:
  - opt-in capture setting
  - default 14-day retention
  - local transcript fragments produce Inbox candidates only
  - expired capture source text is purged while review history remains
- Added Tauri SQLite normalized storage foundation:
  - `sources`
  - `source_chunks`
  - `memory_candidates`
  - `facts`
  - `entities`
  - `relationships`
  - `access_policies`
  - `context_pack_requests`
  - `context_packs`
  - `connector_sessions`
  - `passive_capture_events`
  - `audit_events`
  - `facts_fts`
- Added SQLCipher-backed local database encryption:
  - macOS Keychain-managed Vault key by default
  - `LCV_VAULT_DB_KEY` override for CI and smoke tests
  - plaintext PoC SQLite `vault_state` migration into encrypted SQLite
  - shared encrypted open path for the Tauri app, local MCP sidecar, and browser capture host
- Added real local MCP stdio sidecar:
  - `life_context.request_context_pack`
  - `life_context.propose_memory`
  - `life_context.get_policy_summary`
  - `life_context.get_request_status`
  - private consequential and sensitive packs are queued for confirmation instead of returned directly
- Added Connections UI setup guidance for Claude Desktop-style MCP configuration.
- Added top-bar native Vault Sync action so the app can reload MCP-written requests or memory proposals while open.
- Added OAuth-capable HTTP MCP relay and local Vault Agent:
  - `POST /mcp` accepts MCP JSON-RPC over HTTP
  - `GET /health`
  - `GET /.well-known/oauth-protected-resource`
  - `GET /.well-known/oauth-authorization-server`
  - `POST /oauth/register`
  - Authorization Code + PKCE endpoints at `/oauth/authorize`, `/oauth/approve`, and `/oauth/token`
  - device pairing endpoints at `/pairing/start` and `/pairing/status`
  - local Agent WebSocket endpoint at `/agent/ws`
  - `lcv-agent` forwards paired relay requests to the local encrypted `lcv-mcp` sidecar
  - minimum OAuth scopes are mapped per exposed MCP tool
  - static bearer token fallback remains for local development
  - loopback bind by default
- Added Connections UI setup guidance for OAuth relay, pairing, local Agent, and connector URLs.
- Added Chrome browser capture extension and Native Messaging host:
  - Manifest V3 extension under `browser-extension/`
  - popup-triggered capture for ChatGPT, Claude, and Gemini
  - native host `lcv-capture-host`
  - capture writes `passive_capture` Source, `PassiveCaptureEvent`, and unapproved Inbox candidates
  - host refuses capture unless Passive Capture is enabled and the site is allowed
- Added Connections UI setup guidance for extension and native host manifest installation.
- Kept encrypted JSON backup compatibility through the existing backup flow.

## Still Remaining For Full Product Grade

- Public HTTPS deployment and durable hosted relay domain.
- Persistent OAuth client registration store.
- Installer-managed local Agent launch, reconnect, and background status.
- Provider-backed LLM extraction and PDF/OCR ingestion.
- Full Rust-owned Vault Core commands instead of JSON snapshot plus normalized table projection.
- Large-scale retrieval benchmark against 100k facts and 500k chunks.

## Verification

- `npm test`
- `npm run build`
- `cargo test` in `src-tauri`
- `cargo build` in `src-tauri`
- `npm run mcp:build`
- stdio MCP smoke test for `initialize`, `tools/list`, and `life_context.propose_memory`
- `npm run relay:build`
- `npm run agent:build`
- HTTP relay smoke test for `/health`, OAuth metadata, unauthorized `/mcp`, authorized `tools/list`, encrypted direct fallback writes, and paired Agent WebSocket writes
- `npm run capture:build`
- Native Messaging host smoke test for disabled capture refusal and enabled capture candidate generation
- SQLCipher tests for encrypted DB plain-read refusal and plaintext PoC DB migration
- Entry-point smoke tests proving MCP, Relay, and Capture-created Vault DBs are not readable as plaintext SQLite
- `npm run tauri:build`
- `npm run tauri:bundle`
- Browser UI checks:
  - desktop `1440x980`: Connections MCP setup card displays without horizontal overflow
  - mobile `390x844`: Connections MCP setup card and code blocks fit without page-level horizontal overflow
  - desktop `1440x980`: Connections Remote MCP Relay setup displays OAuth, pairing, Agent, and connector details without horizontal overflow
  - mobile `390x844`: MCP and Remote Relay setup grids stack without page-level horizontal overflow
  - desktop `1440x980`: Connections browser extension setup card displays native host instructions without horizontal overflow
  - mobile `390x844`: extension setup code blocks fit without page-level horizontal overflow
  - desktop `1440x980`: Settings storage panel displays without horizontal overflow
  - mobile `390x844`: Settings storage panel stacks without page-level horizontal overflow
- Extension static checks:
  - `node --check browser-extension/background.js`
  - `node --check browser-extension/content.js`
  - `node --check browser-extension/popup.js`
  - `node --check scripts/write-native-host-manifest.mjs`
  - `LCV_EXTENSION_ID=... npm run extension:host-manifest`

`cargo fmt --check` could not run because `cargo-fmt` is not installed for the active stable Apple Silicon toolchain.

## Review Notes

- Product fit: the app now centers on using life context from everyday AI, not only in-app asking.
- Security/privacy: external AI receives Context Packs only; passive capture creates candidates only; TTL purge is implemented for raw capture text.
- Technical design: normalized SQLite tables and FTS are present, but the frontend still persists a JSON snapshot that is projected into tables.
- UX: users can see connections, pending requests, capture status, and audit events in first-party UI.
- Packaging: adding the MCP sidecar introduced a multi-binary Cargo package issue where Tauri initially built the wrong binary; `default-run` and explicit `[[bin]]` entries now keep the app and sidecar separate.

## Independent Review Passes

SubAgents were not used because the user did not request parallel agent work. Review was performed in-thread.

- Product fit: passed for the requested pivot from app-only PoC to everyday-AI access. Remaining risk is that real MCP/Relay setup may still be too developer-heavy until installer and pairing flows exist.
- Security/privacy: one material issue was found and fixed. Raw Source body excerpts were initially included in `ContextPack.sourceSnippets`; snippets now use only the approved Fact text, with a regression test.
- Technical design: passed for a product-grade vertical slice. Remaining risk is the temporary JSON snapshot plus normalized projection architecture, which should be replaced by Rust-owned Vault Core commands.
- UX/accessibility: desktop and mobile Browser checks found no horizontal overflow on Home, Connections, Requests, Inbox, and Audit. Keyboard/focus styles remain from the PoC stylesheet and were preserved.
