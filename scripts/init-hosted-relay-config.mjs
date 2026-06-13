import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function valuesFor(flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function valueFor(flag) {
  const values = valuesFor(flag);
  return values.length ? values[values.length - 1] : undefined;
}

function fail(message) {
  console.error(`Hosted Relay init failed: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  npm run hosted-relay:init -- --public-host relay.your-domain.com --email ops@your-domain.com --tenant-id personal

Options:
  --public-host <host-or-https-origin>   Public Relay host. https:// origins are normalized to the host.
  --email <email>                        ACME certificate contact email for Caddy.
  --tenant-id <id>                       3-64 chars: letters, numbers, dots, underscores, hyphens.
  --out-dir <path>                       Output directory. Default: deploy/relay
  --allowed-origins <csv>                Browser AI origins. Default: ChatGPT and Claude.
  --allowed-origin <origin>              Repeatable alternative to --allowed-origins.
  --allowed-cimd-hosts <csv>             OAuth CIMD metadata hosts. Default: chatgpt.com.
  --allowed-cimd-host <host>             Repeatable alternative to --allowed-cimd-hosts.
  --force                               Overwrite existing relay.env and compose.env.
  --dry-run                             Validate and print next steps without writing repo files.
`);
}

function normalizePublicHost(raw) {
  if (!raw) fail("--public-host is required");
  let host = raw.trim();
  if (host.includes("://")) {
    let url;
    try {
      url = new URL(host);
    } catch {
      fail("--public-host must be a hostname or https:// origin");
    }
    if (url.protocol !== "https:") fail("--public-host URL must use https://");
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      fail("--public-host URL must be an origin without path, query, hash, or userinfo");
    }
    host = url.hostname;
  }
  if (host.includes("/") || host.includes(":")) fail("--public-host must not include path or port");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    fail("--public-host must be a public DNS hostname, not localhost");
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || !host.includes(".")) {
    fail("--public-host must be a public DNS hostname");
  }
  return host.toLowerCase();
}

function validateEmail(email) {
  if (!email) fail("--email is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("--email must be a valid certificate contact email");
  }
  return email.trim();
}

function validateTenantId(tenantId) {
  if (!tenantId) fail("--tenant-id is required");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(tenantId)) {
    fail("--tenant-id must be 3-64 chars of letters, numbers, dots, underscores, or hyphens");
  }
  return tenantId;
}

function normalizeOrigins() {
  const repeated = valuesFor("--allowed-origin");
  const csv = valueFor("--allowed-origins");
  const rawOrigins = repeated.length
    ? repeated
    : String(csv ?? "https://chatgpt.com,https://claude.ai").split(",");
  const origins = [];
  for (const raw of rawOrigins) {
    const value = raw.trim();
    if (!value) continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      fail(`allowed origin must be a valid https:// origin: ${value}`);
    }
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      fail(`allowed origin must be an https:// origin without path, query, or hash: ${value}`);
    }
    origins.push(url.origin);
  }
  if (!origins.length) fail("at least one allowed AI origin is required");
  if (origins.includes("*")) fail("wildcard allowed origins are not supported");
  return [...new Set(origins)];
}

function normalizeCimdHosts() {
  const repeated = valuesFor("--allowed-cimd-host");
  const csv = valueFor("--allowed-cimd-hosts");
  const rawHosts = repeated.length
    ? repeated
    : String(csv ?? "chatgpt.com").split(",");
  const hosts = [];
  for (const raw of rawHosts) {
    const host = raw.trim().replace(/\.$/, "").toLowerCase();
    if (!host) continue;
    if (host.includes("://") || host.includes("/") || host.includes(":") || host.includes("@")) {
      fail(`allowed CIMD host must be a hostname without scheme, path, port, or userinfo: ${raw}`);
    }
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
      fail(`allowed CIMD host must be a public DNS hostname: ${raw}`);
    }
    if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) {
      fail(`allowed CIMD host must be a public DNS hostname: ${raw}`);
    }
    hosts.push(host);
  }
  if (!hosts.length) fail("at least one allowed CIMD metadata host is required");
  if (hosts.includes("*")) fail("wildcard CIMD metadata hosts are not supported");
  return [...new Set(hosts)];
}

function secret(prefix) {
  return `${prefix}_${randomBytes(48).toString("base64url")}`;
}

