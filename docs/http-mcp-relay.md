# HTTP MCP Relay

Last updated: 2026-06-12

Life Context Vault includes two Remote MCP bridge binaries:

- `lcv-relay`: HTTP MCP relay, OAuth authorization server, and local Agent WebSocket endpoint.
- `lcv-agent`: local desktop Agent that pairs with the relay and forwards requests to `lcv-mcp`.

The relay is a local-first stepping stone toward hosted Remote MCP. It accepts MCP JSON-RPC over HTTP, authorizes AI clients through OAuth Authorization Code + PKCE, and forwards each request through a paired local Agent WebSocket. The Agent then calls the local `lcv-mcp` stdio sidecar, so every transport shares the same encrypted Vault access boundary.

## Build

```bash
npm run relay:build
npm run agent:build
```

## Run Locally

```bash
LCV_RELAY_TOKEN=dev-local-token \
LCV_RELAY_BIND=127.0.0.1:8765 \
LCV_RELAY_BASE_URL=http://127.0.0.1:8765 \
LCV_RELAY_ALLOW_DIRECT_SIDECAR=1 \
LCV_MCP_COMMAND="/Users/kota/Documents/My Context/src-tauri/target/release/lcv-mcp" \
LCV_VAULT_DB_PATH="$HOME/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3" \
src-tauri/target/release/lcv-relay
```

The relay listens at:

```text
http://127.0.0.1:8765/mcp
```

Start a pairing session:

```bash
curl -s -X POST http://127.0.0.1:8765/pairing/start
```

Then start the local Agent with the returned `pairingCode`:

```bash
LCV_AGENT_RELAY_WS="ws://127.0.0.1:8765/agent/ws?pairing_code=<pairingCode>" \
LCV_MCP_COMMAND="/Users/kota/Documents/My Context/src-tauri/target/release/lcv-mcp" \
LCV_VAULT_DB_PATH="$HOME/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3" \
src-tauri/target/release/lcv-agent
```

Development requests may still include the static fallback token:

```text
Authorization: Bearer dev-local-token
Content-Type: application/json
```

Remote clients should use OAuth discovery instead of the static token.

## Endpoints

- `GET /health`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `GET /oauth/authorize`
- `GET /oauth/approve`
- `POST /oauth/token`
- `POST /pairing/start`
- `GET /pairing/status`
- `GET /agent/status`
- `GET /agent/ws?...` for the local Agent WebSocket
- `POST /mcp`
- `OPTIONS /mcp`

`POST /mcp` accepts one MCP JSON-RPC message. If a local Agent is paired, the relay forwards the message over WebSocket. If no Agent is online and `LCV_RELAY_ALLOW_DIRECT_SIDECAR=0`, the relay returns a pending/offline response instead of reading the Vault directly. Local development can set `LCV_RELAY_ALLOW_DIRECT_SIDECAR=1` to preserve direct sidecar fallback.

## Safety Boundary

- Default bind is `127.0.0.1:8765`.
- Binding outside loopback requires explicit `LCV_RELAY_TOKEN`.
- OAuth access tokens are opaque, in-memory, and short-lived.
- OAuth tool access uses minimum scopes:
  - `life_context.request_context_pack` -> `context_pack.request`
  - `life_context.propose_memory` -> `memory.propose`
  - `life_context.get_policy_summary` -> `policy.read`
  - `life_context.get_request_status` -> `request.status`
- The relay does not implement its own Vault reads. It forwards through `lcv-agent` to `lcv-mcp`, or through direct sidecar fallback only when explicitly allowed for local development.
- The relay does not store Context Packs.
- Sensitive Context Packs remain queued for first-party app confirmation.
- Memory proposals remain unapproved `MemoryCandidate` records.

## Smoke Test

```bash
tmpdb="$(mktemp -t lcv-relay.XXXXXX.sqlite3)"
npm run mcp:build
npm run relay:build
npm run agent:build
LCV_RELAY_TOKEN=dev-local-token \
LCV_RELAY_BIND=127.0.0.1:8765 \
LCV_RELAY_BASE_URL=http://127.0.0.1:8765 \
LCV_RELAY_ALLOW_DIRECT_SIDECAR=1 \
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

Agent path:

For an Agent-only smoke, restart the relay with `LCV_RELAY_ALLOW_DIRECT_SIDECAR=0`, then run:

```bash
pairing="$(curl -s -X POST http://127.0.0.1:8765/pairing/start)"
code="$(printf '%s' "$pairing" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pairingCode"])')"
LCV_AGENT_RELAY_WS="ws://127.0.0.1:8765/agent/ws?pairing_code=$code" \
LCV_MCP_COMMAND="$PWD/src-tauri/target/release/lcv-mcp" \
LCV_VAULT_DB_PATH="$tmpdb" \
LCV_VAULT_DB_KEY=0123456789abcdef0123456789abcdef \
src-tauri/target/release/lcv-agent
```

## Remaining Remote Work

This relay is not yet the public hosted relay.

Remaining production work:

- HTTPS deployment.
- Durable hosted relay deployment and domain.
- Persistent OAuth client registration store.
- Installer-managed Agent launch and reconnect.
- Hosted relay storage limited to request metadata and short-lived Context Pack handoff state.
