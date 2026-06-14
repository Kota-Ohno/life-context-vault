# Release & Signing — Life Context Vault (macOS)

End-to-end procedure to produce a signed, notarized, auto-updating macOS
release. This is P0-A of the public-release plan. The build pipeline lives in
`.github/workflows/release.yml`; this document covers the one-time setup and
the per-release steps.

## Prerequisites (one-time, long-lead)

1. **Apple Developer Program** membership ($99/yr). Approval can take a few
   days — start this first.
2. A **Developer ID Application** certificate (for signing) and an **App-specific
   password** for `xcrun notarytool` (created at appleid.apple.com).
3. A **Tauri updater signing keypair**:

   ```bash
   npm run tauri -- signer generate -w ~/.tauri/lcv-updater.key
   # Writes the private key file and prints a public key.
   ```

   - Put the **public key** into `src-tauri/tauri.conf.json` →
     `plugins.updater.pubkey` (replace `REPLACE_WITH_UPDATER_PUBLIC_KEY`).
   - Store the **private key** and its password as GitHub secrets
     `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
     **Never commit the private key.**

## GitHub repository secrets

Populate these in *Settings → Secrets and variables → Actions*:

| Secret | Purpose |
|---|---|
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMXXXXXX)` |
| `APPLE_SIGNING_CERTIFICATE_P12` | base64 of the exported `.p12` (Developer ID Application) |
| `APPLE_SIGNING_CERTIFICATE_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_PASSWORD` | App-specific password for `notarytool` |
| `APPLE_TEAM_SHORT_NAME` | Developer team short name |
| `RUNNER_KEYCHAIN_PASSWORD` | any strong password for the CI keychain |
| `TAURI_SIGNING_PRIVATE_KEY` | updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | updater private-key password |

While these are unset, `.github/workflows/release.yml` still builds but produces
an **ad-hoc** (unsigned) artifact — useful for internal testing, blocked by
Gatekeeper for end users.

## Per-release steps

1. Confirm `npm run product:check` is green on `master`.
2. Bump `version` in `package.json` and `src-tauri/tauri.conf.json`
   (keep them in sync).
3. Update the `endpoints` host in `tauri.conf.json` if the update manifest has
   moved.
4. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. The `release` workflow runs: `product:check` gate (ubuntu) → macOS build,
   sign, notarize, staple → uploads artifacts + GitHub Release.

## Hosting the update manifest

Auto-update fetches `latest.json` (signed by Tauri) from the endpoint in
`tauri.conf.json`. After a release:

1. Copy `latest.json`, the `.app.tar.gz`, and the `.sig` from the release
   artifacts to your static host at the path the endpoint expects, e.g.
   `https://updates.lifecontextvault.example/darwin/aarch64/<current>/latest.json`.
2. Keep all target/arch combinations you ship (e.g. `darwin/aarch64`,
   `darwin/x86_64`).

## Verifying a release (manual)

```bash
APP="src-tauri/target/release/bundle/macos/Life Context Vault.app"
codesign --verify --deep --strict --verbose=4 "$APP"
spctl --assess --verbose=4 --type execute "$APP"
xcrun stapler validate "$APP"
```

On a clean Mac, install the `.dmg`, confirm Gatekeeper allows it, then publish a
`vX.Y.Z+1` and confirm the running app offers the update within minutes.

## What still needs the updater plugin wired (follow-up)

The config, keypair, and pipeline above produce signed update artifacts. The
**in-app update experience** (checking for updates, downloading, relaunching)
requires registering `tauri-plugin-updater` + `tauri-plugin-process` in
`src-tauri/Cargo.toml`/`run()` and a small `src/updater.ts` UI in Settings —
plus adding their permissions to `src-tauri/capabilities/default.json`. That
runtime wiring is the remaining P0-A task; it is independent of signing and can
land once the distribution artifacts exist.