function writeEnvFile(path, lines, force) {
  if (existsSync(path) && !force) {
    fail(`${path} already exists. Re-run with --force after backing up the current file.`);
  }
  writeFileSync(path, `${lines.join("\n")}\n`, { flag: force ? "w" : "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

function runChecker(relayEnvPath, composeEnvPath, label) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-hosted-relay-config.mjs",
      "--env-file",
      relayEnvPath,
      "--compose-env-file",
      composeEnvPath,
      "--name",
      label
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: "pipe" }
  );
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    fail("generated environment did not pass hosted Relay validation");
  }
  return result.stdout.trim();
}

if (hasFlag("--help") || hasFlag("-h")) {
  usage();
  process.exit(0);
}

const publicHost = normalizePublicHost(valueFor("--public-host"));
const email = validateEmail(valueFor("--email"));
const tenantId = validateTenantId(valueFor("--tenant-id"));
const origins = normalizeOrigins();
const cimdHosts = normalizeCimdHosts();
const force = hasFlag("--force");
const dryRun = hasFlag("--dry-run");
const outDir = resolve(repoRoot, valueFor("--out-dir") ?? "deploy/relay");
const targetDir = dryRun ? mkdtempSync(resolve(tmpdir(), "lcv-relay-init-")) : outDir;
const relayEnvPath = resolve(targetDir, "relay.env");
const composeEnvPath = resolve(targetDir, "compose.env");
const displayOutDir = relative(repoRoot, outDir) || ".";

const relayEnv = [
  "# Generated by npm run hosted-relay:init.",
  "# Keep this file out of git. It contains Relay operator secrets.",
  "LCV_RELAY_BIND=0.0.0.0:8765",
  `LCV_RELAY_BASE_URL=https://${publicHost}`,
  `LCV_RELAY_PUBLIC_HOST=${publicHost}`,
  `LCV_RELAY_ADMIN_TOKEN=${secret("admin")}`,
  `LCV_RELAY_HANDOFF_SECRET=${secret("handoff")}`,
  `LCV_RELAY_TENANT_ID=${tenantId}`,
  "LCV_RELAY_ALLOW_DIRECT_SIDECAR=0",
  "LCV_RELAY_ENABLE_STATIC_TOKEN=0",
  "LCV_RELAY_AUTO_APPROVE=0",
  `LCV_RELAY_ALLOWED_ORIGINS=${origins.join(",")}`,
  `LCV_RELAY_ALLOWED_CIMD_HOSTS=${cimdHosts.join(",")}`,
  "LCV_RELAY_STATE_PATH=/data/relay-state.json",
  "LCV_RELAY_REQUEST_EVENT_RETENTION_DAYS=30",
  "LCV_RELAY_CLIENT_RETENTION_DAYS=180",
  "LCV_RELAY_STATE_BACKUP_COUNT=5",
  "LCV_RELAY_HANDOFF_TTL_SECONDS=600"
];

const composeEnv = [
  "# Generated by npm run hosted-relay:init.",
  "# Caddy uses this file only for HTTPS certificate issuance and routing.",
  `LCV_RELAY_PUBLIC_HOST=${publicHost}`,
  `LCV_RELAY_ACME_EMAIL=${email}`
];

try {
  mkdirSync(targetDir, { recursive: true });
  writeEnvFile(relayEnvPath, relayEnv, force || dryRun);
  writeEnvFile(composeEnvPath, composeEnv, force || dryRun);
  const checkerOutput = runChecker(relayEnvPath, composeEnvPath, dryRun ? "dry-run generated config" : "generated config");

  if (dryRun) {
    console.log("Hosted Relay config dry-run passed. No repo files were written.");
  } else {
    console.log("Hosted Relay config files created:");
    console.log(`- ${relayEnvPath}`);
    console.log(`- ${composeEnvPath}`);
  }
  console.log(checkerOutput);
  console.log("");
  console.log("Next steps:");
  console.log("1. Point DNS for the public host at this server.");
  console.log("2. Inspect the Compose config:");
  console.log(`   cd ${displayOutDir} && docker compose --env-file compose.env -f compose.yaml config`);
  console.log("3. Start the hosted Relay:");
  console.log(`   cd ${displayOutDir} && docker compose --env-file compose.env up -d --build`);
  console.log("4. Smoke-test the public endpoint:");
  console.log(`   LCV_HOSTED_RELAY_URL=https://${publicHost} npm run hosted-relay:smoke`);
  console.log("5. Start pairing from Control Center or POST /pairing/start with the admin token stored in relay.env.");
} finally {
  if (dryRun) rmSync(targetDir, { recursive: true, force: true });
}
