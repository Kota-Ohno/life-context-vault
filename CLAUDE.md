# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

Life Context Vault — a local-first desktop app that keeps a personal life-context
vault and exposes **reviewed Context Packs** to AI clients (Claude Desktop, ChatGPT,
Codex, …) without ever giving them the raw vault, raw sources, or unapproved memory
candidates. The **trust boundary is the product**; it is the organizing principle of
the whole codebase. Respect it in every change.

## Commands

All commands run from the repo root. Node 22, Rust stable (min 1.77.2).

```bash
npm install

# Development — USE THIS, not `npm run dev`, for any real work
npm run tauri:dev          # full app: vite + cargo + Tauri window + encrypted vault + AI access

# Browser preview (UI review ONLY — see Gotchas)
npm run dev                # vite on 127.0.0.1:5173; localStorage fallback; no vault/MCP/relay

# Frontend
npm test                   # vitest run
npm run build              # tsc --noEmit + vite build

# Rust
cargo test   --manifest-path src-tauri/Cargo.toml
cargo fmt    --manifest-path src-tauri/Cargo.toml --check
npm run mcp:build | relay:build | agent:build | capture:build   # individual sidecars (release)

# Production
npm run sidecars:prepare   # stage 4 sidecar binaries into src-tauri/binaries/<triple>/
npm run tauri:build        # production binary (stages sidecars first)
npm run tauri:bundle       # macOS .app bundle

# Release gate — exactly what CI runs (use before pushing)
npm run product:check      # tests, build, cargo fmt --check, cargo test, build --bins, relay smoke, hosted-relay checks, git diff --check
npm run product:check:full # also: tauri:build sidecar integration + large retrieval benchmark

# Optional
npm run retrieval:bench    # 100k facts / 500k chunks FTS benchmark (#[ignore] test)
```

CI (`.github/workflows/product-check.yml`) runs `npm run product:check` on every PR/push
to main/master, plus a weekly cron. Commits/pushes are NOT automated — do them only on request.

## Architecture

**One Rust crate → 5 binaries.** `src-tauri/` is a single crate that builds the Tauri app
plus four sidecar binaries. **All sidecars call the same `*_at_path` core functions in
`lib.rs`**, so the security boundary is enforced in exactly one place regardless of transport.

- `life-context-vault` (app) — Tauri shell, ~35 IPC commands, tray/login-item, AI access supervisor
- `lcv-mcp` — local MCP stdio sidecar (4 tools only)
- `lcv-relay` — hand-written HTTP MCP relay + OAuth (Code+PKCE+DCR+CIMD) + WebSocket `/agent/ws`
- `lcv-agent` — local Vault Agent; WebSocket client bridging relay → `lcv-mcp`
- `lcv-capture-host` — Chrome Native Messaging host (passive capture → unapproved candidates)

Rust is **fully synchronous** (`std::thread` + `std::sync::Mutex`, no async runtime).

**Frontend:** React 19 + TypeScript + Vite (`src/`). `App.tsx` is a single ~8k-line file with
no router — all views (Home/Inbox/Sources/Connections/Requests/Search/Settings/Audit) switch via
local state. Navigate by grep, not by file.

**Dependency direction:** `App.tsx` → `nativeStorage.ts` (the only Tauri IPC shim) → `lib.rs`
commands → `*_at_path` shared fns ← (called by) the sidecars. `vault.ts` is a parallel pure-TS
path used ONLY when `window.__TAURI_INTERNALS__` is absent (browser preview / tests).

## Data lifecycle & trust boundary

```
RawSource → extractCandidates → MemoryCandidate (UNTRUSTED) → user approves → ApprovedFact (canonical)
                                                                              │
              (audit) ← buildContextPackForRequest ←─ rank+filter ────────────┘
                                  │
        user confirms → canSendContextPackToAi → makeAiContextPackPayload → AI client
```

The boundary is enforced **twice**, in code not config:

1. `MemoryCandidate` → `ApprovedFact` requires an explicit user action. `secret_never_send`
   (sensitivity tier 4) can **never** become a Fact (`approve_candidate_with_options_at_path`).
