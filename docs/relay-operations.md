# Managed Relay Operations Runbook (P0-F)

Operating the **managed relay** (`lcv-relay`) as a public-facing service. The
relay is metadata-only — it never holds vault data — but as an internet endpoint
it still needs operational hygiene. This runbook covers deployment, monitoring,
abuse handling, and incident response for the operator.

## Deployment posture (already enforced by the relay)

These are coded invariants; confirm they hold on every deploy:

- **Non-loopback bind requires** `https://`, an admin token, a handoff secret,
  allowed origins, and tenant isolation (`validate_relay_surface` in
  `src-tauri/src/bin/lcv-relay.rs`). The relay refuses to start otherwise.
- **Static bearer tokens are disabled** on public binds
  (`LCV_RELAY_ENABLE_STATIC_TOKEN=1` is allowed only on loopback).
- **CIMD metadata fetch** (ChatGPT-style `https://` client ids) is SSRF-hardened:
  host allowlist (`LCV_RELAY_ALLOWED_CIMD_HOSTS`, default `chatgpt.com`), public-IP
  DNS verification, private/loopback IP rejection, `redirects(0)`, 10s timeout,
  128KB body cap, JSON content-type check.
- **Per-IP rate limiting** is on: `LCV_RELAY_RATE_LIMIT_WINDOW_SECS` (default 60)
  and `LCV_RELAY_RATE_LIMIT_MAX` (default 120). Buckets are pruned and capped;
  the limiter fails closed.
- The container is `read_only`, `no-new-privileges`, with only a `/data`
  metadata volume (`deploy/relay/compose.yaml`). Never attach vault storage.

## Provisioning (first deploy)

1. Run the guarded initializer on the host:
   `npm run hosted-relay:init -- --public-host relay.example.com --email ops@example.com --tenant-id personal`
   (generates random secrets; refuses to overwrite without `--force`).
2. Deploy `deploy/relay/Dockerfile` + `compose.yaml` behind Caddy (TLS).
3. Smoke: `npm run hosted-relay:smoke` against the public URL.
4. Confirm `/health` returns `{"status":"ok", ...}` and OAuth metadata is served
   at `/.well-known/oauth-authorization-server`.

## Monitoring

- **Health:** poll `GET /health` every 30–60s; alert on non-200 or `agent: disconnected` lasting > a few minutes.
- **Logs:** the relay logs to stderr. **Confirm no pairing codes, bearer tokens,
  or handoff secrets appear in logs** — they must not. If a secret leaks, rotate
  it (`LCV_RELAY_TOKEN`, `LCV_RELAY_HANDOFF_SECRET`) and re-pair agents.
- **Rate-limit 429 volume:** a sustained spike of 429s from one ASN/IP range
  indicates abuse or a misbehaving client. Tune `LCV_RELAY_RATE_LIMIT_*` or block
  at the edge (Caddy/firewall).
- **Metadata volume growth:** `/data` holds relay state, OAuth client metadata,
  and short-lived handoffs. It is small; alert if it grows unexpectedly
  (`MAX_RELAY_REQUEST_EVENTS`, `MAX_RELAY_STATE_BACKUP_COUNT` bound it).

## Abuse / incident response

1. **Suspected abuse (429 storm / probing):** raise
   `LCV_RELAY_RATE_LIMIT_MAX` lower or block the source ASN at the edge. The
   relay already fails closed, so a flood degrades to 429s, not a crash.
2. **Suspected secret leak in logs:** rotate `LCV_RELAY_TOKEN`,
   `LCV_RELAY_ADMIN_TOKEN`, `LCV_RELAY_HANDOFF_SECRET`; redeploy; users re-pair
   (pairing codes are short-lived, so impact is bounded).
3. **Compromised OAuth client registration:** revoke the client in relay state
   and require affected users to re-register.
4. **Relay process crash:** `restart: unless-stopped` restarts it. The vault is
   never on the relay, so users lose nothing but in-flight handoffs (TTL-bounded).

## Tuning knobs (env)

| Var | Default | Purpose |
|---|---|---|
| `LCV_RELAY_BIND` | `127.0.0.1:8765` | Listen address (non-loopback triggers the surface checks) |
| `LCV_RELAY_ALLOWED_ORIGINS` | — | Required for non-loopback (CORS) |
| `LCV_RELAY_TENANT_ID` | `local` | Required for non-loopback |
| `LCV_RELAY_RATE_LIMIT_WINDOW_SECS` | `60` | Rate-limit window |
| `LCV_RELAY_RATE_LIMIT_MAX` | `120` | Max requests per IP per window |
| `LCV_RELAY_ALLOWED_CIMD_HOSTS` | `chatgpt.com` | CIMD metadata host allowlist |

## Backups

Only relay **metadata** is persisted. Back up `/data` on a schedule; it contains
no vault data and no pack bodies. Restoring it restores client registrations and
relay state, not user content.

## What this relay is NOT responsible for

- Vault data: lives on each user's device, encrypted. The relay cannot read it.
- Pack bodies: held only as short-lived, HMAC-signed handoffs (TTL
  `DEFAULT_RELAY_HANDOFF_TTL_SECONDS` = 10 min), memory-only.
- User account data: there is no server-side user account; the relay is a
  stateless-ish routing + OAuth surface.
