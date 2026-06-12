use life_context_vault_lib::{
  add_passive_capture_event_at_path, purge_browser_passive_capture_source_at_path,
};
use serde_json::{json, Value};
use std::{
  env,
  io::{self, Read, Write},
  path::{Path, PathBuf},
  process::{Command, Stdio},
};

const MAX_NATIVE_MESSAGE_BYTES: usize = 1024 * 1024;
#[cfg(target_os = "macos")]
const APP_BUNDLE_IDENTIFIER: &str = "dev.life-context-vault.poc";
const CONTROL_CENTER_BINARY_NAME: &str = "life-context-vault";

fn main() {
  if let Err(error) = run() {
    let _ = write_native_message(&json!({
      "ok": false,
      "error": error
    }));
    std::process::exit(1);
  }
}

fn run() -> Result<(), String> {
  let message = read_native_message()?;
  let response = handle_message(&message)?;
  write_native_message(&response)
}

fn handle_message(message: &Value) -> Result<Value, String> {
  match get_str(message, "type") {
    "ping" => Ok(json!({ "ok": true, "status": "ready" })),
    "capture_fragment" => capture_fragment(message),
    "delete_capture_source" => delete_capture_source(message),
    "open_control_center" => open_control_center(),
    other => Err(format!("unsupported message type: {other}")),
  }
}

fn capture_fragment(message: &Value) -> Result<Value, String> {
  let text = required_str(message, "text")?;
  let url = required_str(message, "url")?;
  let source_client = optional_str(message, "sourceClient").unwrap_or("generic_mcp");
  let conversation_id = optional_str(message, "conversationId").unwrap_or("browser_unknown");
  let page_title = optional_str(message, "pageTitle").unwrap_or("AI chat capture");

  let result = add_passive_capture_event_at_path(
    &vault_db_path()?,
    source_client,
    conversation_id,
    url,
    text,
    Some(page_title),
    message.get("selected").and_then(Value::as_bool).unwrap_or(false),
  )?;

  Ok(json!({
    "ok": result.accepted,
    "status": result.status,
    "sourceId": result.source_id,
    "eventId": result.event_id,
    "candidateCount": result.candidate_ids.len(),
    "retentionUntil": result.retention_until,
    "message": result.message
  }))
}

fn delete_capture_source(message: &Value) -> Result<Value, String> {
  let source_id = required_str(message, "sourceId")?;
  let result = purge_browser_passive_capture_source_at_path(&vault_db_path()?, source_id)?;
  Ok(json!({
    "ok": true,
    "status": "source_purged",
    "action": result.action,
    "sourceId": result.source_id,
    "affectedCandidateCount": result.affected_candidate_count,
    "affectedFactCount": result.affected_fact_count,
    "invalidatedPackCount": result.invalidated_pack_count,
    "message": "Recent captured Source body was deleted from the local Vault."
  }))
}

fn open_control_center() -> Result<Value, String> {
  let launch_method = launch_control_center()?;
  Ok(json!({
    "ok": true,
    "status": "opening_control_center",
    "launchMethod": launch_method,
    "message": "Life Context Vault Control Center is opening. Review recent Capture candidates in Memory Inbox."
  }))
}

fn launch_control_center() -> Result<&'static str, String> {
  let host_path =
    env::current_exe().map_err(|error| format!("failed to resolve capture host path: {error}"))?;

  #[cfg(target_os = "macos")]
  {
    if let Some(app_bundle) = app_bundle_for_host_path(&host_path) {
      let mut command = Command::new("open");
      command.arg(app_bundle);
      spawn_detached(&mut command)?;
      return Ok("macos_app_bundle");
    }
  }

  let sibling = control_center_binary_candidate_for_host(&host_path);
  if sibling.exists() {
    let mut command = Command::new(sibling);
    spawn_detached(&mut command)?;
    return Ok("sibling_binary");
  }

  #[cfg(target_os = "macos")]
  {
    let mut command = Command::new("open");
    command.arg("-b").arg(APP_BUNDLE_IDENTIFIER);
    run_command_status(&mut command)?;
    Ok("macos_bundle_identifier")
  }

  #[cfg(not(target_os = "macos"))]
  {
    Err("Life Context Vault app binary was not found near the Capture host.".to_string())
  }
}

