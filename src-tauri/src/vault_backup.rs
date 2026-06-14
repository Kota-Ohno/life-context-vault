//! Encrypted vault backup envelope (PBKDF2-SHA256 + AES-GCM-256).
//!
//! Pure crypto layer operating on the canonical `vault_state` JSON payload
//! string. DB-aware `*_at_path` wrappers live in `lib.rs` and compose these
//! with the vault connection. The envelope format is byte-compatible with the
//! legacy pure-TS implementation in `src/vault.ts` so backups restore across
//! both paths.

use aes_gcm::{
  aead::{Aead, KeyInit},
  Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const BACKUP_KDF_ITERATIONS: u32 = 600_000;
const LEGACY_BACKUP_KDF_ITERATIONS: u32 = 120_000;
const BACKUP_ENVELOPE_VERSION: u64 = 1;
const BACKUP_SALT_LEN: usize = 16;
const BACKUP_IV_LEN: usize = 12;
const BACKUP_KEY_LEN: usize = 32;
const BACKUP_KDF_NAME: &str = "PBKDF2-SHA256";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupEnvelope {
  version: u64,
  kdf: String,
  iterations: u32,
  salt: String,
  iv: String,
  cipher_text: String,
}

/// Validate a backup passphrase against the same policy as the TS path:
/// at least 12 characters and spanning at least 3 of the 4 character
/// classes (lower / upper / digit / symbol).
pub fn validate_backup_passphrase(passphrase: &str) -> Result<(), String> {
  let trimmed = passphrase.trim();
  if trimmed.is_empty() {
    return Err("Passphrase is required.".to_string());
  }
  let has_lower = trimmed.chars().any(|c| c.is_ascii_lowercase());
  let has_upper = trimmed.chars().any(|c| c.is_ascii_uppercase());
  let has_digit = trimmed.chars().any(|c| c.is_ascii_digit());
  let has_symbol = trimmed.chars().any(|c| !c.is_ascii_alphanumeric());
  let classes = [has_lower, has_upper, has_digit, has_symbol]
    .iter()
    .filter(|present| **present)
    .count();
  if trimmed.chars().count() < 12 || classes < 3 {
    return Err(
      "バックアップのパスフレーズは12文字以上で、英大文字・英小文字・数字・記号のうち3種類以上を含めてください。".to_string(),
    );
  }
  Ok(())
}

/// Encrypt a canonical payload string (the `vault_state` JSON) into the
/// envelope text. Returns pretty-printed JSON:
/// `{ version, kdf, iterations, salt, iv, cipherText }` (base64, standard
/// alphabet with padding).
pub fn export_encrypted_backup(payload: &str, passphrase: &str) -> Result<String, String> {
  validate_backup_passphrase(passphrase)?;
  let mut salt = [0u8; BACKUP_SALT_LEN];
  let mut iv = [0u8; BACKUP_IV_LEN];
  getrandom::getrandom(&mut salt).map_err(|error| format!("failed to generate backup salt: {error}"))?;
  getrandom::getrandom(&mut iv).map_err(|error| format!("failed to generate backup iv: {error}"))?;

  let key = derive_backup_key(passphrase, &salt, BACKUP_KDF_ITERATIONS)?;
  let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| format!("failed to build cipher: {error}"))?;
  let ciphertext = cipher
    .encrypt(Nonce::from_slice(&iv), payload.as_bytes())
    .map_err(|error| format!("failed to encrypt backup: {error}"))?;

  let envelope = BackupEnvelope {
    version: BACKUP_ENVELOPE_VERSION,
    kdf: BACKUP_KDF_NAME.to_string(),
    iterations: BACKUP_KDF_ITERATIONS,
    salt: STANDARD.encode(salt),
    iv: STANDARD.encode(iv),
    cipher_text: STANDARD.encode(&ciphertext),
  };
  serde_json::to_string_pretty(&envelope).map_err(|error| format!("failed to encode backup envelope: {error}"))
}

