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
  - OAuth dynamic client registrations are persisted in a relay state store
  - recent relay request audit metadata is persisted without MCP bodies or Context Pack bodies
  - `GET /relay/state` exposes metadata-only relay status for local Control Center and smoke checks
- Added Relay state retention controls:
  - request metadata is pruned by both maximum count and default 30-day retention
  - OAuth client registrations remain durable by default but can be expired through `LCV_RELAY_CLIENT_RETENTION_DAYS` or `LCV_RELAY_CLIENT_RETENTION_SECONDS`
  - relay state persistence keeps metadata-only backup generations using `LCV_RELAY_STATE_BACKUP_COUNT`, defaulting to 3 and allowing 0 to disable backups
  - `/relay/state` exposes retention settings without exposing MCP bodies, Raw Sources, Vault content, or Context Pack bodies
- Added Relay tenant isolation controls:
  - loopback development defaults to `LCV_RELAY_TENANT_ID=local`
  - non-loopback binds require explicit `LCV_RELAY_TENANT_ID`
  - persisted relay state stores the tenant id and refuses to load if configured for a different tenant
  - legacy tenantless local relay state migrates to the configured tenant on load
  - `/health` and `/relay/state` expose tenant id as operational metadata without exposing Vault or Context Pack bodies
- Added short-lived Relay Context Pack handoff cache:
  - `POST /relay/handoff` accepts already confirmed MCP responses for approved Context Packs
  - handoff responses are memory-only, TTL-bound, and default to 10 minutes
  - the Relay accepts only fulfilled `ContextPack only` MCP responses
  - `life_context.get_request_status` can return a cached handoff response when the local Agent path is temporarily offline
  - `/relay/state` exposes only handoff metadata and retention settings, never Pack body text
  - relay state persistence and metadata backups still exclude Context Pack bodies
- Added Connections UI setup guidance for OAuth relay, pairing, local Agent, and connector URLs.
- Added app-managed AI Access Service in the Tauri Control Center:
  - `Start AI Access` launches bundled `lcv-relay` and `lcv-agent`
  - app requests a pairing code and connects Agent automatically
  - status shows Relay reachability, Agent connection, managed process state, and MCP URL
  - external relays are status-only; the app does not automatically attach the local Agent to a relay it did not start
  - `Stop managed` only stops processes started by the app
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
  - Home now shows a four-step "First 10 minutes" checklist: add life background, approve memory candidates, start AI Access, and confirm a Context Pack
  - Home now prioritizes one actionable next step above the checklist, such as reviewing pending MemoryCandidates before asking users to inspect status panels
  - Guided background setup appears before the long Background Snapshot so first-time users can start adding life context without scrolling through existing memories
  - mobile navigation switches to icon-first controls with accessible labels, hiding secondary stats so the first action and setup form appear much earlier
  - Connections now shows a natural-language readiness panel explaining whether the desktop app, Relay, Agent, and Context Pack boundary are ready
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
  - unreadable binary content, images without OCR, legacy Office binaries, unsupported files, and oversized files are rejected before RawSource or MemoryCandidate creation
  - the Upload card explains the safe fallback to Manual source text when local extraction or OCR/provider extraction is unavailable
- Added native document extraction for Desktop uploads:
  - PDF, DOCX, PPTX, XLSX, and OpenDocument files are extracted locally through a Tauri Vault boundary before Source creation
  - extracted document text flows into the existing RawSource -> MemoryCandidate path and still never creates ApprovedFacts automatically
  - native extraction rejects images without OCR Provider, legacy Office binaries, unsupported archives, unreadable files, zip-entry overages, and oversized uploads before RawSource creation
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
  - `npm run product:check:full` additionally runs the Tauri sidecar integration build and large retrieval benchmark
  - `product:check` can run smaller benchmark profiles through `-- --include-bench --bench-facts <n> --bench-chunks-per-fact <n>`
- Added GitHub Actions product qualification workflow:
  - `.github/workflows/product-check.yml` runs `npm run product:check` on pull requests and pushes to `main`/`master`
  - scheduled weekly runs and manual `workflow_dispatch` can include a bounded retrieval benchmark profile
  - workflow summaries and an uploaded `product-check.log` preserve release-check and benchmark output for review
