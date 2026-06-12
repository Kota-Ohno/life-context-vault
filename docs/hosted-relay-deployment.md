# Hosted Relay Deployment

Last updated: 2026-06-13

This guide describes the product-grade hosted shape for `lcv-relay`. The hosted relay does not hold a Vault. It holds OAuth client metadata, request metadata, pairing state, and short-lived in-memory Context Pack handoff bodies only.

## Build

```bash
docker build -f deploy/relay/Dockerfile -t life-context-vault-relay:local .
```

## Required Runtime Settings

Set these for any public or shared deployment:

```bash
LCV_RELAY_BIND=0.0.0.0:8765
LCV_RELAY_BASE_URL=https://relay.example.com
LCV_RELAY_ADMIN_TOKEN=<long-random-admin-token>
LCV_RELAY_TENANT_ID=<tenant-or-environment-id>
LCV_RELAY_ALLOW_DIRECT_SIDECAR=0
LCV_RELAY_ALLOWED_ORIGINS=https://chatgpt.com,https://claude.ai
LCV_RELAY_STATE_PATH=/data/relay-state.json
```

The public endpoint must terminate HTTPS before traffic reaches the container. `LCV_RELAY_BASE_URL` must be the public HTTPS origin because OAuth metadata, connector URLs, and Agent WebSocket URLs are derived from it.

Static bearer fallback is disabled by default. Do not set `LCV_RELAY_ENABLE_STATIC_TOKEN=1` in public or shared deployments; real clients should use OAuth Authorization Code + PKCE.

`LCV_RELAY_ALLOWED_ORIGINS` gates browser CORS for `/mcp` and `/relay/handoff`. Keep it to the exact AI client origins you intend to support. OAuth discovery metadata remains public, but the AI-bound data endpoints reject browser requests from other Origins before authorization or request-body payload processing.

## Recommended Runtime Settings

```bash
LCV_RELAY_REQUEST_EVENT_RETENTION_DAYS=30
LCV_RELAY_CLIENT_RETENTION_DAYS=180
LCV_RELAY_STATE_BACKUP_COUNT=5
LCV_RELAY_HANDOFF_TTL_SECONDS=600
```

Mount `/data` as a durable encrypted volume or platform-managed persistent disk. Relay state backups are metadata-only, but they still contain OAuth client registrations and operational request metadata.

## Data Boundary

The hosted relay must not be configured with `LCV_MCP_COMMAND`, `LCV_VAULT_DB_PATH`, `LCV_RELAY_ALLOW_DIRECT_SIDECAR=1`, or `LCV_RELAY_ENABLE_STATIC_TOKEN=1`.

The relay persists:

- Tenant id.
- OAuth dynamic client registrations.
- Recent request metadata.
- Metadata-only state backups.

The relay does not persist:

- Vault content.
- Raw Sources.
- MCP request bodies.
- Context Pack bodies.
- OAuth access tokens or authorization codes.

Confirmed Context Pack handoff bodies are memory-only, admin-gated, client-bound, and TTL-bound. `/relay/state` exposes only handoff metadata.

## Smoke Test

```bash
curl -fsS https://relay.example.com/health
curl -fsS https://relay.example.com/.well-known/oauth-authorization-server
curl -fsS https://relay.example.com/.well-known/oauth-protected-resource
curl -i -X OPTIONS \
  -H "Origin: https://chatgpt.com" \
  https://relay.example.com/mcp
curl -i -X OPTIONS \
  -H "Origin: https://untrusted.example" \
  https://relay.example.com/mcp
```

The trusted-Origin preflight should return `204` with `Access-Control-Allow-Origin: https://chatgpt.com`. The untrusted-Origin preflight should return `403`.

Pairing must be started from a trusted admin path:

```bash
curl -fsS \
  -H "Authorization: Bearer $LCV_RELAY_ADMIN_TOKEN" \
  -X POST \
  https://relay.example.com/pairing/start
```

The local desktop Agent then connects to the returned `agentWebSocketUrl`. Once paired, external MCP requests flow:

```text
External AI -> HTTPS /mcp -> Hosted Relay -> local Agent WebSocket -> local lcv-mcp -> encrypted local Vault
```

## Rotation Runbook

Rotate `LCV_RELAY_ADMIN_TOKEN` when an operator leaves, an admin workstation is lost, or an admin token may have been copied.

1. Set a new admin token in the hosting platform secret store.
2. Restart the relay container.
3. Confirm `/relay/state` rejects the old token.
4. Confirm `/pairing/start` accepts the new token.
5. Record the rotation in the deployment incident log.

If static bearer fallback was enabled outside local development, treat it as a deployment misconfiguration: disable `LCV_RELAY_ENABLE_STATIC_TOKEN`, remove `LCV_RELAY_TOKEN` from the public environment, restart the relay, and require OAuth clients to reconnect.

## Incident Runbook

If request metadata or OAuth client registrations may be exposed:

1. Stop the public relay.
2. Preserve `/data/relay-state.json` and backups for investigation.
3. Rotate `LCV_RELAY_ADMIN_TOKEN` and remove any accidental static bearer fallback settings.
4. Delete or expire OAuth client registrations if client trust is uncertain.
5. Restart the relay and require clients to reconnect.
6. Notify affected users that Relay metadata may have been exposed, while confirming that Vault content and Context Pack bodies are not persisted by the relay.

If a Context Pack body may have been exposed in memory, treat it as time-bounded but sensitive:

1. Stop the relay to clear in-memory handoffs and access tokens.
2. In the local Control Center, deny or regenerate affected Context Pack requests.
3. Review Audit for the request id, client, scope, sensitivity ceiling, and decision result.
