import "./prepare-tauri-sidecars.mjs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error("Usage: node scripts/run-tauri-with-sidecars.mjs <tauri args...>");
}

// Keep in sync with scripts/prepare-tauri-sidecars.mjs `bins`. Only lcv-mcp ships;
// the relay/agent/capture-host sidecars were removed, and listing non-existent
// binaries here makes Tauri's externalBin resolution fail at bundle time.
const externalBin = ["binaries/lcv-mcp"];

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
