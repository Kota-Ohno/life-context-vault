# Life Context Vault

Local-first Control Center and AI Access Layer for a personal life-context vault. The product boundary is simple: everyday AI clients can request reviewed Context Packs, but they cannot read the whole Vault, Raw Sources, or unapproved memory candidates.

## Run As Desktop App

Life Context Vault is a desktop-first product. Use the Tauri app when you want AI Access, encrypted native persistence, or Local MCP.

```bash
npm install
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

## Run Browser Preview

Browser dev mode is for UI review and fallback storage only. It cannot manage encrypted native persistence or install local AI integrations.

```bash
npm run dev
```

Open the printed local URL only when you want that preview mode.

## Verify

```bash
npm test
npm run build
npm run sidecars:prepare
npm run mcp:build
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
- Restore preview and typed confirmation before encrypted backup restore or destructive Vault clear

The browser fallback uses `localStorage`. In the Tauri runtime, the same Vault state is persisted to an encrypted SQLCipher database in the app data directory, keyed by the OS secure credential store, and projected into normalized tables.

## Run Local MCP Sidecar

```bash
npm run mcp:build
```

Then open **Connections** in the Tauri desktop app and use **Claude設定へ追加**. The app merges the `life-context-vault` MCP server into Claude Desktop's config and backs up an existing config first. Manual copy remains available as a fallback.

The MCP sidecar exposes controlled tools only:

- `life_context.request_context_pack`
- `life_context.propose_memory`
- `life_context.get_policy_summary`
- `life_context.get_request_status`

See `docs/local-mcp-sidecar.md` for setup, safety boundaries, and a stdio smoke test.

## Try The Product-Grade Slice

1. Open **Home** and add a small piece of life background.
2. Review the generated candidate in **Inbox** and save it as an ApprovedFact.
3. Open **Requests** and prepare a Context Pack for a ChatGPT or Claude-style task. Use copy fallback first if Local MCP is not connected yet.
4. Open **Connections** when you want to make the route persistent: Claude Desktop/local MCP or copy fallback.
5. Confirm exactly what will be AI-bound, or copy the Pack for an AI that cannot use MCP yet.
6. Open **Audit** to see what was saved, requested, generated, copied, or denied.

See `docs/product-grade-implementation-status.md` for what is implemented now and what remains for bundled document providers and future semantic memory upgrades.
