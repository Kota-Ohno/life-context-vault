# HTTP MCP Relay

Last updated: 2026-06-12

Life Context Vault includes two Remote MCP bridge binaries:

- `lcv-relay`: HTTP MCP relay, OAuth authorization server, and local Agent WebSocket endpoint.
- `lcv-agent`: local desktop Agent that pairs with the relay and forwards requests to `lcv-mcp`.

The relay is a local-first stepping stone toward hosted Remote MCP. It accepts MCP JSON-RPC over HTTP, authorizes AI clients through OAuth Authorization Code + PKCE, and forwards each request through a paired local Agent WebSocket. The Agent then calls the local `lcv-mcp` stdio sidecar, so every transport shares the same encrypted Vault access boundary.

## Build

```bash
npm run sidecars:prepare
npm run relay:build
npm run agent:build
```

`npm run tauri:bundle` prepares and embeds `lcv-mcp`, `lcv-relay`, `lcv-agent`, and `lcv-capture-host` into the macOS app bundle.

For hosted container deployment, see [Hosted Relay Deployment](./hosted-relay-deployment.md).

## App-Managed Service

In the Tauri desktop app, open **Connections** and use **Start AI Access**. The app will:

- Start the bundled `lcv-relay` on `127.0.0.1:8765` if no local relay is reachable.
- Request a pairing code from `/pairing/start`.
- Start the bundled `lcv-agent` with the returned WebSocket URL.
- Show Relay and Agent status in the Control Center.

If another relay is already running on the same port, the app treats it as external: it shows status but will not automatically attach the local Agent to that process. Use the manual pairing commands for that relay, or stop it before starting the app-managed service.

**Stop managed** only stops processes started by the app and does not kill external relay processes.

Closing the app window hides Control Center into the menu bar/system tray and keeps app-managed Relay and Agent processes running. Use **Stop managed** to stop AI Access, or **Quit Life Context Vault** from the menu bar/system tray to stop managed processes and exit the app.

For day-to-day use, the same **Connections** screen can install a macOS LaunchAgent login item and toggle **起動時にAI Accessを自動開始**. The login item only starts the app binary at user login; Relay and Agent still start from the local app process, and external AI still receives Context Packs only after the normal local approval path.

## Run Locally

