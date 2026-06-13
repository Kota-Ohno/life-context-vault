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
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      fail("LCV_RELAY_BASE_URL must be a public HTTPS origin, not localhost");
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
  });

  check(() => {
    if (!secretLooksLong(config.LCV_RELAY_HANDOFF_SECRET)) {
      fail("LCV_RELAY_HANDOFF_SECRET must be set and at least 32 characters");
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
    LCV_RELAY_STATE_PATH: "/data/relay-state.json",
    LCV_RELAY_REQUEST_EVENT_RETENTION_DAYS: "30",
    LCV_RELAY_CLIENT_RETENTION_DAYS: "180",
    LCV_RELAY_STATE_BACKUP_COUNT: "5",
    LCV_RELAY_HANDOFF_TTL_SECONDS: "600"
  };
}

const config = hasFlag("--example")
  ? exampleConfig()
  : Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("LCV_")));
const { errors, warnings } = validate(config);

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
