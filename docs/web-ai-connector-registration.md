# Web AI Connector Registration

Last updated: 2026-06-13

This runbook turns a deployed Hosted Relay into provider-facing registration material for ChatGPT, Claude, and copy-fallback use. The public data boundary remains `ContextPack only`.

## Prerequisites

- Hosted Relay is reachable at a public HTTPS origin.
- `npm run hosted-relay:check -- --env-file deploy/relay/relay.env --compose-env-file deploy/relay/compose.env --name production` passes.
- `npm run hosted-relay:smoke` passes against the deployed origin.
- Control Center has paired the local Agent with the hosted Relay.

## Generate The Packet

```bash
npm run web-ai:packet -- \
  --mcp-url https://relay.example.com/mcp \
  --format markdown
```

For automation:

```bash
npm run web-ai:packet -- \
  --mcp-url https://relay.example.com/mcp \
  --format json
```

The script refuses localhost, non-HTTPS URLs, userinfo, query strings, fragments, and URLs that do not point to `/mcp`.

## ChatGPT

Use the generated `chatgpt` section for the DCR connector path:

- Connector name: `Life Context Vault`
- Description: explain that the connector returns approved, source-backed Context Packs.
- Connector URL: the public `https://.../mcp` endpoint.

The Relay currently supports Dynamic Client Registration (DCR): it publishes `registration_endpoint`, creates a client for the connector instance, and requires Authorization Code + PKCE S256 with `resource` binding. OpenAI's Apps SDK auth docs also describe Client ID Metadata Documents (CIMD) as the preferred client registration method when supported. CIMD support is not implemented in this Relay yet; use the DCR connector mode until `client_id_metadata_document_supported` and CIMD validation are added.

## Claude

For Claude API MCP connector flows, use the generated `claudeApi.mcp_servers` skeleton after completing the OAuth flow and obtaining an access token:

```json
{
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://relay.example.com/mcp",
      "name": "life-context-vault",
      "authorization_token": "PASTE_OAUTH_ACCESS_TOKEN_AFTER_PROVIDER_OR_INSPECTOR_FLOW"
    }
  ]
}
```

Do not paste Relay admin tokens or handoff secrets into provider configuration. Provider-facing requests should use OAuth access tokens only.

## Boundary Check

Before registration, confirm:

- Connector URL is public HTTPS and ends in `/mcp`.
- Authorization server metadata URL returns Relay OAuth metadata.
- Protected resource metadata URL returns the MCP resource metadata.
- The hosted smoke confirms metadata-only `/relay/state`.
- Control Center shows Hosted Relay pairing as confirmed before any Web AI connector info is copied.

## References

- OpenAI Apps SDK: Connect from ChatGPT: https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- OpenAI Apps SDK: Authentication: https://developers.openai.com/apps-sdk/build/auth
- Claude MCP connector: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
- MCP specification 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25
