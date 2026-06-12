use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
  env,
  io::{self, BufRead, Write},
  path::{Path, PathBuf},
  time::{SystemTime, UNIX_EPOCH},
};
use chrono::{SecondsFormat, Utc};
use life_context_vault_lib::create_context_pack_request_at_path;

#[path = "../vault_crypto.rs"]
mod vault_crypto;

const PROTOCOL_VERSION: &str = "2025-06-18";
const VAULT_STATE_KEY: &str = "vault_state";

fn main() {
  let stdin = io::stdin();
  let mut stdout = io::stdout();

  for line in stdin.lock().lines() {
    let Ok(line) = line else {
      continue;
    };
    if line.trim().is_empty() {
      continue;
    }

    let response = match serde_json::from_str::<Value>(&line) {
      Ok(message) => handle_message(&message),
      Err(error) => Some(json!({
        "jsonrpc": "2.0",
        "id": Value::Null,
        "error": {
          "code": -32700,
          "message": format!("Parse error: {error}")
        }
      })),
    };

    if let Some(response) = response {
      if writeln!(stdout, "{response}").is_err() {
        break;
      }
      let _ = stdout.flush();
    }
  }
}

fn handle_message(message: &Value) -> Option<Value> {
  let id = message.get("id").cloned();
  let method = message.get("method").and_then(Value::as_str).unwrap_or_default();

  if id.is_none() {
    return None;
  }

  let id = id.unwrap_or(Value::Null);
  let result = match method {
    "initialize" => Ok(json!({
      "protocolVersion": PROTOCOL_VERSION,
      "capabilities": {
        "tools": {
          "listChanged": false
        }
      },
      "serverInfo": {
        "name": "life-context-vault",
        "title": "Life Context Vault",
        "version": env!("CARGO_PKG_VERSION")
      }
    })),
    "tools/list" => Ok(json!({ "tools": tools() })),
    "tools/call" => {
      let params = message.get("params").unwrap_or(&Value::Null);
      let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
      let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
      call_tool(name, &arguments)
    }
    _ => Err((-32601, format!("Method not found: {method}"))),
  };

  Some(match result {
    Ok(result) => json!({
      "jsonrpc": "2.0",
      "id": id,
      "result": result
    }),
    Err((code, message)) => json!({
      "jsonrpc": "2.0",
      "id": id,
      "error": {
        "code": code,
        "message": message
      }
    }),
  })
}

fn tools() -> Value {
  json!([
    {
      "name": "life_context.request_context_pack",
      "title": "Request Life Context Pack",
      "description": "Request a short-lived, policy-filtered Context Pack. Sensitive packs are queued for user confirmation instead of returned directly.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "taskText": {
            "type": "string",
            "description": "The user task or question that needs life context."
          },
          "clientName": {
            "type": "string",
            "description": "Display name of the AI client requesting context."
          },
          "sensitivityCeiling": {
            "type": "string",
            "enum": ["public", "personal", "private_consequential", "sensitive"],
            "description": "Highest sensitivity tier the caller may receive."
          }
        },
        "required": ["taskText"]
      }
    },
    {
      "name": "life_context.propose_memory",
      "title": "Propose Memory",
      "description": "Create an unapproved Memory Inbox candidate from the current conversation. This never creates an ApprovedFact.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "description": "Conversation excerpt or note to propose for the user's Memory Inbox."
          },
          "clientName": {
            "type": "string",
            "description": "Display name of the proposing AI client."
          }
        },
        "required": ["text"]
      }
    },
    {
      "name": "life_context.get_policy_summary",
      "title": "Get Policy Summary",
      "description": "Return the configured connector and policy summary without exposing raw Vault contents.",
      "inputSchema": {
        "type": "object",
        "properties": {}
      }
    },
    {
      "name": "life_context.get_request_status",
      "title": "Get Context Request Status",
      "description": "Check whether a queued Context Pack request has been confirmed, denied, expired, or is still pending.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string",
            "description": "ContextPackRequest id returned by request_context_pack."
          }
        },
        "required": ["requestId"]
      }
    }
  ])
}

