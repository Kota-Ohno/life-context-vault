# Data Deletion & Erasure — Life Context Vault

How to remove data from Life Context Vault, from a single fact up to a complete,
irrecoverable wipe. This supports the **right to erasure** under GDPR (EU),
Japan's APPI (個人情報保護法), and CCPA, and ordinary "I want this gone" needs.

> Local-first means deletion happens **on your device**. There is no server
> holding your data to delete from — but you must erase every copy, including
> backups, to be thorough.

## Levels of deletion

### 1. Delete a single source or fact (soft, reversible)

- In the **Sources** view, a source can be soft-deleted; it can be restored
  from the audit trail until purged. Soft-deleted sources stop contributing to
  Context Packs immediately (packs referencing them are invalidated).
- In the audit/Inbox flow, a fact can be hidden or marked for review without
  erasing its text. Use **delete** to remove it from active context.

Soft deletion removes the item from AI-bound Context Packs right away, but the
text still exists in the encrypted vault and in any encrypted backup taken
before the deletion.

### 2. Purge raw source bodies (irreversible for that source)

- **Purge** a source to destroy its raw body text while keeping any approved
  facts you derived from it. Use this when you want the AI to keep using a
  conclusion but no longer want the original text stored.
- Passive-capture sources are purged automatically when their retention window
  expires.

### 3. Clear the entire vault (destructive, typed confirmation)

- **Clear Vault** wipes all sources, candidates, facts, packs, and the audit
  trail from the local encrypted database. The app requires **typed
  confirmation** before proceeding (this is already implemented).
- Clearing the vault does **not** touch:
  - Encrypted backups (`.lcvbak`) you saved elsewhere — delete those manually.
  - Data already delivered to an AI provider via approved Context Packs (that
    is governed by the provider).
  - Connector config (e.g., Claude Desktop's config) — disconnect/remove those
    separately if desired.

## Coordinated full erasure (right-to-erasure checklist)

To remove **all** Life Context Vault data:

1. In the app: **Clear Vault** (typed confirmation). This wipes the encrypted DB
   contents.
2. Delete the encrypted database file itself so no schema/fragment remains:
   `~/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3`
   (and the `-wal`/`-shm` sidecars; quitting the app first ensures they flush).
3. Delete the OS credential-store entry (macOS Keychain): the
   `dev.life-context-vault.poc.vault-key` generic password.
4. Delete every encrypted backup (`.lcvbak`) you created, including any copied
   to cloud-sync folders.
5. Remove the app (drag to Trash) and its support directory if you no longer
   want the application.
6. Remove any connector configuration you let the app install (e.g., the
   `life-context-vault` entry in Claude Desktop's config) and any browser
   extension / native-messaging host manifest.

After steps 1–3, no vault data remains on the device. Steps 4–6 cover copies and
integrations.

## Verifying erasure

Because the vault is encrypted, "empty" cannot be confirmed by reading the
file directly. Trust the in-app Clear Vault confirmation and the file deletion
in step 2. If you keep a backup passphrase recorded anywhere, destroy that
record too.

## What deletion cannot undo

- A Context Pack you already approved and delivered to an AI provider. Contact
  that provider to exercise erasure rights there.
- OS-level backups (e.g., Time Machine) that captured the vault file before you
  deleted it — exclude the app's data folder from system backups if this
  matters, and purge old snapshots per your backup software's guidance.