2. Every Context Pack is **re-validated against current policy at retrieval time**
   (`ensure_context_pack_allowed_by_current_policy` / `safe_context_pack_for_client`),
   not just at build. Pack TTL is 10 minutes. If any fact expired/was edited/hidden, or policy
   tightened, the pack is returned as `expired` — nothing leaks.

The AI payload (`AiContextPackPayload`) narrows `excludedItems` to `{reason}` only — the AI
never learns *what* was excluded, only *why*. Audit receipts omit pack/source/candidate bodies
by design.

Pack invalidation is automatic and cascading: any Source/Fact lifecycle change calls
`invalidate_context_packs_for_facts`, cancelling affected packs with `stale_fact` warnings.

## Storage & encryption

- **Canonical store** = a single JSON blob in the SQLCipher `vault_state` table (key `vault_state`).
- The normalized tables (`sources`, `facts`, `memory_candidates`, `facts_fts` via FTS5) are a
  **derived projection**, rebuilt lazily by `sync_normalized_tables_if_stale`. **Never mutate
  projection tables directly** — write through the core functions; the projection resyncs.
- SQLCipher: `kdf_iter = 256000`, `cipher_page_size = 4096` (`vault_crypto.rs`).
- **Key** (`vault_crypto.rs::vault_key`): `LCV_VAULT_DB_KEY` (≥32 chars) → macOS Keychain
  (service `dev.life-context-vault.poc.vault-key`, auto-generated) → `LCV_VAULT_KEY_FILE` (0600).
- **Vault path:** `~/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3`
  (override `LCV_VAULT_DB_PATH`). Desktop app, `lcv-mcp`, and `lcv-capture-host` open the same DB;
  the relay does **not** touch the vault (metadata-only by design).
- Plaintext→encrypted migration is automatic; backup removed unless `LCV_KEEP_PLAINTEXT_MIGRATION_BACKUP=1`.

## Key files

| File | Role |
|---|---|
| `src/types.ts` | Domain model — the canonical type definitions |
| `src/vault.ts` | TS core state machine + security logic; localStorage fallback path |
| `src/nativeStorage.ts` | **Only** Tauri IPC shim; `isTauriRuntime()` gate |
| `src/App.tsx` | Single-file UI (~8k lines, no router) |
| `src-tauri/src/lib.rs` | Rust Vault Core: schema, all IPC commands, all `*_at_path` shared fns |
| `src-tauri/src/vault_crypto.rs` | SQLCipher open path, key resolution, Keychain, migration |
| `src-tauri/src/bin/lcv-*.rs` | The four sidecar binaries (thin transports) |
| `scripts/prepare-tauri-sidecars.mjs` | Stages sidecars for bundling (build-order critical) |
| `scripts/run-product-release-checks.mjs` | The `product:check` gate |

## Conventions

- **IPC casing:** Rust structs use `#[serde(rename_all = "camelCase")]` → TS sees camelCase. SQL
  columns are snake_case. The persisted `vault_state` JSON is TS-shaped (camelCase).
- **IDs:** prefixed — `src_`, `cand_`, `fact_`, `pack_`, `req_`, `audit_`, `conn_` — via `new_id(prefix)`.
- **UI is Japanese-first** (`index.html` `lang="ja"`); some user-facing strings live in the Rust layer.
- **Secret redaction happens before persistence** (`sanitize_secret_material` /
  `is_secret_indicator`) on every ingest path; redacted lines become `blocked_sensitive` candidates.
- **Config is env-var driven** — ~37 `LCV_*` vars; binaries take no config files.
- **Tests are colocated:** Rust `#[cfg(test)] mod tests` at file bottom; TS `*.test.ts` next to module.

## Environment variables (selected)

