use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
  fs,
  io::{Read, Write},
  net::TcpStream,
  path::PathBuf,
  process::{Child, Command, Stdio},
  sync::Mutex,
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{ActivationPolicy, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

mod mcp_stdio;
mod vault_crypto;

const VAULT_STATE_KEY: &str = "vault_state";
const LOCAL_RELAY_BIND: &str = "127.0.0.1:8765";
const LOCAL_RELAY_BASE_URL: &str = "http://127.0.0.1:8765";

struct AiAccessSupervisor {
  relay: Option<Child>,
  agent: Option<Child>,
  pairing_code: Option<String>,
  relay_token: String,
  last_error: Option<String>,
}

impl Default for AiAccessSupervisor {
  fn default() -> Self {
    Self {
      relay: None,
      agent: None,
      pairing_code: None,
      relay_token: random_local_token(),
      last_error: None,
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AiAccessServiceStatus {
  managed_by_app: bool,
  relay_managed_running: bool,
  agent_managed_running: bool,
  relay_reachable: bool,
  agent_connected: bool,
  relay_url: String,
  mcp_server_url: String,
  relay_state_status_url: String,
  pairing_code: Option<String>,
  last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStateSnapshot {
  payload: Option<String>,
  updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveVaultStateResult {
  updated_at: Option<String>,
  conflict: bool,
  current_updated_at: Option<String>,
  current_payload: Option<String>,
}

fn vault_db_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
  fs::create_dir_all(&dir)
    .map_err(|error| format!("failed to create app data dir: {error}"))?;
  Ok(dir.join("vault.sqlite3"))
}

fn relay_state_path(app: &AppHandle) -> Result<PathBuf, String> {
  vault_db_path(app).map(|path| path.with_file_name("relay-state.json"))
}

fn open_vault_db(app: &AppHandle) -> Result<Connection, String> {
  let path = vault_db_path(app)?;
  let connection = vault_crypto::open_encrypted_vault_connection(&path)?;
  connection
    .execute(
      "CREATE TABLE IF NOT EXISTS vault_state (
        key TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )",
      [],
    )
    .map_err(|error| format!("failed to initialize vault database: {error}"))?;
  ensure_vault_state_updated_at_column(&connection)?;
  initialize_vault_schema(&connection)?;
  Ok(connection)
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

fn initialize_vault_schema(connection: &Connection) -> Result<(), String> {
  connection
    .execute_batch(
      "
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS schema_versions (
        component TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO schema_versions (component, version, updated_at)
      VALUES ('vault_core', 1, CURRENT_TIMESTAMP)
      ON CONFLICT(component) DO UPDATE SET
        version = excluded.version,
        updated_at = CURRENT_TIMESTAMP;

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        origin TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        retention_until TEXT,
        default_sensitivity TEXT NOT NULL,
        processing_status TEXT NOT NULL,
        deletion_state TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_chunks (
        id TEXT PRIMARY KEY NOT NULL,
        source_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        detected_sensitivity TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES sources(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY NOT NULL,
        source_ids TEXT NOT NULL,
        proposed_fact_text TEXT NOT NULL,
        domain TEXT NOT NULL,
        candidate_type TEXT NOT NULL,
        detected_sensitivity TEXT NOT NULL,
        confidence TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY NOT NULL,
        fact_text TEXT NOT NULL,
        domain TEXT NOT NULL,
        fact_type TEXT NOT NULL,
        source_ids TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        confidence TEXT NOT NULL,
        status TEXT NOT NULL,
        valid_from TEXT,
        valid_until TEXT,
        due_date TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY NOT NULL,
        entity_type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY NOT NULL,
        from_entity_id TEXT NOT NULL,
        to_entity_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        fact_id TEXT,
        sensitivity TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts
      USING fts5(fact_id UNINDEXED, fact_text, domain);

      CREATE TABLE IF NOT EXISTS access_policies (
        id TEXT PRIMARY KEY NOT NULL,
        client_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_pack_requests (
        id TEXT PRIMARY KEY NOT NULL,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        task_text TEXT NOT NULL,
        sensitivity_ceiling TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_packs (
        id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT,
        task_text TEXT NOT NULL,
        max_sensitivity_included TEXT NOT NULL,
        confirmation_status TEXT NOT NULL,
        expires_at TEXT,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connector_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        client_kind TEXT NOT NULL,
        client_name TEXT NOT NULL,
        transport TEXT NOT NULL,
        status TEXT NOT NULL,
        last_used_at TEXT,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS passive_capture_events (
        id TEXT PRIMARY KEY NOT NULL,
        source_client TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        url_hash TEXT NOT NULL,
        retention_until TEXT NOT NULL,
        sensitivity_guess TEXT NOT NULL,
        processing_status TEXT NOT NULL,
        source_id TEXT,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        metadata TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind);
      CREATE INDEX IF NOT EXISTS idx_sources_retention ON sources(retention_until);
      CREATE INDEX IF NOT EXISTS idx_candidates_status ON memory_candidates(status);
      CREATE INDEX IF NOT EXISTS idx_facts_domain ON facts(domain);
      CREATE INDEX IF NOT EXISTS idx_facts_sensitivity ON facts(sensitivity);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_entity_id);
      CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_entity_id);
      CREATE INDEX IF NOT EXISTS idx_requests_status ON context_pack_requests(status);
      CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_events(occurred_at);
      ",
    )
    .map_err(|error| format!("failed to initialize vault schema: {error}"))
}

fn sync_normalized_tables(connection: &mut Connection, payload: &str) -> Result<(), String> {
  let vault: Value =
    serde_json::from_str(payload).map_err(|error| format!("failed to parse vault payload: {error}"))?;
  let transaction = connection
    .transaction()
    .map_err(|error| format!("failed to start vault sync transaction: {error}"))?;

  for table in [
    "facts_fts",
    "audit_events",
    "passive_capture_events",
    "connector_sessions",
    "context_packs",
    "context_pack_requests",
    "access_policies",
    "relationships",
    "entities",
    "facts",
    "memory_candidates",
    "source_chunks",
    "sources",
  ] {
    transaction
      .execute(&format!("DELETE FROM {table}"), [])
      .map_err(|error| format!("failed to clear {table}: {error}"))?;
  }

  for source in value_array(&vault, "sources") {
    let source_id = str_field(source, "id");
    let body = str_field(source, "body");
    transaction
      .execute(
        "INSERT INTO sources (
          id, kind, title, origin, body, created_at, captured_at, retention_until,
          default_sensitivity, processing_status, deletion_state
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
          source_id,
          str_field(source, "kind"),
          str_field(source, "title"),
          str_field(source, "origin"),
          body,
          str_field(source, "createdAt"),
          str_field(source, "capturedAt"),
          optional_str_field(source, "retentionUntil"),
          str_field(source, "defaultSensitivity"),
          str_field(source, "processingStatus"),
          str_field(source, "deletionState")
        ],
      )
      .map_err(|error| format!("failed to sync source {source_id}: {error}"))?;

    transaction
      .execute(
        "INSERT INTO source_chunks (
          id, source_id, chunk_index, text, detected_sensitivity, created_at
        ) VALUES (?1, ?2, 0, ?3, ?4, ?5)",
        params![
          format!("chunk_{source_id}_0"),
          source_id,
          body,
          str_field(source, "defaultSensitivity"),
          str_field(source, "createdAt")
        ],
      )
      .map_err(|error| format!("failed to sync source chunk for {source_id}: {error}"))?;
  }

  for candidate in value_array(&vault, "candidates") {
    let candidate_id = str_field(candidate, "id");
    transaction
      .execute(
        "INSERT INTO memory_candidates (
          id, source_ids, proposed_fact_text, domain, candidate_type,
          detected_sensitivity, confidence, status, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
          candidate_id,
          json_field(candidate, "sourceIds"),
          str_field(candidate, "proposedFactText"),
          str_field(candidate, "domain"),
          str_field(candidate, "candidateType"),
          str_field(candidate, "detectedSensitivity"),
          str_field(candidate, "confidence"),
          str_field(candidate, "status"),
          str_field(candidate, "createdAt")
        ],
      )
      .map_err(|error| format!("failed to sync candidate {candidate_id}: {error}"))?;
  }

  for fact in value_array(&vault, "facts") {
    let fact_id = str_field(fact, "id");
    transaction
      .execute(
        "INSERT INTO facts (
          id, fact_text, domain, fact_type, source_ids, sensitivity, confidence,
          status, valid_from, valid_until, due_date, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
          fact_id,
          str_field(fact, "factText"),
          str_field(fact, "domain"),
          str_field(fact, "factType"),
          json_field(fact, "sourceIds"),
          str_field(fact, "sensitivity"),
          str_field(fact, "confidence"),
          str_field(fact, "status"),
          optional_str_field(fact, "validFrom"),
          optional_str_field(fact, "validUntil"),
          optional_str_field(fact, "dueDate"),
          str_field(fact, "updatedAt")
        ],
      )
      .map_err(|error| format!("failed to sync fact {fact_id}: {error}"))?;
    transaction
      .execute(
        "INSERT INTO facts_fts (fact_id, fact_text, domain) VALUES (?1, ?2, ?3)",
        params![fact_id, str_field(fact, "factText"), str_field(fact, "domain")],
      )
      .map_err(|error| format!("failed to sync fact FTS {fact_id}: {error}"))?;
  }

  for policy in value_array(&vault, "accessPolicies") {
    let policy_id = str_field(policy, "id");
    transaction
      .execute(
        "INSERT INTO access_policies (id, client_id, payload, updated_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
          policy_id,
          str_field(policy, "clientId"),
          policy.to_string(),
          str_field(policy, "updatedAt")
        ],
      )
      .map_err(|error| format!("failed to sync access policy {policy_id}: {error}"))?;
  }

  for request in value_array(&vault, "contextPackRequests") {
    let request_id = str_field(request, "id");
    transaction
      .execute(
        "INSERT INTO context_pack_requests (
          id, client_id, client_name, task_text, sensitivity_ceiling,
          status, expires_at, payload
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
          request_id,
          str_field(request, "clientId"),
          str_field(request, "clientName"),
          str_field(request, "taskText"),
          str_field(request, "sensitivityCeiling"),
          str_field(request, "status"),
          str_field(request, "expiresAt"),
          request.to_string()
        ],
      )
      .map_err(|error| format!("failed to sync context request {request_id}: {error}"))?;
  }

  for pack in value_array(&vault, "contextPacks") {
    let pack_id = str_field(pack, "id");
    transaction
      .execute(
        "INSERT INTO context_packs (
          id, request_id, task_text, max_sensitivity_included,
          confirmation_status, expires_at, payload
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
          pack_id,
          optional_str_field(pack, "requestId"),
          str_field(pack, "taskText"),
          str_field(pack, "maxSensitivityIncluded"),
          str_field(pack, "confirmationStatus"),
          optional_str_field(pack, "expiresAt"),
          pack.to_string()
        ],
      )
      .map_err(|error| format!("failed to sync context pack {pack_id}: {error}"))?;
  }

  for connector in value_array(&vault, "connectorSessions") {
    let connector_id = str_field(connector, "id");
    transaction
      .execute(
        "INSERT INTO connector_sessions (
          id, client_kind, client_name, transport, status, last_used_at, payload
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
          connector_id,
          str_field(connector, "clientKind"),
          str_field(connector, "clientName"),
          str_field(connector, "transport"),
          str_field(connector, "status"),
          optional_str_field(connector, "lastUsedAt"),
          connector.to_string()
        ],
      )
      .map_err(|error| format!("failed to sync connector {connector_id}: {error}"))?;
  }

  for event in value_array(&vault, "passiveCaptureEvents") {
    let event_id = str_field(event, "id");
    transaction
      .execute(
        "INSERT INTO passive_capture_events (
          id, source_client, conversation_id, url_hash, retention_until,
          sensitivity_guess, processing_status, source_id, payload
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
          event_id,
          str_field(event, "sourceClient"),
          str_field(event, "conversationId"),
          str_field(event, "urlHash"),
          str_field(event, "retentionUntil"),
          str_field(event, "sensitivityGuess"),
          str_field(event, "processingStatus"),
          optional_str_field(event, "sourceId"),
          event.to_string()
        ],
      )
      .map_err(|error| format!("failed to sync passive capture event {event_id}: {error}"))?;
  }

  for event in value_array(&vault, "auditEvents") {
    let event_id = str_field(event, "id");
    transaction
      .execute(
        "INSERT INTO audit_events (
          id, event_type, actor, subject_type, subject_id, occurred_at, sensitivity, metadata
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
          event_id,
          str_field(event, "eventType"),
          str_field(event, "actor"),
          str_field(event, "subjectType"),
          str_field(event, "subjectId"),
          str_field(event, "occurredAt"),
          str_field(event, "sensitivity"),
          json_field(event, "metadata")
        ],
      )
      .map_err(|error| format!("failed to sync audit event {event_id}: {error}"))?;
  }

  transaction
    .commit()
    .map_err(|error| format!("failed to commit vault sync transaction: {error}"))
}

