# Privacy Policy — Life Context Vault

_Lifecycle: DRAFT (pre-public-release). Finalize before distribution._

Life Context Vault is built **local-first**: your life context lives on your
device, encrypted, and you control exactly what (if anything) leaves it. This
policy describes what the application does with your data.

## 1. What is stored, and where

- **Vault data** — background facts, sources (notes, uploaded documents,
  captured chat fragments), candidates, approved facts, context packs, and the
  audit trail — is stored **only on your device** in an encrypted
  SQLCipher database. The encryption key is held by your operating system's
  credential store (macOS Keychain).
- **Settings and connector configuration** are stored on your device alongside
  the vault (and, for a few provider preferences, in the app's local storage).

The maintainer **never** receives, hosts, or can decrypt your vault data.

## 2. What leaves your device, and only when you choose

- **Context Packs to AI clients.** When you approve a Context Pack, its
  contents are delivered to the AI client you connected (e.g., Claude Desktop,
  ChatGPT). The pack contains only facts you approved, filtered by your
  sensitivity policy. Raw sources and unapproved candidates are **never**
  included. That delivery is governed by the AI provider's own privacy policy.
- **Encrypted backups** (`.lcvbak`) are written only to a location you choose
  (a local folder, or a cloud-sync folder you pick). The backup is encrypted
  with a passphrase only you know.
- **Managed relay metadata.** If you use the managed-relay connector, the relay
  processes only routing metadata (request identifiers, pairing codes, short-lived
  handoff references). It does **not** receive vault data or raw sources.

## 3. Telemetry and crash reports

The application does **not** include telemetry, analytics, advertising SDKs, or
automatic crash reporting by default. No usage data is sent to the maintainer.

_(Decision pending before public release: whether to offer opt-in, anonymous
crash reporting. If added, it will be off by default and documented here.)_

## 4. Third-party services and runtimes

- **AI providers** you connect receive only the Context Packs you approve.
- **Optional document runtimes** (e.g., Tesseract OCR, LibreOffice) run locally
  on your device when you ingest images or legacy Office formats; they do not
  transmit data.
- **Cloud-sync providers** (e.g., iCloud Drive, Dropbox) may receive an
  encrypted `.lcvbak` **only if** you explicitly choose such a folder as your
  backup destination.

## 5. Your choices and data control

- **Review before delivery:** every Context Pack is shown for confirmation
  before anything reaches an AI client.
- **Sensitivity tiers:** mark facts `secret_never_send` to guarantee they can
  never appear in any pack.
- **Export / backup:** create encrypted backups at any time.
- **Deletion / erasure:** see `docs/data-deletion.md` for how to remove
  individual sources/facts or wipe the entire vault, backups, and audit trail.
- **Disconnect:** remove any AI connector at any time from the Connections view.

## 6. Security

See `SECURITY.md` for the trust model, vulnerability reporting, and the
guarantees the product is designed to enforce.

## 7. Children's privacy

The application is intended for adult personal use and is not directed at
children.

## 8. Changes

Material changes to this policy will accompany a new app version. The
localized (Japanese) version accompanies the i18n release.

## 9. Contact

_(set maintainer contact before public release)_
