use rusqlite::{params, Connection, OptionalExtension};
use std::{
  fs,
  io::Read,
  path::{Path, PathBuf},
  time::{SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use std::process::Command;

const VAULT_STATE_KEY: &str = "vault_state";
const KEYCHAIN_SERVICE: &str = "dev.life-context-vault.poc.vault-key";
const KEYCHAIN_ACCOUNT: &str = "default";

pub fn open_encrypted_vault_connection(path: &Path) -> Result<Connection, String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)
      .map_err(|error| format!("failed to create vault database directory: {error}"))?;
  }
  let key = vault_key()?;

  if !path.exists() {
    return open_sqlcipher_connection(path, &key);
  }

  match open_sqlcipher_connection(path, &key) {
    Ok(connection) => Ok(connection),
    Err(encrypted_error) => {
      let payload = read_plaintext_payload(path).map_err(|plain_error| {
        format!(
          "failed to open vault as encrypted ({encrypted_error}) or plaintext ({plain_error})"
        )
      })?;
      migrate_plaintext_to_encrypted(path, &payload, &key)?;
      open_sqlcipher_connection(path, &key)
    }
  }
}

fn open_sqlcipher_connection(path: &Path, key: &str) -> Result<Connection, String> {
  let connection =
    Connection::open(path).map_err(|error| format!("failed to open vault database: {error}"))?;
  apply_sqlcipher_key(&connection, key)?;
  validate_connection(&connection)?;
  Ok(connection)
}

fn apply_sqlcipher_key(connection: &Connection, key: &str) -> Result<(), String> {
  connection
    .execute_batch(&format!(
      "
      PRAGMA key = '{}';
      PRAGMA cipher_page_size = 4096;
      PRAGMA kdf_iter = 256000;
      ",
      escape_sql_literal(key)
    ))
    .map_err(|error| format!("failed to apply SQLCipher key: {error}"))
}

fn validate_connection(connection: &Connection) -> Result<(), String> {
  connection
    .query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get::<_, i64>(0))
    .map(|_| ())
    .map_err(|error| format!("failed to validate encrypted vault database: {error}"))
}

fn read_plaintext_payload(path: &Path) -> Result<String, String> {
  let connection =
    Connection::open(path).map_err(|error| format!("failed to open plaintext vault: {error}"))?;
  connection
    .query_row(
      "SELECT payload FROM vault_state WHERE key = ?1",
      params![VAULT_STATE_KEY],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("failed to read plaintext vault payload: {error}"))?
    .ok_or_else(|| "plaintext vault has no vault_state payload".to_string())
}

fn migrate_plaintext_to_encrypted(path: &Path, payload: &str, key: &str) -> Result<(), String> {
  let backup_path = plaintext_backup_path(path);
  fs::rename(path, &backup_path).map_err(|error| {
    format!(
      "failed to move plaintext vault to {}: {error}",
      backup_path.display()
    )
  })?;
  remove_if_exists(&path.with_extension("sqlite3-wal"))?;
  remove_if_exists(&path.with_extension("sqlite3-shm"))?;

  let connection = open_sqlcipher_connection(path, key)?;
  connection
    .execute(
      "CREATE TABLE IF NOT EXISTS vault_state (
        key TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )",
      [],
    )
    .map_err(|error| format!("failed to initialize encrypted vault_state: {error}"))?;
  connection
    .execute(
      "INSERT INTO vault_state (key, payload, updated_at)
       VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         payload = excluded.payload,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      params![VAULT_STATE_KEY, payload],
    )
    .map_err(|error| format!("failed to write encrypted vault payload: {error}"))?;
  validate_connection(&connection)?;
  if !keep_plaintext_migration_backup() {
    remove_if_exists(&backup_path)?;
  }
  Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
  if path.exists() {
    fs::remove_file(path)
      .map_err(|error| format!("failed to remove {}: {error}", path.display()))?;
  }
  Ok(())
}

fn plaintext_backup_path(path: &Path) -> PathBuf {
  let suffix = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs())
    .unwrap_or_default();
  let filename = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("vault.sqlite3");
  path.with_file_name(format!("{filename}.plaintext-migrated-{suffix}"))
}

fn keep_plaintext_migration_backup() -> bool {
  std::env::var("LCV_KEEP_PLAINTEXT_MIGRATION_BACKUP")
    .map(|value| value == "1")
    .unwrap_or(false)
}

pub(crate) fn vault_key() -> Result<String, String> {
  if let Ok(key) = std::env::var("LCV_VAULT_DB_KEY") {
    if key.len() >= 32 {
      return Ok(key);
    }
    return Err("LCV_VAULT_DB_KEY must be at least 32 characters".to_string());
  }

  #[cfg(target_os = "macos")]
  {
    if let Some(key) = find_keychain_password()? {
      return Ok(key);
    }
    let key = generate_hex_key()?;
    store_keychain_password(&key)?;
    return Ok(key);
  }

  #[cfg(not(target_os = "macos"))]
  {
    let key_file = std::env::var("LCV_VAULT_KEY_FILE").map(PathBuf::from).map_err(|_| {
      "LCV_VAULT_DB_KEY or LCV_VAULT_KEY_FILE is required on this platform".to_string()
    })?;
    if key_file.exists() {
      return fs::read_to_string(&key_file)
        .map(|value| value.trim().to_string())
        .map_err(|error| format!("failed to read key file: {error}"));
    }
    let key = generate_hex_key()?;
    if let Some(parent) = key_file.parent() {
      fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create key file directory: {error}"))?;
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
      }
    }
    {
      let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&key_file)
        .map_err(|error| format!("failed to create key file: {error}"))?;
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
      }
      use std::io::Write as _;
      file
        .write_all(key.as_bytes())
        .map_err(|error| format!("failed to write key file: {error}"))?;
    }
    Ok(key)
  }
}

