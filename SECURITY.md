# Security Policy

Life Context Vault is a local-first desktop application that stores sensitive
personal context and exposes only reviewed **Context Packs** to AI clients. We
take the trust boundary — *raw sources and unapproved candidates never leave
the device* — as the core security property of the product.

## Reporting a Vulnerability

Please report security issues **privately** — do not open a public issue.

- **Email:** _(set `SECURITY_CONTACT` before public release)_ — replace this
  address with the maintainer's security mailbox.
- **PGP:** _(publish a key and fingerprint here before public release)_.

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
- The MCP/relay path always queues packs as `pending_user_confirmation`; the AI
  client receives nothing until the user approves it in the Control Center.
- Encrypted backups (`.lcvbak`) contain the full vault including raw sources;
  the backup passphrase is as sensitive as the vault key.

## Trust model (what is NOT guaranteed)

- A lost OS-keychain secret **and** a lost recovery key / backup passphrase
  mean the vault cannot be recovered. Keep an encrypted backup.
- A remote AI provider that receives an approved Context Pack can read its
  contents. Review packs before confirming.
- The hosted relay (when used) handles only request/pack **metadata**, never
  vault data, and is a separate trust surface; see
  `docs/relay-public-exposure.md` (P0-F).

## Hardened configuration defaults

- The managed/HTTP MCP relay refuses non-loopback binds without explicit
  allowed-origins and tenant isolation, refuses static bearer tokens, and
  validates CIMD metadata-fetch targets (rejects localhost/non-public IPs).
- Tauri webview enforces a Content-Security-Policy that blocks remote scripts
  and connections (`src-tauri/tauri.conf.json`).

## Scope

This policy covers the Life Context Vault desktop app and its sidecar binaries
(`lcv-mcp`, `lcv-relay`, `lcv-agent`, `lcv-capture-host`). Out of scope: the
user's chosen AI providers, the OS, and third-party document runtimes
(Tesseract/LibreOffice) invoked for ingestion.
