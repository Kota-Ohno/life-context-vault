import { spawn } from "node:child_process";
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
const iterations = Number.parseInt(process.env.LCV_SSE_SOAK_ITERATIONS ?? "50", 10);

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  if (payload) requestHeaders["Content-Length"] = Buffer.byteLength(payload);

  return new Promise((resolveRequest, reject) => {
    const req = http.request(
      url,
      { method, headers: requestHeaders, agent: false, timeout: 15_000 },
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

async function waitForHealth(baseUrl, relay) {
  let lastError = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (relay.exitCode !== null) throw new Error(`relay exited before health check: ${relay.exitCode}`);
    try {
      const response = await request(baseUrl, { path: "/health" });
      if (response.status === 200) return;
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

async function main() {
  assert(Number.isFinite(iterations) && iterations > 0, "LCV_SSE_SOAK_ITERATIONS must be a positive integer");
  assert(existsSync(relayPath), `missing ${relayPath}; run npm run relay:build first`);
  assert(existsSync(mcpPath), `missing ${mcpPath}; run npm run mcp:build first`);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tempDir = await mkdtemp(join(tmpdir(), "lcv-relay-sse-soak-"));
  const statePath = join(tempDir, "relay-state.json");
  const vaultPath = join(tempDir, "vault.sqlite3");
  const token = "relay-sse-soak-token";
  let stderr = "";

  const relay = spawn(relayPath, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LCV_RELAY_TOKEN: token,
      LCV_RELAY_ENABLE_STATIC_TOKEN: "1",
      LCV_RELAY_BIND: `127.0.0.1:${port}`,
      LCV_RELAY_BASE_URL: baseUrl,
      LCV_RELAY_TENANT_ID: "sse-soak",
      LCV_RELAY_STATE_PATH: statePath,
      LCV_RELAY_ALLOW_DIRECT_SIDECAR: "1",
      LCV_MCP_COMMAND: mcpPath,
      LCV_VAULT_DB_PATH: vaultPath,
      LCV_VAULT_DB_KEY: "0123456789abcdef0123456789abcdef"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  relay.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(baseUrl, relay);
    const initialize = await request(baseUrl, {
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ Authorization: `Bearer ${token}` }),
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
    });
    assert(initialize.status === 200, `initialize must succeed: ${initialize.body}`);
    const sessionId = headerValue(initialize.headers, "mcp-session-id");
    assert(sessionId.startsWith("mcp_session_"), "initialize must return MCP-Session-Id");

    for (let index = 0; index < iterations; index += 1) {
      const previousId = `client_previous_${index}`;
      const sse = await request(baseUrl, {
        path: "/mcp",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
          "MCP-Protocol-Version": "2025-11-25",
          "MCP-Session-Id": sessionId,
          "Last-Event-ID": previousId
        }
      });
      assert(sse.status === 200, `SSE GET ${index} must succeed: ${sse.body}`);
      assert(sse.body.includes("event: ready"), `SSE GET ${index} must emit ready`);
      assert(sse.body.includes("\"resumeSupported\":false"), `SSE GET ${index} must mark replay unsupported`);
      assert(sse.body.includes("\"lastEventIdStored\":false"), `SSE GET ${index} must avoid cursor storage`);
      assert(!sse.body.includes(previousId), `SSE GET ${index} must not echo Last-Event-ID values`);
    }

    const state = await request(baseUrl, { path: "/relay/state" });
    assert(state.status === 200, "relay state must be readable for loopback diagnostics");
    const stateBody = state.json();
    assert(stateBody.sseResumeSupported === false, "relay state must keep SSE resume unsupported");
    assert(stateBody.sseReplayPolicy === "metadata_only_no_event_replay", "relay state must keep replay policy");
    assert(stateBody.sseLastEventIdStored === false, "relay state must not store Last-Event-ID values");
    assert(stateBody.sseEventCount <= 200, "relay state must cap recent SSE diagnostics");
    assert(!state.body.includes("client_previous_"), "relay state must not expose Last-Event-ID values");

    const persistedState = await readFile(statePath, "utf8");
    assert(!persistedState.includes("client_previous_"), "persisted state must not store Last-Event-ID values");
    assert(!persistedState.includes("mcp_session_"), "persisted state must not store MCP session ids");

    console.log(`Relay SSE soak passed: ${iterations} receive-channel checks at ${baseUrl}`);
  } catch (error) {
    console.error("Relay SSE soak failed.");
    if (stderr.trim()) console.error(`relay stderr:\n${stderr}`);
    throw error;
  } finally {
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
