import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? ".exe" : "";
const releaseDir = join(repoRoot, "src-tauri", "target", "release");
const relayPath = join(releaseDir, `lcv-relay${exe}`);
const mcpPath = join(releaseDir, `lcv-mcp${exe}`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function request(baseUrl, { method = "GET", path = "/", headers = {}, body = "" }) {
  const url = new URL(path, baseUrl);
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const requestHeaders = { Connection: "close", ...headers };
  if (payload) {
    requestHeaders["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolveRequest, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: requestHeaders,
        agent: false
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
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(baseUrl, relay) {
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (relay.exitCode !== null) {
      throw new Error(`relay exited before health check: ${relay.exitCode}`);
    }
    try {
      const response = await request(baseUrl, { path: "/health" });
      if (response.status === 200) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`relay did not become healthy: ${lastError?.message ?? "timeout"}`);
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

function mcpHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25",
    ...extra
  };
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

async function main() {
  assert(existsSync(relayPath), `missing ${relayPath}; run npm run relay:build first`);
  assert(existsSync(mcpPath), `missing ${mcpPath}; run npm run mcp:build first`);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = await mkdtemp(join(tmpdir(), "lcv-relay-smoke-"));
  const statePath = join(tempDir, "relay-state.json");
  const vaultPath = join(tempDir, "vault.sqlite3");
  const token = "relay-smoke-token";
  let stderr = "";
  let stdout = "";
  let stopping = false;

  const relay = spawn(relayPath, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LCV_RELAY_TOKEN: token,
      LCV_RELAY_ENABLE_STATIC_TOKEN: "1",
      LCV_RELAY_BIND: `127.0.0.1:${port}`,
      LCV_RELAY_BASE_URL: baseUrl,
      LCV_RELAY_TENANT_ID: "smoke",
      LCV_RELAY_STATE_PATH: statePath,
      LCV_RELAY_ALLOW_DIRECT_SIDECAR: "1",
      LCV_MCP_COMMAND: mcpPath,
      LCV_VAULT_DB_PATH: vaultPath,
      LCV_VAULT_DB_KEY: "0123456789abcdef0123456789abcdef"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  relay.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  relay.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  relay.on("exit", (code, signal) => {
    if (!stopping && code !== null && code !== 0) {
      console.error(`relay exited unexpectedly: code=${code} signal=${signal}`);
      console.error(stderr);
    }
  });

  try {
    const health = await waitForHealth(baseUrl, relay);
    const healthBody = health.json();
    assert(healthBody.status === "ok", "health response must be ok");
    assert(healthBody.tenantId === "smoke", "health must expose configured tenant only");

    const getMissingAccept = await request(baseUrl, { path: "/mcp" });
    assert(getMissingAccept.status === 406, "GET /mcp without SSE Accept must return 406");
    assert(getMissingAccept.body.includes("not_acceptable"), "GET missing Accept body must explain not_acceptable");

    const getUnauth = await request(baseUrl, {
      path: "/mcp",
      headers: {
        Accept: "text/event-stream",
        "MCP-Protocol-Version": "2025-11-25"
      }
    });
    assert(getUnauth.status === 401, "GET /mcp SSE without auth must return OAuth challenge");
    assert(
      headerValue(getUnauth.headers, "www-authenticate").includes("resource_metadata="),
      "unauthenticated SSE GET must include OAuth resource metadata challenge"
    );

    const methodBoundary = await request(baseUrl, { method: "PUT", path: "/mcp" });
    assert(methodBoundary.status === 405, "unsupported /mcp method must return method boundary");
    assert(
      headerValue(methodBoundary.headers, "allow") === "GET, POST, DELETE, OPTIONS",
      "unsupported /mcp method Allow header must include GET, POST, DELETE, OPTIONS"
    );

    const preflight = await request(baseUrl, {
      method: "OPTIONS",
      path: "/mcp",
      headers: {
        Origin: "https://chatgpt.com",
        "Access-Control-Request-Headers": "authorization,content-type,accept,mcp-protocol-version,mcp-session-id"
      }
    });
    assert(preflight.status === 204, "trusted loopback preflight must succeed");
    assert(
      headerValue(preflight.headers, "access-control-allow-methods").includes("DELETE"),
      "preflight must advertise DELETE session termination"
    );
    assert(
      headerValue(preflight.headers, "access-control-allow-headers").includes("MCP-Session-Id"),
      "preflight must advertise MCP-Session-Id"
    );

    const unauth = await request(baseUrl, {
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders(),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
    });
    assert(unauth.status === 401, "well-formed unauthenticated MCP POST must get OAuth challenge");
    assert(
      headerValue(unauth.headers, "www-authenticate").includes("resource_metadata="),
      "unauthenticated MCP POST must include OAuth resource metadata challenge"
    );

    const missingAccept = await request(baseUrl, {
      method: "POST",
      path: "/mcp",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "MCP-Protocol-Version": "2025-11-25"
      },
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    });
    assert(missingAccept.status === 406, "missing MCP Accept header must return 406");
    assert(missingAccept.body.includes("not_acceptable"), "missing Accept body must explain not_acceptable");

    const badContentType = await request(baseUrl, {
      method: "POST",
      path: "/mcp",
      headers: {
        "Content-Type": "text/plain",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`
      },
      body: "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/list\"}"
    });
    assert(badContentType.status === 415, "non-JSON MCP body must return 415");
    assert(badContentType.body.includes("unsupported_media_type"), "bad content type body must explain unsupported_media_type");

    const initialize = await request(baseUrl, {
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ Authorization: `Bearer ${token}` }),
      body: { jsonrpc: "2.0", id: 4, method: "initialize", params: {} }
    });
    assert(initialize.status === 200, `initialize must succeed: ${initialize.body}`);
    const sessionId = headerValue(initialize.headers, "mcp-session-id");
    assert(sessionId.startsWith("mcp_session_"), "initialize must return MCP-Session-Id");

    const sseWithSession = await request(baseUrl, {
      path: "/mcp",
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${token}`,
        "MCP-Protocol-Version": "2025-11-25",
        "MCP-Session-Id": sessionId,
        "Last-Event-ID": "mcp_sse_previous"
      }
    });
    assert(sseWithSession.status === 200, `GET /mcp SSE with session must succeed: ${sseWithSession.body}`);
    assert(
      headerValue(sseWithSession.headers, "content-type").includes("text/event-stream"),
      "SSE GET must return text/event-stream"
    );
    assert(sseWithSession.body.includes("event: ready"), "SSE GET must emit a ready event");
    assert(/(^|\n)id: mcp_sse_/m.test(sseWithSession.body), "SSE GET must emit a stable event id");
    assert(sseWithSession.body.includes("\"resumeSupported\":false"), "SSE GET must explicitly mark replay unsupported");
    assert(
      sseWithSession.body.includes("\"replayPolicy\":\"metadata_only_no_event_replay\""),
      "SSE GET must expose the replay policy"
    );
    assert(sseWithSession.body.includes("\"lastEventIdReceived\":true"), "SSE GET must acknowledge Last-Event-ID presence");
    assert(sseWithSession.body.includes("\"lastEventIdStored\":false"), "SSE GET must state Last-Event-ID values are not stored");

    const missingSession = await request(baseUrl, {
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ Authorization: `Bearer ${token}` }),
      body: { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }
    });
    assert(missingSession.status === 400, "active session client must include MCP-Session-Id");
    assert(missingSession.body.includes("missing_mcp_session"), "missing session body must explain missing_mcp_session");

    const toolsWithSession = await request(baseUrl, {
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        Authorization: `Bearer ${token}`,
        "MCP-Session-Id": sessionId
      }),
      body: { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }
    });
    assert(toolsWithSession.status === 200, `tools/list with session must succeed: ${toolsWithSession.body}`);
    assert(toolsWithSession.body.includes("life_context.request_context_pack"), "tools/list must expose Life Context tools");

    const terminate = await request(baseUrl, {
      method: "DELETE",
      path: "/mcp",
      headers: {
        Authorization: `Bearer ${token}`,
        "MCP-Protocol-Version": "2025-11-25",
        "MCP-Session-Id": sessionId
      }
    });
    assert(terminate.status === 204, "DELETE /mcp must terminate session");

    const toolsAfterDelete = await request(baseUrl, {
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ Authorization: `Bearer ${token}` }),
      body: { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }
    });
    assert(toolsAfterDelete.status === 200, "client without active session can use POST without MCP-Session-Id");

    const redirectUri = "http://127.0.0.1/oauth/callback";
    const registration = await request(baseUrl, {
      method: "POST",
      path: "/oauth/register",
      headers: {
        "Content-Type": "application/json"
      },
      body: {
        client_name: "Relay Smoke OAuth Client",
        redirect_uris: [redirectUri]
      }
    });
    assert(registration.status === 201, `dynamic OAuth registration must succeed: ${registration.body}`);
    const registeredClient = registration.json();
    assert(
      registeredClient.client_id?.startsWith("client_"),
      "dynamic OAuth registration must return a client id"
    );
    assert(
      registeredClient.scope.includes("context_pack.request") && registeredClient.scope.includes("request.status"),
      "dynamic OAuth registration must advertise Life Context scopes"
    );

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
      resource: `${baseUrl}/mcp`,
      state: "relay-smoke-state"
    });
    const authorize = await request(baseUrl, {
      path: `/oauth/authorize?${authorizeParams.toString()}`
    });
    assert(authorize.status === 200, `OAuth authorize must show approval page: ${authorize.body}`);
    assert(authorize.body.includes("Authorize Relay Smoke OAuth Client"), "approval page must name the OAuth client");
    assert(authorize.body.includes("Raw Vault reads are not exposed"), "approval page must explain the Context Pack boundary");
    const approvePath = authorize.body.match(/href="([^"]*\/oauth\/approve\?[^"]+)"/)?.[1];
    assert(approvePath, "approval page must include an approve URL");

    const approve = await request(baseUrl, { path: approvePath.replace(/&amp;/g, "&") });
    assert(approve.status === 302, `OAuth approval must redirect with code: ${approve.body}`);
    const approvedLocation = locationHeader(approve);
    assert(approvedLocation.startsWith(`${redirectUri}?code=`), "OAuth approval redirect must return an authorization code");
    const approvedUrl = new URL(approvedLocation);
    const authorizationCode = approvedUrl.searchParams.get("code");
    assert(authorizationCode?.startsWith("code_"), "OAuth approval redirect must include a generated code");
    assert(approvedUrl.searchParams.get("state") === "relay-smoke-state", "OAuth approval must preserve state");

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
        resource: `${baseUrl}/mcp`
      })
    });
    assert(tokenResponse.status === 200, `OAuth token exchange must succeed: ${tokenResponse.body}`);
    const tokenBody = tokenResponse.json();
    assert(tokenBody.token_type === "Bearer", "OAuth token response must issue a Bearer token");
    assert(tokenBody.access_token?.startsWith("lcv_at_"), "OAuth token response must issue an access token");
    assert(tokenBody.scope === requestedScope, "OAuth token response must preserve requested scopes");

    const oauthTools = await request(baseUrl, {
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ Authorization: `Bearer ${tokenBody.access_token}` }),
      body: { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }
    });
    assert(oauthTools.status === 200, `OAuth bearer must authorize MCP tools/list: ${oauthTools.body}`);
    assert(oauthTools.body.includes("life_context.request_context_pack"), "OAuth bearer tools/list must expose Life Context tools");

    const state = await request(baseUrl, { path: "/relay/state" });
    assert(state.status === 200, "loopback relay state must be readable for diagnostics");
    const stateBody = state.json();
    assert(stateBody.tenantId === "smoke", "relay state must expose configured tenant");
    assert(stateBody.registeredClientCount >= 1, "relay state must expose dynamic OAuth client metadata count");
    assert(typeof stateBody.mcpSessionCount === "number", "relay state must expose session count metadata");
    assert(stateBody.sseResumeSupported === false, "relay state must expose SSE resume support status");
    assert(
      stateBody.sseReplayPolicy === "metadata_only_no_event_replay",
      "relay state must expose the metadata-only SSE replay policy"
    );
    assert(stateBody.sseLastEventIdStored === false, "relay state must not claim to store Last-Event-ID values");
    assert(stateBody.sseEventCount >= 1, "relay state must expose metadata-only SSE event count");
    assert(
      stateBody.recentSseEvents?.[0]?.id?.startsWith("mcp_sse_"),
      "relay state must expose metadata-only SSE event ids"
    );
    assert(
      stateBody.recentSseEvents?.[0]?.resumeRequested === true,
      "relay state must expose Last-Event-ID presence without storing the value"
    );
    assert(!state.body.includes("life_context.request_context_pack"), "relay state must not store MCP response bodies");
    assert(!state.body.includes("protocolVersion"), "relay state must not store initialize response bodies");
    assert(!state.body.includes("mcp_sse_previous"), "relay state must not store Last-Event-ID values");

    const persistedState = await readFile(statePath, "utf8");
    assert(persistedState.includes("\"tenant_id\": \"smoke\""), "persisted state must include tenant metadata");
    assert(persistedState.includes(registeredClient.client_id), "persisted state must include dynamic OAuth client metadata");
    assert(!persistedState.includes("life_context.request_context_pack"), "persisted state must not contain MCP tools response");
    assert(!persistedState.includes("mcp_session_"), "persisted state must not contain MCP session ids");
    assert(!persistedState.includes(tokenBody.access_token), "persisted state must not contain OAuth access tokens");
    assert(!persistedState.includes(authorizationCode), "persisted state must not contain OAuth authorization codes");
    assert(!persistedState.includes(codeVerifier), "persisted state must not contain PKCE verifiers");

    console.log(`Relay smoke passed at ${baseUrl}`);
  } catch (error) {
    console.error("Relay smoke failed.");
    if (stdout.trim()) console.error(`relay stdout:\n${stdout}`);
    if (stderr.trim()) console.error(`relay stderr:\n${stderr}`);
    throw error;
  } finally {
    stopping = true;
    relay.kill("SIGTERM");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    if (relay.exitCode === null) relay.kill("SIGKILL");
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
