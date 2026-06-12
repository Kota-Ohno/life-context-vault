use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
  collections::HashSet,
  env,
  fs,
  io::{Read, Write},
  net::TcpStream,
  path::{Path, PathBuf},
  process::{Child, Command, Stdio},
  sync::Mutex,
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{ActivationPolicy, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

mod mcp_stdio;
mod vault_crypto;

const VAULT_STATE_KEY: &str = "vault_state";
const PROJECTION_STATE_KEY: &str = "vault_state_updated_at";
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

#[derive(Clone, Serialize)]
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeContextPackBuildResult {
  payload: String,
  updated_at: Option<String>,
  request_id: String,
  pack_id: Option<String>,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeContextPackMutationResult {
  payload: String,
  updated_at: Option<String>,
  request_id: Option<String>,
  pack_id: Option<String>,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSourceIngestResult {
  payload: String,
  updated_at: Option<String>,
  source_id: String,
  candidate_ids: Vec<String>,
  detected_sensitivity: String,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCandidateReviewResult {
  payload: String,
  updated_at: Option<String>,
  candidate_id: String,
  status: String,
  fact_id: Option<String>,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePassiveCaptureResult {
  payload: String,
  updated_at: Option<String>,
  accepted: bool,
  status: String,
  message: String,
  event_id: Option<String>,
  source_id: Option<String>,
  candidate_ids: Vec<String>,
  detected_sensitivity: String,
  retention_until: Option<String>,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeVaultSettingsUpdateResult {
  payload: String,
  updated_at: Option<String>,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSourceLifecycleResult {
  payload: String,
  updated_at: Option<String>,
  source_id: String,
  action: String,
  affected_candidate_count: usize,
  affected_fact_count: usize,
  invalidated_pack_count: usize,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSourceMetadataResult {
  payload: String,
  updated_at: Option<String>,
  source_id: String,
  invalidated_pack_count: usize,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFactLifecycleResult {
  payload: String,
  updated_at: Option<String>,
  fact_id: String,
  action: String,
  status: String,
  invalidated_pack_count: usize,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFactMetadataResult {
  payload: String,
  updated_at: Option<String>,
  fact_id: String,
  invalidated_pack_count: usize,
  generated_by: String,
}

pub struct VaultCoreContextPackResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub request_id: String,
  pub pack_id: String,
  pub request_status: String,
  pub expires_at: String,
  pub max_sensitivity_included: String,
  pub confirmation_status: String,
  pub context_pack: Option<Value>,
}

pub struct VaultCoreContextPackMutationResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub request_id: Option<String>,
  pub pack_id: Option<String>,
}

pub struct VaultCoreMemoryProposalResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub status: String,
  pub candidate_id: String,
  pub source_id: String,
  pub detected_sensitivity: String,
}

pub struct VaultCoreSourceIngestResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub source_id: String,
  pub candidate_ids: Vec<String>,
  pub detected_sensitivity: String,
}

pub struct VaultCoreCandidateReviewResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub candidate_id: String,
  pub status: String,
  pub fact_id: Option<String>,
}

pub struct VaultCorePassiveCaptureResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub accepted: bool,
  pub status: String,
  pub message: String,
  pub event_id: Option<String>,
  pub source_id: Option<String>,
  pub candidate_ids: Vec<String>,
  pub detected_sensitivity: String,
  pub retention_until: Option<String>,
}

pub struct VaultCoreSettingsUpdateResult {
  pub payload: String,
  pub updated_at: Option<String>,
}

pub struct VaultCoreSourceLifecycleResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub source_id: String,
  pub action: String,
  pub affected_candidate_count: usize,
  pub affected_fact_count: usize,
  pub invalidated_pack_count: usize,
}

pub struct VaultCoreSourceMetadataResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub source_id: String,
  pub invalidated_pack_count: usize,
}

pub struct VaultCoreFactLifecycleResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub fact_id: String,
  pub action: String,
  pub status: String,
  pub invalidated_pack_count: usize,
}

pub struct VaultCoreFactMetadataResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub fact_id: String,
  pub invalidated_pack_count: usize,
}

pub struct VaultCoreRequestStatusResult {
  pub status: String,
  pub request_id: String,
  pub expires_at: Option<String>,
  pub context_pack: Option<Value>,
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
  open_vault_db_at_path(&path)
}

fn open_vault_db_at_path(path: &Path) -> Result<Connection, String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)
      .map_err(|error| format!("failed to create vault database directory: {error}"))?;
  }
  let mut connection = vault_crypto::open_encrypted_vault_connection(path)?;
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
  sync_normalized_tables_if_stale(&mut connection)?;
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

      CREATE TABLE IF NOT EXISTS projection_state (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO schema_versions (component, version, updated_at)
      VALUES ('vault_core', 2, CURRENT_TIMESTAMP)
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

fn sync_normalized_tables_if_stale(connection: &mut Connection) -> Result<(), String> {
  let snapshot = load_vault_state_snapshot_from_connection(connection)?;
  let Some(payload) = snapshot.payload else {
    return Ok(());
  };
  let Some(updated_at) = snapshot.updated_at else {
    return Ok(());
  };

  let projected_updated_at = connection
    .query_row(
      "SELECT value FROM projection_state WHERE key = ?1",
      params![PROJECTION_STATE_KEY],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("failed to read projection state: {error}"))?;
  if projected_updated_at.as_deref() == Some(updated_at.as_str()) {
    return Ok(());
  }

  sync_normalized_tables(connection, &payload)?;
  mark_projection_synced(connection, &updated_at)
}

fn mark_projection_synced(connection: &Connection, updated_at: &str) -> Result<(), String> {
  connection
    .execute(
      "INSERT INTO projection_state (key, value, updated_at)
       VALUES (?1, ?2, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP",
      params![PROJECTION_STATE_KEY, updated_at],
    )
    .map(|_| ())
    .map_err(|error| format!("failed to update projection state: {error}"))
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

fn optional_value(value: &Value, key: &str) -> Value {
  value.get(key).cloned().unwrap_or(Value::Null)
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

fn create_native_context_pack_request_in_connection(
  connection: &Connection,
  vault: &mut Value,
  client_id: &str,
  client_name: &str,
  task_text: &str,
  purpose: Option<&str>,
  sensitivity_ceiling: Option<&str>,
  approval_mode: Option<&str>,
) -> Result<(String, String), String> {
  let task_text = task_text.trim();
  if task_text.is_empty() {
    return Err("taskText is required.".to_string());
  }

  let now = now_iso();
  let expires_at = minutes_from_now(10);
  let request_id = new_id("req");
  let pack_id = new_id("pack");
  let task_domain = classify_domain(task_text);
  let ceiling = sensitivity_ceiling
    .filter(|value| !value.trim().is_empty())
    .map(ToString::to_string)
    .unwrap_or_else(|| policy_ceiling_for_client(vault, client_id));
  let approval_mode = approval_mode.unwrap_or("explicit_sensitive");
  let facts = rank_context_facts_in_connection(connection, task_text, &ceiling, 24)?;
  let mut items = Vec::new();
  let mut excluded_items = Vec::new();
  let mut source_snippets = Vec::new();

  for fact in facts {
    if fact.sensitivity == "secret_never_send" {
      excluded_items.push(json!({
        "referencedId": fact.id,
        "reason": "secret_never_send"
      }));
      continue;
    }
    if sensitivity_rank(&fact.sensitivity) > sensitivity_rank(&ceiling) {
      excluded_items.push(json!({
        "referencedId": fact.id,
        "reason": "sensitivity_policy"
      }));
      continue;
    }
    if fact.status != "active" {
      excluded_items.push(json!({
        "referencedId": fact.id,
        "reason": match fact.status.as_str() {
          "expired" => "expired",
          "deleted" => "deleted",
          _ => "user_hidden"
        }
      }));
      continue;
    }
    if fact
      .valid_until
      .as_deref()
      .map(is_expired)
      .unwrap_or(false)
    {
      excluded_items.push(json!({
        "referencedId": fact.id,
        "reason": "expired"
      }));
      continue;
    }

    let source_titles = source_titles_in_connection(connection, &fact.source_ids, &ceiling)?;
    let snippet = source_snippet_for_fact(connection, &fact, &ceiling)?;
    items.push(json!({
      "id": new_id("ctxitem"),
      "factId": fact.id.clone(),
      "itemText": fact.fact_text.clone(),
      "reasonIncluded": if fact.domain == task_domain {
        "質問の領域と一致しています。"
      } else {
        "本人の背景情報として回答を調整できます。"
      },
      "sensitivity": fact.sensitivity.clone(),
      "sourceTitles": source_titles,
      "validFrom": fact.valid_from.clone(),
      "validUntil": fact.valid_until.clone(),
      "confidence": fact.confidence.clone()
    }));

    if let Some(snippet) = snippet {
      source_snippets.push(snippet);
    }
  }

  let max_sensitivity_included = items
    .iter()
    .filter_map(|item| item.get("sensitivity").and_then(Value::as_str))
    .max_by_key(|sensitivity| sensitivity_rank(sensitivity))
    .unwrap_or("public")
    .to_string();
  let warnings = context_pack_warnings(connection, &items, &excluded_items)?;
  let requires_confirmation = approval_mode == "always_review"
    || sensitivity_rank(&max_sensitivity_included) >= sensitivity_rank("private_consequential");
  let confirmation_status = if requires_confirmation {
    "pending_user_confirmation"
  } else {
    "not_required"
  };
  let request_status = if requires_confirmation {
    "pending_user_confirmation"
  } else {
    "fulfilled"
  };

  let request = json!({
    "id": request_id,
    "clientId": client_id,
    "clientName": client_name,
    "taskText": task_text,
    "purpose": purpose.unwrap_or("Answer with user-approved life context"),
    "requestedDomains": [task_domain],
    "sensitivityCeiling": ceiling,
    "approvalMode": approval_mode,
    "createdAt": now,
    "expiresAt": expires_at,
    "status": request_status
  });
  let pack = json!({
    "id": pack_id,
    "requestId": request_id,
    "taskText": task_text,
    "taskDomain": task_domain,
    "riskLevel": classify_risk(task_text),
    "generatedAt": now,
    "expiresAt": expires_at,
    "maxSensitivityIncluded": max_sensitivity_included,
    "items": items,
    "sourceSnippets": source_snippets,
    "excludedItems": excluded_items,
    "warnings": warnings,
    "confirmationStatus": confirmation_status
  });

  push_json_array(vault, "contextPackRequests", request);
  push_json_array(vault, "contextPacks", pack);
  touch_connector_in_vault(vault, client_id, &now);
  push_json_array(
    vault,
    "auditEvents",
    audit_event(
      "context_pack_requested",
      "context_pack_request",
      &request_id,
      &ceiling,
      json!({
        "clientName": client_name,
        "purpose": purpose.unwrap_or("Answer with user-approved life context"),
        "generatedBy": "native_vault_core"
      }),
    ),
  );
  push_json_array(
    vault,
    "auditEvents",
    audit_event(
      "context_pack_generated",
      "context_pack",
      &pack_id,
      &max_sensitivity_included,
      json!({
        "requestId": request_id,
        "itemCount": vault
          .get("contextPacks")
          .and_then(Value::as_array)
          .and_then(|packs| packs.first())
          .and_then(|pack| pack.get("items"))
          .and_then(Value::as_array)
          .map(|items| items.len())
          .unwrap_or(0),
        "generatedBy": "native_vault_core"
      }),
    ),
  );

  Ok((request_id, pack_id))
}

pub fn create_context_pack_request_at_path(
  path: &Path,
  client_id: &str,
  client_name: &str,
  task_text: &str,
  purpose: Option<&str>,
  sensitivity_ceiling: Option<&str>,
  approval_mode: Option<&str>,
) -> Result<VaultCoreContextPackResult, String> {
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let (request_id, pack_id) = create_native_context_pack_request_in_connection(
    &connection,
    &mut vault,
    client_id,
    client_name,
    task_text,
    purpose,
    sensitivity_ceiling,
    approval_mode,
  )?;
  let request = find_vault_item_by_id(&vault, "contextPackRequests", &request_id)
    .ok_or_else(|| format!("created ContextPackRequest was not found: {request_id}"))?;
  let pack = find_vault_item_by_id(&vault, "contextPacks", &pack_id)
    .ok_or_else(|| format!("created ContextPack was not found: {pack_id}"))?;
  let request_status = str_field(&request, "status");
  let expires_at = str_field(&request, "expiresAt");
  let max_sensitivity_included = str_field(&pack, "maxSensitivityIncluded");
  let confirmation_status = str_field(&pack, "confirmationStatus");
  let context_pack = if confirmation_status == "not_required" || confirmation_status == "confirmed" {
    Some(safe_context_pack_for_client(&pack))
  } else {
    None
  };

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;

  Ok(VaultCoreContextPackResult {
    payload,
    updated_at,
    request_id,
    pack_id,
    request_status,
    expires_at,
    max_sensitivity_included,
    confirmation_status,
    context_pack,
  })
}

pub fn update_context_pack_item_visibility_at_path(
  path: &Path,
  pack_id: &str,
  fact_id: &str,
  included: bool,
) -> Result<VaultCoreContextPackMutationResult, String> {
  let pack_id = pack_id.trim();
  let fact_id = fact_id.trim();
  if pack_id.is_empty() {
    return Err("packId is required.".to_string());
  }
  if fact_id.is_empty() {
    return Err("factId is required.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let pack = find_vault_item_by_id(&vault, "contextPacks", pack_id)
    .ok_or_else(|| format!("ContextPack was not found: {pack_id}"))?;
  ensure_pack_can_be_edited(&mut vault, &pack)?;
  let request_id = optional_str_field(&pack, "requestId");
  let ceiling = request_id
    .as_deref()
    .and_then(|id| find_vault_item_by_id(&vault, "contextPackRequests", id))
    .map(|request| str_field(&request, "sensitivityCeiling"))
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| str_field(&pack, "maxSensitivityIncluded"));
  let ceiling = sensitivity_tier(&ceiling)?;

  let next_pack = if included {
    restore_fact_to_context_pack(&connection, &pack, fact_id, ceiling)?
  } else {
    remove_fact_from_context_pack(&connection, &pack, fact_id, ceiling)?
  };
  let changed = next_pack != pack;
  if changed {
    replace_vault_item_by_id(&mut vault, "contextPacks", pack_id, next_pack.clone())?;
    if let Some(request_id) = request_id.as_deref() {
      set_context_request_status(&mut vault, request_id, "pending_user_confirmation");
    }
    push_json_array(
      &mut vault,
      "auditEvents",
      audit_event(
        "context_pack_updated",
        "context_pack",
        pack_id,
        &str_field(&next_pack, "maxSensitivityIncluded"),
        json!({
          "requestId": request_id,
          "factId": fact_id,
          "action": if included { "restored_item" } else { "excluded_item" },
          "itemCount": next_pack.get("items").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
          "excludedCount": next_pack.get("excludedItems").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
          "generatedBy": "native_vault_core"
        }),
      ),
    );
  }

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreContextPackMutationResult {
    payload,
    updated_at,
    request_id,
    pack_id: Some(pack_id.to_string()),
  })
}

pub fn confirm_context_pack_at_path(
  path: &Path,
  pack_id: &str,
) -> Result<VaultCoreContextPackMutationResult, String> {
  let pack_id = pack_id.trim();
  if pack_id.is_empty() {
    return Err("packId is required.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let pack = find_vault_item_by_id(&vault, "contextPacks", pack_id)
    .ok_or_else(|| format!("ContextPack was not found: {pack_id}"))?;
  if str_field(&pack, "confirmationStatus") == "cancelled" {
    return Err("cancelled ContextPacks cannot be confirmed.".to_string());
  }
  ensure_pack_not_expired(&mut vault, &pack)?;
  let request_id = optional_str_field(&pack, "requestId");
  let now = now_iso();
  mutate_vault_item_by_id(&mut vault, "contextPacks", pack_id, |pack| {
    pack["confirmationStatus"] = Value::String("confirmed".to_string());
    pack["confirmedAt"] = Value::String(now.clone());
  })?;
  if let Some(request_id) = request_id.as_deref() {
    set_context_request_status(&mut vault, request_id, "fulfilled");
  }
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "context_pack_confirmed",
      "context_pack",
      pack_id,
      &str_field(&pack, "maxSensitivityIncluded"),
      json!({
        "requestId": request_id,
        "generatedBy": "native_vault_core"
      }),
    ),
  );
  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreContextPackMutationResult {
    payload,
    updated_at,
    request_id,
    pack_id: Some(pack_id.to_string()),
  })
}

pub fn deny_context_pack_request_at_path(
  path: &Path,
  request_id: &str,
) -> Result<VaultCoreContextPackMutationResult, String> {
  let request_id = request_id.trim();
  if request_id.is_empty() {
    return Err("requestId is required.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let request = find_vault_item_by_id(&vault, "contextPackRequests", request_id)
    .ok_or_else(|| format!("ContextPackRequest was not found: {request_id}"))?;
  set_context_request_status(&mut vault, request_id, "denied");
  let pack_id = cancel_context_packs_for_request(&mut vault, request_id);
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "context_pack_denied",
      "context_pack_request",
      request_id,
      &str_field(&request, "sensitivityCeiling"),
      json!({
        "clientName": str_field(&request, "clientName"),
        "generatedBy": "native_vault_core"
      }),
    ),
  );
  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreContextPackMutationResult {
    payload,
    updated_at,
    request_id: Some(request_id.to_string()),
    pack_id,
  })
}

fn load_vault_json_from_connection(connection: &Connection) -> Result<Value, String> {
  let snapshot = load_vault_state_snapshot_from_connection(connection)?;
  Ok(snapshot
    .payload
    .as_deref()
    .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
    .unwrap_or_else(empty_vault_json))
}

fn save_vault_json_with_projection(
  connection: &mut Connection,
  vault: &Value,
) -> Result<(String, Option<String>), String> {
  let payload = vault.to_string();
  let save_result = save_vault_state_payload(connection, &payload, None)?;
  let saved_snapshot = load_vault_state_snapshot_from_connection(connection)?;
  Ok((saved_snapshot.payload.unwrap_or(payload), save_result.updated_at))
}

pub fn propose_memory_at_path(
  path: &Path,
  client_id: &str,
  client_name: &str,
  origin: &str,
  text: &str,
) -> Result<VaultCoreMemoryProposalResult, String> {
  let text = text.trim();
  if text.is_empty() {
    return Err("text is required.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let now = now_iso();
  let source_id = new_id("src");
  let candidate_id = new_id("cand");
  let sensitivity = detect_sensitivity(text).to_string();
  let sanitized = sanitize_secret_material(text);
  let source = json!({
    "id": source_id,
    "kind": "mcp_proposal",
    "title": format!("{client_name} memory proposal"),
    "origin": origin,
    "body": sanitized,
    "createdAt": now,
    "capturedAt": now,
    "defaultSensitivity": sensitivity,
    "processingStatus": "ready",
    "deletionState": "active"
  });
  let candidate_status = if sensitivity == "sensitive" || sensitivity == "secret_never_send" {
    "blocked_sensitive"
  } else {
    "new"
  };
  let candidate = json!({
    "id": candidate_id,
    "sourceIds": [source_id],
    "sourceChunkIds": [],
    "proposedFactText": normalized_text(&sanitized),
    "domain": classify_domain(text),
    "candidateType": candidate_type(text),
    "detectedSensitivity": sensitivity,
    "confidence": "medium",
    "reasonToRemember": "MCPクライアントから提案された生活文脈候補です。承認されるまでAIの確定文脈には使われません。",
    "status": candidate_status,
    "createdAt": now,
    "createsFactIds": []
  });

  push_json_array(&mut vault, "sources", source);
  push_json_array(&mut vault, "candidates", candidate);
  touch_connector_in_vault(&mut vault, client_id, &now);
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "memory_proposed",
      "candidate",
      &candidate_id,
      &sensitivity,
      json!({
        "clientId": client_id,
        "clientName": client_name,
        "origin": origin,
        "generatedBy": "native_vault_core"
      }),
    ),
  );

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreMemoryProposalResult {
    payload,
    updated_at,
    status: "candidate_created".to_string(),
    candidate_id,
    source_id,
    detected_sensitivity: sensitivity,
  })
}

pub fn add_source_with_candidates_at_path(
  path: &Path,
  kind: &str,
  origin: &str,
  title: &str,
  body: &str,
) -> Result<VaultCoreSourceIngestResult, String> {
  let body = body.trim();
  if body.is_empty() {
    return Err("body is required.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let now = now_iso();
  let source_id = new_id("src");
  let detected_sensitivity = detect_sensitivity(body).to_string();
  let sanitized = sanitize_source_body(body);
  let normalized_title = normalized_text(title);
  let title = if normalized_title.trim().is_empty() {
    "Untitled source".to_string()
  } else {
    normalized_title
  };
  let source_title = title.clone();
  let kind = source_kind(kind);
  let origin = source_origin(origin);
  let source = json!({
    "id": source_id,
    "kind": kind,
    "title": title,
    "origin": origin,
    "body": sanitized,
    "createdAt": now,
    "capturedAt": now,
    "defaultSensitivity": detected_sensitivity,
    "processingStatus": "ready",
    "deletionState": "active"
  });
  let candidates = extract_memory_candidates_for_source(&source_id, &sanitized, &now);
  let candidate_ids = candidates
    .iter()
    .map(|candidate| str_field(candidate, "id"))
    .collect::<Vec<_>>();

  push_json_array(&mut vault, "sources", source);
  for candidate in candidates {
    push_json_array(&mut vault, "candidates", candidate);
  }
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "source_added",
      "source",
      &source_id,
      &detected_sensitivity,
      json!({
        "title": source_title,
        "kind": kind,
        "origin": origin,
        "candidateCount": candidate_ids.len(),
        "generatedBy": "native_vault_core"
      }),
    ),
  );
  for candidate_id in &candidate_ids {
    let sensitivity = vault
      .get("candidates")
      .and_then(Value::as_array)
      .and_then(|items| {
        items
          .iter()
          .find(|candidate| str_field(candidate, "id") == *candidate_id)
      })
      .map(|candidate| str_field(candidate, "detectedSensitivity"))
      .unwrap_or_else(|| detected_sensitivity.clone());
    push_json_array(
      &mut vault,
      "auditEvents",
      audit_event(
        "candidate_generated",
        "candidate",
        candidate_id,
        &sensitivity,
        json!({
          "sourceId": source_id,
          "generatedBy": "native_vault_core"
        }),
      ),
    );
  }

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreSourceIngestResult {
    payload,
    updated_at,
    source_id,
    candidate_ids,
    detected_sensitivity,
  })
}

