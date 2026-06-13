import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";

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

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function pkceChallenge(verifier) {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function formBody(entries) {
  return new URLSearchParams(entries).toString();
}

function locationHeader(response) {
  return headerValue(response.headers, "location");
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
    await smokeHostedOAuth();

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

async function smokeHostedOAuth() {
  const redirectUri = process.env.LCV_HOSTED_RELAY_TEST_REDIRECT_URI ?? "https://example.com/lcv-oauth-callback";
  const registration = await request(baseUrl, {
    method: "POST",
    path: "/oauth/register",
    headers: {
      "Content-Type": "application/json"
    },
    body: {
      client_name: "Hosted Relay Smoke OAuth Client",
      redirect_uris: [redirectUri]
    }
  });
  assert(registration.status === 201, `hosted dynamic OAuth registration must succeed: ${registration.body}`);
  const registeredClient = registration.json();
  assert(registeredClient.client_id?.startsWith("client_"), "hosted registration must return a client id");

  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = pkceChallenge(codeVerifier);
  const requestedScope = "context_pack.request memory.propose policy.read request.status";
  const authorizeParams = new URLSearchParams({
    response_type: "code",
    client_id: registeredClient.client_id,
    redirect_uri: redirectUri,
    scope: requestedScope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    resource: `${baseUrl.replace(/\/$/, "")}/mcp`,
    state: "hosted-relay-smoke-state"
  });
  const authorize = await request(baseUrl, {
    path: `/oauth/authorize?${authorizeParams.toString()}`
  });
  assert(authorize.status === 200, `hosted OAuth authorize must show approval page: ${authorize.body}`);
  assert(authorize.body.includes("Hosted Relay Smoke OAuth Client"), "hosted approval page must name the OAuth client");
  assert(
    authorize.body.includes("cannot approve OAuth grants from this browser page") ||
      authorize.body.includes("Control Center"),
    "public hosted approval page must require owner approval"
  );
  const approvalSessionId = authorize.body.match(/oauth_session_[A-Za-z0-9_-]+/)?.[0];
  assert(approvalSessionId, "hosted approval page must expose a pending owner approval session");

  const approve = await request(baseUrl, {
    path: `/oauth/approve?session=${encodeURIComponent(approvalSessionId)}`,
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert(approve.status === 302, `hosted owner approval must redirect with code: ${approve.body}`);
  const approvedLocation = locationHeader(approve);
  assert(approvedLocation.startsWith(`${redirectUri}?code=`), "hosted owner approval redirect must return an authorization code");
  const approvedUrl = new URL(approvedLocation);
  const authorizationCode = approvedUrl.searchParams.get("code");
  assert(authorizationCode?.startsWith("code_"), "hosted owner approval must include an authorization code");
  assert(approvedUrl.searchParams.get("state") === "hosted-relay-smoke-state", "hosted owner approval must preserve state");

  const tokenResponse = await request(baseUrl, {
    method: "POST",
    path: "/oauth/token",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formBody({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      resource: `${baseUrl.replace(/\/$/, "")}/mcp`
    })
  });
  assert(tokenResponse.status === 200, `hosted token exchange must succeed: ${tokenResponse.body}`);
  const tokenBody = tokenResponse.json();
  assert(tokenBody.access_token?.startsWith("lcv_at_"), "hosted token exchange must issue an access token");
  assert(tokenBody.scope === requestedScope, "hosted token exchange must preserve requested scopes");

  const initialize = await request(baseUrl, {
    method: "POST",
    path: "/mcp",
    headers: {
      Origin: trustedOrigin,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      Authorization: `Bearer ${tokenBody.access_token}`
    },
    body: { jsonrpc: "2.0", id: 2, method: "initialize", params: {} }
  });
  assert(initialize.status === 200, `hosted OAuth bearer must initialize MCP: ${initialize.body}`);
  const sessionId = headerValue(initialize.headers, "mcp-session-id");
  assert(sessionId.startsWith("mcp_session_"), "hosted initialize must return MCP-Session-Id");

  const tools = await request(baseUrl, {
    method: "POST",
    path: "/mcp",
    headers: {
      Origin: trustedOrigin,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      "MCP-Session-Id": sessionId,
      Authorization: `Bearer ${tokenBody.access_token}`
    },
    body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }
  });
  assert(tools.status === 200, `hosted OAuth bearer must authorize tools/list: ${tools.body}`);
  assert(tools.body.includes("life_context.request_context_pack"), "hosted tools/list must expose Life Context tools");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
