# Contributing to Life Context Vault

Thanks for your interest. This project has one organizing principle: **the trust
boundary is the product.** Reviewed Context Packs are the only thing an AI client
ever sees — never the raw vault, raw sources, or unapproved memory candidates.
Every change is judged first by whether it preserves that boundary.

## Prerequisites

- **Node.js 22**
- **Rust** stable (minimum **1.77.2**)
- macOS is the primary target; the core also builds on Linux/Windows (set
  `LCV_VAULT_DB_KEY` or `LCV_VAULT_KEY_FILE` there — see `CLAUDE.md`).

```bash
npm install
npm run tauri:dev   # full app (vite + cargo + Tauri window + encrypted vault + AI access)
```

`npm run dev` is a **UI-review-only** browser preview: it uses a localStorage
fallback with no encrypted vault and no MCP. Use `tauri:dev` for real work.

## The release gate

Run this before opening a PR — it is exactly what CI runs:

```bash
npm run product:check
```

It runs the frontend tests, the type-check + build, `cargo fmt --check`,
`cargo test`, `cargo build --bins`, and a whitespace check. Keep the Rust tree
rustfmt-clean:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml
```

## Conventions

- **Tests are colocated:** Rust `#[cfg(test)] mod tests` at the bottom of each
  file; TypeScript `*.test.ts` next to the module. The security logic in
  `src/vault.ts` and the Rust `mod tests` have strong coverage — mirror that
  style, especially for anything that touches the boundary.
- **Rust ↔ TS parity:** the Rust `*_at_path` core (`src-tauri/src/lib.rs`) is the
  shipping path; `src/vault.ts` mirrors it for the browser-preview fallback. A
  boundary change in one must land in both, with tests on both sides.
- **Formatting:** 2-space Rust (`src-tauri/rustfmt.toml`); the frontend follows
  the existing style in `src/`.
- **Commits:** stage specific paths — never `git add -A` (it sweeps local
  settings and editor/Finder cruft). Keep commits focused with a clear message.

## Scope discipline

Ingestion stays **curated and deliberate** — manual entry, file uploads, and
opt-in browser capture only. Auto-mass-capture of email, notes, calendar, or
browsing history is **explicitly out of scope**: it recreates the surveillance
the product opposes. PRs that add passive-vacuum ingestion will be declined.

## Reporting security issues

Do **not** open a public issue for vulnerabilities. See
[`SECURITY.md`](SECURITY.md) — use GitHub Private Vulnerability Reporting
(repository **Security** tab → **Report a vulnerability**).