pub fn add_passive_capture_event_at_path(
  path: &Path,
  source_client: &str,
  conversation_id: &str,
  url: &str,
  text: &str,
  page_title: Option<&str>,
  selected: bool,
) -> Result<VaultCorePassiveCaptureResult, String> {
  let text = text.trim();
  if text.is_empty() {
    return Err("text is required.".to_string());
  }
  let source_client = source_client.trim();
  let source_client = if source_client.is_empty() {
    "generic_mcp"
  } else {
    source_client
  };
  let conversation_id = conversation_id.trim();
  let conversation_id = if conversation_id.is_empty() {
    "browser_unknown"
  } else {
    conversation_id
  };
  let url = url.trim();
  if url.is_empty() {
    return Err("url is required.".to_string());
  }

  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let snapshot = load_vault_state_snapshot_from_connection(&connection)?;
  let current_payload = snapshot
    .payload
    .clone()
    .unwrap_or_else(|| vault.to_string());

  if !passive_capture_enabled(&vault) {
    return Ok(VaultCorePassiveCaptureResult {
      payload: current_payload,
      updated_at: snapshot.updated_at,
      accepted: false,
      status: "capture_paused".to_string(),
      message: "Passive Capture is off in Life Context Vault.".to_string(),
      event_id: None,
      source_id: None,
      candidate_ids: Vec::new(),
      detected_sensitivity: "public".to_string(),
      retention_until: None,
    });
  }

  if !passive_capture_site_allowed(&vault, source_client, url) {
    return Ok(VaultCorePassiveCaptureResult {
      payload: current_payload,
      updated_at: snapshot.updated_at,
      accepted: false,
      status: "site_not_allowed".to_string(),
      message: "This site is not in the Passive Capture allowlist.".to_string(),
      event_id: None,
      source_id: None,
      candidate_ids: Vec::new(),
      detected_sensitivity: "public".to_string(),
      retention_until: None,
    });
  }

  let now = now_iso();
  let retention_until = days_from_now(passive_capture_retention_days(&vault));
  let source_id = new_id("src");
  let event_id = new_id("cap");
  let detected_sensitivity = detect_sensitivity(text).to_string();
  let sanitized = sanitize_source_body(text);
  let title_detail = page_title
    .map(normalized_text)
    .filter(|value| !value.trim().is_empty())
    .unwrap_or_else(|| "passive capture".to_string());
  let origin = if is_local_capture_url(source_client, url) {
    "local_mcp"
  } else {
    "passive_browser"
  };
  let candidates = extract_memory_candidates_for_source(&source_id, &sanitized, &now);
  let candidate_ids = candidates
    .iter()
    .map(|candidate| str_field(candidate, "id"))
    .collect::<Vec<_>>();
  let processing_status = if candidate_ids.is_empty() {
    "ignored"
  } else {
    "candidate_generated"
  };

  push_json_array(
    &mut vault,
    "sources",
    json!({
      "id": source_id,
      "kind": "passive_capture",
      "title": format!("{} - {}", client_label(source_client), title_detail),
      "origin": origin,
      "body": sanitized,
      "createdAt": now,
      "capturedAt": now,
      "retentionUntil": retention_until,
      "promotedToLongTerm": false,
      "defaultSensitivity": detected_sensitivity,
      "processingStatus": "ready",
      "deletionState": "active"
    }),
  );
  for candidate in candidates {
    push_json_array(&mut vault, "candidates", candidate);
  }
  push_json_array(
    &mut vault,
    "passiveCaptureEvents",
    json!({
      "id": event_id,
      "sourceClient": source_client,
      "conversationId": conversation_id,
      "urlHash": stable_hash(url),
      "textFragmentRef": format!("{source_id}:body"),
      "capturedAt": now,
      "retentionUntil": retention_until,
      "sensitivityGuess": detected_sensitivity,
      "processingStatus": processing_status,
      "sourceId": source_id,
      "candidateIds": candidate_ids
    }),
  );
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "passive_capture_recorded",
      "passive_capture_event",
      &event_id,
      &detected_sensitivity,
      json!({
        "sourceClient": source_client,
        "conversationId": conversation_id,
        "selected": selected,
        "candidateCount": candidate_ids.len(),
        "retentionUntil": retention_until,
        "generatedBy": "native_vault_core"
      }),
    ),
  );
  for candidate_id in &candidate_ids {
    let sensitivity = vault
      .get("candidates")
      .and_then(Value::as_array)
      .and_then(|items| {
        items
          .iter()
          .find(|candidate| str_field(candidate, "id") == *candidate_id)
      })
      .map(|candidate| str_field(candidate, "detectedSensitivity"))
      .unwrap_or_else(|| detected_sensitivity.clone());
    push_json_array(
      &mut vault,
      "auditEvents",
      audit_event(
        "candidate_generated",
        "candidate",
        candidate_id,
        &sensitivity,
        json!({
          "sourceId": source_id,
          "passiveCaptureEventId": event_id,
          "generatedBy": "native_vault_core"
        }),
      ),
    );
  }

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCorePassiveCaptureResult {
    payload,
    updated_at,
    accepted: true,
    status: processing_status.to_string(),
    message: "Captured text was added to Memory Inbox as unapproved candidate(s).".to_string(),
    event_id: Some(event_id),
    source_id: Some(source_id),
    candidate_ids,
    detected_sensitivity,
    retention_until: Some(retention_until),
  })
}

pub fn update_passive_capture_settings_at_path(
  path: &Path,
  enabled: Option<bool>,
  retention_days: Option<i64>,
  allowed_sites: Option<Vec<String>>,
) -> Result<VaultCoreSettingsUpdateResult, String> {
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let now = now_iso();
  let current = vault
    .get("passiveCaptureSettings")
    .cloned()
    .unwrap_or_else(default_passive_capture_settings);
  let mut next = current.as_object().cloned().unwrap_or_default();

  if let Some(enabled) = enabled {
    next.insert("enabled".to_string(), Value::Bool(enabled));
  }
  if let Some(retention_days) = retention_days {
    next.insert(
      "retentionDays".to_string(),
      Value::Number(serde_json::Number::from(retention_days.clamp(1, 90))),
    );
  }
  if let Some(allowed_sites) = allowed_sites {
    let normalized_sites = normalize_allowed_sites(allowed_sites);
    if normalized_sites.is_empty() {
      return Err("allowedSites must include at least one host.".to_string());
    }
    next.insert("allowedSites".to_string(), json!(normalized_sites));
  }

  vault["passiveCaptureSettings"] = Value::Object(next.clone());
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "policy_updated",
      "policy",
      "passive_capture",
      "personal",
      json!({
        "enabled": next.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "retentionDays": next.get("retentionDays").and_then(Value::as_i64).unwrap_or(14),
        "allowedSites": next.get("allowedSites").cloned().unwrap_or_else(|| json!([])),
        "updatedAt": now,
        "generatedBy": "native_vault_core"
      }),
    ),
  );

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreSettingsUpdateResult { payload, updated_at })
}

pub fn update_access_policy_at_path(
  path: &Path,
  client_id: &str,
  sensitivity_ceiling: Option<&str>,
  requires_approval_above: Option<&str>,
  passive_capture_allowed: Option<bool>,
) -> Result<VaultCoreSettingsUpdateResult, String> {
  let client_id = client_id.trim();
  if client_id.is_empty() {
    return Err("clientId is required.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  ensure_access_policy_for_client(&mut vault, client_id);
  let now = now_iso();
  let ceiling = sensitivity_ceiling
    .map(sensitivity_tier)
    .transpose()?;
  let approval = requires_approval_above
    .map(sensitivity_tier)
    .transpose()?;

  let Some(policies) = vault.get_mut("accessPolicies").and_then(Value::as_array_mut) else {
    return Err("Vault has no accessPolicies array.".to_string());
  };
  let Some(policy) = policies
    .iter_mut()
    .find(|policy| str_field(policy, "clientId") == client_id)
  else {
    return Err(format!("AccessPolicy was not found for client: {client_id}"));
  };

  if let Some(ceiling) = ceiling {
    policy["sensitivityCeiling"] = Value::String(ceiling.to_string());
  }
  if let Some(approval) = approval {
    policy["requiresApprovalAbove"] = Value::String(approval.to_string());
  }
  if let Some(passive_capture_allowed) = passive_capture_allowed {
    policy["passiveCaptureAllowed"] = Value::Bool(passive_capture_allowed);
  }
  policy["updatedAt"] = Value::String(now.clone());
  let policy_id = str_field(policy, "id");
  let sensitivity = str_field(policy, "sensitivityCeiling");
  let metadata = json!({
    "clientId": client_id,
    "sensitivityCeiling": sensitivity,
    "requiresApprovalAbove": str_field(policy, "requiresApprovalAbove"),
    "passiveCaptureAllowed": policy.get("passiveCaptureAllowed").and_then(Value::as_bool).unwrap_or(false),
    "generatedBy": "native_vault_core"
  });

  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "policy_updated",
      "policy",
      &policy_id,
      &sensitivity,
      metadata,
    ),
  );

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreSettingsUpdateResult { payload, updated_at })
}

pub fn update_source_lifecycle_at_path(
  path: &Path,
  source_id: &str,
  action: &str,
) -> Result<VaultCoreSourceLifecycleResult, String> {
  let source_id = source_id.trim();
  if source_id.is_empty() {
    return Err("sourceId is required.".to_string());
  }
  let action = source_lifecycle_action(action)?;
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let now = now_iso();
  let (source_title, source_sensitivity) = {
    let Some(sources) = vault.get_mut("sources").and_then(Value::as_array_mut) else {
      return Err("Vault has no sources array.".to_string());
    };
    let Some(source) = sources
      .iter_mut()
      .find(|source| str_field(source, "id") == source_id)
    else {
      return Err(format!("Source was not found: {source_id}"));
    };
    let source_title = str_field(source, "title");
    let source_sensitivity = str_field(source, "defaultSensitivity");

    match action {
      "restore" => {
        if str_field(source, "deletionState") == "purged" {
          return Err("purged Sources cannot be restored because the Raw body was removed.".to_string());
        }
        source["deletionState"] = Value::String("active".to_string());
        source["processingStatus"] = Value::String("ready".to_string());
      }
      "purge_body" => {
        source["body"] = Value::String(String::new());
        source["deletionState"] = Value::String("purged".to_string());
        source["processingStatus"] = Value::String("deleted".to_string());
        source["promotedToLongTerm"] = Value::Bool(false);
      }
      "soft_delete" => {
        source["deletionState"] = Value::String("soft_deleted".to_string());
        source["processingStatus"] = Value::String("deleted".to_string());
      }
      _ => unreachable!("source_lifecycle_action validated the action"),
    }
    (source_title, source_sensitivity)
  };

  let affected_candidate_count = if action == "restore" {
    0
  } else {
    archive_pending_candidates_for_source(&mut vault, source_id, &now)
  };
  let affected_fact_ids = if action == "restore" {
    restore_source_deleted_facts(&mut vault, source_id, &now)
  } else {
    mark_source_facts_needing_review(&mut vault, source_id, &now)
  };
  let invalidated_pack_count = if action == "restore" {
    0
  } else {
    invalidate_context_packs_for_facts(&mut vault, &affected_fact_ids)
  };
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      match action {
        "restore" => "source_restored",
        "purge_body" => "source_purged",
        _ => "source_deleted",
      },
      "source",
      source_id,
      &source_sensitivity,
      json!({
        "title": source_title,
        "action": action,
        "affectedCandidateCount": affected_candidate_count,
        "affectedFactCount": affected_fact_ids.len(),
        "invalidatedPackCount": invalidated_pack_count,
        "generatedBy": "native_vault_core"
      }),
    ),
  );

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreSourceLifecycleResult {
    payload,
    updated_at,
    source_id: source_id.to_string(),
    action: action.to_string(),
    affected_candidate_count,
    affected_fact_count: affected_fact_ids.len(),
    invalidated_pack_count,
  })
}