| Var | Purpose |
|---|---|
| `LCV_VAULT_DB_KEY` | Vault DB key (tests/CI/non-macOS; ≥32 chars) |
| `LCV_VAULT_KEY_FILE` | Key file path (non-macOS) |
| `LCV_VAULT_DB_PATH` | Override vault DB location |
| `LCV_OCR_COMMAND` | OCR provider for images (else images rejected) |
| `LCV_LEGACY_OFFICE_COMMAND` | LibreOffice `soffice` for `.doc/.xls/.ppt` (else rejected) |
| `LCV_EXTENSION_ID` | Chrome extension id for native-host manifest |
| `LCV_RELAY_BIND` / `LCV_RELAY_ALLOWED_ORIGINS` / `LCV_RELAY_TENANT_ID` | Relay surface (non-loopback bind requires the latter two) |
| `LCV_RELAY_ALLOWED_CIMD_HOSTS` | CIMD (`https://` client-id) host allowlist; default `chatgpt.com` |
| `LCV_RELAY_HANDOFF_SECRET` | HMAC secret for relay handoff |
| `LCV_AGENT_RELAY_WS` | WebSocket URL the agent pairs with (`wss://.../agent/ws?pairing_code=...`) |

Tests inject `LCV_VAULT_DB_KEY=0123456789abcdef0123456789abcdef` via `use_test_vault_key()`.

## Gotchas

1. **`npm run dev` ≠ `npm run tauri:dev`.** The browser preview is UI-review-only: it uses
   `localStorage` and the pure-TS `vault.ts`; `nativeStorage.ts` silently returns `null` outside
   Tauri, so encrypted persistence, MCP, relay/agent, capture, and hosted-relay pairing are all
   inert. Use `npm run tauri:dev` for any feature work.
2. **Sidecar build ordering matters.** `tauri:build`/`tauri:bundle` run
   `prepare-tauri-sidecars.mjs`, which builds all 4 binaries in release and copies them to
   `src-tauri/binaries/<host-triple>/` with a triple suffix (Tauri `externalBin` requirement).
   That dir is gitignored and always regenerated — a manual `cargo build` without staging will
   bundle stale/missing sidecars.
3. **`lcv-mcp` defers approval mode to the Vault Core per-connection policy.** The core resolves
   `None` → `"always_review"` unless the connection has `standingDeliveryEnabled = true`, in which
   case it uses `"explicit_sensitive"`. Connections that have not opted in remain strictly reviewed
   (unchanged). Above-threshold items still queue `pending_user_confirmation` for Control Center
   confirmation before being returned to the AI.
4. **Projection tables are derived.** The canonical data is the `vault_state` JSON blob; the
   normalized tables + FTS5 rebuild from it. Don't write to them directly.
5. **Agent readiness is explicit.** A running `lcv-agent` process is NOT "connected" until the
   relay sends an `agent_ready` ACK and a fresh `agent-status.json` (per-spawn `statusToken` +
   `processId`) is written. Distinguish liveness from pairing readiness.
6. **Non-macOS needs an explicit key.** Set `LCV_VAULT_DB_KEY` or `LCV_VAULT_KEY_FILE`, or the
   vault won't open.
7. **Document extraction is bounded & provider-gated.** Max input 12 MiB, max ZIP entry 8 MiB,
   max extracted text 1M chars. Images require `LCV_OCR_COMMAND`; legacy Office formats require
   `LCV_LEGACY_OFFICE_COMMAND`. Provider stdout is capped (4 MiB) to avoid deadlocks.
8. **App.tsx is one ~8k-line file with no router.** Grep, don't navigate.

## Testing patterns

- Frontend logic is heavily tested via Vitest (`vault.test.ts`, `aiAccessUi.test.ts`,
  `sourceUpload.test.ts`) — the security logic in `vault.ts` has strong coverage; mirror that
  style for boundary changes.
- Rust tests live in `#[cfg(test)] mod tests` per file. The large-scale retrieval benchmark is an
  `#[ignore]` test behind `npm run retrieval:bench`.
- Integration smokes: `npm run relay:smoke`, `npm run relay:sse-soak`, `npm run hosted-relay:smoke`.

## When changing boundary-relevant code

If a change touches candidate extraction, fact approval, sensitivity tiers, access policies, pack
building, pack retrieval, the MCP tool surface, or anything that crosses the trust boundary:
extend the tests in `vault.test.ts` and the Rust `mod tests`, and run `npm run product:check`
before declaring done. The boundary being correct is the whole point of the product.
