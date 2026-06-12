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
- Kept encrypted JSON backup compatibility through the existing backup flow.

## Still Remaining For Full Product Grade

- Real local MCP sidecar process.
- Real remote MCP relay with HTTPS `/mcp`, OAuth, pairing, and local Agent websocket.
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
- `npm run tauri:build`
- `npm run tauri:bundle`

`cargo fmt --check` could not run because `cargo-fmt` is not installed for the active stable Apple Silicon toolchain.

## Review Notes

- Product fit: the app now centers on using life context from everyday AI, not only in-app asking.
- Security/privacy: external AI receives Context Packs only; passive capture creates candidates only; TTL purge is implemented for raw capture text.
- Technical design: normalized SQLite tables and FTS are present, but the frontend still persists a JSON snapshot that is projected into tables.
- UX: users can see connections, pending requests, capture status, and audit events in first-party UI.

## Independent Review Passes

SubAgents were not used because the user did not request parallel agent work. Review was performed in-thread.

- Product fit: passed for the requested pivot from app-only PoC to everyday-AI access. Remaining risk is that real MCP/Relay setup may still be too developer-heavy until installer and pairing flows exist.
- Security/privacy: one material issue was found and fixed. Raw Source body excerpts were initially included in `ContextPack.sourceSnippets`; snippets now use only the approved Fact text, with a regression test.
- Technical design: passed for a product-grade vertical slice. Remaining risk is the temporary JSON snapshot plus normalized projection architecture, which should be replaced by Rust-owned Vault Core commands.
- UX/accessibility: desktop and mobile Browser checks found no horizontal overflow on Home, Connections, Requests, Inbox, and Audit. Keyboard/focus styles remain from the PoC stylesheet and were preserved.