fn value_array<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
  value
    .get(key)
    .and_then(Value::as_array)
    .map(|items| items.iter().collect())
    .unwrap_or_default()
}

fn str_field(value: &Value, key: &str) -> String {
  optional_str_field(value, key).unwrap_or_default()
}

fn optional_str_field(value: &Value, key: &str) -> Option<String> {
  value
    .get(key)
    .and_then(Value::as_str)
    .map(ToString::to_string)
}

fn json_field(value: &Value, key: &str) -> String {
  value
    .get(key)
    .map(Value::to_string)
    .unwrap_or_else(|| "null".to_string())
}

fn random_local_token() -> String {
  let mut bytes = [0u8; 32];
  #[cfg(unix)]
  {
    if fs::File::open("/dev/urandom")
      .and_then(|mut file| file.read_exact(&mut bytes))
      .is_ok()
    {
      return format!("lcv_{}", URL_SAFE_NO_PAD.encode(bytes));
    }
  }

  let mut hasher = Sha256::new();
  hasher.update(
    SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|duration| duration.as_nanos().to_le_bytes())
      .unwrap_or_default(),
  );
  hasher.update(std::process::id().to_le_bytes());
  format!("lcv_{}", URL_SAFE_NO_PAD.encode(hasher.finalize()))
}

