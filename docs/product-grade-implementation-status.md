# Life Context Vault Product-Grade Implementation Status

Last updated: 2026-06-13

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
  - Passive Capture controls and capture history
  - Audit trail
  - AI delivery receipts
- Reworked the local Ask flow into an external-AI-style request flow:
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
  - Source body projection now splits large Source text into deterministic overlapping `source_chunks` instead of storing every Source as a single chunk.
- Added native Vault Core search path:
  - Tauri Search uses encrypted SQLite `facts_fts` for ApprovedFact search
  - domain and sensitivity filters are applied in SQL
  - Search UI shows whether results came from Vault Core FTS or browser fallback
  - native search returns only active ApprovedFacts, never MemoryCandidates or Raw Source body text
  - Tauri open/search resyncs normalized tables and `facts_fts` when `vault_state.updated_at` changed outside the app
- Added Rust-owned Context Pack generation path for the Tauri Control Center:
  - `create_native_context_pack_request` creates the ContextPackRequest, ranks approved Facts from normalized SQLite, applies sensitivity ceilings, writes the short-lived Context Pack, and returns the updated Vault snapshot
  - Tauri Requests uses the native Vault Core path when available and keeps the existing browser-only JS path as fallback
  - Local MCP `life_context.request_context_pack` now calls the same Vault Core path instead of maintaining a separate JSON-snapshot Pack builder
  - native generation includes source snippets only as approved Fact text, never Raw Source body text
  - native generation records policy-limited, sensitive-context, stale, low-confidence, and source-deleted warnings where applicable
- Added Rust-owned Source ingestion path for the Tauri Control Center:
  - `add_native_source_with_candidates` saves background setup, manual notes, and text uploads through Vault Core when Desktop storage is available
  - Source ingestion creates Raw Sources and MemoryCandidates only; it does not create ApprovedFacts
  - Source ingestion writes through the encrypted Vault save path so normalized `sources`, `source_chunks`, and `memory_candidates` stay in sync
  - secret redaction now removes adjacent secret values in both native and browser fallback extraction paths
- Added Rust-owned Candidate review path for the Tauri Control Center:
  - `approve_native_candidate` turns one MemoryCandidate into one ApprovedFact through Vault Core
  - `update_native_candidate_status` handles reject/archive/sensitive review actions without creating Facts
  - Inbox uses the native path when Desktop storage is available and keeps browser fallback only for non-Tauri preview
  - `secret_never_send` candidates cannot be approved as Facts
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
  - `request_context_pack`, `propose_memory`, and `get_request_status` now use shared Rust Vault Core APIs
- Added Connections UI setup guidance for Claude Desktop-style MCP configuration.
- Added top-bar native Vault Sync action so the app can reload MCP-written requests or memory proposals while open.
- Added OAuth-capable HTTP MCP relay and local Vault Agent:
  - `POST /mcp` accepts MCP JSON-RPC over HTTP and validates Streamable HTTP `Content-Type`, `Accept`, and `MCP-Protocol-Version` headers
  - fulfilled MCP `initialize` responses issue memory-only `MCP-Session-Id` values, later POSTs validate client-bound sessions, and `DELETE /mcp` terminates sessions
  - `GET /health`
  - `GET /.well-known/oauth-protected-resource`
  - `GET /.well-known/oauth-authorization-server`
  - `POST /oauth/register`
  - Authorization Code + PKCE endpoints at `/oauth/authorize`, `/oauth/approve`, and `/oauth/token`
  - ChatGPT-style CIMD public-client `client_id` URLs are accepted only for allowlisted public HTTPS metadata hosts and only after cheap OAuth request validation, metadata fetch, and document validation; unsafe URLs, non-allowlisted hosts, mismatched `redirect_uri`, and token exchange client id mismatches are rejected
  - device pairing endpoints at `/pairing/start` and `/pairing/status`
  - local Agent WebSocket endpoint at `/agent/ws`
  - `lcv-agent` forwards paired relay requests to the local encrypted `lcv-mcp` sidecar
  - minimum OAuth scopes are mapped per exposed MCP tool
  - static bearer token fallback remains for local development
  - loopback bind by default
  - OAuth dynamic client registrations are persisted in a relay state store
  - CIMD clients do not create DCR rows; the Relay uses the verified CIMD URL as the OAuth client id and still requires PKCE S256 plus resource binding
  - recent relay request audit metadata is persisted without MCP bodies or Context Pack bodies
  - `GET /relay/state` exposes metadata-only relay status for local Control Center and smoke checks, including MCP session metadata without request bodies
- Added Relay state retention controls:
  - request metadata is pruned by both maximum count and default 30-day retention
  - OAuth client registrations remain durable by default but can be expired through `LCV_RELAY_CLIENT_RETENTION_DAYS` or `LCV_RELAY_CLIENT_RETENTION_SECONDS`
  - relay state persistence keeps metadata-only backup generations using `LCV_RELAY_STATE_BACKUP_COUNT`, defaulting to 3 and allowing 0 to disable backups
  - `/relay/state` exposes retention settings without exposing MCP bodies, Raw Sources, Vault content, or Context Pack bodies
- Added guarded Hosted Relay deployment initialization:
  - `npm run hosted-relay:init` generates `deploy/relay/relay.env` and `deploy/relay/compose.env` from user-provided public host, ACME email, and tenant id
  - generated Relay secrets are random, written with private file permissions, and never printed to the terminal
  - the initializer refuses accidental overwrites unless `--force` is passed, supports `--dry-run`, and immediately runs the hosted Relay config checker
  - product release checks now validate both the initializer syntax and a dry-run generated config
- Added Relay tenant isolation controls:
  - loopback development defaults to `LCV_RELAY_TENANT_ID=local`
  - non-loopback binds require explicit `LCV_RELAY_TENANT_ID`
  - persisted relay state stores the tenant id and refuses to load if configured for a different tenant
  - legacy tenantless local relay state migrates to the configured tenant on load
  - `/health` and `/relay/state` expose tenant id as operational metadata without exposing Vault or Context Pack bodies
- Added short-lived Relay Context Pack handoff cache:
  - `POST /relay/handoff` accepts signed, already confirmed MCP responses for approved Context Packs
  - handoff responses are memory-only, TTL-bound, and default to 10 minutes
  - the Relay accepts only fulfilled `ContextPack only` MCP responses
  - accepted handoffs are canonicalized before memory caching so stray Raw Source, Vault snapshot, unapproved Candidate, or tool-result fields cannot ride along with an otherwise valid signed payload
  - `life_context.get_request_status` can return a cached handoff response when the local Agent path is temporarily offline
  - `/relay/state` exposes only handoff metadata and retention settings, never Pack body text
  - relay state persistence and metadata backups still exclude Context Pack bodies
- Added Connections UI setup guidance for OAuth relay, pairing, local Agent, connector URLs, and Remote MCP diagnostics.
- Added app-managed AI Access Service in the Tauri Control Center:
  - `AI連携を開始` launches bundled `lcv-relay` and `lcv-agent`
  - app requests a pairing code and connects Agent automatically
  - status shows Relay reachability, Agent connection, managed process state, and MCP URL
  - the top AI Access panel exposes a copyable MCP URL for connector setup
  - the Remote Relay setup section exposes copyable health and Streamable HTTP `/mcp` smoke-test commands
  - diagnostics distinguish reachable Relay, expected OAuth `401`, and header-contract `406/415` failures
  - external relays are status-only; the app does not automatically attach the local Agent to a relay it did not start
  - `管理中の連携を停止` only stops processes started by the app
  - closing the app window hides Control Center into the menu bar/system tray and keeps app-managed Relay and Agent running
  - `Quit Life Context Vault` from the menu bar/system tray stops app-managed Relay and Agent before process exit
  - `npm run tauri:bundle` embeds `lcv-mcp`, `lcv-relay`, `lcv-agent`, and `lcv-capture-host`
- Added always-available AI Access operations:
  - Connections can install/remove a macOS LaunchAgent login item for Life Context Vault
  - Startup item generation now supports macOS LaunchAgent, Windows Startup folder command, and Linux XDG autostart desktop entry paths
  - the login item starts only the app binary and does not persist Vault, MCP, or Context Pack bodies
  - a separate local runtime preference can auto-start Relay and Agent when the app opens
  - the UI makes login launch and AI Access auto-start distinct from Context Pack approval
- Added first-run AI access launchpad UX:
  - Home now shows a four-step "First 10 minutes" checklist: add life background, approve memory candidates, try a Context Pack, and then make AI connection setup repeatable
  - Home now prioritizes one actionable next step above the checklist, such as reviewing pending MemoryCandidates before asking users to inspect status panels
  - Guided background setup appears before the long Background Snapshot so first-time users can start adding life context without scrolling through existing memories
  - mobile navigation switches to icon-first controls with accessible labels, hiding secondary stats so the first action and setup form appear much earlier
  - Connections now shows a natural-language readiness panel explaining whether the desktop app, Relay, Agent, and Context Pack boundary are ready
  - Connections now includes a compact connection diagnostics receipt that shows Desktop Vault, Relay, Local Agent, and Web AI readiness with the next action in one place
  - Hosted Relay diagnostic errors are redacted before display so pairing codes and bearer tokens do not appear in the Control Center
  - Home now exposes Capture safety status, allowed-site summary, recent Capture state, one-click Pause/Start, and purge/detail actions without leaving the first daily control surface
  - the same readiness logic is reused across Home and Connections to avoid contradictory user guidance
- Added Claude Desktop setup installer:
  - Connections can install the `life-context-vault` stdio MCP server into Claude Desktop config from the desktop app
  - existing `mcpServers` are preserved, existing config is backed up, and invalid JSON is refused without overwrite
  - manual copy remains as a fallback and uses the native app's resolved sidecar path when available
- Added live native Vault sync for external AI writes:
  - native vault state now exposes `updatedAt` metadata to the frontend
  - the Control Center polls the encrypted native Vault and imports changes written by MCP sidecars, Remote Relay Agent calls, or browser capture
  - incoming pending Context Requests are selected automatically so the user can confirm or deny them from **Requests**
  - legacy `vault_state` tables without `updated_at` are backfilled on open by the app, MCP sidecar, and capture host
  - app writes now include an expected `updatedAt` revision and return a conflict instead of overwriting newer external AI writes
  - frontend conflict handling merges external records with local edits by stable record id before saving again
- Added AI-bound Context Pack approval UX:
  - Requests separates "approve so the external AI can retrieve this Pack" from local PoC answer generation
  - confirmed Packs can be copied as an AI-bound payload for non-MCP clients
  - when Clipboard write fails, Requests shows the explicit AI-bound payload for manual copy and lets the user record the manual delivery receipt after copying
  - copied and MCP-returned payloads are explicitly marked `ContextPack only` and omit local answer/audit internals
  - request details show client, purpose, expiry, sensitivity ceiling, and fulfillment status
- Added Rust-owned AI-bound Context Pack minimization path:
  - `update_native_context_pack_item_visibility` lets users remove or restore individual Fact items before a Pack is confirmed
  - removed items stay visible as `user_hidden` exclusions while Pack items, source snippets, warnings, and max sensitivity are recalculated
  - `confirm_native_context_pack` and `deny_native_context_pack_request` move external-AI approval decisions through Vault Core
  - Requests shows the exact number of Fact items/snippets scheduled for sending and exposes per-item "do not send to this AI" controls
- Added Chrome browser capture extension and Native Messaging host:
  - Manifest V3 extension under `browser-extension/`
  - popup-triggered capture for ChatGPT, Claude, and Gemini
  - native host `lcv-capture-host`
  - capture writes `passive_capture` Source, `PassiveCaptureEvent`, and unapproved Inbox candidates through shared Rust Vault Core
  - host refuses capture unless Passive Capture is enabled and the site is allowed
  - the host no longer owns extraction, redaction, persistence, or audit logic; it only adapts the Native Messaging protocol to Vault Core
- Added Browser Capture host installer:
  - Connections accepts the unpacked Chrome extension id and installs the Chrome Native Messaging host manifest from the desktop app
  - extension ids are validated before writing
  - existing host manifests are backed up before replacement
  - manual command copy remains as fallback
- Added Rust-owned Passive Capture path for the Tauri Control Center:
  - `add_native_passive_capture_event` saves manual/demo Capture through Vault Core when Desktop storage is available
  - browser-only preview keeps the TypeScript fallback
  - Capture creates Sources, PassiveCaptureEvents, Candidates, and audit records, but never ApprovedFacts
  - allowed-site checks are enforced by Vault Core for browser captures, while local Codex/MCP capture uses an explicit `lcv-local://` boundary
- Added Rust-owned policy/settings update path for the Tauri Control Center:
  - `update_native_passive_capture_settings` saves Capture on/off, retention days, and allowed AI sites through Vault Core
  - `update_native_access_policy` saves per-client sensitivity ceilings and confirmation thresholds through Vault Core
  - Connections now lets users edit AI-bound sensitivity policy instead of only reading policy values
  - Capture allowed sites can be edited from the Passive Capture card and are normalized to host names before persistence
- Added client AccessPolicy enforcement in Context Pack generation:
  - per-client `domainAllowlist` is enforced by both Rust Vault Core and the browser fallback Pack builder
  - per-client `requiresApprovalAbove` controls whether a generated Pack must pause for user confirmation
  - domain-limited Facts are recorded as `domain_policy` exclusions and contribute to policy-limited warnings without becoming AI-bound Pack items
- Added general-user AccessPolicy domain controls:
  - Connections now exposes a per-AI checklist for the life domains that may enter Context Pack-capable AI clients; browser Capture is not shown this outbound-AI control
  - quick actions can restore all domains or apply a clearer conservative preset that excludes identity/profile, health/care, finance/benefits, and accessibility/constraint context
  - TypeScript fallback, Tauri command, and Rust Vault Core all persist `domainAllowlist`; empty, unknown, or mixed-invalid domain lists cannot widen access
  - policy updates cancel existing short-lived Packs for that client, expire the associated requests, and re-check the current policy before Pack confirmation/copy/status handoff
  - policy update audit metadata records the domain allowlist, count, and invalidated Pack count
- Added Rust-owned Source lifecycle path for the Tauri Control Center:
  - `update_native_source_lifecycle` supports soft delete, restore, and Raw body purge through Vault Core
  - Source deletion archives unapproved candidates from that Source and marks linked active Facts as `needs_review`
  - Source deletion or body purge cancels existing Context Packs that included affected Facts so external AI cannot retrieve stale Packs again
  - Sources now shows Source state, body retention state, linked candidate/Fact counts, and lifecycle actions in the Control Center
- Added Rust-owned Source metadata editing path for the Tauri Control Center:
  - `update_native_source_metadata` updates Source title, default sensitivity, and passive-capture long-term retention through Vault Core
  - editing Source metadata refreshes normalized Source projection and cancels Context Packs that included linked Facts
  - Source titles in Context Pack items are now filtered by Source deletion state, sensitivity ceiling, and `secret_never_send`
  - Sources rows expose a compact edit form so users can correct provenance labels and keep important passive captures before TTL purge
- Added Rust-owned Source body re-extraction path for the Tauri Control Center:
  - `update_native_source_body` updates Raw Source text through Vault Core with secret redaction before persistence
  - body edits archive old unapproved candidates from that Source and regenerate MemoryCandidates only
  - linked active Facts move to `needs_review` with `source_updated` metadata instead of being silently rewritten
  - existing Context Packs that included affected Facts are cancelled before an external AI can reuse stale Pack contents
  - Sources rows expose a body edit form with explicit copy that saving re-extracts candidates and sends linked Facts back to review
- Added Rust-owned Fact lifecycle path for the Tauri Control Center:
  - `update_native_fact_lifecycle` supports keep active, mark needs review, hide, delete, and restore through Vault Core
  - hiding, deleting, or moving a Fact to review cancels existing Context Packs that included that Fact
  - Search now surfaces a review queue for `needs_review` Facts with keep, hide, and delete actions
  - active search results expose hide/delete actions so users can control what remains eligible for Context Packs
- Added Rust-owned Fact metadata editing path for the Tauri Control Center:
  - `update_native_fact_metadata` updates canonical Fact text, domain, sensitivity, and date metadata through Vault Core
  - editing a Fact refreshes normalized Facts/FTS projection and cancels existing Context Packs that included that Fact
  - Search active and review Fact rows now expose a compact edit form so users can correct life context without recreating Sources
- Added Fact supersede/version-history path for Candidate approval:
  - `approve_native_candidate` can receive selected active Fact ids to supersede while creating one new ApprovedFact
  - new Facts record `supersedesFactIds`; old Facts move to `superseded` with `supersededByFactId`
  - Context Packs containing superseded Facts are cancelled before external AI can reuse old context
  - Inbox shows same-domain active Facts as explicit replacement choices, and Search shows superseded Facts in a separate human-only history section
- Added conservative automatic conflict annotation for MemoryCandidates:
  - new Source, Passive Capture, and MCP memory proposal candidates compare domain, detected date, and key terms against active Facts
  - current-value anchors also catch likely replacements for current address, provider, employer, phone, and email even when the candidate has no explicit date
  - conflicting candidates persist `conflictWithFactIds` and `conflictReason` in the JSON snapshot and normalized `memory_candidates` table
  - Inbox shows a conflict badge, warning copy, and prioritizes the suspected old Fact in the explicit replacement choices
  - Source body re-extraction moves linked Facts to `needs_review` before conflict annotation so regenerated candidates do not self-conflict against the same edited Source
- Added safe text-upload guard for document Sources:
  - Browser-only upload now accepts only text-like formats within the local extraction size ceiling
  - unreadable binary content, images without OCR, legacy Office binaries without a configured local converter, unsupported files, and oversized files are rejected before RawSource or MemoryCandidate creation
  - the Upload card explains the safe fallback to Manual source text when local extraction or OCR/provider extraction is unavailable
- Added native document extraction for Desktop uploads:
  - PDF, DOCX, PPTX, XLSX, and OpenDocument files are extracted locally through a Tauri Vault boundary before Source creation
  - extracted document text flows into the existing RawSource -> MemoryCandidate path and still never creates ApprovedFacts automatically
  - native extraction rejects images without OCR Provider, legacy Office binaries without a configured local converter, unsupported archives, unreadable files, zip-entry overages, and oversized uploads before RawSource creation
  - Upload UX now explains local PDF/Office extraction separately from OCR/provider gaps
- Added explicit local OCR provider support for Desktop image uploads:
  - images remain blocked by default unless an OCR command is configured in Settings or `LCV_OCR_COMMAND`
  - OCR runs as a local command without shell expansion and receives an input temp file
  - `LCV_OCR_ARGS` supports placeholders such as `{input}`, `{mime}`, and `{file_name}`
  - Settings exposes OCR command, arguments, and timeout for non-terminal setup
  - OCR output must be UTF-8 text on stdout and is normalized through the same Source -> MemoryCandidate path
  - OCR execution is timeout-bounded by `LCV_OCR_TIMEOUT_SECONDS`, defaulting to 30 seconds
  - Upload UI shows whether image OCR is currently available and still explains that extracted text creates only Inbox candidates
