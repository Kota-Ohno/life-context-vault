use chrono::{Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
  env,
  io::{self, Read, Write},
  path::PathBuf,
  time::{SystemTime, UNIX_EPOCH},
};

const VAULT_STATE_KEY: &str = "vault_state";
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

  let mut vault = load_vault()?;
  if !passive_capture_enabled(&vault) {
    return Ok(json!({
      "ok": false,
      "status": "capture_paused",
      "message": "Passive Capture is off in Life Context Vault."
    }));
  }
  if !allowed_site(&vault, url) {
    return Ok(json!({
      "ok": false,
      "status": "site_not_allowed",
      "message": "This site is not in the Passive Capture allowlist."
    }));
  }

  let captured_at = now_iso();
  let retention_days = retention_days(&vault);
  let retention_until = (Utc::now() + Duration::days(retention_days))
    .to_rfc3339_opts(SecondsFormat::Millis, true);
  let sanitized = sanitize_secret_material(text);
  let sensitivity = detect_sensitivity(text);
  let source_id = new_id("src");
  let event_id = new_id("cap");
  let candidates = extract_candidates(&source_id, &sanitized, sensitivity, &captured_at);
  let candidate_ids: Vec<Value> = candidates
    .iter()
    .map(|candidate| Value::String(get_str(candidate, "id").to_string()))
    .collect();

  let source = json!({
    "id": source_id,
    "kind": "passive_capture",
    "title": format!("{} - {}", client_label(source_client), page_title),
    "origin": "passive_browser",
    "body": sanitized,
    "createdAt": captured_at,
    "capturedAt": captured_at,
    "retentionUntil": retention_until,
    "promotedToLongTerm": false,
    "defaultSensitivity": sensitivity,
    "processingStatus": "ready",
    "deletionState": "active"
  });
  let event = json!({
    "id": event_id,
    "sourceClient": source_client,
    "conversationId": conversation_id,
    "urlHash": stable_hash(url),
    "textFragmentRef": format!("{source_id}:body"),
    "capturedAt": captured_at,
    "retentionUntil": retention_until,
    "sensitivityGuess": sensitivity,
    "processingStatus": if candidates.is_empty() { "ignored" } else { "candidate_generated" },
    "sourceId": source_id,
    "candidateIds": candidate_ids
  });

  push_array(&mut vault, "sources", source);
  for candidate in candidates {
    push_array(&mut vault, "candidates", candidate);
  }
  push_array(&mut vault, "passiveCaptureEvents", event);
  audit(
    &mut vault,
    "passive_capture_recorded",
    "passive_capture_event",
    &event_id,
    sensitivity,
    json!({
      "sourceClient": source_client,
      "conversationId": conversation_id,
      "selected": message.get("selected").and_then(Value::as_bool).unwrap_or(false)
    }),
  );
  save_vault(&vault)?;

  Ok(json!({
    "ok": true,
    "status": "candidate_generated",
    "sourceId": source_id,
    "eventId": event_id,
    "candidateCount": candidate_ids.len(),
    "retentionUntil": retention_until,
    "message": "Captured text was added to Memory Inbox as unapproved candidate(s)."
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

fn extract_candidates(source_id: &str, text: &str, sensitivity: &'static str, created_at: &str) -> Vec<Value> {
  let mut candidates = Vec::new();
  for line in text
    .split(['\n', '。'])
    .map(normalized)
    .filter(|line| !line.is_empty())
    .take(8)
  {
    let line_sensitivity = detect_sensitivity(&line);
    if line_sensitivity == "secret_never_send" {
      continue;
    }
    if candidate_signal(&line) || candidates.is_empty() {
      candidates.push(json!({
        "id": new_id("cand"),
        "sourceIds": [source_id],
        "sourceChunkIds": [],
        "proposedFactText": line,
        "domain": classify_domain(&line),
        "candidateType": candidate_type(&line),
        "detectedSensitivity": if sensitivity_rank(line_sensitivity) > sensitivity_rank(sensitivity) { line_sensitivity } else { sensitivity },
        "confidence": "medium",
        "reasonToRemember": "ブラウザ拡張から取得したAI会話断片です。承認されるまでAIの確定文脈には使われません。",
        "status": if line_sensitivity == "sensitive" || sensitivity == "sensitive" { "blocked_sensitive" } else { "new" },
        "createdAt": created_at,
        "createsFactIds": []
      }));
    }
  }
  candidates
}

fn load_vault() -> Result<Value, String> {
  let path = vault_db_path()?;
  if !path.exists() {
    return Ok(empty_vault());
  }
  let connection =
    Connection::open(&path).map_err(|error| format!("failed to open vault database: {error}"))?;
  ensure_vault_state_table(&connection)?;
  let payload: Option<String> = connection
    .query_row(
      "SELECT payload FROM vault_state WHERE key = ?1",
      params![VAULT_STATE_KEY],
      |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("failed to load vault state: {error}"))?;
  Ok(payload
    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    .unwrap_or_else(empty_vault))
}

fn save_vault(vault: &Value) -> Result<(), String> {
  let path = vault_db_path()?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|error| format!("failed to create vault directory: {error}"))?;
  }
  let connection =
    Connection::open(&path).map_err(|error| format!("failed to open vault database: {error}"))?;
  ensure_vault_state_table(&connection)?;
  connection
    .execute(
      "INSERT INTO vault_state (key, payload, updated_at)
       VALUES (?1, ?2, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         payload = excluded.payload,
         updated_at = CURRENT_TIMESTAMP",
      params![VAULT_STATE_KEY, vault.to_string()],
    )
    .map_err(|error| format!("failed to save vault state: {error}"))?;
  Ok(())
}

fn ensure_vault_state_table(connection: &Connection) -> Result<(), String> {
  connection
    .execute(
      "CREATE TABLE IF NOT EXISTS vault_state (
        key TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )",
      [],
    )
    .map_err(|error| format!("failed to initialize vault_state: {error}"))?;
  Ok(())
}

fn empty_vault() -> Value {
  json!({
    "version": 2,
    "sources": [],
    "candidates": [],
    "facts": [],
    "accessPolicies": [],
    "passiveCaptureSettings": {
      "enabled": false,
      "retentionDays": 14,
      "allowedSites": ["chat.openai.com", "chatgpt.com", "claude.ai", "gemini.google.com"]
    },
    "passiveCaptureEvents": [],
    "connectorSessions": [],
    "contextPackRequests": [],
    "contextPacks": [],
    "auditEvents": []
  })
}

fn passive_capture_enabled(vault: &Value) -> bool {
  vault
    .get("passiveCaptureSettings")
    .and_then(|settings| settings.get("enabled"))
    .and_then(Value::as_bool)
    .unwrap_or(false)
}

fn retention_days(vault: &Value) -> i64 {
  vault
    .get("passiveCaptureSettings")
    .and_then(|settings| settings.get("retentionDays"))
    .and_then(Value::as_i64)
    .unwrap_or(14)
    .clamp(1, 90)
}

fn allowed_site(vault: &Value, url: &str) -> bool {
  let host = host_from_url(url);
  let Some(host) = host else {
    return false;
  };
  vault
    .get("passiveCaptureSettings")
    .and_then(|settings| settings.get("allowedSites"))
    .and_then(Value::as_array)
    .map(|sites| {
      sites
        .iter()
        .filter_map(Value::as_str)
        .any(|site| host == site || host.ends_with(&format!(".{site}")))
    })
    .unwrap_or(false)
}

fn host_from_url(url: &str) -> Option<String> {
  let without_scheme = url.split("://").nth(1).unwrap_or(url);
  without_scheme
    .split('/')
    .next()
    .map(|host| host.split(':').next().unwrap_or(host).to_lowercase())
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

fn audit(
  vault: &mut Value,
  event_type: &str,
  subject_type: &str,
  subject_id: &str,
  sensitivity: &str,
  metadata: Value,
) {
  push_array(
    vault,
    "auditEvents",
    json!({
      "id": new_id("audit"),
      "eventType": event_type,
      "actor": "connector",
      "subjectType": subject_type,
      "subjectId": subject_id,
      "occurredAt": now_iso(),
      "sensitivity": sensitivity,
      "metadata": metadata
    }),
  );
}

fn push_array(value: &mut Value, key: &str, item: Value) {
  if !value.get(key).map(Value::is_array).unwrap_or(false) {
    value[key] = json!([]);
  }
  if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
    items.insert(0, item);
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

fn classify_domain(text: &str) -> &'static str {
  let lower = text.to_lowercase();
  if contains_any(&lower, &["health", "medical", "doctor", "disability", "care", "病院", "健康", "障害", "介護"]) {
    "health_and_care"
  } else if contains_any(&lower, &["finance", "benefit", "pension", "tax", "bank", "payment", "money", "給付", "年金", "税", "銀行", "支払"]) {
    "finance_and_benefits"
  } else if contains_any(&lower, &["work", "job", "school", "employer", "student", "勤務", "仕事", "学校", "転職", "職場"]) {
    "work_and_education"
  } else if contains_any(&lower, &["family", "partner", "child", "household", "家族", "配偶者", "子ども", "世帯"]) {
    "relationships_and_household"
  } else if contains_any(&lower, &["home", "address", "lease", "rent", "utility", "housing", "住所", "住居", "賃貸", "家"]) {
    "home_and_places"
  } else if contains_any(&lower, &["contract", "policy", "insurance", "warranty", "契約", "保険", "保証"]) {
    "contracts_and_policies"
  } else if contains_any(&lower, &["deadline", "submit", "renew", "procedure", "form", "期限", "提出", "更新", "手続"]) {
    "procedures_and_obligations"
  } else if contains_any(&lower, &["goal", "priority", "preference", "tone", "目標", "優先", "好み", "口調"]) {
    "values_goals_and_preferences"
  } else if contains_any(&lower, &["routine", "schedule", "habit", "commute", "予定", "習慣", "通勤"]) {
    "routines_and_logistics"
  } else if contains_any(&lower, &["move", "moving", "travel", "plan", "引っ越", "旅行", "予定", "計画"]) {
    "life_events_and_plans"
  } else {
    "documents_and_evidence"
  }
}

fn candidate_type(text: &str) -> &'static str {
  let lower = text.to_lowercase();
  if contains_any(&lower, &["deadline", "due", "renew", "expires", "期限", "締切", "更新"]) {
    "deadline"
  } else if contains_any(&lower, &["must", "need to", "required", "submit", "notify", "必要", "提出", "連絡"]) {
    "obligation"
  } else if contains_any(&lower, &["tone", "preference", "好み", "口調"]) {
    "preference"
  } else if contains_any(&lower, &["goal", "priority", "目標", "優先"]) {
    "goal"
  } else if contains_any(&lower, &["moving", "move", "job change", "travel", "引っ越", "転職", "旅行"]) {
    "life_event"
  } else {
    "note"
  }
}

fn detect_sensitivity(text: &str) -> &'static str {
  let lower = text.to_lowercase();
  if contains_any(&lower, &["password", "passcode", "api key", "token", "secret", "private key", "recovery code", "パスワード", "秘密鍵", "my number", "national id", "bank account", "口座番号", "マイナンバー"]) {
    "secret_never_send"
  } else if contains_any(&lower, &["health", "medical", "doctor", "diagnosis", "disability", "benefit", "legal", "minor", "病院", "診断", "障害", "給付", "法律", "未成年"]) {
    "sensitive"
  } else if contains_any(&lower, &["finance", "tax", "pension", "insurance", "contract", "rent", "salary", "payment", "税", "年金", "保険", "契約", "家賃", "給与", "支払"]) {
    "private_consequential"
  } else if contains_any(&lower, &["name", "address", "phone", "email", "family", "名前", "住所", "電話", "メール", "家族"]) {
    "personal"
  } else {
    "public"
  }
}