fn refresh_child(child: &mut Option<Child>) -> bool {
  let Some(process) = child.as_mut() else {
    return false;
  };
  match process.try_wait() {
    Ok(None) => true,
    Ok(Some(_)) | Err(_) => {
      *child = None;
      false
    }
  }
}

fn stop_child(child: &mut Option<Child>) {
  if let Some(mut process) = child.take() {
    let _ = process.kill();
    let _ = process.wait();
  }
}

fn local_relay_json(method: &str, path: &str, body: Option<&str>) -> Result<Value, String> {
  let body = body.unwrap_or("");
  let mut stream = TcpStream::connect(LOCAL_RELAY_BIND)
    .map_err(|error| format!("failed to connect local relay: {error}"))?;
  stream
    .set_read_timeout(Some(Duration::from_secs(2)))
    .map_err(|error| format!("failed to set relay read timeout: {error}"))?;
  stream
    .set_write_timeout(Some(Duration::from_secs(2)))
    .map_err(|error| format!("failed to set relay write timeout: {error}"))?;

  let request = format!(
    "{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {length}\r\n\r\n{body}",
    host = LOCAL_RELAY_BIND,
    length = body.as_bytes().len()
  );
  stream
    .write_all(request.as_bytes())
    .map_err(|error| format!("failed to write relay request: {error}"))?;

  let mut response = String::new();
  stream
    .read_to_string(&mut response)
    .map_err(|error| format!("failed to read relay response: {error}"))?;
  parse_http_json_response(&response)
}