- Added explicit large-scale retrieval benchmark coverage:
  - ignored Rust benchmark seeds an encrypted SQLite Vault with 100,000 ApprovedFacts and 500,000 SourceChunks by default
  - benchmark measures Vault Core FTS search and Context Pack generation on the same normalized schema used by the app and MCP sidecars
  - `npm run retrieval:bench` runs the benchmark without adding cost to normal test runs
  - `LCV_BENCH_FACTS` and `LCV_BENCH_CHUNKS_PER_FACT` can reduce or expand the synthetic dataset for local profiling
- Added product release qualification commands:
  - `npm run product:check` runs frontend tests/build, Rust tests, Rust release binary build, format check when rustfmt is installed, and `git diff --check`
  - `npm run product:check:full` additionally runs the Tauri sidecar integration build, local SSE soak, and large retrieval benchmark
  - `product:check` can run smaller benchmark profiles through `-- --include-bench --bench-facts <n> --bench-chunks-per-fact <n>`
  - `product:check` also validates the documented hosted Relay configuration baseline, while real deployed endpoints use `npm run hosted-relay:smoke`
- Added GitHub Actions product qualification workflow:
  - `.github/workflows/product-check.yml` runs `npm run product:check` on pull requests and pushes to `main`/`master`
  - scheduled weekly runs and manual `workflow_dispatch` can include a bounded retrieval benchmark profile
  - workflow summaries and an uploaded `product-check.log` preserve release-check and benchmark output for review
- Added hosted Relay deployment artifacts:
  - `deploy/relay/Dockerfile` builds a relay-only container with direct Vault sidecar fallback disabled
  - `.dockerignore` excludes local Vault databases, relay state, build output, and dependency noise from container context
  - `scripts/check-hosted-relay-config.mjs` validates the hosted Relay environment boundary: public HTTPS origin, no direct sidecar/Vault settings, no static bearer fallback, no hosted auto-approve, long admin/handoff secrets, exact HTTPS CORS origins, tenant id, durable metadata path, and hosted handoff TTL at or below 600 seconds
  - `scripts/hosted-relay-smoke.mjs` verifies a deployed HTTPS Relay health, OAuth metadata, protected-resource metadata, trusted/untrusted CORS behavior, OAuth challenge behavior, optional staging OAuth registration/owner-approval/PKCE/authenticated MCP when an admin token is supplied, and metadata-only `/relay/state`
  - `docs/hosted-relay-deployment.md` defines required public HTTPS settings, durable metadata volume, automated/manual smoke tests, token rotation, and incident runbooks
  - hosted deployment guidance keeps the relay metadata-only and requires local Agent/Vault access for real Context Pack generation
- Added release-gated HTTP Relay smoke:
  - `npm run relay:smoke` starts release `lcv-relay` and `lcv-mcp` on a random loopback port with a temporary encrypted Vault
  - the smoke checks health, method boundary, CORS, OAuth challenge, header-contract failures, MCP session issue/reuse/delete, dynamic OAuth client registration, unsafe redirect rejection, approval-page consent, S256 PKCE token exchange, wrong-verifier/resource/code-reuse rejection, insufficient-scope `403`, OAuth bearer `tools/list`, and metadata-only relay persistence
  - persisted relay state is asserted to keep registered OAuth client metadata while excluding MCP tool responses, MCP session ids, OAuth access tokens, authorization codes, and PKCE verifiers
  - `npm run product:check` now runs the smoke after release sidecar binaries are built
- Added local SSE soak coverage:
  - `npm run relay:sse-soak` opens repeated authenticated Streamable HTTP receive channels against release `lcv-relay`
  - the soak verifies ready events, generated-event-id resume, unknown-cursor non-storage/non-echo, bounded recent SSE diagnostics, and metadata-only persisted state
  - `npm run product:check:full` includes the soak for release candidates, while `product:check` keeps the default loop bounded
- Added Streamable HTTP SSE receive-channel support:
  - `GET /mcp` now returns an authenticated `text/event-stream` ready event for clients that open the MCP receive channel
  - `Last-Event-ID` is accepted for compatibility; generated Relay SSE event ids can resume the same client/session stream inside the bounded in-memory metadata window
  - unknown client-provided `Last-Event-ID` values are acknowledged as received but not stored or echoed
  - the ready event declares `resumeSupported: true`, `replayPolicy: metadata_only_per_stream_replay`, and whether the cursor was recognized
  - relay state and persisted metadata remain body-free and exclude client-provided SSE cursor values
  - ready SSE events now carry a generated `mcp_sse_*` event id and the Relay exposes metadata-only recent SSE event diagnostics plus replay policy without storing Context Pack, MCP response, Raw Source, or tool-result bodies
- Added Universal AI Access readiness UX:
  - Connections now shows the MCP endpoint, Remote/Local/Copy access routes, Context Pack boundary, and readiness checklist in one first-screen panel
  - Remote Relay diagnostics include an SSE ready check alongside health and POST header checks
  - the older duplicate Connection readiness panel was removed so users reach AI Access Service and connector policy controls faster
- Added local Legacy Office conversion provider support:
  - `.doc`, `.xls`, and `.ppt` remain blocked by default, but can be accepted when the user configures a local LibreOffice/soffice-style conversion command
  - conversion runs locally in a private temp directory, then the converted DOCX/PPTX/XLSX/PDF output goes through the existing native extraction and Memory Inbox review flow
  - Settings now includes OS-specific LibreOffice install commands, safe default conversion arguments, and clear/copy actions
- Added guided Legacy Office provider detection:
  - Desktop detects installed LibreOffice/soffice candidates from PATH and common install locations without executing them
  - Settings shows detected candidates with one-click command/argument/timeout setup and explains that detection does not run LibreOffice or send documents
- Added security hardening from adversarial review:
  - external MCP requests now default to user review even for low-sensitivity Context Packs
  - confirmed Context Packs expire at `expiresAt` and are not returned after TTL
  - Relay handoff now requires a Vault-generated HMAC signature, confirmed Context Pack status, matching request/client metadata, and unexpired pack expiry
  - Relay HTTP parsing now enforces header/body size limits and read timeouts
  - Agent pairing codes are single-use and Agent logs redact `pairing_code`
  - OCR/Legacy Office provider output is drained concurrently with bounded buffers, and temporary document directories are cleaned on failure
  - plaintext Vault migration backups are deleted after verified encrypted migration by default
- Kept encrypted JSON backup compatibility through the existing backup flow.
- Strengthened encrypted JSON backups:
  - new browser fallback exports use PBKDF2-SHA256 with 600,000 iterations
  - restore remains compatible with legacy 120,000-iteration backups and legacy backups that omitted the iteration count
  - Settings explains the passphrase risk and requires a longer mixed-character backup passphrase before export

## Still Remaining For Full Product Grade

- Hosted operations outside this repository: actual public HTTPS Relay domain, DNS, platform secret store, persistent volume, backups, uptime monitoring, and provider registration against the real `/mcp` endpoint.
- Bundled OCR and Office conversion runtimes for users who do not want to install Tesseract or LibreOffice separately.
- CIMD hardening for custom host allowlists if provider certification requires connect-time IP pinning, metadata caching, fetch rate limiting, `private_key_jwt`, or confidential-client assertions; the current Relay supports allowlisted public-client CIMD metadata document validation with PKCE/resource binding plus DCR fallback.
- Provider-assisted semantic conflict detection, multi-Fact merge, and entity-level versioning beyond the current deterministic date/current-value Candidate conflict annotation and explicit supersede flow.
- Hosted CI threshold tuning after real runner history accumulates; the 100k Fact / 500k SourceChunk benchmark remains an explicit local release-candidate check because of dataset size.
- Remote MCP hosted-client certification and provider-specific long-lived SSE behavior if certification requires more than the current metadata-only resume window and session lifecycle.

## Verification

- `npm test`
- `npm run build`
- `cargo test` in `src-tauri`
- `cargo build` in `src-tauri`
- `npm run mcp:build`
- Claude Desktop config merge unit test preserving existing MCP servers
- Context Pack approval tests proving external-AI confirmation does not create a local answer and AI-bound payloads omit internal fields
- stdio MCP smoke test for `initialize`, `tools/list`, and `life_context.propose_memory`
- `npm run relay:build`
- `npm run agent:build`
- `npm run sidecars:prepare`
- MCP sidecar smoke test for external `request_context_pack` persistence and `get_request_status` lookup against the same encrypted Vault
- stdio MCP binary smoke test for shared-core `life_context.request_context_pack` returning a `ContextPack only` payload
- HTTP relay smoke test for `/health`, OAuth metadata, unauthorized `/mcp`, authorized `tools/list`, encrypted direct fallback writes, paired Agent WebSocket writes, persisted OAuth client reload, and metadata-only `/relay/state`
- Relay retention tests proving old request metadata is pruned by TTL and OAuth client registrations are pruned only when a client TTL is configured
- Relay state backup tests proving metadata-only backup generations are rotated without storing Context Pack bodies
- Relay tenant tests proving non-loopback binds require tenant id, mismatched tenant state is refused, and legacy tenantless metadata migrates to the configured tenant
- Relay handoff tests proving only fulfilled `ContextPack only` responses are accepted, `/relay/state` omits Pack body text, and offline `get_request_status` can return a still-valid cached handoff
- Relay handoff signature tests proving unsigned/spoofed handoffs are rejected before short-lived cache storage
- Relay HTTP parser tests proving oversized request bodies and headers are rejected before unbounded allocation
- MCP tests proving low-sensitivity external Context Packs are queued for user confirmation instead of auto-returned
- Native Context Pack expiry tests proving confirmed-but-expired Packs are not returned to external clients
- Provider execution tests proving noisy OCR/Office providers do not deadlock on pipe output and failed conversion removes temp directories
- Vault encryption migration tests proving plaintext migrated database backups are removed after successful encrypted migration
- macOS login item plist unit tests for app-binary-only launch, `RunAtLoad`, `KeepAlive=false`, XML escaping, and no Vault key or Context Pack payload fields
- Windows Startup command and Linux XDG desktop-entry unit tests proving startup helpers run only the current app binary and do not include Vault keys or Context Pack payloads
- Background lifecycle unit tests proving window close hides to tray without stopping managed AI Access, while window destruction/quit still stops managed Relay and Agent
- Bundled sidecar smoke test from `Life Context Vault.app/Contents/MacOS` for Relay -> Agent -> MCP `tools/list`
- `npm run capture:build`
- Chrome Native Messaging host manifest generation unit tests for extension id validation and allowed origin shape
- Native Messaging host smoke test for disabled capture refusal and enabled capture candidate generation
- SQLCipher tests for encrypted DB plain-read refusal and plaintext PoC DB migration
- Native Vault FTS tests proving active ApprovedFact-only search, SQL-side filters, and escaped user query terms
- Native projection-state tests proving MCP/Relay-style external `vault_state` writes are projected into normalized tables/FTS and app saves mark the projected revision
- Native Context Pack tests proving only ApprovedFacts are included, unapproved candidates are ignored, Raw Source body text is not copied into snippets, and facts above the client sensitivity ceiling are excluded
- Native Context Pack minimization tests proving user-hidden items are removed from the AI-bound Pack, retained as exclusions, and remain absent after confirmation and `get_request_status`
- Native Source ingestion tests proving Source upload/manual/background-style writes create Candidates but not Facts, sync normalized Source/Candidate tables, and redact secret values before persistence
- Upload guard tests proving text-like files are accepted, native PDF/Office files require Desktop extraction, OCR images require a provider unless configured, legacy Office binaries require a converter unless configured, and oversized files are rejected before Source creation
- Native document extraction tests proving DOCX XML text can be extracted locally, image OCR is refused without a provider, and a configured local OCR command can provide image text without creating ApprovedFacts
- Native Legacy Office conversion tests proving `.doc` remains blocked without a converter and a configured local converter produces extracted text without creating ApprovedFacts
- Native provider detection tests proving OCR and Legacy Office candidates are discovered from PATH/common paths without executing the provider
- Native Source lifecycle tests proving Source soft delete marks linked Facts as `needs_review`, invalidates affected Context Packs, removes Fact search results, and body purge blocks later candidate approval
- Native Source metadata tests proving metadata edits invalidate affected Context Packs, sync normalized Source projection, and prevent `secret_never_send` Source titles/snippets from entering new Context Packs
- Native Source body re-extraction tests proving body edits regenerate MemoryCandidates, move linked Facts to `needs_review`, invalidate affected Context Packs, and refresh normalized search/source projection
- Native Fact lifecycle tests proving hidden Facts invalidate affected Context Packs and disappear from search, while kept review Facts become active again
- Native Fact metadata tests proving edits sync FTS, clear blank date fields, reject `secret_never_send`, and invalidate affected Context Packs
- Native Candidate review tests proving candidate approval creates one ApprovedFact and FTS row, status updates do not create Facts, and `secret_never_send` candidates are not approvable
- Native Candidate supersede tests proving approval can mark selected old Facts as `superseded`, write version links, invalidate affected Context Packs, and keep superseded Facts out of active search
- Native Candidate conflict tests proving new conflicting candidates record active Fact ids/reasons, remain unapproved, and do not change the old Fact, including current-value conflicts without dates
- Native Passive Capture tests proving paused/site-blocked captures do not write events, accepted captures create Sources/Events/Candidates but not Facts, redact secret values, and sync normalized capture tables
- Native Policy/settings tests proving Capture settings normalize allowed sites and audit changes, and AccessPolicy updates sync normalized policy tables
- Native and browser fallback Context Pack tests proving client domain allowlists exclude disallowed Facts, `requiresApprovalAbove` changes confirmation status, request ceilings cannot widen client policy, malformed policy sensitivity values fail closed, and domain-limited Facts cannot be restored into edited Packs
- Native and browser fallback policy update tests proving per-client domain allowlists persist, deduplicate, audit their count, reject empty/unknown/mixed-invalid domain updates without widening access, fail closed for corrupted empty persisted allowlists, and invalidate existing Packs before later confirmation or retrieval
- MCP Context Pack tests proving `request_context_pack` uses the shared Vault Core path for sensitive queued Packs and low-risk returned Packs without Raw Source body leakage
- MCP shared Core tests proving `propose_memory` creates Candidates but not Facts, `get_request_status` strips internal Pack fields, and confirmed Packs are hidden from clients that do not own the original request
- Agent tests proving Remote Relay client identity is forwarded to the MCP sidecar as trusted runtime metadata
- Entry-point smoke tests proving MCP, Relay, and Capture-created Vault DBs are not readable as plaintext SQLite
- Large retrieval benchmark: `npm run retrieval:bench` on 2026-06-12 seeded 100,000 Facts and 500,000 SourceChunks in 1786.4ms, measured FTS P95 at 160.9ms, and measured Context Pack generation P95 at 63.6ms, below the 300ms / 1000ms targets
- Product release check wrapper covering standard app/Rust/release-binary checks and optional full Tauri + retrieval benchmark qualification
- GitHub Actions product check workflow for PR/push checks plus weekly/manual bounded retrieval benchmark runs
- Hosted Relay Dockerfile and deployment runbook with metadata-only state, token rotation, incident response, and smoke-test guidance
- `npm run tauri:build`
- `npm run tauri:bundle`
- Bundle inspection confirmed `lcv-mcp`, `lcv-relay`, `lcv-agent`, and `lcv-capture-host` are embedded under `Life Context Vault.app/Contents/MacOS`.
- Browser UI checks:
  - desktop `1440x980`: Connections MCP setup card displays without horizontal overflow
  - mobile `390x844`: Connections MCP setup card and code blocks fit without page-level horizontal overflow
  - desktop `1440x980`: Connections Remote MCP Relay setup displays OAuth, pairing, Agent, and connector details without horizontal overflow
  - mobile `390x844`: MCP and Remote Relay setup grids stack without page-level horizontal overflow
  - desktop `1440x980`: Connections browser extension setup card displays native host instructions without horizontal overflow
  - mobile `390x844`: extension setup code blocks fit without page-level horizontal overflow
  - desktop `1280x720`: Browser Capture host installer card accepts an extension id without page-level horizontal overflow
  - mobile `390x844`: Browser Capture host installer card, invalid-id help, and disabled install button fit without page-level horizontal overflow
  - desktop `1280x720`: Connections background-mode automation card appears with three automation cards and no page-level horizontal overflow
  - mobile `390x844`: Connections background-mode automation cards stack to one column without page-level or card-level horizontal overflow
  - desktop `1280x720` and mobile `390x844`: Connections Remote Relay command includes `LCV_RELAY_TENANT_ID=local` inside the code block without page-level horizontal overflow
  - desktop `1280x900`: Connections manual Capture can start Passive Capture, create an Inbox candidate, and keep Facts at zero
  - mobile `390x844`: Connections Capture surfaces render without page-level horizontal overflow
  - desktop `1280x920`: editable policy controls and Capture allowed-site controls render and update without page-level horizontal overflow
  - mobile `390x844`: editable policy controls stack to one column without page-level horizontal overflow
  - desktop `1280x920`: Sources lifecycle controls show active/stopped state, linked counts, restore/body-purge actions, and no page-level horizontal overflow
  - mobile `390x844`: Sources lifecycle row stacks badges and actions without page-level horizontal overflow
  - desktop `1280x920`: Sources metadata edit form updates title/sensitivity/long-term retention and returns to the Source row without page-level horizontal overflow
  - mobile `390x844`: Sources metadata edit form stacks fields and lifecycle actions without page-level horizontal overflow
  - desktop `1280x720`: Sources body edit form is accessible by label, saves edited body text, regenerates one candidate, moves the linked Fact to the Search review queue, and has no page-level horizontal overflow
  - mobile `390x844`: Sources body edit form keeps textarea, warning copy, and action buttons inside the row without page-level horizontal overflow
  - desktop `1280x720`: Sources upload card shows the safe text-file boundary and accepted extension contract without page-level or card horizontal overflow
  - mobile `390x844`: Sources upload card, accepted format label, and unsupported-file explanation stack without page-level or card horizontal overflow
  - desktop `1280x720`: Inbox replacement choices show same-domain active Facts, switch the save button to "置き換えて保存", and save one new Fact while moving the old Fact into Search history without page-level overflow
  - mobile `390x844`: Inbox replacement panel and action buttons stack without page-level, card, or panel horizontal overflow
  - desktop `1280x720`: Inbox conflicting candidate shows `衝突候補`, conflict warning, old/new renewal dates, and switches to "置き換えて保存" after selecting the suspected old Fact without page/card/panel horizontal overflow
  - mobile `390x844`: Inbox conflicting candidate, replacement panel, and action buttons stack without page-level, card, panel, or button horizontal overflow
  - mobile `390x844`: Search version-history panel and superseded Fact rows render without page-level or row horizontal overflow
  - desktop `1280x920`: Search review queue shows `needs_review` Facts with keep/hide/delete actions, and keep moves the Fact back into active results without page-level horizontal overflow
  - mobile `390x844`: Search review queue and active Fact lifecycle actions stack without page-level horizontal overflow
  - desktop `1280x920`: Search Fact edit form keeps the form open on empty text, updates text/domain/sensitivity/date metadata, and returns to the result row without page-level horizontal overflow
  - mobile `390x844`: Search Fact edit form stacks fields and actions without page-level horizontal overflow
  - desktop `1280x720`: AI Access operations controls for login launch and auto-start fit without page-level horizontal overflow
  - mobile `390x844`: AI Access operations controls stack to one column without page-level horizontal overflow
  - desktop `1280x720`: Search mode row and filters display without page-level horizontal overflow
  - mobile `390x844`: Search mode row and filters stack without page-level horizontal overflow
  - desktop `1280x920`: Requests Context Pack minimization removes one Fact, shows `user_hidden` restore controls, and has no page-level or internal horizontal overflow
  - mobile `390x844`: Requests Context Pack minimization stacks send/remove/restore controls without page-level or internal horizontal overflow
  - desktop `1280x720`: Home first-run launchpad and Connections readiness panel have no page-level horizontal overflow
  - mobile `390x844`: Home first-run launchpad and Connections readiness panel stack to one column without page-level horizontal overflow
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
- Technical design: normalized SQLite tables, native FTS search, shared Rust-owned Source ingestion, Source lifecycle, Source metadata editing, Source body re-extraction, Fact lifecycle, Fact metadata editing, explicit Fact supersede/version history, conservative Candidate conflict annotation, Candidate review, Passive Capture, Policy settings, Context Pack generation, MCP memory proposal, and MCP request status are present, while semantic conflict merging and advanced multi-Fact/entity versioning remain future work.
- Context Pack Core: Tauri Requests and local MCP `request_context_pack` both use the same Vault Core generation path from normalized SQLite.
- External sync: native FTS is protected against stale projection after MCP/Relay-style writes by comparing `vault_state.updated_at` with `projection_state`.
- UX: users can see connections, pending requests, capture status, and audit events in first-party UI.
- Packaging: adding the MCP sidecar introduced a multi-binary Cargo package issue where Tauri initially built the wrong binary; `default-run` and explicit `[[bin]]` entries now keep the app and sidecar separate.
- Passive Capture review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Passive Capture product review: accepted; manual/demo Capture, browser extension Capture, and local AI Capture now share one Vault Core path while preserving the Inbox-first user promise.
- Passive Capture security review: accepted after fixing the `copy_fallback` local URL allowlist mismatch; paused captures, unallowed browser sites, secrets, and Fact creation are covered by tests.
- Passive Capture technical review: accepted; capture host no longer duplicates extraction, redaction, persistence, or audit logic, and normalized capture tables are synced by the same encrypted save path.
- Passive Capture UX review: accepted; desktop and mobile Connections surfaces render without page-level horizontal overflow, and manual Capture produces an Inbox candidate with zero Facts.
- Policy Settings review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Policy Settings product review: accepted; users can now adjust AI-bound sensitivity policy and Capture allowed sites from Connections instead of reading fixed policy values.
- Policy Settings security review: accepted; Capture site input is normalized to host names, empty allowlists are rejected by Vault Core, and every policy/settings update writes an audit event.
- Policy Settings technical review: accepted; Tauri policy/settings writes now use shared Vault Core commands and sync normalized `access_policies` plus audit projection.
- Policy Settings UX review: accepted; controls preserve the existing card density, avoid `secret_never_send` as a selectable AI-bound ceiling, and stack cleanly on mobile.
- Source Lifecycle review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Source Lifecycle product review: accepted; users can now stop, restore, or purge Source body text while seeing whether the Source has linked candidates and Facts.
- Source Lifecycle security review: accepted; deleted or purged Sources immediately remove linked active Facts from search/Context Pack retrieval and block later approval of stale candidates.
- Source Lifecycle technical review: accepted; lifecycle writes go through Vault Core, sync normalized Source/Fact/Candidate/Context Pack projections, and invalidate AI-bound Packs that included affected Facts.
- Source Lifecycle UX review: accepted; desktop and mobile Sources lifecycle rows render without page-level horizontal overflow, and stop/restore/body-purge actions remain visible without crowding the upload/manual Source panels.
- Source Metadata review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Source Metadata product review: accepted; users can now correct provenance labels and promote important passive captures to long-term retention without touching Raw Source body text.
- Source Metadata security review: accepted; Source title exposure is filtered by Source sensitivity/deletion state, and metadata edits invalidate existing Context Packs with stale provenance.
- Source Metadata technical review: accepted; Source metadata writes go through Vault Core, sync normalized Source projection, audit `source_updated`, and share the same Pack invalidation guard as Source lifecycle.
- Source Metadata UX review: accepted; desktop and mobile Sources metadata edit forms render without page-level horizontal overflow, and the long-term retention checkbox stays compact inside the existing row pattern.
- Source Body Re-extraction review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Source Body Re-extraction product review: accepted; users can now correct captured or uploaded Source text and get fresh Inbox candidates without silently changing approved life context.
- Source Body Re-extraction security review: accepted; body edits re-run secret redaction, keep regenerated memories as unapproved candidates, move linked Facts out of AI retrieval, and cancel affected Context Packs.
- Source Body Re-extraction technical review: accepted; Source body writes go through Vault Core, sync normalized Sources/Candidates/Facts/FTS/Context Pack projections, and audit `source_updated` plus regenerated candidates.
- Source Body Re-extraction UX review: accepted after adding explicit `label`/input associations; desktop and mobile Sources body edit forms render without page-level horizontal overflow and clearly warn about re-extraction/review effects.
- Fact Lifecycle review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Fact Lifecycle product review: accepted; review-needed Facts are no longer invisible after Source deletion, and active Facts can be removed from future AI context from the Search surface.
- Fact Lifecycle security review: accepted; hide/delete/review actions invalidate existing Context Packs and active-only search keeps non-active Facts out of retrieval.
- Fact Lifecycle technical review: accepted; Fact lifecycle writes go through Vault Core, sync normalized Facts/FTS/Context Pack projections, and reuse the same Pack invalidation guard as Source lifecycle.
- Fact Lifecycle UX review: accepted; desktop and mobile Search surfaces show review-needed Facts and active Fact actions without page-level horizontal overflow, with action copy that separates keeping context from hiding/deleting it.
- Fact Metadata review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Fact Metadata product review: accepted; users can now correct canonical life context directly from Search instead of deleting and recreating memory.
- Fact Metadata security review: accepted; changed Facts invalidate existing Context Packs, and secret-never-send is not offered as a selectable AI-bound sensitivity.
- Fact Metadata technical review: accepted; metadata writes go through Vault Core, refresh normalized Facts/FTS, clear blank optional date fields, and audit `fact_updated`.
- Fact Metadata UX review: accepted; the compact edit form keeps high-frequency Search scanning intact while exposing correction only when requested.
- Fact Supersede review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Fact Supersede product review: accepted; users can now approve a new memory while explicitly replacing an older one instead of accumulating contradictory active context.
- Fact Supersede security review: accepted; superseded Facts leave active retrieval immediately, affected Context Packs are cancelled, and version history remains human-readable without becoming AI-bound context.
- Fact Supersede technical review: accepted; approval writes version links, syncs normalized Fact columns/FTS, returns invalidation metadata through Tauri, and preserves the old approval API for existing MCP/test callers.
- Fact Supersede UX review: accepted; Inbox replacement choices and Search version history render without desktop/mobile horizontal overflow and keep "saved" separate from "sent to AI".
- Candidate Conflict review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Candidate Conflict product review: accepted; conflicting life context now receives visible review pressure in Inbox without pretending the new extraction is truth.
- Candidate Conflict security review: accepted; conflict metadata does not make candidates AI-eligible, does not send Raw Source text, and does not supersede old Facts without explicit user approval.
- Candidate Conflict technical review: accepted; TypeScript fallback and Rust Vault Core both annotate candidates, sync normalized conflict columns, and avoid self-conflict during Source body re-extraction.
- Candidate Conflict UX review: accepted; desktop and mobile Inbox surfaces show conflict state and replacement action without horizontal overflow.
- Current-Value Conflict review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, privacy, technical, and false-positive-risk passes.
- Current-Value Conflict product review: accepted; current address, provider, employer, phone, and email changes are central life context updates, and users should see replacement pressure even when no date is present.
- Current-Value Conflict privacy review: accepted; the marker logic runs locally, only stores conflict metadata on MemoryCandidates, and does not expose candidate text to AI or mutate ApprovedFacts.
- Current-Value Conflict false-positive review: accepted; deterministic anchors are intentionally conservative and any match remains review-only, so a mistaken conflict can be ignored without changing the canonical Fact.
- Current-Value Conflict verification: `cargo test --manifest-path src-tauri/Cargo.toml native_source_ingest_marks_current_value_conflict_without_date` and `npm run product:check` passed. `cargo fmt` was skipped inside `product:check` because rustfmt is not installed for the local stable toolchain.
- Context Pack Minimization review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and UX passes.
- Context Pack Minimization product review: accepted; users can now remove individual Facts from a task-specific Pack without hiding the canonical Fact globally.
- Context Pack Minimization security review: accepted; removed items stay in `excludedItems` as `user_hidden`, source snippets and max sensitivity are recalculated, and external AI retrieves only the confirmed edited Pack.
- Context Pack Minimization technical review: accepted; Pack item visibility, confirmation, and denial now have Rust-owned Vault Core commands with projection sync and audit events.
- Context Pack Minimization UX review: accepted; desktop and mobile Requests screens show send counts, removed Facts, and restore controls without horizontal overflow.

