use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
  env,
  io::{self, BufRead, Write},
  path::PathBuf,
  time::{SystemTime, UNIX_EPOCH},
};
use chrono::{SecondsFormat, Utc};

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
    "life_context.request_context_pack" => request_context_pack(&mut vault, arguments),
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

fn request_context_pack(vault: &mut Value, arguments: &Value) -> Result<Value, (i64, String)> {
  let task_text = required_str(arguments, "taskText")?;
  let client_name = optional_str(arguments, "clientName").unwrap_or("Local MCP Client");
  let ceiling = optional_str(arguments, "sensitivityCeiling").unwrap_or("private_consequential");
  let now = now_iso();
  let expires_at = minutes_from_now(10);
  let request_id = new_id("req");
  let pack_id = new_id("pack");
  let task_domain = classify_domain(task_text);
  let facts = relevant_facts(vault, task_text, ceiling);
  let max_sensitivity = facts
    .iter()
    .map(|fact| get_str(fact, "sensitivity"))
    .max_by_key(|sensitivity| sensitivity_rank(sensitivity))
    .unwrap_or("public");
  let requires_confirmation = sensitivity_rank(max_sensitivity) >= sensitivity_rank("private_consequential");
  let items: Vec<Value> = facts
    .iter()
    .map(|fact| {
      json!({
        "id": new_id("ctxitem"),
        "factId": get_str(fact, "id"),
        "itemText": get_str(fact, "factText"),
        "reasonIncluded": if get_str(fact, "domain") == task_domain {
          "質問の領域と一致しています。"
        } else {
          "本人の背景情報として回答を調整できます。"
        },
        "sensitivity": get_str(fact, "sensitivity"),
        "sourceTitles": source_titles(vault, fact),
        "confidence": get_str(fact, "confidence")
      })
    })
    .collect();
  let warnings = if requires_confirmation {
    vec![json!({
      "kind": "sensitive_context",
      "message": "このContext Packには重要な私的情報が含まれるため、Life Context Vaultアプリで確認が必要です。",
      "relatedIds": facts.iter().map(|fact| Value::String(get_str(fact, "id").to_string())).collect::<Vec<Value>>()
    })]
  } else {
    vec![]
  };
  let confirmation_status = if requires_confirmation {
    "pending_user_confirmation"
  } else {
    "not_required"
  };
  let request = json!({
    "id": request_id,
    "clientId": "conn_local_mcp",
    "clientName": client_name,
    "taskText": task_text,
    "purpose": "MCP client requested life context",
    "requestedDomains": [task_domain],
    "sensitivityCeiling": ceiling,
    "approvalMode": "explicit_sensitive",
    "createdAt": now,
    "expiresAt": expires_at,
    "status": if requires_confirmation { "pending_user_confirmation" } else { "fulfilled" }
  });
  let pack = json!({
    "id": pack_id,
    "requestId": request_id,
    "taskText": task_text,
    "taskDomain": task_domain,
    "riskLevel": classify_risk(task_text),
    "generatedAt": now,
    "expiresAt": expires_at,
    "maxSensitivityIncluded": max_sensitivity,
    "items": items,
    "sourceSnippets": [],
    "excludedItems": [],
    "warnings": warnings,
    "confirmationStatus": confirmation_status
  });

  push_array(vault, "contextPackRequests", request);
  push_array(vault, "contextPacks", pack.clone());
  audit(
    vault,
    "context_pack_requested",
    "context_pack_request",
    &request_id,
    ceiling,
    json!({ "clientName": client_name, "transport": "local_mcp" }),
  );
  audit(
    vault,
    "context_pack_generated",
    "context_pack",
    &pack_id,
    max_sensitivity,
    json!({ "requestId": request_id, "itemCount": facts.len() }),
  );

  if requires_confirmation {
    Ok(json!({
      "mutated": true,
      "status": "pending_user_confirmation",
      "requestId": request_id,
      "expiresAt": expires_at,
      "maxSensitivityIncluded": max_sensitivity,
      "message": "Context Pack was created but not returned because it requires user confirmation in Life Context Vault.",
      "nextAction": "Open Life Context Vault > Context Requests, confirm or deny the request, then call life_context.get_request_status."
    }))
  } else {
    Ok(json!({
      "mutated": true,
      "status": "fulfilled",
      "requestId": request_id,
      "contextPack": safe_pack_for_client(&pack),
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

fn relevant_facts(vault: &Value, task_text: &str, ceiling: &str) -> Vec<Value> {
  let task_domain = classify_domain(task_text);
  let lower_task = task_text.to_lowercase();
  let tokens: Vec<String> = lower_task
    .split_whitespace()
    .map(|token| token.trim_matches(|character: char| !character.is_alphanumeric()).to_string())
    .filter(|token| !token.is_empty())
    .collect();

  let mut scored: Vec<(i64, Value)> = array(vault, "facts")
    .into_iter()
    .filter(|fact| get_str(fact, "status") == "active")
    .filter(|fact| get_str(fact, "sensitivity") != "secret_never_send")
    .filter(|fact| sensitivity_rank(get_str(fact, "sensitivity")) <= sensitivity_rank(ceiling))
    .map(|fact| {
      let haystack = format!(
        "{} {}",
        get_str(&fact, "factText").to_lowercase(),
        get_str(&fact, "domain").to_lowercase()
      );
      let token_score = tokens
        .iter()
        .filter(|token| haystack.contains(token.as_str()))
        .count() as i64
        * 3;
      let domain_score = if get_str(&fact, "domain") == task_domain {
        4
      } else {
        cross_domain_bridge_score(&lower_task, get_str(&fact, "domain"))
      };
      (token_score + domain_score, fact)
    })
    .filter(|(score, _)| *score > 0)
    .collect();

  scored.sort_by(|a, b| b.0.cmp(&a.0));
  scored.into_iter().take(8).map(|(_, fact)| fact).collect()
}

fn safe_pack_for_client(pack: &Value) -> Value {
  json!({
    "id": get_str(pack, "id"),
    "requestId": optional_value(pack, "requestId"),
    "taskText": get_str(pack, "taskText"),
    "taskDomain": get_str(pack, "taskDomain"),
    "generatedAt": get_str(pack, "generatedAt"),
    "expiresAt": optional_value(pack, "expiresAt"),
    "maxSensitivityIncluded": get_str(pack, "maxSensitivityIncluded"),
    "items": pack.get("items").cloned().unwrap_or_else(|| json!([])),
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

fn source_titles(vault: &Value, fact: &Value) -> Vec<Value> {
  let sources = array(vault, "sources");
  fact
    .get("sourceIds")
    .and_then(Value::as_array)
    .map(|ids| {
      ids.iter()
        .filter_map(Value::as_str)
        .map(|source_id| {
          sources
            .iter()
            .find(|source| get_str(source, "id") == source_id)
            .map(|source| get_str(source, "title"))
            .unwrap_or("Unknown source")
            .to_string()
        })
        .map(Value::String)
        .collect()
    })
    .unwrap_or_default()
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

fn classify_risk(text: &str) -> &'static str {
  let sensitivity = detect_sensitivity(text);
  if sensitivity == "sensitive" || sensitivity == "secret_never_send" {
    "high"
  } else if sensitivity == "private_consequential"
    || contains_any(
      &text.to_lowercase(),
      &["contract", "deadline", "benefit", "health", "legal", "money", "契約", "期限", "給付", "健康", "法務", "お金"],
    )
  {
    "medium"
  } else {
    "low"
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

fn cross_domain_bridge_score(task: &str, domain: &str) -> i64 {
  if contains_any(task, &["job", "work", "employer", "転職", "勤務先", "仕事"]) {
    if ["contracts_and_policies", "procedures_and_obligations", "finance_and_benefits"].contains(&domain) {
      return 2;
    }
  }
  if contains_any(task, &["move", "moving", "address", "引っ越", "住所"]) {
    if ["home_and_places", "contracts_and_policies", "procedures_and_obligations", "documents_and_evidence"].contains(&domain) {
      return 2;
    }
  }
  0
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

fn minutes_from_now(minutes: i64) -> String {
  (Utc::now() + chrono::Duration::minutes(minutes))
    .to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sensitive_context_pack_is_queued_without_returning_items_directly() {
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
        "updatedAt": "2026-06-12T00:00:00.000Z"
      }),
    );

    let result = request_context_pack(
      &mut vault,
      &json!({
        "taskText": "What should I check before changing jobs?",
        "clientName": "Claude Desktop"
      }),
    )
    .expect("request context pack");

    assert_eq!(result.get("status").and_then(Value::as_str), Some("pending_user_confirmation"));
    assert!(result.get("contextPack").is_none());
    assert_eq!(array(&vault, "contextPackRequests").len(), 1);
    assert_eq!(array(&vault, "contextPacks").len(), 1);
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
}