- Added hosted Relay deployment artifacts:
  - `deploy/relay/Dockerfile` builds a relay-only container with direct Vault sidecar fallback disabled
  - `.dockerignore` excludes local Vault databases, relay state, build output, and dependency noise from container context
  - `docs/hosted-relay-deployment.md` defines required public HTTPS settings, durable metadata volume, smoke tests, token rotation, and incident runbooks
  - hosted deployment guidance keeps the relay metadata-only and requires local Agent/Vault access for real Context Pack generation
- Kept encrypted JSON backup compatibility through the existing backup flow.

## Still Remaining For Full Product Grade

- Provisioning the actual public HTTPS Relay domain, TLS termination, secret store, persistent volume, and uptime monitoring in the chosen hosting environment.
- Legacy Office conversion beyond the Settings/env local OCR command provider and local PDF/modern Office extractor.
- Provider-assisted semantic conflict detection, multi-Fact merge, and entity-level versioning beyond the current deterministic date/current-value Candidate conflict annotation and explicit supersede flow.
- Hosted CI threshold tuning after real runner history accumulates; the 100k Fact / 500k SourceChunk benchmark remains an explicit local release-candidate check because of dataset size.

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
- Upload guard tests proving text-like files are accepted, native PDF/Office files require Desktop extraction, OCR images require a provider unless configured, legacy Office binaries are blocked, and oversized files are rejected before Source creation
- Native document extraction tests proving DOCX XML text can be extracted locally, image OCR is refused without a provider, and a configured local OCR command can provide image text without creating ApprovedFacts
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
- MCP Context Pack tests proving `request_context_pack` uses the shared Vault Core path for sensitive queued Packs and low-risk returned Packs without Raw Source body leakage
- MCP shared Core tests proving `propose_memory` creates Candidates but not Facts and `get_request_status` strips internal Pack fields
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

- Review fallback: SubAgents were not used for this slice because final completion review has not started yet; the main thread ran separate product, security/privacy, technical, and UX passes.
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

- Review fallback: SubAgents were not used for this slice because final completion review has not started yet; the main thread ran separate operations, security/privacy, performance-cost, and maintainability passes.
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
- Lifecycle: app-managed Relay and Agent are stopped by **Stop managed** and on app window close; external relays are observed but not killed or auto-attached.
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

- Review fallback: SubAgents were not used for this slice because final completion review has not started yet; the main thread ran separate product, security/privacy, technical, and operations passes.
- Product fit: accepted; a hosted Remote MCP request can now be fulfilled after local approval without asking the Relay to read or persist the Vault.
- Security/privacy: accepted; handoff bodies are admin-gated, memory-only, TTL-bound, validated as fulfilled `ContextPack only` responses, and excluded from relay state persistence plus backups.
- Technical design: accepted; Agent/Vault remains canonical when online, while offline `get_request_status` can use the cached response for the matching request id.
- Operations: accepted; `/relay/state` exposes handoff count, request id, client id, creation time, expiry time, and TTL settings for debugging without exposing Pack body text.
- Verification: `cargo test --manifest-path src-tauri/Cargo.toml --bin lcv-relay` passed.

### Hosted Relay Deployment Slice

- Review fallback: SubAgents were not used for this slice because final completion review has not started yet; the main thread ran separate hosted-ops, security/privacy, product, and maintainability passes.
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

## Independent Review Passes

SubAgents were not used because the user did not request parallel agent work. Review was performed in-thread.

- Product fit: passed for the requested pivot from app-only PoC to everyday-AI access. Remaining risk is that real MCP/Relay setup may still be too developer-heavy until installer and pairing flows exist.
- Security/privacy: one material issue was found and fixed. Raw Source body excerpts were initially included in `ContextPack.sourceSnippets`; snippets now use only the approved Fact text, with a regression test.
- Technical design: passed for the current vertical slices. Remaining risk is the temporary JSON snapshot projection for write-side CRUD and Context Pack generation, which should continue moving into Rust-owned Vault Core commands.
- UX/accessibility: desktop and mobile Browser checks found no horizontal overflow on Home, Connections, Requests, Inbox, and Audit. Keyboard/focus styles remain from the PoC stylesheet and were preserved.