### Native Document Extraction Slice

- Review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, dependency, and UX passes.
- Product fit: accepted; important life documents such as PDFs and modern Office files can now become reviewable MemoryCandidates without forcing users to manually paste extracted text.
- Security/privacy: accepted; extraction is local in the Desktop path, unsupported/OCR-required/legacy/oversized files are rejected before RawSource creation, and extracted text still creates only unapproved Candidates until the user approves Facts.
- Technical design: accepted; native extraction is behind one Tauri command, uses bounded input size, ZIP entry count, ZIP entry size, and extracted text limits, and then reuses the existing Source ingestion pipeline.
- Dependency review: accepted with constraints; `pdf-extract`, `quick-xml`, and `zip` were added for local extraction, with `zip` pinned to the Rust-1.77-compatible 0.6 series rather than the latest MSRV-heavy release.
- UX review: accepted; Upload now separates local PDF/Office extraction from OCR/provider gaps and keeps failure messages specific enough for non-developer users.
- Verification: `npm test`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, `git diff --check`, and `npm run tauri:build` passed. Browser layout checks covered Sources Upload at desktop `1280x720` and mobile `390x844` with no page-level or Upload-card horizontal overflow. `cargo fmt` remains unavailable because `rustfmt` is not installed for the local stable toolchain.

### Local OCR Provider Slice

- Review fallback: At the time of this slice, SubAgents were not used; the main thread ran separate product, security/privacy, technical, and UX passes.
- Product fit: accepted; scanned life documents can now enter the same Memory Inbox workflow when the user explicitly configures a local OCR provider.
- Security/privacy: accepted; OCR is off by default, uses an explicit local command without shell expansion, accepts only stdout text, keeps image body handling inside Desktop extraction, and still creates only unapproved MemoryCandidates.
- Technical design: accepted; provider invocation uses a temp input file, placeholder-based args, UTF-8 output validation, normalized extracted text, and a bounded timeout.
- UX: accepted; Upload shows whether image OCR is available, Settings exposes command/args/timeout setup, and the copy stays focused on local extraction plus Inbox confirmation.
- Verification: `npm test -- --run src/sourceUpload.test.ts`, `cargo test --manifest-path src-tauri/Cargo.toml native_document_extraction`, `npm run build`, and in-app Browser desktop Sources Upload plus Settings OCR DOM/layout checks at `1280x900` passed. Mobile rendering could not be re-verified in this Browser runtime because viewport control was unavailable; the new OCR copy uses the already-validated responsive `trust-note`, input, action-row, and drop-zone patterns.

### Large Retrieval Benchmark Slice

- Review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, technical, and operations passes.
- Product fit: accepted; multi-year life context growth now has an executable 100k Fact / 500k SourceChunk retrieval gate instead of only an architectural target.
- Security/privacy: accepted; the benchmark uses synthetic data, opens the same encrypted SQLite path with the test Vault key, and exercises ApprovedFact-only search plus Context Pack generation without Raw Source export.
- Technical design: accepted; the benchmark is ignored by default, exposed through `npm run retrieval:bench`, configurable through `LCV_BENCH_FACTS` and `LCV_BENCH_CHUNKS_PER_FACT`, and measures the shared Vault Core path used by the Control Center and MCP sidecar.
- Operations: accepted; normal `npm test`/`cargo test` remain fast while release qualification has a repeatable command and documented P95 targets.
- Verification: `npm test`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run retrieval:bench`, `git diff --check`, and `npm run tauri:build` passed. `cargo fmt` could not run because `rustfmt` is not installed for the local stable toolchain.

### Product Release Check Slice

- Review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate operations, developer-experience, maintainability, and performance-risk passes.
- Product fit: accepted; release qualification now has a named command instead of relying on a remembered checklist, which is important before opening Life Context Vault to everyday AI users.
- Developer experience: accepted; `product:check` keeps the default loop bounded, while `product:check:full` adds Tauri sidecar integration and the large retrieval benchmark for release candidates.
- Performance risk: accepted; full checks keep the 100k Fact / 500k SourceChunk benchmark opt-in, and smaller benchmark profiles can be run through `-- --include-bench --bench-facts <n> --bench-chunks-per-fact <n>`.
- Verification: `npm run product:check` and `npm run product:check -- --include-bench --bench-facts 100 --bench-chunks-per-fact 1` passed. Both explicitly skipped `cargo fmt` because rustfmt is not installed for the local stable toolchain.

### CI Product Check Slice

- Review fallback: At the time of this slice, SubAgents were not used; the main thread ran separate operations, security/privacy, performance-cost, and maintainability passes.
- Product fit: accepted; product-grade checks now run outside the developer machine, and retrieval performance has a scheduled lightweight profile rather than relying only on manual local runs.
- Security/privacy: accepted; the workflow uses synthetic benchmark data and does not require Vault secrets, Relay tokens, OCR provider commands, or user data.
- Performance-cost: accepted; PR/push checks run the standard bounded `product:check`, while scheduled/manual runs can add a smaller retrieval benchmark profile with configurable size.
- Maintainability: accepted; logs are uploaded as an artifact and a job summary records event and benchmark parameters for later trend review.
- Verification: workflow YAML was added and local `npm run product:check` passed after the workflow was created.

### Relay State Store Slice

- Product fit: durable OAuth client registrations reduce repeated setup friction for ChatGPT/Claude-style connectors while keeping the first-party app as the control surface.
- Security/privacy: relay persistence is limited to OAuth client registrations and request metadata. MCP request bodies, Raw Sources, Vault content, and Context Pack bodies are not written to the relay state file.
- Technical design: relay state writes use a temp file plus replace step, and failed registration persistence rolls back the in-memory client so a 500 response does not leave a process-only client behind.
- UX: Connections now distinguishes what the Relay keeps from what it refuses to keep, including a visible `/relay/state` status URL for local inspection.
- Verification: desktop `1440x980` and mobile `390x844` Browser checks found no page-level horizontal overflow in the updated Remote Relay setup section.

### Relay Retention Controls Slice

- Review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, operations, and technical passes.
- Product fit: accepted; Relay metadata can now survive normal use without unbounded growth while preserving durable OAuth clients by default.
- Security/privacy: accepted; retention prunes only metadata already allowed in Relay state and does not add any persisted MCP request body, Vault content, Raw Source text, or Context Pack body.
- Operations: accepted; request-event retention defaults to 30 days, supports seconds/days environment overrides, and client-registration TTL remains opt-in for stricter hosted deployments.
- Technical design: accepted; pruning runs on load, event recording, and persistence, with `/relay/state` exposing retention settings for local inspection.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay`, `cargo test --manifest-path src-tauri/Cargo.toml`, `git diff --check`, and `npm run tauri:build` passed.

### App-Managed AI Access Service Slice

- Product fit: everyday AI access no longer depends on copying three terminal commands; the desktop Control Center can start Relay, create pairing, and connect Agent.
- Security/privacy: app-managed startup preserves the same Relay boundary. The app does not add raw Vault reads or new externally exposed tools.
- Technical design: helper binaries are prepared as Tauri external binaries and resolved from the app bundle, while manual target/release binaries still work in development.
- UX: Connections now leads with service status and direct controls, keeping manual commands as fallback.
- Lifecycle: app-managed Relay and Agent are stopped by **管理中の連携を停止** and on app window close; external relays are observed but not killed or auto-attached.
- Verification: bundled Relay and Agent launched from `Life Context Vault.app/Contents/MacOS` and served MCP `tools/list` through the Agent WebSocket path.

### Cross-Platform Startup Helper Slice

- Review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, platform, and technical passes.
- Product fit: accepted; AI Access can be restored after login on macOS, Windows, and Linux using the same Control Center command surface.
- Security/privacy: accepted; startup payloads run only the app binary and do not embed Vault keys, Relay tokens, MCP payloads, Raw Sources, or Context Pack bodies.
- Platform design: accepted; macOS keeps LaunchAgent, Windows uses the user's Startup folder `.cmd`, and Linux uses XDG autostart `.desktop`.
- Technical design: accepted; existing Tauri command names remain stable while OS-specific path/payload generation is isolated in testable helpers.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm test`, `npm run build`, `npm run tauri:build`, and `git diff --check` passed; Browser checked Connections at 1280px and 390px with no page-level horizontal overflow.

### Menu-Bar Background Mode Slice

- Review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, lifecycle, and UI passes.
- Product fit: accepted; everyday AI access no longer depends on keeping a Control Center window visible, and the user can return from the menu bar/system tray.
- Security/privacy: accepted; background mode does not add Vault reads, MCP tools, Relay storage, Raw Source access, or Context Pack persistence. It only changes app lifecycle handling.
- Lifecycle: accepted; regular window close prevents window destruction and hides to background, while explicit tray Quit and real window destruction still stop app-managed Relay and Agent.
- UX: accepted; Connections explains that closing the window keeps AI Access running and that full exit is available through `Quit Life Context Vault`.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm test`, `npm run build`, `npm run tauri:build`, and `git diff --check` passed; Browser checked Connections at 1280px and 390px with no page-level horizontal overflow.

