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
- Added real local MCP stdio sidecar:
  - `life_context.request_context_pack`
  - `life_context.propose_memory`
  - `life_context.get_policy_summary`
  - `life_context.get_request_status`
  - private consequential and sensitive packs are queued for confirmation instead of returned directly
- Added Connections UI setup guidance for Claude Desktop-style MCP configuration.
- Added top-bar native Vault Sync action so the app can reload MCP-written requests or memory proposals while open.
- Added local HTTP MCP relay:
  - `POST /mcp` forwards JSON-RPC to `lcv-mcp`
  - `GET /health`
  - `GET /.well-known/oauth-protected-resource`
  - bearer token required for `/mcp`
  - loopback bind by default
- Added Connections UI setup guidance for local relay endpoint and launch command.
- Kept encrypted JSON backup compatibility through the existing backup flow.

## Still Remaining For Full Product Grade

- Hosted remote MCP relay with public HTTPS, OAuth, pairing, and local Agent websocket.
- Browser extension and Native Messaging capture bridge.
- SQLCipher or equivalent local database encryption with OS keychain-managed keys.
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
- HTTP relay smoke test for `/health`, unauthorized `/mcp`, and authorized `tools/list`
- `npm run tauri:build`
- `npm run tauri:bundle`
- Browser UI checks:
  - desktop `1440x980`: Connections MCP setup card displays without horizontal overflow
  - mobile `390x844`: Connections MCP setup card and code blocks fit without page-level horizontal overflow
  - desktop `1440x980`: Connections HTTP Relay setup card displays endpoint and launch command without horizontal overflow
  - mobile `390x844`: MCP and Relay setup grids stack without page-level horizontal overflow

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