/// Decrypt an envelope produced by `export_encrypted_backup` back into the
/// canonical payload string. Fails on a wrong passphrase (AES-GCM tag
/// mismatch) or an unsupported envelope version.
pub fn import_encrypted_backup(backup_text: &str, passphrase: &str) -> Result<String, String> {
  let value: serde_json::Value = serde_json::from_str(backup_text)
    .map_err(|error| format!("backup is not valid JSON: {error}"))?;
  let version = value
    .get("version")
    .and_then(serde_json::Value::as_u64)
    .ok_or_else(|| "backup is missing a version".to_string())?;
  if version != BACKUP_ENVELOPE_VERSION {
    return Err(format!("unsupported backup version: {version}"));
  }
  let iterations = value
    .get("iterations")
    .and_then(serde_json::Value::as_u64)
    .filter(|rounds| *rounds > 0)
    .unwrap_or(LEGACY_BACKUP_KDF_ITERATIONS as u64) as u32;
  let salt = decode_required_field(&value, "salt")?;
  let iv = decode_required_field(&value, "iv")?;
  let ciphertext = decode_required_field(&value, "cipherText")?;

  let key = derive_backup_key(passphrase, &salt, iterations)?;
  let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| format!("failed to build cipher: {error}"))?;
  let plaintext = cipher
    .decrypt(Nonce::from_slice(&iv), ciphertext.as_slice())
    .map_err(|_| "backup passphrase is incorrect or the backup is corrupted".to_string())?;
  String::from_utf8(plaintext)
    .map_err(|error| format!("decrypted backup payload is not valid UTF-8: {error}"))
}

fn derive_backup_key(passphrase: &str, salt: &[u8], iterations: u32) -> Result<[u8; BACKUP_KEY_LEN], String> {
  let mut key = [0u8; BACKUP_KEY_LEN];
  pbkdf2_hmac::<Sha256>(passphrase.as_bytes(), salt, iterations, &mut key);
  Ok(key)
}

fn decode_required_field(value: &serde_json::Value, key: &str) -> Result<Vec<u8>, String> {
  let encoded = value
    .get(key)
    .and_then(serde_json::Value::as_str)
    .ok_or_else(|| format!("backup is missing {key}"))?;
  STANDARD.decode(encoded).map_err(|error| format!("failed to decode backup {key}: {error}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  const STRONG_PASSPHRASE: &str = "Correct-Horse-42!"; // 16 chars, 4 classes

  #[test]
  fn passphrase_validation_rejects_short_passphrase() {
    assert!(validate_backup_passphrase("Short1!").is_err());
  }

  #[test]
  fn passphrase_validation_rejects_too_few_character_classes() {
    // 13 chars but a single class.
    assert!(validate_backup_passphrase("onlylowercase").is_err());
  }

  #[test]
  fn passphrase_validation_accepts_strong_passphrase() {
    assert!(validate_backup_passphrase(STRONG_PASSPHRASE).is_ok());
  }

  #[test]
  fn backup_round_trips_canonical_payload() {
    let payload = r#"{"version":2,"sources":[],"facts":[]}"#;
    let envelope = export_encrypted_backup(payload, STRONG_PASSPHRASE).expect("export should succeed");
    let restored = import_encrypted_backup(&envelope, STRONG_PASSPHRASE).expect("import should succeed");
    assert_eq!(restored, payload);
  }

  #[test]
  fn backup_rejects_wrong_passphrase_on_import() {
    let envelope = export_encrypted_backup("payload", STRONG_PASSPHRASE).expect("export should succeed");
    assert!(import_encrypted_backup(&envelope, "Wrong-Pass-99?").is_err());
  }

  #[test]
  fn backup_envelope_has_versioned_pbkdf2_shape() {
    let envelope = export_encrypted_backup("payload", STRONG_PASSPHRASE).expect("export should succeed");
    let value: serde_json::Value = serde_json::from_str(&envelope).expect("envelope must be JSON");
    assert_eq!(value["version"], 1);
    assert_eq!(value["kdf"], "PBKDF2-SHA256");
    assert_eq!(value["iterations"], BACKUP_KDF_ITERATIONS);
    assert!(value["salt"].is_string());
    assert!(value["iv"].is_string());
    assert!(value["cipherText"].is_string());
  }

  #[test]
  fn backup_rejects_unsupported_envelope_version() {
    let bogus = serde_json::json!({
      "version": 999,
      "kdf": "PBKDF2-SHA256",
      "iterations": BACKUP_KDF_ITERATIONS,
      "salt": "AAAAAAAAAAAAAAAAAAAAAA==",
      "iv": "AAAAAAAAAAAAAAAA",
      "cipherText": "AAAA"
    })
    .to_string();
    assert!(import_encrypted_backup(&bogus, STRONG_PASSPHRASE).is_err());
  }
}