### Relay Tenant Isolation Slice

- Review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate product, security/privacy, hosted-ops, and compatibility passes.
- Product fit: accepted; hosted Relay state now has an explicit tenant boundary before any future shared deployment work.
- Security/privacy: accepted; tenant id is operational metadata only. The change does not persist MCP bodies, Raw Sources, Vault content, Context Pack bodies, access tokens, or authorization codes.
- Hosted operations: accepted; non-loopback binds require an explicit tenant id, and state files configured for a different tenant are refused instead of silently reused.
- Compatibility: accepted; old tenantless local state migrates to the configured tenant, preserving existing local development state.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm test`, `npm run build`, `cargo build --release --manifest-path src-tauri/Cargo.toml --bin lcv-relay`, `npm run tauri:build`, and `git diff --check` passed; Browser checked Connections at 1280px and 390px with no page-level horizontal overflow.

### Relay State Backup Slice

- Review fallback: SubAgents were not used for this slice because parallel SubAgent work was not explicitly requested; the main thread ran separate hosted-ops, security/privacy, durability, and compatibility passes.
- Product fit: accepted; hosted and local Relay metadata can recover recent OAuth client/request metadata state without changing the Vault data boundary.
- Security/privacy: accepted; backups contain the same metadata-only state as the primary relay state file and still exclude MCP bodies, Raw Sources, Vault content, Context Pack bodies, access tokens, and authorization codes.
- Durability: accepted; the previous state file is copied to `.bak1` before replacement, older backups rotate up to the configured generation count, and `LCV_RELAY_STATE_BACKUP_COUNT=0` can disable the behavior.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm test`, `npm run build`, `cargo build --release --manifest-path src-tauri/Cargo.toml --bin lcv-relay`, `npm run tauri:build`, and `git diff --check` passed.

### Relay Handoff Slice

- Review fallback: At the time of this slice, SubAgents were not used; the main thread ran separate product, security/privacy, technical, and operations passes.
- Product fit: accepted; a hosted Remote MCP request can now be fulfilled after local approval without asking the Relay to read or persist the Vault.
- Security/privacy: accepted; handoff bodies are admin-gated, HMAC-signed, memory-only, TTL-bound, validated as fulfilled `ContextPack only` responses, and excluded from relay state persistence plus backups.
- Technical design: accepted; Agent/Vault remains canonical when online, while offline `get_request_status` can use the cached response for the matching request id.
- Operations: accepted; `/relay/state` exposes handoff count, request id, client id, creation time, expiry time, and TTL settings for debugging without exposing Pack body text.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay` passed.

### Hosted Relay Deployment Slice

- Review fallback: At the time of this slice, SubAgents were not used; the main thread ran separate hosted-ops, security/privacy, product, and maintainability passes.
- Product fit: accepted; everyday AI clients now have a documented public HTTPS relay shape while the actual Vault remains on the user's device.
- Security/privacy: accepted; the Docker defaults disable direct sidecar fallback, require external secrets for public binds, persist only metadata under `/data`, and keep Context Pack handoff bodies memory-only.
- Hosted operations: accepted; deployment docs define required env vars, durable volume, smoke tests, admin token rotation, static fallback token rotation, and incident response.
- Maintainability: accepted; the Dockerfile builds only `lcv-relay`, `.dockerignore` keeps local Vault/state/build artifacts out of the context, and the runbook links from `docs/http-mcp-relay.md`.
- Verification: Dockerfile/runbook added, YAML/docs diff checked, and local `npm run product:check` had already passed for the codebase before this docs/deploy-only slice.

### First-Run AI Access UX Slice

- Product fit: Home now gives non-developer users a concrete sequence from "add life context" to "AI can request a Context Pack" instead of expecting them to discover Connections first.
- UX: Connections now explains readiness in natural language and separates service state from Vault usefulness signals such as Approved Facts, Inbox, Requests, and Capture. Home now places a single Next Action above the checklist and moves Guided Setup before the long Background Snapshot.
- Safety: readiness copy reinforces that external AI receives only Context Packs, not Raw Sources, unapproved candidates, or the full Vault.
- Verification: `npm run build` and `git diff --check` passed. Browser DOM/layout checks covered Home at desktop `1280x900` and mobile `390x844`, with no horizontal overflow; mobile setup moved from roughly `y=3026` before this pass to `y=743`, mobile nav buttons retain `aria-label`s, and the Next Action button navigated to **Inbox** in the rendered app.

### Claude Desktop Setup Slice

- Product fit: first-time Local MCP setup no longer depends on hand-editing `claude_desktop_config.json`.
- Technical design: the Tauri app resolves the bundled `lcv-mcp` sidecar and native Vault path, then merges only the `life-context-vault` server entry.
- UX: Connections now offers a primary install button plus copy fallback, and reports config/backup paths after installation.
- Safety: existing Claude config is backed up before writing, other MCP servers are preserved, and invalid JSON stops the installer without overwrite.
- Verification: Rust unit tests cover preserving existing MCP servers during merge.

### External Vault Sync Slice

- Product fit: Context Requests and Memory Proposals created by everyday AI clients are no longer invisible until the user manually reloads the native Vault.
- Technical design: `vault_state.updated_at` is treated as the lightweight revision marker for external writers; legacy tables are migrated in all native entry points that can open the Vault.
- UX: when a pending external Context Request appears, the app selects it and shows a notice pointing the user to **Requests** for confirmation.
- Safety: the app still confirms Context Packs locally; the sync path only imports the updated encrypted Vault snapshot and does not add new external read tools.
- Verification: Rust tests cover legacy `updated_at` backfill, and an MCP sidecar smoke test wrote a Context Request then read its status from the same encrypted Vault.

### Conflict-Safe Native Save Slice

- Product fit: the Control Center no longer blindly overwrites native Vault updates that arrived from MCP, Relay Agent, or browser capture while the app was open.
- Technical design: native saves accept the last observed `updatedAt`; stale saves return the current encrypted Vault snapshot instead of writing.
- UX: when a save conflict happens, the app merges external records and local edits, then tells the user that external AI updates were merged.
- Safety: same-id records prefer the user's local edit, while new external Sources, Candidates, Context Requests, Context Packs, Audit Events, and connector records are preserved.
- Verification: Rust tests confirm stale saves return conflict without changing the stored payload.

### Native Projection Sync Slice

- Product fit: external AI writes made while the Control Center is closed are now visible to native search after the next app open/search path.
- Security/privacy: the sync path still projects only from encrypted local `vault_state`; it does not add a new Raw Source or full-Vault external read path.
- Technical design: `projection_state` records the `vault_state.updated_at` revision already reflected in normalized tables and `facts_fts`.
- Review disposition: stale FTS after MCP/Relay writes was the material finding; fixed with open-time projection sync and regression coverage.
- Verification: Rust tests cover first projection, stale projection replacement, and save-time projection revision marking.

### Native Context Pack Engine Slice

- Product fit: the Requests flow now exercises the same trust boundary that everyday AI clients need: a Context Request becomes a short-lived Context Pack without exposing the full Vault.
- UX: no new visual model was introduced; the existing confirmation UI remains the user-facing control point, with the Tauri path using Vault Core generation and browser builds retaining the JS fallback.
- Security/privacy: native tests cover ApprovedFact-only inclusion, unapproved Candidate exclusion, Raw Source body exclusion from snippets, and sensitivity-ceiling exclusions.
- Technical design: ranking now reads normalized SQLite facts and sources, then writes the request and pack back through the encrypted Vault save path so projection state remains current.
- Review disposition: a DB-read error in source-deleted warning generation was initially swallowed; fixed to propagate the error instead of silently omitting the warning.
- Follow-up: passive capture and policy updates should continue moving toward shared Vault Core CRUD.

### Native Candidate Review Slice

- Product fit: the critical user action in Memory Inbox now uses Vault Core, so "AI inferred this" and "I approved this as a Fact" are separated by a single shared boundary.
- UX: Inbox behavior is unchanged visually, but Desktop approvals now update the encrypted Vault snapshot and normalized search projection immediately.
- Security/privacy: `secret_never_send` candidates are blocked from approval in Vault Core, and reject/archive/sensitive status changes cannot create ApprovedFacts.
- Technical design: `approve_candidate_at_path` and `update_candidate_status_at_path` are path-based Vault Core APIs behind Tauri review commands.
- Review disposition: status update and approval were split into separate Core functions to avoid treating `approved` as a generic status mutation.

### Native Fact Metadata Slice

- Product fit: everyday AI context becomes correctable after approval; users can revise fact text, domain, sensitivity, and date metadata without losing provenance.
- UX: Search result rows expose editing progressively so the normal scan-and-retrieve surface remains quiet until correction is needed.
- Security/privacy: edits invalidate Context Packs that included the changed Fact, preventing external clients from reusing stale AI-bound payloads.
- Technical design: `update_fact_metadata_at_path` is the path-based Vault Core API behind the Tauri `update_native_fact_metadata` command and browser fallback mirrors the same state transition.
- Review disposition: the material risk was stale FTS or stale Pack contents after edits; fixed with projection sync and Context Pack invalidation coverage.

### Native Source Ingestion Slice

- Product fit: first-run background setup, manual notes, and text uploads now use the same Vault Core write boundary that everyday AI integrations rely on, so new users see one consistent Source -> Inbox -> ApprovedFact model.
- UX: Sources now explicitly separates Source/candidate storage from AI-bound Context Pack sharing before the user submits a note or document.
- Security/privacy: native and browser fallback redaction now remove adjacent secret values, and Source ingestion never creates ApprovedFacts automatically.
- Technical design: `add_source_with_candidates_at_path` is the path-based Vault Core API behind the Tauri `add_native_source_with_candidates` command.
- Review disposition: the first native redaction pass collapsed line breaks and reduced multi-line documents to one candidate; fixed by preserving line boundaries during Source-body sanitization.

### Shared MCP Context Pack Core Slice

- Product fit: Claude Desktop-style local MCP requests now use the same Context Pack Engine as the Control Center, reducing surprise between in-app testing and everyday AI usage.
- Security/privacy: sidecar tests cover both sensitive Pack queuing without returning items and low-risk Pack return without Raw Source body leakage.
- Technical design: `create_context_pack_request_at_path` is the path-based Vault Core API used by both Tauri commands and the stdio MCP sidecar.
- Review disposition: old sidecar-only ranking and Pack assembly helpers were removed after the shared path landed, leaving one generation source of truth for request_context_pack.

### Shared MCP Proposal And Status Slice

- Product fit: everyday AI clients now propose memory candidates and retrieve confirmed request status through the same Vault Core boundary rather than sidecar-only JSON mutation.
- Security/privacy: shared status returns only the AI-bound Context Pack payload and strips local answer/audit internals; shared proposal never creates ApprovedFacts.
- Technical design: `propose_memory_at_path` and `get_context_request_status_at_path` are path-based Vault Core APIs used by the stdio MCP sidecar.
- Review disposition: old sidecar-local memory proposal assembly and request-status Pack sanitization were removed after shared Core APIs landed.

### Relay Auth And OCR Hardening Slice

- Product fit: public Remote MCP access now defaults to the OAuth + local Agent approval path that matches the everyday-AI product promise, while static bearer access is explicitly limited to local development.
- Security/privacy: `/oauth/approve` now requires a server-side pending authorization session, static bearer MCP access is off unless `LCV_RELAY_ENABLE_STATIC_TOKEN=1`, browser-originated loopback admin calls are rejected without an admin token, and cached handoffs are bound to the requesting AI client id.
- Security/privacy: local OCR provider execution now uses a private per-request temporary directory, clears inherited process environment variables except a minimal locale/path allowlist, and returns generic provider errors without echoing stderr into the app.
- Operations: hosted Relay deployment docs now require HTTPS base URL, admin token, direct sidecar disabled, and OAuth-only client access; accidental public static bearer fallback is treated as a misconfiguration.
- Verification: relay tests cover pending OAuth authorization sessions, empty-scope rejection, static bearer disabling, and client-bound handoff cache behavior. Native document extraction tests cover the OCR command path.

### Control Center UX Hardening Slice

- Product fit: Connections now puts the AI Access quick start at the top of the page, so everyday AI connectivity is no longer buried below policy details.
- UX: Context Requests keeps the Context Pack panel beside the incoming request on desktop, and on narrow screens moves the active Pack before the request form so the user reviews the AI-bound payload first.
- UX: Pack risk, maximum sensitivity, confirmation status, and the approve/copy/local-answer/deny actions now sit at the top of the Pack panel. The copy action is labeled as copying the Context Pack body, separating "saved" from "AI-bound or copied."
- Verification: in-app Browser checks at `1280x900` and `390x844` confirmed no horizontal overflow. Connections shows `AI連携を開始` in the first viewport; Requests shows the Pack approval actions in the first viewport after selecting a request on both desktop and mobile.

### Control Center Relay Handoff Slice

- Product fit: approving a Context Pack in Control Center can now register the already-confirmed Pack with the local Relay, so hosted Remote MCP clients can complete `life_context.get_request_status` without asking the Relay to read the Vault.
- Security/privacy: the Tauri command posts only a safe MCP status response built from `safe_context_pack_for_client`; handoff is signed, bound to the original request id and client id, and still excludes Raw Source bodies, Vault snapshots, and unapproved MemoryCandidates.
- UX: approval notices distinguish Vault confirmation from Relay handoff. If Relay is unavailable, the Pack remains confirmed locally and the user is told that handoff is not complete.
- Verification: Rust coverage confirms the handoff payload is fulfilled, declares `ContextPack only`, includes approved Pack facts, and does not include source-origin internals.

### Passive Capture TTL Enforcement Slice

- Security/privacy: Rust Vault saves now purge expired passive-capture Source bodies before writing the encrypted snapshot and normalized tables, matching the browser fallback TTL behavior.
- Data model: expired passive-capture Sources are marked `deletionState: purged`, body is replaced with `[PURGED_PASSIVE_CAPTURE]`, linked PassiveCaptureEvents move to `processingStatus: purged`, and a `passive_capture_purged` audit event is recorded.
- Verification: Rust coverage seeds an expired passive-capture transcript, triggers a native settings save, and confirms both the JSON snapshot and normalized `sources` table contain only the purge marker.

### Access Policy Enforcement Slice

- Product fit: everyday AI clients now receive only the life domains the user allowed for that client, rather than relying on sensitivity ceilings alone.
- Security/privacy: `domainAllowlist` and `requiresApprovalAbove` are enforced inside Pack generation, AI-requested sensitivity ceilings can only narrow the user's policy ceiling, malformed policy sensitivity values fail closed to `public`, and domain-limited Facts cannot be restored into an edited Pack.
- AI access: Remote Relay now forwards the authenticated OAuth client id through the local Agent to the MCP sidecar as trusted runtime metadata, so Remote MCP requests no longer collapse into `conn_local_mcp`.
- AI access: `life_context.get_request_status` now uses the effective client id and hides confirmed Packs from any client that did not own the original request.
- Technical design: TypeScript fallback and Rust Vault Core share the same policy semantics, including `domain_policy` exclusions, policy-limited warnings, ceiling minimization, and approval-threshold fail-closed behavior.
- Security/privacy: Vault Core external IDs, app-managed Relay tokens, and Relay OAuth/client/pairing tokens now require OS randomness through `getrandom` instead of falling back to predictable time-derived values.
- Verification: `npm test` covers the browser fallback path, `cargo test --manifest-path src-tauri/Cargo.toml` covers Rust Vault Core, MCP, Relay, and Agent paths, and focused coverage confirms domain allowlists, invalid/widened ceilings, client-bound request status, and Agent-to-MCP client id propagation.

### Connections Domain Policy UX Slice

- Product fit: users can now decide which life areas each Context Pack-capable AI is allowed to receive, instead of relying on invisible Core-only `domainAllowlist` rules.
- UX: each eligible AI connection card shows the allowed domain count, a checklist of Japanese life-domain labels, and two accessible presets: all domains or a conservative preset that removes personal identity, care, money/benefits, and accessibility/constraint context. Browser Capture no longer shows this outbound-AI control.
- Security/privacy: empty, unknown, or mixed-invalid domain updates cannot widen access. Browser fallback preserves the previous allowlist for invalid updates, Rust Vault Core rejects invalid updates, corrupted empty persisted allowlists fail closed to a conservative domain set, and policy changes cancel existing Packs before later confirmation, copy, status, or Relay handoff.
- Review disposition: SubAgent security and UX findings for stale Pack egress, mixed invalid domain handling, empty persisted allowlists, oversized checkbox rendering, Capture-policy confusion, missing Copy fallback policy, repeated button accessible names, and unclear domain labels were fixed in this slice.
- Verification: `npm test`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `npm run build` passed. Browser checks at desktop `1280x720` and mobile `390x844` found no page, card, action-row, or policy-domain-panel horizontal overflow; domain checkbox inputs measured `16x16`, Browser Capture had no policy-domain panel, and ChatGPT's conservative/all-domain actions updated checked domains and summary count.

### AI Delivery Receipts Slice

- Product fit: Audit now starts with a human-readable receipt list for AI boundary events, separating "saved in Vault", "made available as a Context Pack", "copied or handed to Relay", and "denied/invalidated".
- Security/privacy: Clipboard copy and Relay handoff write `context_pack_delivered` audit events containing only request/client/status/count/sensitivity metadata. Audit metadata explicitly records `trustBoundary: ContextPack only`, `bodyStoredInAudit: false`, `rawSourceIncluded: false`, and `unapprovedCandidateIncluded: false`.
- Technical design: the browser fallback records delivery receipts through `recordContextPackDelivery`; native Relay handoff records the same receipt in Vault Core and returns the updated encrypted Vault snapshot to Control Center.
- Verification: `npm run product:check` passed. Added tests prove delivery receipts omit Pack body text and Raw Source body text while preserving AI name, delivery channel, status, and item count. Browser checks at desktop `1280x720` and mobile `390x844` confirmed the Audit receipts render without horizontal overflow; screenshot capture was unavailable because the Browser screenshot API timed out.

### Source Upload Drag And Drop Slice

- Product fit: Sources now supports the expected "select or drop a file" path, reducing friction in the first 10-minute value flow for non-developer users who start from documents.
- UX/accessibility: the existing file input remains available with an explicit accessible label, while the drop zone exposes a drag-active state, focus state, accepted-format copy, and a one-file-at-a-time expectation without hiding the native picker.
- Verification: `npm run product:check` passed. Browser checks at desktop `1280x720` and mobile `390x844` confirmed the Sources upload zone renders with no horizontal overflow, keeps the file input within the panel, and exposes the expected ARIA labels.

### Browser Auto Capture Slice

- Product fit: the Chrome extension now supports opt-in Auto Capture on supported AI chat pages, bringing the product closer to "life context follows everyday AI" without requiring users to remember popup capture every time.
- Security/privacy: Auto Capture is off by default, shows a persistent in-page status badge, debounces page changes, skips unchanged text hashes, and stores only preference/hash/status metadata in Chrome storage. Captured transcript text still goes directly to the local Native Messaging host and Vault Core, where app-level Pause, allowed-site policy, retention, redaction, and candidate-only boundaries are enforced.
- Technical design: popup manual capture and content-script Auto Capture now share the same background `capturePageFragment` path and recent status metadata. The content script responds to popup setting changes without a page reload.
- Verification: extension static checks passed with `node --check browser-extension/background.js`, `node --check browser-extension/content.js`, and `node --check browser-extension/popup.js`. Static popup visual inspection via the in-app browser was attempted, but local `file://` extension HTML was blocked by the browser URL policy; no alternate browser workaround was used.

