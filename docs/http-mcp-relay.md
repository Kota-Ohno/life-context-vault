# HTTP MCP Relay

Last updated: 2026-06-12

Life Context Vault includes an HTTP relay binary named `lcv-relay`.

The relay is a local-first stepping stone toward hosted Remote MCP. It accepts MCP JSON-RPC over HTTP and forwards each request to the local `lcv-mcp` stdio sidecar, so both transports share the same encrypted Vault access boundary.

## Build

```bash
npm run relay:build
```

## Run Locally

```bash
LCV_RELAY_TOKEN=dev-local-token \
LCV_RELAY_BIND=127.0.0.1:8765 \
LCV_MCP_COMMAND="/Users/kota/Documents/My Context/src-tauri/target/release/lcv-mcp" \
LCV_VAULT_DB_PATH="$HOME/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3" \
src-tauri/target/release/lcv-relay
```

The relay listens at:

```text
http://127.0.0.1:8765/mcp
```

Requests must include:

```text
Authorization: Bearer dev-local-token
Content-Type: application/json
```

## Endpoints

- `GET /health`
- `GET /.well-known/oauth-protected-resource`
- `POST /mcp`
- `OPTIONS /mcp`

`POST /mcp` accepts one MCP JSON-RPC message and returns the sidecar response.

## Safety Boundary

- Default bind is `127.0.0.1:8765`.
- Binding outside loopback requires explicit `LCV_RELAY_TOKEN`.
- The relay does not implement its own Vault reads. It forwards to `lcv-mcp`.
- The relay does not store Context Packs.
- Sensitive Context Packs remain queued for first-party app confirmation.
- Memory proposals remain unapproved `MemoryCandidate` records.

## Smoke Test

```bash
tmpdb="$(mktemp -t lcv-relay.XXXXXX.sqlite3)"
npm run mcp:build
npm run relay:build
LCV_RELAY_TOKEN=dev-local-token \
LCV_RELAY_BIND=127.0.0.1:8765 \
LCV_MCP_COMMAND="$PWD/src-tauri/target/release/lcv-mcp" \
LCV_VAULT_DB_PATH="$tmpdb" \
LCV_VAULT_DB_KEY=0123456789abcdef0123456789abcdef \
src-tauri/target/release/lcv-relay
```

In another terminal:

```bash
curl -s \
  -H 'Authorization: Bearer dev-local-token' \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:8765/mcp
```

## Remaining Remote Work

This relay is not yet the public hosted relay.

Remaining production work:

- HTTPS deployment.
- OAuth 2.1 authorization server flow.
- Device pairing between hosted relay and local Agent.
- Long-lived local Agent websocket.
- Hosted relay storage limited to request metadata and short-lived Context Pack handoff state.