pub fn update_source_metadata_at_path(
  path: &Path,
  source_id: &str,
  title: &str,
  default_sensitivity: &str,
  promoted_to_long_term: Option<bool>,
) -> Result<VaultCoreSourceMetadataResult, String> {
  let source_id = source_id.trim();
  if source_id.is_empty() {
    return Err("sourceId is required.".to_string());
  }
  let title = normalized_text(title);
  if title.is_empty() {
    return Err("title is required.".to_string());
  }
  let default_sensitivity = sensitivity_tier(default_sensitivity)?;
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let applied_promoted_to_long_term = {
    let Some(sources) = vault.get_mut("sources").and_then(Value::as_array_mut) else {
      return Err("Vault has no sources array.".to_string());
    };
    let Some(source) = sources
      .iter_mut()
      .find(|source| str_field(source, "id") == source_id)
    else {
      return Err(format!("Source was not found: {source_id}"));
    };
    source["title"] = Value::String(title.clone());
    source["defaultSensitivity"] = Value::String(default_sensitivity.to_string());
    let has_retention = source
      .get("retentionUntil")
      .and_then(Value::as_str)
      .map(|value| !value.trim().is_empty())
      .unwrap_or(false);
    if has_retention {
      let promoted = promoted_to_long_term.unwrap_or_else(|| {
        source
          .get("promotedToLongTerm")
          .and_then(Value::as_bool)
          .unwrap_or(false)
      });
      source["promotedToLongTerm"] = Value::Bool(promoted);
      Some(promoted)
    } else {
      None
    }
  };
  let affected_fact_ids = fact_ids_for_source(&vault, source_id);
  let invalidated_pack_count = invalidate_context_packs_for_facts_with_warning(
    &mut vault,
    &affected_fact_ids,
    "stale_fact",
    "根拠Sourceのメタデータが更新されたため、このContext Packは無効化されました。",
  );
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "source_updated",
      "source",
      source_id,
      default_sensitivity,
      json!({
        "title": title,
        "defaultSensitivity": default_sensitivity,
        "promotedToLongTerm": applied_promoted_to_long_term,
        "affectedFactCount": affected_fact_ids.len(),
        "invalidatedPackCount": invalidated_pack_count,
        "generatedBy": "native_vault_core"
      }),
    ),
  );

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreSourceMetadataResult {
    payload,
    updated_at,
    source_id: source_id.to_string(),
    invalidated_pack_count,
  })
}

pub fn update_fact_lifecycle_at_path(
  path: &Path,
  fact_id: &str,
  action: &str,
) -> Result<VaultCoreFactLifecycleResult, String> {
  let fact_id = fact_id.trim();
  if fact_id.is_empty() {
    return Err("factId is required.".to_string());
  }
  let action = fact_lifecycle_action(action)?;
  let status = fact_status_for_action(action);
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let now = now_iso();
  let sensitivity = {
    let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) else {
      return Err("Vault has no facts array.".to_string());
    };
    let Some(fact) = facts
      .iter_mut()
      .find(|fact| str_field(fact, "id") == fact_id)
    else {
      return Err(format!("ApprovedFact was not found: {fact_id}"));
    };
    let sensitivity = str_field(fact, "sensitivity");
    fact["status"] = Value::String(status.to_string());
    fact["updatedAt"] = Value::String(now.clone());
    if status == "active" {
      if let Some(object) = fact.as_object_mut() {
        object.remove("reviewReason");
        object.remove("reviewSourceId");
      }
    } else if status == "needs_review" && str_field(fact, "reviewReason").is_empty() {
      fact["reviewReason"] = Value::String("source_deleted".to_string());
    }
    sensitivity
  };
  let invalidated_pack_count = if matches!(action, "mark_needs_review" | "hide" | "delete") {
    invalidate_context_packs_for_facts_with_warning(
      &mut vault,
      &[fact_id.to_string()],
      "stale_fact",
      "Factの表示状態が変更されたため、このContext Packは無効化されました。",
    )
  } else {
    0
  };
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "fact_updated",
      "fact",
      fact_id,
      &sensitivity,
      json!({
        "action": action,
        "status": status,
        "invalidatedPackCount": invalidated_pack_count,
        "generatedBy": "native_vault_core"
      }),
    ),
  );

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreFactLifecycleResult {
    payload,
    updated_at,
    fact_id: fact_id.to_string(),
    action: action.to_string(),
    status: status.to_string(),
    invalidated_pack_count,
  })
}

pub fn update_fact_metadata_at_path(
  path: &Path,
  fact_id: &str,
  fact_text: &str,
  domain: &str,
  sensitivity: &str,
  valid_from: Option<&str>,
  valid_until: Option<&str>,
  due_date: Option<&str>,
) -> Result<VaultCoreFactMetadataResult, String> {
  let fact_id = fact_id.trim();
  if fact_id.is_empty() {
    return Err("factId is required.".to_string());
  }
  let fact_text = normalized_text(fact_text);
  if fact_text.is_empty() {
    return Err("factText is required.".to_string());
  }
  let domain = life_domain(domain)?;
  let sensitivity = sensitivity_tier(sensitivity)?;
  if sensitivity == "secret_never_send" {
    return Err("secret_never_send cannot be saved as an ApprovedFact.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let now = now_iso();
  {
    let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) else {
      return Err("Vault has no facts array.".to_string());
    };
    let Some(fact) = facts
      .iter_mut()
      .find(|fact| str_field(fact, "id") == fact_id)
    else {
      return Err(format!("ApprovedFact was not found: {fact_id}"));
    };
    fact["factText"] = Value::String(fact_text);
    fact["domain"] = Value::String(domain.to_string());
    fact["sensitivity"] = Value::String(sensitivity.to_string());
    fact["updatedAt"] = Value::String(now);
    set_optional_fact_string(fact, "validFrom", valid_from);
    set_optional_fact_string(fact, "validUntil", valid_until);
    set_optional_fact_string(fact, "dueDate", due_date);
  }
  let invalidated_pack_count = invalidate_context_packs_for_facts_with_warning(
    &mut vault,
    &[fact_id.to_string()],
    "stale_fact",
    "Factが更新されたため、このContext Packは無効化されました。",
  );
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "fact_updated",
      "fact",
      fact_id,
      sensitivity,
      json!({
        "action": "metadata_updated",
        "domain": domain,
        "invalidatedPackCount": invalidated_pack_count,
        "generatedBy": "native_vault_core"
      }),
    ),
  );

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreFactMetadataResult {
    payload,
    updated_at,
    fact_id: fact_id.to_string(),
    invalidated_pack_count,
  })
}

pub fn approve_candidate_at_path(
  path: &Path,
  candidate_id: &str,
  edited_text: Option<&str>,
) -> Result<VaultCoreCandidateReviewResult, String> {
  let candidate_id = candidate_id.trim();
  if candidate_id.is_empty() {
    return Err("candidateId is required.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let candidate = find_vault_item_by_id(&vault, "candidates", candidate_id)
    .ok_or_else(|| format!("MemoryCandidate was not found: {candidate_id}"))?;
  let detected_sensitivity = str_field(&candidate, "detectedSensitivity");
  if detected_sensitivity == "secret_never_send" {
    return Err("secret_never_send candidates cannot be approved as Facts.".to_string());
  }
  let current_status = str_field(&candidate, "status");
  if current_status == "approved" || current_status == "edited_and_approved" {
    return Err("candidate is already approved.".to_string());
  }
  let proposed_text = str_field(&candidate, "proposedFactText");
  let fact_text = edited_text
    .unwrap_or(&proposed_text)
    .trim()
    .to_string();
  if fact_text.is_empty() {
    return Err("approved fact text is required.".to_string());
  }

  let now = now_iso();
  let fact_id = new_id("fact");
  let source_ids = candidate
    .get("sourceIds")
    .cloned()
    .unwrap_or_else(|| json!([]));
  if source_ids_have_deleted_source_in_vault(&vault, &source_ids) {
    return Err("candidates from deleted or purged Sources cannot be approved as Facts.".to_string());
  }
  let source_backed = source_ids
    .as_array()
    .map(|ids| !ids.is_empty())
    .unwrap_or(false);
  let mut fact = json!({
    "id": fact_id.clone(),
    "factText": fact_text,
    "domain": str_field(&candidate, "domain"),
    "factType": candidate_type_to_fact_type(&str_field(&candidate, "candidateType")),
    "sourceIds": source_ids,
    "sensitivity": detected_sensitivity.clone(),
    "confidence": if source_backed { "source_backed" } else { "inferred_and_confirmed" },
    "status": "active",
    "createdAt": now.clone(),
    "approvedAt": now.clone(),
    "updatedAt": now.clone()
  });
  copy_optional_candidate_field(&candidate, &mut fact, "validFrom");
  copy_optional_candidate_field(&candidate, &mut fact, "validUntil");
  copy_optional_candidate_field(&candidate, &mut fact, "dueDate");

  let approved_status = if edited_text
    .map(str::trim)
    .filter(|text| *text != proposed_text)
    .is_some()
  {
    "edited_and_approved"
  } else {
    "approved"
  };
  update_candidate_in_vault(&mut vault, candidate_id, |candidate| {
    candidate["status"] = Value::String(approved_status.to_string());
    candidate["reviewedAt"] = Value::String(now.clone());
    candidate["createsFactIds"] = json!([fact_id.clone()]);
  })?;
  push_json_array(&mut vault, "facts", fact);
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "candidate_reviewed",
      "candidate",
      candidate_id,
      &detected_sensitivity,
      json!({
        "action": "approved",
        "generatedBy": "native_vault_core"
      }),
    ),
  );
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "fact_created",
      "fact",
      &fact_id,
      &detected_sensitivity,
      json!({
        "candidateId": candidate_id,
        "generatedBy": "native_vault_core"
      }),
    ),
  );

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreCandidateReviewResult {
    payload,
    updated_at,
    candidate_id: candidate_id.to_string(),
    status: approved_status.to_string(),
    fact_id: Some(fact_id),
  })
}

pub fn update_candidate_status_at_path(
  path: &Path,
  candidate_id: &str,
  status: &str,
) -> Result<VaultCoreCandidateReviewResult, String> {
  let candidate_id = candidate_id.trim();
  if candidate_id.is_empty() {
    return Err("candidateId is required.".to_string());
  }
  let status = candidate_review_status(status)?;
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let candidate = find_vault_item_by_id(&vault, "candidates", candidate_id)
    .ok_or_else(|| format!("MemoryCandidate was not found: {candidate_id}"))?;
  let detected_sensitivity = str_field(&candidate, "detectedSensitivity");
  let now = now_iso();

  update_candidate_in_vault(&mut vault, candidate_id, |candidate| {
    candidate["status"] = Value::String(status.to_string());
    candidate["reviewedAt"] = Value::String(now.clone());
  })?;
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "candidate_reviewed",
      "candidate",
      candidate_id,
      &detected_sensitivity,
      json!({
        "action": status,
        "generatedBy": "native_vault_core"
      }),
    ),
  );

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreCandidateReviewResult {
    payload,
    updated_at,
    candidate_id: candidate_id.to_string(),
    status: status.to_string(),
    fact_id: None,
  })
}

pub fn get_context_request_status_at_path(
  path: &Path,
  request_id: &str,
) -> Result<VaultCoreRequestStatusResult, String> {
  let connection = open_vault_db_at_path(path)?;
  let vault = load_vault_json_from_connection(&connection)?;
  let Some(request) = find_vault_item_by_id(&vault, "contextPackRequests", request_id) else {
    return Ok(VaultCoreRequestStatusResult {
      status: "not_found".to_string(),
      request_id: request_id.to_string(),
      expires_at: None,
      context_pack: None,
    });
  };
  let pack = vault
    .get("contextPacks")
    .and_then(Value::as_array)
    .and_then(|packs| {
      packs
        .iter()
        .find(|pack| str_field(pack, "requestId") == request_id)
    })
    .cloned();
  let expires_at = str_field(&request, "expiresAt");
  let confirmed = pack
    .as_ref()
    .map(|pack| str_field(pack, "confirmationStatus") == "confirmed")
    .unwrap_or(false)
    || str_field(&request, "status") == "fulfilled";
  let expired = !confirmed && !expires_at.is_empty() && is_expired(&expires_at);

  if confirmed {
    return Ok(VaultCoreRequestStatusResult {
      status: "fulfilled".to_string(),
      request_id: request_id.to_string(),
      expires_at: if expires_at.is_empty() { None } else { Some(expires_at) },
      context_pack: pack.as_ref().map(safe_context_pack_for_client),
    });
  }

  Ok(VaultCoreRequestStatusResult {
    status: if expired {
      "expired".to_string()
    } else {
      str_field(&request, "status")
    },
    request_id: request_id.to_string(),
    expires_at: if expires_at.is_empty() { None } else { Some(expires_at) },
    context_pack: None,
  })
}

fn find_vault_item_by_id(vault: &Value, key: &str, id: &str) -> Option<Value> {
  vault
    .get(key)
    .and_then(Value::as_array)
    .and_then(|items| items.iter().find(|item| str_field(item, "id") == id))
    .cloned()
}

fn safe_context_pack_for_client(pack: &Value) -> Value {
  json!({
    "trustBoundary": "ContextPack only",
    "id": str_field(pack, "id"),
    "requestId": optional_value(pack, "requestId"),
    "taskText": str_field(pack, "taskText"),
    "taskDomain": str_field(pack, "taskDomain"),
    "generatedAt": str_field(pack, "generatedAt"),
    "expiresAt": optional_value(pack, "expiresAt"),
    "maxSensitivityIncluded": str_field(pack, "maxSensitivityIncluded"),
    "items": pack.get("items").cloned().unwrap_or_else(|| json!([])),
    "sourceSnippets": pack.get("sourceSnippets").cloned().unwrap_or_else(|| json!([])),
    "warnings": pack.get("warnings").cloned().unwrap_or_else(|| json!([])),
    "excludedItems": pack.get("excludedItems").cloned().unwrap_or_else(|| json!([])),
    "confirmationStatus": str_field(pack, "confirmationStatus")
  })
}

fn ensure_pack_can_be_edited(vault: &mut Value, pack: &Value) -> Result<(), String> {
  let status = str_field(pack, "confirmationStatus");
  if status == "cancelled" {
    return Err("cancelled ContextPacks cannot be edited.".to_string());
  }
  if status == "confirmed" {
    return Err("confirmed ContextPacks cannot be edited. Create a new request instead.".to_string());
  }
  ensure_pack_not_expired(vault, pack)?;
  if let Some(request_id) = optional_str_field(pack, "requestId") {
    if let Some(request) = find_vault_item_by_id(vault, "contextPackRequests", &request_id) {
      let request_status = str_field(&request, "status");
      if matches!(request_status.as_str(), "denied" | "expired" | "fulfilled") {
        return Err(format!("ContextPackRequest is already {request_status}."));
      }
    }
  }
  Ok(())
}

fn ensure_pack_not_expired(vault: &mut Value, pack: &Value) -> Result<(), String> {
  let expires_at = optional_str_field(pack, "expiresAt")
    .or_else(|| {
      optional_str_field(pack, "requestId")
        .and_then(|request_id| find_vault_item_by_id(vault, "contextPackRequests", &request_id))
        .and_then(|request| optional_str_field(&request, "expiresAt"))
    })
    .unwrap_or_default();
  if !expires_at.is_empty() && is_expired(&expires_at) {
    if let Some(request_id) = optional_str_field(pack, "requestId") {
      set_context_request_status(vault, &request_id, "expired");
    }
    return Err("ContextPack has expired. Create a new request.".to_string());
  }
  Ok(())
}

fn remove_fact_from_context_pack(
  connection: &Connection,
  pack: &Value,
  fact_id: &str,
  ceiling: &str,
) -> Result<Value, String> {
  let items = pack
    .get("items")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
  if !items
    .iter()
    .any(|item| item.get("factId").and_then(Value::as_str) == Some(fact_id))
  {
    return Ok(pack.clone());
  }
  let next_items = items
    .into_iter()
    .filter(|item| item.get("factId").and_then(Value::as_str) != Some(fact_id))
    .collect::<Vec<_>>();
  let mut excluded_items = pack
    .get("excludedItems")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
  let already_excluded = excluded_items.iter().any(|item| {
    item.get("referencedId").and_then(Value::as_str) == Some(fact_id)
      && item.get("reason").and_then(Value::as_str) == Some("user_hidden")
  });
  if !already_excluded {
    excluded_items.insert(0, json!({ "referencedId": fact_id, "reason": "user_hidden" }));
  }
  refresh_user_edited_context_pack(connection, pack, next_items, excluded_items, ceiling)
}

fn restore_fact_to_context_pack(
  connection: &Connection,
  pack: &Value,
  fact_id: &str,
  ceiling: &str,
) -> Result<Value, String> {
  let mut items = pack
    .get("items")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
  if items
    .iter()
    .any(|item| item.get("factId").and_then(Value::as_str) == Some(fact_id))
  {
    return Ok(pack.clone());
  }
  let fact = fact_by_id_in_connection(connection, fact_id)?
    .ok_or_else(|| format!("ApprovedFact was not found: {fact_id}"))?;
  if !fact_eligible_for_context_pack(&fact, ceiling) {
    return Err("Fact is not eligible for this Context Pack.".to_string());
  }
  let task_domain = str_field(pack, "taskDomain");
  items.push(context_pack_item_from_fact(connection, &fact, &task_domain, ceiling)?);
  let excluded_items = pack
    .get("excludedItems")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
    .into_iter()
    .filter(|item| {
      !(item.get("referencedId").and_then(Value::as_str) == Some(fact_id)
        && item.get("reason").and_then(Value::as_str) == Some("user_hidden"))
    })
    .collect::<Vec<_>>();
  refresh_user_edited_context_pack(connection, pack, items, excluded_items, ceiling)
}

fn refresh_user_edited_context_pack(
  connection: &Connection,
  pack: &Value,
  items: Vec<Value>,
  excluded_items: Vec<Value>,
  ceiling: &str,
) -> Result<Value, String> {
  let mut next_pack = pack.clone();
  let snippets = source_snippets_for_context_items(connection, &items, ceiling)?;
  next_pack["items"] = Value::Array(items.clone());
  next_pack["sourceSnippets"] = Value::Array(snippets);
  next_pack["excludedItems"] = Value::Array(excluded_items.clone());
  next_pack["warnings"] = Value::Array(context_pack_warnings(connection, &items, &excluded_items)?);
  next_pack["maxSensitivityIncluded"] = Value::String(max_sensitivity_for_items(&items).to_string());
  next_pack["confirmationStatus"] = Value::String("edited_by_user".to_string());
  if let Some(object) = next_pack.as_object_mut() {
    object.remove("confirmedAt");
    object.remove("localAnswer");
  }
  Ok(next_pack)
}