### OCR Setup Assistant Slice

- Product fit: Settings now detects common local Tesseract OCR providers from `PATH` and platform-standard install locations, then lets the user apply a safe command/argument preset without copying paths by hand.
- Security/privacy: detection checks only local executable paths and does not run OCR, inspect images, or send data. Image OCR execution remains explicit, local-command based, timeout bounded, and still produces only Source text plus unapproved Inbox candidates.
- Technical design: Tauri exposes `detect_ocr_provider_candidates`, TypeScript keeps the native boundary typed, and the Settings view applies detected command, basic `{input} stdout` args, and timeout through existing runtime preferences.
- Verification: Rust provider-detection test covers PATH detection and duplicate suppression without executing the fake provider. `npm run product:check` passed. Browser checks at desktop `1280x900` and mobile `390x844` confirmed the Settings Local OCR card renders without horizontal overflow and keeps the preset buttons within the panel.

### OCR Guided Install Slice

- Product fit: users who do not already have Tesseract now see concrete macOS/Homebrew, Windows/winget, and Ubuntu/apt install commands inside Settings instead of being told to figure out OCR externally.
- Security/privacy: the app only copies commands or fills local path/argument fields; it does not run installers, inspect images, send image data, or execute OCR until the user later uploads an image with an explicit local provider configured.
- Technical design: Settings orders the OS-relevant guide first when the browser platform is known, keeps all command text wrapped inside the existing panel pattern, and uses the existing clipboard notice flow.
- Verification: `npm test -- --run`, `npm run build`, desktop `1280x920` CDP render, and mobile `390x844` CDP render passed with no horizontal overflow in the Settings OCR guide.

### Browser Capture Delete Slice

- Product fit: the extension popup now lets a user immediately delete the latest captured Source body when Auto Capture or manual capture grabbed the wrong conversation, reducing the anxiety cost of trying passive capture.
- Security/privacy: Chrome storage stores only the latest `sourceId` plus capture metadata, not transcript text. Native host deletion is scoped to browser `passive_capture` Sources and refuses arbitrary/manual Source ids.
- Technical design: the capture host exposes a `delete_capture_source` Native Messaging action backed by a Vault Core wrapper that validates Source kind/origin before calling the existing `purge_body` lifecycle path. The popup updates recent-capture metadata after deletion.
- Verification: Rust tests cover both the capture-host delete path and refusal of non-browser Sources. Extension static checks cover the popup/background changes. `npm run product:check` passed; popup visual inspection remains limited by the in-app browser `file://` URL policy noted in the Browser Auto Capture slice.

### Browser Delta Capture Slice

- Product fit: Auto Capture now avoids resending the whole visible conversation after every debounced page change when the chat grows normally, reducing duplicate Sources and making passive capture feel calmer.
- Security/privacy: the previous accepted transcript is held only in the content script's in-memory page session for delta comparison. Chrome storage still keeps only preference/hash/status metadata and the latest `sourceId`, not transcript text.
- Technical design: first successful capture uses `captureMode: "full"`; later captures compute appended text by prefix/direct/overlap matching and send `captureMode: "delta"` with metadata-only `textLength`. If overlap is unclear, the extension falls back to full capture rather than guessing.
- Verification: extension static checks cover content/background/popup changes. A Node VM check verified prefix, overlap, and rewrite fallback behavior against the actual content script helper. `npm run product:check` passed.

### Browser Capture Open App Slice

- Product fit: after a popup or Auto Capture, users can open the Control Center from the extension and continue directly to Memory Inbox review instead of wondering where the saved candidate went.
- Security/privacy: the extension still stores and displays only recent capture metadata. The open-app action sends no transcript, Source body, Candidate text, Vault content, or Context Pack body back to Chrome.
- Technical design: the popup sends `LCV_OPEN_CONTROL_CENTER` to the background service worker, which asks the Native Messaging host to launch the known app bundle or sibling app binary. The host does not accept a user-supplied command or path.
- Verification: capture-host unit tests cover app-bundle and sibling-binary resolution. Extension static checks cover popup/background JavaScript. Headless Chrome rendered the popup at `360x620` with the new open-app button visible and no horizontal overflow. `npm run product:check` passed.

### Browser Durable Delta Checkpoint Slice

- Product fit: Auto Capture can resume calm delta behavior after an AI chat page reload instead of sending the whole visible conversation again whenever the page refreshes.
- Security/privacy: Chrome storage still does not keep transcript text. Durable checkpoints store only `conversationId`, source client, full-text hash, text length, and timestamp, and they are used only when the current page prefix hashes to the previous accepted capture.
- Technical design: the content script keeps the existing in-memory overlap path for live page growth, then falls back to recent checkpoint metadata after reload. If the prefix hash does not match, the extension sends a full capture rather than guessing.
- Verification: extension static checks cover content/background/popup JavaScript. A Node VM check loaded the actual content script and verified reload-safe delta, unchanged-checkpoint detection, rewrite fallback, and absence of stored `text`/`url` fields in checkpoints. `npm run product:check` passed.

### Remote MCP Method Boundary Slice

- Product fit: hosted-client smoke tests against unsupported `/mcp` methods now get an explicit method boundary instead of a generic 404.
- Security/privacy: unsupported MCP transports still do not expose Vault, Raw Source, or Context Pack bodies; the Relay returns metadata-only method guidance.
- Technical design: unsupported `/mcp` methods return `405 Method Not Allowed`, `Allow: GET, POST, DELETE, OPTIONS`, JSON guidance, and CORS headers. `POST /mcp` remains the only JSON-RPC request path; `GET /mcp` is now the SSE receive-channel path.
- Verification: Relay unit coverage fixes the unsupported method status, reason, `Allow` header, and response body. `npm run product:check` passed for the original boundary slice.

### Relay Origin Allowlist Slice

- Product fit: hosted Relay setup now has a concrete `LCV_RELAY_ALLOWED_ORIGINS` path for ChatGPT/Claude-style browser clients instead of relying on wildcard CORS.
- Security/privacy: public/shared Relay startup requires an Origin allowlist, and `/mcp` plus `/relay/handoff` reject disallowed browser Origins before authorization or request-body payload processing. OAuth discovery remains public metadata.
- Technical design: loopback development keeps wildcard CORS when no Origin allowlist is configured; configured Origins receive exact `Access-Control-Allow-Origin` plus `Vary: Origin`; disallowed Origins receive `403 origin_not_allowed`.
- Verification: Relay unit tests cover required public allowlist configuration, trusted preflight, and untrusted-Origin rejection. `npm run product:check` passed.

### Remote MCP Protocol Headers Slice

- Product fit: hosted AI clients now receive clearer MCP/OAuth compatibility signals instead of generic bearer errors or browser preflight misses.
- Security/privacy: public Relay OAuth requires `resource=<relay>/mcp` on authorization and token exchange, and MCP access tokens are rejected when bound to another resource. The Relay still exposes only Context Pack tools.
- Technical design: `/mcp` now allows MCP-specific browser headers, validates `MCP-Protocol-Version` for 2025-03-26/2025-06-18/2025-11-25, returns `400 unsupported_protocol_version` for unsupported versions, echoes the negotiated version on MCP responses, and returns a `WWW-Authenticate` challenge with `resource_metadata` plus required scope on unauthorized MCP calls.
- Verification: Relay unit tests cover MCP CORS headers, unauthorized OAuth challenge contents, unsupported protocol-version rejection, and public OAuth resource binding.

### Remote MCP Transport Header Slice

- Product fit: ChatGPT/Claude-style hosted MCP smoke tests now get explicit Streamable HTTP transport guidance when `/mcp` is called with missing or incompatible POST headers.
- Security/privacy: malformed MCP POSTs are rejected before OAuth, Agent forwarding, direct sidecar fallback, or any Vault read path. The Relay still exposes only Context Pack tools and does not store MCP request bodies.
- Technical design: `POST /mcp` requires `Content-Type: application/json` and `Accept: application/json, text/event-stream`, returning `415 unsupported_media_type` or `406 not_acceptable` before authorization. GET `/mcp` handles the SSE receive channel and metadata-only resume path.
- Verification: Relay unit tests cover missing `Accept`, non-JSON `Content-Type`, preserved OAuth challenges for well-formed unauthenticated requests, and cached handoff behavior under the new header contract. `npm run product:check` passed.
- Review fallback: SubAgents were not used for this incremental protocol-hardening slice; the main thread ran separate compatibility, security/privacy, product, and maintainability passes.

### Remote MCP Session Slice

- Product fit: hosted MCP clients that follow Streamable HTTP session semantics can now receive a relay-issued `MCP-Session-Id` after `initialize`, reuse it on later POSTs, and explicitly end it with `DELETE /mcp`.
- Security/privacy: sessions are memory-only, bound to the authenticated client id, expire after 24 hours, and never persist MCP request bodies, Context Pack bodies, Raw Sources, OAuth tokens, or Vault content. Cross-client and expired session ids receive the same not-found response.
- Technical design: fulfilled `initialize` responses add `MCP-Session-Id`; non-initialize POSTs for a client with an active session fail closed with `400 missing_mcp_session` when the header is omitted; unknown session ids return `404 mcp_session_not_found`; `DELETE /mcp` terminates only the caller's own session.
- Verification: Relay unit tests cover session issuance, missing-session rejection, unknown-session rejection, same-client deletion, cross-client deletion refusal, updated CORS allowed methods, and metadata-only `/relay/state` exposure. `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay` passed.
- Review fallback: SubAgents were not used for this protocol slice; the main thread ran separate compatibility, security/privacy, operations, and maintainability passes.

### Relay HTTP Smoke Slice

- Product fit: product-grade checks now exercise the actual release Relay binary over HTTP, catching transport, header, session, and persistence issues that unit tests alone can miss.
- Security/privacy: the smoke uses a temporary encrypted Vault and state file, then asserts relay state and persisted metadata do not contain MCP response bodies, tool response content, or `MCP-Session-Id` values.
- Technical design: `scripts/run-relay-smoke.mjs` starts release `lcv-relay` on a random loopback port with static bearer enabled only for the local smoke, sends real HTTP requests with `Connection: close`, and cleans up the process plus temp directory.
- Verification: `npm run relay:smoke` passed locally and is now included in `npm run product:check`.
- Review fallback: SubAgents were not used for this verification-hardening slice; the main thread ran separate product, security/privacy, operations, and maintainability passes.

### Remote MCP SSE Receive Slice

- Product fit: hosted MCP clients can now open `GET /mcp` as an SSE receive channel instead of hitting a POST-only method boundary, which reduces connector compatibility risk while keeping `POST /mcp` as the only JSON-RPC request path.
- Security/privacy: SSE GET requires `Accept: text/event-stream` plus a valid bearer token, session ids remain client-bound, `Last-Event-ID` values are not persisted, and the ready event carries no Context Pack, Raw Source, tool result, or request body content.
- Technical design: the Relay emits a short `ready` SSE event with `retry: 5000`, a generated event id, and `lastEventIdReceived`. Unsupported `/mcp` methods now advertise `Allow: GET, POST, DELETE, OPTIONS`.
- Verification: Relay unit coverage was added for missing SSE Accept, unauthorized SSE GET, authorized ready events, Last-Event-ID non-persistence, and unsupported method boundaries. The release HTTP smoke now checks real-binary SSE behavior.
- Review fallback: SubAgents were not used for this incremental protocol slice; the main thread ran separate protocol compatibility, security/privacy, operations, and maintainability passes.

### Remote MCP SSE Metadata Slice

- Product fit: Relay operators can now see whether hosted MCP clients are opening the SSE receive channel and whether resume was requested, without needing packet logs or MCP body inspection. This makes connector setup failures easier to diagnose before a hosted beta.
- Security/privacy: Relay state exposes only generated SSE event ids, client id, optional session id, event type, timestamps, and a boolean `resumeRequested`. It still does not persist MCP bodies, Context Pack bodies, Raw Sources, tool responses, `MCP-Session-Id` values in the state file, or the actual `Last-Event-ID` cursor value.
- Technical design: `GET /mcp` now records a memory-only `RelaySseEvent` when it emits the `ready` SSE event. `/relay/state` reports `sseResumeSupported: true`, bounded `recentSseEvents`, and `sseEventCount`; persisted relay state remains limited to OAuth client registrations and request metadata.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay -- --nocapture` and `npm run relay:smoke` passed. The smoke now asserts real release-binary SSE event ids, metadata-only SSE diagnostics, `resumeRequested`, and non-persistence of raw `Last-Event-ID` values.
- Review fallback: SubAgents were not used for this incremental protocol-hardening slice; the main thread ran protocol compatibility, security/privacy, operations, and maintainability passes.

### Universal AI Access UX Slice

- Product fit: Connections now answers the main adoption question first: which endpoint to give a daily AI, which connection routes are supported, and why only Context Packs cross the boundary.
- Security/privacy: the new copy actions expose only MCP URL, OAuth/connector metadata, and diagnostic curl commands. They do not include Vault content, Context Pack bodies, Raw Sources, access tokens, or local encryption keys.
- UX/design: a redundant Connection readiness panel was removed after rendered review because the new Universal AI Access panel already covered readiness and the duplicate panel pushed service controls too far down the page.
- Verification: `npm test -- --run`, `npm run build`, desktop `1280x920` browser render, and mobile `390x844` browser render passed. Both viewports had no horizontal overflow, no clipped checklist/button text, and the old duplicate panel was absent.
- Review fallback: SubAgents were not used for this UI slice; the main thread ran separate product-fit, privacy, visual QA, and maintainability passes.

### Legacy Office Conversion Provider Slice

- Product fit: users with older life documents can now configure a local LibreOffice/soffice command and upload `.doc`, `.xls`, or `.ppt` without manually converting files outside the app first.
- Security/privacy: old Office binaries are still blocked by default. When enabled, conversion runs as an explicit local command with no shell expansion, a private temp directory, a bounded timeout, minimal environment variables, and no cloud upload; extracted text still creates only Source plus unapproved MemoryCandidates.
- Technical design: the native extractor detects legacy Office separately, maps it to DOCX/XLSX/PPTX output targets, runs the configured converter with `{input}`, `{output_dir}`, `{output}`, and `{target_ext}` placeholders, then re-enters the existing native extraction pipeline. Runtime preferences and Settings expose command, arguments, and timeout.
- UX/design: Settings includes OS-specific LibreOffice install commands and editable conversion arguments. The Sources upload copy now distinguishes OCR Provider and Legacy Office conversion Provider readiness.
- Verification: `npm test -- --run src/sourceUpload.test.ts`, `cargo test --manifest-path src-tauri/Cargo.toml native_document_extraction`, `npm run build`, desktop `1280x920` Settings render, and mobile `390x844` Settings render passed with no horizontal overflow or clipped provider fields.
- Review fallback: SubAgents were not used for this local extraction slice; the main thread ran separate product-fit, security/privacy, technical, and visual QA passes.

### Legacy Office Provider Detection UX Slice

- Product fit: users who already have LibreOffice installed can now configure old Office conversion without knowing the command path or arguments.
- Security/privacy: provider discovery only checks file existence in PATH and common install locations; it does not execute LibreOffice, read documents, or create Sources.
- Technical design: the native detection command mirrors OCR discovery, returns command/argument/timeout candidates, and deduplicates PATH/common-path results before the Settings view offers one-click preference setup.
- UX/design: the Settings card now shows detected LibreOffice candidates above install guides and includes explicit copy that detection has not run the provider or sent documents.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml provider_detection`, `npm run build`, and Playwright desktop `1280x920` plus mobile `390x844` Settings renders passed with no horizontal overflow.
- Review fallback: SubAgents were not used for this narrow detection slice; the main thread ran separate product-fit, privacy, technical, and visual QA passes.

### Adversarial Security Hardening Slice

