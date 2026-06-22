//! Recovery key: an offline escape hatch that re-derives the SQLCipher key when
//! the OS credential store (macOS Keychain) is lost.
//!
//! On first vault creation the app generates a high-entropy recovery key,
//! shows it once for the user to write down, and stores a **sidecar** envelope
//! (next to the encrypted DB, never inside it) containing the SQLCipher key
//! wrapped by a key derived from the recovery key. The recovery key itself is
//! never stored; AES-GCM's auth tag verifies it on unwrap.
//!
//! This module is the pure crypto core (DB-independent); the sidecar file IO
//! and onboarding flow live in `lib.rs` / the frontend.

use aes_gcm::{
  aead::{Aead, KeyInit},
  Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const RECOVERY_KEY_BYTES: usize = 20; // 160-bit, formatted as 5 groups of 8 hex chars
const RECOVERY_KDF_ITERATIONS: u32 = 600_000;
const RECOVERY_ENVELOPE_VERSION: u64 = 1;
const RECOVERY_SALT_LEN: usize = 16;
const RECOVERY_IV_LEN: usize = 12;
const RECOVERY_KEY_LEN: usize = 32;
const RECOVERY_KDF_NAME: &str = "PBKDF2-SHA256";
const RECOVERY_PURPOSE: &str = "vault-key-wrap";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryEnvelope {
  version: u64,
  kdf: String,
  purpose: String,
  iterations: u32,
  salt: String,
  iv: String,
  wrapped_key: String,
}

/// Parse a user-entered recovery key (with or without dashes/spaces) back into
/// its raw bytes. Fails on malformed input.
pub fn parse_recovery_key(formatted: &str) -> Result<[u8; RECOVERY_KEY_BYTES], String> {
  let stripped: String = formatted
    .chars()
    .filter(|character| !character.is_whitespace() && *character != '-')
    .map(|character| character.to_ascii_lowercase())
    .collect();
  if stripped.len() != RECOVERY_KEY_BYTES * 2 {
    return Err(format!(
      "recovery key must be {} hex characters (excluding dashes)",
      RECOVERY_KEY_BYTES * 2
    ));
  }
  if !stripped
    .chars()
    .all(|character| character.is_ascii_hexdigit())
  {
    return Err("recovery key must contain only hex characters".to_string());
  }
  let mut bytes = [0u8; RECOVERY_KEY_BYTES];
  for (byte, chunk) in bytes.iter_mut().zip(stripped.as_bytes().chunks(2)) {
    let pair =
      std::str::from_utf8(chunk).map_err(|error| format!("invalid recovery key: {error}"))?;
    *byte =
      u8::from_str_radix(pair, 16).map_err(|error| format!("invalid recovery key: {error}"))?;
  }
  Ok(bytes)
}

/// Wrap a secret (the SQLCipher key hex string) under a recovery key. Returns
/// a pretty-printed JSON envelope for the sidecar file.
pub fn wrap_vault_key(vault_key_hex: &str, recovery_key_formatted: &str) -> Result<String, String> {
  let recovery_bytes = parse_recovery_key(recovery_key_formatted)?;
  let mut salt = [0u8; RECOVERY_SALT_LEN];
  let mut iv = [0u8; RECOVERY_IV_LEN];
  getrandom::getrandom(&mut salt)
    .map_err(|error| format!("failed to generate recovery salt: {error}"))?;
  getrandom::getrandom(&mut iv)
    .map_err(|error| format!("failed to generate recovery iv: {error}"))?;

  let kek = derive_recovery_kek(&recovery_bytes, &salt);
  let cipher =
    Aes256Gcm::new_from_slice(&kek).map_err(|error| format!("failed to build cipher: {error}"))?;
  let wrapped = cipher
    .encrypt(Nonce::from_slice(&iv), vault_key_hex.as_bytes())
    .map_err(|error| format!("failed to wrap vault key: {error}"))?;

  let envelope = RecoveryEnvelope {
    version: RECOVERY_ENVELOPE_VERSION,
    kdf: RECOVERY_KDF_NAME.to_string(),
    purpose: RECOVERY_PURPOSE.to_string(),
    iterations: RECOVERY_KDF_ITERATIONS,
    salt: STANDARD.encode(salt),
    iv: STANDARD.encode(iv),
    wrapped_key: STANDARD.encode(&wrapped),
  };
  serde_json::to_string_pretty(&envelope)
    .map_err(|error| format!("failed to encode recovery envelope: {error}"))
}

/// Unwrap the SQLCipher key hex from a sidecar envelope using the recovery key.
/// Fails if the recovery key is wrong (AES-GCM tag mismatch).
pub fn unwrap_vault_key(
  envelope_text: &str,
  recovery_key_formatted: &str,
) -> Result<String, String> {
  let value: serde_json::Value = serde_json::from_str(envelope_text)
    .map_err(|error| format!("recovery envelope is not valid JSON: {error}"))?;
  let version = value
    .get("version")
    .and_then(serde_json::Value::as_u64)
    .ok_or_else(|| "recovery envelope is missing a version".to_string())?;
  if version != RECOVERY_ENVELOPE_VERSION {
    return Err(format!("unsupported recovery envelope version: {version}"));
  }
  let salt = decode_envelope_field(&value, "salt")?;
  let iv = decode_envelope_field(&value, "iv")?;
  let wrapped = decode_envelope_field(&value, "wrappedKey")?;

  let recovery_bytes = parse_recovery_key(recovery_key_formatted)?;
  let kek = derive_recovery_kek(&recovery_bytes, &salt);
  let cipher =
    Aes256Gcm::new_from_slice(&kek).map_err(|error| format!("failed to build cipher: {error}"))?;
  let plaintext = cipher
    .decrypt(Nonce::from_slice(&iv), wrapped.as_slice())
    .map_err(|_| "recovery key is incorrect or the envelope is corrupted".to_string())?;
  String::from_utf8(plaintext).map_err(|error| format!("unwrapped key is not valid UTF-8: {error}"))
}

fn derive_recovery_kek(recovery_key_bytes: &[u8], salt: &[u8]) -> [u8; RECOVERY_KEY_LEN] {
  let mut key = [0u8; RECOVERY_KEY_LEN];
  pbkdf2_hmac::<Sha256>(recovery_key_bytes, salt, RECOVERY_KDF_ITERATIONS, &mut key);
  key
}

fn decode_envelope_field(value: &serde_json::Value, key: &str) -> Result<Vec<u8>, String> {
  let encoded = value
    .get(key)
    .and_then(serde_json::Value::as_str)
    .ok_or_else(|| format!("recovery envelope is missing {key}"))?;
  STANDARD
    .decode(encoded)
    .map_err(|error| format!("failed to decode recovery {key}: {error}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  const VAULT_KEY_HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const TEST_RECOVERY_KEY: &str = "a1b2c3d4-e5f6a7b8-c9d0e1f2-a3b4c5d6-e7f8a9b0";

  #[test]
  fn parse_recovery_key_accepts_dashed_and_plain_forms() {
    let plain = TEST_RECOVERY_KEY.replace('-', "");
    assert!(parse_recovery_key(TEST_RECOVERY_KEY).is_ok());
    assert!(parse_recovery_key(&plain).is_ok());
    assert_eq!(
      parse_recovery_key(TEST_RECOVERY_KEY).unwrap(),
      parse_recovery_key(&plain).unwrap()
    );
  }

  #[test]
  fn parse_recovery_key_rejects_malformed_input() {
    assert!(parse_recovery_key("nope").is_err());
    assert!(parse_recovery_key("zzzzzzzz-zzzzzzzz-zzzzzzzz-zzzzzzzz-zzzzzzzz").is_err());
  }

  #[test]
  fn wrap_and_unwrap_round_trips_vault_key() {
    let envelope = wrap_vault_key(VAULT_KEY_HEX, TEST_RECOVERY_KEY).expect("wrap should succeed");
    let recovered = unwrap_vault_key(&envelope, TEST_RECOVERY_KEY).expect("unwrap should succeed");
    assert_eq!(recovered, VAULT_KEY_HEX);
  }

  #[test]
  fn unwrap_rejects_wrong_recovery_key() {
    let envelope = wrap_vault_key(VAULT_KEY_HEX, TEST_RECOVERY_KEY).expect("wrap should succeed");
    assert!(unwrap_vault_key(&envelope, "01234567-89abcdef-01234567-89abcdef-01234567").is_err());
  }

  #[test]
  fn recovery_envelope_has_expected_shape() {
    let envelope = wrap_vault_key(VAULT_KEY_HEX, TEST_RECOVERY_KEY).expect("wrap should succeed");
    let value: serde_json::Value = serde_json::from_str(&envelope).expect("envelope is JSON");
    assert_eq!(value["version"], 1);
    assert_eq!(value["kdf"], "PBKDF2-SHA256");
    assert_eq!(value["purpose"], "vault-key-wrap");
    assert_eq!(value["iterations"], RECOVERY_KDF_ITERATIONS);
    assert!(value["salt"].is_string());
    assert!(value["iv"].is_string());
    assert!(value["wrappedKey"].is_string());
  }
}
