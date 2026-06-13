import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function valueFor(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function run(label, command, commandArgs, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...(options.env ?? {})
    }
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function cargoFmtAvailable() {
  const result = spawnSync("cargo", ["fmt", "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe"
  });
  return result.status === 0;
}

const full = hasFlag("--full");
const includeBench = full || hasFlag("--include-bench");
const includeTauriBuild = full || hasFlag("--include-tauri-build");
const includeSseSoak = full || hasFlag("--include-sse-soak");
const benchEnv = {};
const benchFacts = valueFor("--bench-facts");
const benchChunksPerFact = valueFor("--bench-chunks-per-fact");

if (benchFacts) benchEnv.LCV_BENCH_FACTS = benchFacts;
if (benchChunksPerFact) benchEnv.LCV_BENCH_CHUNKS_PER_FACT = benchChunksPerFact;

run("frontend tests", "npm", ["test"]);
run("frontend production build", "npm", ["run", "build"]);

if (cargoFmtAvailable()) {
  run("Rust format check", "cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--check"]);
} else {
  console.warn("\n==> Rust format check");
  console.warn("Skipping cargo fmt because rustfmt is not installed for the active toolchain.");
}

run("Rust tests", "cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"]);
run("Rust release binaries", "cargo", [
  "build",
  "--release",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--bins"
]);

run("HTTP relay smoke", "npm", ["run", "relay:smoke"]);
run("hosted Relay config baseline", "npm", ["run", "hosted-relay:check", "--", "--example"]);

if (includeSseSoak) {
  run("HTTP relay SSE soak", "npm", ["run", "relay:sse-soak"]);
}

if (includeTauriBuild) {
  run("Tauri sidecar integration build", "npm", ["run", "tauri:build"]);
}

if (includeBench) {
  run("large retrieval benchmark", "npm", ["run", "retrieval:bench"], { env: benchEnv });
}

run("git diff whitespace check", "git", ["diff", "--check"]);

console.log("\nProduct release checks passed.");
