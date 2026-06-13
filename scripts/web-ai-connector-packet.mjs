const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function valueFor(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function fail(message) {
  throw new Error(message);
}

function publicHttpsMcpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("--mcp-url must be a valid URL");
  }
  if (url.protocol !== "https:") fail("--mcp-url must use https://");
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    fail("--mcp-url must be a public HTTPS URL, not localhost");
  }
  if (url.username || url.password || url.search || url.hash) {
    fail("--mcp-url must not include userinfo, query, or fragment");
  }
  if (url.pathname.replace(/\/+$/, "") !== "/mcp") {
    fail("--mcp-url must point to the public /mcp endpoint");
  }
  return url.toString().replace(/\/+$/, "");
}

function baseUrlFromMcpUrl(mcpUrl) {
  const url = new URL(mcpUrl);
  url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

function outputPacket(format, packet) {
  if (format === "json") {
    console.log(JSON.stringify(packet, null, 2));
    return;
  }
  if (format !== "markdown") fail("--format must be json or markdown");
  console.log(`# ${packet.name} Web AI Connector Packet`);
  console.log("");
  console.log(`MCP URL: \`${packet.mcpServerUrl}\``);
  console.log("");
  console.log("## ChatGPT Connector");
  console.log("");
  console.log(`- Connector name: ${packet.chatgpt.connectorName}`);
  console.log(`- Description: ${packet.chatgpt.description}`);
  console.log(`- Connector URL: \`${packet.chatgpt.connectorUrl}\``);
  console.log("");
  console.log("## Claude MCP Connector");
  console.log("");
  console.log("```json");
  console.log(JSON.stringify(packet.claudeApi, null, 2));
  console.log("```");
  console.log("");
  console.log("## OAuth / Metadata");
  console.log("");
  console.log(`- Authorization server metadata: \`${packet.authorizationServerMetadata}\``);
  console.log(`- Protected resource metadata: \`${packet.protectedResourceMetadata}\``);
  console.log(`- Client ID Metadata Documents: ${packet.clientIdMetadataDocuments}`);
  console.log(`- Dynamic client registration: \`${packet.dynamicClientRegistration}\``);
  console.log("");
  console.log("## Boundary");
  console.log("");
  for (const item of packet.boundary) console.log(`- ${item}`);
}

const mcpUrl = publicHttpsMcpUrl(valueFor("--mcp-url") ?? process.env.LCV_WEB_AI_MCP_URL ?? "");
const baseUrl = baseUrlFromMcpUrl(mcpUrl);
const name = valueFor("--name") ?? "Life Context Vault";
const description =
  valueFor("--description") ??
  "Requests approved, source-backed Life Context Vault Context Packs. The server never exposes the whole Vault, Raw Sources, or unapproved memories.";
const format = valueFor("--format") ?? (hasFlag("--markdown") ? "markdown" : "json");

const packet = {
  name,
  description,
  mcpServerUrl: mcpUrl,
  authorizationServerMetadata: `${baseUrl}/.well-known/oauth-authorization-server`,
  protectedResourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource`,
  clientIdMetadataDocuments: "supported for allowlisted public PKCE clients; DCR remains available",
  dynamicClientRegistration: `${baseUrl}/oauth/register`,
  relayStateStatus: `${baseUrl}/relay/state`,
  scopes: [
    "context_pack.request",
    "memory.propose",
    "policy.read",
    "request.status"
  ],
  chatgpt: {
    connectorName: name,
    description,
    connectorUrl: mcpUrl,
    expectedOAuth: "CIMD or DCR + Authorization Code + PKCE S256 with resource-bound access tokens"
  },
  claudeApi: {
    mcp_servers: [
      {
        type: "url",
        url: mcpUrl,
        name: "life-context-vault",
        authorization_token: "PASTE_OAUTH_ACCESS_TOKEN_AFTER_PROVIDER_OR_INSPECTOR_FLOW"
      }
    ]
  },
  boundary: [
    "External AI receives confirmed short-lived Context Packs only.",
    "Raw Sources, the full Vault, unapproved MemoryCandidates, OAuth access tokens, and authorization codes are not persisted by the hosted Relay.",
    "Sensitive Context Pack requests stay pending until the local Control Center approves them."
  ]
};

outputPacket(format, packet);
