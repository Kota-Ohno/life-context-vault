import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const placeholderCheckEnabled = !hasFlag("--example") && !hasFlag("--allow-placeholders");

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

function parseEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const parsed = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) fail(`${path}:${index + 1} must be KEY=value`);
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function originOf(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} must be a valid URL`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    fail(`${name} must be an origin without path, query, or hash`);
  }
  return url;
}

function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTruthyPublicStatic(value) {
  return value === "1" || value === "true" || value === "yes";
}

function secretLooksLong(value) {
  return typeof value === "string" && value.trim().length >= 32;
}

function looksLikePlaceholder(value) {
  return /<|>|change[-_ ]?me|replace[-_ ]?me|example\.com|your[-_ ]/i.test(String(value ?? ""));
}

function validateHostName(value, name) {
  if (!value) fail(`${name} is required`);
  if (String(value).includes("://") || String(value).includes("/") || String(value).includes(":")) {
    fail(`${name} must be a hostname without scheme, path, or port`);
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(String(value)) || !String(value).includes(".")) {
    fail(`${name} must be a public DNS hostname`);
  }
}

function validateCimdHost(value) {
  const host = String(value ?? "").trim().replace(/\.$/, "").toLowerCase();
  if (!host) fail("LCV_RELAY_ALLOWED_CIMD_HOSTS must not include empty entries");
  if (host.includes("://") || host.includes("/") || host.includes(":") || host.includes("@")) {
    fail(`LCV_RELAY_ALLOWED_CIMD_HOSTS entries must be hostnames without scheme, path, port, or userinfo: ${value}`);
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    fail(`LCV_RELAY_ALLOWED_CIMD_HOSTS entries must be public DNS hostnames: ${value}`);
  }
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) {
    fail(`LCV_RELAY_ALLOWED_CIMD_HOSTS entries must be public DNS hostnames: ${value}`);
  }
  return host;
}

function validateComposeEnv(config, relayConfig) {
  const errors = [];
  const warnings = [];
  const allowedKeys = new Set(["LCV_RELAY_PUBLIC_HOST", "LCV_RELAY_ACME_EMAIL"]);
  const forbiddenKeys = [
    "LCV_RELAY_ADMIN_TOKEN",
    "LCV_RELAY_HANDOFF_SECRET",
    "LCV_RELAY_TOKEN",
    "LCV_RELAY_AUTO_APPROVE",
    "LCV_RELAY_ENABLE_STATIC_TOKEN",
    "LCV_MCP_COMMAND",
    "LCV_VAULT_DB_PATH",
    "LCV_VAULT_DB_KEY"
  ];

  function check(fn) {
    try {
      fn();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  check(() => {
    validateHostName(config.LCV_RELAY_PUBLIC_HOST, "compose LCV_RELAY_PUBLIC_HOST");
    if (placeholderCheckEnabled && looksLikePlaceholder(config.LCV_RELAY_PUBLIC_HOST)) {
      fail("compose LCV_RELAY_PUBLIC_HOST must be replaced with the real hosted Relay host");
    }
    const relayHost = relayConfig.LCV_RELAY_PUBLIC_HOST ?? (relayConfig.LCV_RELAY_BASE_URL ? new URL(relayConfig.LCV_RELAY_BASE_URL).hostname : null);
    if (relayHost && config.LCV_RELAY_PUBLIC_HOST !== relayHost) {
      fail("compose LCV_RELAY_PUBLIC_HOST must match the Relay environment host");
    }
  });

  check(() => {
    const email = String(config.LCV_RELAY_ACME_EMAIL ?? "");
    if (!email || !email.includes("@")) {
      fail("LCV_RELAY_ACME_EMAIL is required for Caddy certificate issuance");
    }
    if (placeholderCheckEnabled && looksLikePlaceholder(email)) {
      fail("LCV_RELAY_ACME_EMAIL must be replaced with the real certificate contact email");
    }
  });

  for (const key of forbiddenKeys) {
    check(() => {
      if (config[key]) fail(`${key} must not be present in compose.env; keep Relay secrets in relay.env only`);
    });
  }

  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key) && !forbiddenKeys.includes(key)) {
      warnings.push(`${key} is not used by the compose/Caddy bundle; confirm it is not a misplaced Relay secret.`);
    }
  }

  return { errors, warnings };
}

function validate(config) {
  const errors = [];
  const warnings = [];

  function check(fn) {
    try {
      fn();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const baseUrl = config.LCV_RELAY_BASE_URL;
  check(() => {
    if (!baseUrl) fail("LCV_RELAY_BASE_URL is required");
    const url = originOf(baseUrl, "LCV_RELAY_BASE_URL");
    if (url.protocol !== "https:") fail("LCV_RELAY_BASE_URL must use https:// for hosted deployments");
    if (placeholderCheckEnabled && looksLikePlaceholder(baseUrl)) {
      fail("LCV_RELAY_BASE_URL must be replaced with the real hosted Relay origin");
    }
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      fail("LCV_RELAY_BASE_URL must be a public HTTPS origin, not localhost");
    }
    if (config.LCV_RELAY_PUBLIC_HOST && config.LCV_RELAY_PUBLIC_HOST !== url.hostname) {
      fail("LCV_RELAY_PUBLIC_HOST must match the host portion of LCV_RELAY_BASE_URL");
    }
  });

  check(() => {
    if (!config.LCV_RELAY_BIND) fail("LCV_RELAY_BIND is required");
    if (!String(config.LCV_RELAY_BIND).startsWith("0.0.0.0:")) {
      warnings.push("LCV_RELAY_BIND is not 0.0.0.0:<port>; confirm your platform exposes the relay publicly.");
    }
  });

  check(() => {
    if (config.LCV_RELAY_ALLOW_DIRECT_SIDECAR !== "0") {
      fail("LCV_RELAY_ALLOW_DIRECT_SIDECAR=0 is required for hosted deployments");
    }
  });

  check(() => {
    if (isTruthyPublicStatic(config.LCV_RELAY_ENABLE_STATIC_TOKEN)) {
      fail("LCV_RELAY_ENABLE_STATIC_TOKEN must not be enabled for hosted deployments");
    }
    if (isTruthyPublicStatic(config.LCV_RELAY_AUTO_APPROVE)) {
      fail("LCV_RELAY_AUTO_APPROVE must not be enabled for hosted deployments");
    }
    if (config.LCV_RELAY_TOKEN) {
      fail("LCV_RELAY_TOKEN must not be set for hosted deployments; use OAuth clients instead");
    }
  });

  check(() => {
    if (!secretLooksLong(config.LCV_RELAY_ADMIN_TOKEN)) {
      fail("LCV_RELAY_ADMIN_TOKEN must be set and at least 32 characters");
    }
    if (placeholderCheckEnabled && looksLikePlaceholder(config.LCV_RELAY_ADMIN_TOKEN)) {
      fail("LCV_RELAY_ADMIN_TOKEN must be generated from the hosting platform secret store");
    }
  });

  check(() => {
    if (!secretLooksLong(config.LCV_RELAY_HANDOFF_SECRET)) {
      fail("LCV_RELAY_HANDOFF_SECRET must be set and at least 32 characters");
    }
    if (placeholderCheckEnabled && looksLikePlaceholder(config.LCV_RELAY_HANDOFF_SECRET)) {
      fail("LCV_RELAY_HANDOFF_SECRET must be generated from the hosting platform secret store");
    }
    if (config.LCV_RELAY_HANDOFF_SECRET === config.LCV_RELAY_ADMIN_TOKEN) {
      fail("LCV_RELAY_HANDOFF_SECRET must differ from LCV_RELAY_ADMIN_TOKEN");
    }
  });

  check(() => {
    if (!config.LCV_RELAY_TENANT_ID) fail("LCV_RELAY_TENANT_ID is required");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(config.LCV_RELAY_TENANT_ID)) {
      fail("LCV_RELAY_TENANT_ID must be 3-64 chars of letters, numbers, dots, underscores, or hyphens");
    }
  });

  check(() => {
    if (!config.LCV_RELAY_STATE_PATH) fail("LCV_RELAY_STATE_PATH is required");
    if (!String(config.LCV_RELAY_STATE_PATH).startsWith("/data/")) {
      warnings.push("LCV_RELAY_STATE_PATH is outside /data; confirm it is on a durable metadata volume.");
    }
  });

  check(() => {
    const origins = splitCsv(config.LCV_RELAY_ALLOWED_ORIGINS);
    if (origins.length === 0) fail("LCV_RELAY_ALLOWED_ORIGINS must include exact AI client origins");
    if (origins.includes("*")) fail("LCV_RELAY_ALLOWED_ORIGINS must not include *");
    for (const origin of origins) {
      const url = originOf(origin, "LCV_RELAY_ALLOWED_ORIGINS item");
      if (url.protocol !== "https:") fail(`LCV_RELAY_ALLOWED_ORIGINS item must use https://: ${origin}`);
    }
  });

  check(() => {
    const rawHosts = splitCsv(config.LCV_RELAY_ALLOWED_CIMD_HOSTS);
    const hosts = rawHosts.length ? rawHosts : ["chatgpt.com"];
    if (!rawHosts.length) {
      warnings.push("LCV_RELAY_ALLOWED_CIMD_HOSTS is not set; relay default is chatgpt.com.");
    }
    if (hosts.includes("*")) fail("LCV_RELAY_ALLOWED_CIMD_HOSTS must not include *");
    for (const host of hosts) validateCimdHost(host);
  });

  check(() => {
    if (config.LCV_MCP_COMMAND) fail("LCV_MCP_COMMAND must not be set on the hosted metadata-only relay");
    if (config.LCV_VAULT_DB_PATH) fail("LCV_VAULT_DB_PATH must not be set on the hosted metadata-only relay");
    if (config.LCV_VAULT_DB_KEY) fail("LCV_VAULT_DB_KEY must not be set on the hosted metadata-only relay");
  });

  check(() => {
    const ttl = Number.parseInt(config.LCV_RELAY_HANDOFF_TTL_SECONDS ?? "600", 10);
    if (!Number.isFinite(ttl) || ttl <= 0) fail("LCV_RELAY_HANDOFF_TTL_SECONDS must be a positive number of seconds");
    if (ttl > 600) fail("LCV_RELAY_HANDOFF_TTL_SECONDS must be 600 seconds or less for hosted deployments");
    if (config.LCV_RELAY_HANDOFF_TTL_DAYS) fail("LCV_RELAY_HANDOFF_TTL_DAYS must not be used for hosted deployments");
  });

  return { errors, warnings };
}

