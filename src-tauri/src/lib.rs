use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
  env,
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
const CAPTURE_HOST_NAME: &str = "dev.life_context_vault.capture";
const LOGIN_ITEM_LABEL: &str = "dev.life-context-vault.ai-access";

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDesktopConfigInstallResult {
  config_path: String,
  backup_path: Option<String>,
  server_name: String,
  already_configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCaptureHostInstallResult {
  manifest_path: String,
  backup_path: Option<String>,
  host_name: String,
  host_path: String,
  extension_id: String,
  already_configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginItemStatus {
  supported: bool,
  enabled: bool,
  plist_path: Option<String>,
  program_path: Option<String>,
  label: String,
  backup_path: Option<String>,
  last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFactSearchResult {
  id: String,
  fact_text: String,
  domain: String,
  fact_type: String,
  source_ids: Vec<String>,
  sensitivity: String,
  confidence: String,
  status: String,
  valid_from: Option<String>,
  valid_until: Option<String>,
  due_date: Option<String>,
  created_at: String,
  approved_at: String,
  updated_at: String,
  rank: f64,
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
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    .map_err(|error| format!("failed to initialize vault schema: {error}"))?;
  ensure_column(connection, "facts", "created_at", "TEXT")?;
  ensure_column(connection, "facts", "approved_at", "TEXT")?;
  connection
    .execute(
      "UPDATE facts
       SET created_at = COALESCE(NULLIF(created_at, ''), updated_at),
           approved_at = COALESCE(NULLIF(approved_at, ''), updated_at)
       WHERE created_at IS NULL OR created_at = '' OR approved_at IS NULL OR approved_at = ''",
      [],
    )
    .map_err(|error| format!("failed to backfill fact timestamps: {error}"))?;
  Ok(())
}

fn ensure_column(
  connection: &Connection,
  table: &str,
  column: &str,
  definition: &str,
) -> Result<(), String> {
  let mut statement = connection
    .prepare(&format!("PRAGMA table_info({table})"))
    .map_err(|error| format!("failed to inspect {table} schema: {error}"))?;
  let columns = statement
    .query_map([], |row| row.get::<_, String>(1))
    .map_err(|error| format!("failed to read {table} schema: {error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("failed to collect {table} schema: {error}"))?;

  if !columns.iter().any(|existing| existing == column) {
    connection
      .execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])
      .map_err(|error| format!("failed to add {table}.{column}: {error}"))?;
  }
  Ok(())
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
    let fact_updated_at = str_field(fact, "updatedAt");
    let fact_created_at = optional_str_field(fact, "createdAt")
      .filter(|value| !value.is_empty())
      .unwrap_or_else(|| fact_updated_at.clone());
    let fact_approved_at = optional_str_field(fact, "approvedAt")
      .filter(|value| !value.is_empty())
      .unwrap_or_else(|| fact_updated_at.clone());
    transaction
      .execute(
        "INSERT INTO facts (
          id, fact_text, domain, fact_type, source_ids, sensitivity, confidence,
          status, valid_from, valid_until, due_date, created_at, approved_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
          fact_created_at,
          fact_approved_at,
          fact_updated_at
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

fn parse_json_string_array(value: String) -> Vec<String> {
  serde_json::from_str::<Vec<String>>(&value).unwrap_or_default()
}

fn fts_query_from_user_input(query: &str) -> Option<String> {
  let terms = query
    .split_whitespace()
    .map(|term| term.trim_matches(|character: char| character.is_ascii_punctuation()))
    .filter(|term| !term.is_empty())
    .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
    .collect::<Vec<_>>();
  if terms.is_empty() {
    None
  } else {
    Some(terms.join(" AND "))
  }
}

fn row_to_native_fact_search_result(
  row: &rusqlite::Row<'_>,
) -> rusqlite::Result<NativeFactSearchResult> {
  let source_ids_json: String = row.get("source_ids")?;
  Ok(NativeFactSearchResult {
    id: row.get("id")?,
    fact_text: row.get("fact_text")?,
    domain: row.get("domain")?,
    fact_type: row.get("fact_type")?,
    source_ids: parse_json_string_array(source_ids_json),
    sensitivity: row.get("sensitivity")?,
    confidence: row.get("confidence")?,
    status: row.get("status")?,
    valid_from: row.get("valid_from")?,
    valid_until: row.get("valid_until")?,
    due_date: row.get("due_date")?,
    created_at: row.get("created_at")?,
    approved_at: row.get("approved_at")?,
    updated_at: row.get("updated_at")?,
    rank: row.get("rank")?,
  })
}

fn search_facts_in_connection(
  connection: &Connection,
  query: &str,
  domain: Option<&str>,
  sensitivity: Option<&str>,
  limit: i64,
) -> Result<Vec<NativeFactSearchResult>, String> {
  let limit = limit.clamp(1, 200);
  let domain = domain.filter(|value| !value.is_empty() && *value != "all");
  let sensitivity = sensitivity.filter(|value| !value.is_empty() && *value != "all");

  if let Some(fts_query) = fts_query_from_user_input(query) {
    let mut statement = connection
      .prepare(
        "SELECT
           f.id,
           f.fact_text,
           f.domain,
           f.fact_type,
           f.source_ids,
           f.sensitivity,
           f.confidence,
           f.status,
           f.valid_from,
           f.valid_until,
           f.due_date,
           f.created_at,
           f.approved_at,
           f.updated_at,
           bm25(facts_fts) AS rank
         FROM facts_fts
         JOIN facts f ON f.id = facts_fts.fact_id
         WHERE facts_fts MATCH ?1
           AND f.status = 'active'
           AND (?2 IS NULL OR f.domain = ?2)
           AND (?3 IS NULL OR f.sensitivity = ?3)
         ORDER BY rank ASC, f.updated_at DESC
         LIMIT ?4",
      )
      .map_err(|error| format!("failed to prepare FTS fact search: {error}"))?;
    let results = statement
      .query_map(params![fts_query, domain, sensitivity, limit], row_to_native_fact_search_result)
      .map_err(|error| format!("failed to run FTS fact search: {error}"))?
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("failed to collect FTS fact search results: {error}"));
    return results;
  }

  let mut statement = connection
    .prepare(
      "SELECT
         id,
         fact_text,
         domain,
         fact_type,
         source_ids,
         sensitivity,
         confidence,
         status,
         valid_from,
         valid_until,
         due_date,
         created_at,
         approved_at,
         updated_at,
         0.0 AS rank
       FROM facts
       WHERE status = 'active'
         AND (?1 IS NULL OR domain = ?1)
         AND (?2 IS NULL OR sensitivity = ?2)
       ORDER BY updated_at DESC
       LIMIT ?3",
    )
    .map_err(|error| format!("failed to prepare fact search: {error}"))?;
  let results = statement
    .query_map(params![domain, sensitivity, limit], row_to_native_fact_search_result)
    .map_err(|error| format!("failed to run fact search: {error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("failed to collect fact search results: {error}"));
  results
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

fn system_time_seconds(time: SystemTime) -> u64 {
  time
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs())
    .unwrap_or_default()
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

fn claude_desktop_config_path() -> Result<PathBuf, String> {
  #[cfg(target_os = "macos")]
  {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    return Ok(PathBuf::from(home)
      .join("Library")
      .join("Application Support")
      .join("Claude")
      .join("claude_desktop_config.json"));
  }

  #[cfg(target_os = "windows")]
  {
    let appdata = env::var("APPDATA").map_err(|_| "APPDATA is not set".to_string())?;
    return Ok(PathBuf::from(appdata)
      .join("Claude")
      .join("claude_desktop_config.json"));
  }

  #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
  {
    let base = env::var("XDG_CONFIG_HOME")
      .map(PathBuf::from)
      .or_else(|_| env::var("HOME").map(|home| PathBuf::from(home).join(".config")))
      .map_err(|_| "Neither XDG_CONFIG_HOME nor HOME is set".to_string())?;
    Ok(base.join("Claude").join("claude_desktop_config.json"))
  }
}

fn life_context_claude_server_config(app: &AppHandle) -> Result<Value, String> {
  let command = mcp_stdio::resolve_sibling_binary("lcv-mcp");
  if !command.exists() {
    return Err(format!(
      "lcv-mcp was not found at {}. Build or bundle the sidecars before installing Claude Desktop config.",
      command.display()
    ));
  }
  Ok(life_context_claude_server_config_for_paths(
    command,
    vault_db_path(app)?,
  ))
}

fn life_context_claude_server_config_for_paths(command: PathBuf, vault_path: PathBuf) -> Value {
  json!({
    "type": "stdio",
    "command": command.display().to_string(),
    "env": {
      "LCV_VAULT_DB_PATH": vault_path.display().to_string()
    }
  })
}

fn merge_claude_desktop_config(
  mut existing: Value,
  server_config: Value,
) -> Result<(Value, bool), String> {
  let root = existing
    .as_object_mut()
    .ok_or_else(|| "Claude Desktop config must be a JSON object".to_string())?;
  let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
  let server_map = servers
    .as_object_mut()
    .ok_or_else(|| "Claude Desktop config field mcpServers must be a JSON object".to_string())?;
  let changed = server_map.get("life-context-vault") != Some(&server_config);
  server_map.insert("life-context-vault".to_string(), server_config);
  Ok((existing, changed))
}

#[tauri::command]
fn install_claude_desktop_config(
  app: AppHandle,
) -> Result<ClaudeDesktopConfigInstallResult, String> {
  let config_path = claude_desktop_config_path()?;
  let server_config = life_context_claude_server_config(&app)?;
  let existing = if config_path.exists() {
    let raw = fs::read_to_string(&config_path)
      .map_err(|error| format!("failed to read Claude Desktop config: {error}"))?;
    serde_json::from_str::<Value>(&raw).map_err(|error| {
      format!("Claude Desktop config is not valid JSON; no changes were made: {error}")
    })?
  } else {
    json!({})
  };
  let (next_config, changed) = merge_claude_desktop_config(existing, server_config)?;

  if !changed {
    return Ok(ClaudeDesktopConfigInstallResult {
      config_path: config_path.display().to_string(),
      backup_path: None,
      server_name: "life-context-vault".to_string(),
      already_configured: true,
    });
  }

  if let Some(parent) = config_path.parent() {
    fs::create_dir_all(parent)
      .map_err(|error| format!("failed to create Claude config directory: {error}"))?;
  }

  let backup_path = if config_path.exists() {
    let backup = config_path.with_file_name(format!(
      "claude_desktop_config.json.lcv-backup-{}.json",
      system_time_seconds(SystemTime::now())
    ));
    fs::copy(&config_path, &backup)
      .map_err(|error| format!("failed to back up Claude Desktop config: {error}"))?;
    Some(backup)
  } else {
    None
  };

  let payload = serde_json::to_string_pretty(&next_config)
    .map_err(|error| format!("failed to serialize Claude Desktop config: {error}"))?;
  let temp_path = config_path.with_file_name("claude_desktop_config.json.lcv.tmp");
  fs::write(&temp_path, payload)
    .map_err(|error| format!("failed to write Claude Desktop config temp file: {error}"))?;
  #[cfg(target_os = "windows")]
  {
    if config_path.exists() {
      fs::remove_file(&config_path)
        .map_err(|error| format!("failed to replace Claude Desktop config: {error}"))?;
    }
  }
  fs::rename(&temp_path, &config_path)
    .map_err(|error| format!("failed to install Claude Desktop config: {error}"))?;

  Ok(ClaudeDesktopConfigInstallResult {
    config_path: config_path.display().to_string(),
    backup_path: backup_path.map(|path| path.display().to_string()),
    server_name: "life-context-vault".to_string(),
    already_configured: false,
  })
}

#[tauri::command]
fn claude_desktop_config_template(app: AppHandle) -> Result<String, String> {
  let config = json!({
    "mcpServers": {
      "life-context-vault": life_context_claude_server_config(&app)?
    }
  });
  serde_json::to_string_pretty(&config)
    .map_err(|error| format!("failed to serialize Claude Desktop config: {error}"))
}

fn validate_chrome_extension_id(extension_id: &str) -> Result<String, String> {
  let normalized = extension_id.trim().to_ascii_lowercase();
  let valid = normalized.len() == 32
    && normalized
      .chars()
      .all(|character| ('a'..='p').contains(&character));
  if valid {
    Ok(normalized)
  } else {
    Err(
      "Chrome extension id must be the 32-character id shown after loading browser-extension/ unpacked."
        .to_string(),
    )
  }
}

fn chrome_capture_host_manifest_path() -> Result<PathBuf, String> {
  #[cfg(target_os = "macos")]
  {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    return Ok(PathBuf::from(home)
      .join("Library")
      .join("Application Support")
      .join("Google")
      .join("Chrome")
      .join("NativeMessagingHosts")
      .join(format!("{CAPTURE_HOST_NAME}.json")));
  }

  #[cfg(target_os = "linux")]
  {
    let base = env::var("XDG_CONFIG_HOME")
      .map(PathBuf::from)
      .or_else(|_| env::var("HOME").map(|home| PathBuf::from(home).join(".config")))
      .map_err(|_| "Neither XDG_CONFIG_HOME nor HOME is set".to_string())?;
    return Ok(base
      .join("google-chrome")
      .join("NativeMessagingHosts")
      .join(format!("{CAPTURE_HOST_NAME}.json")));
  }

  #[cfg(target_os = "windows")]
  {
    Err(
      "Chrome Native Messaging host installation is not implemented on Windows yet; \
       use Chrome registry setup manually."
        .to_string(),
    )
  }
}

fn capture_host_binary_path() -> Result<PathBuf, String> {
  let command = mcp_stdio::resolve_sibling_binary("lcv-capture-host");
  if !command.exists() {
    return Err(format!(
      "lcv-capture-host was not found at {}. Build or bundle the sidecars before installing \
       the browser capture host.",
      command.display()
    ));
  }
  Ok(command)
}

fn capture_host_manifest_for_paths(extension_id: &str, host_path: PathBuf) -> Value {
  json!({
    "name": CAPTURE_HOST_NAME,
    "description": "Life Context Vault browser capture native host",
    "path": host_path.display().to_string(),
    "type": "stdio",
    "allowed_origins": [format!("chrome-extension://{extension_id}/")]
  })
}

fn xml_escape(value: &str) -> String {
  value
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
    .replace('\'', "&apos;")
}

fn login_item_plist_for_path(label: &str, program_path: &PathBuf) -> String {
  let label = xml_escape(label);
  let program_path = xml_escape(&program_path.display().to_string());
  format!(
    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{program_path}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
"#
  )
}

fn login_item_plist_path() -> Result<PathBuf, String> {
  #[cfg(target_os = "macos")]
  {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    return Ok(PathBuf::from(home)
      .join("Library")
      .join("LaunchAgents")
      .join(format!("{LOGIN_ITEM_LABEL}.plist")));
  }

  #[cfg(not(target_os = "macos"))]
  {
    Err("Login item installation is currently implemented for macOS only.".to_string())
  }
}

fn current_executable_path() -> Result<PathBuf, String> {
  env::current_exe()
    .map_err(|error| format!("failed to resolve current app executable: {error}"))
}

fn login_item_status_with_backup(backup_path: Option<PathBuf>) -> LoginItemStatus {
  #[cfg(target_os = "macos")]
  {
    let plist_path = match login_item_plist_path() {
      Ok(path) => path,
      Err(error) => {
        return LoginItemStatus {
          supported: false,
          enabled: false,
          plist_path: None,
          program_path: None,
          label: LOGIN_ITEM_LABEL.to_string(),
          backup_path: backup_path.map(|path| path.display().to_string()),
          last_error: Some(error),
        };
      }
    };
    let program_path = match current_executable_path() {
      Ok(path) => path,
      Err(error) => {
        return LoginItemStatus {
          supported: true,
          enabled: plist_path.exists(),
          plist_path: Some(plist_path.display().to_string()),
          program_path: None,
          label: LOGIN_ITEM_LABEL.to_string(),
          backup_path: backup_path.map(|path| path.display().to_string()),
          last_error: Some(error),
        };
      }
    };
    let mut last_error = None;
    let enabled = plist_path.exists();
    if enabled {
      match fs::read_to_string(&plist_path) {
        Ok(raw) => {
          let expected_program = xml_escape(&program_path.display().to_string());
          if !raw.contains(LOGIN_ITEM_LABEL) || !raw.contains(&expected_program) {
            last_error = Some(
              "Login item exists but points to a different app build; reinstall to update it."
                .to_string(),
            );
          }
        }
        Err(error) => {
          last_error = Some(format!("failed to inspect login item plist: {error}"));
        }
      }
    }
    return LoginItemStatus {
      supported: true,
      enabled,
      plist_path: Some(plist_path.display().to_string()),
      program_path: Some(program_path.display().to_string()),
      label: LOGIN_ITEM_LABEL.to_string(),
      backup_path: backup_path.map(|path| path.display().to_string()),
      last_error,
    };
  }

  #[cfg(not(target_os = "macos"))]
  {
    LoginItemStatus {
      supported: false,
      enabled: false,
      plist_path: None,
      program_path: current_executable_path()
        .ok()
        .map(|path| path.display().to_string()),
      label: LOGIN_ITEM_LABEL.to_string(),
      backup_path: backup_path.map(|path| path.display().to_string()),
      last_error: Some(
        "Login item installation is currently implemented for macOS only.".to_string(),
      ),
    }
  }
}

#[tauri::command]
fn install_chrome_capture_host_manifest(
  extension_id: String,
) -> Result<BrowserCaptureHostInstallResult, String> {
  let extension_id = validate_chrome_extension_id(&extension_id)?;
  let manifest_path = chrome_capture_host_manifest_path()?;
  let host_path = capture_host_binary_path()?;
  let manifest = capture_host_manifest_for_paths(&extension_id, host_path.clone());

  let existing = if manifest_path.exists() {
    let raw = fs::read_to_string(&manifest_path)
      .map_err(|error| format!("failed to read Chrome Native Messaging host manifest: {error}"))?;
    serde_json::from_str::<Value>(&raw).ok()
  } else {
    None
  };

  if existing.as_ref() == Some(&manifest) {
    return Ok(BrowserCaptureHostInstallResult {
      manifest_path: manifest_path.display().to_string(),
      backup_path: None,
      host_name: CAPTURE_HOST_NAME.to_string(),
      host_path: host_path.display().to_string(),
      extension_id,
      already_configured: true,
    });
  }

  if let Some(parent) = manifest_path.parent() {
    fs::create_dir_all(parent)
      .map_err(|error| format!("failed to create Chrome Native Messaging host directory: {error}"))?;
  }

  let backup_path = if manifest_path.exists() {
    let backup = manifest_path.with_file_name(format!(
      "{CAPTURE_HOST_NAME}.lcv-backup-{}.json",
      system_time_seconds(SystemTime::now())
    ));
    fs::copy(&manifest_path, &backup)
      .map_err(|error| format!("failed to back up Chrome Native Messaging host manifest: {error}"))?;
    Some(backup)
  } else {
    None
  };

  let payload = serde_json::to_string_pretty(&manifest)
    .map_err(|error| format!("failed to serialize Chrome Native Messaging host manifest: {error}"))?;
  let temp_path = manifest_path.with_file_name(format!("{CAPTURE_HOST_NAME}.json.lcv.tmp"));
  fs::write(&temp_path, payload)
    .map_err(|error| format!("failed to write Chrome Native Messaging host temp file: {error}"))?;
  #[cfg(target_os = "windows")]
  {
    if manifest_path.exists() {
      fs::remove_file(&manifest_path)
        .map_err(|error| format!("failed to replace Chrome Native Messaging host manifest: {error}"))?;
    }
  }
  fs::rename(&temp_path, &manifest_path)
    .map_err(|error| format!("failed to install Chrome Native Messaging host manifest: {error}"))?;

  Ok(BrowserCaptureHostInstallResult {
    manifest_path: manifest_path.display().to_string(),
    backup_path: backup_path.map(|path| path.display().to_string()),
    host_name: CAPTURE_HOST_NAME.to_string(),
    host_path: host_path.display().to_string(),
    extension_id,
    already_configured: false,
  })
}

#[tauri::command]
fn login_item_status() -> Result<LoginItemStatus, String> {
  Ok(login_item_status_with_backup(None))
}

#[tauri::command]
fn install_login_item() -> Result<LoginItemStatus, String> {
  let plist_path = login_item_plist_path()?;
  let program_path = current_executable_path()?;
  let plist = login_item_plist_for_path(LOGIN_ITEM_LABEL, &program_path);

  if plist_path.exists() {
    let existing = fs::read_to_string(&plist_path)
      .map_err(|error| format!("failed to read login item plist: {error}"))?;
    if existing == plist {
      return Ok(login_item_status_with_backup(None));
    }
  }

  if let Some(parent) = plist_path.parent() {
    fs::create_dir_all(parent)
      .map_err(|error| format!("failed to create LaunchAgents directory: {error}"))?;
  }

  let backup_path = if plist_path.exists() {
    let backup = plist_path.with_file_name(format!(
      "{LOGIN_ITEM_LABEL}.lcv-backup-{}.plist",
      system_time_seconds(SystemTime::now())
    ));
    fs::copy(&plist_path, &backup)
      .map_err(|error| format!("failed to back up login item plist: {error}"))?;
    Some(backup)
  } else {
    None
  };

  let temp_path = plist_path.with_file_name(format!("{LOGIN_ITEM_LABEL}.plist.lcv.tmp"));
  fs::write(&temp_path, plist)
    .map_err(|error| format!("failed to write login item temp file: {error}"))?;
  fs::rename(&temp_path, &plist_path)
    .map_err(|error| format!("failed to install login item plist: {error}"))?;
  Ok(login_item_status_with_backup(backup_path))
}

#[tauri::command]
fn uninstall_login_item() -> Result<LoginItemStatus, String> {
  let plist_path = login_item_plist_path()?;
  if plist_path.exists() {
    fs::remove_file(&plist_path)
      .map_err(|error| format!("failed to remove login item plist: {error}"))?;
  }
  Ok(login_item_status_with_backup(None))
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
fn search_vault_facts(
  app: AppHandle,
  query: String,
  domain: Option<String>,
  sensitivity: Option<String>,
  limit: Option<i64>,
) -> Result<Vec<NativeFactSearchResult>, String> {
  let connection = open_vault_db(&app)?;
  search_facts_in_connection(
    &connection,
    &query,
    domain.as_deref(),
    sensitivity.as_deref(),
    limit.unwrap_or(80),
  )
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
      search_vault_facts,
      ai_access_service_status,
      start_ai_access_services,
      stop_ai_access_services,
      install_claude_desktop_config,
      claude_desktop_config_template,
      install_chrome_capture_host_manifest,
      login_item_status,
      install_login_item,
      uninstall_login_item
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
  fn native_fact_search_returns_only_active_approved_facts() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_vault_schema(&connection).expect("schema");

    let payload = r#"
    {
      "version": 2,
      "sources": [],
      "candidates": [
        {
          "id": "cand_secret",
          "sourceIds": [],
          "proposedFactText": "Secret passport token should not appear.",
          "domain": "identity_and_profile",
          "candidateType": "identity",
          "detectedSensitivity": "secret_never_send",
          "confidence": "medium",
          "status": "new",
          "createdAt": "2026-06-12T00:00:00.000Z"
        }
      ],
      "facts": [
        {
          "id": "fact_active",
          "factText": "Need to update address before moving.",
          "domain": "home_and_places",
          "factType": "obligation",
          "sourceIds": ["src_address"],
          "sensitivity": "personal",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-11T00:00:00.000Z",
          "approvedAt": "2026-06-11T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:00:00.000Z"
        },
        {
          "id": "fact_deleted",
          "factText": "Deleted address item.",
          "domain": "home_and_places",
          "factType": "note",
          "sourceIds": [],
          "sensitivity": "personal",
          "confidence": "source_backed",
          "status": "deleted",
          "createdAt": "2026-06-10T00:00:00.000Z",
          "approvedAt": "2026-06-10T00:10:00.000Z",
          "updatedAt": "2026-06-10T00:00:00.000Z"
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
    let results = search_facts_in_connection(
      &connection,
      "address",
      Some("home_and_places"),
      Some("personal"),
      20,
    )
    .expect("search");

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "fact_active");
    assert_eq!(results[0].source_ids, vec!["src_address"]);
  }

  #[test]
  fn native_fact_search_escapes_fts_syntax_from_user_input() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_vault_schema(&connection).expect("schema");

    let payload = r#"
    {
      "version": 2,
      "sources": [],
      "candidates": [],
      "facts": [
        {
          "id": "fact_phrase",
          "factText": "Insurance renewal is due in September.",
          "domain": "contracts_and_policies",
          "factType": "deadline",
          "sourceIds": [],
          "sensitivity": "private_consequential",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
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
    let results =
      search_facts_in_connection(&connection, "insurance OR passport", None, None, 20)
        .expect("search");

    assert_eq!(results.len(), 0);
    assert_eq!(
      fts_query_from_user_input("insurance OR passport").as_deref(),
      Some("\"insurance\" AND \"OR\" AND \"passport\"")
    );
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

  #[test]
  fn claude_config_merge_preserves_existing_servers() {
    let existing = json!({
      "mcpServers": {
        "other-server": {
          "command": "/usr/bin/other"
        }
      },
      "theme": "system"
    });
    let server = life_context_claude_server_config_for_paths(
      PathBuf::from("/Applications/Life Context Vault.app/Contents/MacOS/lcv-mcp"),
      PathBuf::from(
        "/Users/example/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3",
      ),
    );

    let (merged, changed) = merge_claude_desktop_config(existing, server).expect("merge");

    assert!(changed);
    assert!(merged
      .get("mcpServers")
      .and_then(Value::as_object)
      .and_then(|servers| servers.get("other-server"))
      .is_some());
    assert!(merged
      .get("mcpServers")
      .and_then(Value::as_object)
      .and_then(|servers| servers.get("life-context-vault"))
      .is_some());
    assert_eq!(merged.get("theme").and_then(Value::as_str), Some("system"));
  }

  #[test]
  fn chrome_extension_id_validation_accepts_chrome_ids_only() {
    assert_eq!(
      validate_chrome_extension_id("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP").as_deref(),
      Ok("abcdefghijklmnopabcdefghijklmnop")
    );
    assert!(validate_chrome_extension_id("REPLACE_WITH_EXTENSION_ID").is_err());
    assert!(validate_chrome_extension_id("abcdefghijklmnopabcdefghijklmn0p").is_err());
    assert!(validate_chrome_extension_id("abcdefghijklmnop").is_err());
  }

  #[test]
  fn capture_host_manifest_uses_native_messaging_boundary() {
    let manifest = capture_host_manifest_for_paths(
      "abcdefghijklmnopabcdefghijklmnop",
      PathBuf::from("/Applications/Life Context Vault.app/Contents/MacOS/lcv-capture-host"),
    );

    assert_eq!(manifest.get("name").and_then(Value::as_str), Some(CAPTURE_HOST_NAME));
    assert_eq!(manifest.get("type").and_then(Value::as_str), Some("stdio"));
    assert_eq!(
      manifest
        .get("allowed_origins")
        .and_then(Value::as_array)
        .and_then(|origins| origins.first())
        .and_then(Value::as_str),
      Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop/")
    );
    assert!(manifest
      .get("path")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .ends_with("lcv-capture-host"));
  }

  #[test]
  fn login_item_plist_runs_only_the_current_app_binary() {
    let plist = login_item_plist_for_path(
      LOGIN_ITEM_LABEL,
      &PathBuf::from("/Applications/Life Context Vault.app/Contents/MacOS/life-context-vault"),
    );

    assert!(plist.contains(LOGIN_ITEM_LABEL));
    assert!(plist.contains("<key>ProgramArguments</key>"));
    assert!(plist.contains(
      "/Applications/Life Context Vault.app/Contents/MacOS/life-context-vault"
    ));
    assert!(plist.contains("<key>RunAtLoad</key>"));
    assert!(plist.contains("<true/>"));
    assert!(plist.contains("<key>KeepAlive</key>"));
    assert!(plist.contains("<false/>"));
    assert!(!plist.contains("LCV_VAULT_DB_KEY"));
    assert!(!plist.contains("ContextPack"));
  }

  #[test]
  fn login_item_plist_escapes_xml_values() {
    let plist = login_item_plist_for_path(
      "dev.life-context-vault.ai-access",
      &PathBuf::from("/Applications/Life & Context <Vault>.app/Contents/MacOS/life-context-vault"),
    );

    assert!(plist.contains("Life &amp; Context &lt;Vault&gt;.app"));
  }
}