fn parse_http_json_response(response: &str) -> Result<Value, String> {
  let (head, body) = response
    .split_once("\r\n\r\n")
    .ok_or_else(|| "relay returned malformed HTTP response".to_string())?;
  let status = head
    .lines()
    .next()
    .and_then(|line| line.split_whitespace().nth(1))
    .and_then(|code| code.parse::<u16>().ok())
    .ok_or_else(|| "relay response did not include a valid status".to_string())?;
  if !(200..300).contains(&status) {
    return Err(format!("relay returned HTTP {status}: {body}"));
  }
  if body.trim().is_empty() {
    return Ok(Value::Null);
  }
  serde_json::from_str(body).map_err(|error| format!("relay returned invalid JSON: {error}"))
}

fn relay_reachable() -> bool {
  local_relay_json("GET", "/health", None).is_ok()
}

fn agent_connected() -> bool {
  local_relay_json("GET", "/agent/status", None)
    .ok()
    .and_then(|value| value.get("connected").and_then(Value::as_bool))
    .unwrap_or(false)
}

fn wait_for_condition(mut predicate: impl FnMut() -> bool) -> bool {
  for _ in 0..30 {
    if predicate() {
      return true;
    }
    thread::sleep(Duration::from_millis(100));
  }
  false
}

fn should_block_external_relay_start(
  relay_reachable: bool,
  relay_managed_running: bool,
  agent_connected: bool,
) -> bool {
  relay_reachable && !relay_managed_running && !agent_connected
}

