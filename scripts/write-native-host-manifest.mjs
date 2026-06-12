import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const extensionId = process.env.LCV_EXTENSION_ID ?? "REPLACE_WITH_EXTENSION_ID";
const hostPath = resolve("src-tauri/target/release/lcv-capture-host");
const manifest = {
  name: "dev.life_context_vault.capture",
  description: "Life Context Vault browser capture native host",
  path: hostPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`]
};

const repoManifestPath = resolve("browser-extension/native-host.dev.json");
writeFileSync(repoManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const chromeDir = join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
mkdirSync(chromeDir, { recursive: true });
const chromeManifestPath = join(chromeDir, "dev.life_context_vault.capture.json");
writeFileSync(chromeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${repoManifestPath}`);
console.log(`Wrote ${chromeManifestPath}`);
if (extensionId === "REPLACE_WITH_EXTENSION_ID") {
  console.log("Set LCV_EXTENSION_ID to your unpacked extension id, then rerun this script.");
}
