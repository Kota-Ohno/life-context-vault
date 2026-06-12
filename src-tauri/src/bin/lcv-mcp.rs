use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
  env,
  io::{self, BufRead, Write},
  path::{Path, PathBuf},
};
use life_context_vault_lib::{
  create_context_pack_request_at_path, get_context_request_status_for_client_at_path,
  propose_memory_at_path,
};

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
  let client_id = effective_client_id();
  let result = match name {
    "life_context.request_context_pack" => request_context_pack(arguments, &client_id),
    "life_context.propose_memory" => propose_memory(arguments, &client_id),
    "life_context.get_policy_summary" => {
      let vault = load_vault().map_err(|error| (-32000, error))?;
      get_policy_summary(&vault, &client_id)
    }
    "life_context.get_request_status" => get_request_status(arguments, &client_id),
    _ => Err((-32602, format!("Unknown tool: {name}"))),
  }?;

  Ok(tool_result(result))
}

fn request_context_pack(arguments: &Value, client_id: &str) -> Result<Value, (i64, String)> {
  let path = vault_db_path().map_err(|error| (-32000, error))?;
  request_context_pack_at_path(&path, arguments, client_id)
}

fn request_context_pack_at_path(
  path: &Path,
  arguments: &Value,
  client_id: &str,
) -> Result<Value, (i64, String)> {
  let task_text = required_str(arguments, "taskText")?;
  let client_name = optional_str(arguments, "clientName").unwrap_or("Local MCP Client");
  let ceiling = optional_str(arguments, "sensitivityCeiling");
  let result = create_context_pack_request_at_path(
    path,
    client_id,
    client_name,
    task_text,
    Some("MCP client requested life context"),
    ceiling,
    Some("always_review"),
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

fn propose_memory(arguments: &Value, client_id: &str) -> Result<Value, (i64, String)> {
  let path = vault_db_path().map_err(|error| (-32000, error))?;
  propose_memory_at_path_for_mcp(&path, arguments, client_id)
}

fn propose_memory_at_path_for_mcp(
  path: &Path,
  arguments: &Value,
  client_id: &str,
) -> Result<Value, (i64, String)> {
  let text = required_str(arguments, "text")?;
  let client_name = optional_str(arguments, "clientName").unwrap_or("Local MCP Client");
  let result = propose_memory_at_path(path, client_id, client_name, "local_mcp", text)
    .map_err(|error| (-32000, error))?;

  Ok(json!({
    "mutated": false,
    "status": result.status,
    "candidateId": result.candidate_id,
    "sourceId": result.source_id,
    "detectedSensitivity": result.detected_sensitivity,
    "message": "Memory proposal was added to the Inbox. It is not an ApprovedFact."
  }))
}

fn get_policy_summary(vault: &Value, client_id: &str) -> Result<Value, (i64, String)> {
  let policy = effective_policy_summary(vault, client_id);
  Ok(json!({
    "mutated": false,
    "status": "ok",
    "summary": {
      "trustBoundary": "ContextPack only. Raw Vault and unapproved MemoryCandidate records are not exposed as trusted context.",
      "confirmationRule": "Context Packs above the calling client's approval threshold are queued for user confirmation.",
      "tools": ["life_context.request_context_pack", "life_context.propose_memory", "life_context.get_policy_summary", "life_context.get_request_status"],
      "clientId": client_id,
      "effectivePolicy": policy
    }
  }))
}

fn get_request_status(arguments: &Value, client_id: &str) -> Result<Value, (i64, String)> {
  let path = vault_db_path().map_err(|error| (-32000, error))?;
  get_request_status_at_path_for_mcp(&path, arguments, client_id)
}

fn get_request_status_at_path_for_mcp(
  path: &Path,
  arguments: &Value,
  client_id: &str,
) -> Result<Value, (i64, String)> {
  let request_id = required_str(arguments, "requestId")?;
  let result = get_context_request_status_for_client_at_path(path, request_id, client_id)
    .map_err(|error| (-32000, error))?;
  if result.status == "not_found" {
    return Ok(json!({
      "mutated": false,
      "status": "not_found",
      "requestId": request_id,
      "message": "No ContextPackRequest was found for this id."
    }));
  }
  if result.context_pack.is_some() {
    Ok(json!({
      "mutated": false,
      "status": "fulfilled",
      "requestId": request_id,
      "contextPack": result.context_pack,
      "message": "The Context Pack has been confirmed and can be used for this answer."
    }))
  } else {
    Ok(json!({
      "mutated": false,
      "status": result.status,
      "requestId": request_id,
      "expiresAt": result.expires_at,
      "message": "The request is not yet fulfilled."
    }))
  }
}

fn effective_client_id() -> String {
  env::var("LCV_EFFECTIVE_CLIENT_ID")
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "conn_local_mcp".to_string())
}

fn effective_policy_summary(vault: &Value, client_id: &str) -> Value {
  let policy = vault
    .get("accessPolicies")
    .and_then(Value::as_array)
    .and_then(|policies| {
      policies
        .iter()
        .find(|policy| policy.get("clientId").and_then(Value::as_str) == Some(client_id))
    });
  json!({
    "sensitivityCeiling": policy
      .and_then(|policy| policy.get("sensitivityCeiling"))
      .and_then(Value::as_str)
      .unwrap_or("private_consequential"),
    "requiresApprovalAbove": policy
      .and_then(|policy| policy.get("requiresApprovalAbove"))
      .and_then(Value::as_str)
      .unwrap_or("personal"),
    "passiveCaptureAllowed": policy
      .and_then(|policy| policy.get("passiveCaptureAllowed"))
      .and_then(Value::as_bool)
      .unwrap_or(false),
    "domainCount": policy
      .and_then(|policy| policy.get("domainAllowlist"))
      .and_then(Value::as_array)
      .map(Vec::len)
      .unwrap_or(0)
  })
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

#[cfg(test)]
fn array(value: &Value, key: &str) -> Vec<Value> {
  value
    .get(key)
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
}

#[cfg(test)]
fn push_array(value: &mut Value, key: &str, item: Value) {
  if !value.get(key).map(Value::is_array).unwrap_or(false) {
    value[key] = json!([]);
  }
  if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
    items.insert(0, item);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{SystemTime, UNIX_EPOCH};

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

  fn read_test_vault(path: &Path) -> Value {
    let connection = vault_crypto::open_encrypted_vault_connection(path).expect("open saved vault");
    ensure_vault_state_table(&connection).expect("vault_state table");
    let payload: String = connection
      .query_row(
        "SELECT payload FROM vault_state WHERE key = ?1",
        params![VAULT_STATE_KEY],
        |row| row.get(0),
      )
      .expect("saved payload");
    serde_json::from_str::<Value>(&payload).expect("saved json")
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
      "conn_local_mcp",
    )
    .expect("request context pack");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("pending_user_confirmation"));
    assert!(result.get("contextPack").is_none());
    let saved = read_test_vault(&path);
    assert_eq!(array(&saved, "contextPackRequests").len(), 1);
    assert_eq!(array(&saved, "contextPacks").len(), 1);
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn low_risk_context_pack_is_queued_without_raw_source_body() {
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
      "conn_local_mcp",
    )
    .expect("request context pack");

    assert_eq!(
      result.get("status").and_then(Value::as_str),
      Some("pending_user_confirmation")
    );
    assert!(result.get("contextPack").is_none());
    let saved = read_test_vault(&path);
    let packs = array(&saved, "contextPacks");
    let pack = packs.first().expect("queued context pack");
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
    let path = test_vault_path("memory-proposal");
    write_test_vault(&path, &empty_vault());

    let result = propose_memory_at_path_for_mcp(
      &path,
      &json!({
        "text": "Tone preference: concise and calm",
        "clientName": "Codex"
      }),
      "conn_local_mcp",
    )
    .expect("propose memory");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("candidate_created"));
    let saved = read_test_vault(&path);
    assert_eq!(array(&saved, "candidates").len(), 1);
    assert_eq!(array(&saved, "facts").len(), 0);
    assert_eq!(
      array(&saved, "candidates")[0].get("status").and_then(Value::as_str),
      Some("new")
    );
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn request_status_returns_confirmed_pack_without_internal_fields() {
    let path = test_vault_path("request-status");
    let mut vault = empty_vault();
    push_array(
      &mut vault,
      "contextPackRequests",
      json!({
        "id": "req_confirmed",
        "clientId": "conn_local_mcp",
        "clientName": "Claude Desktop",
        "taskText": "Help me plan",
        "purpose": "MCP client requested life context",
        "requestedDomains": ["life_events_and_plans"],
        "sensitivityCeiling": "personal",
        "approvalMode": "explicit_sensitive",
        "createdAt": "2026-06-12T00:00:00.000Z",
        "expiresAt": "2099-06-12T00:10:00.000Z",
        "status": "fulfilled"
      }),
    );
    push_array(
      &mut vault,
      "contextPacks",
      json!({
        "id": "pack_confirmed",
        "requestId": "req_confirmed",
        "taskText": "Help me plan",
        "taskDomain": "life_events_and_plans",
        "riskLevel": "low",
        "generatedAt": "2026-06-12T00:00:00.000Z",
        "expiresAt": "2099-06-12T00:10:00.000Z",
        "maxSensitivityIncluded": "personal",
        "items": [],
        "sourceSnippets": [],
        "warnings": [],
        "excludedItems": [],
        "confirmationStatus": "confirmed",
        "localAnswer": "internal-only",
        "auditEventId": "audit_internal"
      }),
    );
    write_test_vault(&path, &vault);

    let result = get_request_status_at_path_for_mcp(
      &path,
      &json!({
        "requestId": "req_confirmed"
      }),
      "conn_local_mcp",
    )
    .expect("request status");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("fulfilled"));
    let pack = result.get("contextPack").expect("context pack");
    assert_eq!(
      pack.get("trustBoundary").and_then(Value::as_str),
      Some("ContextPack only")
    );
    assert!(pack.get("localAnswer").is_none());
    assert!(pack.get("auditEventId").is_none());
    let _ = std::fs::remove_file(path);
  }

  #[test]
  fn request_status_hides_confirmed_pack_from_other_client() {
    let path = test_vault_path("request-status-client-boundary");
    let mut vault = empty_vault();
    push_array(
      &mut vault,
      "contextPackRequests",
      json!({
        "id": "req_confirmed",
        "clientId": "client_chatgpt_oauth",
        "clientName": "ChatGPT",
        "taskText": "Help me plan",
        "purpose": "MCP client requested life context",
        "requestedDomains": ["life_events_and_plans"],
        "sensitivityCeiling": "personal",
        "approvalMode": "explicit_sensitive",
        "createdAt": "2026-06-12T00:00:00.000Z",
        "expiresAt": "2099-06-12T00:10:00.000Z",
        "status": "fulfilled"
      }),
    );
    push_array(
      &mut vault,
      "contextPacks",
      json!({
        "id": "pack_confirmed",
        "requestId": "req_confirmed",
        "taskText": "Help me plan",
        "taskDomain": "life_events_and_plans",
        "riskLevel": "low",
        "generatedAt": "2026-06-12T00:00:00.000Z",
        "expiresAt": "2099-06-12T00:10:00.000Z",
        "maxSensitivityIncluded": "personal",
        "items": [],
        "sourceSnippets": [],
        "warnings": [],
        "excludedItems": [],
        "confirmationStatus": "confirmed"
      }),
    );
    write_test_vault(&path, &vault);

    let result = get_request_status_at_path_for_mcp(
      &path,
      &json!({
        "requestId": "req_confirmed"
      }),
      "client_other_oauth",
    )
    .expect("request status");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("not_found"));
    assert!(result.get("contextPack").is_none());
    let _ = std::fs::remove_file(path);
  }
}
