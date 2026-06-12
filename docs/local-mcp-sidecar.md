# Local MCP Sidecar

Last updated: 2026-06-12

Life Context Vault includes a local MCP stdio sidecar named `lcv-mcp`.

The sidecar is designed for same-device AI clients such as Claude Desktop, Codex-like tools, Cursor-like tools, and other MCP clients. It reads and writes the user's local encrypted SQLCipher Vault file and exposes only controlled tools.

## Build

```bash
npm run mcp:build
```

The release binary is written to:

```text
src-tauri/target/release/lcv-mcp
```

## Claude Desktop Config

Use the **Connections** screen in the Tauri desktop app and click **Install Claude config**. The app:

- resolves the bundled `lcv-mcp` sidecar path,
- writes the current encrypted Vault path into the MCP environment,
- preserves existing `mcpServers`,
- backs up `claude_desktop_config.json` before writing, and
- refuses to overwrite invalid JSON.

Manual copy remains available in **Connections**. A development config looks like:

```json
{
  "mcpServers": {
    "life-context-vault": {
      "type": "stdio",
      "command": "/Users/kota/Documents/My Context/src-tauri/target/release/lcv-mcp",
      "env": {
        "LCV_VAULT_DB_PATH": "$HOME/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3"
      }
    }
  }
}
```

When running inside the Tauri app, the Settings screen shows the exact native Vault path.

The app and sidecar share the same Vault encryption key through the OS secure credential store. For automated smoke tests only, `LCV_VAULT_DB_KEY` can override that key.

## Tools

The sidecar exposes:

- `life_context.request_context_pack`
- `life_context.propose_memory`
- `life_context.get_policy_summary`
- `life_context.get_request_status`

## Safety Boundary

- The sidecar never exposes raw Vault-wide reads.
- `request_context_pack` uses the shared Rust Vault Core Context Pack Engine and returns low-risk Context Packs directly.
- Context Packs with `private_consequential` or higher sensitivity are written to the Vault as `pending_user_confirmation` and are not returned directly.
- `propose_memory` uses shared Vault Core write logic and creates a `MemoryCandidate` only. It never creates an `ApprovedFact`.
- `get_policy_summary` returns policy and connector metadata, not raw life context.
- `get_request_status` uses shared Vault Core read logic and returns a confirmed Context Pack only after the app marks it confirmed or fulfilled.
- In **Requests**, the app separates "approve for AI retrieval" from local answer generation. Approval makes the Pack available to `get_request_status`; copying a Pack uses the same AI-bound payload shape for non-MCP clients.

## App Sync

If the app is already open while an MCP client writes a request or memory proposal, the Tauri app polls the native Vault and imports external updates automatically. The top-bar **Sync** button is still available as a manual refresh.

The browser-only development app uses `localStorage`, so it cannot observe the native SQLite file used by the MCP sidecar.

## Smoke Test

```bash
tmpdb="$(mktemp -t lcv-mcp.XXXXXX.sqlite3)"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"life_context.propose_memory","arguments":{"text":"Tone preference: concise and calm","clientName":"Smoke Client"}}}' \
  | LCV_VAULT_DB_PATH="$tmpdb" \
    LCV_VAULT_DB_KEY=0123456789abcdef0123456789abcdef \
    src-tauri/target/release/lcv-mcp
rm -f "$tmpdb"
```
