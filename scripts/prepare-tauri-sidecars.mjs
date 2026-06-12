import { copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repoRoot, "src-tauri", "Cargo.toml");
const releaseDir = join(repoRoot, "src-tauri", "target", "release");
const sidecarDir = join(repoRoot, "src-tauri", "binaries");
const bins = ["lcv-mcp", "lcv-relay", "lcv-agent", "lcv-capture-host"];

function hostTriple() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = output
    .split("\n")
    .find((line) => line.startsWith("host:"))
    ?.replace("host:", "")
    .trim();
  if (!host) throw new Error("Could not determine rustc host triple");
  return host;
}

const triple = hostTriple();
const exe = process.platform === "win32" ? ".exe" : "";

execFileSync(
  "cargo",
  [
    "build",
    "--release",
    "--manifest-path",
    manifestPath,
    ...bins.flatMap((bin) => ["--bin", bin])
  ],
  { stdio: "inherit" }
);

mkdirSync(sidecarDir, { recursive: true });

for (const bin of bins) {
  const source = join(releaseDir, `${bin}${exe}`);
  const destination = join(sidecarDir, `${bin}-${triple}${exe}`);
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
  console.log(`Prepared Tauri sidecar ${destination}`);
}