- Product fit: external AI clients now follow the product promise more strictly: every MCP Context Pack request waits for user review, and confirmed Packs still expire before reuse.
- Security/privacy: Relay handoff requires `LCV_RELAY_HANDOFF_SECRET` signatures, confirmed Pack state, matching request/client metadata, and unexpired expiry. Pairing codes are single-use, Agent logs redact pairing secrets, Relay HTTP reads have body/header limits plus read timeouts, provider subprocess output is drained with bounded buffers, and plaintext migration backups are removed after verified encrypted migration.
- Technical design: the Relay validates handoff signatures before inserting the memory-only cache, MCP sidecar requests use `always_review`, Context Pack status checks apply `expiresAt` even after confirmation, and OCR/Legacy Office execution no longer depends on `wait_with_output` pipe draining after process exit.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml` passed. New coverage includes noisy provider output, conversion failure temp cleanup, confirmed-but-expired Pack refusal, low-risk MCP queueing, signed Relay handoff, Relay HTTP size limits, single-use pairing, redacted Agent URLs, S256-only PKCE, and plaintext migration backup deletion.
- SubAgent disposition: fixed material P1/P2 security and engineering findings for Provider execution deadlock, temp cleanup, Relay body limits, PKCE mismatch, Context Pack TTL, low-risk external auto-send, unsigned handoff, pairing reuse/log leakage, plaintext migration backup retention, and key-file fallback permissions.

### Remote MCP Connection Diagnostics UX Slice

- Product fit: the first Connections panel now lets a user copy the MCP URL immediately, while the Remote Relay setup section includes health and `/mcp` smoke-test commands that match the Relay's Streamable HTTP header contract.
- Security/privacy: diagnostic commands do not include Vault data, Context Pack bodies, OAuth tokens, or Raw Sources. The `/mcp` smoke test is intentionally unauthenticated and should produce an OAuth challenge when the Relay is reachable.
- UX/design: the top panel keeps only one extra copy action so the first Connections card stays compact; detailed health and MCP check commands live in the existing Remote Relay setup grid.
- Verification: `npm test -- --run`, `npm run build`, and `git diff --check` passed. Browser checks at desktop `1280x920` and mobile `390x844` confirmed no page-level horizontal overflow, no overflowing buttons, a compact top AI Access panel, and the lower Remote Relay diagnostic card present.
- Review fallback: SubAgents were not used for this UI polish slice; the main thread ran separate product, security/privacy, visual QA, and maintainability passes.

### General-User Control Center UX Hardening Slice

- Product fit: Connections now starts with plain routes for ChatGPT/Claude Web, Claude Desktop/local MCP, browser Capture, and copy fallback. The UI explicitly says hosted web AIs need a public HTTPS Relay instead of localhost, while developer relay commands are moved under an advanced diagnostics disclosure.
- Security/privacy: Recent Captures shows what was locally captured, the source AI, retention deadline, candidate count, and sensitivity guess. Users can purge a single captured transcript body or all active captured transcript bodies without deleting the audit trail; Source lifecycle safeguards still move linked Facts back to review and invalidate existing Context Packs.
- Safety UX: Settings now requires encrypted backup restore preview before replacement. Restore needs a typed `RESTORE` confirmation, and destructive Vault clear needs typed `CLEAR`; both checks are enforced in the execution functions, not only in button disabled states.
- Terminology: visible product copy now treats the app as a Control Center and AI Access Layer rather than a local PoC simulator. Requests copy describes preparing and confirming incoming Context requests instead of simulating them.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Playwright desktop `1440x1200` and mobile `390x1200` renders for Connections and Settings had no horizontal overflow. A manual Capture flow created a Recent Captures row with one active transcript, verified individual purge changed it to "本文消去済み", and confirmed delete-all controls were present without exposing Raw Source text outside the local UI.
- SubAgent disposition: this slice addresses the product/UX review P1s for developer-heavy connection setup, risky restore/clear controls, and incomplete Passive Capture trust controls. Remaining hosted connector provisioning and bundled OCR polish stay outside this local UX slice.

### Hosted Relay Agent Connection Slice

- Product fit: Web AI access no longer stops at "deploy a Hosted Relay and copy commands." Connections now includes a three-step Hosted Relay Agent panel where a user can paste a short-lived `agentWebSocketUrl`, start the local Agent process, and copy the public MCP URL for ChatGPT/Claude Web.
- Security/privacy: The desktop app does not persist the pairing URL and clears it from the UI after launch. Hosted Agent URLs are WSS-only, must point exactly to `/agent/ws`, must include only a non-empty `pairing_code`, and reject userinfo/fragments/extra query params. `lcv-agent` writes local `agent-status.json` only after Relay sends `agent_ready`, redacts the Agent URL query in last-error text, and never writes Vault data, Raw Source, MCP request bodies, or Context Pack bodies. Starting a hosted Agent stops any app-managed local Relay process, keeps the Vault on the user's device, and preserves the Context Pack-only boundary.
- Technical design: `lcv-agent` now enables `tungstenite` `rustls-tls-native-roots`, so `wss://.../agent/ws?pairing_code=...` URLs from public HTTPS relays can connect. Tauri exposes `start_ai_access_agent_for_relay`, derives the hosted MCP URL for status, distinguishes `hosted_agent` from local managed Relay mode, passes `LCV_AGENT_STATUS_PATH` and a per-spawn `LCV_AGENT_STATUS_TOKEN` to the Agent, and marks hosted `agentConnected` only when the fresh Agent status file reports `connected` for the matching Relay base URL, current child process id, and status token. Relay now sends an explicit `agent_ready` after `connect_agent` succeeds; before that ACK, Agent pings and MCP traffic cannot mark the status as connected. After readiness, Relay sends periodic WebSocket pings so status freshness is tied to Relay I/O rather than an Agent-only timer, cleans up Agent state on error exits with pairing-id matching, requires the exact `/agent/ws` path, and app-managed Agents do not auto-reuse single-use pairing URLs after disconnect.
- UX/design: Hosted Relay setup is a normal Connections panel rather than hidden under diagnostics. It previews the MCP URL to register with ChatGPT/Claude, separates "saved on this device", "sent to AI", and "kept on Relay", disables every public MCP URL / connector copy path until pairing is confirmed, shows user-facing status labels for this device, Relay confirmation, last check, and problem state, and moves the self-host pairing command into an advanced disclosure.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Focused Rust checks passed for WSS pairing URL validation, hosted runtime status matching, exact Agent WebSocket path detection, Relay `agent_ready` handling, and `lcv-agent` status-file redaction. A local Relay/Agent run confirmed valid pairing reaches `connected` with `relayBaseUrl` and no pairing secret only after Relay ACK, while an invalid pairing remains `disconnected`. Headless Chrome/CDP checked the Connections Hosted Relay panel at desktop `1440x900` and mobile `390x844`: the Hosted Relay heading, MCP URL preview, setup copy, and natural-language storage/send/Relay boundary rendered with no page-level horizontal overflow. Before confirmed pairing, Web AI connector-info copy and Hosted MCP URL copy are disabled and the URL is labeled as a post-pairing preview. `src/aiAccessUi.test.ts` fixes the hosted-pending copy contract so alternate public MCP URL and connector-copy paths stay disabled until pairing is confirmed.
- SubAgent disposition: fixed security/technical findings for public `ws://` rejection, stale hosted URL on launch failure, stricter path/query validation, closed `relayMode` and runtime status typing, clearing pairing URLs from the UI, process-liveness/ACK confusion, stale status trust, extra query leakage, Relay cleanup on error exits, non-exact `/agent/ws` routing, pending-hosted alternate copy paths, Agent-only heartbeat freshness, pre-ACK freshness updates, and single-use pairing auto-reconnect ambiguity. Fixed UX findings for premature Web AI connector copy, technical status labels, localhost Web connector copy, checklist copy, public copy gating, and buried trust boundaries. Remaining future improvement: richer Relay-origin heartbeat metadata for hosted fleet operations.

### AI Confirmation Inbox Slice

- Product fit: Requests now behaves more like the user's approval inbox for real AI requests. The primary surface is "AIへ返す前の確認待ち" with pending/ready/closed counts, while manual test request creation remains available but is moved into an advanced disclosure.
- UX/design: The pack preview is framed as "この内容だけAIへ渡す." Primary actions say exactly what happens: allow only this content, confirm-and-copy fallback, draft a local answer, or deny without sending. Request rows show client, status, task, creation time, and expiry. The preview now shows why each fact/snippet is included, source snippets when available, and an explicit zero-snippet state when Raw Source text or high-sensitivity source titles are intentionally not sent.
- Security/privacy: The flow keeps the Context Pack boundary unchanged. It makes send/copy actions more explicit, preserves existing deny/expire behavior, and displays excluded items plus user-hidden facts before approval. Manual tests still go through the same confirmation and audit path as MCP requests.
- Review fallback: Product fit review checked that the screen no longer leads with a simulator. Security/privacy review checked that copy/approve actions still use existing confirmation and policy gates. UI/UX review checked that the left column communicates queue state before advanced testing controls and fixed the misleading `approved`/`fulfilled` classification so only fulfilled requests count as AI-retrievable. Maintainability review kept the change scoped to presentation and helper labels, with no data model change.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Chrome/CDP checked the Requests flow at desktop `1280x900` and mobile `390x844`: demo data loads, the manual advanced test creates a short-lived Pack, `approved` but unfulfilled requests count as "対応待ち" rather than "AI取得可", approval/copy/local-deny actions render, the source-snippet empty state is visible when no snippet is sent, old simulator copy is absent, and there is no page-level horizontal overflow.

### Connections Progressive Disclosure Slice

- Product fit: Connections now leads with the user-level connection choices and keeps the product promise visible: Web AI via Hosted Relay, local AI via MCP, Capture, and copy fallback. Deeper policy, runtime, local MCP, relay diagnostics, browser extension host, and manual capture settings are still available, but no longer dominate the initial page.
- UX/design: The advanced sections are converted to compact disclosure panels with short descriptions and status badges. The first mobile pass now shows the actionable connection choices before long operational detail, while Passive Capture controls and recent capture review remain visible because they are day-to-day controls rather than rare setup.
- Security/privacy: Progressive disclosure does not remove any boundary controls. Sensitivity ceilings, domain allowlists, runtime controls, relay diagnostics, and Native Messaging setup remain explicit user actions behind summaries; the Relay/Context Pack boundary copy stays visible before advanced options.
- Review fallback: Product fit review flagged Connections as too dense for general users. UI/UX review checked desktop and mobile screenshots and kept the primary connection options visible. Security/privacy review verified that hidden sections are still reachable and that hiding them does not imply auto-approval or auto-capture. Maintainability review kept the change to presentation structure and shared disclosure styling.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Chrome/CDP checked Connections at desktop `1280x900` and mobile `390x844`: six setup disclosures render closed by default, top connection choices and Hosted Relay remain visible, collapsed sections can be opened through native `summary`, the policy controls render after opening, and there is no page-level horizontal overflow.

### Home Source Provenance Slice

- Product fit: Home now preserves the "sourced life context" promise in the first-use dashboard. Background Snapshot passes Source records into Fact rendering, so source-backed facts show titles such as Guided background setup or Sample insurance renewal note instead of "Unknown source."
- UX/design: Fact source labels now use a shared `factSourceNames` helper that distinguishes real source titles, missing sources, no-source facts, and truncated multi-source lists. This keeps Home, Search, and review rows aligned without adding another visual pattern.
- Security/privacy: The change displays existing Source titles already visible elsewhere in the app and does not expose Raw Source body text or unapproved MemoryCandidate text. Missing sources are labeled explicitly instead of implying a source exists.
- Review fallback: Product fit review flagged "Unknown source" in Home as a trust regression. Security/privacy review checked that only titles, not Source bodies, are displayed. Maintainability review added unit coverage for source-title formatting so the regression is harder to reintroduce.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Chrome/CDP checked Home at desktop `1280x900` and mobile `390x844`: demo Background Snapshot shows Guided background setup and Sample insurance renewal note, no Unknown source or Source未検出 appears, and there is no page-level horizontal overflow.

### Memory Inbox Empty Start Slice

- Product fit: first-time users who open an empty Memory Inbox now get direct entry points for background setup, document/manual Sources, and AI chat Capture setup instead of a dead-end explanatory state.
- UX/design: the empty state keeps the existing quiet Control Center style, uses three familiar icon buttons, and adds one compact trust note that separates "saved as a Fact" from "sent to AI."
- Security/privacy: the new actions do not create Facts or enable Capture by themselves. They only navigate to existing user-controlled flows, and the empty-state copy reinforces that candidates require approval before Context Pack use.
- Review fallback: Product fit review flagged empty Inbox as a likely first-run stall. Security/privacy review confirmed no automatic saving or sending was added. UI/UX review checks desktop and mobile button layout, focusable controls, and no horizontal overflow. Maintainability review keeps the change scoped to `InboxView` presentation and one static rendering test.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Browser/Playwright checked the empty Inbox at desktop `1280x900` and mobile `390x844`: all three entry buttons render, the trust boundary copy is visible, each button navigates to the intended Control Center view, keyboard Tab reaches the three actions, and there is no page-level horizontal overflow.

### Search Memory Inventory Slice

- Product fit: Search now acts as a memory inventory, not only a text search. Users can see how many ApprovedFacts are AI-eligible, waiting for review, hidden/deleted, or retained only as history/expired context.
- UX/design: the inventory uses the existing compact metric style, keeps the Active-only Context Pack rule in a short trust note, gives empty Search users direct Sources/Inbox entry points, and shows hidden/deleted Facts in an "Outside AI context" section with an explicit restore action. Expired context remains counted with history instead of being directly restored without a date review.
- Security/privacy: restoring an excluded Fact is a user action labeled `AI候補へ戻す`. The change does not broaden retrieval; it makes the existing Active-only boundary more visible and keeps Raw Source bodies and unapproved candidates out of Search results.
- Review fallback: Product fit review flagged "what does the Vault remember and what can AI use?" as a daily trust question. Security/privacy review checked that excluded Facts stay outside Context Packs until explicit restore. UI/UX review checked desktop and mobile inventory density, action labels, and no horizontal overflow. Maintainability review added `factInventoryCounts` coverage so state-category drift is visible.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Browser/Playwright checked Search at desktop `1280x900` and mobile `390x900`: empty Search shows Sources/Inbox actions and the Active-only rule; demo data shows 4 AI candidates; hiding a Fact changes counts to 3 AI candidates and 1 hidden/deleted, renders the Outside AI context section, and `AI候補へ戻す` restores counts to 4/0 with no page-level horizontal overflow.

### Sources Review Queue Slice

- Product fit: Sources now connects the "add a document or memo" action to the next required step. Source-backed unapproved candidates appear in a local review queue with an `Inboxで承認` action, so users do not have to infer where newly extracted memories went.
- UX/design: the queue uses the existing panel and row language, previews up to three pending candidate facts, keeps one primary action, and stacks cleanly on mobile. It appears only when there is actual user work waiting.
- Security/privacy: the queue displays only MemoryCandidate text already created locally from the Source and repeats that these candidates are not Facts, Context Pack candidates, or AI-bound content until Inbox approval. It does not approve, send, or widen policy automatically.
- Review fallback: Product fit review flagged Sources as a first-run handoff risk after upload/manual entry. Security/privacy review checked that the queue includes only source-backed unapproved statuses and not approved/rejected candidates. UI/UX review checked desktop/mobile layout and the click path into Inbox. Maintainability review added `sourceReviewCandidates` coverage for the filtering boundary.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Browser/Playwright checked Sources at desktop `1280x900` and mobile `390x900`: adding a manual Source creates one pending candidate, the Sources review queue renders the candidate and trust boundary, `Inboxで承認` opens Memory Inbox with one candidate card and save action, and there is no page-level horizontal overflow.

### Connections Copy Fallback Route Slice

- Product fit: the Connections "MCPなしでコピー" route now sends users to Context Requests instead of copying the MCP URL. This matches the product promise that copy fallback means "review a Context Pack, then copy its content to any AI."
- UX/design: the first-screen connection cards keep one clear action per route. Web/local routes still copy or install connector setup, while the fallback route uses `Requestsで確認・コピー` with the same card density and mobile layout.
- Security/privacy: the route does not expose a connector URL as a substitute for approved content. Users land in the existing Context Pack confirmation flow, preserving minimization, exclusions, audit receipts, and explicit send/copy decisions.
- Review fallback: Product fit review flagged the old fallback button as misleading because it copied an MCP endpoint rather than the AI-bound pack content. Security/privacy review confirmed no new data path was added. UI/UX review checked desktop/mobile Connections cards and the click path to Requests.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Browser/Playwright checked Connections at desktop `1280x900` and mobile `390x900`: the card is labeled `MCPなしでコピー`, the old `現在の入口をコピー` button is absent, `Requestsで確認・コピー` appears once, clicking it opens Context Requests, and there is no page-level horizontal overflow.

### Requests Copy Fallback Starter Slice

- Product fit: users who arrive in Context Requests without a live MCP request now see a direct copy-fallback starter instead of a hidden manual test control. This completes the "MCPなしでコピー" route as an actual first-use path.
- UX/design: the empty Requests state keeps the existing approval-inbox layout, adds one compact starter panel, and leaves the advanced manual test folded only after there is already request or pack context on the page.
- Security/privacy: the starter reuses the existing `buildPack` flow, so the user still reviews the generated Context Pack before copying or generating an answer. No Fact, Source body, or connector endpoint is sent just by opening the starter.
- Review fallback: Product fit review checked the Connections-to-Requests handoff. Security/privacy review confirmed the same Context Pack boundary, exclusions, and confirmation gate remain in force. UI/UX review checks desktop/mobile empty Requests, form labels, and no horizontal overflow. Maintainability review added `shouldShowCopyFallbackStarter` coverage for the empty-state rule.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Browser/Playwright checked desktop `1280x900` and mobile `390x900`: demo data can route from Connections to Requests, the empty Requests inbox shows `MCPなしでContext Packを作る`, the advanced manual-test summary is hidden in that state, `確認用Context Packを作成` generates a Context Pack preview with `確認してコピーFallback`, and there is no page-level horizontal overflow.

### Home First Context Pack Slice

- Product fit: Home now treats the first Context Pack trial as the next value moment after ApprovedFacts exist, even when MCP/Agent setup is not ready. AI connection setup becomes the follow-up for repeated use instead of blocking the first useful copy-fallback experience.
- UX/design: the first-10-minutes checklist now reads `生活背景を入れる -> 候補を承認する -> Context Packを試す -> AI連携を常用化する`. The next-action card sends users to Requests with copy-fallback wording rather than asking them to start AI Access first.
- Security/privacy: no AI boundary changed. The Home action only opens Requests; Pack generation, exclusions, confirmation, copy, and Audit still happen in the existing Context Pack path.
- Review fallback: Product fit review flagged the previous Home priority as over-optimizing for MCP setup before the user had felt value. Security/privacy review confirmed copy fallback still requires Pack preview. UI/UX review checks Home checklist order, next-action copy, desktop/mobile layout, and the Requests handoff. Maintainability review added `homeNextActionKind` coverage for the priority rule.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Browser/Playwright checked desktop `1280x900` and mobile `390x900`: after demo data, Home shows `Context Packを試す` as the next action, checklist step 3 is Context Pack before AI connection step 4, `Packを確認` opens the Requests copy-fallback starter, and there is no page-level horizontal overflow.

### Audit Domain Receipt Slice

- Product fit: Audit receipts now explain what kind of life context was AI-bound by domain, such as `契約・保険` or `制約・配慮`, instead of only showing counts. This better matches the general-user promise that users can understand what each AI received.
- UX/design: the receipt stays compact and natural-language, reusing the existing delivery-receipt row. It shows domain summary, Fact/snippet/exclusion counts, channel, and trust boundary without adding a heavy detail drawer.
- Security/privacy: Audit still does not store Pack body, Fact text, Raw Source body, or unapproved candidate text. The new metadata is limited to included life-domain ids derived from already-confirmed Pack items.
- Review fallback: Product fit review flagged count-only receipts as weak for "what was sent?" Security/privacy review confirmed domain ids are metadata, not Pack body. UI/UX review checked receipt readability on desktop/mobile. Maintainability review added tests for receipt copy and metadata leakage.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Browser/Playwright checked desktop `1280x900` and mobile `390x900`: after copy fallback, Audit shows a receipt like `制約・配慮、価値観・希望、本人情報の文脈`, includes ApprovedFact/snippet/exclusion counts, states that Raw Source body and unapproved candidates were not included, does not show Fact/Source body text, and has no page-level horizontal overflow.

### Manual Copy Fallback Payload Slice