fn supervisor_status(supervisor: &mut AiAccessSupervisor) -> AiAccessServiceStatus {
  let relay_managed_running = refresh_child(&mut supervisor.relay);
  let agent_managed_running = refresh_child(&mut supervisor.agent);
  AiAccessServiceStatus {
    managed_by_app: true,
    relay_managed_running,
    agent_managed_running,
    relay_reachable: relay_reachable(),
    agent_connected: agent_connected(),
    relay_url: LOCAL_RELAY_BASE_URL.to_string(),
    mcp_server_url: format!("{LOCAL_RELAY_BASE_URL}/mcp"),
    relay_state_status_url: format!("{LOCAL_RELAY_BASE_URL}/relay/state"),
    pairing_code: supervisor.pairing_code.clone(),
    last_error: supervisor.last_error.clone(),
  }
}

fn spawn_relay(app: &AppHandle, relay_token: &str) -> Result<Child, String> {
  let vault_path = vault_db_path(app)?;
  let relay_state_path = relay_state_path(app)?;
  let relay_command = mcp_stdio::resolve_sibling_binary("lcv-relay");
  let mcp_command = mcp_stdio::resolve_sibling_binary("lcv-mcp");
  Command::new(&relay_command)
    .env("LCV_RELAY_TOKEN", relay_token)
    .env("LCV_RELAY_BIND", LOCAL_RELAY_BIND)
    .env("LCV_RELAY_BASE_URL", LOCAL_RELAY_BASE_URL)
    .env("LCV_RELAY_STATE_PATH", relay_state_path)
    .env("LCV_RELAY_ALLOW_DIRECT_SIDECAR", "0")
    .env("LCV_MCP_COMMAND", mcp_command)
    .env("LCV_VAULT_DB_PATH", vault_path)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|error| format!("failed to start local relay at {}: {error}", relay_command.display()))
}

fn spawn_agent(app: &AppHandle, agent_websocket_url: &str) -> Result<Child, String> {
  let vault_path = vault_db_path(app)?;
  let agent_command = mcp_stdio::resolve_sibling_binary("lcv-agent");
  let mcp_command = mcp_stdio::resolve_sibling_binary("lcv-mcp");
  Command::new(&agent_command)
    .env("LCV_AGENT_RELAY_WS", agent_websocket_url)
    .env("LCV_AGENT_RECONNECT", "1")
    .env("LCV_MCP_COMMAND", mcp_command)
    .env("LCV_VAULT_DB_PATH", vault_path)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|error| format!("failed to start local agent at {}: {error}", agent_command.display()))
}

#[tauri::command]
fn load_vault_state(app: AppHandle) -> Result<Option<String>, String> {
  load_vault_state_snapshot(app).map(|snapshot| snapshot.payload)
}

#[tauri::command]
fn load_vault_state_snapshot(app: AppHandle) -> Result<VaultStateSnapshot, String> {
  let connection = open_vault_db(&app)?;
  load_vault_state_snapshot_from_connection(&connection)
}