fn candidate_signal(text: &str) -> bool {
  let lower = text.to_lowercase();
  contains_any(
    &lower,
    &[
      "preference", "tone", "goal", "need", "must", "deadline", "renew", "moving", "address",
      "好み", "口調", "目標", "必要", "期限", "更新", "引っ越", "住所"
    ],
  )
}

fn sensitivity_rank(sensitivity: &str) -> i64 {
  match sensitivity {
    "public" => 0,
    "personal" => 1,
    "private_consequential" => 2,
    "sensitive" => 3,
    "secret_never_send" => 4,
    _ => 4,
  }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
  needles.iter().any(|needle| text.contains(needle))
}

fn sanitize_secret_material(text: &str) -> String {
  text
    .split_whitespace()
    .map(|token| {
      let lower = token.to_lowercase();
      if lower.contains("password")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("パスワード")
        || lower.contains("秘密鍵")
      {
        "[REDACTED_SECRET]".to_string()
      } else {
        token.to_string()
      }
    })
    .collect::<Vec<String>>()
    .join(" ")
}

fn normalized(text: &str) -> String {
  text.split_whitespace().collect::<Vec<&str>>().join(" ")
}

fn stable_hash(text: &str) -> String {
  let mut hash = 2166136261u32;
  for byte in text.as_bytes() {
    hash ^= u32::from(*byte);
    hash = hash.wrapping_mul(16777619);
  }
  format!("hash_{hash:x}")
}

fn client_label(client: &str) -> &'static str {
  match client {
    "chatgpt" => "ChatGPT",
    "claude_remote" => "Claude",
    "gemini" => "Gemini",
    "codex" => "Codex",
    _ => "AI chat",
  }
}

fn new_id(prefix: &str) -> String {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or_default();
  format!("{prefix}_{nanos}")
}

fn now_iso() -> String {
  Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
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
  fn allowed_site_matches_configured_hosts_only() {
    let vault = empty_vault();
    assert!(allowed_site(&vault, "https://chatgpt.com/c/123"));
    assert!(allowed_site(&vault, "https://claude.ai/chat/123"));
    assert!(!allowed_site(&vault, "https://example.com/chat/123"));
  }

  #[test]
  fn disabled_passive_capture_refuses_capture() {
    let result = capture_fragment(&json!({
      "type": "capture_fragment",
      "sourceClient": "chatgpt",
      "conversationId": "thread",
      "url": "https://chatgpt.com/c/thread",
      "text": "Tone preference: concise"
    }))
    .expect("capture response");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("capture_paused"));
  }
}