- Product fit: copy fallback now still works when the browser or OS blocks Clipboard writes. Requests displays the AI-bound Context Pack payload after an explicit copy attempt fails, so users can manually copy into any AI instead of hitting a dead end.
- UX/design: the manual fallback appears inside the active Pack preview only for the affected Pack. It uses a fixed-height readonly payload field, one primary `手動コピー済みとしてAudit記録` action, and a secondary close action.
- Security/privacy: the payload is shown only after the user explicitly asks to copy the Pack. It is not stored as a new persisted object; before recording the manual delivery receipt, the app re-checks the current Pack policy and Audit still stores only metadata.
- Review fallback: Product fit review flagged the old Clipboard failure notice as dishonest because no content was actually displayed. Security/privacy review confirmed the fallback does not bypass Pack confirmation or add body text to Audit. UI/UX review checked desktop/mobile fallback layout and close behavior. Maintainability review added `manualCopyPayloadForPack` coverage so stale payloads cannot appear for another Pack.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. Headless Browser/Playwright forced `navigator.clipboard.writeText` failure at desktop `1280x900` and mobile `390x900`: copy fallback displayed a readonly `ContextPack only` payload for the active Pack, `手動コピー済みとしてAudit記録` closed the panel and added the delivery receipt, Audit still stated that Raw Source body and unapproved candidates were not included, and there was no page-level horizontal overflow.

### Connection Diagnostics Slice

- Product fit: Connections now gives users a single diagnostic receipt for whether their Desktop Vault, Relay, Local Agent, and Web AI route are usable. This turns scattered status metrics into one next action, which is important when the product promise is "your usual AI can call your life context."
- UX/design: the new card keeps the existing quiet Control Center style, adds one primary action based on the current state, and stacks its four readiness checks into one column on mobile. It avoids exposing advanced Relay commands unless the user opens the existing advanced section.
- Security/privacy: the diagnostic uses metadata-only service status. It does not display Vault content, Context Pack body text, Raw Source text, unapproved candidates, pairing codes, or bearer tokens; hosted connection errors are redacted before display.
- Review fallback: Product fit review flagged Connections as too fragmented for general users to recover from setup issues. Security/privacy review added UI-level redaction even though Rust already redacts Agent logs. UI/UX review checked desktop/mobile layout and button sizing. Maintainability review put the state classification in `aiConnectionDiagnostic` so Hosted/Local/offline behavior has unit coverage.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. In-app Browser checked Connections at desktop `1280x900` and mobile `390x900`: the diagnostics card renders the next action and four readiness states, buttons stay at usable touch size, and there is no page-level horizontal overflow. Browser screenshot capture timed out in this environment, so verification used rendered DOM dimensions and text checks.

### Home Capture Safety Slice

- Product fit: Home now shows Passive Capture as a daily safety control rather than a hidden Connections-only setting. Users can see whether Capture is paused or active, which sites are allowed, whether anything was recently captured, and how many stored transcript bodies can be purged.
- UX/design: the card keeps the existing compact Control Center style and adds one-click `Captureを開始` / `Captureを一時停止`, `Capture詳細`, and `全本文を消去` actions. Long site allowlists are summarized as the first two sites plus a count so Home stays scannable.
- Security/privacy: the card states that Capture only creates unapproved candidates and that Fact creation plus AI sending still require Inbox and Context Pack confirmation. Purge counts only active passive-browser Sources, not already purged bodies.
- Review fallback: Product fit review flagged Home as missing the "am I currently recording AI conversations?" answer. Security/privacy review checked that no new automatic Fact creation or AI sending path was added. UI/UX review found and fixed a narrow-column wrapping issue in the site summary. Maintainability review added `homeCaptureSafetySummary` coverage for active, paused, and purged states.
- Verification: `npm test`, `npm run build`, `git diff --check`, and `npm run product:check` passed. React static rendering verifies the Home Capture Safety card renders Pause/Start, detail, purge actions, allowed-site summary, recent capture preview, and the unapproved-candidate boundary. Browser automation could not complete in this slice because both in-app Browser and Chrome Browser connections returned a closed native pipe, so desktop/mobile layout screenshot QA remains to rerun when Browser automation is healthy.

### Restore Receipt Slice

- Product fit: Settings restore preview now behaves like a migration receipt, not just a destructive count check. It separates what the encrypted backup contains from what the current Vault will lose or replace, covering Source bodies, Approved Facts, Inbox candidates, Context Requests/Packs, AI connection metadata, Policies, Passive Capture events, and Audit receipts.
- UX/design: the receipt follows the existing compact Control Center style with 8px cards, no nested page cards, and short natural-language explanations. Desktop renders the backup contents and replacement scope side by side; mobile stacks them into one hierarchy so general users can read the restore risk before typing `RESTORE`.
- Security/privacy: the preview uses metadata only. It reports byte counts, sensitivity ceiling, TTL-expired Capture counts, active/paired connection counts, and audit counts without exposing Backup JSON, passphrases, Source body text, Context Pack payloads, or unapproved candidate text. It explicitly reminds users that restore does not automatically send anything to external AI.
- Review fallback: Product fit review flagged restore as a trust-critical device migration path. Security/privacy review checked that the receipt does not echo sensitive backup contents and that paired AI connection metadata is called out for post-restore review. UI/UX review checked desktop/mobile wrapping and the separation between "saved in Vault" and "sent to AI." Maintainability review put the receipt classification in `makeRestorePreview` with unit coverage.
- Verification: `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `git diff --check`, and `npm run product:check` passed. System Chrome headless rendered Settings restore preview at desktop `1280x900` and mobile `390x844`: desktop uses two receipt columns, mobile uses one, the restore buttons remain visible, and neither the page nor `.restore-preview` has horizontal overflow.

### Remote MCP SSE Replay Policy Slice

- Product fit: Connections and Relay diagnostics now separate "SSE ready channel works" from "event replay/resume is supported." This avoids misleading hosted-client setup during provider certification and gives operators a precise `/relay/state` signal.
- Security/privacy: that slice made replay capability explicit without persisting `Last-Event-ID` values, MCP bodies, Context Pack bodies, Raw Sources, or tool responses. The later metadata-resume slice upgrades the advertised policy to generated-id replay while preserving that storage boundary.
- Technical design: `GET /mcp` ready payloads and `/relay/state` now carry the same replay policy. Connections labels the command as an SSE ready check and keeps durable resumability separate from the current memory-only metadata replay window.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay -- --nocapture`, `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `npm run relay:build`, `npm run relay:smoke`, and `git diff --check` passed for that earlier policy slice. The later metadata-resume slice updates the UI helper and release smoke to advertise generated-id metadata replay. System Chrome headless rendered Connections at desktop `1280x900` and mobile `390x844`: `SSE診断をコピー` is visible, buttons do not overflow, and there is no page-level horizontal overflow.
- Review fallback: SubAgents were not used for this incremental protocol/UX slice; the main thread ran protocol compatibility, security/privacy, product, and maintainability passes.

### Remote MCP SSE Metadata Resume Slice

- Product fit: hosted MCP clients can now reconnect with a Relay-generated SSE event id and receive a concrete metadata-only resume acknowledgement instead of a permanent "replay unsupported" signal. This reduces provider-certification risk while keeping the external data boundary as Context Pack only.
- Security/privacy: resume works only for generated event ids already present in the bounded in-memory SSE window for the same client/session stream. Unknown client-provided `Last-Event-ID` values are not stored or echoed, and replayable payloads are Relay metadata only; Context Pack bodies, MCP response bodies, Raw Sources, tool results, OAuth tokens, and session ids are not written to persisted relay state.
- Technical design: `RelaySseEvent` now carries `streamId`, monotonic `sequence`, and a metadata payload. GET `/mcp` builds a replay plan from `Last-Event-ID`, replays missed metadata events from memory, emits the current `ready` event, and reports `resumeSupported: true`, `replayPolicy: metadata_only_per_stream_replay`, `lastEventIdStored`, and `replayedEventCount`.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay -- --nocapture`, `npm run relay:build`, `npm run relay:smoke`, `npm run mcp:build`, `npm run relay:sse-soak`, `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. Chrome visual checks verified Connections at desktop `1280px` and mobile `390px`: metadata-resume copy renders, old unsupported-replay copy is absent, and neither viewport has page-level horizontal overflow.
- Review fallback: SubAgents were not used for this incremental protocol slice; the main thread ran protocol compatibility, security/privacy, product fit, UI/UX, and maintainability passes.

### Storage Backup And Handoff Hardening Slice

- Product fit: large uploaded documents now project into multiple deterministic Source chunks, which keeps the Vault architecture aligned with the planned `source_chunks` retrieval model instead of letting one huge Source dominate indexing. Backup copy now explains and enforces stronger user-chosen protection for the full life-context export.
- Security/privacy: encrypted browser fallback backups now require a stronger passphrase and use a higher PBKDF2 iteration count for new exports while keeping legacy restore compatibility. Relay handoff cache storage now canonicalizes a valid signed response before caching so extra Raw Source, full Vault, unapproved Candidate, or raw tool-result fields cannot persist in the short-lived handoff cache.
- Technical design: Source projection uses a 4,000-character target chunk with a 300-character overlap and stable chunk ids. Backup payloads carry `iterations`, defaulting to 600,000 on export and falling back to 120,000 for older imports. Handoff validation returns a canonical MCP response containing only the approved Context Pack boundary fields.
- Verification: `npm test -- --run src/vault.test.ts src/aiAccessUi.test.ts`, focused Rust projection and handoff tests, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. Chrome visual checks verified Settings at desktop `1280px` and mobile `390px`: stronger backup passphrase guidance and risk copy render, old Export copy is absent, and neither viewport has page-level horizontal overflow. `cargo fmt` is still skipped by the release check because rustfmt is not installed for the active toolchain.
- Review fallback: SubAgents were not used for this incremental hardening slice; the main thread ran performance, security/privacy, backup/restore compatibility, UI/UX, and maintainability passes.

### Hosted Relay Readiness Gate Slice

- Product fit: hosted Relay readiness now has explicit operator commands instead of prose-only deployment expectations. `hosted-relay:check` catches dangerous public settings before deployment, and `hosted-relay:smoke` verifies a real HTTPS endpoint after provisioning.
- Security/privacy: the config gate rejects public static bearer fallback, direct Vault sidecar settings, hosted Vault paths/keys, non-HTTPS origins, wildcard CORS, missing tenant id, and short/matching admin or handoff secrets. The public smoke keeps the same Context Pack boundary and checks that optional `/relay/state` output is metadata-only.
- Technical design: `product:check` validates the documented hosted baseline without needing a real domain, while `product:check:full` now adds local SSE soak coverage. Real provider certification remains a deployment task because it requires a public HTTPS Relay and provider-side connector registration.
- Verification: `npm run hosted-relay:check -- --example`, `npm run relay:sse-soak`, and `git diff --check` passed. `node scripts/hosted-relay-smoke.mjs` was intentionally not run against a real endpoint in this local slice and correctly fails fast without `LCV_HOSTED_RELAY_URL`.
- Review fallback: SubAgents were not used for this incremental release-gate slice; the main thread ran product fit, security/privacy, operations, and maintainability passes.

### Remote MCP OAuth Smoke Slice

- Product fit: release smoke now exercises the real daily-AI authorization path instead of relying only on the static local bearer fallback: dynamic OAuth client registration, human-readable approval page, authorization-code redirect, S256 PKCE token exchange, and OAuth bearer MCP `tools/list`.
- Security/privacy: the smoke asserts the approval page explains the Context Pack boundary, and that persisted Relay state excludes OAuth access tokens, authorization codes, PKCE verifiers, MCP session ids, MCP tool responses, Vault data, Raw Sources, and Context Pack bodies. It also covers unsafe redirect URI rejection, wrong PKCE verifier rejection, wrong resource rejection, authorization-code reuse rejection, and insufficient-scope `403`.
- Technical design: `scripts/run-relay-smoke.mjs` generates verifier/challenge pairs, requests the full Life Context scope set with `resource=<relay>/mcp`, approves loopback authorization sessions, exchanges the code, and then calls `/mcp` with the issued OAuth bearer token.
- Verification: `node --check scripts/run-relay-smoke.mjs`, `npm run relay:smoke`, and `npm run product:check` passed.
- Review fallback: SubAgents were not used for this incremental protocol slice; the main thread ran product fit, OAuth/protocol compatibility, security/privacy, and maintainability passes.

### Hosted Relay OAuth Hardening Slice

- Product fit: hosted Relay deployments now fail faster on dangerous production settings before a user tries to connect ChatGPT/Claude Web. The product promise depends on Web AI access being OAuth-first and owner-approved, not a public bearer-token shortcut.
- Security/privacy: non-loopback Relay binds now reject static bearer fallback entirely, hosted config checks reject `LCV_RELAY_AUTO_APPROVE`, public OAuth approval requires owner/admin authorization, redirect URIs are validated for safe schemes/hosts/no fragments/no control characters, PKCE verifiers must meet length/character requirements, and handoff TTL is capped at 600 seconds for hosted deployments.
- Technical design: Relay MCP authorization now distinguishes missing/invalid bearer tokens from insufficient scopes, returning `401` OAuth challenges for unauthenticated clients and `403 insufficient_scope` for under-scoped tokens. Hosted deployment docs now call out auto-approve, redirect URI, and handoff TTL boundaries.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay -- --nocapture`, `npm run hosted-relay:check -- --example`, `npm run relay:smoke`, and `npm run product:check -- --include-sse-soak` passed.
- Review fallback: SubAgents were not used for this incremental security slice; the main thread ran protocol compatibility, security/privacy, operations, and maintainability passes.

### Hosted OAuth Smoke Completion Slice

- Product fit: deployed Relay smoke can now verify the provider-facing OAuth path before Agent pairing, then optionally require the paired Agent for a full end-to-end connector rehearsal.
- Security/privacy: the hosted smoke still runs metadata/CORS/challenge checks without admin credentials and verifies that OAuth metadata advertises CIMD support. With `LCV_RELAY_ADMIN_TOKEN`, it verifies that public browser approval remains owner-gated, uses admin-authenticated approval to exercise DCR, `resource=<origin>/mcp`, S256 PKCE, token exchange, pending-agent handling, and metadata-only `/relay/state`, and asserts state output excludes OAuth tokens, authorization codes, and PKCE verifiers.
- Technical design: `scripts/hosted-relay-smoke.mjs` treats `pending_agent_offline` as a valid OAuth-readiness result unless `LCV_HOSTED_RELAY_REQUIRE_AGENT=1` is set. Full Agent-backed `initialize`/`tools/list` remains available for staging connector rehearsals without making early public endpoint checks brittle.
- Verification: `node --check scripts/hosted-relay-smoke.mjs`, `npm run hosted-relay:check -- --example`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed; `node scripts/hosted-relay-smoke.mjs` correctly fails fast without `LCV_HOSTED_RELAY_URL`. Live hosted OAuth smoke remains pending until a real staging endpoint exists.
- SubAgent disposition: closes the remaining P2 release-gate gap in code by adding the staging smoke path and separating OAuth readiness from Agent readiness. Real public-provider readiness still requires provisioning the HTTPS Relay and running this smoke against that environment.

### Hosted Relay Registration UX Slice

- Product fit: Connections now shows a `Web AI registration` readiness receipt and provider-specific guide cards inside the Hosted Relay panel, so users can tell whether ChatGPT, Claude Web, or copy-fallback setup is blocked by Desktop app state, malformed Agent URL, unconfirmed pairing, missing public HTTPS MCP URL, or metadata readiness.
- UX/design: the receipt follows the existing compact status-card language, keeps the Hosted Relay panel as the single place for Web AI setup, and gives each provider a concrete next action without exposing advanced self-host commands by default.
- Security/privacy: the readiness helper never echoes the pasted `pairing_code`, treats public Web AI registration as ready only after confirmed hosted pairing plus a non-local HTTPS MCP URL, and repeats that the AI-bound boundary is Context Pack only.
- Technical design: `hostedRelayRegistrationReadiness` and `webAiRegistrationGuides` are pure UI helpers used by Connections and covered with focused tests for ready, pending, invalid URL, browser-only, provider-guide, and secret-redaction states.
- Verification: `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. System Chrome/Playwright checked Connections at `1440px` and `390px`: the Web AI registration guide renders three provider cards, button labels stay compact, and neither viewport has page-level horizontal overflow.
- Review fallback: SubAgents were not used for this incremental UX slice; the main thread ran product fit, security/privacy, UI/UX, and maintainability passes.

### Hosted Relay Compose Deployment Slice

- Product fit: hosted Relay provisioning now has a concrete single-host deployment bundle instead of Dockerfile-only instructions. Operators can copy env templates, validate the Relay environment, start Caddy-managed HTTPS, and then run the hosted smoke against the public origin.
- Security/privacy: `relay.env` and `compose.env` are separated so Caddy receives only public host/ACME settings while Relay receives admin and handoff secrets. The config checker now reads `--env-file` plus `--compose-env-file`, rejects real deployments that still contain placeholder domains/secrets, verifies the Caddy public host matches `LCV_RELAY_BASE_URL`, catches Relay secrets accidentally placed in `compose.env`, and keeps rejecting public static bearer, direct sidecar fallback, hosted Vault variables, wildcard CORS, and long handoff TTLs. Real copied env files are ignored by git.
- Technical design: `deploy/relay/compose.yaml` runs `lcv-relay` behind Caddy with durable metadata volumes, read-only containers, tmpfs `/tmp`, and `no-new-privileges`. `product:check` validates the relay and compose env templates with `--allow-placeholders` so template drift is caught without requiring real secrets.
- Verification: `node --check scripts/check-hosted-relay-config.mjs`, `npm run hosted-relay:check -- --example`, `npm run hosted-relay:check -- --env-file deploy/relay/relay.env.example --compose-env-file deploy/relay/compose.env.example --allow-placeholders --name deploy-template`, real placeholder rejection without `--allow-placeholders`, compose-secret rejection with a temporary bad env file, `docker compose --env-file compose.env -f compose.yaml config` after temporary example copies, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed.
- Review fallback: SubAgents were not used for this incremental deployment slice; the main thread ran hosted-ops, security/privacy, product, and maintainability passes.

### Web AI Connector Registration Packet Slice

- Product fit: after a Hosted Relay is deployed and paired, operators can now generate provider-facing registration material for ChatGPT, Claude API MCP connector usage, and copy-fallback review instead of translating Relay internals by hand.
- Security/privacy: `web-ai:packet` refuses localhost, non-HTTPS, query, fragment, userinfo, and non-`/mcp` URLs. The generated packet contains public MCP/OAuth metadata and provider instructions only; it does not include Relay admin tokens, handoff secrets, Vault paths, Context Pack bodies, Raw Sources, or OAuth access tokens.
- Technical design: `scripts/web-ai-connector-packet.mjs` emits JSON or Markdown with ChatGPT connector fields, Claude `mcp_servers` skeleton, OAuth metadata URLs, scopes, and the Context Pack-only boundary. `product:check` syntax-checks the script and generates a sample packet against `https://relay.example.com/mcp`.
- Verification: official OpenAI Apps SDK and Claude MCP connector docs were rechecked before implementation. `node --check scripts/web-ai-connector-packet.mjs`, `node scripts/web-ai-connector-packet.mjs --mcp-url https://relay.example.com/mcp --format json`, invalid localhost/non-`/mcp` rejection, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed.
- Review fallback: SubAgents were not used for this incremental registration slice; the main thread ran provider-fit, security/privacy, operations, and maintainability passes.