fn call_tool(name: &str, arguments: &Value) -> Result<Value, (i64, String)> {
  let mut vault = load_vault().map_err(|error| (-32000, error))?;
  let result = match name {
    "life_context.request_context_pack" => request_context_pack(arguments),
    "life_context.propose_memory" => propose_memory(&mut vault, arguments),
    "life_context.get_policy_summary" => get_policy_summary(&vault),
    "life_context.get_request_status" => get_request_status(&vault, arguments),
    _ => Err((-32602, format!("Unknown tool: {name}"))),
  }?;

  if result.get("mutated").and_then(Value::as_bool).unwrap_or(false) {
    save_vault(&vault).map_err(|error| (-32000, error))?;
  }

  Ok(tool_result(result))
}

fn request_context_pack(arguments: &Value) -> Result<Value, (i64, String)> {
  let path = vault_db_path().map_err(|error| (-32000, error))?;
  request_context_pack_at_path(&path, arguments)
}

fn request_context_pack_at_path(path: &Path, arguments: &Value) -> Result<Value, (i64, String)> {
  let task_text = required_str(arguments, "taskText")?;
  let client_name = optional_str(arguments, "clientName").unwrap_or("Local MCP Client");
  let ceiling = optional_str(arguments, "sensitivityCeiling").unwrap_or("private_consequential");
  let result = create_context_pack_request_at_path(
    path,
    "conn_local_mcp",
    client_name,
    task_text,
    Some("MCP client requested life context"),
    Some(ceiling),
    Some("explicit_sensitive"),
  )
  .map_err(|error| (-32000, error))?;

  if result.context_pack.is_none() {
    Ok(json!({
      "mutated": false,
      "status": result.request_status,
      "requestId": result.request_id,
      "expiresAt": result.expires_at,
      "maxSensitivityIncluded": result.max_sensitivity_included,
      "message": "Context Pack was created but not returned because it requires user confirmation in Life Context Vault.",
      "nextAction": "Open Life Context Vault > Context Requests, confirm or deny the request, then call life_context.get_request_status."
    }))
  } else {
    Ok(json!({
      "mutated": false,
      "status": result.request_status,
      "requestId": result.request_id,
      "contextPack": result.context_pack,
      "message": "Context Pack is low sensitivity and can be used for this answer."
    }))
  }
}

fn propose_memory(vault: &mut Value, arguments: &Value) -> Result<Value, (i64, String)> {
  let text = required_str(arguments, "text")?;
  let client_name = optional_str(arguments, "clientName").unwrap_or("Local MCP Client");
  let source_id = new_id("src");
  let candidate_id = new_id("cand");
  let now = now_iso();
  let sensitivity = detect_sensitivity(text);
  let sanitized = sanitize_secret_material(text);
  let source = json!({
    "id": source_id,
    "kind": "mcp_proposal",
    "title": format!("{client_name} memory proposal"),
    "origin": "local_mcp",
    "body": sanitized,
    "createdAt": now,
    "capturedAt": now,
    "defaultSensitivity": sensitivity,
    "processingStatus": "ready",
    "deletionState": "active"
  });
  let candidate = json!({
    "id": candidate_id,
    "sourceIds": [source_id],
    "sourceChunkIds": [],
    "proposedFactText": normalized(&sanitized),
    "domain": classify_domain(text),
    "candidateType": candidate_type(text),
    "detectedSensitivity": sensitivity,
    "confidence": "medium",
    "reasonToRemember": "MCPクライアントから提案された生活文脈候補です。承認されるまでAIの確定文脈には使われません。",
    "status": if sensitivity == "sensitive" { "blocked_sensitive" } else { "new" },
    "createdAt": now,
    "createsFactIds": []
  });

  push_array(vault, "sources", source);
  push_array(vault, "candidates", candidate);
  audit(
    vault,
    "memory_proposed",
    "candidate",
    &candidate_id,
    sensitivity,
    json!({ "clientName": client_name, "transport": "local_mcp" }),
  );

  Ok(json!({
    "mutated": true,
    "status": "candidate_created",
    "candidateId": candidate_id,
    "sourceId": source_id,
    "detectedSensitivity": sensitivity,
    "message": "Memory proposal was added to the Inbox. It is not an ApprovedFact."
  }))
}

