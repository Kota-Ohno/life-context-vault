# Security Policy

Life Context Vault is a local-first desktop application that stores sensitive
personal context and exposes only reviewed **Context Packs** to AI clients. We
take the trust boundary — *raw sources and unapproved candidates never leave
the device* — as the core security property of the product.

## Reporting a Vulnerability

Please report security issues **privately** — do not open a public issue.

Use **GitHub Private Vulnerability Reporting**: open the repository's
**Security** tab and choose **Report a vulnerability**. This opens a private
advisory visible only to the maintainers.

Include:
- A description of the issue and its impact.
- The version/commit you tested (`git rev-parse HEAD`).
- Steps to reproduce, a proof of concept, or an affected file:line.

We will acknowledge within **5 business days** and aim to ship a fix or
mitigation within **90 days**, coordinated with you on disclosure timing.

## Trust model (what the product guarantees)

- All vault data is stored locally in an **encrypted SQLCipher** database keyed
  by a secret in the OS credential store (macOS Keychain). No vault data leaves
  the device unless the user explicitly exports an encrypted backup or
  approves a Context Pack.
- `RawSource` text and unapproved `MemoryCandidate`s can **never** reach an AI
  client. Only user-approved `ApprovedFact`s can, and only as part of a
  short-lived, user-confirmed Context Pack that is **re-validated against the
  current access policy at retrieval time**.
- `secret_never_send` facts can never become approved or appear in any pack.
- The local MCP path queues packs as `pending_user_confirmation` unless the user
  has explicitly granted a connection standing delivery; the AI client receives
  nothing until the policy is satisfied and (for reviewed packs) the user
  approves it in the Control Center.
- Encrypted backups (`.lcvbak`) contain the full vault including raw sources;
  the backup passphrase is as sensitive as the vault key.

## Trust model (what is NOT guaranteed)

- A lost OS-keychain secret **and** a lost recovery key / backup passphrase
  mean the vault cannot be recovered. Keep an encrypted backup.
- A remote AI provider that receives an approved Context Pack can read its
  contents. Review packs before confirming.

## Hardened configuration defaults

- AI access is local-only: the single sidecar (`lcv-mcp`) speaks MCP over stdio
  to a same-device client. The product makes no network egress of its own.
- Tauri webview enforces a Content-Security-Policy that blocks remote scripts
  and connections (`src-tauri/tauri.conf.json`).

## Scope

This policy covers the Life Context Vault desktop app and its sidecar binary
(`lcv-mcp`). Out of scope: the user's chosen AI providers, the OS, and
third-party document runtimes (Tesseract/LibreOffice) invoked for ingestion.