fn spawn_detached(command: &mut Command) -> Result<(), String> {
  command
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map(|_| ())
    .map_err(|error| format!("failed to open Life Context Vault Control Center: {error}"))
}

#[cfg(target_os = "macos")]
fn run_command_status(command: &mut Command) -> Result<(), String> {
  let status = command
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .status()
    .map_err(|error| format!("failed to open Life Context Vault Control Center: {error}"))?;
  if status.success() {
    Ok(())
  } else {
    Err("Life Context Vault app is not registered with Launch Services.".to_string())
  }
}

fn control_center_binary_candidate_for_host(host_path: &Path) -> PathBuf {
  let binary_name = if cfg!(target_os = "windows") {
    format!("{CONTROL_CENTER_BINARY_NAME}.exe")
  } else {
    CONTROL_CENTER_BINARY_NAME.to_string()
  };
  host_path
    .parent()
    .map(|parent| parent.join(&binary_name))
    .unwrap_or_else(|| PathBuf::from(&binary_name))
}

#[cfg(target_os = "macos")]
fn app_bundle_for_host_path(host_path: &Path) -> Option<PathBuf> {
  host_path
    .ancestors()
    .find(|path| path.extension().and_then(|extension| extension.to_str()) == Some("app"))
    .map(Path::to_path_buf)
}

fn read_native_message() -> Result<Value, String> {
  let mut length_bytes = [0u8; 4];
  io::stdin()
    .read_exact(&mut length_bytes)
    .map_err(|error| format!("failed to read native message length: {error}"))?;
  let length = u32::from_ne_bytes(length_bytes) as usize;
  if length > MAX_NATIVE_MESSAGE_BYTES {
    return Err("native message exceeds 1MB limit".to_string());
  }
  let mut payload = vec![0u8; length];
  io::stdin()
    .read_exact(&mut payload)
    .map_err(|error| format!("failed to read native message payload: {error}"))?;
  serde_json::from_slice::<Value>(&payload)
    .map_err(|error| format!("failed to parse native message JSON: {error}"))
}

fn write_native_message(value: &Value) -> Result<(), String> {
  let payload = value.to_string().into_bytes();
  let length = payload.len() as u32;
  let mut stdout = io::stdout();
  stdout
    .write_all(&length.to_ne_bytes())
    .map_err(|error| format!("failed to write native message length: {error}"))?;
  stdout
    .write_all(&payload)
    .map_err(|error| format!("failed to write native message payload: {error}"))?;
  stdout
    .flush()
    .map_err(|error| format!("failed to flush native message: {error}"))
}

fn vault_db_path() -> Result<PathBuf, String> {
  if let Ok(path) = env::var("LCV_VAULT_DB_PATH") {
    return Ok(PathBuf::from(path));
  }

  #[cfg(target_os = "macos")]
  {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    return Ok(PathBuf::from(home)
      .join("Library")
      .join("Application Support")
      .join("dev.life-context-vault.poc")
      .join("vault.sqlite3"));
  }

  #[cfg(target_os = "windows")]
  {
    let appdata = env::var("APPDATA").map_err(|_| "APPDATA is not set".to_string())?;
    return Ok(PathBuf::from(appdata)
      .join("dev.life-context-vault.poc")
      .join("vault.sqlite3"));
  }

  #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
  {
    let base = env::var("XDG_DATA_HOME")
      .map(PathBuf::from)
      .or_else(|_| env::var("HOME").map(|home| PathBuf::from(home).join(".local").join("share")))
      .map_err(|_| "Neither XDG_DATA_HOME nor HOME is set".to_string())?;
    Ok(base.join("dev.life-context-vault.poc").join("vault.sqlite3"))
  }
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
  value
    .get(key)
    .and_then(Value::as_str)
    .filter(|text| !text.trim().is_empty())
    .ok_or_else(|| format!("missing required string field: {key}"))
}

fn optional_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
  value.get(key).and_then(Value::as_str).filter(|text| !text.trim().is_empty())
}