fn context_pack_item_from_fact(
  connection: &Connection,
  fact: &NativeFactSearchResult,
  task_domain: &str,
  ceiling: &str,
) -> Result<Value, String> {
  Ok(json!({
    "id": new_id("ctxitem"),
    "factId": fact.id,
    "itemText": fact.fact_text,
    "reasonIncluded": if fact.domain == task_domain {
      "質問の領域と一致しています。"
    } else {
      "本人の背景情報として回答を調整できます。"
    },
    "sensitivity": fact.sensitivity,
    "sourceTitles": source_titles_in_connection(connection, &fact.source_ids, ceiling)?,
    "validFrom": fact.valid_from,
    "validUntil": fact.valid_until,
    "confidence": fact.confidence
  }))
}

fn fact_eligible_for_context_pack(fact: &NativeFactSearchResult, ceiling: &str) -> bool {
  fact.status == "active"
    && fact.sensitivity != "secret_never_send"
    && sensitivity_rank(&fact.sensitivity) <= sensitivity_rank(ceiling)
    && fact
      .valid_until
      .as_deref()
      .map(is_expired)
      .unwrap_or(false)
      == false
}

fn source_snippets_for_context_items(
  connection: &Connection,
  items: &[Value],
  ceiling: &str,
) -> Result<Vec<Value>, String> {
  let mut snippets = Vec::new();
  let mut seen_source_ids = HashSet::new();
  for fact_id in items
    .iter()
    .filter_map(|item| item.get("factId").and_then(Value::as_str))
  {
    let Some(fact) = fact_by_id_in_connection(connection, fact_id)? else {
      continue;
    };
    let Some(snippet) = source_snippet_for_fact(connection, &fact, ceiling)? else {
      continue;
    };
    let source_id = str_field(&snippet, "sourceId");
    if seen_source_ids.insert(source_id) {
      snippets.push(snippet);
    }
  }
  Ok(snippets)
}

fn max_sensitivity_for_items(items: &[Value]) -> &'static str {
  let mut max = "public";
  for sensitivity in items
    .iter()
    .filter_map(|item| item.get("sensitivity").and_then(Value::as_str))
  {
    if sensitivity_rank(sensitivity) > sensitivity_rank(max) {
      max = sensitivity_tier(sensitivity).unwrap_or("secret_never_send");
    }
  }
  max
}

fn fact_by_id_in_connection(
  connection: &Connection,
  fact_id: &str,
) -> Result<Option<NativeFactSearchResult>, String> {
  connection
    .query_row(
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
       WHERE id = ?1",
      params![fact_id],
      row_to_native_fact_search_result,
    )
    .optional()
    .map_err(|error| format!("failed to read fact {fact_id}: {error}"))
}

fn replace_vault_item_by_id(
  vault: &mut Value,
  key: &str,
  id: &str,
  next_value: Value,
) -> Result<(), String> {
  mutate_vault_item_by_id(vault, key, id, |item| {
    *item = next_value.clone();
  })
}

fn mutate_vault_item_by_id<F>(vault: &mut Value, key: &str, id: &str, mut mutate: F) -> Result<(), String>
where
  F: FnMut(&mut Value),
{
  let Some(items) = vault.get_mut(key).and_then(Value::as_array_mut) else {
    return Err(format!("Vault has no {key} array."));
  };
  let Some(item) = items.iter_mut().find(|item| str_field(item, "id") == id) else {
    return Err(format!("{key} item was not found: {id}"));
  };
  mutate(item);
  Ok(())
}

fn set_context_request_status(vault: &mut Value, request_id: &str, status: &str) {
  if let Some(requests) = vault
    .get_mut("contextPackRequests")
    .and_then(Value::as_array_mut)
  {
    for request in requests {
      if str_field(request, "id") == request_id {
        request["status"] = Value::String(status.to_string());
      }
    }
  }
}

fn cancel_context_packs_for_request(vault: &mut Value, request_id: &str) -> Option<String> {
  let mut first_pack_id = None;
  if let Some(packs) = vault.get_mut("contextPacks").and_then(Value::as_array_mut) {
    for pack in packs {
      if str_field(pack, "requestId") == request_id {
        if first_pack_id.is_none() {
          first_pack_id = optional_str_field(pack, "id");
        }
        pack["confirmationStatus"] = Value::String("cancelled".to_string());
      }
    }
  }
  first_pack_id
}

fn rank_context_facts_in_connection(
  connection: &Connection,
  task_text: &str,
  ceiling: &str,
  limit: usize,
) -> Result<Vec<NativeFactSearchResult>, String> {
  let task_domain = classify_domain(task_text);
  let lower_task = task_text.to_lowercase();
  let tokens = search_tokens(task_text);
  let mut candidates = Vec::<NativeFactSearchResult>::new();

  for fact in search_facts_in_connection(connection, task_text, None, None, 200)? {
    push_unique_fact(&mut candidates, fact);
  }
  for fact in context_candidate_facts_in_connection(connection, task_text)? {
    push_unique_fact(&mut candidates, fact);
  }

  let mut scored = candidates
    .into_iter()
    .map(|fact| {
      let haystack = format!("{} {}", fact.fact_text.to_lowercase(), fact.domain.to_lowercase());
      let token_score = tokens
        .iter()
        .filter(|token| haystack.contains(token.as_str()))
        .count() as i64
        * 3;
      let domain_score = if fact.domain == task_domain {
        4
      } else if is_stable_background_fact(&fact) {
        1
      } else {
        0
      };
      let bridge_score = cross_domain_bridge_score(&lower_task, &fact.domain);
      let sensitivity_penalty = if sensitivity_rank(&fact.sensitivity) >= sensitivity_rank("sensitive") {
        -1
      } else {
        0
      };
      let policy_bonus = if sensitivity_rank(&fact.sensitivity) <= sensitivity_rank(ceiling) {
        1
      } else {
        0
      };
      (
        token_score + domain_score + bridge_score + sensitivity_penalty + policy_bonus,
        fact,
      )
    })
    .filter(|(score, _)| *score > 0)
    .collect::<Vec<_>>();

  scored.sort_by(|(left_score, left_fact), (right_score, right_fact)| {
    right_score
      .cmp(left_score)
      .then_with(|| right_fact.updated_at.cmp(&left_fact.updated_at))
  });
  Ok(scored
    .into_iter()
    .take(limit)
    .map(|(_, fact)| fact)
    .collect())
}

fn context_candidate_facts_in_connection(
  connection: &Connection,
  task_text: &str,
) -> Result<Vec<NativeFactSearchResult>, String> {
  let domains = context_candidate_domains(task_text);
  let domains_sql = domains
    .iter()
    .map(|domain| format!("'{domain}'"))
    .collect::<Vec<_>>()
    .join(", ");
  let stable_types_sql = [
    "identity",
    "preference",
    "relationship",
    "life_event",
    "goal",
    "routine",
    "constraint",
    "support_need",
    "place_context",
    "background_profile",
  ]
  .iter()
  .map(|fact_type| format!("'{fact_type}'"))
  .collect::<Vec<_>>()
  .join(", ");
  let sql = format!(
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
     WHERE domain IN ({domains_sql})
        OR fact_type IN ({stable_types_sql})
     ORDER BY updated_at DESC
     LIMIT 300"
  );
  let mut statement = connection
    .prepare(&sql)
    .map_err(|error| format!("failed to prepare context fact candidates: {error}"))?;
  let results = statement
    .query_map([], row_to_native_fact_search_result)
    .map_err(|error| format!("failed to run context fact candidates: {error}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| format!("failed to collect context fact candidates: {error}"))?;
  Ok(results)
}

fn push_unique_fact(facts: &mut Vec<NativeFactSearchResult>, fact: NativeFactSearchResult) {
  if !facts.iter().any(|existing| existing.id == fact.id) {
    facts.push(fact);
  }
}

fn source_titles_in_connection(
  connection: &Connection,
  source_ids: &[String],
  ceiling: &str,
) -> Result<Vec<String>, String> {
  let mut titles = Vec::new();
  for source_id in source_ids {
    let source = connection
      .query_row(
        "SELECT title, default_sensitivity, deletion_state FROM sources WHERE id = ?1",
        params![source_id],
        |row| {
          Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
          ))
        },
      )
      .optional()
      .map_err(|error| format!("failed to read source title {source_id}: {error}"))?;
    let Some((title, sensitivity, deletion_state)) = source else {
      continue;
    };
    if deletion_state == "active"
      && sensitivity != "secret_never_send"
      && sensitivity_rank(&sensitivity) <= sensitivity_rank(ceiling)
    {
      titles.push(title);
    }
  }
  Ok(titles)
}

fn source_snippet_for_fact(
  connection: &Connection,
  fact: &NativeFactSearchResult,
  ceiling: &str,
) -> Result<Option<Value>, String> {
  for source_id in &fact.source_ids {
    let source = connection
      .query_row(
        "SELECT id, title, default_sensitivity, deletion_state
         FROM sources
         WHERE id = ?1",
        params![source_id],
        |row| {
          Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
          ))
        },
      )
      .optional()
      .map_err(|error| format!("failed to read source snippet metadata {source_id}: {error}"))?;
    let Some((source_id, title, sensitivity, deletion_state)) = source else {
      continue;
    };
    if deletion_state != "active"
      || sensitivity == "secret_never_send"
      || sensitivity_rank(&sensitivity) > sensitivity_rank(ceiling)
    {
      continue;
    }
    return Ok(Some(json!({
      "id": new_id("snippet"),
      "sourceId": source_id,
      "title": title,
      "text": fact.fact_text,
      "sensitivity": sensitivity,
      "reasonIncluded": "Raw Source本文ではなく、承認済みFact本文だけを根拠として含めています。"
    })));
  }
  Ok(None)
}

fn context_pack_warnings(
  connection: &Connection,
  items: &[Value],
  excluded_items: &[Value],
) -> Result<Vec<Value>, String> {
  let mut warnings = Vec::new();
  let sensitive_ids = items
    .iter()
    .filter(|item| {
      item
        .get("sensitivity")
        .and_then(Value::as_str)
        .map(|sensitivity| sensitivity_rank(sensitivity) >= sensitivity_rank("private_consequential"))
        .unwrap_or(false)
    })
    .filter_map(|item| {
      item
        .get("factId")
        .and_then(Value::as_str)
        .map(|fact_id| Value::String(fact_id.to_string()))
    })
    .collect::<Vec<_>>();
  if !sensitive_ids.is_empty() {
    warnings.push(json!({
      "kind": "sensitive_context",
      "message": "このContext Packには私的またはセンシティブな背景情報が含まれます。",
      "relatedIds": sensitive_ids
    }));
  }

  let low_confidence_ids = items
    .iter()
    .filter(|item| {
      item
        .get("confidence")
        .and_then(Value::as_str)
        .map(|confidence| confidence == "inferred_and_confirmed")
        .unwrap_or(false)
    })
    .filter_map(|item| {
      item
        .get("factId")
        .and_then(Value::as_str)
        .map(|fact_id| Value::String(fact_id.to_string()))
    })
    .collect::<Vec<_>>();
  if !low_confidence_ids.is_empty() {
    warnings.push(json!({
      "kind": "low_confidence",
      "message": "一部の背景情報は推定後に確認された情報です。必要ならSourceを確認してください。",
      "relatedIds": low_confidence_ids
    }));
  }

  let expired_ids = excluded_items
    .iter()
    .filter(|item| item.get("reason").and_then(Value::as_str) == Some("expired"))
    .filter_map(|item| {
      item
        .get("referencedId")
        .and_then(Value::as_str)
        .map(|fact_id| Value::String(fact_id.to_string()))
    })
    .collect::<Vec<_>>();
  if !expired_ids.is_empty() {
    warnings.push(json!({
      "kind": "stale_fact",
      "message": "期限切れまたは古い可能性がある背景情報は除外されました。",
      "relatedIds": expired_ids
    }));
  }

  let policy_limited_ids = excluded_items
    .iter()
    .filter(|item| item.get("reason").and_then(Value::as_str) == Some("sensitivity_policy"))
    .filter_map(|item| {
      item
        .get("referencedId")
        .and_then(Value::as_str)
        .map(|fact_id| Value::String(fact_id.to_string()))
    })
    .collect::<Vec<_>>();
  if !policy_limited_ids.is_empty() {
    warnings.push(json!({
      "kind": "policy_limited",
      "message": "一部の背景情報はAI接続の感度ポリシーにより除外されました。",
      "relatedIds": policy_limited_ids
    }));
  }

  let mut source_deleted_ids = Vec::new();
  for fact_id in items
    .iter()
    .filter_map(|item| item.get("factId").and_then(Value::as_str))
  {
    if fact_has_deleted_source(connection, fact_id)? {
      source_deleted_ids.push(Value::String(fact_id.to_string()));
    }
  }
  if !source_deleted_ids.is_empty() {
    warnings.push(json!({
      "kind": "source_deleted",
      "message": "根拠Sourceが削除または無効化されたFactがあります。",
      "relatedIds": source_deleted_ids
    }));
  }

  Ok(warnings)
}

fn fact_has_deleted_source(connection: &Connection, fact_id: &str) -> Result<bool, String> {
  let source_ids_json = connection
    .query_row(
      "SELECT source_ids FROM facts WHERE id = ?1",
      params![fact_id],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| format!("failed to read fact sources {fact_id}: {error}"))?;
  let Some(source_ids_json) = source_ids_json else {
    return Ok(false);
  };
  for source_id in parse_json_string_array(source_ids_json) {
    let deletion_state = connection
      .query_row(
        "SELECT deletion_state FROM sources WHERE id = ?1",
        params![source_id],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .map_err(|error| format!("failed to read source deletion state: {error}"))?;
    if deletion_state.as_deref() != Some("active") {
      return Ok(true);
    }
  }
  Ok(false)
}

fn search_tokens(text: &str) -> Vec<String> {
  text
    .to_lowercase()
    .split_whitespace()
    .map(|token| token.trim_matches(|character: char| !character.is_alphanumeric()).to_string())
    .filter(|token| !token.is_empty())
    .collect()
}

fn context_candidate_domains(task_text: &str) -> Vec<&'static str> {
  let task_domain = classify_domain(task_text);
  let lower = task_text.to_lowercase();
  let mut domains = vec![task_domain];
  if contains_any(&lower, &["job", "work", "employer", "転職", "勤務先", "仕事"]) {
    domains.extend([
      "contracts_and_policies",
      "procedures_and_obligations",
      "finance_and_benefits",
    ]);
  }
  if contains_any(&lower, &["move", "moving", "address", "引っ越", "住所"]) {
    domains.extend([
      "home_and_places",
      "contracts_and_policies",
      "procedures_and_obligations",
      "documents_and_evidence",
    ]);
  }
  let mut deduped = Vec::new();
  for domain in domains {
    if !deduped.contains(&domain) {
      deduped.push(domain);
    }
  }
  deduped
}

fn is_stable_background_fact(fact: &NativeFactSearchResult) -> bool {
  [
    "identity",
    "preference",
    "relationship",
    "life_event",
    "goal",
    "routine",
    "constraint",
    "support_need",
    "place_context",
    "background_profile",
  ]
  .contains(&fact.fact_type.as_str())
    && [
      "identity_and_profile",
      "values_goals_and_preferences",
      "life_events_and_plans",
      "routines_and_logistics",
      "home_and_places",
      "work_and_education",
      "relationships_and_household",
      "constraints_and_accessibility",
    ]
    .contains(&fact.domain.as_str())
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
  if contains_any(task, &["job", "work", "employer", "転職", "勤務先", "仕事"])
    && ["contracts_and_policies", "procedures_and_obligations", "finance_and_benefits"].contains(&domain)
  {
    return 2;
  }
  if contains_any(task, &["move", "moving", "address", "引っ越", "住所"])
    && [
      "home_and_places",
      "contracts_and_policies",
      "procedures_and_obligations",
      "documents_and_evidence",
    ]
    .contains(&domain)
  {
    return 2;
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
  let tokens = text.split_whitespace().collect::<Vec<_>>();
  let mut sanitized = Vec::new();
  let mut index = 0;
  while index < tokens.len() {
    let token = tokens[index];
    let lower = token.to_lowercase();
    let next_lower = tokens
      .get(index + 1)
      .map(|next| next.to_lowercase())
      .unwrap_or_default();

    if lower == "api" && next_lower.starts_with("key") {
      sanitized.push("[REDACTED_SECRET]".to_string());
      sanitized.push("[REDACTED_SECRET]".to_string());
      if index + 2 < tokens.len() {
        sanitized.push("[REDACTED_SECRET]".to_string());
        index += 3;
      } else {
        index += 2;
      }
      continue;
    }

    if is_secret_indicator(&lower) {
      sanitized.push("[REDACTED_SECRET]".to_string());
      if index + 1 < tokens.len() {
        sanitized.push("[REDACTED_SECRET]".to_string());
        index += 2;
      } else {
        index += 1;
      }
    } else {
      sanitized.push(token.to_string());
      index += 1;
    }
  }
  sanitized.join(" ")
}

fn sanitize_source_body(text: &str) -> String {
  text.lines()
    .map(sanitize_secret_material)
    .collect::<Vec<_>>()
    .join("\n")
}

fn is_secret_indicator(lower: &str) -> bool {
  lower.contains("password")
    || lower.contains("token")
    || lower.contains("secret")
    || lower.contains("api_key")
    || lower.contains("apikey")
    || lower.contains("passcode")
    || lower.contains("パスワード")
    || lower.contains("秘密鍵")
}

fn normalized_text(text: &str) -> String {
  text.split_whitespace().collect::<Vec<&str>>().join(" ")
}

fn source_kind(kind: &str) -> &'static str {
  match kind {
    "document" => "document",
    "conversation" => "conversation",
    "manual_note" => "manual_note",
    "background_onboarding" => "background_onboarding",
    "passive_capture" => "passive_capture",
    "mcp_proposal" => "mcp_proposal",
    _ => "manual_note",
  }
}