#[tauri::command]
fn save_vault_state(
  app: AppHandle,
  payload: String,
  expected_updated_at: Option<String>,
) -> Result<SaveVaultStateResult, String> {
  let mut connection = open_vault_db(&app)?;
  save_vault_state_payload(
    &mut connection,
    &payload,
    expected_updated_at.as_deref(),
  )
}

fn save_vault_state_payload(
  connection: &mut Connection,
  payload: &str,
  expected_updated_at: Option<&str>,
) -> Result<SaveVaultStateResult, String> {
  let current = load_vault_state_snapshot_from_connection(&connection)?;
  if let Some(expected) = expected_updated_at {
    if current.updated_at.as_deref() != Some(expected) {
      return Ok(SaveVaultStateResult {
        updated_at: current.updated_at.clone(),
        conflict: true,
        current_updated_at: current.updated_at,
        current_payload: current.payload,
      });
    }
  }

  connection
    .execute(
      "INSERT INTO vault_state (key, payload, updated_at)
       VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(key) DO UPDATE SET
         payload = excluded.payload,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      params![VAULT_STATE_KEY, payload],
    )
    .map_err(|error| format!("failed to save vault state: {error}"))?;
  sync_normalized_tables(connection, payload)?;
  let updated_at = vault_state_updated_at(&connection)?;
  Ok(SaveVaultStateResult {
    updated_at: Some(updated_at),
    conflict: false,
    current_updated_at: None,
    current_payload: None,
  })
}

fn vault_state_updated_at(connection: &Connection) -> Result<String, String> {
  connection
    .query_row(
      "SELECT updated_at FROM vault_state WHERE key = ?1",
      params![VAULT_STATE_KEY],
      |row| row.get::<_, String>(0),
    )
    .map_err(|error| format!("failed to read vault updated_at: {error}"))
}

fn load_vault_state_snapshot_from_connection(
  connection: &Connection,
) -> Result<VaultStateSnapshot, String> {
  connection
    .query_row(
      "SELECT payload, updated_at FROM vault_state WHERE key = ?1",
      params![VAULT_STATE_KEY],
      |row| {
        Ok(VaultStateSnapshot {
          payload: Some(row.get::<_, String>(0)?),
          updated_at: Some(row.get::<_, String>(1)?),
        })
      },
    )
    .optional()
    .map(|snapshot| {
      snapshot.unwrap_or(VaultStateSnapshot {
        payload: None,
        updated_at: None,
      })
    })
    .map_err(|error| format!("failed to load vault state: {error}"))
}

#[tauri::command]
fn vault_storage_path(app: AppHandle) -> Result<String, String> {
  vault_db_path(&app).map(|path| path.display().to_string())
}

#[tauri::command]
fn ai_access_service_status(
  supervisor: tauri::State<'_, Mutex<AiAccessSupervisor>>,
) -> Result<AiAccessServiceStatus, String> {
  let mut supervisor = supervisor
    .lock()
    .map_err(|_| "failed to lock AI access supervisor".to_string())?;
  Ok(supervisor_status(&mut supervisor))
}