fn get_str<'a>(value: &'a Value, key: &str) -> &'a str {
  value.get(key).and_then(Value::as_str).unwrap_or_default()
}

#[cfg(test)]
mod tests {
  use super::*;
  use life_context_vault_lib::update_passive_capture_settings_at_path;
  use std::sync::Mutex;

  static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

  #[test]
  fn native_message_roundtrip_uses_native_length_prefix() {
    let response = json!({ "ok": true, "candidateCount": 1 });
    let payload = response.to_string().into_bytes();
    let length = payload.len() as u32;
    assert_eq!(u32::from_ne_bytes(length.to_ne_bytes()), length);
  }

  #[test]
  fn control_center_binary_candidate_uses_sibling_app_binary() {
    let host = PathBuf::from("/tmp/Life Context Vault.app/Contents/MacOS/lcv-capture-host");
    let candidate = control_center_binary_candidate_for_host(&host);
    let expected_name = if cfg!(target_os = "windows") {
      "life-context-vault.exe"
    } else {
      "life-context-vault"
    };

    assert_eq!(
      candidate.file_name().and_then(|name| name.to_str()),
      Some(expected_name)
    );
    assert!(!candidate.display().to_string().contains("capture-host"));
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn app_bundle_is_resolved_from_bundled_capture_host_path() {
    let host = PathBuf::from(
      "/Applications/Life Context Vault.app/Contents/MacOS/lcv-capture-host",
    );
    let bundle = app_bundle_for_host_path(&host).expect("bundle path");

    assert_eq!(
      bundle,
      PathBuf::from("/Applications/Life Context Vault.app")
    );
  }

  #[test]
  fn disabled_passive_capture_refuses_capture() {
    let _guard = TEST_ENV_LOCK.lock().expect("test env lock");
    let path = env::temp_dir().join(format!(
      "lcv-capture-disabled-test-{}.sqlite3",
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos()
    ));
    env::set_var("LCV_VAULT_DB_KEY", "0123456789abcdef0123456789abcdef");
    env::set_var("LCV_VAULT_DB_PATH", &path);

    let result = capture_fragment(&json!({
      "type": "capture_fragment",
      "sourceClient": "chatgpt",
      "conversationId": "thread",
      "url": "https://chatgpt.com/c/thread",
      "text": "Tone preference: concise"
    }))
    .expect("capture response");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("capture_paused"));
    env::remove_var("LCV_VAULT_DB_PATH");
    env::remove_var("LCV_VAULT_DB_KEY");
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
  }

  #[test]
  fn delete_capture_source_purges_recent_browser_capture() {
    let _guard = TEST_ENV_LOCK.lock().expect("test env lock");
    let path = env::temp_dir().join(format!(
      "lcv-capture-delete-test-{}.sqlite3",
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos()
    ));
    env::set_var("LCV_VAULT_DB_KEY", "0123456789abcdef0123456789abcdef");
    env::set_var("LCV_VAULT_DB_PATH", &path);
    update_passive_capture_settings_at_path(
      &path,
      Some(true),
      Some(14),
      Some(vec!["chatgpt.com".to_string()]),
    )
    .expect("enable capture");

    let capture = capture_fragment(&json!({
      "type": "capture_fragment",
      "sourceClient": "chatgpt",
      "conversationId": "thread",
      "url": "https://chatgpt.com/c/thread",
      "pageTitle": "ChatGPT",
      "text": "Insurance policy renewal is due on 2027-08-31."
    }))
    .expect("capture response");
    let source_id = capture
      .get("sourceId")
      .and_then(Value::as_str)
      .expect("source id");

    let deleted = delete_capture_source(&json!({
      "type": "delete_capture_source",
      "sourceId": source_id
    }))
    .expect("delete response");

    assert_eq!(deleted.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(deleted.get("status").and_then(Value::as_str), Some("source_purged"));
    assert_eq!(deleted.get("sourceId").and_then(Value::as_str), Some(source_id));

    env::remove_var("LCV_VAULT_DB_PATH");
    env::remove_var("LCV_VAULT_DB_KEY");
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
  }
}
