import "./prepare-tauri-sidecars.mjs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error("Usage: node scripts/run-tauri-with-sidecars.mjs <tauri args...>");
}

const externalBin = [
  "binaries/lcv-mcp",
  "binaries/lcv-relay",
  "binaries/lcv-agent",
  "binaries/lcv-capture-host"
];

execFileSync("tauri", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({
      bundle: {
        externalBin
      }
    })
  }
});