#[tauri::command]
fn start_ai_access_services(
  app: AppHandle,
  supervisor: tauri::State<'_, Mutex<AiAccessSupervisor>>,
) -> Result<AiAccessServiceStatus, String> {
  let mut supervisor = supervisor
    .lock()
    .map_err(|_| "failed to lock AI access supervisor".to_string())?;

  let relay_managed_running = refresh_child(&mut supervisor.relay);
  let relay_is_reachable = relay_reachable();
  if !relay_is_reachable {
    if !relay_managed_running {
      supervisor.relay = Some(spawn_relay(&app, &supervisor.relay_token).map_err(|error| {
        supervisor.last_error = Some(error.clone());
        error
      })?);
    }
    if !wait_for_condition(relay_reachable) {
      let error = "local relay did not become reachable".to_string();
      supervisor.last_error = Some(error.clone());
      return Err(error);
    }
  } else if should_block_external_relay_start(
    relay_is_reachable,
    relay_managed_running,
    agent_connected(),
  ) {
    let error = format!(
      "another relay is already running at {LOCAL_RELAY_BASE_URL}; use manual pairing for that relay or stop it before starting the app-managed AI Access Service"
    );
    supervisor.last_error = Some(error.clone());
    return Err(error);
  }

  if !agent_connected() {
    if refresh_child(&mut supervisor.agent) {
      stop_child(&mut supervisor.agent);
    }
    let pairing = local_relay_json("POST", "/pairing/start", None).map_err(|error| {
      supervisor.last_error = Some(error.clone());
      error
    })?;
    let pairing_code = pairing
      .get("pairingCode")
      .and_then(Value::as_str)
      .ok_or_else(|| "relay pairing response did not include pairingCode".to_string())?
      .to_string();
    let agent_websocket_url = pairing
      .get("agentWebSocketUrl")
      .and_then(Value::as_str)
      .ok_or_else(|| "relay pairing response did not include agentWebSocketUrl".to_string())?
      .to_string();
    supervisor.pairing_code = Some(pairing_code);
    supervisor.agent = Some(spawn_agent(&app, &agent_websocket_url).map_err(|error| {
      supervisor.last_error = Some(error.clone());
      error
    })?);
    if !wait_for_condition(agent_connected) {
      let error = "local agent did not connect to relay".to_string();
      supervisor.last_error = Some(error.clone());
      return Err(error);
    }
  }

  supervisor.last_error = None;
  Ok(supervisor_status(&mut supervisor))
}