#[cfg(target_os = "macos")]
fn find_keychain_password() -> Result<Option<String>, String> {
  let output = Command::new("security")
    .args([
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ])
    .output()
    .map_err(|error| format!("failed to call security tool: {error}"))?;
  if output.status.success() {
    let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if key.is_empty() {
      Ok(None)
    } else {
      Ok(Some(key))
    }
  } else {
    Ok(None)
  }
}

#[cfg(target_os = "macos")]
fn store_keychain_password(key: &str) -> Result<(), String> {
  let status = Command::new("security")
    .args([
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      key,
      "-U",
    ])
    .status()
    .map_err(|error| format!("failed to call security tool: {error}"))?;
  if status.success() {
    Ok(())
  } else {
    Err(format!("failed to store vault key in Keychain: {status}"))
  }
}

/// Re-establish the vault key in the OS credential store after a recovery-key
/// unwrap, so subsequent normal opens succeed after a Keychain loss. macOS-only
/// (the release target); other platforms should restore from an encrypted backup.
#[cfg(target_os = "macos")]
pub(crate) fn reestablish_vault_key(key: &str) -> Result<(), String> {
  store_keychain_password(key)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn reestablish_vault_key(_key: &str) -> Result<(), String> {
  Err("Recovery re-key is macOS-only; restore from an encrypted backup instead.".to_string())
}

fn generate_hex_key() -> Result<String, String> {
  let mut bytes = [0u8; 32];
  let mut file = fs::File::open("/dev/urandom")
    .map_err(|error| format!("failed to open /dev/urandom: {error}"))?;
  file
    .read_exact(&mut bytes)
    .map_err(|error| format!("failed to read random key bytes: {error}"))?;
  Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn escape_sql_literal(value: &str) -> String {
  value.replace('\'', "''")
}

#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::params;

  #[test]
  fn encrypted_database_is_not_plain_sqlite_readable() {
    let path = std::env::temp_dir().join(format!(
      "lcv-encrypted-test-{}.sqlite3",
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos()
    ));
    let key = "0123456789abcdef0123456789abcdef";
    {
      let connection = open_sqlcipher_connection(&path, key).expect("encrypted connection");
      connection
        .execute(
          "CREATE TABLE vault_state (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)",
          [],
        )
        .expect("create table");
      connection
        .execute(
          "INSERT INTO vault_state (key, payload) VALUES (?1, ?2)",
          params![VAULT_STATE_KEY, "{\"version\":2}"],
        )
        .expect("insert payload");
    }

    let plain = Connection::open(&path).expect("plain connection handle");
    let plain_result =
      plain.query_row("SELECT payload FROM vault_state", [], |row| row.get::<_, String>(0));
    assert!(plain_result.is_err());
    let _ = fs::remove_file(path);
  }

  #[test]
  fn plaintext_database_is_migrated_to_encrypted() {
    let dir = std::env::temp_dir().join(format!(
      "lcv-plaintext-migration-test-{}",
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("test dir");
    let path = dir.join("vault.sqlite3");
    let payload = "{\"version\":2,\"facts\":[]}";
    let key = "abcdef0123456789abcdef0123456789";

    {
      let connection = Connection::open(&path).expect("plaintext connection");
      connection
        .execute(
          "CREATE TABLE vault_state (key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)",
          [],
        )
        .expect("create plaintext vault_state");
      connection
        .execute(
          "INSERT INTO vault_state (key, payload) VALUES (?1, ?2)",
          params![VAULT_STATE_KEY, payload],
        )
        .expect("insert plaintext payload");
    }

    let read_payload = read_plaintext_payload(&path).expect("read plaintext payload");
    assert_eq!(read_payload, payload);
    migrate_plaintext_to_encrypted(&path, &read_payload, key).expect("migrate plaintext");

    let encrypted = open_sqlcipher_connection(&path, key).expect("encrypted connection");
    let encrypted_payload: String = encrypted
      .query_row(
        "SELECT payload FROM vault_state WHERE key = ?1",
        params![VAULT_STATE_KEY],
        |row| row.get(0),
      )
      .expect("read encrypted payload");
    assert_eq!(encrypted_payload, payload);

    let plain = Connection::open(&path).expect("plain connection handle");
    let plain_result =
      plain.query_row("SELECT payload FROM vault_state", [], |row| row.get::<_, String>(0));
    assert!(plain_result.is_err());
    let plaintext_backups = fs::read_dir(&dir)
      .expect("read migration dir")
      .filter_map(Result::ok)
      .filter(|entry| {
        entry
          .file_name()
          .to_str()
          .map(|name| name.contains(".plaintext-migrated-"))
          .unwrap_or(false)
      })
      .count();
    assert_eq!(plaintext_backups, 0);
    let _ = fs::remove_dir_all(dir);
  }
}