### Context Pack Boundary Receipt UX Slice

- Product fit: Requests now shows a compact delivery-boundary receipt for the active Context Pack, separating what will be sent to the AI, what will not be sent, Pack expiry, and confirmation state before users approve or copy the payload.
- UX/design: the receipt reuses the existing dense card language from restore/audit receipts, making the core promise visible at the exact decision point instead of relying on scattered explanatory copy. Low-risk `確認不要` Packs say they are waiting for return/copy rather than user approval, so the status language matches the action model.
- Security/privacy: the receipt is generated from Pack metadata only. It summarizes counts, sensitivity, exclusions, TTL, and confirmation state without copying Fact text, Source snippet text, Raw Source body, or unapproved MemoryCandidate content into a new surface.
- Technical design: `contextPackBoundaryReceipt` is a pure UI helper covered by unit tests. It does not change Context Pack generation, confirmation, Relay handoff, manual copy payloads, or Audit persistence.
- Verification: `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. System Chrome/Playwright checked Requests at `1280px` and `390px`: the boundary receipt renders four cards and neither viewport has page-level horizontal overflow.
- Review fallback: SubAgents were not used for this incremental boundary receipt slice; the main thread ran product fit, security/privacy, UI/UX, and maintainability passes.

### Expired Context Pack UI Consistency Slice

- Product fit: Requests now treats expired short-lived Context Packs as expired everywhere in the review UI, even if the persisted request status was previously `fulfilled`. Users no longer see `AI返却可` on a Pack that the boundary receipt says is expired.
- UX/design: request rows, request metrics, detail status, delivery banner, receipt confirmation state, and Pack action buttons now share one effective expiry calculation. Expired Packs show a clear retry message instead of a contradictory ready state.
- Security/privacy: expiry is enforced as a UI-visible send boundary. Expired confirmed Packs cannot be copied, approved, drafted locally from the active Pack controls, or presented as externally retrievable from Requests.
- Technical design: `effectiveRequestStatus`, `contextPackDeliveryState`, and `isIsoExpired` centralize the display-time status calculation without mutating persisted request history. Unit tests cover fulfilled-but-expired requests and expired confirmed Packs.
- Verification: `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. In-app Browser checked Requests at desktop and mobile widths: an expired fulfilled request is labeled `期限切れ`, all Pack action buttons are disabled, the receipt confirmation state says expired, and neither viewport has page-level horizontal overflow.
- Review fallback: SubAgents were not used for this incremental expiry consistency slice; the main thread ran product fit, security/privacy, UI/UX, and maintainability passes.

### Restore AI Boundary Preview Slice

- Product fit: Settings restore preview now shows what the restored Vault means for AI access before the user replaces their current Vault. This covers deliverable short-lived Packs, expired Packs, pending/return-waiting requests, and paired connector metadata.
- UX/design: Backup/Restore is now a full-width Settings panel so the three restore receipt columns remain readable on desktop and stack on mobile. The new `AI boundary after restore` column follows the existing restore receipt card language.
- Security/privacy: the restore preview still does not echo Source body, Fact text, Context Pack item text, request task text, or Pack snippets. It summarizes only counts and operational state, keeping restore review metadata-only.
- Technical design: `restoreAiBoundarySummary` reuses the same effective expiry/delivery-state helpers as Requests, so restored expired Packs are described consistently with the active review UI.
- Verification: `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. System Chrome/Playwright checked an encrypted backup restore preview at `1280px` and `390px`: the AI boundary section shows four cards, desktop cards have readable column width, mobile stacks to one column, neither viewport has page-level horizontal overflow, and no Pack or Fact body text appears in the receipt.
- Review fallback: SubAgents were not used for this incremental restore preview slice; the main thread ran product fit, security/privacy, UI/UX, and maintainability passes.

### Vault Clear Impact Receipt Slice

- Product fit: Settings now shows a clear-impact receipt before the destructive `CLEAR` action, so users can see what local life context, AI boundary records, connector metadata, and audit/capture history will be removed.
- UX/design: the receipt reuses the existing restore receipt card style inside the danger zone. The clear button remains disabled until the user types `CLEAR`, and the cards fit desktop and mobile without adding another modal.
- Security/privacy: the receipt summarizes counts and local operational impact only. It does not echo Source body, Fact text, Context Pack item text, request text, or Pack snippets. It also reminds users that external AI/service-side settings are separate from local Vault deletion.
- Technical design: `clearVaultImpactSections` reuses Vault record counts and the same Context Pack delivery-state summary used by restore preview and Requests, keeping destructive-action copy aligned with the AI boundary model.
- Verification: `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. System Chrome/Playwright checked Settings danger zone at `1280px` and `390px`: four impact cards render, the clear button stays disabled before confirmation text, neither viewport has page-level horizontal overflow, and no stored Source, Fact, Pack, or Request body text appears in the warning receipt.
- Review fallback: SubAgents were not used for this incremental clear-impact slice; the main thread ran product fit, security/privacy, UI/UX, and maintainability passes.

### Home AI Boundary And Pack Revalidation Slice

- Product fit: Home now shows an `AI Boundary Today` receipt before setup and connection details, separating ApprovedFacts that can enter Context Packs, unapproved Inbox candidates, confirmation/return-waiting requests, and currently retrievable Packs.
- UX/design: the receipt uses the same compact operational card language as restore/clear receipts. Desktop renders four cards in one row and mobile stacks them, giving general users a daily answer to "what can AI actually use right now?" without opening Requests first.
- Security/privacy: the Home receipt is metadata-only and does not echo Source body, Candidate text, request task text, or Pack body text. Capture bulk purge now requires a second click and shows an inline impact card explaining that only Raw transcript body text is removed while Facts, candidate records, and Audit counts remain.
- Technical design: `homeAiBoundarySections` uses the same `effectiveRequestStatus` and `contextPackDeliveryState` helpers as Requests. `canSendContextPackToAi` and the Rust Vault Core `get_request_status` path now revalidate current Fact status, Fact text, validity dates, sensitivity, domain policy, and active Source eligibility before an already-confirmed Pack can be returned.
- Verification: `npm test -- --run src/aiAccessUi.test.ts src/vault.test.ts`, `cargo test --manifest-path src-tauri/Cargo.toml confirmed_context_pack_revalidates_current_fact_before_external_status_return`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. System Chrome/Playwright checked Home at `1280px` and `390px`: the boundary receipt renders four cards, has no horizontal overflow, and the receipt does not include Candidate, Request, or Pack body text.
- Review fallback: SubAgents were not used for this incremental boundary hardening slice; the main thread ran product fit, security/privacy, UI/UX, technical, and regression passes.

### Document Ingestion Readiness UX Slice

- Product fit: Sources now shows a compact document-ingestion readiness receipt before users upload files, separating always-local PDF/DOCX-style extraction from optional image OCR and legacy DOC/XLS/PPT conversion providers.
- UX/design: the receipt uses the existing compact card language and tells users whether Images and DOC/XLS/PPT are currently blocked or locally configured. This reduces the "why did my document not import?" failure path for non-technical users.
- Security/privacy: disconnected OCR/legacy Office states explicitly say those files are not Source-created until a local provider is configured. Ready states reiterate that extracted content becomes Source plus Inbox candidates only; Fact creation and AI sending remain separate confirmation steps.
- Technical design: `documentIngestionReadiness` is a pure UI helper covered by unit tests, and Sources renders the resulting cards inside the upload panel. The extraction path itself is unchanged and still rejects unsupported files before RawSource creation.
- Verification: `npm test -- --run src/aiAccessUi.test.ts src/sourceUpload.test.ts`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. System Chrome/Playwright checked Sources at `1280px` and `390px`: the readiness receipt renders three cards, modern and legacy Office support are visually separated, and neither viewport has page-level horizontal overflow.
- Review fallback: SubAgents were not used for this incremental ingestion UX slice; the main thread ran product fit, security/privacy, UI/UX, and maintainability passes.

### Product Review UX Closure Slice

- Product fit: Home onboarding step 1 now sends first-time users to the guided life-background input instead of splitting them between Sources and the setup card.
- UX/trust language: Search now labels active saved Facts as `Context Pack候補`, not generic `AI候補`, so "saved in Vault" remains separate from "sent to AI."
- Passive Capture safety: the in-page extension badge is now keyboard/click actionable and pauses Auto Capture by updating the same extension storage setting used by the popup. Extension local metadata stores host and URL hash instead of full URL/title.
- Verification: `node --check browser-extension/background.js`, `node --check browser-extension/content.js`, `node --check browser-extension/popup.js`, `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. In-app Browser checked Search at desktop and mobile widths: `Context Pack候補` is visible and there is no page-level horizontal overflow. Home first-time `入力欄へ` is covered by static rendering because the live browser had existing local state.
- SubAgent disposition: fixed P1 first-value split, P2 Passive Capture pause affordance, P2 extension metadata minimization, and P2 trust-language mismatch. A default hosted Relay service and bundled OCR/Office runtimes remain product-distribution work outside this local repository slice.

### Final Boundary And First-Value Closure Slice

- Product fit: Home now prioritizes creating/copying a Context Pack until there is a non-expired deliverable Pack, so stale Request history no longer pushes users into AI connection setup before they have seen value. Requests keeps the copy fallback composer visible whenever no Pack is selected, making "use with any AI" a permanent top-level path instead of an empty-state-only affordance.
- Security/privacy: AI-bound Pack return now revalidates each item against the current Fact and Source state immediately before delivery. Hidden/deleted/expired/secret Facts, stale item text, validity drift, missing Sources, purged Sources, and current policy changes fail closed instead of trusting an older confirmed Pack snapshot. AI-facing payloads also anonymize `excludedItems` to reason-only entries so hidden/secret/deleted Fact ids stay UI-local.
- Destructive-action UX: Source body purge and Capture body purge now require an inline second confirmation with impact text. The receipt distinguishes Raw transcript/Source body deletion from retained Fact/Candidate/Audit metadata and shows candidate, Fact, and Context Pack impact counts for Source deletion.
- Accessibility/product polish: app notifications now use `role="status"`/`aria-live="polite"` with a separate close button, active navigation exposes `aria-current="page"`, and visible product identity no longer says PoC in the browser title/package metadata.
- Verification: `npm test -- --run src/vault.test.ts src/aiAccessUi.test.ts`, `cargo test --manifest-path src-tauri/Cargo.toml native_context_pack_item_visibility_minimizes_ai_bound_pack -- --nocapture`, `cargo test --manifest-path src-tauri/Cargo.toml confirmed_context_pack -- --nocapture`, `npm run build`, `git diff --check`, and `npm run product:check -- --include-sse-soak` passed. Browser verified Home next action returns to `Context Packを試す` with expired history, Requests shows `MCPなしでContext Packを作る` despite existing Request history, Source purge confirmation renders at desktop `1280px` and mobile `390px`, and neither viewport has page-level horizontal overflow.
- SubAgent disposition: fixed the Security P0/P1 final-delivery revalidation blocker, Security P2 excluded-item id leakage, the UI/UX destructive-action confirmation blocker, Product-fit P1 first-value routing, P2 copy-fallback discoverability, and P3 PoC naming. Hosted public Relay provisioning/certification remains a deployment/product-operations milestone outside this local repository slice; this repo now labels that path as needing Hosted Relay/desktop pairing rather than pretending browser dev mode is the finished Web AI product.

### Connections General-User Labeling Slice

- Product fit: Connections now presents the ordinary path as `AI連携を開始`, `状態を更新`, `MCP URLをコピー`, `管理中の連携を停止`, `Claude設定へ追加`, `Native Hostを追加`, and `開始/一時停止` instead of operator-flavored English labels. The detailed Relay/Agent/Web AI diagnostic panel is collapsed by default so first-time users see connection choices before protocol internals.
- UX/design: the change keeps the existing card and disclosure system, but separates "what should I press?" from "how do I debug MCP/SSE/Agent state?" without adding a new screen. The collapsed diagnostic summary still shows a compact readiness badge such as `利用不可 0/4 ready`.
- Security/privacy: no data path changed. The collapsed diagnostic summary is readiness metadata only and does not include runtime errors, pairing URLs, bearer tokens, Context Pack text, Source bodies, or candidate text. The opened diagnostic still exposes only operational status and redacted error text.
- Verification: `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, `git diff --check`, and in-app Browser checks passed. Browser verified Connections at desktop `1280px` and mobile `390px`: Japanese primary labels render, old `Start AI Access`/`Copy URL` labels are absent from the visible page, the diagnostic disclosure is closed by default with a summary readiness badge, expanding reveals four status cards, and neither viewport has page-level horizontal overflow. A follow-up pass also removed remaining English action labels from Local MCP setup, login/startup controls, Passive Capture, and Browser extension setup.
- Review fallback: SubAgents were not re-run for this small follow-up slice; it directly addresses prior Product Design/Product-fit findings about English operational labels and Connections complexity.

### Settings General-User Labeling Slice

- Product fit: Settings now uses Japanese action labels for backup, restore receipts, local OCR, Legacy Office conversion, storage readiness, provider copy actions, and destructive provider reset controls. This keeps backup/OCR setup from feeling like an operator console when non-technical users need to protect or import life context.
- Security/privacy: no persistence or provider execution path changed. Backup passphrases, backup JSON, OCR image data, Office documents, Source bodies, and Context Pack payloads are not newly logged, copied, or sent.
- Verification: `npm test -- --run src/aiAccessUi.test.ts`, `npm run build`, and `git diff --check` passed. In-app Browser verified Settings at desktop `1280px` and mobile `390px`: backup/OCR/Office Japanese labels render, old `Backup JSON`/`Legacy Office conversion`/`Timeout seconds` labels are absent from the visible page, and neither viewport has page-level horizontal overflow.
- Review fallback: this is a scoped UX text cleanup following the same Product Design concern as the Connections labeling slice.

### Remote MCP CIMD Metadata Validation Slice

- Product fit: ChatGPT connector setup can now use the Apps SDK-preferred CIMD path when available, while DCR remains available. This reduces the gap between the local product promise and real Web AI connector setup without asking general users to understand OAuth registration variants.
- Security/privacy: CIMD client ids must be public HTTPS metadata document URLs whose hosts are in `LCV_RELAY_ALLOWED_CIMD_HOSTS` and are not stored as DCR rows. The Relay rejects malformed OAuth authorize requests before any CIMD fetch, rejects localhost, userinfo, fragments, query strings, dot path segments, empty document paths, non-HTTPS schemes, non-default HTTPS ports, non-public IP literals, non-allowlisted hosts, control characters, oversized values, redirects, non-JSON documents, and documents over 128 KiB. The fetched metadata must match the OAuth `client_id`, include `client_name`, list the requested `redirect_uri`, and remain a public PKCE client (`token_endpoint_auth_method: none` when present). Both CIMD and DCR still require Authorization Code + PKCE S256 plus MCP `resource` binding, and token exchange now requires matching `client_id`.
- Technical design: OAuth metadata now advertises `client_id_metadata_document_supported: true`. `oauth_authorize` validates cheap request parameters before resolving either a registered DCR client or an allowlisted fetched CIMD metadata document. The approval page displays the registration method, client id, CIMD host when applicable, and redirect host so users do not rely on metadata-controlled display names alone. CIMD DNS verification and metadata fetch are injectable for deterministic tests, and the fetch client uses OS-native certificate roots. `oauth_approve` preserves DCR revalidation while allowing metadata-validated CIMD authorization sessions, and `oauth_token` requires `client_id` form values to match the consumed authorization code.
- Verification: focused Relay unit tests cover metadata advertising, unsafe CIMD URL rejection, CIMD host allowlist rejection, CIMD metadata document acceptance/rejection, `/oauth/authorize` accepting fetched CIMD metadata without DCR registration, cheap-parameter validation before CIMD verification/fetch, and token client mismatch/missing-client rejection. `npm run product:check -- --include-sse-soak` passed after the review fixes. System Chrome headless checked Connections at desktop `1440x1000` and mobile `390x844`: the ChatGPT setup step and registration fallback copy render, the Vault boundary copy remains visible, the Connections nav state is active, and neither viewport has page-level horizontal overflow.
- Known limit: this is public-client CIMD compatibility. Connect-time IP pinning after DNS preflight, CIMD metadata caching/rate limiting, `private_key_jwt`, and confidential-client assertions remain future hardening if provider certification or custom host allowlists require them.

## SubAgent Completion Review Disposition

SubAgent reviews were used for the product-grade completion pass. Material findings were triaged as fixed, intentionally deferred, or requiring real hosted operations outside this local implementation slice.

- Fixed security findings: OAuth approval now requires a pending authorization session; static bearer MCP access is opt-in development-only; loopback admin calls reject browser origins without an admin token; Relay handoffs are client-bound; Remote Relay authenticated client ids reach Vault Core through Agent/MCP; `get_request_status` is client-bound; OCR command execution clears inherited environment and uses a private temp directory; passive-capture TTL purge is enforced in Rust Vault saves; AccessPolicy domain and approval-threshold rules are enforced in Pack generation, Pack editing, and fail-closed malformed policy handling; CIMD authorize validation now runs cheap checks before outbound work, requires allowlisted metadata hosts and `client_name`, shows client/redirect hosts on approval, and requires `client_id` at token exchange.
- Fixed product/UX findings: Connections surfaces AI Access start/status first, Requests keeps approval actions in the first review viewport, Pack copy/approval wording separates saved memory from AI-bound payloads, Control Center approval can push a confirmed short-lived handoff to Relay, Audit shows AI delivery receipts without storing Pack bodies, Sources accepts file selection or drag-and-drop without losing the native picker, the browser extension can run opt-in Auto Capture with visible in-page state plus an open-app review path, and ChatGPT setup copy now describes the user action with CIMD/DCR details kept as diagnostics/fallback.
- Deferred hosted-product findings: public HTTPS Relay provisioning, real OAuth redirect registration, uptime monitoring, and tenant secret storage remain deployment work, not local code-only work.
- Deferred protocol-hardening findings: real Streamable HTTP event replay/resumability, if provider certification requires it, and real hosted-client certification remain before a hosted connector beta.
- Deferred scale/architecture findings: normalized SQLite projections are implemented, but several write paths still treat the JSON Vault snapshot as the mutation envelope; moving all writes to normalized authoritative tables remains a larger migration.
- Deferred general-user polish: a bundled OCR runtime remains product-hardening work after the core AI access boundary.