fn get_policy_summary(vault: &Value) -> Result<Value, (i64, String)> {
  Ok(json!({
    "mutated": false,
    "status": "ok",
    "summary": {
      "trustBoundary": "ContextPack only. Raw Vault and unapproved MemoryCandidate records are not exposed as trusted context.",
      "confirmationRule": "private_consequential and sensitive Context Packs are queued for user confirmation.",
      "tools": ["life_context.request_context_pack", "life_context.propose_memory", "life_context.get_policy_summary", "life_context.get_request_status"],
      "connectorSessions": vault.get("connectorSessions").cloned().unwrap_or_else(|| json!([])),
      "accessPolicies": vault.get("accessPolicies").cloned().unwrap_or_else(|| json!([]))
    }
  }))
}

fn get_request_status(vault: &Value, arguments: &Value) -> Result<Value, (i64, String)> {
  let request_id = required_str(arguments, "requestId")?;
  let request = array(vault, "contextPackRequests")
    .iter()
    .find(|request| get_str(request, "id") == request_id)
    .cloned();
  let Some(request) = request else {
    return Ok(json!({
      "mutated": false,
      "status": "not_found",
      "requestId": request_id,
      "message": "No ContextPackRequest was found for this id."
    }));
  };
  let pack = array(vault, "contextPacks")
    .iter()
    .find(|pack| get_str(pack, "requestId") == request_id)
    .cloned();
  let confirmed = pack
    .as_ref()
    .map(|pack| get_str(pack, "confirmationStatus") == "confirmed")
    .unwrap_or(false)
    || get_str(&request, "status") == "fulfilled";

  if confirmed {
    Ok(json!({
      "mutated": false,
      "status": "fulfilled",
      "requestId": request_id,
      "contextPack": pack.as_ref().map(safe_pack_for_client),
      "message": "The Context Pack has been confirmed and can be used for this answer."
    }))
  } else {
    Ok(json!({
      "mutated": false,
      "status": get_str(&request, "status"),
      "requestId": request_id,
      "expiresAt": get_str(&request, "expiresAt"),
      "message": "The request is not yet fulfilled."
    }))
  }
}

fn tool_result(result: Value) -> Value {
  let text = result
    .get("message")
    .and_then(Value::as_str)
    .unwrap_or("Life Context Vault tool completed.");
  json!({
    "content": [
      {
        "type": "text",
        "text": text
      }
    ],
    "structuredContent": result,
    "isError": false
  })
}

