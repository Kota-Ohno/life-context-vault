# Correction A2 Report — Architecture Documentation: 2-Binary Local-MCP Reality

Date: 2026-06-23
Branch: chore/correct-relay-removal
Task: Correct all docs to reflect post-Simplify 1.1 state (2 binaries: Tauri app + `lcv-mcp`).

## Status

COMPLETE. All edits applied, `npm run build` clean, no remaining active links to deleted docs.

## Files Deleted (git rm)

- `docs/http-mcp-relay.md`
- `docs/hosted-relay-deployment.md`
- `docs/relay-operations.md`
- `docs/web-ai-connector-registration.md`

## Files Edited

### CLAUDE.md
- "no vault/MCP/relay" → "no vault/MCP" (line ~24)
- `mcp:build | relay:build | agent:build | capture:build` → `mcp:build` only
- `sidecars:prepare` description: "4 sidecar binaries" → "sidecar binary"
- `product:check` comment: removed "relay smoke, hosted-relay checks"
- "One Rust crate → 5 binaries" → "2 binaries"
- Removed `lcv-relay`, `lcv-agent`, `lcv-capture-host` bullet descriptions
- DB path note: removed `lcv-capture-host` and relay metadata-only note
- Removed 4 relay env var table rows (`LCV_RELAY_BIND`, `LCV_RELAY_ALLOWED_CIMD_HOSTS`, `LCV_RELAY_HANDOFF_SECRET`, `LCV_AGENT_RELAY_WS`)
- Gotcha #1: "relay/agent, capture, and hosted-relay pairing" → "MCP"
- Deleted Gotcha #5 (Agent readiness); renumbered #6→#5, #7→#6, #8→#7
- Removed "Integration smokes: relay:smoke, relay:sse-soak, hosted-relay:smoke"

### README.md
- Feature list line: removed "Hosted Relay Agent pairing, or browser capture"
- Browser preview note: removed Vault Agent and Hosted Relay mentions
- Verify section: removed `relay:build`, `agent:build`, `capture:build`
- Current Product Slice: removed relay, agent, hosted relay, capture feature bullets
- Removed entire "Run HTTP MCP Relay" and "Run Browser Capture Extension" sections
- Try steps: removed relay/capture references; cloud AI = copy fallback
- Closing note: removed "hosted connector certification"

### docs/life-context-vault-architecture.md
- Goal: removed "remote MCP relay clients"
- Lead-in: "MCP and relay adapters" → "the local MCP adapter"
- Flowchart: removed `Relay` node and its edges
- AI Access Layer section: "three routes" → "two routes"; removed relay bullets; updated behavior list
- MCP Adapter section: removed relay paragraph; added copy-fallback note for cloud AI

### docs/product-grade-implementation-status.md
- Collapsed entire relay/agent/CIMD/DCR/OAuth section into a single "Removed in Simplify 1.1" note
- Collapsed hosted relay deployment, SSE soak, and relay smoke into "Removed in Simplify 1.1" notes
- Removed `relay:build`, `agent:build`, `capture:build` from verification list
- Removed relay-specific test bullets; removed Agent test bullet
- Added `lcv-capture-host` removal note on Chrome capture entry
- Fixed bundle inspection note: only `lcv-mcp` embedded
- Fixed "Still Remaining": removed hosted relay items; added cloud-AI copy-fallback note
- Fixed `product:check` description to not mention hosted-relay checks
- Fixed maintainability review to note removal

### docs/public-release-progress.md
- P0-F ops runbook: added "(File removed in Simplify 1.1)" note
- P0-F rate limiting: noted relay removal
- P0-B full one-click: noted relay removal, `managedRelay.ts` is dead code
- P0-F module split: noted relay removal
- How to resume: removed relay pairing from priority list

### docs/browser-capture-extension.md
- Build Native Host section: added removal note for `lcv-capture-host`
- Install Native Host Manifest: added removal note

### docs/superpowers/specs/2026-06-22-north-star-and-improvement-plan.md
- "Relay is necessary and minimal" → added correction note (relay removed; universal = LOCAL MCP + copy fallback)
- Decision 6 "Relay stays": added correction column
- R2 (relay onboarding mechanism): reframed as LOCAL MCP friction post-removal
- Distribution stack: reframed to `lcv-mcp` + Claude-config installer
- P3: reframed to local MCP onboarding
- R2 open item: reframed to local MCP install flow

## Verification

- `npm run build`: clean (tsc + vite, 0 errors)
- No active links to deleted docs remain in tracked files (2 remaining references are inside strikethrough/historical notes)
- 4 relay docs removed via `git rm`

## Concerns

- `docs/product-grade-implementation-status.md` is a long historical log (~1252 lines). Many review-slice sections still mention relay/agent in their historical narrative (e.g., "App-Managed AI Access Service Slice", various relay-specific review slices). These are accurate historical records of what was implemented and later removed. They were left as-is to preserve the audit trail; only the active-instruction sections and forward-looking references were corrected.
- `docs/public-release-progress.md` retains historical relay items marked with removal notes; the "Remaining P0" section was corrected to reflect the current state.