```bash
LCV_RELAY_TOKEN=dev-local-token \
LCV_RELAY_ENABLE_STATIC_TOKEN=1 \
LCV_RELAY_BIND=127.0.0.1:8765 \
LCV_RELAY_BASE_URL=http://127.0.0.1:8765 \
LCV_RELAY_TENANT_ID=local \
LCV_RELAY_STATE_PATH="$HOME/Library/Application Support/dev.life-context-vault.poc/relay-state.json" \
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

Development requests may include the static fallback token only when `LCV_RELAY_ENABLE_STATIC_TOKEN=1`:

```text
Authorization: Bearer dev-local-token
Content-Type: application/json
MCP-Protocol-Version: 2025-11-25
```

Remote clients should use OAuth discovery instead of the static token. Public or shared deployments should leave `LCV_RELAY_ENABLE_STATIC_TOKEN` unset.

OAuth clients should request the Relay MCP endpoint as the resource:

```text
resource=https://relay.example.com/mcp
```

For public, non-loopback Relay binds, `resource` is required on `/oauth/authorize` and `/oauth/token`. Access tokens are accepted by `/mcp` only when they are bound to the configured MCP resource. A missing or invalid MCP bearer token receives a `WWW-Authenticate` challenge with the Relay protected-resource metadata URL and the minimum required scope for the requested tool.

For public or shared deployments, set an explicit browser Origin allowlist for the AI-bound data endpoints:

```bash
LCV_RELAY_ALLOWED_ORIGINS=https://chatgpt.com,https://claude.ai
```

When `LCV_RELAY_BIND` is outside loopback, the relay refuses to start without `LCV_RELAY_ALLOWED_ORIGINS`. The allowlist applies to `/mcp` and `/relay/handoff`; OAuth discovery endpoints remain public metadata.

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
- `GET /relay/state`
- `POST /relay/handoff`
- `GET /agent/ws?...` for the local Agent WebSocket
- `POST /mcp`
- `OPTIONS /mcp`
- `GET /mcp` returns `405 Method Not Allowed` with `Allow: POST, OPTIONS`; SSE GET transport is not enabled in the current Relay.

`POST /mcp` accepts one MCP JSON-RPC message. If a local Agent is paired, the relay forwards the message over WebSocket. If no Agent is online and `LCV_RELAY_ALLOW_DIRECT_SIDECAR=0`, the relay returns a pending/offline response instead of reading the Vault directly. Local development can set `LCV_RELAY_ALLOW_DIRECT_SIDECAR=1` to preserve direct sidecar fallback.

`POST /mcp` validates `MCP-Protocol-Version` when the header is present. Missing versions are treated as the 2025-03-26 default for older local clients. Supported versions are 2025-03-26, 2025-06-18, and 2025-11-25; unsupported versions receive `400 unsupported_protocol_version` before authorization or forwarding.

`OPTIONS /mcp`, `POST /mcp`, `OPTIONS /relay/handoff`, and `POST /relay/handoff` use `LCV_RELAY_ALLOWED_ORIGINS` when a browser `Origin` header is present. A disallowed Origin receives `403 origin_not_allowed` before authorization or request-body payload processing. Browser preflight responses allow `Authorization`, `Content-Type`, `Accept`, `MCP-Protocol-Version`, `MCP-Session-Id`, and `Last-Event-ID`.

`GET /relay/state` returns operational metadata for the local Control Center and smoke tests. It requires non-browser loopback access or `LCV_RELAY_ADMIN_TOKEN`.

`POST /relay/handoff` stores a short-lived, memory-only MCP response for an already confirmed Context Pack. It requires non-browser loopback access or `LCV_RELAY_ADMIN_TOKEN`.

## Relay State Store

`lcv-relay` persists only relay control metadata:

- Relay tenant id.
- OAuth dynamic client registrations.
- Recent MCP request metadata: request id, client id, required scope, JSON-RPC method, MCP tool name, status, transport, and timestamp.

Request metadata is pruned by both count and time:

- `MAX_RELAY_REQUEST_EVENTS` keeps at most 500 recent request metadata rows.
- `LCV_RELAY_REQUEST_EVENT_RETENTION_DAYS` defaults to `30`.
- `LCV_RELAY_REQUEST_EVENT_RETENTION_SECONDS` can override days for smoke tests or tightly controlled deployments.
- OAuth client registrations remain durable by default.
- `LCV_RELAY_CLIENT_RETENTION_DAYS` or `LCV_RELAY_CLIENT_RETENTION_SECONDS` can expire old OAuth client registrations when a hosted or shared relay needs stricter rotation.
- `LCV_RELAY_STATE_BACKUP_COUNT` keeps compact metadata-only state backups next to the state file. Default is `3`; `0` disables backups.
- `LCV_RELAY_HANDOFF_TTL_SECONDS` controls memory-only Context Pack handoff lifetime. Default is `600`.

Tenant isolation is explicit:

- Loopback development defaults to `LCV_RELAY_TENANT_ID=local`.
- Binding outside loopback requires explicit `LCV_RELAY_TENANT_ID`.
- The relay state file stores the tenant id and refuses to load if it belongs to a different tenant.
- Legacy tenantless local state is migrated to the configured tenant on load.

It does not persist:

- MCP request bodies.
- Raw Vault content.
- Raw Source text.
- Context Pack bodies.
- OAuth access tokens or authorization codes.

If `LCV_RELAY_STATE_PATH` is not set, the relay stores this metadata at the platform app-data location:

- macOS: `$HOME/Library/Application Support/dev.life-context-vault.poc/relay-state.json`
- Windows: `%APPDATA%/dev.life-context-vault.poc/relay-state.json`
- Linux: `$XDG_DATA_HOME/dev.life-context-vault.poc/relay-state.json` or `$HOME/.local/share/dev.life-context-vault.poc/relay-state.json`

## Short-Lived Context Pack Handoff

Hosted Remote MCP flows sometimes need the desktop Agent to complete approval after the relay has already accepted the external AI request. For that handoff, `lcv-relay` keeps a memory-only cache of confirmed MCP responses:

- The endpoint is `POST /relay/handoff`.
- The caller must be non-browser loopback or provide `LCV_RELAY_ADMIN_TOKEN`.
- The body must include the requesting MCP client id: `{ "clientId": "...", "mcpResponse": { ... } }`.
- The MCP response is accepted only when `structuredContent.status` is `fulfilled` and `structuredContent.contextPack.trustBoundary` is exactly `ContextPack only`.
- The default TTL is 10 minutes.
- `LCV_RELAY_HANDOFF_TTL_SECONDS` can override the TTL; `LCV_RELAY_HANDOFF_TTL_DAYS` is also accepted for deployment tests.
- Handoff bodies are never written to the relay state store or backup files.
- `/relay/state` exposes only handoff count, request id, client id, creation time, expiry time, and retention settings.

When the Agent path is offline, `life_context.get_request_status` can return a still-valid handoff response from this cache. Live Agent/Vault reads remain canonical whenever a paired Agent is online.

The desktop Control Center uses the same endpoint after a user confirms a Context Pack. The app posts only a safe MCP `life_context.get_request_status`-style response, bound to the original client id and request id; it does not post the Vault snapshot, Raw Source body, or unapproved MemoryCandidate records.

## Safety Boundary

- Default bind is `127.0.0.1:8765`.
- Binding outside loopback requires an HTTPS `LCV_RELAY_BASE_URL`, `LCV_RELAY_ADMIN_TOKEN`, and `LCV_RELAY_ALLOW_DIRECT_SIDECAR=0`.
- Static bearer fallback is disabled by default and is intended only for local development when `LCV_RELAY_ENABLE_STATIC_TOKEN=1`.
- Loopback admin routes reject browser-originated requests unless an explicit admin token is supplied.
- OAuth access tokens are opaque, in-memory, and short-lived.
- OAuth client registrations are durable, but access tokens and authorization codes are not persisted.
- OAuth tool access uses minimum scopes:
  - `life_context.request_context_pack` -> `context_pack.request`
  - `life_context.propose_memory` -> `memory.propose`
  - `life_context.get_policy_summary` -> `policy.read`
  - `life_context.get_request_status` -> `request.status`
- OAuth approval requires a server-side pending authorization session. `/oauth/approve` cannot mint a code from query parameters alone.
- The relay does not implement its own Vault reads. It forwards through `lcv-agent` to `lcv-mcp`, or through direct sidecar fallback only when explicitly allowed for local development.
- The relay does not store Context Pack bodies or MCP request bodies.
- Confirmed Context Pack handoff bodies are memory-only, TTL-bound, admin-gated, client-bound, and excluded from relay state persistence and backups.
- Sensitive Context Packs remain queued for first-party app confirmation.
- Memory proposals remain unapproved `MemoryCandidate` records.

## Smoke Test

```bash
tmpdb="$(mktemp -t lcv-relay.XXXXXX.sqlite3)"
npm run mcp:build
npm run relay:build
npm run agent:build
LCV_RELAY_TOKEN=dev-local-token \
LCV_RELAY_ENABLE_STATIC_TOKEN=1 \
LCV_RELAY_BIND=127.0.0.1:8765 \
LCV_RELAY_BASE_URL=http://127.0.0.1:8765 \
LCV_RELAY_TENANT_ID=local \
LCV_RELAY_STATE_PATH="$(mktemp -t lcv-relay-state.XXXXXX.json)" \
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

- Provisioning the actual public HTTPS domain, TLS terminator, secret store, persistent volume, and uptime monitoring in the chosen hosting environment.