fn load_vault() -> Result<Value, String> {
  let path = vault_db_path()?;
  if !path.exists() {
    return Ok(empty_vault());
  }
  let connection = vault_crypto::open_encrypted_vault_connection(&path)?;
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
  let connection = vault_crypto::open_encrypted_vault_connection(&path)?;
  ensure_vault_state_table(&connection)?;
  connection
    .execute(
      "INSERT INTO vault_state (key, payload, updated_at)
       VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         payload = excluded.payload,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
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
  ensure_vault_state_updated_at_column(connection)?;
  Ok(())
}

fn ensure_vault_state_updated_at_column(connection: &Connection) -> Result<(), String> {
  let mut statement = connection
    .prepare("PRAGMA table_info(vault_state)")
    .map_err(|error| format!("failed to inspect vault_state schema: {error}"))?;
  let columns = statement
    .query_map([], |row| row.get::<_, String>(1))
    .map_err(|error| format!("failed to read vault_state schema: {error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("failed to collect vault_state schema: {error}"))?;
  if !columns.iter().any(|column| column == "updated_at") {
    connection
      .execute("ALTER TABLE vault_state ADD COLUMN updated_at TEXT", [])
      .map_err(|error| format!("failed to add vault_state updated_at: {error}"))?;
  }
  connection
    .execute(
      "UPDATE vault_state
       SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE updated_at IS NULL OR updated_at = ''",
      [],
    )
    .map_err(|error| format!("failed to backfill vault_state updated_at: {error}"))?;
  Ok(())
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

fn safe_pack_for_client(pack: &Value) -> Value {
  json!({
    "trustBoundary": "ContextPack only",
    "id": get_str(pack, "id"),
    "requestId": optional_value(pack, "requestId"),
    "taskText": get_str(pack, "taskText"),
    "taskDomain": get_str(pack, "taskDomain"),
    "generatedAt": get_str(pack, "generatedAt"),
    "expiresAt": optional_value(pack, "expiresAt"),
    "maxSensitivityIncluded": get_str(pack, "maxSensitivityIncluded"),
    "items": pack.get("items").cloned().unwrap_or_else(|| json!([])),
    "sourceSnippets": pack.get("sourceSnippets").cloned().unwrap_or_else(|| json!([])),
    "warnings": pack.get("warnings").cloned().unwrap_or_else(|| json!([])),
    "excludedItems": pack.get("excludedItems").cloned().unwrap_or_else(|| json!([])),
    "confirmationStatus": get_str(pack, "confirmationStatus")
  })
}

fn audit(
  vault: &mut Value,
  event_type: &str,
  subject_type: &str,
  subject_id: &str,
  sensitivity: &str,
  metadata: Value,
) {
  let event = json!({
    "id": new_id("audit"),
    "eventType": event_type,
    "actor": "connector",
    "subjectType": subject_type,
    "subjectId": subject_id,
    "occurredAt": now_iso(),
    "sensitivity": sensitivity,
    "metadata": metadata
  });
  push_array(vault, "auditEvents", event);
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, (i64, String)> {
  value
    .get(key)
    .and_then(Value::as_str)
    .filter(|text| !text.trim().is_empty())
    .ok_or_else(|| (-32602, format!("Missing required string argument: {key}")))
}

fn optional_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
  value.get(key).and_then(Value::as_str).filter(|text| !text.trim().is_empty())
}

fn array(value: &Value, key: &str) -> Vec<Value> {
  value
    .get(key)
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
}

fn push_array(value: &mut Value, key: &str, item: Value) {
  if !value.get(key).map(Value::is_array).unwrap_or(false) {
    value[key] = json!([]);
  }
  if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
    items.insert(0, item);
  }
}

fn get_str<'a>(value: &'a Value, key: &str) -> &'a str {
  value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn optional_value(value: &Value, key: &str) -> Value {
  value.get(key).cloned().unwrap_or(Value::Null)
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

fn contains_any(text: &str, needles: &[&str]) -> bool {
  needles.iter().any(|needle| text.contains(needle))
}

fn sanitize_secret_material(text: &str) -> String {
  let mut sanitized = Vec::new();
  for token in text.split_whitespace() {
    let lower = token.to_lowercase();
    if lower.contains("password")
      || lower.contains("token")
      || lower.contains("secret")
      || lower.contains("api_key")
      || lower.contains("apikey")
      || lower.contains("パスワード")
      || lower.contains("秘密鍵")
    {
      sanitized.push("[REDACTED_SECRET]".to_string());
    } else {
      sanitized.push(token.to_string());
    }
  }
  sanitized.join(" ")
}

fn normalized(text: &str) -> String {
  text.split_whitespace().collect::<Vec<&str>>().join(" ")
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

  fn test_vault_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|duration| duration.as_nanos())
      .unwrap_or_default();
    env::temp_dir().join(format!("life-context-vault-{name}-{nanos}.sqlite3"))
  }

  fn write_test_vault(path: &Path, vault: &Value) {
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent).expect("test vault directory");
    }
    let connection = vault_crypto::open_encrypted_vault_connection(path).expect("encrypted test vault");
    ensure_vault_state_table(&connection).expect("vault_state table");
    connection
      .execute(
        "INSERT INTO vault_state (key, payload, updated_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO UPDATE SET
           payload = excluded.payload,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![VAULT_STATE_KEY, vault.to_string()],
      )
      .expect("write test vault");
  }

  #[test]
  fn sensitive_context_pack_is_queued_without_returning_items_directly() {
    let path = test_vault_path("sensitive-context-pack");
    let mut vault = empty_vault();
    push_array(
      &mut vault,
      "facts",
      json!({
        "id": "fact_insurance",
        "factText": "Insurance policy renews on 2026-09-01.",
        "domain": "contracts_and_policies",
        "factType": "deadline",
        "sourceIds": [],
        "sensitivity": "private_consequential",
        "confidence": "source_backed",
        "status": "active",
        "createdAt": "2026-06-12T00:00:00.000Z",
        "approvedAt": "2026-06-12T00:00:00.000Z",
        "updatedAt": "2026-06-12T00:00:00.000Z"
      }),
    );
    write_test_vault(&path, &vault);

    let result = request_context_pack_at_path(
      &path,
      &json!({
        "taskText": "What should I check before changing jobs?",
        "clientName": "Claude Desktop"
      }),
    )
    .expect("request context pack");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("pending_user_confirmation"));
    assert!(result.get("contextPack").is_none());
    let saved = {
      let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open saved vault");
      ensure_vault_state_table(&connection).expect("vault_state table");
      let payload: String = connection
        .query_row(
          "SELECT payload FROM vault_state WHERE key = ?1",
          params![VAULT_STATE_KEY],
          |row| row.get(0),
        )
        .expect("saved payload");
      serde_json::from_str::<Value>(&payload).expect("saved json")
    };
    assert_eq!(array(&saved, "contextPackRequests").len(), 1);
    assert_eq!(array(&saved, "contextPacks").len(), 1);
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn low_risk_context_pack_returns_core_pack_without_raw_source_body() {
    let path = test_vault_path("low-risk-context-pack");
    let mut vault = empty_vault();
    push_array(
      &mut vault,
      "sources",
      json!({
        "id": "src_tone",
        "kind": "manual_note",
        "title": "Tone note",
        "origin": "manual_entry",
        "body": "RAW_SOURCE_BODY should stay local.",
        "createdAt": "2026-06-12T00:00:00.000Z",
        "capturedAt": "2026-06-12T00:00:00.000Z",
        "defaultSensitivity": "personal",
        "processingStatus": "ready",
        "deletionState": "active"
      }),
    );
    push_array(
      &mut vault,
      "facts",
      json!({
        "id": "fact_tone",
        "factText": "Tone preference is concise and calm.",
        "domain": "values_goals_and_preferences",
        "factType": "preference",
        "sourceIds": ["src_tone"],
        "sensitivity": "personal",
        "confidence": "source_backed",
        "status": "active",
        "createdAt": "2026-06-12T00:00:00.000Z",
        "approvedAt": "2026-06-12T00:00:00.000Z",
        "updatedAt": "2026-06-12T00:00:00.000Z"
      }),
    );
    write_test_vault(&path, &vault);

    let result = request_context_pack_at_path(
      &path,
      &json!({
        "taskText": "Draft this message in my preferred tone.",
        "clientName": "Claude Desktop",
        "sensitivityCeiling": "personal"
      }),
    )
    .expect("request context pack");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("fulfilled"));
    let pack = result.get("contextPack").expect("returned pack");
    assert_eq!(
      pack.get("trustBoundary").and_then(Value::as_str),
      Some("ContextPack only")
    );
    let snippets = pack
      .get("sourceSnippets")
      .and_then(Value::as_array)
      .expect("source snippets");
    assert_eq!(snippets.len(), 1);
    assert_eq!(
      snippets[0].get("text").and_then(Value::as_str),
      Some("Tone preference is concise and calm.")
    );
    assert!(
      !snippets[0]
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .contains("RAW_SOURCE_BODY")
    );
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn memory_proposal_creates_candidate_not_fact() {
    let mut vault = empty_vault();

    let result = propose_memory(
      &mut vault,
      &json!({
        "text": "Tone preference: concise and calm",
        "clientName": "Codex"
      }),
    )
    .expect("propose memory");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("candidate_created"));
    assert_eq!(array(&vault, "candidates").len(), 1);
    assert_eq!(array(&vault, "facts").len(), 0);
  }

  #[test]
  fn safe_pack_for_client_declares_context_pack_boundary() {
    let pack = json!({
      "id": "pack_1",
      "requestId": "req_1",
      "taskText": "Help me plan",
      "taskDomain": "life_events_and_plans",
      "generatedAt": "2026-06-12T00:00:00.000Z",
      "expiresAt": "2026-06-12T00:10:00.000Z",
      "maxSensitivityIncluded": "personal",
      "items": [],
      "sourceSnippets": [],
      "warnings": [],
      "excludedItems": [],
      "confirmationStatus": "confirmed",
      "localAnswer": "internal-only answer",
      "auditEventId": "audit_1"
    });

    let safe = safe_pack_for_client(&pack);

    assert_eq!(
      safe.get("trustBoundary").and_then(Value::as_str),
      Some("ContextPack only")
    );
    assert!(safe.get("sourceSnippets").is_some());
    assert!(safe.get("localAnswer").is_none());
    assert!(safe.get("auditEventId").is_none());
  }
}