fn source_origin(origin: &str) -> &'static str {
  match origin {
    "user_upload" => "user_upload",
    "in_app_chat" => "in_app_chat",
    "manual_entry" => "manual_entry",
    "guided_onboarding" => "guided_onboarding",
    "passive_browser" => "passive_browser",
    "local_mcp" => "local_mcp",
    "remote_relay" => "remote_relay",
    _ => "manual_entry",
  }
}

fn passive_capture_enabled(vault: &Value) -> bool {
  vault
    .get("passiveCaptureSettings")
    .and_then(|settings| settings.get("enabled"))
    .and_then(Value::as_bool)
    .unwrap_or(false)
}

fn passive_capture_retention_days(vault: &Value) -> i64 {
  vault
    .get("passiveCaptureSettings")
    .and_then(|settings| settings.get("retentionDays"))
    .and_then(Value::as_i64)
    .unwrap_or(14)
    .clamp(1, 90)
}

fn default_passive_capture_settings() -> Value {
  json!({
    "enabled": false,
    "retentionDays": 14,
    "allowedSites": default_allowed_sites()
  })
}

fn default_allowed_sites() -> Vec<&'static str> {
  vec!["chat.openai.com", "chatgpt.com", "claude.ai", "gemini.google.com"]
}

fn normalize_allowed_sites(sites: Vec<String>) -> Vec<String> {
  let mut normalized = Vec::new();
  for site in sites {
    let raw = site.trim().to_lowercase();
    if raw.is_empty() {
      continue;
    }
    let host = host_from_url(&raw).unwrap_or(raw);
    let host = host
      .trim_start_matches("*.")
      .trim_matches('.')
      .to_string();
    if host.is_empty()
      || host.contains('/')
      || host.contains('@')
      || host.chars().any(char::is_whitespace)
    {
      continue;
    }
    if !normalized.iter().any(|item| item == &host) {
      normalized.push(host);
    }
  }
  normalized
}

fn passive_capture_site_allowed(vault: &Value, source_client: &str, url: &str) -> bool {
  if is_local_capture_url(source_client, url) {
    return true;
  }
  let Some(host) = host_from_url(url) else {
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

fn is_local_capture_url(source_client: &str, url: &str) -> bool {
  matches!(source_client, "codex" | "generic_mcp" | "copy_fallback")
    && (url.starts_with("lcv-local://") || url.starts_with("local://"))
}

fn host_from_url(url: &str) -> Option<String> {
  let without_scheme = url.split("://").nth(1).unwrap_or(url);
  let host = without_scheme
    .split('/')
    .next()
    .unwrap_or_default()
    .split(':')
    .next()
    .unwrap_or_default()
    .trim()
    .to_lowercase();
  if host.is_empty() {
    None
  } else {
    Some(host)
  }
}

fn sensitivity_tier(value: &str) -> Result<&'static str, String> {
  match value {
    "public" => Ok("public"),
    "personal" => Ok("personal"),
    "private_consequential" => Ok("private_consequential"),
    "sensitive" => Ok("sensitive"),
    "secret_never_send" => Ok("secret_never_send"),
    _ => Err(format!("unsupported sensitivity tier: {value}")),
  }
}

fn all_life_domains() -> Vec<&'static str> {
  vec![
    "identity_and_profile",
    "values_goals_and_preferences",
    "life_events_and_plans",
    "routines_and_logistics",
    "home_and_places",
    "documents_and_evidence",
    "contracts_and_policies",
    "procedures_and_obligations",
    "health_and_care",
    "finance_and_benefits",
    "work_and_education",
    "relationships_and_household",
    "constraints_and_accessibility",
  ]
}

fn default_policy_scopes(client_id: &str) -> Vec<&'static str> {
  if client_id == "conn_browser_capture" {
    vec!["passive_capture.write", "memory.propose"]
  } else {
    vec![
      "context_pack.request",
      "memory.propose",
      "policy.read",
      "request.status",
    ]
  }
}

fn default_policy_ceiling(client_id: &str) -> &'static str {
  match client_id {
    "conn_claude_desktop" => "sensitive",
    "conn_browser_capture" => "personal",
    _ => "private_consequential",
  }
}

fn default_policy_passive_capture_allowed(client_id: &str) -> bool {
  client_id == "conn_browser_capture"
}

fn default_access_policy_for_client(client_id: &str, now: &str) -> Value {
  json!({
    "id": format!("policy_{}", client_id.trim_start_matches("conn_")),
    "clientId": client_id,
    "scopes": default_policy_scopes(client_id),
    "domainAllowlist": all_life_domains(),
    "sensitivityCeiling": default_policy_ceiling(client_id),
    "requiresApprovalAbove": "personal",
    "passiveCaptureAllowed": default_policy_passive_capture_allowed(client_id),
    "createdAt": now,
    "updatedAt": now
  })
}

fn ensure_access_policy_for_client(vault: &mut Value, client_id: &str) {
  if !vault
    .get("accessPolicies")
    .map(Value::is_array)
    .unwrap_or(false)
  {
    vault["accessPolicies"] = json!([]);
  }
  let exists = vault
    .get("accessPolicies")
    .and_then(Value::as_array)
    .map(|policies| policies.iter().any(|policy| str_field(policy, "clientId") == client_id))
    .unwrap_or(false);
  if !exists {
    let policy = default_access_policy_for_client(client_id, &now_iso());
    push_json_array(vault, "accessPolicies", policy);
  }
}

fn client_label(client: &str) -> &'static str {
  match client {
    "chatgpt" => "ChatGPT",
    "claude_desktop" | "claude_remote" => "Claude",
    "gemini" => "Gemini",
    "codex" => "Codex",
    "copy_fallback" => "Copy fallback",
    _ => "AI chat",
  }
}

fn extract_memory_candidates_for_source(source_id: &str, body: &str, created_at: &str) -> Vec<Value> {
  let mut candidates = Vec::new();

  for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
    if let Some(candidate) = candidate_from_source_line(source_id, line, created_at) {
      candidates.push(candidate);
    }
  }

  if candidates.is_empty() && !body.trim().is_empty() {
    let text = body.chars().take(220).collect::<String>();
    candidates.push(memory_candidate(
      source_id,
      &text,
      classify_domain(&text),
      "note",
      "この情報は後で背景文脈として役立つ可能性があります。",
      None,
      "low",
      created_at,
    ));
  }

  candidates
}

fn candidate_from_source_line(source_id: &str, line: &str, created_at: &str) -> Option<Value> {
  let lower = line.to_lowercase();

  if contains_any(&lower, &["preferred name", "nickname", "名前", "呼び名"]) {
    return Some(memory_candidate(
      source_id,
      line,
      "identity_and_profile",
      "background_profile",
      "AIの呼び方や本人性の文脈として使えます。",
      None,
      "medium",
      created_at,
    ));
  }
  if contains_any(&lower, &["tone", "communication", "話し方", "文体", "口調", "伝え方"]) {
    return Some(memory_candidate(
      source_id,
      line,
      "values_goals_and_preferences",
      "preference",
      "文章作成や会話支援の出力を本人に合わせられます。",
      None,
      "medium",
      created_at,
    ));
  }
  if contains_any(&lower, &["goal", "priority", "want to", "目標", "優先", "大事", "やりたい"]) {
    return Some(memory_candidate(
      source_id,
      line,
      "values_goals_and_preferences",
      "goal",
      "提案や計画を本人の優先順位に合わせられます。",
      None,
      "medium",
      created_at,
    ));
  }
  if contains_any(&lower, &["constraint", "budget", "energy", "accessibility", "schedule", "制約", "予算", "体力", "予定", "アクセシビリティ"]) {
    return Some(memory_candidate(
      source_id,
      line,
      "constraints_and_accessibility",
      "constraint",
      "現実的な計画や提案の制約として重要です。",
      None,
      "medium",
      created_at,
    ));
  }

  let date = extract_yyyy_mm_dd(line);
  if date.is_some()
    && contains_any(
      &lower,
      &["deadline", "due", "renew", "expires", "expiration", "submit", "update", "期限", "締切", "更新", "提出", "満了"],
    )
  {
    return Some(memory_candidate(
      source_id,
      line,
      classify_domain(line),
      "deadline",
      "期限や更新日は生活上の手続きに影響します。",
      date,
      "medium",
      created_at,
    ));
  }

  if looks_like_contact_point(line) {
    return Some(memory_candidate(
      source_id,
      line,
      classify_domain(line),
      "contact_point",
      "必要なときの連絡先として参照できます。",
      None,
      "medium",
      created_at,
    ));
  }
  if contains_any(&lower, &["must", "need to", "required", "submit", "notify", "cancel", "renew", "必要", "提出", "連絡", "解約", "更新"]) {
    return Some(memory_candidate(
      source_id,
      line,
      classify_domain(line),
      "obligation",
      "やるべきことや注意点として後から役立ちます。",
      None,
      "medium",
      created_at,
    ));
  }
  if contains_any(&lower, &["moving", "move", "job change", "travel", "caregiving", "引っ越", "転職", "旅行", "介護", "入学", "卒業"]) {
    return Some(memory_candidate(
      source_id,
      line,
      "life_events_and_plans",
      "life_event",
      "生活イベントは関連する助言や手続きの前提になります。",
      None,
      "medium",
      created_at,
    ));
  }

  None
}

fn memory_candidate(
  source_id: &str,
  text: &str,
  domain: &str,
  candidate_type: &str,
  reason: &str,
  due_date: Option<String>,
  confidence: &str,
  created_at: &str,
) -> Value {
  let sensitivity = detect_sensitivity(text);
  let status = if sensitivity == "sensitive" || sensitivity == "secret_never_send" {
    "blocked_sensitive"
  } else {
    "new"
  };
  let mut candidate = json!({
    "id": new_id("cand"),
    "sourceIds": [source_id],
    "sourceChunkIds": [],
    "proposedFactText": normalized_text(text),
    "domain": domain,
    "candidateType": candidate_type,
    "detectedSensitivity": sensitivity,
    "confidence": confidence,
    "reasonToRemember": reason,
    "status": status,
    "createdAt": created_at,
    "createsFactIds": []
  });
  if let Some(due_date) = due_date {
    candidate["dueDate"] = Value::String(due_date);
  }
  candidate
}

fn looks_like_contact_point(text: &str) -> bool {
  let has_email_shape = text.contains('@') && text.contains('.');
  let digit_count = text.chars().filter(|character| character.is_ascii_digit()).count();
  has_email_shape || digit_count >= 9
}

fn extract_yyyy_mm_dd(text: &str) -> Option<String> {
  for token in text.split(|character: char| character.is_whitespace() || character == '.' || character == ',') {
    let candidate = token.trim_matches(|character: char| {
      !character.is_ascii_digit() && character != '-'
    });
    if candidate.len() == 10
      && candidate.as_bytes().get(4) == Some(&b'-')
      && candidate.as_bytes().get(7) == Some(&b'-')
      && NaiveDate::parse_from_str(candidate, "%Y-%m-%d").is_ok()
    {
      return Some(candidate.to_string());
    }
  }
  None
}

fn candidate_type_to_fact_type(candidate_type: &str) -> &'static str {
  match candidate_type {
    "deadline" => "deadline",
    "obligation" => "obligation",
    "contact_point" => "contact_point",
    "preference" => "preference",
    "relationship" => "relationship",
    "life_event" => "life_event",
    "goal" => "goal",
    "routine" => "routine",
    "constraint" => "constraint",
    "background_profile" => "background_profile",
    _ => "note",
  }
}

fn candidate_review_status(status: &str) -> Result<&'static str, String> {
  match status {
    "new" => Ok("new"),
    "needs_user_detail" => Ok("needs_user_detail"),
    "rejected" => Ok("rejected"),
    "archived" => Ok("archived"),
    "blocked_sensitive" => Ok("blocked_sensitive"),
    "approved" | "edited_and_approved" => {
      Err("use approve_candidate_at_path to create ApprovedFacts.".to_string())
    }
    _ => Err(format!("unsupported candidate status: {status}")),
  }
}

fn source_lifecycle_action(action: &str) -> Result<&'static str, String> {
  match action {
    "soft_delete" => Ok("soft_delete"),
    "restore" => Ok("restore"),
    "purge_body" => Ok("purge_body"),
    _ => Err(format!("unsupported source lifecycle action: {action}")),
  }
}

fn fact_lifecycle_action(action: &str) -> Result<&'static str, String> {
  match action {
    "keep_active" => Ok("keep_active"),
    "mark_needs_review" => Ok("mark_needs_review"),
    "hide" => Ok("hide"),
    "delete" => Ok("delete"),
    "restore" => Ok("restore"),
    _ => Err(format!("unsupported fact lifecycle action: {action}")),
  }
}

fn fact_status_for_action(action: &str) -> &'static str {
  match action {
    "keep_active" | "restore" => "active",
    "hide" => "user_hidden",
    "delete" => "deleted",
    _ => "needs_review",
  }
}

fn life_domain(value: &str) -> Result<&'static str, String> {
  match value {
    "identity_and_profile" => Ok("identity_and_profile"),
    "values_goals_and_preferences" => Ok("values_goals_and_preferences"),
    "life_events_and_plans" => Ok("life_events_and_plans"),
    "routines_and_logistics" => Ok("routines_and_logistics"),
    "home_and_places" => Ok("home_and_places"),
    "documents_and_evidence" => Ok("documents_and_evidence"),
    "contracts_and_policies" => Ok("contracts_and_policies"),
    "procedures_and_obligations" => Ok("procedures_and_obligations"),
    "health_and_care" => Ok("health_and_care"),
    "finance_and_benefits" => Ok("finance_and_benefits"),
    "work_and_education" => Ok("work_and_education"),
    "relationships_and_household" => Ok("relationships_and_household"),
    "constraints_and_accessibility" => Ok("constraints_and_accessibility"),
    _ => Err(format!("unsupported life context domain: {value}")),
  }
}

fn set_optional_fact_string(fact: &mut Value, key: &str, value: Option<&str>) {
  let normalized = value.map(normalized_text).unwrap_or_default();
  if normalized.is_empty() {
    if let Some(object) = fact.as_object_mut() {
      object.remove(key);
    }
  } else {
    fact[key] = Value::String(normalized);
  }
}

fn json_array_contains_string(value: &Value, needle: &str) -> bool {
  value
    .as_array()
    .map(|items| items.iter().any(|item| item.as_str() == Some(needle)))
    .unwrap_or(false)
}

fn source_ids_have_deleted_source_in_vault(vault: &Value, source_ids: &Value) -> bool {
  source_ids
    .as_array()
    .map(|ids| {
      ids.iter().filter_map(Value::as_str).any(|source_id| {
        vault
          .get("sources")
          .and_then(Value::as_array)
          .and_then(|sources| {
            sources
              .iter()
              .find(|source| str_field(source, "id") == source_id)
          })
          .map(|source| str_field(source, "deletionState") != "active")
          .unwrap_or(true)
      })
    })
    .unwrap_or(false)
}

fn archive_pending_candidates_for_source(vault: &mut Value, source_id: &str, now: &str) -> usize {
  let Some(candidates) = vault.get_mut("candidates").and_then(Value::as_array_mut) else {
    return 0;
  };
  let mut affected = 0;
  for candidate in candidates {
    let status = str_field(candidate, "status");
    if json_array_contains_string(candidate.get("sourceIds").unwrap_or(&Value::Null), source_id)
      && matches!(status.as_str(), "new" | "needs_user_detail" | "blocked_sensitive")
    {
      candidate["status"] = Value::String("archived".to_string());
      candidate["reviewedAt"] = Value::String(now.to_string());
      affected += 1;
    }
  }
  affected
}

fn mark_source_facts_needing_review(vault: &mut Value, source_id: &str, now: &str) -> Vec<String> {
  let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) else {
    return Vec::new();
  };
  let mut affected = Vec::new();
  for fact in facts {
    if str_field(fact, "status") == "active"
      && json_array_contains_string(fact.get("sourceIds").unwrap_or(&Value::Null), source_id)
    {
      let fact_id = str_field(fact, "id");
      fact["status"] = Value::String("needs_review".to_string());
      fact["updatedAt"] = Value::String(now.to_string());
      fact["reviewReason"] = Value::String("source_deleted".to_string());
      fact["reviewSourceId"] = Value::String(source_id.to_string());
      affected.push(fact_id);
    }
  }
  affected
}

fn restore_source_deleted_facts(vault: &mut Value, source_id: &str, now: &str) -> Vec<String> {
  let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) else {
    return Vec::new();
  };
  let mut affected = Vec::new();
  for fact in facts {
    if str_field(fact, "status") == "needs_review"
      && str_field(fact, "reviewReason") == "source_deleted"
      && str_field(fact, "reviewSourceId") == source_id
    {
      let fact_id = str_field(fact, "id");
      fact["status"] = Value::String("active".to_string());
      fact["updatedAt"] = Value::String(now.to_string());
      if let Some(object) = fact.as_object_mut() {
        object.remove("reviewReason");
        object.remove("reviewSourceId");
      }
      affected.push(fact_id);
    }
  }
  affected
}

fn fact_ids_for_source(vault: &Value, source_id: &str) -> Vec<String> {
  value_array(vault, "facts")
    .into_iter()
    .filter(|fact| json_array_contains_string(fact.get("sourceIds").unwrap_or(&Value::Null), source_id))
    .map(|fact| str_field(fact, "id"))
    .filter(|fact_id| !fact_id.is_empty())
    .collect()
}

fn invalidate_context_packs_for_facts(vault: &mut Value, fact_ids: &[String]) -> usize {
  invalidate_context_packs_for_facts_with_warning(
    vault,
    fact_ids,
    "source_deleted",
    "根拠Sourceが削除または消去されたため、このContext Packは無効化されました。",
  )
}

