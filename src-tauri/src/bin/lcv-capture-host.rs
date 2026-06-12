use life_context_vault_lib::add_passive_capture_event_at_path;
use serde_json::{json, Value};
use std::{
  env,
  io::{self, Read, Write},
  path::PathBuf,
};

const MAX_NATIVE_MESSAGE_BYTES: usize = 1024 * 1024;

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

  #[test]
  fn native_message_roundtrip_uses_native_length_prefix() {
    let response = json!({ "ok": true, "candidateCount": 1 });
    let payload = response.to_string().into_bytes();
    let length = payload.len() as u32;
    assert_eq!(u32::from_ne_bytes(length.to_ne_bytes()), length);
  }

  #[test]
  fn disabled_passive_capture_refuses_capture() {
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
}
