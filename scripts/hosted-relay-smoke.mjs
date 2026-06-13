import http from "node:http";
import https from "node:https";

const baseUrl = process.env.LCV_HOSTED_RELAY_URL;
const adminToken = process.env.LCV_RELAY_ADMIN_TOKEN;
const trustedOrigin = process.env.LCV_HOSTED_RELAY_TRUSTED_ORIGIN ?? "https://chatgpt.com";
const untrustedOrigin = process.env.LCV_HOSTED_RELAY_UNTRUSTED_ORIGIN ?? "https://untrusted.example";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

async function request(base, { method = "GET", path = "/", headers = {}, body = "" }) {
  const url = new URL(path, base);
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const transport = url.protocol === "https:" ? https : http;
  const requestHeaders = { Connection: "close", ...headers };
  if (payload) requestHeaders["Content-Length"] = Buffer.byteLength(payload);

  return new Promise((resolveRequest, reject) => {
    const req = transport.request(
      url,
      {
        method,
        headers: requestHeaders,
        agent: false,
        timeout: 15_000
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          resolveRequest({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: responseBody,
            json: () => JSON.parse(responseBody)
          });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`request timed out: ${method} ${url}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requireHostedUrl() {
  if (!baseUrl) {
    throw new Error("LCV_HOSTED_RELAY_URL is required, for example https://relay.example.com");
  }
  const url = new URL(baseUrl);
  assert(url.protocol === "https:", "LCV_HOSTED_RELAY_URL must use https://");
  assert(url.pathname === "/" && !url.search && !url.hash, "LCV_HOSTED_RELAY_URL must be an origin without path/query/hash");
}

async function main() {
  requireHostedUrl();

  const health = await request(baseUrl, { path: "/health" });
  assert(health.status === 200, `/health must return 200, got ${health.status}`);
  const healthBody = health.json();
  assert(healthBody.status === "ok", "/health must return status ok");

  const authzMetadata = await request(baseUrl, { path: "/.well-known/oauth-authorization-server" });
  assert(authzMetadata.status === 200, "OAuth authorization metadata must be public");
  const authzBody = authzMetadata.json();
  assert(authzBody.issuer === baseUrl.replace(/\/$/, ""), "OAuth issuer must match the public relay origin");
  assert(String(authzBody.token_endpoint ?? "").startsWith(baseUrl), "OAuth token endpoint must use public relay origin");

  const resourceMetadata = await request(baseUrl, { path: "/.well-known/oauth-protected-resource" });
  assert(resourceMetadata.status === 200, "OAuth protected-resource metadata must be public");
  const resourceBody = resourceMetadata.json();
  assert(
    JSON.stringify(resourceBody).includes(`${baseUrl.replace(/\/$/, "")}/mcp`),
    "protected-resource metadata must advertise the public /mcp resource"
  );

  const trustedPreflight = await request(baseUrl, {
    method: "OPTIONS",
    path: "/mcp",
    headers: {
      Origin: trustedOrigin,
      "Access-Control-Request-Headers": "authorization,content-type,accept,mcp-protocol-version,mcp-session-id,last-event-id"
    }
  });
  assert(trustedPreflight.status === 204, `trusted-Origin preflight must return 204, got ${trustedPreflight.status}`);
  assert(
    headerValue(trustedPreflight.headers, "access-control-allow-origin") === trustedOrigin,
    "trusted-Origin preflight must echo the configured trusted origin"
  );
  assert(
    headerValue(trustedPreflight.headers, "access-control-allow-methods").includes("DELETE"),
    "trusted-Origin preflight must advertise MCP session DELETE"
  );

  const untrustedPreflight = await request(baseUrl, {
    method: "OPTIONS",
    path: "/mcp",
    headers: { Origin: untrustedOrigin }
  });
  assert(untrustedPreflight.status === 403, `untrusted-Origin preflight must return 403, got ${untrustedPreflight.status}`);

  const unauthPost = await request(baseUrl, {
    method: "POST",
    path: "/mcp",
    headers: {
      Origin: trustedOrigin,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25"
    },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
  });
  assert(unauthPost.status === 401, `unauthenticated MCP POST must return OAuth challenge, got ${unauthPost.status}`);
  assert(
    headerValue(unauthPost.headers, "www-authenticate").includes("resource_metadata="),
    "unauthenticated MCP POST must include resource metadata challenge"
  );

  if (adminToken) {
    const state = await request(baseUrl, {
      path: "/relay/state",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(state.status === 200, `/relay/state with admin token must return 200, got ${state.status}`);
    assert(!state.body.includes("life_context.request_context_pack"), "/relay/state must not expose MCP response bodies");
    assert(!state.body.includes("Context Pack"), "/relay/state must not expose Context Pack bodies");
  }

  console.log(`Hosted Relay smoke passed for ${baseUrl}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