fn invalidate_context_packs_for_facts_with_warning(
  vault: &mut Value,
  fact_ids: &[String],
  warning_kind: &str,
  warning_message: &str,
) -> usize {
  if fact_ids.is_empty() {
    return 0;
  }
  let fact_set = fact_ids.iter().cloned().collect::<HashSet<_>>();
  let mut invalidated_request_ids = HashSet::new();
  let Some(packs) = vault.get_mut("contextPacks").and_then(Value::as_array_mut) else {
    return 0;
  };
  let mut affected = 0;
  for pack in packs {
    let has_affected_item = pack
      .get("items")
      .and_then(Value::as_array)
      .map(|items| {
        items.iter().any(|item| {
          item
            .get("factId")
            .and_then(Value::as_str)
            .map(|fact_id| fact_set.contains(fact_id))
            .unwrap_or(false)
        })
      })
      .unwrap_or(false);
    if has_affected_item && str_field(pack, "confirmationStatus") != "cancelled" {
      pack["confirmationStatus"] = Value::String("cancelled".to_string());
      let mut warnings = pack
        .get("warnings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
      warnings.insert(
        0,
        json!({
          "kind": warning_kind,
          "message": warning_message,
          "relatedIds": fact_ids
        }),
      );
      pack["warnings"] = Value::Array(warnings);
      if let Some(request_id) = pack.get("requestId").and_then(Value::as_str) {
        invalidated_request_ids.insert(request_id.to_string());
      }
      affected += 1;
    }
  }

  if let Some(requests) = vault
    .get_mut("contextPackRequests")
    .and_then(Value::as_array_mut)
  {
    for request in requests {
      if invalidated_request_ids.contains(&str_field(request, "id")) {
        request["status"] = Value::String("expired".to_string());
      }
    }
  }

  affected
}

fn copy_optional_candidate_field(candidate: &Value, fact: &mut Value, key: &str) {
  if let Some(value) = candidate.get(key).cloned() {
    if !value.as_str().map(str::is_empty).unwrap_or(false) {
      fact[key] = value;
    }
  }
}

fn update_candidate_in_vault<F>(
  vault: &mut Value,
  candidate_id: &str,
  mut update: F,
) -> Result<(), String>
where
  F: FnMut(&mut Value),
{
  let Some(candidates) = vault.get_mut("candidates").and_then(Value::as_array_mut) else {
    return Err("Vault has no candidates array.".to_string());
  };
  let Some(candidate) = candidates
    .iter_mut()
    .find(|candidate| str_field(candidate, "id") == candidate_id)
  else {
    return Err(format!("MemoryCandidate was not found: {candidate_id}"));
  };
  update(candidate);
  Ok(())
}

fn is_expired(value: &str) -> bool {
  if let Ok(datetime) = DateTime::parse_from_rfc3339(value) {
    return datetime.with_timezone(&Utc) <= Utc::now();
  }
  if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
    return date < Utc::now().date_naive();
  }
  false
}

fn policy_ceiling_for_client(vault: &Value, client_id: &str) -> String {
  value_array(vault, "accessPolicies")
    .into_iter()
    .find(|policy| str_field(policy, "clientId") == client_id)
    .map(|policy| str_field(policy, "sensitivityCeiling"))
    .filter(|ceiling| !ceiling.is_empty())
    .unwrap_or_else(|| "private_consequential".to_string())
}

fn push_json_array(value: &mut Value, key: &str, item: Value) {
  if !value.get(key).map(Value::is_array).unwrap_or(false) {
    value[key] = json!([]);
  }
  if let Some(items) = value.get_mut(key).and_then(Value::as_array_mut) {
    items.insert(0, item);
  }
}

fn touch_connector_in_vault(vault: &mut Value, client_id: &str, now: &str) {
  let Some(sessions) = vault.get_mut("connectorSessions").and_then(Value::as_array_mut) else {
    return;
  };
  for session in sessions {
    if str_field(session, "id") != client_id {
      continue;
    }
    let status = str_field(session, "status");
    if status == "available" || status == "needs_pairing" {
      session["status"] = Value::String("connected".to_string());
    }
    session["lastUsedAt"] = Value::String(now.to_string());
  }
}

fn audit_event(
  event_type: &str,
  subject_type: &str,
  subject_id: &str,
  sensitivity: &str,
  metadata: Value,
) -> Value {
  json!({
    "id": new_id("audit"),
    "eventType": event_type,
    "actor": "vault_core",
    "subjectType": subject_type,
    "subjectId": subject_id,
    "occurredAt": now_iso(),
    "sensitivity": sensitivity,
    "metadata": metadata
  })
}