function exampleConfig() {
  return {
    LCV_RELAY_BIND: "0.0.0.0:8765",
    LCV_RELAY_BASE_URL: "https://relay.example.com",
    LCV_RELAY_ADMIN_TOKEN: "admin_0123456789abcdef0123456789abcdef",
    LCV_RELAY_HANDOFF_SECRET: "handoff_0123456789abcdef0123456789abcdef",
    LCV_RELAY_TENANT_ID: "production",
    LCV_RELAY_ALLOW_DIRECT_SIDECAR: "0",
    LCV_RELAY_ALLOWED_ORIGINS: "https://chatgpt.com,https://claude.ai",
    LCV_RELAY_ALLOWED_CIMD_HOSTS: "chatgpt.com",
    LCV_RELAY_STATE_PATH: "/data/relay-state.json",
    LCV_RELAY_REQUEST_EVENT_RETENTION_DAYS: "30",
    LCV_RELAY_CLIENT_RETENTION_DAYS: "180",
    LCV_RELAY_STATE_BACKUP_COUNT: "5",
    LCV_RELAY_HANDOFF_TTL_SECONDS: "600"
  };
}

const config = hasFlag("--example")
  ? exampleConfig()
  : valueFor("--env-file")
  ? parseEnvFile(valueFor("--env-file"))
  : Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("LCV_")));
const { errors, warnings } = validate(config);
const composeEnvFile = valueFor("--compose-env-file");
if (composeEnvFile) {
  const composeResult = validateComposeEnv(parseEnvFile(composeEnvFile), config);
  errors.push(...composeResult.errors);
  warnings.push(...composeResult.warnings);
}

if (warnings.length) {
  console.warn("Hosted Relay config warnings:");
  for (const warning of warnings) console.warn(`- ${warning}`);
}

if (errors.length) {
  console.error("Hosted Relay config check failed:");
  for (const error of errors) console.error(`- ${error}`);
  console.error("\nSet the LCV_RELAY_* environment variables or run with --example to validate the documented baseline.");
  process.exit(1);
}

console.log(
  `Hosted Relay config check passed for ${hasFlag("--example") ? "documented example" : valueFor("--name") ?? "environment"}.`
);