#[tauri::command]
fn stop_ai_access_services(
  supervisor: tauri::State<'_, Mutex<AiAccessSupervisor>>,
) -> Result<AiAccessServiceStatus, String> {
  let mut supervisor = supervisor
    .lock()
    .map_err(|_| "failed to lock AI access supervisor".to_string())?;
  stop_child(&mut supervisor.agent);
  stop_child(&mut supervisor.relay);
  supervisor.pairing_code = None;
  supervisor.last_error = None;
  Ok(supervisor_status(&mut supervisor))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(Mutex::new(AiAccessSupervisor::default()))
    .on_window_event(|window, event| {
      if matches!(
        event,
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
      ) {
        let supervisor = window.state::<Mutex<AiAccessSupervisor>>();
        if let Ok(mut supervisor) = supervisor.lock() {
          stop_child(&mut supervisor.agent);
          stop_child(&mut supervisor.relay);
        };
      }
    })
    .invoke_handler(tauri::generate_handler![
      load_vault_state,
      load_vault_state_snapshot,
      save_vault_state,
      vault_storage_path,
      ai_access_service_status,
      start_ai_access_services,
      stop_ai_access_services
    ])
    .setup(|app| {
      app.set_activation_policy(ActivationPolicy::Regular);
      let url = if cfg!(debug_assertions) {
        WebviewUrl::External(
          "http://127.0.0.1:5173"
            .parse()
            .expect("static dev URL must be valid"),
        )
      } else {
        WebviewUrl::App("index.html".into())
      };
      eprintln!("creating Life Context Vault main window");
      let window = WebviewWindowBuilder::new(app, "main", url)
        .title("Life Context Vault")
        .inner_size(1200.0, 820.0)
        .min_inner_size(390.0, 680.0)
        .resizable(true)
        .visible(true)
        .build()?;
      window.center()?;
      window.show()?;
      window.set_focus()?;
      eprintln!("Life Context Vault main window is visible");

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn syncs_vault_snapshot_into_normalized_tables() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_vault_schema(&connection).expect("schema");

    let payload = r#"
    {
      "version": 2,
      "sources": [
        {
          "id": "src_test",
          "kind": "manual_note",
          "title": "Move note",
          "origin": "manual_entry",
          "body": "Need to update address before moving.",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "capturedAt": "2026-06-12T00:00:00.000Z",
          "defaultSensitivity": "personal",
          "processingStatus": "ready",
          "deletionState": "active"
        }
      ],
      "candidates": [
        {
          "id": "cand_test",
          "sourceIds": ["src_test"],
          "proposedFactText": "Need to update address before moving.",
          "domain": "home_and_places",
          "candidateType": "obligation",
          "detectedSensitivity": "personal",
          "confidence": "medium",
          "status": "new",
          "createdAt": "2026-06-12T00:00:00.000Z"
        }
      ],
      "facts": [
        {
          "id": "fact_test",
          "factText": "Need to update address before moving.",
          "domain": "home_and_places",
          "factType": "obligation",
          "sourceIds": ["src_test"],
          "sensitivity": "personal",
          "confidence": "source_backed",
          "status": "active",
          "updatedAt": "2026-06-12T00:00:00.000Z"
        }
      ],
      "accessPolicies": [],
      "contextPackRequests": [],
      "contextPacks": [],
      "connectorSessions": [],
      "passiveCaptureEvents": [],
      "auditEvents": []
    }
    "#;

    sync_normalized_tables(&mut connection, payload).expect("sync");

    let source_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
      .expect("source count");
    let candidate_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM memory_candidates", [], |row| row.get(0))
      .expect("candidate count");
    let fact_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("fact count");
    let fts_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts_fts WHERE facts_fts MATCH 'address'", [], |row| {
        row.get(0)
      })
      .expect("fts count");

    assert_eq!(source_count, 1);
    assert_eq!(candidate_count, 1);
    assert_eq!(fact_count, 1);
    assert_eq!(fts_count, 1);
  }

  #[test]
  fn relay_http_parser_accepts_json_success() {
    let parsed = parse_http_json_response(
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{\"status\":\"ok\"}",
    )
    .expect("relay response");

    assert_eq!(parsed.get("status").and_then(Value::as_str), Some("ok"));
  }

  #[test]
  fn relay_http_parser_rejects_error_status() {
    let error = parse_http_json_response(
      "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\n\r\n{\"error\":\"boom\"}",
    )
    .expect_err("error status");

    assert!(error.contains("HTTP 500"));
  }

  #[test]
  fn external_relay_without_agent_is_not_auto_attached() {
    assert!(should_block_external_relay_start(true, false, false));
    assert!(!should_block_external_relay_start(true, true, false));
    assert!(!should_block_external_relay_start(true, false, true));
    assert!(!should_block_external_relay_start(false, false, false));
  }

  #[test]
  fn vault_state_updated_at_column_is_backfilled_for_legacy_tables() {
    let connection = Connection::open_in_memory().expect("connection");
    connection
      .execute(
        "CREATE TABLE vault_state (
          key TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL
        )",
        [],
      )
      .expect("legacy table");
    connection
      .execute(
        "INSERT INTO vault_state (key, payload) VALUES (?1, ?2)",
        params![VAULT_STATE_KEY, "{}"],
      )
      .expect("legacy row");

    ensure_vault_state_updated_at_column(&connection).expect("migrate");

    let updated_at = vault_state_updated_at(&connection).expect("updated_at");
    assert!(updated_at.ends_with('Z'));
  }

  #[test]
  fn stale_vault_save_returns_conflict_without_overwriting_payload() {
    let mut connection = Connection::open_in_memory().expect("connection");
    connection
      .execute(
        "CREATE TABLE vault_state (
          key TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )",
        [],
      )
      .expect("table");
    connection
      .execute(
        "INSERT INTO vault_state (key, payload, updated_at) VALUES (?1, ?2, ?3)",
        params![VAULT_STATE_KEY, "{\"external\":true}", "external-revision"],
      )
      .expect("row");

    let result = save_vault_state_payload(&mut connection, "{\"local\":true}", Some("old-revision"))
      .expect("save result");
    let stored_payload: String = connection
      .query_row(
        "SELECT payload FROM vault_state WHERE key = ?1",
        params![VAULT_STATE_KEY],
        |row| row.get(0),
      )
      .expect("stored payload");

    assert!(result.conflict);
    assert_eq!(result.current_updated_at.as_deref(), Some("external-revision"));
    assert_eq!(result.current_payload.as_deref(), Some("{\"external\":true}"));
    assert_eq!(stored_payload, "{\"external\":true}");
  }
}