fn empty_vault_json() -> Value {
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

fn days_from_now(days: i64) -> String {
  (Utc::now() + chrono::Duration::days(days))
    .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn stable_hash(text: &str) -> String {
  let mut hash = 2166136261u32;
  for byte in text.as_bytes() {
    hash ^= u32::from(*byte);
    hash = hash.wrapping_mul(16777619);
  }
  format!("hash_{hash:x}")
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
  mark_projection_synced(connection, &updated_at)?;
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
fn create_native_context_pack_request(
  app: AppHandle,
  client_id: String,
  client_name: String,
  task_text: String,
  purpose: Option<String>,
  sensitivity_ceiling: Option<String>,
  approval_mode: Option<String>,
) -> Result<NativeContextPackBuildResult, String> {
  let path = vault_db_path(&app)?;
  let result = create_context_pack_request_at_path(
    &path,
    &client_id,
    &client_name,
    &task_text,
    purpose.as_deref(),
    sensitivity_ceiling.as_deref(),
    approval_mode.as_deref(),
  )?;
  Ok(NativeContextPackBuildResult {
    payload: result.payload,
    updated_at: result.updated_at,
    request_id: result.request_id,
    pack_id: Some(result.pack_id),
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn update_native_context_pack_item_visibility(
  app: AppHandle,
  pack_id: String,
  fact_id: String,
  included: bool,
) -> Result<NativeContextPackMutationResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_context_pack_item_visibility_at_path(&path, &pack_id, &fact_id, included)?;
  Ok(NativeContextPackMutationResult {
    payload: result.payload,
    updated_at: result.updated_at,
    request_id: result.request_id,
    pack_id: result.pack_id,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn confirm_native_context_pack(
  app: AppHandle,
  pack_id: String,
) -> Result<NativeContextPackMutationResult, String> {
  let path = vault_db_path(&app)?;
  let result = confirm_context_pack_at_path(&path, &pack_id)?;
  Ok(NativeContextPackMutationResult {
    payload: result.payload,
    updated_at: result.updated_at,
    request_id: result.request_id,
    pack_id: result.pack_id,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn deny_native_context_pack_request(
  app: AppHandle,
  request_id: String,
) -> Result<NativeContextPackMutationResult, String> {
  let path = vault_db_path(&app)?;
  let result = deny_context_pack_request_at_path(&path, &request_id)?;
  Ok(NativeContextPackMutationResult {
    payload: result.payload,
    updated_at: result.updated_at,
    request_id: result.request_id,
    pack_id: result.pack_id,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn add_native_source_with_candidates(
  app: AppHandle,
  kind: String,
  origin: String,
  title: String,
  body: String,
) -> Result<NativeSourceIngestResult, String> {
  let path = vault_db_path(&app)?;
  let result = add_source_with_candidates_at_path(&path, &kind, &origin, &title, &body)?;
  Ok(NativeSourceIngestResult {
    payload: result.payload,
    updated_at: result.updated_at,
    source_id: result.source_id,
    candidate_ids: result.candidate_ids,
    detected_sensitivity: result.detected_sensitivity,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn approve_native_candidate(
  app: AppHandle,
  candidate_id: String,
  edited_text: Option<String>,
) -> Result<NativeCandidateReviewResult, String> {
  let path = vault_db_path(&app)?;
  let result = approve_candidate_at_path(&path, &candidate_id, edited_text.as_deref())?;
  Ok(NativeCandidateReviewResult {
    payload: result.payload,
    updated_at: result.updated_at,
    candidate_id: result.candidate_id,
    status: result.status,
    fact_id: result.fact_id,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn update_native_candidate_status(
  app: AppHandle,
  candidate_id: String,
  status: String,
) -> Result<NativeCandidateReviewResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_candidate_status_at_path(&path, &candidate_id, &status)?;
  Ok(NativeCandidateReviewResult {
    payload: result.payload,
    updated_at: result.updated_at,
    candidate_id: result.candidate_id,
    status: result.status,
    fact_id: result.fact_id,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn add_native_passive_capture_event(
  app: AppHandle,
  source_client: String,
  conversation_id: String,
  url: String,
  text: String,
  page_title: Option<String>,
  selected: Option<bool>,
) -> Result<NativePassiveCaptureResult, String> {
  let path = vault_db_path(&app)?;
  let result = add_passive_capture_event_at_path(
    &path,
    &source_client,
    &conversation_id,
    &url,
    &text,
    page_title.as_deref(),
    selected.unwrap_or(false),
  )?;
  Ok(NativePassiveCaptureResult {
    payload: result.payload,
    updated_at: result.updated_at,
    accepted: result.accepted,
    status: result.status,
    message: result.message,
    event_id: result.event_id,
    source_id: result.source_id,
    candidate_ids: result.candidate_ids,
    detected_sensitivity: result.detected_sensitivity,
    retention_until: result.retention_until,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn update_native_passive_capture_settings(
  app: AppHandle,
  enabled: Option<bool>,
  retention_days: Option<i64>,
  allowed_sites: Option<Vec<String>>,
) -> Result<NativeVaultSettingsUpdateResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_passive_capture_settings_at_path(
    &path,
    enabled,
    retention_days,
    allowed_sites,
  )?;
  Ok(NativeVaultSettingsUpdateResult {
    payload: result.payload,
    updated_at: result.updated_at,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn update_native_access_policy(
  app: AppHandle,
  client_id: String,
  sensitivity_ceiling: Option<String>,
  requires_approval_above: Option<String>,
  passive_capture_allowed: Option<bool>,
) -> Result<NativeVaultSettingsUpdateResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_access_policy_at_path(
    &path,
    &client_id,
    sensitivity_ceiling.as_deref(),
    requires_approval_above.as_deref(),
    passive_capture_allowed,
  )?;
  Ok(NativeVaultSettingsUpdateResult {
    payload: result.payload,
    updated_at: result.updated_at,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn update_native_source_lifecycle(
  app: AppHandle,
  source_id: String,
  action: String,
) -> Result<NativeSourceLifecycleResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_source_lifecycle_at_path(&path, &source_id, &action)?;
  Ok(NativeSourceLifecycleResult {
    payload: result.payload,
    updated_at: result.updated_at,
    source_id: result.source_id,
    action: result.action,
    affected_candidate_count: result.affected_candidate_count,
    affected_fact_count: result.affected_fact_count,
    invalidated_pack_count: result.invalidated_pack_count,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn update_native_source_metadata(
  app: AppHandle,
  source_id: String,
  title: String,
  default_sensitivity: String,
  promoted_to_long_term: Option<bool>,
) -> Result<NativeSourceMetadataResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_source_metadata_at_path(
    &path,
    &source_id,
    &title,
    &default_sensitivity,
    promoted_to_long_term,
  )?;
  Ok(NativeSourceMetadataResult {
    payload: result.payload,
    updated_at: result.updated_at,
    source_id: result.source_id,
    invalidated_pack_count: result.invalidated_pack_count,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn update_native_fact_lifecycle(
  app: AppHandle,
  fact_id: String,
  action: String,
) -> Result<NativeFactLifecycleResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_fact_lifecycle_at_path(&path, &fact_id, &action)?;
  Ok(NativeFactLifecycleResult {
    payload: result.payload,
    updated_at: result.updated_at,
    fact_id: result.fact_id,
    action: result.action,
    status: result.status,
    invalidated_pack_count: result.invalidated_pack_count,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn update_native_fact_metadata(
  app: AppHandle,
  fact_id: String,
  fact_text: String,
  domain: String,
  sensitivity: String,
  valid_from: Option<String>,
  valid_until: Option<String>,
  due_date: Option<String>,
) -> Result<NativeFactMetadataResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_fact_metadata_at_path(
    &path,
    &fact_id,
    &fact_text,
    &domain,
    &sensitivity,
    valid_from.as_deref(),
    valid_until.as_deref(),
    due_date.as_deref(),
  )?;
  Ok(NativeFactMetadataResult {
    payload: result.payload,
    updated_at: result.updated_at,
    fact_id: result.fact_id,
    invalidated_pack_count: result.invalidated_pack_count,
    generated_by: "native_vault_core".to_string(),
  })
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
      create_native_context_pack_request,
      update_native_context_pack_item_visibility,
      confirm_native_context_pack,
      deny_native_context_pack_request,
      add_native_source_with_candidates,
      approve_native_candidate,
      update_native_candidate_status,
      add_native_passive_capture_event,
      update_native_passive_capture_settings,
      update_native_access_policy,
      update_native_source_lifecycle,
      update_native_source_metadata,
      update_native_fact_lifecycle,
      update_native_fact_metadata,
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

  fn initialize_test_vault_connection(connection: &Connection) {
    connection
      .execute(
        "CREATE TABLE IF NOT EXISTS vault_state (
          key TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
      )
      .expect("vault_state table");
    ensure_vault_state_updated_at_column(connection).expect("vault_state updated_at");
    initialize_vault_schema(connection).expect("schema");
  }

  fn write_test_vault_state(connection: &Connection, payload: &str, updated_at: &str) {
    connection
      .execute(
        "INSERT INTO vault_state (key, payload, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at",
        params![VAULT_STATE_KEY, payload, updated_at],
      )
      .expect("write vault_state");
  }

  fn temp_vault_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|duration| duration.as_nanos())
      .unwrap_or_default();
    std::env::temp_dir().join(format!("life-context-vault-{name}-{nanos}.sqlite3"))
  }

  fn remove_temp_vault(path: &Path) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(path.with_extension("sqlite3-wal"));
    let _ = fs::remove_file(path.with_extension("sqlite3-shm"));
  }

  fn use_test_vault_key() {
    std::env::set_var("LCV_VAULT_DB_KEY", "0123456789abcdef0123456789abcdef");
  }

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
  fn opening_vault_syncs_projection_after_external_snapshot_write() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_test_vault_connection(&connection);

    let first_payload = r#"
    {
      "version": 2,
      "sources": [],
      "candidates": [],
      "facts": [
        {
          "id": "fact_address",
          "factText": "Moving address update is due before July.",
          "domain": "home_and_places",
          "factType": "deadline",
          "sourceIds": [],
          "sensitivity": "personal",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:20:00.000Z"
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
    write_test_vault_state(&connection, first_payload, "2026-06-12T00:00:00.000Z");
    sync_normalized_tables_if_stale(&mut connection).expect("first projection sync");

    let address_count: i64 = connection
      .query_row(
        "SELECT COUNT(*) FROM facts_fts WHERE facts_fts MATCH 'address'",
        [],
        |row| row.get(0),
      )
      .expect("address FTS count");
    let first_projection: String = connection
      .query_row(
        "SELECT value FROM projection_state WHERE key = ?1",
        params![PROJECTION_STATE_KEY],
        |row| row.get(0),
      )
      .expect("first projection state");
    assert_eq!(address_count, 1);
    assert_eq!(first_projection, "2026-06-12T00:00:00.000Z");

    let second_payload = r#"
    {
      "version": 2,
      "sources": [],
      "candidates": [],
      "facts": [
        {
          "id": "fact_passport",
          "factText": "Passport renewal reminder is due in September.",
          "domain": "identity_and_profile",
          "factType": "deadline",
          "sourceIds": [],
          "sensitivity": "private_consequential",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T01:00:00.000Z",
          "approvedAt": "2026-06-12T01:10:00.000Z",
          "updatedAt": "2026-06-12T01:20:00.000Z"
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
    write_test_vault_state(&connection, second_payload, "2026-06-12T01:00:00.000Z");
    sync_normalized_tables_if_stale(&mut connection).expect("stale projection resync");

    let stale_address_count: i64 = connection
      .query_row(
        "SELECT COUNT(*) FROM facts_fts WHERE facts_fts MATCH 'address'",
        [],
        |row| row.get(0),
      )
      .expect("stale address FTS count");
    let passport_count: i64 = connection
      .query_row(
        "SELECT COUNT(*) FROM facts_fts WHERE facts_fts MATCH 'passport'",
        [],
        |row| row.get(0),
      )
      .expect("passport FTS count");
    let fact_ids: Vec<String> = connection
      .prepare("SELECT id FROM facts ORDER BY id")
      .expect("facts statement")
      .query_map([], |row| row.get::<_, String>(0))
      .expect("facts query")
      .collect::<Result<Vec<_>, _>>()
      .expect("facts collect");
    let second_projection: String = connection
      .query_row(
        "SELECT value FROM projection_state WHERE key = ?1",
        params![PROJECTION_STATE_KEY],
        |row| row.get(0),
      )
      .expect("second projection state");

    assert_eq!(stale_address_count, 0);
    assert_eq!(passport_count, 1);
    assert_eq!(fact_ids, vec!["fact_passport"]);
    assert_eq!(second_projection, "2026-06-12T01:00:00.000Z");
  }

  #[test]
  fn saving_vault_marks_projection_revision() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_test_vault_connection(&connection);

    let payload = r#"
    {
      "version": 2,
      "sources": [],
      "candidates": [],
      "facts": [
        {
          "id": "fact_policy",
          "factText": "Insurance policy renews each October.",
          "domain": "contracts_and_policies",
          "factType": "deadline",
          "sourceIds": [],
          "sensitivity": "private_consequential",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:20:00.000Z"
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

    let result = save_vault_state_payload(&mut connection, payload, None).expect("save vault");
    let projection: String = connection
      .query_row(
        "SELECT value FROM projection_state WHERE key = ?1",
        params![PROJECTION_STATE_KEY],
        |row| row.get(0),
      )
      .expect("projection state");

    assert!(!result.conflict);
    assert_eq!(Some(projection), result.updated_at);
  }

  #[test]
  fn native_source_ingest_creates_candidates_not_facts_and_syncs_projection() {
    use_test_vault_key();
    let path = temp_vault_path("source-ingest");
    let result = add_source_with_candidates_at_path(
      &path,
      "document",
      "user_upload",
      "Renewal note",
      "Insurance policy renews on 2026-08-31.\nNeed to update address before renewal.\nContact support@example.com for policy changes.",
    )
    .expect("source ingest");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let source_count = saved
      .get("sources")
      .and_then(Value::as_array)
      .map(Vec::len)
      .unwrap_or_default();
    let candidate_count = saved
      .get("candidates")
      .and_then(Value::as_array)
      .map(Vec::len)
      .unwrap_or_default();
    let fact_count = saved
      .get("facts")
      .and_then(Value::as_array)
      .map(Vec::len)
      .unwrap_or_default();
    let candidate_types = saved
      .get("candidates")
      .and_then(Value::as_array)
      .cloned()
      .unwrap_or_default()
      .into_iter()
      .filter_map(|candidate| candidate.get("candidateType").and_then(Value::as_str).map(str::to_string))
      .collect::<Vec<_>>();

    assert_eq!(source_count, 1);
    assert_eq!(candidate_count, 3);
    assert_eq!(fact_count, 0);
    assert!(candidate_types.contains(&"deadline".to_string()));
    assert!(candidate_types.contains(&"obligation".to_string()));
    assert!(candidate_types.contains(&"contact_point".to_string()));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let normalized_source_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
      .expect("normalized source count");
    let normalized_candidate_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM memory_candidates", [], |row| row.get(0))
      .expect("normalized candidate count");
    let normalized_chunk_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM source_chunks", [], |row| row.get(0))
      .expect("normalized chunk count");
    let normalized_fact_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("normalized fact count");
    let projection: String = connection
      .query_row(
        "SELECT value FROM projection_state WHERE key = ?1",
        params![PROJECTION_STATE_KEY],
        |row| row.get(0),
      )
      .expect("projection state");

    assert_eq!(normalized_source_count, 1);
    assert_eq!(normalized_candidate_count, 3);
    assert_eq!(normalized_chunk_count, 1);
    assert_eq!(normalized_fact_count, 0);
    assert_eq!(Some(projection), result.updated_at);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_source_ingest_redacts_secret_values_and_blocks_candidate() {
    use_test_vault_key();
    let path = temp_vault_path("source-secret");
    let result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Secret note",
      "API key sk-test-12345 should not be stored.\nPassword hunter2",
    )
    .expect("source ingest");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let source_body = saved
      .get("sources")
      .and_then(Value::as_array)
      .and_then(|sources| sources.first())
      .and_then(|source| source.get("body"))
      .and_then(Value::as_str)
      .unwrap_or_default();
    let candidate = saved
      .get("candidates")
      .and_then(Value::as_array)
      .and_then(|candidates| candidates.first())
      .expect("candidate");

    assert!(!source_body.contains("sk-test-12345"));
    assert!(!source_body.contains("hunter2"));
    assert_eq!(
      candidate.get("detectedSensitivity").and_then(Value::as_str),
      Some("secret_never_send")
    );
    assert_eq!(
      candidate.get("status").and_then(Value::as_str),
      Some("blocked_sensitive")
    );
    assert!(
      saved
        .get("facts")
        .and_then(Value::as_array)
        .map(Vec::is_empty)
        .unwrap_or(false)
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn native_source_soft_delete_marks_facts_review_and_invalidates_packs() {
    use_test_vault_key();
    let path = temp_vault_path("source-soft-delete");
    let source_result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Lease note",
      "Need to renew lease by 2027-01-15.\nContact landlord at landlord@example.com.",
    )
    .expect("source ingest");
    let candidate_id = source_result
      .candidate_ids
      .first()
      .cloned()
      .expect("candidate id");
    approve_candidate_at_path(&path, &candidate_id, None).expect("approve candidate");
    create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "What should I remember about my lease renewal?",
      Some("test"),
      Some("sensitive"),
      Some("explicit_sensitive"),
    )
    .expect("context pack");

    let result = update_source_lifecycle_at_path(&path, &source_result.source_id, "soft_delete")
      .expect("soft delete source");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let source = saved
      .get("sources")
      .and_then(Value::as_array)
      .and_then(|sources| sources.iter().find(|source| str_field(source, "id") == source_result.source_id))
      .expect("source");
    let fact = saved
      .get("facts")
      .and_then(Value::as_array)
      .and_then(|facts| facts.first())
      .expect("fact");
    let pack = saved
      .get("contextPacks")
      .and_then(Value::as_array)
      .and_then(|packs| packs.first())
      .expect("pack");
    let request = saved
      .get("contextPackRequests")
      .and_then(Value::as_array)
      .and_then(|requests| requests.first())
      .expect("request");

    assert_eq!(source.get("deletionState").and_then(Value::as_str), Some("soft_deleted"));
    assert_eq!(source.get("processingStatus").and_then(Value::as_str), Some("deleted"));
    assert_eq!(fact.get("status").and_then(Value::as_str), Some("needs_review"));
    assert_eq!(fact.get("reviewReason").and_then(Value::as_str), Some("source_deleted"));
    assert_eq!(result.affected_fact_count, 1);
    assert_eq!(result.invalidated_pack_count, 1);
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("cancelled")
    );
    assert_eq!(request.get("status").and_then(Value::as_str), Some("expired"));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let search = search_facts_in_connection(&connection, "lease", None, None, 20).expect("search facts");
    let normalized_status: String = connection
      .query_row("SELECT status FROM facts LIMIT 1", [], |row| row.get(0))
      .expect("normalized fact status");

    assert!(search.is_empty());
    assert_eq!(normalized_status, "needs_review");
    remove_temp_vault(&path);
  }

  #[test]
  fn native_source_purge_removes_body_and_blocks_candidate_approval() {
    use_test_vault_key();
    let path = temp_vault_path("source-purge");
    let source_result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Moving note",
      "Need to update address before moving.",
    )
    .expect("source ingest");
    let candidate_id = source_result
      .candidate_ids
      .first()
      .cloned()
      .expect("candidate id");

    let result = update_source_lifecycle_at_path(&path, &source_result.source_id, "purge_body")
      .expect("purge source");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let source = saved
      .get("sources")
      .and_then(Value::as_array)
      .and_then(|sources| sources.iter().find(|source| str_field(source, "id") == source_result.source_id))
      .expect("source");
    let candidate = saved
      .get("candidates")
      .and_then(Value::as_array)
      .and_then(|candidates| candidates.iter().find(|candidate| str_field(candidate, "id") == candidate_id))
      .expect("candidate");
    let approval_error = match approve_candidate_at_path(&path, &candidate_id, None) {
      Ok(_) => panic!("purged source candidate should not approve"),
      Err(error) => error,
    };

    assert_eq!(source.get("body").and_then(Value::as_str), Some(""));
    assert_eq!(source.get("deletionState").and_then(Value::as_str), Some("purged"));
    assert_eq!(candidate.get("status").and_then(Value::as_str), Some("archived"));
    assert!(approval_error.contains("deleted or purged Sources"));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let normalized_body: String = connection
      .query_row(
        "SELECT body FROM sources WHERE id = ?1",
        params![source_result.source_id],
        |row| row.get(0),
      )
      .expect("normalized source body");
    assert!(normalized_body.is_empty());
    remove_temp_vault(&path);
  }

  #[test]
  fn native_source_metadata_update_invalidates_pack_and_filters_secret_titles() {
    use_test_vault_key();
    let path = temp_vault_path("source-metadata");
    let source_result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Lease note",
      "Need to renew lease by 2027-01-15.",
    )
    .expect("source ingest");
    let candidate_id = source_result
      .candidate_ids
      .first()
      .cloned()
      .expect("candidate id");
    approve_candidate_at_path(&path, &candidate_id, None).expect("approve candidate");
    let first_pack = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "What should I remember about lease renewal?",
      Some("test"),
      Some("sensitive"),
      Some("explicit_sensitive"),
    )
    .expect("context pack");

    let updated = update_source_metadata_at_path(
      &path,
      &source_result.source_id,
      "Apartment lease evidence",
      "private_consequential",
      Some(true),
    )
    .expect("source metadata update");
    let saved: Value = serde_json::from_str(&updated.payload).expect("saved vault json");
    let source = saved
      .get("sources")
      .and_then(Value::as_array)
      .and_then(|sources| sources.iter().find(|source| str_field(source, "id") == source_result.source_id))
      .expect("source");
    let cancelled_pack = find_vault_item_by_id(&saved, "contextPacks", &first_pack.pack_id)
      .expect("cancelled pack");

    assert_eq!(updated.invalidated_pack_count, 1);
    assert_eq!(source.get("title").and_then(Value::as_str), Some("Apartment lease evidence"));
    assert_eq!(
      source.get("defaultSensitivity").and_then(Value::as_str),
      Some("private_consequential")
    );
    assert_eq!(
      cancelled_pack.get("confirmationStatus").and_then(Value::as_str),
      Some("cancelled")
    );
    assert_eq!(
      cancelled_pack
        .get("warnings")
        .and_then(Value::as_array)
        .and_then(|warnings| warnings.first())
        .and_then(|warning| warning.get("kind"))
        .and_then(Value::as_str),
      Some("stale_fact")
    );

    update_source_metadata_at_path(
      &path,
      &source_result.source_id,
      "Private password file",
      "secret_never_send",
      Some(false),
    )
    .expect("secret source metadata update");
    let second_pack = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "What should I remember about lease renewal?",
      Some("test"),
      Some("sensitive"),
      Some("explicit_sensitive"),
    )
    .expect("second context pack");
    let second_saved: Value = serde_json::from_str(&second_pack.payload).expect("second vault json");
    let pack = find_vault_item_by_id(&second_saved, "contextPacks", &second_pack.pack_id)
      .expect("second pack");
    let item = pack
      .get("items")
      .and_then(Value::as_array)
      .and_then(|items| items.first())
      .expect("pack item");

    assert!(item
      .get("sourceTitles")
      .and_then(Value::as_array)
      .map(Vec::is_empty)
      .unwrap_or(false));
    assert!(pack
      .get("sourceSnippets")
      .and_then(Value::as_array)
      .map(Vec::is_empty)
      .unwrap_or(false));
    remove_temp_vault(&path);
  }

  #[test]
  fn native_fact_lifecycle_hide_invalidates_pack_and_search() {
    use_test_vault_key();
    let path = temp_vault_path("fact-hide");
    let source_result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Insurance note",
      "Need to renew insurance by 2027-02-01.",
    )
    .expect("source ingest");
    let candidate_id = source_result
      .candidate_ids
      .first()
      .cloned()
      .expect("candidate id");
    let reviewed = approve_candidate_at_path(&path, &candidate_id, None).expect("approve candidate");
    let fact_id = reviewed.fact_id.expect("fact id");
    create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "What should I remember about insurance renewal?",
      Some("test"),
      Some("sensitive"),
      Some("explicit_sensitive"),
    )
    .expect("context pack");

    let result = update_fact_lifecycle_at_path(&path, &fact_id, "hide").expect("hide fact");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let fact = saved
      .get("facts")
      .and_then(Value::as_array)
      .and_then(|facts| facts.iter().find(|fact| str_field(fact, "id") == fact_id))
      .expect("fact");
    let pack = saved
      .get("contextPacks")
      .and_then(Value::as_array)
      .and_then(|packs| packs.first())
      .expect("pack");

    assert_eq!(result.status, "user_hidden");
    assert_eq!(result.invalidated_pack_count, 1);
    assert_eq!(fact.get("status").and_then(Value::as_str), Some("user_hidden"));
    assert_eq!(pack.get("confirmationStatus").and_then(Value::as_str), Some("cancelled"));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let search = search_facts_in_connection(&connection, "insurance", None, None, 20).expect("search facts");
    assert!(search.is_empty());
    remove_temp_vault(&path);
  }

  #[test]
  fn native_fact_lifecycle_keep_active_restores_review_fact() {
    use_test_vault_key();
    let path = temp_vault_path("fact-keep-active");
    let source_result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Lease note",
      "Need to renew lease by 2027-01-15.",
    )
    .expect("source ingest");
    let candidate_id = source_result
      .candidate_ids
      .first()
      .cloned()
      .expect("candidate id");
    let reviewed = approve_candidate_at_path(&path, &candidate_id, None).expect("approve candidate");
    let fact_id = reviewed.fact_id.expect("fact id");
    update_source_lifecycle_at_path(&path, &source_result.source_id, "soft_delete")
      .expect("soft delete source");

    let result = update_fact_lifecycle_at_path(&path, &fact_id, "keep_active")
      .expect("keep fact active");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let fact = saved
      .get("facts")
      .and_then(Value::as_array)
      .and_then(|facts| facts.iter().find(|fact| str_field(fact, "id") == fact_id))
      .expect("fact");

    assert_eq!(result.status, "active");
    assert_eq!(fact.get("status").and_then(Value::as_str), Some("active"));
    assert!(fact.get("reviewReason").is_none());
    assert!(fact.get("reviewSourceId").is_none());

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let search = search_facts_in_connection(&connection, "lease", None, None, 20).expect("search facts");
    assert_eq!(search.len(), 1);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_fact_metadata_update_syncs_fts_and_invalidates_pack() {
    use_test_vault_key();
    let path = temp_vault_path("fact-metadata");
    let source_result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Lease note",
      "Need to renew lease by 2027-01-15.",
    )
    .expect("source ingest");
    let candidate_id = source_result
      .candidate_ids
      .first()
      .cloned()
      .expect("candidate id");
    let reviewed = approve_candidate_at_path(&path, &candidate_id, None).expect("approve candidate");
    let fact_id = reviewed.fact_id.expect("fact id");
    create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "What should I remember about lease renewal?",
      Some("test"),
      Some("sensitive"),
      Some("explicit_sensitive"),
    )
    .expect("context pack");

    let result = update_fact_metadata_at_path(
      &path,
      &fact_id,
      "Need to renew apartment lease by 2027-03-20.",
      "contracts_and_policies",
      "private_consequential",
      Some(""),
      Some("2027-03-20"),
      Some("2027-03-20"),
    )
    .expect("metadata update");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let fact = saved
      .get("facts")
      .and_then(Value::as_array)
      .and_then(|facts| facts.iter().find(|fact| str_field(fact, "id") == fact_id))
      .expect("fact");
    let pack = saved
      .get("contextPacks")
      .and_then(Value::as_array)
      .and_then(|packs| packs.first())
      .expect("pack");

    assert_eq!(result.invalidated_pack_count, 1);
    assert_eq!(
      fact.get("factText").and_then(Value::as_str),
      Some("Need to renew apartment lease by 2027-03-20.")
    );
    assert_eq!(
      fact.get("domain").and_then(Value::as_str),
      Some("contracts_and_policies")
    );
    assert!(fact.get("validFrom").is_none());
    assert_eq!(pack.get("confirmationStatus").and_then(Value::as_str), Some("cancelled"));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let old_search = search_facts_in_connection(&connection, "2027-01-15", None, None, 20)
      .expect("old search");
    let new_search = search_facts_in_connection(&connection, "apartment", None, None, 20)
      .expect("new search");
    assert!(old_search.is_empty());
    assert_eq!(new_search.len(), 1);

    let secret_result = update_fact_metadata_at_path(
      &path,
      &fact_id,
      "Secret value should not become an ApprovedFact.",
      "contracts_and_policies",
      "secret_never_send",
      None,
      None,
      None,
    );
    assert!(secret_result.is_err());
    remove_temp_vault(&path);
  }

  #[test]
  fn passive_capture_site_policy_matches_allowed_browser_and_local_clients() {
    let vault = empty_vault_json();

    assert!(passive_capture_site_allowed(
      &vault,
      "chatgpt",
      "https://chatgpt.com/c/123"
    ));
    assert!(passive_capture_site_allowed(
      &vault,
      "claude_remote",
      "https://claude.ai/chat/123"
    ));
    assert!(passive_capture_site_allowed(
      &vault,
      "codex",
      "lcv-local://codex/thread"
    ));
    assert!(passive_capture_site_allowed(
      &vault,
      "copy_fallback",
      "lcv-local://copy_fallback/thread"
    ));
    assert!(!passive_capture_site_allowed(
      &vault,
      "chatgpt",
      "https://example.com/chat/123"
    ));
  }

  #[test]
  fn native_passive_capture_refuses_when_paused_without_creating_events() {
    use_test_vault_key();
    let path = temp_vault_path("passive-paused");
    let result = add_passive_capture_event_at_path(
      &path,
      "chatgpt",
      "thread",
      "https://chatgpt.com/c/thread",
      "Tone preference: concise",
      Some("ChatGPT"),
      true,
    )
    .expect("passive capture response");
    let saved: Value = serde_json::from_str(&result.payload).expect("vault json");

    assert!(!result.accepted);
    assert_eq!(result.status, "capture_paused");
    assert_eq!(
      saved
        .get("passiveCaptureEvents")
        .and_then(Value::as_array)
        .map(Vec::len),
      Some(0)
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn native_passive_capture_refuses_unallowed_site() {
    use_test_vault_key();
    let path = temp_vault_path("passive-site");
    let mut connection = open_vault_db_at_path(&path).expect("open vault");
    let mut vault = empty_vault_json();
    vault["passiveCaptureSettings"]["enabled"] = json!(true);
    save_vault_json_with_projection(&mut connection, &vault).expect("seed vault");
    drop(connection);

    let result = add_passive_capture_event_at_path(
      &path,
      "chatgpt",
      "thread",
      "https://example.com/c/thread",
      "Tone preference: concise",
      Some("Example"),
      true,
    )
    .expect("passive capture response");
    let saved: Value = serde_json::from_str(&result.payload).expect("vault json");

    assert!(!result.accepted);
    assert_eq!(result.status, "site_not_allowed");
    assert_eq!(
      saved
        .get("passiveCaptureEvents")
        .and_then(Value::as_array)
        .map(Vec::len),
      Some(0)
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn native_passive_capture_creates_candidates_not_facts_and_syncs_projection() {
    use_test_vault_key();
    let path = temp_vault_path("passive-capture");
    let mut connection = open_vault_db_at_path(&path).expect("open vault");
    let mut vault = empty_vault_json();
    vault["passiveCaptureSettings"]["enabled"] = json!(true);
    save_vault_json_with_projection(&mut connection, &vault).expect("seed vault");
    drop(connection);

    let result = add_passive_capture_event_at_path(
      &path,
      "chatgpt",
      "thread",
      "https://chatgpt.com/c/thread",
      "Tone preference: concise and calm.\nPassword hunter2\nNeed to update address before moving.",
      Some("ChatGPT thread"),
      true,
    )
    .expect("passive capture");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let source_body = saved
      .get("sources")
      .and_then(Value::as_array)
      .and_then(|sources| sources.first())
      .and_then(|source| source.get("body"))
      .and_then(Value::as_str)
      .unwrap_or_default();
    let facts_count = saved
      .get("facts")
      .and_then(Value::as_array)
      .map(Vec::len)
      .unwrap_or_default();
    let passive_event_count = saved
      .get("passiveCaptureEvents")
      .and_then(Value::as_array)
      .map(Vec::len)
      .unwrap_or_default();

    assert!(result.accepted);
    assert_eq!(result.status, "candidate_generated");
    assert!(!result.candidate_ids.is_empty());
    assert_eq!(facts_count, 0);
    assert_eq!(passive_event_count, 1);
    assert!(source_body.contains("[REDACTED_SECRET]"));
    assert!(!source_body.contains("hunter2"));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let normalized_source_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
      .expect("normalized source count");
    let normalized_candidate_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM memory_candidates", [], |row| row.get(0))
      .expect("normalized candidate count");
    let normalized_fact_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("normalized fact count");
    let normalized_capture_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM passive_capture_events", [], |row| row.get(0))
      .expect("normalized capture count");

    assert_eq!(normalized_source_count, 1);
    assert_eq!(normalized_candidate_count, result.candidate_ids.len() as i64);
    assert_eq!(normalized_fact_count, 0);
    assert_eq!(normalized_capture_count, 1);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_passive_capture_settings_update_normalizes_sites_and_audits() {
    use_test_vault_key();
    let path = temp_vault_path("passive-settings");
    let result = update_passive_capture_settings_at_path(
      &path,
      Some(true),
      Some(120),
      Some(vec![
        "https://chatgpt.com/c/thread".to_string(),
        "*.Claude.ai".to_string(),
        "bad host".to_string(),
        "chatgpt.com".to_string(),
      ]),
    )
    .expect("settings update");
    let saved: Value = serde_json::from_str(&result.payload).expect("vault json");
    let settings = saved
      .get("passiveCaptureSettings")
      .expect("passive capture settings");
    let audit_count = saved
      .get("auditEvents")
      .and_then(Value::as_array)
      .map(Vec::len)
      .unwrap_or_default();

    assert_eq!(settings.get("enabled").and_then(Value::as_bool), Some(true));
    assert_eq!(settings.get("retentionDays").and_then(Value::as_i64), Some(90));
    assert_eq!(
      settings.get("allowedSites").cloned().unwrap_or_else(|| json!([])),
      json!(["chatgpt.com", "claude.ai"])
    );
    assert_eq!(audit_count, 1);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_access_policy_update_syncs_projection() {
    use_test_vault_key();
    let path = temp_vault_path("policy-update");
    let result = update_access_policy_at_path(
      &path,
      "conn_chatgpt",
      Some("personal"),
      Some("public"),
      Some(false),
    )
    .expect("policy update");
    let saved: Value = serde_json::from_str(&result.payload).expect("vault json");
    let policy = saved
      .get("accessPolicies")
      .and_then(Value::as_array)
      .and_then(|policies| {
        policies
          .iter()
          .find(|policy| str_field(policy, "clientId") == "conn_chatgpt")
      })
      .expect("policy");

    assert_eq!(
      policy.get("sensitivityCeiling").and_then(Value::as_str),
      Some("personal")
    );
    assert_eq!(
      policy.get("requiresApprovalAbove").and_then(Value::as_str),
      Some("public")
    );

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let normalized_policy_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM access_policies", [], |row| row.get(0))
      .expect("normalized policy count");
    let audit_count: i64 = connection
      .query_row(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = 'policy_updated'",
        [],
        |row| row.get(0),
      )
      .expect("audit count");

    assert_eq!(normalized_policy_count, 1);
    assert_eq!(audit_count, 1);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_candidate_approval_creates_fact_and_syncs_fts() {
    use_test_vault_key();
    let path = temp_vault_path("candidate-approve");
    let ingested = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Tone",
      "Tone preference: concise and calm",
    )
    .expect("source ingest");
    let candidate_id = ingested
      .candidate_ids
      .first()
      .expect("candidate id")
      .to_string();

    let reviewed = approve_candidate_at_path(
      &path,
      &candidate_id,
      Some("Tone preference: concise, calm, and concrete"),
    )
    .expect("approve candidate");
    let saved: Value = serde_json::from_str(&reviewed.payload).expect("saved vault json");
    let facts = saved.get("facts").and_then(Value::as_array).expect("facts");
    let candidate = saved
      .get("candidates")
      .and_then(Value::as_array)
      .and_then(|candidates| {
        candidates
          .iter()
          .find(|candidate| str_field(candidate, "id") == candidate_id)
      })
      .expect("candidate");

    assert_eq!(facts.len(), 1);
    assert_eq!(
      facts[0].get("factText").and_then(Value::as_str),
      Some("Tone preference: concise, calm, and concrete")
    );
    assert_eq!(
      candidate.get("status").and_then(Value::as_str),
      Some("edited_and_approved")
    );
    assert_eq!(
      candidate
        .get("createsFactIds")
        .and_then(Value::as_array)
        .and_then(|ids| ids.first())
        .and_then(Value::as_str),
      reviewed.fact_id.as_deref()
    );

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let fact_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("fact count");
    let fts_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts_fts WHERE facts_fts MATCH 'concrete'", [], |row| row.get(0))
      .expect("fts count");

    assert_eq!(fact_count, 1);
    assert_eq!(fts_count, 1);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_candidate_status_update_does_not_create_fact() {
    use_test_vault_key();
    let path = temp_vault_path("candidate-status");
    let ingested = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Move",
      "Need to update address before renewal.",
    )
    .expect("source ingest");
    let candidate_id = ingested
      .candidate_ids
      .first()
      .expect("candidate id")
      .to_string();

    let reviewed = update_candidate_status_at_path(&path, &candidate_id, "archived")
      .expect("archive candidate");
    let saved: Value = serde_json::from_str(&reviewed.payload).expect("saved vault json");
    let candidate = saved
      .get("candidates")
      .and_then(Value::as_array)
      .and_then(|candidates| candidates.first())
      .expect("candidate");

    assert_eq!(reviewed.fact_id, None);
    assert_eq!(candidate.get("status").and_then(Value::as_str), Some("archived"));
    assert!(
      saved
        .get("facts")
        .and_then(Value::as_array)
        .map(Vec::is_empty)
        .unwrap_or(false)
    );

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let normalized_status: String = connection
      .query_row(
        "SELECT status FROM memory_candidates WHERE id = ?1",
        params![candidate_id],
        |row| row.get(0),
      )
      .expect("candidate status");
    let normalized_fact_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("fact count");

    assert_eq!(normalized_status, "archived");
    assert_eq!(normalized_fact_count, 0);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_candidate_approval_rejects_secret_never_send() {
    use_test_vault_key();
    let path = temp_vault_path("candidate-secret-approval");
    let ingested = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Secret",
      "Password hunter2",
    )
    .expect("source ingest");
    let candidate_id = ingested
      .candidate_ids
      .first()
      .expect("candidate id")
      .to_string();

    let error = match approve_candidate_at_path(&path, &candidate_id, None) {
      Ok(_) => panic!("secret candidate should not be approved"),
      Err(error) => error,
    };
    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let fact_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("fact count");

    assert!(error.contains("secret_never_send"));
    assert_eq!(fact_count, 0);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_context_pack_uses_approved_facts_and_fact_only_snippets() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_test_vault_connection(&connection);
    let payload = r#"
    {
      "version": 2,
      "sources": [
        {
          "id": "src_policy",
          "kind": "document",
          "title": "Insurance PDF",
          "origin": "user_upload",
          "body": "RAW_POLICY_BODY account number 123456 should never be copied.",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "capturedAt": "2026-06-12T00:00:00.000Z",
          "defaultSensitivity": "personal",
          "processingStatus": "ready",
          "deletionState": "active"
        }
      ],
      "candidates": [
        {
          "id": "cand_unapproved",
          "sourceIds": ["src_policy"],
          "proposedFactText": "Unapproved candidate text must not become trusted context.",
          "domain": "contracts_and_policies",
          "candidateType": "note",
          "detectedSensitivity": "personal",
          "confidence": "high",
          "status": "new",
          "createdAt": "2026-06-12T00:00:00.000Z"
        }
      ],
      "facts": [
        {
          "id": "fact_insurance",
          "factText": "Insurance policy renews on 2026-09-01.",
          "domain": "contracts_and_policies",
          "factType": "deadline",
          "sourceIds": ["src_policy"],
          "sensitivity": "private_consequential",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:20:00.000Z"
        }
      ],
      "accessPolicies": [
        {
          "id": "policy_chatgpt",
          "clientId": "conn_chatgpt",
          "scopes": ["context_pack.request"],
          "domainAllowlist": ["contracts_and_policies"],
          "sensitivityCeiling": "private_consequential",
          "requiresApprovalAbove": "personal",
          "passiveCaptureAllowed": false,
          "createdAt": "2026-06-12T00:00:00.000Z",
          "updatedAt": "2026-06-12T00:00:00.000Z"
        }
      ],
      "contextPackRequests": [],
      "contextPacks": [],
      "connectorSessions": [],
      "passiveCaptureEvents": [],
      "auditEvents": []
    }
    "#;
    sync_normalized_tables(&mut connection, payload).expect("sync");
    let mut vault: Value = serde_json::from_str(payload).expect("vault json");

    let (request_id, pack_id) = create_native_context_pack_request_in_connection(
      &connection,
      &mut vault,
      "conn_chatgpt",
      "ChatGPT",
      "What should I check for insurance renewal?",
      Some("普段使うAIへの回答文脈"),
      None,
      Some("explicit_sensitive"),
    )
    .expect("native context pack");

    let request = vault
      .get("contextPackRequests")
      .and_then(Value::as_array)
      .and_then(|requests| requests.first())
      .expect("request");
    let pack = vault
      .get("contextPacks")
      .and_then(Value::as_array)
      .and_then(|packs| packs.first())
      .expect("pack");
    let items = pack.get("items").and_then(Value::as_array).expect("items");
    let snippets = pack
      .get("sourceSnippets")
      .and_then(Value::as_array)
      .expect("snippets");

    assert_eq!(request.get("id").and_then(Value::as_str), Some(request_id.as_str()));
    assert_eq!(pack.get("id").and_then(Value::as_str), Some(pack_id.as_str()));
    assert_eq!(
      request.get("status").and_then(Value::as_str),
      Some("pending_user_confirmation")
    );
    assert_eq!(items.len(), 1);
    assert_eq!(
      items[0].get("factId").and_then(Value::as_str),
      Some("fact_insurance")
    );
    assert!(
      items
        .iter()
        .all(|item| item.get("itemText").and_then(Value::as_str) != Some("Unapproved candidate text must not become trusted context."))
    );
    assert_eq!(snippets.len(), 1);
    assert_eq!(
      snippets[0].get("text").and_then(Value::as_str),
      Some("Insurance policy renews on 2026-09-01.")
    );
    assert!(
      !snippets[0]
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .contains("RAW_POLICY_BODY")
    );
  }

  #[test]
  fn native_context_pack_item_visibility_minimizes_ai_bound_pack() {
    use_test_vault_key();
    let path = temp_vault_path("context-pack-minimize");
    let public_source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Library note",
      "Need to renew library card by 2027-01-10.",
    )
    .expect("public source");
    let private_source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Rent contract note",
      "Need to renew apartment rent contract by 2027-01-15.",
    )
    .expect("private source");
    approve_candidate_at_path(
      &path,
      public_source.candidate_ids.first().expect("public candidate"),
      None,
    )
    .expect("approve public candidate");
    let private_approval = approve_candidate_at_path(
      &path,
      private_source.candidate_ids.first().expect("private candidate"),
      None,
    )
    .expect("approve private candidate");
    let private_fact_id = private_approval.fact_id.expect("private fact id");
    let built = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "Help me plan the library card and apartment rent contract renewal",
      Some("普段使うAIへの回答文脈"),
      Some("sensitive"),
      Some("always_review"),
    )
    .expect("context pack");
    let built_vault: Value = serde_json::from_str(&built.payload).expect("built vault");
    let built_pack = find_vault_item_by_id(&built_vault, "contextPacks", &built.pack_id)
      .expect("built pack");
    assert!(built_pack
      .get("items")
      .and_then(Value::as_array)
      .map(|items| {
        items.iter().any(|item| {
          item.get("factId").and_then(Value::as_str) == Some(private_fact_id.as_str())
        })
      })
      .unwrap_or(false));

    let edited = update_context_pack_item_visibility_at_path(
      &path,
      &built.pack_id,
      &private_fact_id,
      false,
    )
    .expect("minimize pack");
    let edited_vault: Value = serde_json::from_str(&edited.payload).expect("edited vault");
    let edited_pack = find_vault_item_by_id(&edited_vault, "contextPacks", &built.pack_id)
      .expect("edited pack");
    assert_eq!(
      edited_pack.get("confirmationStatus").and_then(Value::as_str),
      Some("edited_by_user")
    );
    assert!(edited_pack
      .get("items")
      .and_then(Value::as_array)
      .map(|items| {
        items.iter().all(|item| {
          item.get("factId").and_then(Value::as_str) != Some(private_fact_id.as_str())
        })
      })
      .unwrap_or(false));
    assert!(edited_pack
      .get("excludedItems")
      .and_then(Value::as_array)
      .map(|items| {
        items.iter().any(|item| {
          item.get("referencedId").and_then(Value::as_str) == Some(private_fact_id.as_str())
            && item.get("reason").and_then(Value::as_str) == Some("user_hidden")
        })
      })
      .unwrap_or(false));
    assert_eq!(
      edited_pack
        .get("maxSensitivityIncluded")
        .and_then(Value::as_str),
      Some("public")
    );

    confirm_context_pack_at_path(&path, &built.pack_id).expect("confirm minimized pack");
    let status = get_context_request_status_at_path(&path, &built.request_id).expect("request status");
    let client_pack = status.context_pack.expect("client context pack");
    let client_items = client_pack
      .get("items")
      .and_then(Value::as_array)
      .cloned()
      .unwrap_or_default();
    let client_items_payload = Value::Array(client_items).to_string();

    assert_eq!(status.status, "fulfilled");
    assert!(!client_items_payload.contains("apartment rent contract"));
    assert!(client_pack.to_string().contains("user_hidden"));
    remove_temp_vault(&path);
  }

  #[test]
  fn native_context_pack_excludes_facts_above_policy_ceiling() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_test_vault_connection(&connection);
    let payload = r#"
    {
      "version": 2,
      "sources": [],
      "candidates": [],
      "facts": [
        {
          "id": "fact_health",
          "factText": "Doctor follow-up is scheduled for next month.",
          "domain": "health_and_care",
          "factType": "support_need",
          "sourceIds": [],
          "sensitivity": "sensitive",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:20:00.000Z"
        }
      ],
      "accessPolicies": [
        {
          "id": "policy_copy",
          "clientId": "conn_copy_fallback",
          "scopes": ["context_pack.request"],
          "domainAllowlist": ["health_and_care"],
          "sensitivityCeiling": "personal",
          "requiresApprovalAbove": "public",
          "passiveCaptureAllowed": false,
          "createdAt": "2026-06-12T00:00:00.000Z",
          "updatedAt": "2026-06-12T00:00:00.000Z"
        }
      ],
      "contextPackRequests": [],
      "contextPacks": [],
      "connectorSessions": [],
      "passiveCaptureEvents": [],
      "auditEvents": []
    }
    "#;
    sync_normalized_tables(&mut connection, payload).expect("sync");
    let mut vault: Value = serde_json::from_str(payload).expect("vault json");

    create_native_context_pack_request_in_connection(
      &connection,
      &mut vault,
      "conn_copy_fallback",
      "Copy Context Pack",
      "Help me prepare for the doctor follow-up.",
      None,
      None,
      Some("explicit_sensitive"),
    )
    .expect("native context pack");

    let pack = vault
      .get("contextPacks")
      .and_then(Value::as_array)
      .and_then(|packs| packs.first())
      .expect("pack");
    let items = pack.get("items").and_then(Value::as_array).expect("items");
    let excluded = pack
      .get("excludedItems")
      .and_then(Value::as_array)
      .expect("excluded");
    let warnings = pack.get("warnings").and_then(Value::as_array).expect("warnings");

    assert!(items.is_empty());
    assert!(excluded.iter().any(|item| {
      item.get("referencedId").and_then(Value::as_str) == Some("fact_health")
        && item.get("reason").and_then(Value::as_str) == Some("sensitivity_policy")
    }));
    assert!(warnings.iter().any(|warning| {
      warning.get("kind").and_then(Value::as_str) == Some("policy_limited")
    }));
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("not_required")
    );
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
