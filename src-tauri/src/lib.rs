use base64::{
  engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
  Engine as _,
};
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
  collections::HashSet,
  env,
  ffi::OsString,
  fs,
  io::{Cursor, Read, Write},
  path::{Path, PathBuf},
  process::{Command, Output, Stdio},
  sync::mpsc,
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
  menu::{MenuBuilder, MenuItemBuilder},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  ActivationPolicy, App, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
  WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

mod embeddings;
mod mcp_stdio;
mod vault_backup;
mod vault_crypto;
mod vault_recovery;

const VAULT_STATE_KEY: &str = "vault_state";
const PROJECTION_STATE_KEY: &str = "vault_state_updated_at";
const LOGIN_ITEM_LABEL: &str = "dev.life-context-vault.ai-access";
const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "life-context-vault-tray";
const TRAY_MENU_OPEN_ID: &str = "open-control-center";
const TRAY_MENU_QUIT_ID: &str = "quit-life-context-vault";
const MAX_NATIVE_DOCUMENT_BYTES: usize = 12 * 1024 * 1024;
const MAX_NATIVE_XML_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS: usize = 1_000_000;
const MAX_PROVIDER_STDOUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROVIDER_STDERR_BYTES: usize = 128 * 1024;
// Bound how long we wait for a provider's stdout/stderr reader threads to reach
// EOF. child.kill() does not close a pipe write-end inherited by a lingering
// grandchild, so an unbounded join() could hang forever and defeat the timeout.
const PROVIDER_READER_DRAIN_GRACE: Duration = Duration::from_secs(5);
const SOURCE_CHUNK_TARGET_CHARS: usize = 4_000;
const SOURCE_CHUNK_OVERLAP_CHARS: usize = 300;

#[derive(Debug, PartialEq, Eq)]
enum WindowLifecycleDecision {
  HideToBackground,
  Ignore,
}

#[derive(Debug, PartialEq, Eq)]
enum WindowLifecycleEventKind {
  CloseRequested,
  Destroyed,
  Other,
}

fn window_lifecycle_decision(event_kind: WindowLifecycleEventKind) -> WindowLifecycleDecision {
  match event_kind {
    WindowLifecycleEventKind::CloseRequested => WindowLifecycleDecision::HideToBackground,
    WindowLifecycleEventKind::Destroyed => WindowLifecycleDecision::Ignore,
    WindowLifecycleEventKind::Other => WindowLifecycleDecision::Ignore,
  }
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
  warning: Option<String>,
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
  sensitivity_classified: bool,
  sensitivity_confidence: String,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDocumentExtractionResult {
  text: String,
  detected_kind: String,
  warnings: Vec<String>,
  generated_by: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDocumentExtractionCapabilities {
  native_document_extraction: bool,
  ocr_extraction: bool,
  ocr_provider_label: Option<String>,
  legacy_office_conversion: bool,
  legacy_office_provider_label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrProviderCandidate {
  label: String,
  command: String,
  args: String,
  timeout_seconds: u64,
  source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCandidateReviewResult {
  payload: String,
  updated_at: Option<String>,
  candidate_id: String,
  status: String,
  fact_id: Option<String>,
  superseded_fact_ids: Vec<String>,
  invalidated_pack_count: usize,
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
struct NativeSourceBodyResult {
  payload: String,
  updated_at: Option<String>,
  source_id: String,
  candidate_ids: Vec<String>,
  affected_candidate_count: usize,
  affected_fact_count: usize,
  invalidated_pack_count: usize,
  detected_sensitivity: String,
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
  pub superseded_fact_ids: Vec<String>,
  pub invalidated_pack_count: usize,
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

pub struct VaultCoreSourceBodyResult {
  pub payload: String,
  pub updated_at: Option<String>,
  pub source_id: String,
  pub candidate_ids: Vec<String>,
  pub affected_candidate_count: usize,
  pub affected_fact_count: usize,
  pub invalidated_pack_count: usize,
  pub detected_sensitivity: String,
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
  fs::create_dir_all(&dir).map_err(|error| format!("failed to create app data dir: {error}"))?;
  Ok(dir.join("vault.sqlite3"))
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
  migrate_classification_if_needed(&mut connection)?;
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
        created_at TEXT NOT NULL,
        conflict_with_fact_ids TEXT,
        conflict_reason TEXT
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
        updated_at TEXT NOT NULL,
        supersedes_fact_ids TEXT,
        superseded_by_fact_id TEXT,
        sensitivity_classified INTEGER,
        sensitivity_confidence TEXT
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
  ensure_column(connection, "facts", "supersedes_fact_ids", "TEXT")?;
  ensure_column(connection, "facts", "superseded_by_fact_id", "TEXT")?;
  ensure_column(connection, "facts", "sensitivity_classified", "INTEGER")?;
  ensure_column(connection, "facts", "sensitivity_confidence", "TEXT")?;
  ensure_column(
    connection,
    "memory_candidates",
    "conflict_with_fact_ids",
    "TEXT",
  )?;
  ensure_column(connection, "memory_candidates", "conflict_reason", "TEXT")?;
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
      .execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
      )
      .map_err(|error| format!("failed to add {table}.{column}: {error}"))?;
  }
  Ok(())
}

fn sync_normalized_tables(connection: &mut Connection, payload: &str) -> Result<(), String> {
  let vault: Value = serde_json::from_str(payload)
    .map_err(|error| format!("failed to parse vault payload: {error}"))?;
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

    let source_chunks = source_chunks_for_text(&body);
    for (chunk_index, chunk_text) in source_chunks.iter().enumerate() {
      transaction
        .execute(
          "INSERT INTO source_chunks (
            id, source_id, chunk_index, text, detected_sensitivity, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
          params![
            format!("chunk_{source_id}_{chunk_index}"),
            source_id,
            chunk_index as i64,
            chunk_text,
            str_field(source, "defaultSensitivity"),
            str_field(source, "createdAt")
          ],
        )
        .map_err(|error| {
          format!("failed to sync source chunk {chunk_index} for {source_id}: {error}")
        })?;
    }
  }

  for candidate in value_array(&vault, "candidates") {
    let candidate_id = str_field(candidate, "id");
    transaction
      .execute(
        "INSERT INTO memory_candidates (
          id, source_ids, proposed_fact_text, domain, candidate_type,
          detected_sensitivity, confidence, status, created_at, conflict_with_fact_ids,
          conflict_reason
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
          candidate_id,
          json_field(candidate, "sourceIds"),
          str_field(candidate, "proposedFactText"),
          str_field(candidate, "domain"),
          str_field(candidate, "candidateType"),
          str_field(candidate, "detectedSensitivity"),
          str_field(candidate, "confidence"),
          str_field(candidate, "status"),
          str_field(candidate, "createdAt"),
          json_field(candidate, "conflictWithFactIds"),
          optional_str_field(candidate, "conflictReason")
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
    let fact_sensitivity_classified: i64 = fact
      .get("sensitivityClassified")
      .and_then(|v| v.as_bool())
      .map(|b| if b { 1 } else { 0 })
      .unwrap_or(0);
    let fact_sensitivity_confidence: String = fact
      .get("sensitivityConfidence")
      .and_then(|v| v.as_str())
      .filter(|s| !s.is_empty())
      .unwrap_or("low")
      .to_string();
    transaction
      .execute(
        "INSERT INTO facts (
          id, fact_text, domain, fact_type, source_ids, sensitivity, confidence,
          status, valid_from, valid_until, due_date, created_at, approved_at, updated_at,
          supersedes_fact_ids, superseded_by_fact_id,
          sensitivity_classified, sensitivity_confidence
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
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
          fact_updated_at,
          json_field(fact, "supersedesFactIds"),
          optional_str_field(fact, "supersededByFactId"),
          fact_sensitivity_classified,
          fact_sensitivity_confidence
        ],
      )
      .map_err(|error| format!("failed to sync fact {fact_id}: {error}"))?;
    transaction
      .execute(
        "INSERT INTO facts_fts (fact_id, fact_text, domain) VALUES (?1, ?2, ?3)",
        params![
          fact_id,
          str_field(fact, "factText"),
          str_field(fact, "domain")
        ],
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

fn source_chunks_for_text(text: &str) -> Vec<String> {
  if text.is_empty() {
    return vec![String::new()];
  }

  let chars: Vec<char> = text.chars().collect();
  let mut chunks = Vec::new();
  let mut start = 0;
  while start < chars.len() {
    let hard_end = (start + SOURCE_CHUNK_TARGET_CHARS).min(chars.len());
    let mut end = hard_end;
    if hard_end < chars.len() {
      let search_start =
        start + SOURCE_CHUNK_TARGET_CHARS.saturating_sub(SOURCE_CHUNK_OVERLAP_CHARS);
      if let Some(boundary) = (search_start..hard_end)
        .rev()
        .find(|index| chars[*index].is_whitespace() || matches!(chars[*index], '.' | '。' | '\n'))
      {
        if boundary > start {
          end = boundary + 1;
        }
      }
    }

    chunks.push(
      chars[start..end]
        .iter()
        .collect::<String>()
        .trim()
        .to_string(),
    );
    if end >= chars.len() {
      break;
    }
    start = end
      .saturating_sub(SOURCE_CHUNK_OVERLAP_CHARS)
      .max(start + 1);
  }

  chunks
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
  // NULL ⇒ fail-closed: classified=false, confidence="low"
  let sensitivity_classified: bool = row
    .get::<_, Option<i64>>("sensitivity_classified")?
    .map(|v| v != 0)
    .unwrap_or(false);
  let sensitivity_confidence: String = row
    .get::<_, Option<String>>("sensitivity_confidence")?
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "low".to_string());
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
    sensitivity_classified,
    sensitivity_confidence,
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
           f.sensitivity_classified,
           f.sensitivity_confidence,
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
      .query_map(
        params![fts_query, domain, sensitivity, limit],
        row_to_native_fact_search_result,
      )
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
         sensitivity_classified,
         sensitivity_confidence,
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
    .query_map(
      params![domain, sensitivity, limit],
      row_to_native_fact_search_result,
    )
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
  let request_id = new_id("req");
  let pack_id = new_id("pack");
  let task_domain = classify_domain(task_text);
  let policy_ceiling = policy_ceiling_for_client(vault, client_id);
  let ceiling = sensitivity_ceiling
    .filter(|value| !value.trim().is_empty())
    .map(|value| policy_sensitivity_value(value, "public"))
    .map(|requested_ceiling| lower_sensitivity_tier(&policy_ceiling, &requested_ceiling))
    .unwrap_or(policy_ceiling);
  let requires_approval_above = policy_requires_approval_above_for_client(vault, client_id);
  let domain_allowlist = policy_domain_allowlist_for_client(vault, client_id);
  let resolved_mode = match approval_mode {
    Some(mode) => mode.to_string(),
    // Caller (e.g. lcv-mcp) defers to the connection's standing-delivery opt-in.
    // Single enforcement point: the core decides, not the sidecar.
    None => {
      if connection_standing_delivery_enabled(vault, client_id) {
        "explicit_sensitive".to_string()
      } else {
        "always_review".to_string()
      }
    }
  };
  let approval_mode = resolved_mode.as_str();
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
    if !domain_allowlist.is_empty() && !domain_allowlist.iter().any(|domain| domain == &fact.domain)
    {
      excluded_items.push(json!({
        "referencedId": fact.id,
        "reason": "domain_policy"
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
    if fact.valid_until.as_deref().map(is_expired).unwrap_or(false) {
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
      "reasonIncluded": context_inclusion_reason(&fact, task_domain, task_text),
      "sensitivity": fact.sensitivity.clone(),
      "sourceTitles": source_titles,
      "validFrom": fact.valid_from.clone(),
      "validUntil": fact.valid_until.clone(),
      "confidence": fact.confidence.clone(),
      "sensitivityClassified": fact.sensitivity_classified,
      "sensitivityConfidence": fact.sensitivity_confidence.clone()
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
  let bar = policy_zero_touch_confidence_bar_for_client(vault, client_id);
  let requires_confirmation = approval_mode == "always_review"
    || !items
      .iter()
      .all(|it| zero_touch_eligible(it, &requires_approval_above, &bar));
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
  // Decouple the confirmation window from the delivery TTL. A confirmation-required
  // request stays confirmable for a long window so the user isn't racing a clock;
  // the short 10-minute delivery TTL is (re)stamped at confirmation time
  // (confirm_context_pack_at_path). A zero-touch pack is delivered immediately, so
  // its 10-minute delivery TTL runs from creation as before.
  let expires_at = if requires_confirmation {
    days_from_now(1)
  } else {
    minutes_from_now(10)
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
  if confirmation_status == "not_required" {
    let now = now_iso();
    let client_id_del = str_field(&request, "clientId");
    let client_name_del = str_field(&request, "clientName");
    mutate_vault_item_by_id(&mut vault, "contextPacks", &pack_id, |p| {
      p["deliveredAt"] = Value::String(now.clone());
    })?;
    push_json_array(
      &mut vault,
      "auditEvents",
      audit_event(
        "context_pack_delivered",
        "context_pack",
        &pack_id,
        "public",
        json!({
          "zeroTouch": true,
          "clientName": client_name_del,
          "clientId": client_id_del,
          "packId": pack_id
        }),
      ),
    );
  }
  let pack = find_vault_item_by_id(&vault, "contextPacks", &pack_id)
    .ok_or_else(|| format!("created ContextPack was not found after delivery mark: {pack_id}"))?;
  let context_pack = if confirmation_status == "not_required" || confirmation_status == "confirmed"
  {
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
  let request = request_id
    .as_deref()
    .and_then(|id| find_vault_item_by_id(&vault, "contextPackRequests", id));
  let ceiling = request
    .as_ref()
    .map(|request| str_field(request, "sensitivityCeiling"))
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| str_field(&pack, "maxSensitivityIncluded"));
  let ceiling = sensitivity_tier(&ceiling)?;
  let domain_allowlist = request
    .as_ref()
    .map(|request| policy_domain_allowlist_for_client(&vault, &str_field(request, "clientId")))
    .unwrap_or_default();

  let next_pack = if included {
    restore_fact_to_context_pack(&connection, &pack, fact_id, ceiling, &domain_allowlist)?
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
  ensure_context_pack_allowed_by_current_policy(&vault, &pack)?;
  let request_id = optional_str_field(&pack, "requestId");
  let now = now_iso();
  // Re-stamp the short delivery TTL from the moment of human confirmation, so the
  // 10-minute retrieval window starts now (not at request creation). Pending packs
  // carry a long confirmation window; this narrows it back to the secure delivery
  // window once approved.
  let delivery_expires_at = minutes_from_now(10);
  mutate_vault_item_by_id(&mut vault, "contextPacks", pack_id, |pack| {
    pack["confirmationStatus"] = Value::String("confirmed".to_string());
    pack["confirmedAt"] = Value::String(now.clone());
    pack["expiresAt"] = Value::String(delivery_expires_at.clone());
  })?;
  if let Some(request_id) = request_id.as_deref() {
    set_context_request_status(&mut vault, request_id, "fulfilled");
  }
  let confirmed_pack =
    find_vault_item_by_id(&vault, "contextPacks", pack_id).unwrap_or_else(|| pack.clone());
  let mut metadata = context_pack_receipt_metadata(
    &vault,
    &confirmed_pack,
    None,
    Some("available_for_ai"),
    None,
    None,
    None,
  );
  if let Some(object) = metadata.as_object_mut() {
    object.insert("generatedBy".to_string(), json!("native_vault_core"));
  }
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "context_pack_confirmed",
      "context_pack",
      pack_id,
      &str_field(&confirmed_pack, "maxSensitivityIncluded"),
      metadata,
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
        "requestId": request_id,
        "clientId": str_field(&request, "clientId"),
        "clientName": str_field(&request, "clientName"),
        "deliveryStatus": "denied",
        "trustBoundary": "ContextPack only",
        "bodyStoredInAudit": false,
        "rawSourceIncluded": false,
        "unapprovedCandidateIncluded": false,
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
  Ok(
    snapshot
      .payload
      .as_deref()
      .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
      .unwrap_or_else(empty_vault_json),
  )
}

fn purge_expired_passive_captures_in_vault(vault: &mut Value) -> usize {
  let mut expired_source_ids = Vec::new();
  if let Some(sources) = vault.get_mut("sources").and_then(Value::as_array_mut) {
    for source in sources {
      let is_passive_capture = str_field(source, "kind") == "passive_capture";
      let promoted = source
        .get("promotedToLongTerm")
        .and_then(Value::as_bool)
        .unwrap_or(false);
      let expired = optional_str_field(source, "retentionUntil")
        .as_deref()
        .map(is_expired)
        .unwrap_or(false);
      if is_passive_capture && !promoted && expired {
        let source_id = str_field(source, "id");
        source["body"] = Value::String("[PURGED_PASSIVE_CAPTURE]".to_string());
        source["deletionState"] = Value::String("purged".to_string());
        source["processingStatus"] = Value::String("ready".to_string());
        if !source_id.is_empty() {
          expired_source_ids.push(source_id);
        }
      }
    }
  }
  if expired_source_ids.is_empty() {
    return 0;
  }

  let expired: HashSet<String> = expired_source_ids.iter().cloned().collect();
  if let Some(events) = vault
    .get_mut("passiveCaptureEvents")
    .and_then(Value::as_array_mut)
  {
    for event in events {
      let source_id = optional_str_field(event, "sourceId");
      if source_id
        .as_deref()
        .map(|id| expired.contains(id))
        .unwrap_or(false)
      {
        event["processingStatus"] = Value::String("purged".to_string());
      }
    }
  }

  for source_id in &expired_source_ids {
    push_json_array(
      vault,
      "auditEvents",
      audit_event(
        "passive_capture_purged",
        "source",
        source_id,
        "personal",
        json!({
          "generatedBy": "native_vault_core"
        }),
      ),
    );
  }
  expired_source_ids.len()
}

fn save_vault_json_with_projection(
  connection: &mut Connection,
  vault: &Value,
) -> Result<(String, Option<String>), String> {
  let mut vault_to_save = vault.clone();
  purge_expired_passive_captures_in_vault(&mut vault_to_save);
  let payload = vault_to_save.to_string();
  let save_result = save_vault_state_payload(connection, &payload, None)?;
  let saved_snapshot = load_vault_state_snapshot_from_connection(connection)?;
  Ok((
    saved_snapshot.payload.unwrap_or(payload),
    save_result.updated_at,
  ))
}

pub fn export_encrypted_backup_at_path(path: &Path, passphrase: &str) -> Result<String, String> {
  let connection = open_vault_db_at_path(path)?;
  let vault = load_vault_json_from_connection(&connection)?;
  let payload = vault.to_string();
  vault_backup::export_encrypted_backup(&payload, passphrase)
}

pub fn import_encrypted_backup_at_path(
  path: &Path,
  backup_text: &str,
  passphrase: &str,
) -> Result<String, String> {
  let payload = vault_backup::import_encrypted_backup(backup_text, passphrase)?;
  let vault: Value = serde_json::from_str(&payload)
    .map_err(|error| format!("decrypted backup is not a valid vault payload: {error}"))?;
  let version = vault.get("version").and_then(Value::as_u64);
  if version != Some(2) {
    return Err(format!(
      "decrypted backup is not a supported vault version (got {:?})",
      version
    ));
  }
  let mut connection = open_vault_db_at_path(path)?;
  save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(payload)
}

pub fn get_runtime_preferences_at_path(path: &Path) -> Result<Value, String> {
  let connection = open_vault_db_at_path(path)?;
  let vault = load_vault_json_from_connection(&connection)?;
  Ok(
    vault
      .get("runtimePreferences")
      .cloned()
      .unwrap_or_else(|| json!({})),
  )
}

pub fn save_runtime_preferences_at_path(path: &Path, prefs: &Value) -> Result<(), String> {
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  vault["runtimePreferences"] = prefs.clone();
  save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(())
}

#[tauri::command]
fn get_native_runtime_preferences(app: AppHandle) -> Result<Value, String> {
  let path = vault_db_path(&app)?;
  get_runtime_preferences_at_path(&path)
}

#[tauri::command]
fn save_native_runtime_preferences(app: AppHandle, prefs: Value) -> Result<(), String> {
  let path = vault_db_path(&app)?;
  save_runtime_preferences_at_path(&path, &prefs)
}

pub fn export_local_backup_at_path(path: &Path) -> Result<String, String> {
  let connection = open_vault_db_at_path(path)?;
  let vault = load_vault_json_from_connection(&connection)?;
  let payload = vault.to_string();
  let vault_key = vault_crypto::vault_key()?;
  vault_backup::export_local_backup(&payload, &vault_key)
}

pub fn import_local_backup_at_path(path: &Path, backup_text: &str) -> Result<String, String> {
  let vault_key = vault_crypto::vault_key()?;
  let payload = vault_backup::import_local_backup(backup_text, &vault_key)?;
  let vault: Value = serde_json::from_str(&payload)
    .map_err(|error| format!("decrypted local backup is not a valid vault payload: {error}"))?;
  let mut connection = open_vault_db_at_path(path)?;
  save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(payload)
}

/// Write a vault-key-derived local backup into `dest_dir`, keeping only the
/// `retention` most-recent `vault-<timestamp>.lcvbak` files. Used by the
/// scheduled automatic-backup task.
pub fn write_local_backup_to_dir(
  db_path: &Path,
  dest_dir: &Path,
  retention: usize,
) -> Result<PathBuf, String> {
  fs::create_dir_all(dest_dir)
    .map_err(|error| format!("failed to create backup directory: {error}"))?;
  let envelope = export_local_backup_at_path(db_path)?;
  let stamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs())
    .unwrap_or(0);
  let backup_path = dest_dir.join(format!("vault-{stamp}.lcvbak"));
  fs::write(&backup_path, envelope).map_err(|error| format!("failed to write backup: {error}"))?;
  prune_local_backups(dest_dir, retention)?;
  Ok(backup_path)
}

fn prune_local_backups(dest_dir: &Path, retention: usize) -> Result<(), String> {
  let mut backups: Vec<(PathBuf, u64)> = fs::read_dir(dest_dir)
    .map_err(|error| format!("failed to read backup directory: {error}"))?
    .filter_map(Result::ok)
    .filter_map(|entry| {
      let path = entry.path();
      let name = path.file_name()?.to_str()?;
      let stamp = name
        .strip_prefix("vault-")?
        .strip_suffix(".lcvbak")?
        .parse::<u64>()
        .ok()?;
      Some((path, stamp))
    })
    .collect();
  backups.sort_by_key(|(_, stamp)| *stamp);
  while backups.len() > retention {
    let (path, _) = backups.remove(0);
    let _ = fs::remove_file(path);
  }
  Ok(())
}

fn local_backup_default_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let db_path = vault_db_path(app)?;
  let parent = db_path
    .parent()
    .ok_or_else(|| "vault path has no parent directory".to_string())?;
  Ok(parent.join("Backups"))
}

/// Write a vault-key-derived backup now to the default Backups directory next
/// to the vault, keeping the last LCV_BACKUP_RETENTION (default 10). Usable as
/// a "Back up now" action and as the body of a scheduled task.
/// Recover the SQLCipher key from the sidecar using the recovery key, then
/// re-establish it in the OS credential store so normal opens succeed after a
/// Keychain loss. Completes the recovery-key flow (P0-C).
/// Write the recovery-key sidecar (wrapping the current SQLCipher key) so the
/// user can recover after a Keychain loss. Called during onboarding after the
/// user writes down the displayed recovery key.
#[tauri::command]
fn write_recovery_envelope(app: AppHandle, recovery_key: String) -> Result<(), String> {
  let path = vault_db_path(&app)?;
  write_recovery_envelope_at_path(&path, &recovery_key)
}

#[tauri::command]
fn recover_vault_with_recovery_key(_app: AppHandle, _recovery_key: String) -> Result<(), String> {
  Err(
    "Recovery re-key requires macOS Keychain; restore from an encrypted backup instead."
      .to_string(),
  )
}

#[tauri::command]
fn run_local_backup_now(app: AppHandle) -> Result<String, String> {
  let db_path = vault_db_path(&app)?;
  let dest = local_backup_default_dir(&app)?;
  let retention = env::var("LCV_BACKUP_RETENTION")
    .ok()
    .and_then(|value| value.parse().ok())
    .unwrap_or(10);
  let written = write_local_backup_to_dir(&db_path, &dest, retention)?;
  Ok(written.to_string_lossy().to_string())
}

#[tauri::command]
fn export_native_encrypted_backup(app: AppHandle, passphrase: String) -> Result<String, String> {
  let path = vault_db_path(&app)?;
  export_encrypted_backup_at_path(&path, &passphrase)
}

#[tauri::command]
fn import_native_encrypted_backup(
  app: AppHandle,
  backup_text: String,
  passphrase: String,
) -> Result<String, String> {
  let path = vault_db_path(&app)?;
  import_encrypted_backup_at_path(&path, &backup_text, &passphrase)
}

pub fn write_recovery_envelope_at_path(db_path: &Path, recovery_key: &str) -> Result<(), String> {
  let vault_key = vault_crypto::vault_key()?;
  let envelope = vault_recovery::wrap_vault_key(&vault_key, recovery_key)?;
  let sidecar = recovery_sidecar_path(db_path);
  fs::write(&sidecar, envelope).map_err(|error| {
    format!(
      "failed to write recovery envelope to {}: {error}",
      sidecar.display()
    )
  })
}

pub fn recover_vault_key_at_path(db_path: &Path, recovery_key: &str) -> Result<String, String> {
  let sidecar = recovery_sidecar_path(db_path);
  let envelope = fs::read_to_string(&sidecar).map_err(|error| {
    format!(
      "failed to read recovery envelope at {}: {error}",
      sidecar.display()
    )
  })?;
  vault_recovery::unwrap_vault_key(&envelope, recovery_key)
}

/// Path of the recovery-key sidecar file stored next to (not inside) the
/// encrypted vault DB. `vault.sqlite3` -> `vault.recovery.json`.
fn recovery_sidecar_path(db_path: &Path) -> PathBuf {
  db_path.with_extension("recovery.json")
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
  // Use the line-aware sanitizer (same path as add_source / passive capture) so
  // secret redaction stays per-line and consistent across every ingest path.
  let sanitized = sanitize_source_body(text);
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
  let mut candidate = json!({
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
  annotate_candidate_conflicts(&vault, &mut candidate);

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
  let mut candidates = extract_memory_candidates_for_source(&source_id, &sanitized, &now);
  annotate_candidates_conflicts(&vault, &mut candidates);
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

pub fn add_source_pending_runtime_at_path(
  path: &Path,
  kind: &str,
  origin: &str,
  title: &str,
) -> Result<VaultCoreSourceIngestResult, String> {
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let now = now_iso();
  let source_id = new_id("src");
  let normalized_title = normalized_text(title);
  let source_title = if normalized_title.trim().is_empty() {
    "Untitled source".to_string()
  } else {
    normalized_title
  };
  let kind = source_kind(kind);
  let origin = source_origin(origin);
  let body = "[needs_runtime] このSourceは抽出ランタイム(OCRまたはOffice変換)が未設定のため本文を抽出していません。SettingsでProviderを設定後に再処理できます。";
  let source = json!({
    "id": source_id,
    "kind": kind,
    "title": source_title,
    "origin": origin,
    "body": body,
    "createdAt": now,
    "capturedAt": now,
    "defaultSensitivity": "personal",
    "processingStatus": "needs_runtime",
    "deletionState": "active"
  });
  push_json_array(&mut vault, "sources", source);
  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "source_added",
      "source",
      &source_id,
      "personal",
      json!({
        "title": source_title,
        "kind": kind,
        "origin": origin,
        "pendingRuntime": true,
        "generatedBy": "native_vault_core"
      }),
    ),
  );
  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreSourceIngestResult {
    payload,
    updated_at,
    source_id,
    candidate_ids: vec![],
    detected_sensitivity: "personal".to_string(),
  })
}

#[tauri::command]
fn add_native_source_pending_runtime(
  app: AppHandle,
  kind: String,
  origin: String,
  title: String,
) -> Result<NativeSourceIngestResult, String> {
  let path = vault_db_path(&app)?;
  let result = add_source_pending_runtime_at_path(&path, &kind, &origin, &title)?;
  Ok(NativeSourceIngestResult {
    payload: result.payload,
    updated_at: result.updated_at,
    source_id: result.source_id,
    candidate_ids: result.candidate_ids,
    detected_sensitivity: result.detected_sensitivity,
    generated_by: "native_vault_core".to_string(),
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
  let mut candidates = extract_memory_candidates_for_source(&source_id, &sanitized, &now);
  annotate_candidates_conflicts(&vault, &mut candidates);
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
  Ok(VaultCoreSettingsUpdateResult {
    payload,
    updated_at,
  })
}

pub fn update_access_policy_at_path(
  path: &Path,
  client_id: &str,
  sensitivity_ceiling: Option<&str>,
  requires_approval_above: Option<&str>,
  domain_allowlist: Option<Vec<String>>,
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
  let ceiling = sensitivity_ceiling.map(sensitivity_tier).transpose()?;
  let approval = requires_approval_above.map(sensitivity_tier).transpose()?;
  let domains = domain_allowlist
    .map(normalize_policy_domain_allowlist)
    .transpose()?;

  let (policy_id, sensitivity, mut metadata) = {
    let Some(policies) = vault
      .get_mut("accessPolicies")
      .and_then(Value::as_array_mut)
    else {
      return Err("Vault has no accessPolicies array.".to_string());
    };
    let Some(policy) = policies
      .iter_mut()
      .find(|policy| str_field(policy, "clientId") == client_id)
    else {
      return Err(format!(
        "AccessPolicy was not found for client: {client_id}"
      ));
    };

    if let Some(ceiling) = ceiling {
      policy["sensitivityCeiling"] = Value::String(ceiling.to_string());
    }
    if let Some(approval) = approval {
      policy["requiresApprovalAbove"] = Value::String(approval.to_string());
    }
    if let Some(domains) = domains {
      policy["domainAllowlist"] = json!(domains);
    }
    if let Some(passive_capture_allowed) = passive_capture_allowed {
      policy["passiveCaptureAllowed"] = Value::Bool(passive_capture_allowed);
    }
    policy["updatedAt"] = Value::String(now.clone());
    let policy_id = str_field(policy, "id");
    let sensitivity = str_field(policy, "sensitivityCeiling");
    let normalized_domains =
      normalize_existing_policy_domain_allowlist(policy.get("domainAllowlist"));
    let normalized_domain_count = normalized_domains.len();
    let metadata = json!({
      "clientId": client_id,
      "sensitivityCeiling": sensitivity,
      "requiresApprovalAbove": str_field(policy, "requiresApprovalAbove"),
      "domainAllowlist": normalized_domains,
      "domainAllowlistCount": normalized_domain_count,
      "passiveCaptureAllowed": policy.get("passiveCaptureAllowed").and_then(Value::as_bool).unwrap_or(false),
      "generatedBy": "native_vault_core"
    });
    (policy_id, sensitivity, metadata)
  };
  let invalidated_pack_count = invalidate_context_packs_for_client_policy(&mut vault, client_id);
  if let Some(object) = metadata.as_object_mut() {
    object.insert(
      "invalidatedPackCount".to_string(),
      json!(invalidated_pack_count),
    );
  }

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
  Ok(VaultCoreSettingsUpdateResult {
    payload,
    updated_at,
  })
}

pub fn set_connection_standing_delivery_at_path(
  path: &Path,
  client_id: &str,
  enabled: bool,
) -> Result<(), String> {
  let client_id = client_id.trim();
  if client_id.is_empty() {
    return Err("clientId is required.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  ensure_access_policy_for_client(&mut vault, client_id);
  let now = now_iso();
  {
    let Some(policies) = vault
      .get_mut("accessPolicies")
      .and_then(Value::as_array_mut)
    else {
      return Err("Vault has no accessPolicies array.".to_string());
    };
    let Some(policy) = policies
      .iter_mut()
      .find(|policy| str_field(policy, "clientId") == client_id)
    else {
      return Err(format!(
        "AccessPolicy was not found for client: {client_id}"
      ));
    };
    policy["standingDeliveryEnabled"] = Value::Bool(enabled);
    policy["updatedAt"] = Value::String(now);
  }
  save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(())
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
          return Err(
            "purged Sources cannot be restored because the Raw body was removed.".to_string(),
          );
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

pub fn purge_browser_passive_capture_source_at_path(
  path: &Path,
  source_id: &str,
) -> Result<VaultCoreSourceLifecycleResult, String> {
  let source_id = source_id.trim();
  if source_id.is_empty() {
    return Err("sourceId is required.".to_string());
  }
  let connection = open_vault_db_at_path(path)?;
  let vault = load_vault_json_from_connection(&connection)?;
  let Some(source) = vault
    .get("sources")
    .and_then(Value::as_array)
    .and_then(|sources| {
      sources
        .iter()
        .find(|source| str_field(source, "id") == source_id)
    })
  else {
    return Err(format!("Source was not found: {source_id}"));
  };
  if str_field(source, "kind") != "passive_capture"
    || str_field(source, "origin") != "passive_browser"
  {
    return Err("Capture host can only delete browser passive-capture Sources.".to_string());
  }
  drop(connection);
  update_source_lifecycle_at_path(path, source_id, "purge_body")
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

pub fn update_source_body_at_path(
  path: &Path,
  source_id: &str,
  body: &str,
) -> Result<VaultCoreSourceBodyResult, String> {
  let source_id = source_id.trim();
  if source_id.is_empty() {
    return Err("sourceId is required.".to_string());
  }
  let body = body.trim();
  if body.is_empty() {
    return Err("body is required.".to_string());
  }
  let mut connection = open_vault_db_at_path(path)?;
  let mut vault = load_vault_json_from_connection(&connection)?;
  let now = now_iso();
  let detected_sensitivity = detect_sensitivity(body).to_string();
  let sanitized = sanitize_source_body(body);
  let source_title = {
    let Some(sources) = vault.get_mut("sources").and_then(Value::as_array_mut) else {
      return Err("Vault has no sources array.".to_string());
    };
    let Some(source) = sources
      .iter_mut()
      .find(|source| str_field(source, "id") == source_id)
    else {
      return Err(format!("Source was not found: {source_id}"));
    };
    if str_field(source, "deletionState") != "active" {
      return Err(
        "only active Sources can be edited. Restore the Source before editing its body."
          .to_string(),
      );
    }
    source["body"] = Value::String(sanitized.clone());
    source["defaultSensitivity"] = Value::String(detected_sensitivity.clone());
    source["processingStatus"] = Value::String("ready".to_string());
    str_field(source, "title")
  };

  let affected_candidate_count = archive_pending_candidates_for_source(&mut vault, source_id, &now);
  let affected_fact_ids =
    mark_source_facts_needing_review_with_reason(&mut vault, source_id, &now, "source_updated");
  let invalidated_pack_count = invalidate_context_packs_for_facts_with_warning(
    &mut vault,
    &affected_fact_ids,
    "stale_fact",
    "根拠Source本文が更新されたため、このContext Packは無効化されました。",
  );
  let mut candidates = extract_memory_candidates_for_source(source_id, &sanitized, &now);
  annotate_candidates_conflicts(&vault, &mut candidates);
  let candidate_ids = candidates
    .iter()
    .map(|candidate| str_field(candidate, "id"))
    .collect::<Vec<_>>();
  for candidate in candidates {
    push_json_array(&mut vault, "candidates", candidate);
  }

  push_json_array(
    &mut vault,
    "auditEvents",
    audit_event(
      "source_updated",
      "source",
      source_id,
      &detected_sensitivity,
      json!({
        "title": source_title,
        "action": "body_reextracted",
        "candidateCount": candidate_ids.len(),
        "affectedCandidateCount": affected_candidate_count,
        "affectedFactCount": affected_fact_ids.len(),
        "invalidatedPackCount": invalidated_pack_count,
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
          "regenerated": true,
          "generatedBy": "native_vault_core"
        }),
      ),
    );
  }

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreSourceBodyResult {
    payload,
    updated_at,
    source_id: source_id.to_string(),
    candidate_ids,
    affected_candidate_count,
    affected_fact_count: affected_fact_ids.len(),
    invalidated_pack_count,
    detected_sensitivity,
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
    let old_fact_text = str_field(fact, "factText");
    let old_sensitivity = str_field(fact, "sensitivity");
    fact["factText"] = Value::String(fact_text.clone());
    fact["domain"] = Value::String(domain.to_string());
    fact["sensitivity"] = Value::String(sensitivity.to_string());
    fact["updatedAt"] = Value::String(now);
    set_optional_fact_string(fact, "validFrom", valid_from);
    set_optional_fact_string(fact, "validUntil", valid_until);
    set_optional_fact_string(fact, "dueDate", due_date);
    // Task 7: re-run classifier when factText changes; clear classification on manual
    // sensitivity override so the gate knows the item has not been auto-classified.
    // Branch order (mirrors TS updateFactMetadata):
    //   1. Manual sensitivity override wins — even when text also changed.
    //   2. Text-only change — re-classify with the new text.
    //   3. Domain-only / no-change edit — leave classification fields untouched.
    if sensitivity != old_sensitivity {
      fact["sensitivityClassified"] = Value::Bool(false);
      fact["sensitivityConfidence"] = Value::String("low".to_string());
    } else if fact_text != old_fact_text {
      let classification = classify_sensitivity(&fact_text);
      fact["sensitivityClassified"] = Value::Bool(classification.classified);
      fact["sensitivityConfidence"] = Value::String(classification.confidence.to_string());
    }
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
  approve_candidate_with_options_at_path(path, candidate_id, edited_text, &[])
}

pub fn approve_candidate_with_options_at_path(
  path: &Path,
  candidate_id: &str,
  edited_text: Option<&str>,
  supersede_fact_ids: &[String],
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
  let fact_text = edited_text.unwrap_or(&proposed_text).trim().to_string();
  if fact_text.is_empty() {
    return Err("approved fact text is required.".to_string());
  }

  let now = now_iso();
  let fact_id = new_id("fact");
  let mut superseded_fact_ids = Vec::new();
  for requested_id in supersede_fact_ids {
    let requested_id = requested_id.trim();
    if requested_id.is_empty() || superseded_fact_ids.iter().any(|id| id == requested_id) {
      continue;
    }
    let Some(existing_fact) = find_vault_item_by_id(&vault, "facts", requested_id) else {
      return Err(format!("Superseded Fact was not found: {requested_id}"));
    };
    if str_field(&existing_fact, "status") != "active" {
      return Err(format!(
        "Only active Facts can be superseded: {requested_id}"
      ));
    }
    superseded_fact_ids.push(requested_id.to_string());
  }
  let source_ids = candidate
    .get("sourceIds")
    .cloned()
    .unwrap_or_else(|| json!([]));
  if source_ids_have_deleted_source_in_vault(&vault, &source_ids) {
    return Err(
      "candidates from deleted or purged Sources cannot be approved as Facts.".to_string(),
    );
  }
  let source_backed = source_ids
    .as_array()
    .map(|ids| !ids.is_empty())
    .unwrap_or(false);
  // Determine whether the user actually changed the text.
  let text_was_edited = edited_text
    .map(str::trim)
    .filter(|t| *t != proposed_text.trim())
    .is_some();
  // Always classify the fact text so sensitivityClassified / sensitivityConfidence
  // are fresh on the new fact (Task 7: zero-touch gate evaluates these fields).
  let classification = classify_sensitivity(&fact_text);
  // When edited text was provided, derive sensitivity TIER from the NEW text so
  // that injecting a credential into an otherwise-benign candidate cannot
  // produce a low-sensitivity fact that auto-delivers (trust-boundary leak).
  // Mirrors TS vault.ts approveCandidate (line ~607: sensitivity: classifiedForFact.tier).
  let fact_sensitivity = if text_was_edited {
    // Mirror the TS/extract path: secret_never_send must never become a fact.
    if classification.tier == "secret_never_send" {
      return Err(
        "The edited text contains secret material and cannot be approved as a Fact.".to_string(),
      );
    }
    classification.tier.clone()
  } else {
    // Non-edited path: use the candidate's original detected sensitivity tier.
    detected_sensitivity.clone()
  };
  let mut fact = json!({
    "id": fact_id.clone(),
    "factText": fact_text,
    "domain": str_field(&candidate, "domain"),
    "factType": candidate_type_to_fact_type(&str_field(&candidate, "candidateType")),
    "sourceIds": source_ids,
    "sensitivity": fact_sensitivity,
    "confidence": if source_backed { "source_backed" } else { "inferred_and_confirmed" },
    "status": "active",
    "createdAt": now.clone(),
    "approvedAt": now.clone(),
    "updatedAt": now.clone(),
    "supersedesFactIds": superseded_fact_ids.clone(),
    "sensitivityClassified": classification.classified,
    "sensitivityConfidence": classification.confidence.to_string()
  });
  copy_optional_candidate_field(&candidate, &mut fact, "validFrom");
  copy_optional_candidate_field(&candidate, &mut fact, "validUntil");
  copy_optional_candidate_field(&candidate, &mut fact, "dueDate");
  let invalidated_pack_count = invalidate_context_packs_for_facts_with_warning(
    &mut vault,
    &superseded_fact_ids,
    "stale_fact",
    "Factが新しいFactに置き換えられたため、このContext Packは無効化されました。",
  );
  if !superseded_fact_ids.is_empty() {
    let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) else {
      return Err("Vault has no facts array.".to_string());
    };
    for fact in facts {
      if superseded_fact_ids
        .iter()
        .any(|fact_id| fact_id == &str_field(fact, "id"))
      {
        fact["status"] = Value::String("superseded".to_string());
        fact["updatedAt"] = Value::String(now.clone());
        fact["supersededByFactId"] = Value::String(fact_id.clone());
      }
    }
  }

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
        "supersededFactIds": superseded_fact_ids,
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
        "supersedesFactIds": superseded_fact_ids,
        "invalidatedPackCount": invalidated_pack_count,
        "generatedBy": "native_vault_core"
      }),
    ),
  );
  for superseded_fact_id in &superseded_fact_ids {
    push_json_array(
      &mut vault,
      "auditEvents",
      audit_event(
        "fact_updated",
        "fact",
        superseded_fact_id,
        &detected_sensitivity,
        json!({
          "action": "superseded",
          "supersededByFactId": fact_id,
          "generatedBy": "native_vault_core"
        }),
      ),
    );
  }

  let (payload, updated_at) = save_vault_json_with_projection(&mut connection, &vault)?;
  Ok(VaultCoreCandidateReviewResult {
    payload,
    updated_at,
    candidate_id: candidate_id.to_string(),
    status: approved_status.to_string(),
    fact_id: Some(fact_id),
    superseded_fact_ids,
    invalidated_pack_count,
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
    superseded_fact_ids: Vec::new(),
    invalidated_pack_count: 0,
  })
}

pub fn get_context_request_status_at_path(
  path: &Path,
  request_id: &str,
) -> Result<VaultCoreRequestStatusResult, String> {
  get_context_request_status_at_path_with_client(path, request_id, None)
}

pub fn get_context_request_status_for_client_at_path(
  path: &Path,
  request_id: &str,
  client_id: &str,
) -> Result<VaultCoreRequestStatusResult, String> {
  let client_id = client_id.trim();
  if client_id.is_empty() {
    return Err("clientId is required.".to_string());
  }
  get_context_request_status_at_path_with_client(path, request_id, Some(client_id))
}

fn get_context_request_status_at_path_with_client(
  path: &Path,
  request_id: &str,
  expected_client_id: Option<&str>,
) -> Result<VaultCoreRequestStatusResult, String> {
  let mut connection = open_vault_db_at_path(path)?;
  let vault = load_vault_json_from_connection(&connection)?;
  let Some(request) = find_vault_item_by_id(&vault, "contextPackRequests", request_id) else {
    return Ok(VaultCoreRequestStatusResult {
      status: "not_found".to_string(),
      request_id: request_id.to_string(),
      expires_at: None,
      context_pack: None,
    });
  };
  if let Some(expected_client_id) = expected_client_id {
    if str_field(&request, "clientId") != expected_client_id {
      return Ok(VaultCoreRequestStatusResult {
        status: "not_found".to_string(),
        request_id: request_id.to_string(),
        expires_at: None,
        context_pack: None,
      });
    }
  }
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
  if !expires_at.is_empty() && is_expired(&expires_at) {
    return Ok(VaultCoreRequestStatusResult {
      status: "expired".to_string(),
      request_id: request_id.to_string(),
      expires_at: Some(expires_at),
      context_pack: None,
    });
  }
  let pack_confirmed = pack
    .as_ref()
    .map(|pack| str_field(pack, "confirmationStatus") == "confirmed")
    .unwrap_or(false);
  let confirmed = pack_confirmed && str_field(&request, "status") == "fulfilled";

  if confirmed {
    let Some(pack) = pack.as_ref() else {
      return Ok(VaultCoreRequestStatusResult {
        status: "expired".to_string(),
        request_id: request_id.to_string(),
        expires_at: if expires_at.is_empty() {
          None
        } else {
          Some(expires_at)
        },
        context_pack: None,
      });
    };
    if ensure_context_pack_allowed_by_current_policy(&vault, pack).is_err() {
      return Ok(VaultCoreRequestStatusResult {
        status: "expired".to_string(),
        request_id: request_id.to_string(),
        expires_at: if expires_at.is_empty() {
          None
        } else {
          Some(expires_at)
        },
        context_pack: None,
      });
    }
    // Fire-once delivery audit event for confirmed packs
    let delivered_at = pack
      .get("deliveredAt")
      .and_then(Value::as_str)
      .unwrap_or("")
      .to_string();
    if delivered_at.is_empty() {
      let now = now_iso();
      let client_id_del = str_field(&request, "clientId");
      let client_name_del = str_field(&request, "clientName");
      let pack_id_del = str_field(pack, "id");
      let mut vault_mut = load_vault_json_from_connection(&connection)?;
      if mutate_vault_item_by_id(&mut vault_mut, "contextPacks", &pack_id_del, |p| {
        p["deliveredAt"] = Value::String(now.clone());
      })
      .is_ok()
      {
        push_json_array(
          &mut vault_mut,
          "auditEvents",
          audit_event(
            "context_pack_delivered",
            "context_pack",
            &pack_id_del,
            "public",
            json!({
              "zeroTouch": false,
              "clientName": client_name_del,
              "clientId": client_id_del,
              "packId": pack_id_del
            }),
          ),
        );
        save_vault_json_with_projection(&mut connection, &vault_mut)?;
      }
    }
    return Ok(VaultCoreRequestStatusResult {
      status: "fulfilled".to_string(),
      request_id: request_id.to_string(),
      expires_at: if expires_at.is_empty() {
        None
      } else {
        Some(expires_at)
      },
      context_pack: Some(safe_context_pack_for_client(pack)),
    });
  }

  Ok(VaultCoreRequestStatusResult {
    status: str_field(&request, "status"),
    request_id: request_id.to_string(),
    expires_at: if expires_at.is_empty() {
      None
    } else {
      Some(expires_at)
    },
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
    "excludedItems": sanitize_context_exclusions_for_ai(pack),
    "confirmationStatus": str_field(pack, "confirmationStatus")
  })
}

fn sanitize_context_exclusions_for_ai(pack: &Value) -> Value {
  let exclusions = pack
    .get("excludedItems")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
    .into_iter()
    .filter_map(|item| {
      let reason = str_field(&item, "reason");
      if reason.is_empty() {
        None
      } else {
        Some(json!({ "reason": reason }))
      }
    })
    .collect::<Vec<_>>();
  Value::Array(exclusions)
}

fn ensure_pack_can_be_edited(vault: &mut Value, pack: &Value) -> Result<(), String> {
  let status = str_field(pack, "confirmationStatus");
  if status == "cancelled" {
    return Err("cancelled ContextPacks cannot be edited.".to_string());
  }
  if status == "confirmed" {
    return Err(
      "confirmed ContextPacks cannot be edited. Create a new request instead.".to_string(),
    );
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

fn ensure_context_pack_allowed_by_current_policy(
  vault: &Value,
  pack: &Value,
) -> Result<(), String> {
  let request_id = optional_str_field(pack, "requestId")
    .ok_or_else(|| "ContextPack has no client request boundary.".to_string())?;
  let request = find_vault_item_by_id(vault, "contextPackRequests", &request_id)
    .ok_or_else(|| format!("ContextPackRequest was not found: {request_id}"))?;
  let client_id = str_field(&request, "clientId");
  if client_id.is_empty() {
    return Err("ContextPackRequest has no clientId.".to_string());
  }
  let request_status = str_field(&request, "status");
  if matches!(request_status.as_str(), "denied" | "expired") {
    return Err(format!("ContextPackRequest is already {request_status}."));
  }
  let policy_ceiling = policy_ceiling_for_client(vault, &client_id);
  let request_ceiling =
    policy_sensitivity_value(&str_field(&request, "sensitivityCeiling"), "public");
  let ceiling = lower_sensitivity_tier(&policy_ceiling, &request_ceiling);
  let domain_allowlist = policy_domain_allowlist_for_client(vault, &client_id);
  let items = pack
    .get("items")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
  for item in items {
    let item_sensitivity = item
      .get("sensitivity")
      .and_then(Value::as_str)
      .and_then(|value| sensitivity_tier(value).ok().map(str::to_string))
      .ok_or_else(|| "ContextPack item has an invalid sensitivity.".to_string())?;
    if sensitivity_rank(&item_sensitivity) > sensitivity_rank(&ceiling) {
      return Err("ContextPack exceeds the current AI client sensitivity policy.".to_string());
    }
    let fact_id = str_field(&item, "factId");
    let fact = find_vault_item_by_id(vault, "facts", &fact_id)
      .ok_or_else(|| format!("ContextPack references a missing Fact: {fact_id}"))?;
    if str_field(&fact, "status") != "active" {
      return Err("ContextPack references a Fact that is no longer active.".to_string());
    }
    if str_field(&item, "itemText") != str_field(&fact, "factText") {
      return Err("ContextPack item text no longer matches the current Fact.".to_string());
    }
    if str_field(&item, "validFrom") != str_field(&fact, "validFrom") {
      return Err("ContextPack item validity no longer matches the current Fact.".to_string());
    }
    let fact_valid_until = str_field(&fact, "validUntil");
    if !fact_valid_until.is_empty() && is_expired(&fact_valid_until) {
      return Err("ContextPack references an expired Fact.".to_string());
    }
    if str_field(&item, "validUntil") != fact_valid_until {
      return Err("ContextPack item validity no longer matches the current Fact.".to_string());
    }
    let fact_sensitivity = str_field(&fact, "sensitivity");
    let fact_sensitivity = sensitivity_tier(&fact_sensitivity).unwrap_or("secret_never_send");
    if fact_sensitivity == "secret_never_send" {
      return Err("ContextPack references a secret Fact.".to_string());
    }
    if sensitivity_rank(fact_sensitivity) > sensitivity_rank(&ceiling) {
      return Err("ContextPack Fact exceeds the current AI client sensitivity policy.".to_string());
    }
    let fact_domain = life_domain(&str_field(&fact, "domain"))?;
    if !domain_allowlist.iter().any(|domain| domain == fact_domain) {
      return Err("ContextPack Fact is outside the current AI client domain policy.".to_string());
    }
    let source_ids = fact
      .get("sourceIds")
      .and_then(Value::as_array)
      .cloned()
      .unwrap_or_default();
    if !source_ids.is_empty() {
      let has_ai_eligible_source = source_ids.iter().any(|source_id| {
        let Some(source_id) = source_id.as_str() else {
          return false;
        };
        let Some(source) = find_vault_item_by_id(vault, "sources", source_id) else {
          return false;
        };
        if str_field(&source, "deletionState") != "active" {
          return false;
        }
        let source_sensitivity = str_field(&source, "defaultSensitivity");
        let Ok(source_sensitivity) = sensitivity_tier(&source_sensitivity) else {
          return false;
        };
        // The fact's own sensitivity is already gated against the ceiling above; the
        // source's cautious default sensitivity is only a pre-approval heuristic and
        // must not override the user's explicit fact-level approval here — otherwise a
        // pack containing any fact from a cautiously-classified source could never be
        // approved for AI.
        source_sensitivity != "secret_never_send"
      });
      if !has_ai_eligible_source {
        return Err("ContextPack Fact no longer has an AI-eligible active Source.".to_string());
      }
    }
    // Task 7: re-validate classification/zero-touch eligibility at retrieval time
    // against the CURRENT Fact (not the frozen pack item). Mirrors the TS analogue
    // in vault.ts so the production (Rust) path is not strictly weaker than the
    // fallback (TS) path:
    //  (a) An item that was classified at build time but whose current Fact is now
    //      unclassified is a fail-closed signal — a silently-unverified fact must
    //      not ride along, regardless of how the pack was delivered.
    //  (b) Packs delivered without user confirmation (zero-touch) must additionally
    //      still satisfy the current per-client confidence bar / approval threshold,
    //      evaluated against the current Fact. User-confirmed packs are exempt — a
    //      human reviewed them.
    let item_was_classified = item
      .get("sensitivityClassified")
      .and_then(Value::as_bool)
      .unwrap_or(false);
    let fact_is_now_classified = fact
      .get("sensitivityClassified")
      .and_then(Value::as_bool)
      .unwrap_or(false);
    if item_was_classified && !fact_is_now_classified {
      return Err("ContextPack item is no longer eligible for zero-touch delivery.".to_string());
    }
    let pack_confirmation_status = str_field(pack, "confirmationStatus");
    if pack_confirmation_status == "not_required" {
      let bar = policy_zero_touch_confidence_bar_for_client(vault, &client_id);
      let requires_approval_above = policy_requires_approval_above_for_client(vault, &client_id);
      if !zero_touch_eligible(&fact, &requires_approval_above, &bar) {
        return Err("ContextPack item is no longer eligible for zero-touch delivery.".to_string());
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
    excluded_items.insert(
      0,
      json!({ "referencedId": fact_id, "reason": "user_hidden" }),
    );
  }
  refresh_user_edited_context_pack(connection, pack, next_items, excluded_items, ceiling)
}

fn restore_fact_to_context_pack(
  connection: &Connection,
  pack: &Value,
  fact_id: &str,
  ceiling: &str,
  domain_allowlist: &[String],
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
  if !domain_allowlist.is_empty() && !domain_allowlist.iter().any(|domain| domain == &fact.domain) {
    return Err("Fact is outside this AI client's allowed life domains.".to_string());
  }
  let task_domain = str_field(pack, "taskDomain");
  let task_text = str_field(pack, "taskText");
  items.push(context_pack_item_from_fact(
    connection,
    &fact,
    &task_domain,
    &task_text,
    ceiling,
  )?);
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
  next_pack["maxSensitivityIncluded"] =
    Value::String(max_sensitivity_for_items(&items).to_string());
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
  task_text: &str,
  ceiling: &str,
) -> Result<Value, String> {
  Ok(json!({
    "id": new_id("ctxitem"),
    "factId": fact.id,
    "itemText": fact.fact_text,
    "reasonIncluded": context_inclusion_reason(fact, task_domain, task_text),
    "sensitivity": fact.sensitivity,
    "sourceTitles": source_titles_in_connection(connection, &fact.source_ids, ceiling)?,
    "validFrom": fact.valid_from,
    "validUntil": fact.valid_until,
    "confidence": fact.confidence,
    "sensitivityClassified": fact.sensitivity_classified,
    "sensitivityConfidence": fact.sensitivity_confidence
  }))
}

fn fact_eligible_for_context_pack(fact: &NativeFactSearchResult, ceiling: &str) -> bool {
  fact.status == "active"
    && fact.sensitivity != "secret_never_send"
    && sensitivity_rank(&fact.sensitivity) <= sensitivity_rank(ceiling)
    && fact.valid_until.as_deref().map(is_expired).unwrap_or(false) == false
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
         sensitivity_classified,
         sensitivity_confidence,
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

fn mutate_vault_item_by_id<F>(
  vault: &mut Value,
  key: &str,
  id: &str,
  mut mutate: F,
) -> Result<(), String>
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
  let task_vec = embeddings::embed(task_text);
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
      let haystack = format!(
        "{} {}",
        fact.fact_text.to_lowercase(),
        fact.domain.to_lowercase()
      );
      let fact_vec = embeddings::embed(&format!("{} {}", fact.fact_text, fact.domain));
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
      let sensitivity_penalty =
        if sensitivity_rank(&fact.sensitivity) >= sensitivity_rank("sensitive") {
          -1
        } else {
          0
        };
      let policy_bonus = if sensitivity_rank(&fact.sensitivity) <= sensitivity_rank(ceiling) {
        1
      } else {
        0
      };
      let semantic_score = (embeddings::cosine(&task_vec, &fact_vec) * 6.0).round() as i64;
      (
        token_score
          + domain_score
          + bridge_score
          + sensitivity_penalty
          + policy_bonus
          + semantic_score,
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
  Ok(
    scored
      .into_iter()
      .take(limit)
      .map(|(_, fact)| fact)
      .collect(),
  )
}

/// A short, human-readable reason a fact was included in a context pack, chosen
/// by the dominant QUALITATIVE signal in priority order (direct token match >
/// same domain > cross-domain bridge > stable background). Using priority order
/// rather than the raw additive score avoids mislabeling from signals living on
/// different numeric scales. Centralizes the wording shared by every build path.
fn context_inclusion_reason(
  fact: &NativeFactSearchResult,
  task_domain: &str,
  task_text: &str,
) -> &'static str {
  let haystack = format!(
    "{} {}",
    fact.fact_text.to_lowercase(),
    fact.domain.to_lowercase()
  );
  let tokens = search_tokens(task_text);
  if !tokens.is_empty() && tokens.iter().any(|token| haystack.contains(token.as_str())) {
    "質問の語に直接一致する記憶です。"
  } else if fact.domain == task_domain {
    "質問の領域と一致しています。"
  } else if cross_domain_bridge_score(&task_text.to_lowercase(), &fact.domain) > 0 {
    "関連する領域からの橋渡しとして含めています。"
  } else if is_stable_background_fact(fact) {
    "安定した背景情報として回答を調整できます。"
  } else {
    "本人の背景情報として回答を調整できます。"
  }
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
       sensitivity_classified,
       sensitivity_confidence,
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
        .map(|sensitivity| {
          sensitivity_rank(sensitivity) >= sensitivity_rank("private_consequential")
        })
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
    .filter(|item| {
      matches!(
        item.get("reason").and_then(Value::as_str),
        Some("sensitivity_policy" | "domain_policy")
      )
    })
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
    .map(|token| {
      token
        .trim_matches(|character: char| !character.is_alphanumeric())
        .to_string()
    })
    .filter(|token| !token.is_empty())
    .collect()
}

fn context_candidate_domains(task_text: &str) -> Vec<&'static str> {
  let task_domain = classify_domain(task_text);
  let lower = task_text.to_lowercase();
  let mut domains = vec![task_domain];
  if contains_any(
    &lower,
    &["job", "work", "employer", "転職", "勤務先", "仕事"],
  ) {
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
  if contains_any(
    &lower,
    &[
      "health",
      "medical",
      "doctor",
      "disability",
      "care",
      "病院",
      "健康",
      "障害",
      "介護",
    ],
  ) {
    "health_and_care"
  } else if contains_any(
    &lower,
    &[
      "finance", "benefit", "pension", "tax", "bank", "payment", "money", "給付", "年金", "税",
      "銀行", "支払",
    ],
  ) {
    "finance_and_benefits"
  } else if contains_any(
    &lower,
    &[
      "work", "job", "school", "employer", "student", "勤務", "仕事", "学校", "転職", "職場",
    ],
  ) {
    "work_and_education"
  } else if contains_any(
    &lower,
    &[
      "family",
      "partner",
      "child",
      "household",
      "家族",
      "配偶者",
      "子ども",
      "世帯",
    ],
  ) {
    "relationships_and_household"
  } else if contains_any(
    &lower,
    &[
      "home", "address", "lease", "rent", "utility", "housing", "住所", "住居", "賃貸", "家",
    ],
  ) {
    "home_and_places"
  } else if contains_any(
    &lower,
    &[
      "contract",
      "policy",
      "insurance",
      "warranty",
      "契約",
      "保険",
      "保証",
    ],
  ) {
    "contracts_and_policies"
  } else if contains_any(
    &lower,
    &[
      "deadline",
      "submit",
      "renew",
      "procedure",
      "form",
      "期限",
      "提出",
      "更新",
      "手続",
    ],
  ) {
    "procedures_and_obligations"
  } else if contains_any(
    &lower,
    &[
      "goal",
      "priority",
      "preference",
      "tone",
      "目標",
      "優先",
      "好み",
      "口調",
    ],
  ) {
    "values_goals_and_preferences"
  } else if contains_any(
    &lower,
    &[
      "routine", "schedule", "habit", "commute", "予定", "習慣", "通勤",
    ],
  ) {
    "routines_and_logistics"
  } else if contains_any(
    &lower,
    &[
      "move",
      "moving",
      "travel",
      "plan",
      "引っ越",
      "旅行",
      "予定",
      "計画",
    ],
  ) {
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
      &[
        "contract", "deadline", "benefit", "health", "legal", "money", "契約", "期限", "給付",
        "健康", "法務", "お金",
      ],
    )
  {
    "medium"
  } else {
    "low"
  }
}

fn detect_sensitivity(text: &str) -> &'static str {
  let lower = text.to_lowercase();
  if contains_any(
    &lower,
    &[
      "password",
      "passcode",
      "api key",
      "token",
      "secret",
      "private key",
      "recovery code",
      "パスワード",
      "秘密鍵",
      "my number",
      "national id",
      "bank account",
      "口座番号",
      "マイナンバー",
    ],
  ) {
    "secret_never_send"
  } else if contains_any(
    &lower,
    &[
      "health",
      "medical",
      "doctor",
      "diagnosis",
      "disability",
      "benefit",
      "legal",
      "minor",
      "病院",
      "診断",
      "障害",
      "給付",
      "法律",
      "未成年",
    ],
  ) {
    "sensitive"
  } else if contains_any(
    &lower,
    &[
      "finance",
      "tax",
      "pension",
      "insurance",
      "contract",
      "rent",
      "salary",
      "payment",
      "税",
      "年金",
      "保険",
      "契約",
      "家賃",
      "給与",
      "支払",
    ],
  ) {
    "private_consequential"
  } else if contains_any(
    &lower,
    &[
      "name",
      "address",
      "phone",
      "email",
      "family",
      "名前",
      "住所",
      "電話",
      "メール",
      "家族",
    ],
  ) {
    "personal"
  } else {
    "public"
  }
}

// ── classify_sensitivity: Rust mirror of TS classifySensitivity ──────────────
// Mirrors src/sensitivity.ts SIGNALS list exactly: structured patterns → "high",
// bare keyword hits → "low"; secret-first ordering; no match → public/low/false.

#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SensitivityResult {
  tier: String,
  confidence: String,
  classified: bool,
  reasons: Vec<String>,
}

#[allow(dead_code)]
fn confidence_rank(c: &str) -> u8 {
  match c {
    "high" => 2,
    "medium" => 1,
    _ => 0, // "low" or unknown
  }
}

#[allow(dead_code)]
fn tier_rank_str(t: &str) -> u8 {
  match t {
    "secret_never_send" => 4,
    "sensitive" => 3,
    "private_consequential" => 2,
    "personal" => 1,
    _ => 0, // "public" or unknown
  }
}

/// Match credential assignment: keyword = value (structured, high confidence).
/// Mirrors: /\b(password|passcode|api[_\s-]?key|token|secret|private[_\s-]?key|
///           recovery[_\s-]?code|bearer\s+[a-z0-9._-]{12,})\b\s*[:=]\s*\S+/i
#[allow(dead_code)]
fn match_credential_assignment(text: &str) -> bool {
  let lower = text.to_lowercase();
  // Find each keyword group, then check if followed by [:=] and a value.
  let keywords = ["password", "passcode", "token", "secret", "bearer"];
  let compound_kw = [("api", "key"), ("private", "key"), ("recovery", "code")];

  // Check simple keywords followed by [:=]value
  for kw in &keywords {
    if let Some(pos) = lower.find(kw) {
      // Ensure word boundary: preceding char not alphanumeric
      let before_ok = pos == 0 || {
        let ch = lower[..pos].chars().last().unwrap_or(' ');
        !ch.is_alphanumeric() && ch != '_'
      };
      if before_ok {
        let after = &lower[pos + kw.len()..];
        // For "bearer" allow space then 12+ chars (no [:=] required)
        if *kw == "bearer" {
          let rest = after.trim_start();
          if rest.len() >= 12 && !rest.starts_with([':', '=']) {
            // Check next char is alphanumeric/._-
            let ch = rest.chars().next().unwrap_or(' ');
            if ch.is_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
              return true;
            }
          }
        }
        // For others, allow optional whitespace then [:=] then non-whitespace
        let rest = after.trim_start_matches(|c: char| c == '_' || c == '-' || c == ' ');
        let rest = rest.trim_start();
        if rest.starts_with(':') || rest.starts_with('=') {
          let val = rest[1..].trim_start();
          if !val.is_empty() && !val.starts_with(' ') {
            return true;
          }
        }
      }
    }
  }

  // Check compound keywords (api key, private key, recovery code) with optional separator
  for (w1, w2) in &compound_kw {
    // Build variants: "apikey", "api key", "api_key", "api-key"
    // The zero-separator form is required to match TS regex api[_\s-]?key (? = 0 or 1)
    let variants = [
      format!("{}{}", w1, w2),
      format!("{} {}", w1, w2),
      format!("{}_{}", w1, w2),
      format!("{}-{}", w1, w2),
    ];
    for variant in &variants {
      if let Some(pos) = lower.find(variant.as_str()) {
        let before_ok = pos == 0 || {
          let ch = lower[..pos].chars().last().unwrap_or(' ');
          !ch.is_alphanumeric() && ch != '_'
        };
        if before_ok {
          let after = &lower[pos + variant.len()..];
          let rest = after.trim_start();
          if rest.starts_with(':') || rest.starts_with('=') {
            let val = rest[1..].trim_start();
            if !val.is_empty() {
              return true;
            }
          }
        }
      }
    }
  }
  false
}

/// Match email address pattern. Mirrors: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
#[allow(dead_code)]
fn match_email(text: &str) -> bool {
  // Simple state-machine email scan
  let lower = text.to_lowercase();
  let bytes = lower.as_bytes();
  let len = bytes.len();
  let mut i = 0;
  while i < len {
    // Find '@'
    if bytes[i] == b'@' && i > 0 {
      // Scan local part backwards: [a-z0-9._%+-]+
      let local_end = i;
      let mut j = local_end;
      while j > 0 {
        let c = bytes[j - 1];
        if c.is_ascii_alphanumeric()
          || c == b'.'
          || c == b'_'
          || c == b'%'
          || c == b'+'
          || c == b'-'
        {
          j -= 1;
        } else {
          break;
        }
      }
      if j < local_end {
        // Scan domain part forwards: [a-z0-9.-]+\.[a-z]{2,}
        let domain_start = i + 1;
        let mut k = domain_start;
        while k < len {
          let c = bytes[k];
          if c.is_ascii_alphanumeric() || c == b'.' || c == b'-' {
            k += 1;
          } else {
            break;
          }
        }
        let domain = &lower[domain_start..k];
        // Must contain a dot and end with 2+ alpha chars
        if let Some(dot_pos) = domain.rfind('.') {
          let tld = &domain[dot_pos + 1..];
          if tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()) {
            return true;
          }
        }
      }
    }
    i += 1;
  }
  false
}

/// Luhn algorithm check for credit card numbers.
/// Mirrors: luhnValid() in src/sensitivity.ts
#[allow(dead_code)]
fn luhn_valid(digits: &str) -> bool {
  let mut sum: u32 = 0;
  let mut alternate = false;
  for ch in digits.chars().rev() {
    let Some(d) = ch.to_digit(10) else {
      return false;
    };
    let mut n = d;
    if alternate {
      n *= 2;
      if n > 9 {
        n -= 9;
      }
    }
    sum += n;
    alternate = !alternate;
  }
  sum % 10 == 0
}

/// Match マイナンバー keyword followed (within 10 non-digit chars) by a 12-digit number.
/// Mirrors: /マイナンバー[^\d]{0,10}\d{4}[ -]?\d{4}[ -]?\d{4}/ in src/sensitivity.ts
#[allow(dead_code)]
fn match_my_number(text: &str) -> bool {
  const KW: &str = "マイナンバー";
  let mut search = text;
  while let Some(pos) = search.find(KW) {
    let rest = &search[pos + KW.len()..];
    // Consume up to 10 non-digit chars
    let mut chars = rest.chars();
    let mut non_digit = 0;
    let mut after_gap = rest;
    loop {
      let mut peek = chars.clone();
      match peek.next() {
        Some(c) if !c.is_ascii_digit() && non_digit < 10 => {
          non_digit += 1;
          chars = peek;
          after_gap = chars.as_str();
        }
        _ => break,
      }
    }
    // Now match \d{4}[ -]?\d{4}[ -]?\d{4}
    // Returns byte-length of exactly n ASCII digits at start of src, or None.
    fn eat_digits(src: &[u8], n: usize) -> Option<usize> {
      if src.len() >= n && src[..n].iter().all(|b| b.is_ascii_digit()) {
        Some(n)
      } else {
        None
      }
    }
    let s = after_gap.as_bytes();
    if let Some(len1) = eat_digits(s, 4) {
      let s2 = &s[len1..];
      // optional [ -]
      let s2 = if s2.first().copied() == Some(b' ') || s2.first().copied() == Some(b'-') {
        &s2[1..]
      } else {
        s2
      };
      if let Some(len2) = eat_digits(s2, 4) {
        let s3 = &s2[len2..];
        let s3 = if s3.first().copied() == Some(b' ') || s3.first().copied() == Some(b'-') {
          &s3[1..]
        } else {
          s3
        };
        if eat_digits(s3, 4).is_some() {
          return true;
        }
      }
    }
    // Advance past keyword
    search = &search[pos + KW.len()..];
  }
  false
}

/// Match Luhn-valid credit card numbers in text.
/// Mirrors: containsLuhnCard() in src/sensitivity.ts
/// Pattern: \b\d{4}(?:[ -]\d{4}){2,4}\b | \b\d{13,19}\b — then strip spaces/hyphens,
/// check 13–19 digits, run Luhn.
#[allow(dead_code)]
fn match_card_luhn(text: &str) -> bool {
  let bytes = text.as_bytes();
  let len = bytes.len();
  // Scan for runs of digits optionally separated by spaces/hyphens (grouped or contiguous).
  let mut i = 0;
  while i < len {
    if bytes[i].is_ascii_digit() {
      // Collect a digit group (could be grouped by spaces/hyphens or contiguous).
      let start = i;
      let mut buf = String::new();
      let mut j = start;
      while j < len && (bytes[j].is_ascii_digit() || bytes[j] == b' ' || bytes[j] == b'-') {
        if bytes[j].is_ascii_digit() {
          buf.push(bytes[j] as char);
        } else if j + 1 < len && bytes[j + 1].is_ascii_digit() {
          // Accept separator only if followed by digit
        } else {
          break;
        }
        j += 1;
      }
      // Require word boundary before: preceding char must not be alphanumeric or '_'
      // (mirrors JS \b where _ is a word char, so "VISA4111..." is not a match)
      let before_ok =
        start == 0 || (!bytes[start - 1].is_ascii_alphanumeric() && bytes[start - 1] != b'_');
      // Require word boundary after: char at j must not be alphanumeric or '_'
      let after_ok = j >= len || (!bytes[j].is_ascii_alphanumeric() && bytes[j] != b'_');
      if before_ok && after_ok && buf.len() >= 13 && buf.len() <= 19 {
        if luhn_valid(&buf) {
          return true;
        }
      }
      i = if j > i { j } else { i + 1 };
    } else {
      i += 1;
    }
  }
  false
}

/// Match US SSN pattern: \b\d{3}-\d{2}-\d{4}\b(?!-).
/// Mirrors: /\b\d{3}-\d{2}-\d{4}\b(?!-)/ in src/sensitivity.ts
#[allow(dead_code)]
fn match_ssn(text: &str) -> bool {
  let bytes = text.as_bytes();
  let len = bytes.len();
  if len < 11 {
    return false;
  }
  let mut i = 0;
  while i + 10 <= len {
    // Check \b\d{3}-\d{2}-\d{4}\b(?!-)
    // Mirror JS \b: treat '_' as a word char in addition to alphanumeric.
    let word_before = i == 0 || (!bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_');
    if word_before
      && bytes[i].is_ascii_digit()
      && bytes[i + 1].is_ascii_digit()
      && bytes[i + 2].is_ascii_digit()
      && bytes[i + 3] == b'-'
      && bytes[i + 4].is_ascii_digit()
      && bytes[i + 5].is_ascii_digit()
      && bytes[i + 6] == b'-'
      && bytes[i + 7].is_ascii_digit()
      && bytes[i + 8].is_ascii_digit()
      && bytes[i + 9].is_ascii_digit()
      && bytes[i + 10].is_ascii_digit()
    {
      // Word boundary after: next char must not be alphanumeric or '_' (JS \b treats '_' as word char)
      let after_ok =
        i + 11 >= len || (!bytes[i + 11].is_ascii_alphanumeric() && bytes[i + 11] != b'_');
      // Negative lookahead (?!-): next char must not be '-'
      let not_dash = i + 11 >= len || bytes[i + 11] != b'-';
      if after_ok && not_dash {
        return true;
      }
    }
    i += 1;
  }
  false
}

/// Match IBAN pattern: \b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,3}\b
/// Mirrors: IBAN signal in src/sensitivity.ts
#[allow(dead_code)]
fn match_iban(text: &str) -> bool {
  let chars: Vec<char> = text.chars().collect();
  let len = chars.len();
  if len < 15 {
    return false;
  }
  let mut i = 0;
  while i + 4 <= len {
    // Word boundary before
    let word_before = i == 0 || {
      let c = chars[i - 1];
      !c.is_alphanumeric()
    };
    if word_before && chars[i].is_ascii_uppercase() && chars[i + 1].is_ascii_uppercase() {
      let country_end = i + 2;
      // Two check digits
      if country_end + 2 <= len
        && chars[country_end].is_ascii_digit()
        && chars[country_end + 1].is_ascii_digit()
      {
        let mut j = country_end + 2;
        // Optional space then 4 alphanumeric groups, repeated 2–7 times
        let mut group_count = 0;
        loop {
          // Optional single space
          let k = if j < len && chars[j] == ' ' { j + 1 } else { j };
          if k + 4 <= len
            && chars[k..k + 4]
              .iter()
              .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
          {
            group_count += 1;
            j = k + 4;
          } else {
            break;
          }
          if group_count == 7 {
            break;
          }
        }
        if group_count >= 2 {
          // Optional trailing: [ ]?[A-Z0-9]{1,3}
          let k = if j < len && chars[j] == ' ' { j + 1 } else { j };
          let mut trailing = 0usize;
          while trailing < 3
            && k + trailing < len
            && (chars[k + trailing].is_ascii_uppercase() || chars[k + trailing].is_ascii_digit())
          {
            trailing += 1;
          }
          let end = k + trailing;
          // Word boundary after
          let word_after = end >= len || {
            let c = chars[end];
            !c.is_alphanumeric()
          };
          if word_after && trailing >= 1 {
            // Minimum total chars: 2+2 + 2*(4+1) = 14, but require at least a meaningful IBAN
            let raw_len = end - i;
            if raw_len >= 15 {
              return true;
            }
          }
        }
      }
    }
    i += 1;
  }
  false
}

/// Match phone number pattern (tight — avoids dates, IPs, and version strings).
/// Mirrors: phone signal in src/sensitivity.ts
/// Pattern: /(?:\+\d{1,3}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4,}|
///            \(\d{3}\)[\s.-]?\d{3}[-.\s]?\d{4}|
///            \b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/
#[allow(dead_code)]
fn match_phone(text: &str) -> bool {
  let bytes = text.as_bytes();
  let len = bytes.len();

  // Helper: is separator (space, dot, hyphen)
  fn is_sep(b: u8) -> bool {
    b == b' ' || b == b'.' || b == b'-'
  }
  fn is_sep_or_none(bytes: &[u8], idx: usize) -> bool {
    idx >= bytes.len() || is_sep(bytes[idx])
  }

  let mut i = 0;
  while i < len {
    // Pattern 1: +\d{1,3} followed by optional sep, optional '(', 3 digits, optional ')', sep, 3+4 digits
    if bytes[i] == b'+' && i + 1 < len && bytes[i + 1].is_ascii_digit() {
      let mut j = i + 1;
      // Country code: 1-3 digits
      let mut cc_len = 0;
      while j < len && bytes[j].is_ascii_digit() && cc_len < 3 {
        j += 1;
        cc_len += 1;
      }
      if cc_len >= 1 {
        // Optional separator
        let j = if j < len && is_sep(bytes[j]) {
          j + 1
        } else {
          j
        };
        // Optional '('
        let mut j = j;
        let _has_paren = if j < len && bytes[j] == b'(' {
          j += 1;
          true
        } else {
          false
        };
        // 3 area digits
        if j + 3 <= len
          && bytes[j].is_ascii_digit()
          && bytes[j + 1].is_ascii_digit()
          && bytes[j + 2].is_ascii_digit()
        {
          j += 3;
          // Optional ')'
          if j < len && bytes[j] == b')' {
            j += 1;
          }
          // Separator
          let j = if j < len && is_sep(bytes[j]) {
            j + 1
          } else {
            j
          };
          let mut j = j;
          // 3 digits
          if j + 3 <= len
            && bytes[j].is_ascii_digit()
            && bytes[j + 1].is_ascii_digit()
            && bytes[j + 2].is_ascii_digit()
          {
            j += 3;
            // Optional separator
            let j = if j < len && is_sep(bytes[j]) {
              j + 1
            } else {
              j
            };
            let mut j = j;
            // 4+ digits
            let mut digit_count = 0;
            while j < len && bytes[j].is_ascii_digit() {
              j += 1;
              digit_count += 1;
            }
            if digit_count >= 4 {
              return true;
            }
          }
        }
      }
    }

    // Pattern 2: (\d{3}) followed by sep?, 3 digits, sep, 4 digits
    if bytes[i] == b'(' && i + 5 <= len {
      let mut j = i + 1;
      if j + 3 <= len
        && bytes[j].is_ascii_digit()
        && bytes[j + 1].is_ascii_digit()
        && bytes[j + 2].is_ascii_digit()
        && j + 3 < len
        && bytes[j + 3] == b')'
      {
        j += 4;
        // Optional sep
        let j = if j < len && is_sep(bytes[j]) {
          j + 1
        } else {
          j
        };
        let mut j = j;
        // 3 digits
        if j + 3 <= len
          && bytes[j].is_ascii_digit()
          && bytes[j + 1].is_ascii_digit()
          && bytes[j + 2].is_ascii_digit()
        {
          j += 3;
          // Sep (optional)
          let j = if j < len && is_sep(bytes[j]) {
            j + 1
          } else {
            j
          };
          let mut j = j;
          // 4 digits
          if j + 4 <= len
            && bytes[j].is_ascii_digit()
            && bytes[j + 1].is_ascii_digit()
            && bytes[j + 2].is_ascii_digit()
            && bytes[j + 3].is_ascii_digit()
          {
            j += 4;
            // Word boundary after: next char must not be digit
            let after_ok = j >= len || !bytes[j].is_ascii_digit();
            if after_ok {
              return true;
            }
          }
        }
      }
    }

    // Pattern 3: \b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b  (NANP 3-3-4)
    // Word boundary before — mirror JS \b: '_' is also a word char.
    let word_before = i == 0 || (!bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_');
    if word_before
      && i + 11 <= len
      && bytes[i].is_ascii_digit()
      && bytes[i + 1].is_ascii_digit()
      && bytes[i + 2].is_ascii_digit()
      && is_sep(bytes[i + 3])
      && bytes[i + 4].is_ascii_digit()
      && bytes[i + 5].is_ascii_digit()
      && bytes[i + 6].is_ascii_digit()
      && is_sep(bytes[i + 7])
      && bytes[i + 8].is_ascii_digit()
      && bytes[i + 9].is_ascii_digit()
      && bytes[i + 10].is_ascii_digit()
    {
      // Need 4th digit
      if i + 11 < len && bytes[i + 11].is_ascii_digit() {
        // Word boundary after: char at i+12 must not be digit
        let after_ok = i + 12 >= len || !bytes[i + 12].is_ascii_digit();
        if after_ok {
          return true;
        }
      }
    }

    i += 1;
  }
  false
}

/// Match postal address: house number + Capitalized street name + Capitalized suffix.
/// Mirrors: /\b\d{1,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+
///   (?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct)\b/
/// in src/sensitivity.ts
#[allow(dead_code)]
fn match_address(text: &str) -> bool {
  let chars: Vec<char> = text.chars().collect();
  let len = chars.len();
  const SUFFIXES: &[&str] = &[
    "Street",
    "St",
    "Avenue",
    "Ave",
    "Road",
    "Rd",
    "Boulevard",
    "Blvd",
    "Lane",
    "Ln",
    "Drive",
    "Dr",
    "Way",
    "Court",
    "Ct",
  ];

  let mut i = 0;
  while i < len {
    // Word boundary before: preceding char not alphanumeric
    let word_before = i == 0 || !chars[i - 1].is_alphanumeric();
    if word_before && chars[i].is_ascii_digit() {
      // Collect 1–5 digits
      let start = i;
      let mut j = i;
      let mut digit_count = 0;
      while j < len && chars[j].is_ascii_digit() && digit_count < 5 {
        j += 1;
        digit_count += 1;
      }
      // Must be followed by whitespace
      if digit_count >= 1 && j < len && chars[j] == ' ' {
        j += 1; // skip space
                // Match 1–3 words: [A-Z][A-Za-z]+  (Capitalized)
        let mut word_count = 0;
        let mut k = j;
        while word_count < 3 && k < len && chars[k].is_ascii_uppercase() {
          // Collect word
          let word_start = k;
          k += 1; // skip initial uppercase
          while k < len && chars[k].is_ascii_alphabetic() {
            k += 1;
          }
          let word: String = chars[word_start..k].iter().collect();
          // TS pattern [A-Z][A-Za-z]+ requires ≥2 chars; single-char words do not count.
          if word.len() < 2 {
            break;
          }
          // Check if this word is a street suffix
          let is_suffix = SUFFIXES.contains(&word.as_str());
          if is_suffix && word_count >= 1 {
            // Word boundary after suffix
            let after_ok = k >= len || !chars[k].is_alphanumeric();
            if after_ok {
              return true;
            }
          }
          // Must be followed by space to continue matching
          if k < len && chars[k] == ' ' {
            k += 1;
            word_count += 1;
          } else {
            break;
          }
        }
        // Check if last word scanned is a suffix preceded by at least 1 cap word
        // (handled in loop above via is_suffix && word_count >= 1)
      }
      i = if start + 1 > i { start + 1 } else { i + 1 };
    } else {
      i += 1;
    }
  }
  false
}

/// Match Japanese postal code: 〒\d{3}-\d{4}
/// Mirrors: /〒\d{3}-\d{4}/ in src/sensitivity.ts
#[allow(dead_code)]
fn match_jp_postal(text: &str) -> bool {
  let chars: Vec<char> = text.chars().collect();
  let len = chars.len();
  if len < 9 {
    return false;
  }
  for i in 0..len {
    if chars[i] == '〒' && i + 8 < len {
      // 〒 + 3 digits + '-' + 4 digits = 9 chars total (index i to i+8 inclusive)
      let d1 = chars[i + 1].is_ascii_digit();
      let d2 = chars[i + 2].is_ascii_digit();
      let d3 = chars[i + 3].is_ascii_digit();
      let dash = chars[i + 4] == '-';
      let d4 = chars[i + 5].is_ascii_digit();
      let d5 = chars[i + 6].is_ascii_digit();
      let d6 = chars[i + 7].is_ascii_digit();
      let d7 = chars[i + 8].is_ascii_digit();
      if d1 && d2 && d3 && dash && d4 && d5 && d6 && d7 {
        return true;
      }
    }
  }
  false
}

/// Classify text with full parity to TS classifySensitivity.
/// Signals ordered secret-first. Returns highest-tier, highest-confidence match.
#[allow(dead_code)]
fn classify_sensitivity(text: &str) -> SensitivityResult {
  // Build signals list mirroring SIGNALS in src/sensitivity.ts
  // Each entry: (matcher_fn, tier, confidence, reason)
  type MatchFn = fn(&str) -> bool;

  struct Signal {
    matcher: MatchFn,
    tier: &'static str,
    confidence: &'static str,
    reason: &'static str,
  }

  fn bare_credential_en(t: &str) -> bool {
    let lower = t.to_lowercase();
    contains_any(
      &lower,
      &[
        "password",
        "passcode",
        "apikey",
        "api key",
        "api_key",
        "api-key",
        "token",
        "secret",
        "privatekey",
        "private key",
        "private_key",
        "private-key",
        "recoverycode",
        "recovery code",
        "recovery_code",
        "recovery-code",
      ],
    )
  }
  fn bare_national_bank_en(t: &str) -> bool {
    let lower = t.to_lowercase();
    contains_any(
      &lower,
      &[
        "my number",
        "my_number",
        "mynumber",
        "national id",
        "national_id",
        "nationalid",
        "bank account",
        "bank_account",
      ],
    )
  }
  fn bare_national_bank_ja(t: &str) -> bool {
    contains_any(t, &["口座番号", "マイナンバー"])
  }
  fn bare_credential_ja(t: &str) -> bool {
    contains_any(t, &["パスワード", "秘密鍵"])
  }
  fn health_legal_en(t: &str) -> bool {
    let lower = t.to_lowercase();
    contains_any(
      &lower,
      &[
        "health",
        "medical",
        "doctor",
        "diagnosis",
        "disability",
        "benefit",
        "legal",
        "minor",
      ],
    )
  }
  fn health_legal_ja(t: &str) -> bool {
    contains_any(t, &["病院", "診断", "障害", "給付", "法律", "未成年"])
  }
  fn financial_en(t: &str) -> bool {
    let lower = t.to_lowercase();
    contains_any(
      &lower,
      &[
        "finance",
        "tax",
        "pension",
        "insurance",
        "contract",
        "rent",
        "salary",
        "payment",
      ],
    )
  }
  fn financial_ja(t: &str) -> bool {
    contains_any(t, &["税", "年金", "保険", "契約", "家賃", "給与", "支払"])
  }
  fn personal_contact_en(t: &str) -> bool {
    let lower = t.to_lowercase();
    contains_any(&lower, &["name", "address", "phone", "email", "family"])
  }
  fn personal_contact_ja(t: &str) -> bool {
    contains_any(t, &["名前", "住所", "電話", "メール", "家族"])
  }

  let signals: &[Signal] = &[
    // ── secret_never_send: credential structured patterns (high) ──
    Signal {
      matcher: match_credential_assignment as MatchFn,
      tier: "secret_never_send",
      confidence: "high",
      reason: "matches credential assignment pattern",
    },
    // secret_never_send: national/bank ID bare keywords (low)
    Signal {
      matcher: bare_national_bank_en as MatchFn,
      tier: "secret_never_send",
      confidence: "low",
      reason: "matches national/bank identity keyword",
    },
    // secret_never_send: Japanese identity keywords (low)
    Signal {
      matcher: bare_national_bank_ja as MatchFn,
      tier: "secret_never_send",
      confidence: "low",
      reason: "matches Japanese identity/account keyword",
    },
    // secret_never_send: マイナンバー keyword + 12-digit number (high — structured)
    Signal {
      matcher: match_my_number as MatchFn,
      tier: "secret_never_send",
      confidence: "high",
      reason: "matches マイナンバー keyword with 12-digit number",
    },
    // secret_never_send: US SSN NNN-NN-NNNN (high — structured)
    Signal {
      matcher: match_ssn as MatchFn,
      tier: "secret_never_send",
      confidence: "high",
      reason: "matches US SSN pattern (NNN-NN-NNNN)",
    },
    // secret_never_send: Luhn-valid credit card number (high — structured + algorithm)
    Signal {
      matcher: match_card_luhn as MatchFn,
      tier: "secret_never_send",
      confidence: "high",
      reason: "matches Luhn-valid card number",
    },
    // secret_never_send: IBAN (high — structured country-code + check digits)
    Signal {
      matcher: match_iban as MatchFn,
      tier: "secret_never_send",
      confidence: "high",
      reason: "matches IBAN pattern",
    },
    // secret_never_send: bare credential keywords (low)
    Signal {
      matcher: bare_credential_en as MatchFn,
      tier: "secret_never_send",
      confidence: "low",
      reason: "matches credential keyword",
    },
    // secret_never_send: Japanese credential keywords (low)
    Signal {
      matcher: bare_credential_ja as MatchFn,
      tier: "secret_never_send",
      confidence: "low",
      reason: "matches Japanese credential keyword",
    },
    // ── sensitive: health/legal/minor keywords (low) ──
    Signal {
      matcher: health_legal_en as MatchFn,
      tier: "sensitive",
      confidence: "low",
      reason: "matches health/legal/minor keyword",
    },
    // sensitive: Japanese health/legal keywords (low)
    Signal {
      matcher: health_legal_ja as MatchFn,
      tier: "sensitive",
      confidence: "low",
      reason: "matches Japanese health/legal keyword",
    },
    // ── private_consequential: financial/contract keywords (low) ──
    Signal {
      matcher: financial_en as MatchFn,
      tier: "private_consequential",
      confidence: "low",
      reason: "matches financial/contract keyword",
    },
    // private_consequential: Japanese financial/contract keywords (low)
    Signal {
      matcher: financial_ja as MatchFn,
      tier: "private_consequential",
      confidence: "low",
      reason: "matches Japanese financial/contract keyword",
    },
    // ── personal: email structured pattern (high) ──
    Signal {
      matcher: match_email as MatchFn,
      tier: "personal",
      confidence: "high",
      reason: "matches email pattern",
    },
    // personal: phone number — tight pattern only (avoids dates, IPs, versions) (high)
    Signal {
      matcher: match_phone as MatchFn,
      tier: "personal",
      confidence: "high",
      reason: "matches formatted phone number",
    },
    // personal: postal address with Capitalized name + Capitalized suffix (high)
    Signal {
      matcher: match_address as MatchFn,
      tier: "personal",
      confidence: "high",
      reason: "matches postal address pattern",
    },
    // personal: Japanese postal code 〒NNN-NNNN (high)
    Signal {
      matcher: match_jp_postal as MatchFn,
      tier: "personal",
      confidence: "high",
      reason: "matches Japanese postal code",
    },
    // personal: bare contact/family keywords (low)
    Signal {
      matcher: personal_contact_en as MatchFn,
      tier: "personal",
      confidence: "low",
      reason: "matches personal contact keyword",
    },
    // personal: Japanese contact/family keywords (low)
    Signal {
      matcher: personal_contact_ja as MatchFn,
      tier: "personal",
      confidence: "low",
      reason: "matches Japanese personal keyword",
    },
  ];

  let mut matched_tiers: Vec<(&'static str, &'static str, &'static str)> = Vec::new();
  for sig in signals {
    if (sig.matcher)(text) {
      matched_tiers.push((sig.tier, sig.confidence, sig.reason));
    }
  }

  if matched_tiers.is_empty() {
    return SensitivityResult {
      tier: "public".to_string(),
      confidence: "low".to_string(),
      classified: false,
      reasons: vec![],
    };
  }

  // Pick highest tier; among ties, pick highest confidence — mirrors TS reduce logic.
  let top = matched_tiers
    .iter()
    .copied()
    .reduce(|a, b| {
      let tier_diff = tier_rank_str(b.0) as i8 - tier_rank_str(a.0) as i8;
      if tier_diff != 0 {
        if tier_diff > 0 {
          b
        } else {
          a
        }
      } else if confidence_rank(b.1) > confidence_rank(a.1) {
        b
      } else {
        a
      }
    })
    .unwrap();

  SensitivityResult {
    tier: top.0.to_string(),
    confidence: top.1.to_string(),
    classified: true,
    reasons: matched_tiers.iter().map(|m| m.2.to_string()).collect(),
  }
}

fn candidate_type(text: &str) -> &'static str {
  let lower = text.to_lowercase();
  if contains_any(
    &lower,
    &[
      "deadline", "due", "renew", "expires", "期限", "締切", "更新",
    ],
  ) {
    "deadline"
  } else if contains_any(
    &lower,
    &[
      "must", "need to", "required", "submit", "notify", "必要", "提出", "連絡",
    ],
  ) {
    "obligation"
  } else if contains_any(&lower, &["tone", "preference", "好み", "口調"]) {
    "preference"
  } else if contains_any(&lower, &["goal", "priority", "目標", "優先"]) {
    "goal"
  } else if contains_any(
    &lower,
    &[
      "moving",
      "move",
      "job change",
      "travel",
      "引っ越",
      "転職",
      "旅行",
    ],
  ) {
    "life_event"
  } else {
    "note"
  }
}

fn cross_domain_bridge_score(task: &str, domain: &str) -> i64 {
  if contains_any(task, &["job", "work", "employer", "転職", "勤務先", "仕事"])
    && [
      "contracts_and_policies",
      "procedures_and_obligations",
      "finance_and_benefits",
    ]
    .contains(&domain)
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
  // Operate per line so a secret indicator only redacts the rest of its OWN
  // line, never across line boundaries. Once an indicator (or the "api key"
  // pattern) is seen, redact the indicator AND every remaining token on the
  // line: a credential separated from its keyword by >=2 tokens (e.g.
  // "My password is hunter2") would otherwise survive verbatim in the
  // persisted source body. Fail closed — mask more, not less.
  text
    .split('\n')
    .map(sanitize_secret_material_line)
    .collect::<Vec<_>>()
    .join("\n")
}

fn sanitize_secret_material_line(line: &str) -> String {
  let tokens = line.split_whitespace().collect::<Vec<_>>();
  let mut sanitized = Vec::new();
  let mut index = 0;
  while index < tokens.len() {
    let token = tokens[index];
    let lower = token.to_lowercase();
    let next_is_key = tokens
      .get(index + 1)
      .map(|next| next.to_lowercase().starts_with("key"))
      .unwrap_or(false);

    // High confidence (api-key pattern, or a whole-word / pluralized keyword):
    // redact the indicator AND the rest of the line, so a value separated from
    // its keyword by >=2 tokens ("password is hunter2") cannot survive.
    if (lower == "api" && next_is_key) || is_strong_secret_indicator(&lower) {
      for _ in index..tokens.len() {
        sanitized.push("[REDACTED_SECRET]".to_string());
      }
      break;
    }

    // Low confidence (keyword only as a substring, e.g. an unseparated compound
    // like "secretkey"): keep the baseline bounded blast — the indicator plus the
    // next token — so we never under-redact versus substring matching, without
    // nuking a whole line on a false positive like "secretary".
    if is_secret_indicator(&lower) {
      sanitized.push("[REDACTED_SECRET]".to_string());
      if index + 1 < tokens.len() {
        sanitized.push("[REDACTED_SECRET]".to_string());
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    sanitized.push(token.to_string());
    index += 1;
  }
  sanitized.join(" ")
}

fn sanitize_source_body(text: &str) -> String {
  // Map the per-line sanitizer directly over lines — sanitize_secret_material is
  // itself line-aware now, so calling it here would split on '\n' a second time.
  text
    .lines()
    .map(sanitize_secret_material_line)
    .collect::<Vec<_>>()
    .join("\n")
}

/// True if `needle` occurs in `token` as a whole word — delimited by
/// non-alphanumeric chars (or string boundaries) on the left, and on the right
/// by a boundary OR only a plural/possessive suffix ("s"/"es") before a boundary.
/// Matches "password=x", "x-api-key", "my_secret", and the plurals
/// "passwords"/"tokens"/"secrets", while rejecting false positives like
/// "secretary", "tokenize", "subtoken". `needle` is ASCII, so byte offsets from
/// `find` always land on char boundaries in UTF-8 input.
fn contains_secret_word(token: &str, needle: &str) -> bool {
  let mut start = 0;
  while let Some(pos) = token[start..].find(needle) {
    let abs = start + pos;
    let before_ok = abs == 0
      || !token[..abs]
        .chars()
        .next_back()
        .map(|c| c.is_alphanumeric())
        .unwrap_or(false);
    if before_ok {
      // The keyword may be followed only by a plural/possessive suffix before a
      // boundary: accept "secrets"/"tokens"/"passwords", reject "secretary".
      let suffix: String = token[abs + needle.len()..]
        .chars()
        .take_while(|c| c.is_alphanumeric())
        .collect();
      if matches!(suffix.as_str(), "" | "s" | "es") {
        return true;
      }
    }
    start = abs + 1;
  }
  false
}

/// High-confidence indicator: the token IS a secret keyword (whole word or
/// pluralized), or a Japanese keyword. Triggers the to-end-of-line redaction.
fn is_strong_secret_indicator(lower: &str) -> bool {
  contains_secret_word(lower, "password")
    || contains_secret_word(lower, "token")
    || contains_secret_word(lower, "secret")
    || contains_secret_word(lower, "api_key")
    || contains_secret_word(lower, "apikey")
    || contains_secret_word(lower, "passcode")
    || lower.contains("パスワード")
    || lower.contains("秘密鍵")
}

/// Low-confidence indicator: the keyword appears anywhere as a substring
/// (e.g. an unseparated compound like "secretkey"). Used only for the bounded
/// fallback redaction so we never under-redact versus substring matching.
/// NOTE: redaction is at-rest masking only; classification via detect_sensitivity
/// is independent, so neither matcher affects the trust boundary.
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
  vec![
    "chat.openai.com",
    "chatgpt.com",
    "claude.ai",
    "gemini.google.com",
  ]
}

fn normalize_allowed_sites(sites: Vec<String>) -> Vec<String> {
  let mut normalized = Vec::new();
  for site in sites {
    let raw = site.trim().to_lowercase();
    if raw.is_empty() {
      continue;
    }
    let host = host_from_url(&raw).unwrap_or(raw);
    let host = host.trim_start_matches("*.").trim_matches('.').to_string();
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

fn cautious_life_domains() -> Vec<String> {
  all_life_domains()
    .into_iter()
    .filter(|domain| {
      !matches!(
        *domain,
        "identity_and_profile"
          | "health_and_care"
          | "finance_and_benefits"
          | "constraints_and_accessibility"
      )
    })
    .map(str::to_string)
    .collect()
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
    "standingDeliveryEnabled": true,
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
    .map(|policies| {
      policies
        .iter()
        .any(|policy| str_field(policy, "clientId") == client_id)
    })
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeDocumentKind {
  Text,
  Pdf,
  Docx,
  Pptx,
  Xlsx,
  OpenDocument,
  ImageOcr,
  LegacyOffice,
}

impl NativeDocumentKind {
  fn label(self) -> &'static str {
    match self {
      NativeDocumentKind::Text => "text",
      NativeDocumentKind::Pdf => "pdf",
      NativeDocumentKind::Docx => "docx",
      NativeDocumentKind::Pptx => "pptx",
      NativeDocumentKind::Xlsx => "xlsx",
      NativeDocumentKind::OpenDocument => "opendocument",
      NativeDocumentKind::ImageOcr => "image_ocr",
      NativeDocumentKind::LegacyOffice => "legacy_office_converted",
    }
  }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct OcrCommandConfig {
  command: String,
  args: Vec<String>,
  timeout: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LegacyOfficeCommandConfig {
  command: String,
  args: Vec<String>,
  timeout: Duration,
}

struct TempDirGuard {
  path: PathBuf,
}

impl OcrCommandConfig {
  fn label(&self) -> String {
    Path::new(&self.command)
      .file_name()
      .and_then(|value| value.to_str())
      .unwrap_or(&self.command)
      .to_string()
  }
}

impl LegacyOfficeCommandConfig {
  fn label(&self) -> String {
    Path::new(&self.command)
      .file_name()
      .and_then(|value| value.to_str())
      .unwrap_or(&self.command)
      .to_string()
  }
}

impl TempDirGuard {
  fn new(path: PathBuf) -> Self {
    Self { path }
  }

  fn path(&self) -> &Path {
    &self.path
  }

  fn into_path(self) -> PathBuf {
    let path = self.path.clone();
    std::mem::forget(self);
    path
  }
}

impl Drop for TempDirGuard {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.path);
  }
}

#[cfg(test)]
fn extract_native_document_text_from_base64_with_ocr_config(
  file_name: &str,
  mime_type: &str,
  content_base64: &str,
  ocr_config: Option<OcrCommandConfig>,
) -> Result<NativeDocumentExtractionResult, String> {
  extract_native_document_text_from_base64_with_configs(
    file_name,
    mime_type,
    content_base64,
    ocr_config,
    legacy_office_config_from_env(),
  )
}

fn extract_native_document_text_from_base64_with_configs(
  file_name: &str,
  mime_type: &str,
  content_base64: &str,
  ocr_config: Option<OcrCommandConfig>,
  legacy_office_config: Option<LegacyOfficeCommandConfig>,
) -> Result<NativeDocumentExtractionResult, String> {
  let payload = content_base64
    .split_once(',')
    .map(|(_, content)| content)
    .unwrap_or(content_base64)
    .trim();
  let bytes = STANDARD
    .decode(payload)
    .map_err(|error| format!("文書データを読み込めませんでした: {error}"))?;
  if bytes.len() > MAX_NATIVE_DOCUMENT_BYTES {
    return Err(format!(
      "この文書は大きすぎます。ローカル抽出は{}MBまでです。",
      MAX_NATIVE_DOCUMENT_BYTES / 1024 / 1024
    ));
  }
  let kind = detect_native_document_kind(file_name, mime_type, &bytes)?;
  let mut warnings = Vec::new();
  let text = match kind {
    NativeDocumentKind::LegacyOffice => extract_legacy_office_document(
      file_name,
      mime_type,
      &bytes,
      &mut warnings,
      legacy_office_config.as_ref(),
      ocr_config.as_ref(),
    )?,
    _ => extract_standard_native_document_text(
      kind,
      file_name,
      mime_type,
      &bytes,
      &mut warnings,
      ocr_config.as_ref(),
    )?,
  };
  let text = normalize_extracted_document_text(text, &mut warnings)?;
  Ok(NativeDocumentExtractionResult {
    text,
    detected_kind: kind.label().to_string(),
    warnings,
    generated_by: "native_document_extractor".to_string(),
  })
}

fn extract_standard_native_document_text(
  kind: NativeDocumentKind,
  file_name: &str,
  mime_type: &str,
  bytes: &[u8],
  warnings: &mut Vec<String>,
  ocr_config: Option<&OcrCommandConfig>,
) -> Result<String, String> {
  Ok(match kind {
    NativeDocumentKind::Text => extract_plain_text_document(bytes)?,
    NativeDocumentKind::Pdf => pdf_extract::extract_text_from_mem(bytes)
      .map_err(|error| format!("PDF本文を抽出できませんでした: {error}"))?,
    NativeDocumentKind::Docx => {
      let (text, document_warnings) = extract_zip_xml_document_text(bytes, is_docx_text_entry)?;
      warnings.extend(document_warnings);
      text
    }
    NativeDocumentKind::Pptx => {
      let (text, document_warnings) = extract_zip_xml_document_text(bytes, is_pptx_text_entry)?;
      warnings.extend(document_warnings);
      text
    }
    NativeDocumentKind::Xlsx => {
      let (text, document_warnings) = extract_zip_xml_document_text(bytes, is_xlsx_text_entry)?;
      warnings.extend(document_warnings);
      text
    }
    NativeDocumentKind::OpenDocument => {
      let (text, document_warnings) =
        extract_zip_xml_document_text(bytes, is_opendocument_text_entry)?;
      warnings.extend(document_warnings);
      text
    }
    NativeDocumentKind::ImageOcr => {
      extract_image_ocr_document(file_name, mime_type, bytes, warnings, ocr_config.cloned())?
    }
    NativeDocumentKind::LegacyOffice => {
      return Err("旧Office文書は変換Provider経由でのみ抽出できます。".to_string())
    }
  })
}

fn detect_native_document_kind(
  file_name: &str,
  mime_type: &str,
  bytes: &[u8],
) -> Result<NativeDocumentKind, String> {
  let extension = Path::new(file_name)
    .extension()
    .and_then(|value| value.to_str())
    .map(|value| value.to_lowercase())
    .unwrap_or_default();
  let mime_type = mime_type.to_lowercase();
  let is_zip = bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06");

  if mime_type.starts_with("text/")
    || matches!(
      extension.as_str(),
      "txt"
        | "text"
        | "md"
        | "markdown"
        | "csv"
        | "tsv"
        | "json"
        | "jsonl"
        | "yaml"
        | "yml"
        | "log"
    )
  {
    return Ok(NativeDocumentKind::Text);
  }
  if mime_type == "application/pdf" || extension == "pdf" || bytes.starts_with(b"%PDF-") {
    return Ok(NativeDocumentKind::Pdf);
  }
  if extension == "docx"
    || mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  {
    return Ok(NativeDocumentKind::Docx);
  }
  if extension == "pptx"
    || mime_type == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  {
    return Ok(NativeDocumentKind::Pptx);
  }
  if extension == "xlsx"
    || mime_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  {
    return Ok(NativeDocumentKind::Xlsx);
  }
  if matches!(extension.as_str(), "odt" | "ods" | "odp")
    || matches!(
      mime_type.as_str(),
      "application/vnd.oasis.opendocument.text"
        | "application/vnd.oasis.opendocument.spreadsheet"
        | "application/vnd.oasis.opendocument.presentation"
    )
  {
    return Ok(NativeDocumentKind::OpenDocument);
  }
  if mime_type.starts_with("image/")
    || matches!(
      extension.as_str(),
      "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "heif" | "tif" | "tiff"
    )
  {
    return Ok(NativeDocumentKind::ImageOcr);
  }
  if matches!(extension.as_str(), "doc" | "xls" | "ppt")
    || bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0])
  {
    return Ok(NativeDocumentKind::LegacyOffice);
  }
  if is_zip {
    return Err(
      "ZIP系文書として検出しましたが、対応するOffice/OpenDocument形式ではありません。".to_string(),
    );
  }
  Err(
    "このファイル形式はまだSource化できません。対応形式は TXT/MD/CSV/JSON/YAML/LOG/PDF/DOCX/PPTX/XLSX/ODT/ODS/ODP です。"
      .to_string(),
  )
}

fn ocr_command_config_from_env() -> Option<OcrCommandConfig> {
  let command = env::var("LCV_OCR_COMMAND").ok()?;
  let timeout_seconds = env::var("LCV_OCR_TIMEOUT_SECONDS")
    .ok()
    .and_then(|value| value.parse::<u64>().ok());
  ocr_command_config_from_parts(
    &command,
    env::var("LCV_OCR_ARGS").ok().as_deref(),
    timeout_seconds,
  )
}

fn ocr_command_config_from_parts(
  command: &str,
  args: Option<&str>,
  timeout_seconds: Option<u64>,
) -> Option<OcrCommandConfig> {
  let command = command.trim();
  if command.is_empty() {
    return None;
  }
  let args = args
    .map(|value| {
      value
        .split_whitespace()
        .filter(|part| !part.trim().is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>()
    })
    .filter(|args| !args.is_empty())
    .unwrap_or_else(|| vec!["{input}".to_string()]);
  Some(OcrCommandConfig {
    command: command.to_string(),
    args,
    timeout: ocr_timeout_from_value(timeout_seconds),
  })
}

fn ocr_timeout_from_value(seconds: Option<u64>) -> Duration {
  let seconds = seconds.unwrap_or(30).clamp(1, 120);
  Duration::from_secs(seconds)
}

fn ocr_command_config_from_input(
  command: Option<&str>,
  args: Option<&str>,
  timeout_seconds: Option<u64>,
) -> Option<OcrCommandConfig> {
  command.and_then(|command| ocr_command_config_from_parts(command, args, timeout_seconds))
}

fn legacy_office_config_from_env() -> Option<LegacyOfficeCommandConfig> {
  let command = env::var("LCV_LEGACY_OFFICE_COMMAND").ok()?;
  let timeout_seconds = env::var("LCV_LEGACY_OFFICE_TIMEOUT_SECONDS")
    .ok()
    .and_then(|value| value.parse::<u64>().ok());
  legacy_office_command_config_from_parts(
    &command,
    env::var("LCV_LEGACY_OFFICE_ARGS").ok().as_deref(),
    timeout_seconds,
  )
}

fn legacy_office_command_config_from_parts(
  command: &str,
  args: Option<&str>,
  timeout_seconds: Option<u64>,
) -> Option<LegacyOfficeCommandConfig> {
  let command = command.trim();
  if command.is_empty() {
    return None;
  }
  let args = args
    .map(|value| {
      value
        .split_whitespace()
        .filter(|part| !part.trim().is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>()
    })
    .filter(|args| !args.is_empty())
    .unwrap_or_else(|| {
      vec![
        "--headless".to_string(),
        "--convert-to".to_string(),
        "{target_ext}".to_string(),
        "--outdir".to_string(),
        "{output_dir}".to_string(),
        "{input}".to_string(),
      ]
    });
  Some(LegacyOfficeCommandConfig {
    command: command.to_string(),
    args,
    timeout: legacy_office_timeout_from_value(timeout_seconds),
  })
}

fn legacy_office_timeout_from_value(seconds: Option<u64>) -> Duration {
  let seconds = seconds.unwrap_or(60).clamp(1, 120);
  Duration::from_secs(seconds)
}

fn legacy_office_command_config_from_input(
  command: Option<&str>,
  args: Option<&str>,
  timeout_seconds: Option<u64>,
) -> Option<LegacyOfficeCommandConfig> {
  command
    .and_then(|command| legacy_office_command_config_from_parts(command, args, timeout_seconds))
}

fn detect_ocr_provider_candidates_from_sources(
  path_env: Option<OsString>,
  common_paths: &[PathBuf],
) -> Vec<OcrProviderCandidate> {
  let mut candidates = Vec::new();
  let mut seen = HashSet::new();

  if let Some(path_env) = path_env {
    for dir in env::split_paths(&path_env) {
      for binary in tesseract_binary_names() {
        let path = dir.join(binary);
        push_tesseract_candidate(&mut candidates, &mut seen, &path, "PATH");
      }
    }
  }

  for path in common_paths {
    push_tesseract_candidate(&mut candidates, &mut seen, path, "common-path");
  }

  candidates
}

fn detect_ocr_provider_candidates_internal() -> Vec<OcrProviderCandidate> {
  detect_ocr_provider_candidates_from_sources(env::var_os("PATH"), &common_ocr_provider_paths())
}

fn detect_legacy_office_provider_candidates_from_sources(
  path_env: Option<OsString>,
  common_paths: &[PathBuf],
) -> Vec<OcrProviderCandidate> {
  let mut candidates = Vec::new();
  let mut seen = HashSet::new();

  if let Some(path_env) = path_env {
    for dir in env::split_paths(&path_env) {
      for binary in legacy_office_binary_names() {
        let path = dir.join(binary);
        push_legacy_office_candidate(&mut candidates, &mut seen, &path, "PATH");
      }
    }
  }

  for path in common_paths {
    push_legacy_office_candidate(&mut candidates, &mut seen, path, "common-path");
  }

  candidates
}

fn detect_legacy_office_provider_candidates_internal() -> Vec<OcrProviderCandidate> {
  detect_legacy_office_provider_candidates_from_sources(
    env::var_os("PATH"),
    &common_legacy_office_provider_paths(),
  )
}

fn common_ocr_provider_paths() -> Vec<PathBuf> {
  let mut paths = vec![
    PathBuf::from("/opt/homebrew/bin/tesseract"),
    PathBuf::from("/usr/local/bin/tesseract"),
    PathBuf::from("/usr/bin/tesseract"),
  ];
  if cfg!(windows) {
    paths.push(PathBuf::from(
      r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    ));
  }
  paths
}

fn common_legacy_office_provider_paths() -> Vec<PathBuf> {
  let mut paths = vec![
    PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
    PathBuf::from("/opt/homebrew/bin/soffice"),
    PathBuf::from("/usr/local/bin/soffice"),
    PathBuf::from("/usr/bin/libreoffice"),
    PathBuf::from("/usr/bin/soffice"),
    PathBuf::from("/snap/bin/libreoffice"),
  ];
  if cfg!(windows) {
    paths.push(PathBuf::from(
      r"C:\Program Files\LibreOffice\program\soffice.exe",
    ));
    paths.push(PathBuf::from(
      r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ));
  }
  paths
}

fn tesseract_binary_names() -> Vec<&'static str> {
  if cfg!(windows) {
    vec!["tesseract.exe", "tesseract"]
  } else {
    vec!["tesseract"]
  }
}

fn legacy_office_binary_names() -> Vec<&'static str> {
  if cfg!(windows) {
    vec!["soffice.exe", "libreoffice.exe", "soffice", "libreoffice"]
  } else {
    vec!["soffice", "libreoffice"]
  }
}

fn push_tesseract_candidate(
  candidates: &mut Vec<OcrProviderCandidate>,
  seen: &mut HashSet<String>,
  path: &Path,
  source: &str,
) {
  if !path_is_file(path) {
    return;
  }
  let command = path.to_string_lossy().to_string();
  if !seen.insert(command.clone()) {
    return;
  }
  candidates.push(OcrProviderCandidate {
    label: format!("Tesseract OCR ({source})"),
    command,
    args: "{input} stdout".to_string(),
    timeout_seconds: 30,
    source: source.to_string(),
  });
}

fn push_legacy_office_candidate(
  candidates: &mut Vec<OcrProviderCandidate>,
  seen: &mut HashSet<String>,
  path: &Path,
  source: &str,
) {
  if !path_is_file(path) {
    return;
  }
  let command = path.to_string_lossy().to_string();
  if !seen.insert(command.clone()) {
    return;
  }
  candidates.push(OcrProviderCandidate {
    label: format!("LibreOffice ({source})"),
    command,
    args: "--headless --convert-to {target_ext} --outdir {output_dir} {input}".to_string(),
    timeout_seconds: 60,
    source: source.to_string(),
  });
}

fn path_is_file(path: &Path) -> bool {
  fs::metadata(path)
    .map(|metadata| metadata.is_file())
    .unwrap_or(false)
}

fn ocr_config_or_env(config: Option<OcrCommandConfig>) -> Option<OcrCommandConfig> {
  config.or_else(ocr_command_config_from_env)
}

fn legacy_office_config_or_env(
  config: Option<&LegacyOfficeCommandConfig>,
) -> Option<LegacyOfficeCommandConfig> {
  config.cloned().or_else(legacy_office_config_from_env)
}

fn extract_legacy_office_document(
  file_name: &str,
  mime_type: &str,
  bytes: &[u8],
  warnings: &mut Vec<String>,
  legacy_office_config: Option<&LegacyOfficeCommandConfig>,
  ocr_config: Option<&OcrCommandConfig>,
) -> Result<String, String> {
  let config = legacy_office_config_or_env(legacy_office_config);
  let config = config.as_ref().ok_or_else(|| {
    "旧Office変換Providerが設定されていません。LibreOffice等でDOCX/PPTX/XLSX、PDF、またはテキストへ変換してから追加してください。"
      .to_string()
  })?;
  let target_ext = legacy_office_target_extension(file_name, mime_type)?;
  let (temp_dir, input_path, output_path) =
    write_legacy_office_temp_input(file_name, target_ext, bytes)?;
  let temp_dir = TempDirGuard::new(temp_dir);
  let input_path_text = input_path.display().to_string();
  let output_dir_text = temp_dir.path().display().to_string();
  let output_path_text = output_path.display().to_string();
  let mut command = Command::new(&config.command);
  command.env_clear();
  if let Some(path) = env::var_os("PATH") {
    command.env("PATH", path);
  }
  command.env("LC_ALL", "C.UTF-8");
  command.env("LANG", "C.UTF-8");
  for arg in &config.args {
    command.arg(
      arg
        .replace("{input}", &input_path_text)
        .replace("{output_dir}", &output_dir_text)
        .replace("{output}", &output_path_text)
        .replace("{target_ext}", target_ext)
        .replace("{mime}", mime_type)
        .replace("{file_name}", file_name),
    );
  }
  command.stdout(Stdio::piped()).stderr(Stdio::piped());

  let output = run_command_with_timeout(&mut command, config.timeout, "旧Office変換Provider");
  let converted_bytes = match output {
    Ok(output) if output.status.success() => {
      if !output_path.exists() {
        return Err("旧Office変換Providerは完了しましたが、変換後ファイルが見つかりませんでした。引数の{output_dir}/{output}設定を確認してください。".to_string());
      }
      fs::read(&output_path)
        .map_err(|error| format!("変換後Office文書を読めませんでした: {error}"))?
    }
    Ok(_) => {
      return Err("旧Office変換Providerが変換に失敗しました。コマンド、引数、対応ファイル形式を確認してください。".to_string());
    }
    Err(error) => {
      return Err(error);
    }
  };
  if converted_bytes.len() > MAX_NATIVE_DOCUMENT_BYTES {
    return Err(format!(
      "変換後Office文書が大きすぎます。ローカル抽出は{}MBまでです。",
      MAX_NATIVE_DOCUMENT_BYTES / 1024 / 1024
    ));
  }
  let converted_name = output_path
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or(file_name)
    .to_string();
  let converted_kind = detect_native_document_kind(&converted_name, "", &converted_bytes)?;
  if converted_kind == NativeDocumentKind::LegacyOffice {
    return Err("旧Office変換Providerの出力が旧Office形式のままでした。DOCX/PPTX/XLSX/PDFへ変換する設定にしてください。".to_string());
  }
  warnings.push(format!(
    "旧Office文書はローカル変換Provider `{}` で{}へ変換してから抽出しました。保存前に候補を確認してください。",
    config.label(),
    target_ext.to_uppercase()
  ));
  extract_standard_native_document_text(
    converted_kind,
    &converted_name,
    "",
    &converted_bytes,
    warnings,
    ocr_config,
  )
}

fn legacy_office_target_extension(
  file_name: &str,
  mime_type: &str,
) -> Result<&'static str, String> {
  let extension = Path::new(file_name)
    .extension()
    .and_then(|value| value.to_str())
    .map(|value| value.to_lowercase())
    .unwrap_or_default();
  let mime_type = mime_type.to_lowercase();
  if extension == "doc" || mime_type == "application/msword" {
    return Ok("docx");
  }
  if extension == "xls" || mime_type == "application/vnd.ms-excel" {
    return Ok("xlsx");
  }
  if extension == "ppt" || mime_type == "application/vnd.ms-powerpoint" {
    return Ok("pptx");
  }
  Err("旧Office文書の種類を判定できませんでした。拡張子が.doc/.xls/.pptのファイルを指定してください。".to_string())
}

fn write_legacy_office_temp_input(
  file_name: &str,
  target_ext: &str,
  bytes: &[u8],
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
  let extension = Path::new(file_name)
    .extension()
    .and_then(|value| value.to_str())
    .filter(|value| {
      value
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
    })
    .unwrap_or("doc");
  let stem = Path::new(file_name)
    .file_stem()
    .and_then(|value| value.to_str())
    .map(safe_temp_file_stem)
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "input".to_string());
  let temp_dir = env::temp_dir().join(new_id("lcv_legacy_office"));
  fs::create_dir(&temp_dir)
    .map_err(|error| format!("旧Office変換一時ディレクトリを準備できませんでした: {error}"))?;
  let temp_dir_guard = TempDirGuard::new(temp_dir);
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(temp_dir_guard.path(), fs::Permissions::from_mode(0o700));
  }
  let input_path = temp_dir_guard.path().join(format!("{stem}.{extension}"));
  {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&input_path)
      .map_err(|error| format!("旧Office変換入力ファイルを準備できませんでした: {error}"))?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    file
      .write_all(bytes)
      .map_err(|error| format!("旧Office変換入力ファイルを書き込めませんでした: {error}"))?;
  }
  let output_path = temp_dir_guard.path().join(format!("{stem}.{target_ext}"));
  Ok((temp_dir_guard.into_path(), input_path, output_path))
}

fn safe_temp_file_stem(value: &str) -> String {
  value
    .chars()
    .map(|character| {
      if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
        character
      } else {
        '_'
      }
    })
    .collect()
}

fn extract_image_ocr_document(
  file_name: &str,
  mime_type: &str,
  bytes: &[u8],
  warnings: &mut Vec<String>,
  ocr_config: Option<OcrCommandConfig>,
) -> Result<String, String> {
  let config = ocr_config_or_env(ocr_config);
  extract_image_ocr_document_with_optional_config(
    config.as_ref(),
    file_name,
    mime_type,
    bytes,
    warnings,
  )
}

fn extract_image_ocr_document_with_optional_config(
  config: Option<&OcrCommandConfig>,
  file_name: &str,
  mime_type: &str,
  bytes: &[u8],
  warnings: &mut Vec<String>,
) -> Result<String, String> {
  let config = config.ok_or_else(|| {
    "画像OCR Providerが設定されていません。LCV_OCR_COMMANDを設定するか、テキスト化した内容をManual sourceへ貼り付けてください。"
      .to_string()
  })?;
  extract_image_ocr_document_with_config(config, file_name, mime_type, bytes, warnings)
}

fn extract_image_ocr_document_with_config(
  config: &OcrCommandConfig,
  file_name: &str,
  mime_type: &str,
  bytes: &[u8],
  warnings: &mut Vec<String>,
) -> Result<String, String> {
  let (temp_dir, input_path) = write_ocr_temp_input(file_name, bytes)?;

  let input_path_text = input_path.display().to_string();
  let mut command = Command::new(&config.command);
  command.env_clear();
  if let Some(path) = env::var_os("PATH") {
    command.env("PATH", path);
  }
  command.env("LC_ALL", "C.UTF-8");
  command.env("LANG", "C.UTF-8");
  for arg in &config.args {
    command.arg(
      arg
        .replace("{input}", &input_path_text)
        .replace("{mime}", mime_type)
        .replace("{file_name}", file_name),
    );
  }
  command.stdout(Stdio::piped()).stderr(Stdio::piped());

  let output = run_command_with_timeout(&mut command, config.timeout, "OCR Provider");
  let _ = fs::remove_dir_all(&temp_dir);
  let output = output?;
  if !output.status.success() {
    return Err(
      "OCR Providerが本文抽出に失敗しました。コマンド、引数、対応画像形式を確認してください。"
        .to_string(),
    );
  }
  let text = String::from_utf8(output.stdout)
    .map_err(|_| "OCR Providerの出力をUTF-8として読めませんでした。".to_string())?;
  warnings.push(format!(
    "画像本文はローカルOCR Provider `{}` で抽出しました。保存前に候補を確認してください。",
    config.label()
  ));
  Ok(text)
}

fn write_ocr_temp_input(file_name: &str, bytes: &[u8]) -> Result<(PathBuf, PathBuf), String> {
  let extension = Path::new(file_name)
    .extension()
    .and_then(|value| value.to_str())
    .filter(|value| {
      value
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
    })
    .unwrap_or("img");
  let temp_dir = env::temp_dir().join(new_id("lcv_ocr"));
  fs::create_dir(&temp_dir)
    .map_err(|error| format!("OCR一時ディレクトリを準備できませんでした: {error}"))?;
  let temp_dir_guard = TempDirGuard::new(temp_dir);
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(temp_dir_guard.path(), fs::Permissions::from_mode(0o700));
  }
  let input_path = temp_dir_guard.path().join(format!("input.{extension}"));
  {
    let mut file = fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(&input_path)
      .map_err(|error| format!("OCR入力ファイルを準備できませんでした: {error}"))?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    file
      .write_all(bytes)
      .map_err(|error| format!("OCR入力ファイルを書き込めませんでした: {error}"))?;
  }
  Ok((temp_dir_guard.into_path(), input_path))
}

fn run_command_with_timeout(
  command: &mut Command,
  timeout: Duration,
  provider_label: &str,
) -> Result<Output, String> {
  let mut child = command
    .spawn()
    .map_err(|error| format!("{provider_label}を起動できませんでした: {error}"))?;
  let stdout = child
    .stdout
    .take()
    .ok_or_else(|| format!("{provider_label}の標準出力を取得できませんでした。"))?;
  let stderr = child
    .stderr
    .take()
    .ok_or_else(|| format!("{provider_label}の標準エラー出力を取得できませんでした。"))?;
  // Reader threads stream their result over a channel rather than being join()ed
  // directly, so we can always collect them with a deadline. A provider that
  // spawns a grandchild inheriting the stdout pipe would keep the pipe open even
  // after child.kill(), so an unbounded join() would hang and defeat the timeout.
  let (stdout_tx, stdout_rx) = mpsc::channel();
  thread::spawn(move || {
    let _ = stdout_tx.send(drain_reader_limited(stdout, MAX_PROVIDER_STDOUT_BYTES));
  });
  let (stderr_tx, stderr_rx) = mpsc::channel();
  thread::spawn(move || {
    let _ = stderr_tx.send(drain_reader_limited(stderr, MAX_PROVIDER_STDERR_BYTES));
  });
  let started_at = SystemTime::now();
  let status = loop {
    match child
      .try_wait()
      .map_err(|error| format!("{provider_label}の状態を確認できませんでした: {error}"))?
    {
      Some(_) => {
        break child
          .wait()
          .map_err(|error| format!("{provider_label}の終了状態を読めませんでした: {error}"))?;
      }
      None => {
        let elapsed = started_at.elapsed().unwrap_or_default();
        if elapsed >= timeout {
          let _ = child.kill();
          let _ = child.wait();
          // Bounded drain only — never wait forever for readers that a lingering
          // grandchild may be holding open.
          let _ = stdout_rx.recv_timeout(PROVIDER_READER_DRAIN_GRACE);
          let _ = stderr_rx.recv_timeout(PROVIDER_READER_DRAIN_GRACE);
          return Err(format!(
            "{provider_label}が{}秒以内に完了しなかったため停止しました。",
            timeout.as_secs()
          ));
        }
        thread::sleep(Duration::from_millis(25));
      }
    }
  };
  let stdout = collect_drained_output(&stdout_rx, provider_label, "標準出力")?;
  let stderr = collect_drained_output(&stderr_rx, provider_label, "標準エラー出力")?;
  if stdout.exceeded {
    return Err(format!(
      "{provider_label}の標準出力が大きすぎます。ローカルProvider出力は{}MBまでです。",
      MAX_PROVIDER_STDOUT_BYTES / 1024 / 1024
    ));
  }
  Ok(Output {
    status,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
  })
}

struct DrainedOutput {
  bytes: Vec<u8>,
  exceeded: bool,
}

fn drain_reader_limited<R: Read>(mut reader: R, limit: usize) -> Result<DrainedOutput, String> {
  let mut bytes = Vec::new();
  let mut exceeded = false;
  let mut buffer = [0u8; 8192];
  loop {
    let len = reader
      .read(&mut buffer)
      .map_err(|error| format!("Provider出力を読めませんでした: {error}"))?;
    if len == 0 {
      break;
    }
    let remaining = limit.saturating_sub(bytes.len());
    if remaining >= len {
      bytes.extend_from_slice(&buffer[..len]);
    } else {
      bytes.extend_from_slice(&buffer[..remaining]);
      exceeded = true;
    }
  }
  Ok(DrainedOutput { bytes, exceeded })
}

fn collect_drained_output(
  rx: &mpsc::Receiver<Result<DrainedOutput, String>>,
  provider_label: &str,
  stream_label: &str,
) -> Result<DrainedOutput, String> {
  match rx.recv_timeout(PROVIDER_READER_DRAIN_GRACE) {
    Ok(result) => {
      result.map_err(|error| format!("{provider_label}の{stream_label}を読めませんでした: {error}"))
    }
    Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
      "{provider_label}の{stream_label}の読み取りが時間内に完了しませんでした（子プロセスが出力を保持している可能性があります）。"
    )),
    Err(mpsc::RecvTimeoutError::Disconnected) => {
      Err(format!("{provider_label}の{stream_label}Readerが停止しました。"))
    }
  }
}

fn extract_plain_text_document(bytes: &[u8]) -> Result<String, String> {
  let text = String::from_utf8(bytes.to_vec())
    .map_err(|_| "このテキスト文書はUTF-8として読めませんでした。".to_string())?;
  if !looks_like_readable_document_text(&text) {
    return Err("本文がテキストとして読めませんでした。PDF/画像/Office文書はネイティブ抽出経由で追加してください。".to_string());
  }
  Ok(text)
}

fn looks_like_readable_document_text(text: &str) -> bool {
  if text.trim().is_empty() {
    return false;
  }
  let sample = text.chars().take(4096).collect::<String>();
  let trimmed = sample.trim_start();
  if trimmed.starts_with("%PDF-")
    || trimmed.starts_with("PK\u{0003}\u{0004}")
    || trimmed.starts_with("\u{0089}PNG")
    || trimmed.starts_with("GIF87a")
    || trimmed.starts_with("GIF89a")
  {
    return false;
  }
  if sample.contains('\0') {
    return false;
  }
  let total = sample.chars().count().max(1);
  let control_count = sample
    .chars()
    .filter(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    .count();
  control_count * 100 < total * 2
}

fn extract_zip_xml_document_text<F>(
  bytes: &[u8],
  include_entry: F,
) -> Result<(String, Vec<String>), String>
where
  F: Fn(&str) -> bool,
{
  let cursor = Cursor::new(bytes);
  let mut archive =
    zip::ZipArchive::new(cursor).map_err(|error| format!("文書ZIPを開けませんでした: {error}"))?;
  if archive.len() > 2_000 {
    return Err("この文書は内部ファイル数が多すぎるため、安全のため抽出しません。".to_string());
  }

  let mut parts = Vec::new();
  let mut warnings = Vec::new();
  // Bound the *aggregate* extracted text as we go. The per-entry (8 MiB) and
  // entry-count (2000) guards above do not cap the sum, so a zip-bomb document
  // whose many entries each declare large uncompressed sizes could otherwise
  // accumulate gigabytes in `parts` before the post-hoc cap in
  // normalize_extracted_document_text ever runs. Stop reading further entries
  // once the cumulative char budget is exhausted (fail closed: surface less).
  let mut total_chars: usize = 0;
  for index in 0..archive.len() {
    let mut file = archive
      .by_index(index)
      .map_err(|error| format!("文書内ファイルを読めませんでした: {error}"))?;
    let name = file.name().to_string();
    if !include_entry(&name) {
      continue;
    }
    if file.size() > MAX_NATIVE_XML_ENTRY_BYTES {
      warnings.push(format!("{name} は大きすぎるため抽出から除外しました。"));
      continue;
    }
    let mut xml = Vec::new();
    file
      .read_to_end(&mut xml)
      .map_err(|error| format!("文書XMLを読めませんでした: {error}"))?;
    let text = extract_visible_text_from_xml(&xml)?;
    if text.trim().is_empty() {
      continue;
    }
    let remaining = MAX_EXTRACTED_TEXT_CHARS.saturating_sub(total_chars);
    if remaining == 0 {
      warnings.push(
        "抽出テキストが上限に達したため、以降の内部ファイルは抽出しませんでした。".to_string(),
      );
      break;
    }
    let text_chars = text.chars().count();
    if text_chars > remaining {
      let truncated: String = text.chars().take(remaining).collect();
      parts.push(truncated);
      warnings.push(
        "抽出テキストが上限に達したため、一部を切り詰めて以降の内部ファイルは抽出しませんでした。"
          .to_string(),
      );
      break;
    }
    total_chars += text_chars;
    parts.push(text);
  }

  if parts.is_empty() {
    return Err(
      "この文書から抽出できる本文が見つかりませんでした。画像だけの文書はOCR Providerが必要です。"
        .to_string(),
    );
  }
  Ok((parts.join("\n"), warnings))
}

fn is_docx_text_entry(name: &str) -> bool {
  name == "word/document.xml"
    || name.starts_with("word/header")
    || name.starts_with("word/footer")
    || name == "word/footnotes.xml"
    || name == "word/endnotes.xml"
    || name == "word/comments.xml"
}

fn is_pptx_text_entry(name: &str) -> bool {
  (name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
    || (name.starts_with("ppt/notesSlides/notesSlide") && name.ends_with(".xml"))
}

fn is_xlsx_text_entry(name: &str) -> bool {
  name == "xl/sharedStrings.xml"
    || (name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
}

fn is_opendocument_text_entry(name: &str) -> bool {
  name == "content.xml"
}

fn extract_visible_text_from_xml(bytes: &[u8]) -> Result<String, String> {
  let mut reader = quick_xml::Reader::from_reader(bytes);
  reader.trim_text(true);
  let mut buffer = Vec::new();
  let mut output = String::new();

  loop {
    match reader.read_event_into(&mut buffer) {
      Ok(quick_xml::events::Event::Text(event)) => {
        let text = event
          .unescape()
          .map_err(|error| format!("文書XMLの本文を読めませんでした: {error}"))?;
        append_visible_text(&mut output, text.as_ref());
      }
      Ok(quick_xml::events::Event::CData(event)) => {
        let text = String::from_utf8_lossy(event.as_ref());
        append_visible_text(&mut output, &text);
      }
      Ok(quick_xml::events::Event::End(event)) => {
        if is_xml_block_name(event.name().as_ref()) {
          append_visible_break(&mut output);
        }
      }
      Ok(quick_xml::events::Event::Empty(event)) => {
        if is_xml_break_name(event.name().as_ref()) {
          append_visible_break(&mut output);
        }
      }
      Ok(quick_xml::events::Event::Eof) => break,
      Err(error) => return Err(format!("文書XMLを解析できませんでした: {error}")),
      _ => {}
    }
    buffer.clear();
  }

  Ok(output)
}

fn append_visible_text(output: &mut String, text: &str) {
  let text = text.trim();
  if text.is_empty() {
    return;
  }
  let needs_space = output
    .chars()
    .last()
    .map(|character| !character.is_whitespace())
    .unwrap_or(false);
  if needs_space {
    output.push(' ');
  }
  output.push_str(text);
}

fn append_visible_break(output: &mut String) {
  if !output.ends_with('\n') {
    output.push('\n');
  }
}

fn is_xml_block_name(name: &[u8]) -> bool {
  matches!(
    name,
    b"p" | b"tr" | b"row" | b"text:p" | b"text:h" | b"table:table-row"
  ) || name.ends_with(b":p")
    || name.ends_with(b":tr")
}

fn is_xml_break_name(name: &[u8]) -> bool {
  matches!(name, b"br" | b"w:br" | b"text:line-break") || name.ends_with(b":br")
}

fn normalize_extracted_document_text(
  text: String,
  warnings: &mut Vec<String>,
) -> Result<String, String> {
  let mut text = text.replace("\r\n", "\n").replace('\r', "\n");
  text = text.replace('\0', "");
  if text.trim().is_empty() {
    return Err(
      "抽出できる本文が見つかりませんでした。画像だけの文書はOCR Providerが必要です。".to_string(),
    );
  }
  let char_count = text.chars().count();
  if char_count > MAX_EXTRACTED_TEXT_CHARS {
    text = text.chars().take(MAX_EXTRACTED_TEXT_CHARS).collect();
    warnings.push(format!(
      "抽出本文が長いため、先頭{}文字だけをSource化しました。",
      MAX_EXTRACTED_TEXT_CHARS
    ));
  }
  Ok(text)
}

fn extract_memory_candidates_for_source(
  source_id: &str,
  body: &str,
  created_at: &str,
) -> Vec<Value> {
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
  if contains_any(
    &lower,
    &["tone", "communication", "話し方", "文体", "口調", "伝え方"],
  ) {
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
  if contains_any(
    &lower,
    &[
      "goal",
      "priority",
      "want to",
      "目標",
      "優先",
      "大事",
      "やりたい",
    ],
  ) {
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
  if contains_any(
    &lower,
    &[
      "constraint",
      "budget",
      "energy",
      "accessibility",
      "schedule",
      "制約",
      "予算",
      "体力",
      "予定",
      "アクセシビリティ",
    ],
  ) {
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
      &[
        "deadline",
        "due",
        "renew",
        "expires",
        "expiration",
        "submit",
        "update",
        "期限",
        "締切",
        "更新",
        "提出",
        "満了",
      ],
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
  if contains_any(
    &lower,
    &[
      "must", "need to", "required", "submit", "notify", "cancel", "renew", "必要", "提出", "連絡",
      "解約", "更新",
    ],
  ) {
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
  if contains_any(
    &lower,
    &[
      "moving",
      "move",
      "job change",
      "travel",
      "caregiving",
      "引っ越",
      "転職",
      "旅行",
      "介護",
      "入学",
      "卒業",
    ],
  ) {
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
    "createsFactIds": [],
    "conflictWithFactIds": []
  });
  if let Some(due_date) = due_date {
    candidate["dueDate"] = Value::String(due_date);
  }
  candidate
}

fn annotate_candidates_conflicts(vault: &Value, candidates: &mut [Value]) {
  for candidate in candidates {
    annotate_candidate_conflicts(vault, candidate);
  }
}

fn annotate_candidate_conflicts(vault: &Value, candidate: &mut Value) {
  let conflict_ids = value_array(vault, "facts")
    .into_iter()
    .filter(|fact| str_field(fact, "status") == "active")
    .filter(|fact| str_field(fact, "domain") == str_field(candidate, "domain"))
    .filter(|fact| candidate_conflicts_with_fact(candidate, fact))
    .take(4)
    .map(|fact| str_field(fact, "id"))
    .collect::<Vec<_>>();

  if !conflict_ids.is_empty() {
    candidate["conflictWithFactIds"] = json!(conflict_ids);
    candidate["conflictReason"] = Value::String(
      "既存のActive Factと日付または内容が異なる可能性があります。保存前に置き換えるか確認してください。".to_string(),
    );
  }
}

fn candidate_conflicts_with_fact(candidate: &Value, fact: &Value) -> bool {
  let candidate_text = str_field(candidate, "proposedFactText");
  let fact_text = str_field(fact, "factText");
  let candidate_date =
    optional_str_field(candidate, "dueDate").or_else(|| extract_yyyy_mm_dd(&candidate_text));
  let fact_date = optional_str_field(fact, "dueDate").or_else(|| extract_yyyy_mm_dd(&fact_text));

  if let (Some(candidate_date), Some(fact_date)) = (candidate_date, fact_date) {
    if candidate_date != fact_date
      && shared_conflict_keyword_count(&candidate_text, &fact_text) >= 2
    {
      return true;
    }
  }

  current_value_conflicts(&candidate_text, &fact_text)
}

fn shared_conflict_keyword_count(left: &str, right: &str) -> usize {
  let left_keywords = conflict_keywords(left);
  let right_keywords = conflict_keywords(right);
  left_keywords
    .iter()
    .filter(|keyword| right_keywords.iter().any(|existing| existing == *keyword))
    .count()
}

fn conflict_keywords(text: &str) -> Vec<String> {
  let stop_words = [
    "the", "and", "for", "with", "before", "after", "need", "needs", "update", "updated", "renew",
    "renews", "on", "by", "to", "of",
  ];
  let mut keywords = Vec::new();
  let mut current = String::new();

  for character in text.to_lowercase().chars() {
    if character.is_alphanumeric()
      || ('一'..='龠').contains(&character)
      || ('ぁ'..='ん').contains(&character)
      || ('ァ'..='ン').contains(&character)
      || character == 'ー'
    {
      current.push(character);
      continue;
    }
    push_conflict_keyword(&mut keywords, &current, &stop_words);
    current.clear();
  }
  push_conflict_keyword(&mut keywords, &current, &stop_words);
  keywords
}

fn push_conflict_keyword(keywords: &mut Vec<String>, token: &str, stop_words: &[&str]) {
  let token = token.trim();
  if token.len() < 3
    || token
      .chars()
      .all(|character| character.is_ascii_digit() || character == '-')
  {
    return;
  }
  if stop_words.iter().any(|stop_word| stop_word == &token) {
    return;
  }
  if !keywords.iter().any(|keyword| keyword == token) {
    keywords.push(token.to_string());
  }
}

#[derive(Debug, PartialEq, Eq)]
struct ConflictValueMarker {
  kind: &'static str,
  value: String,
}

fn current_value_conflicts(candidate_text: &str, fact_text: &str) -> bool {
  let (Some(candidate_marker), Some(fact_marker)) = (
    conflict_value_marker(candidate_text),
    conflict_value_marker(fact_text),
  ) else {
    return false;
  };
  candidate_marker.kind == fact_marker.kind && candidate_marker.value != fact_marker.value
}

fn conflict_value_marker(text: &str) -> Option<ConflictValueMarker> {
  let lower = text.to_lowercase();
  let anchors: &[(&str, &[&str])] = &[
    (
      "address",
      &[
        "current address is",
        "current address:",
        "my address is",
        "address:",
        "現住所は",
        "現在の住所は",
        "住所は",
        "住所:",
      ],
    ),
    (
      "provider",
      &[
        "current provider is",
        "provider:",
        "insurance provider is",
        "insurer is",
        "保険者は",
        "保険会社は",
        "契約先は",
      ],
    ),
    (
      "employer",
      &[
        "current employer is",
        "employer:",
        "workplace is",
        "勤務先は",
        "現在の勤務先は",
        "職場は",
        "会社は",
      ],
    ),
    (
      "contact",
      &[
        "phone is",
        "phone:",
        "email is",
        "email:",
        "電話番号は",
        "メールアドレスは",
      ],
    ),
  ];

  for &(kind, kind_anchors) in anchors {
    for &anchor in kind_anchors {
      if let Some(index) = lower.find(anchor) {
        let raw_value = &lower[index + anchor.len()..];
        if let Some(value) = normalize_conflict_value(raw_value) {
          return Some(ConflictValueMarker { kind, value });
        }
      }
    }
  }
  None
}

fn normalize_conflict_value(raw_value: &str) -> Option<String> {
  let value = raw_value
    .split(|character| matches!(character, '.' | '。' | '\n' | '\r' | ';' | '；'))
    .next()
    .unwrap_or_default()
    .trim_matches(|character: char| {
      character.is_whitespace()
        || matches!(character, ':' | '：' | '-' | '=' | ',' | '、' | '"' | '\'')
    })
    .trim();
  let mut normalized = value.to_string();
  for prefix in ["the ", "a ", "an "] {
    if let Some(stripped) = normalized.strip_prefix(prefix) {
      normalized = stripped.trim().to_string();
    }
  }
  for suffix in ["です", "である", "になります"] {
    if let Some(stripped) = normalized.strip_suffix(suffix) {
      normalized = stripped.trim().to_string();
    }
  }
  if normalized.chars().count() < 3 {
    return None;
  }
  Some(normalized.chars().take(120).collect())
}

fn looks_like_contact_point(text: &str) -> bool {
  let has_email_shape = text.contains('@') && text.contains('.');
  let digit_count = text
    .chars()
    .filter(|character| character.is_ascii_digit())
    .count();
  has_email_shape || digit_count >= 9
}

fn extract_yyyy_mm_dd(text: &str) -> Option<String> {
  for token in
    text.split(|character: char| character.is_whitespace() || character == '.' || character == ',')
  {
    let candidate =
      token.trim_matches(|character: char| !character.is_ascii_digit() && character != '-');
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
    if json_array_contains_string(
      candidate.get("sourceIds").unwrap_or(&Value::Null),
      source_id,
    ) && matches!(
      status.as_str(),
      "new" | "needs_user_detail" | "blocked_sensitive"
    ) {
      candidate["status"] = Value::String("archived".to_string());
      candidate["reviewedAt"] = Value::String(now.to_string());
      affected += 1;
    }
  }
  affected
}

fn mark_source_facts_needing_review(vault: &mut Value, source_id: &str, now: &str) -> Vec<String> {
  mark_source_facts_needing_review_with_reason(vault, source_id, now, "source_deleted")
}

fn mark_source_facts_needing_review_with_reason(
  vault: &mut Value,
  source_id: &str,
  now: &str,
  reason: &str,
) -> Vec<String> {
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
      fact["reviewReason"] = Value::String(reason.to_string());
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
    .filter(|fact| {
      json_array_contains_string(fact.get("sourceIds").unwrap_or(&Value::Null), source_id)
    })
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

fn invalidate_context_packs_for_client_policy(vault: &mut Value, client_id: &str) -> usize {
  let request_ids = value_array(vault, "contextPackRequests")
    .into_iter()
    .filter(|request| str_field(request, "clientId") == client_id)
    .map(|request| str_field(request, "id"))
    .filter(|request_id| !request_id.is_empty())
    .collect::<HashSet<_>>();
  if request_ids.is_empty() {
    return 0;
  }

  let mut invalidated_request_ids = HashSet::new();
  let Some(packs) = vault.get_mut("contextPacks").and_then(Value::as_array_mut) else {
    return 0;
  };
  let mut affected = 0;
  for pack in packs {
    let request_id = optional_str_field(pack, "requestId").unwrap_or_default();
    if request_ids.contains(&request_id) && str_field(pack, "confirmationStatus") != "cancelled" {
      pack["confirmationStatus"] = Value::String("cancelled".to_string());
      if let Some(object) = pack.as_object_mut() {
        object.remove("confirmedAt");
      }
      let mut warnings = pack
        .get("warnings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
      warnings.insert(
        0,
        json!({
          "kind": "policy_limited",
          "message": "AI接続ポリシーが更新されたため、このContext Packは無効化されました。新しいContext Packを作成してください。",
          "relatedIds": [client_id]
        }),
      );
      pack["warnings"] = Value::Array(warnings);
      invalidated_request_ids.insert(request_id);
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

fn connection_standing_delivery_enabled(vault: &Value, client_id: &str) -> bool {
  value_array(vault, "accessPolicies")
    .into_iter()
    .find(|policy| str_field(policy, "clientId") == client_id)
    .and_then(|policy| {
      policy
        .get("standingDeliveryEnabled")
        .and_then(Value::as_bool)
    })
    .unwrap_or(false) // absent = legacy/strict; opt-in is explicit
}

fn policy_ceiling_for_client(vault: &Value, client_id: &str) -> String {
  let value = value_array(vault, "accessPolicies")
    .into_iter()
    .find(|policy| str_field(policy, "clientId") == client_id)
    .map(|policy| str_field(policy, "sensitivityCeiling"))
    .unwrap_or_default();
  policy_sensitivity_value(&value, "private_consequential")
}

fn policy_requires_approval_above_for_client(vault: &Value, client_id: &str) -> String {
  let value = value_array(vault, "accessPolicies")
    .into_iter()
    .find(|policy| str_field(policy, "clientId") == client_id)
    .map(|policy| str_field(policy, "requiresApprovalAbove"))
    .unwrap_or_default();
  policy_sensitivity_value(&value, "personal")
}

fn policy_sensitivity_value(value: &str, missing_default: &str) -> String {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return missing_default.to_string();
  }
  sensitivity_tier(trimmed).unwrap_or("public").to_string()
}

fn lower_sensitivity_tier(left: &str, right: &str) -> String {
  if sensitivity_rank(left) <= sensitivity_rank(right) {
    left.to_string()
  } else {
    right.to_string()
  }
}

fn policy_domain_allowlist_for_client(vault: &Value, client_id: &str) -> Vec<String> {
  value_array(vault, "accessPolicies")
    .into_iter()
    .find(|policy| str_field(policy, "clientId") == client_id)
    .map(|policy| normalize_existing_policy_domain_allowlist(policy.get("domainAllowlist")))
    .unwrap_or_else(cautious_life_domains)
}

fn normalize_existing_policy_domain_allowlist(value: Option<&Value>) -> Vec<String> {
  let Some(domains) = value.and_then(Value::as_array) else {
    return cautious_life_domains();
  };
  let mut normalized = Vec::new();
  for domain in domains {
    let Some(domain) = domain.as_str() else {
      return cautious_life_domains();
    };
    let Ok(domain) = life_domain(domain.trim()) else {
      return cautious_life_domains();
    };
    if !normalized.iter().any(|existing| existing == domain) {
      normalized.push(domain.to_string());
    }
  }
  if normalized.is_empty() {
    return cautious_life_domains();
  }
  normalized
}

fn normalize_policy_domain_allowlist(domains: Vec<String>) -> Result<Vec<String>, String> {
  let mut normalized = Vec::new();
  for domain in domains {
    let domain = life_domain(domain.trim())?.to_string();
    if !normalized.iter().any(|existing| existing == &domain) {
      normalized.push(domain);
    }
  }
  if normalized.is_empty() {
    return Err("domainAllowlist must include at least one life domain.".to_string());
  }
  Ok(normalized)
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
  let Some(sessions) = vault
    .get_mut("connectorSessions")
    .and_then(Value::as_array_mut)
  else {
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

fn context_pack_receipt_metadata(
  vault: &Value,
  pack: &Value,
  channel: Option<&str>,
  status: Option<&str>,
  ttl_seconds: Option<u64>,
  relay_expires_at: Option<u64>,
  message: Option<&str>,
) -> Value {
  let request = optional_str_field(pack, "requestId")
    .and_then(|request_id| find_vault_item_by_id(vault, "contextPackRequests", &request_id));
  let items = pack
    .get("items")
    .and_then(Value::as_array)
    .map(Vec::len)
    .unwrap_or(0);
  let snippets = pack
    .get("sourceSnippets")
    .and_then(Value::as_array)
    .map(Vec::len)
    .unwrap_or(0);
  let excluded = pack
    .get("excludedItems")
    .and_then(Value::as_array)
    .map(Vec::len)
    .unwrap_or(0);
  let warnings = pack
    .get("warnings")
    .and_then(Value::as_array)
    .map(Vec::len)
    .unwrap_or(0);
  json!({
    "requestId": optional_str_field(pack, "requestId"),
    "packId": str_field(pack, "id"),
    "clientId": request.as_ref().map(|request| str_field(request, "clientId")),
    "clientName": request.as_ref().map(|request| str_field(request, "clientName")),
    "requestStatus": request.as_ref().map(|request| str_field(request, "status")),
    "taskDomain": str_field(pack, "taskDomain"),
    "itemCount": items,
    "sourceSnippetCount": snippets,
    "excludedCount": excluded,
    "warningCount": warnings,
    "maxSensitivityIncluded": str_field(pack, "maxSensitivityIncluded"),
    "confirmationStatus": str_field(pack, "confirmationStatus"),
    "expiresAt": optional_str_field(pack, "expiresAt")
      .or_else(|| request.as_ref().and_then(|request| optional_str_field(request, "expiresAt"))),
    "deliveryChannel": channel,
    "deliveryStatus": status,
    "ttlSeconds": ttl_seconds,
    "relayExpiresAt": relay_expires_at,
    "message": message,
    "trustBoundary": "ContextPack only",
    "bodyStoredInAudit": false,
    "rawSourceIncluded": false,
    "unapprovedCandidateIncluded": false,
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
  let mut bytes = [0u8; 18];
  getrandom::getrandom(&mut bytes)
    .expect("OS randomness is required to generate Vault identifiers");
  format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn now_iso() -> String {
  Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn minutes_from_now(minutes: i64) -> String {
  (Utc::now() + chrono::Duration::minutes(minutes)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn days_from_now(days: i64) -> String {
  (Utc::now() + chrono::Duration::days(days)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn stable_hash(text: &str) -> String {
  let mut hash = 2166136261u32;
  for byte in text.as_bytes() {
    hash ^= u32::from(*byte);
    hash = hash.wrapping_mul(16777619);
  }
  format!("hash_{hash:x}")
}

fn system_time_seconds(time: SystemTime) -> u64 {
  time
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs())
    .unwrap_or_default()
}

fn show_control_center(app: &AppHandle) -> Result<(), String> {
  app
    .set_activation_policy(ActivationPolicy::Regular)
    .map_err(|error| format!("failed to activate app: {error}"))?;
  let window = app
    .get_webview_window(MAIN_WINDOW_LABEL)
    .ok_or_else(|| "Control Center window is not available".to_string())?;
  window
    .show()
    .map_err(|error| format!("failed to show Control Center: {error}"))?;
  let _ = window.unminimize();
  window
    .set_focus()
    .map_err(|error| format!("failed to focus Control Center: {error}"))?;
  Ok(())
}

fn handle_tray_menu_event(app: &AppHandle, menu_id: &str) {
  match menu_id {
    TRAY_MENU_OPEN_ID => {
      let _ = show_control_center(app);
    }
    TRAY_MENU_QUIT_ID => {
      app.exit(0);
    }
    _ => {}
  }
}

fn configure_background_tray(app: &mut App) -> tauri::Result<()> {
  let open = MenuItemBuilder::with_id(TRAY_MENU_OPEN_ID, "Open Control Center").build(app)?;
  let quit = MenuItemBuilder::with_id(TRAY_MENU_QUIT_ID, "Quit Life Context Vault").build(app)?;
  let menu = MenuBuilder::new(app)
    .item(&open)
    .separator()
    .item(&quit)
    .build()?;

  let mut tray = TrayIconBuilder::with_id(TRAY_ID)
    .menu(&menu)
    .tooltip("Life Context Vault")
    .show_menu_on_left_click(true)
    .on_menu_event(|app, event| {
      handle_tray_menu_event(app, event.id().as_ref());
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        let _ = show_control_center(tray.app_handle());
      }
    });

  if let Some(icon) = app.default_window_icon() {
    tray = tray.icon(icon.clone());
  }

  tray.build(app)?;
  Ok(())
}

fn claude_desktop_config_path() -> Result<PathBuf, String> {
  #[cfg(target_os = "macos")]
  {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    return Ok(
      PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude_desktop_config.json"),
    );
  }

  #[cfg(target_os = "windows")]
  {
    let appdata = env::var("APPDATA").map_err(|_| "APPDATA is not set".to_string())?;
    return Ok(
      PathBuf::from(appdata)
        .join("Claude")
        .join("claude_desktop_config.json"),
    );
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

#[cfg(not(target_os = "macos"))]
fn build_non_macos_key_env() -> (std::collections::HashMap<String, String>, Option<String>) {
  use std::collections::HashMap;
  if let Ok(key_file) = std::env::var("LCV_VAULT_KEY_FILE") {
    let mut env = HashMap::new();
    env.insert("LCV_VAULT_KEY_FILE".to_string(), key_file);
    (env, None)
  } else if std::env::var("LCV_VAULT_DB_KEY").is_ok() {
    let warning = "LCV_VAULT_DB_KEY は設定ファイルに書き込まれませんでした。claude_desktop_config.json の env ブロックに手動で追加してください。".to_string();
    (HashMap::new(), Some(warning))
  } else {
    (HashMap::new(), None)
  }
}

fn life_context_claude_server_config(app: &AppHandle) -> Result<(Value, Option<String>), String> {
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

fn life_context_claude_server_config_for_paths(
  command: PathBuf,
  vault_path: PathBuf,
) -> (Value, Option<String>) {
  #[cfg(not(target_os = "macos"))]
  {
    let (extra_env, warning) = build_non_macos_key_env();
    let mut env = serde_json::Map::new();
    env.insert(
      "LCV_VAULT_DB_PATH".to_string(),
      Value::String(vault_path.display().to_string()),
    );
    for (k, v) in extra_env {
      env.insert(k, Value::String(v));
    }
    let config = json!({
      "type": "stdio",
      "command": command.display().to_string(),
      "env": env
    });
    (config, warning)
  }
  #[cfg(target_os = "macos")]
  {
    let config = json!({
      "type": "stdio",
      "command": command.display().to_string(),
      "env": {
        "LCV_VAULT_DB_PATH": vault_path.display().to_string()
      }
    });
    (config, None)
  }
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
  let (server_config, key_warning) = life_context_claude_server_config(&app)?;
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
      warning: key_warning,
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
    warning: key_warning,
  })
}

#[tauri::command]
fn claude_desktop_config_template(app: AppHandle) -> Result<String, String> {
  let (server_config, _) = life_context_claude_server_config(&app)?;
  let config = json!({
    "mcpServers": {
      "life-context-vault": server_config
    }
  });
  serde_json::to_string_pretty(&config)
    .map_err(|error| format!("failed to serialize Claude Desktop config: {error}"))
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

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_login_item_command_for_path(program_path: &PathBuf) -> String {
  let program_path = program_path.display().to_string().replace('"', "");
  format!("@echo off\r\nstart \"\" \"{program_path}\"\r\n")
}

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
fn desktop_entry_escape(value: &str) -> String {
  value
    .replace('\\', "\\\\")
    .replace('"', "\\\"")
    .replace('$', "\\$")
    .replace('`', "\\`")
}

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
fn linux_login_item_desktop_for_path(program_path: &PathBuf) -> String {
  let program_path = desktop_entry_escape(&program_path.display().to_string());
  format!(
    r#"[Desktop Entry]
Type=Application
Name=Life Context Vault
Comment=Start Life Context Vault Control Center at login
Exec="{program_path}"
Terminal=false
X-GNOME-Autostart-enabled=true
"#
  )
}

fn login_item_payload_for_path(label: &str, program_path: &PathBuf) -> String {
  #[cfg(target_os = "macos")]
  {
    return login_item_plist_for_path(label, program_path);
  }

  #[cfg(target_os = "windows")]
  {
    let _ = label;
    return windows_login_item_command_for_path(program_path);
  }

  #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
  {
    let _ = label;
    linux_login_item_desktop_for_path(program_path)
  }
}

fn login_item_plist_path() -> Result<PathBuf, String> {
  #[cfg(target_os = "macos")]
  {
    let home = env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    return Ok(
      PathBuf::from(home)
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LOGIN_ITEM_LABEL}.plist")),
    );
  }

  #[cfg(target_os = "windows")]
  {
    let appdata = env::var("APPDATA").map_err(|_| "APPDATA is not set".to_string())?;
    return Ok(
      PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup")
        .join("Life Context Vault.cmd"),
    );
  }

  #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
  {
    let base = env::var("XDG_CONFIG_HOME")
      .map(PathBuf::from)
      .or_else(|_| env::var("HOME").map(|home| PathBuf::from(home).join(".config")))
      .map_err(|_| "Neither XDG_CONFIG_HOME nor HOME is set".to_string())?;
    Ok(
      base
        .join("autostart")
        .join("dev.life-context-vault.desktop"),
    )
  }
}

fn current_executable_path() -> Result<PathBuf, String> {
  env::current_exe().map_err(|error| format!("failed to resolve current app executable: {error}"))
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
          let expected_payload = login_item_payload_for_path(LOGIN_ITEM_LABEL, &program_path);
          if raw != expected_payload {
            last_error = Some(
              "Startup item exists but points to a different app build; reinstall to update it."
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
    let startup_path = match login_item_plist_path() {
      Ok(path) => path,
      Err(error) => {
        return LoginItemStatus {
          supported: false,
          enabled: false,
          plist_path: None,
          program_path: current_executable_path()
            .ok()
            .map(|path| path.display().to_string()),
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
          enabled: startup_path.exists(),
          plist_path: Some(startup_path.display().to_string()),
          program_path: None,
          label: LOGIN_ITEM_LABEL.to_string(),
          backup_path: backup_path.map(|path| path.display().to_string()),
          last_error: Some(error),
        };
      }
    };
    let mut last_error = None;
    let enabled = startup_path.exists();
    if enabled {
      match fs::read_to_string(&startup_path) {
        Ok(raw) => {
          let expected_payload = login_item_payload_for_path(LOGIN_ITEM_LABEL, &program_path);
          if raw != expected_payload {
            last_error = Some(
              "Startup item exists but points to a different app build; reinstall to update it."
                .to_string(),
            );
          }
        }
        Err(error) => {
          last_error = Some(format!("failed to inspect startup item: {error}"));
        }
      }
    }
    LoginItemStatus {
      supported: true,
      enabled,
      plist_path: Some(startup_path.display().to_string()),
      program_path: Some(program_path.display().to_string()),
      label: LOGIN_ITEM_LABEL.to_string(),
      backup_path: backup_path.map(|path| path.display().to_string()),
      last_error,
    }
  }
}

#[tauri::command]
fn login_item_status() -> Result<LoginItemStatus, String> {
  Ok(login_item_status_with_backup(None))
}

#[tauri::command]
fn install_login_item() -> Result<LoginItemStatus, String> {
  let startup_path = login_item_plist_path()?;
  let program_path = current_executable_path()?;
  let payload = login_item_payload_for_path(LOGIN_ITEM_LABEL, &program_path);

  if startup_path.exists() {
    let existing = fs::read_to_string(&startup_path)
      .map_err(|error| format!("failed to read startup item: {error}"))?;
    if existing == payload {
      return Ok(login_item_status_with_backup(None));
    }
  }

  if let Some(parent) = startup_path.parent() {
    fs::create_dir_all(parent)
      .map_err(|error| format!("failed to create startup item directory: {error}"))?;
  }

  let backup_path = if startup_path.exists() {
    let file_name = startup_path
      .file_name()
      .and_then(|name| name.to_str())
      .unwrap_or("startup-item");
    let backup = startup_path.with_file_name(format!(
      "{file_name}.lcv-backup-{}",
      system_time_seconds(SystemTime::now())
    ));
    fs::copy(&startup_path, &backup)
      .map_err(|error| format!("failed to back up startup item: {error}"))?;
    Some(backup)
  } else {
    None
  };

  let file_name = startup_path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("startup-item");
  let temp_path = startup_path.with_file_name(format!("{file_name}.lcv.tmp"));
  fs::write(&temp_path, payload)
    .map_err(|error| format!("failed to write startup item temp file: {error}"))?;
  #[cfg(target_os = "windows")]
  {
    if startup_path.exists() {
      fs::remove_file(&startup_path)
        .map_err(|error| format!("failed to replace startup item: {error}"))?;
    }
  }
  fs::rename(&temp_path, &startup_path)
    .map_err(|error| format!("failed to install startup item: {error}"))?;
  Ok(login_item_status_with_backup(backup_path))
}

#[tauri::command]
fn uninstall_login_item() -> Result<LoginItemStatus, String> {
  let startup_path = login_item_plist_path()?;
  if startup_path.exists() {
    fs::remove_file(&startup_path)
      .map_err(|error| format!("failed to remove startup item: {error}"))?;
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
  save_vault_state_payload(&mut connection, &payload, expected_updated_at.as_deref())
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
fn extract_native_document_text(
  file_name: String,
  mime_type: String,
  content_base64: String,
  ocr_command: Option<String>,
  ocr_args: Option<String>,
  ocr_timeout_seconds: Option<u64>,
  legacy_office_command: Option<String>,
  legacy_office_args: Option<String>,
  legacy_office_timeout_seconds: Option<u64>,
) -> Result<NativeDocumentExtractionResult, String> {
  let ocr_config = ocr_command_config_from_input(
    ocr_command.as_deref(),
    ocr_args.as_deref(),
    ocr_timeout_seconds,
  );
  let legacy_office_config = legacy_office_command_config_from_input(
    legacy_office_command.as_deref(),
    legacy_office_args.as_deref(),
    legacy_office_timeout_seconds,
  );
  extract_native_document_text_from_base64_with_configs(
    &file_name,
    &mime_type,
    &content_base64,
    ocr_config,
    legacy_office_config,
  )
}

#[tauri::command]
fn native_document_extraction_capabilities() -> NativeDocumentExtractionCapabilities {
  let ocr_config = ocr_command_config_from_env();
  let legacy_office_config = legacy_office_config_from_env();
  NativeDocumentExtractionCapabilities {
    native_document_extraction: true,
    ocr_extraction: ocr_config.is_some(),
    ocr_provider_label: ocr_config.map(|config| config.label()),
    legacy_office_conversion: legacy_office_config.is_some(),
    legacy_office_provider_label: legacy_office_config.map(|config| config.label()),
  }
}

#[tauri::command]
fn detect_ocr_provider_candidates() -> Vec<OcrProviderCandidate> {
  detect_ocr_provider_candidates_internal()
}

#[tauri::command]
fn detect_legacy_office_provider_candidates() -> Vec<OcrProviderCandidate> {
  detect_legacy_office_provider_candidates_internal()
}

#[tauri::command]
fn approve_native_candidate(
  app: AppHandle,
  candidate_id: String,
  edited_text: Option<String>,
  supersede_fact_ids: Vec<String>,
) -> Result<NativeCandidateReviewResult, String> {
  let path = vault_db_path(&app)?;
  let result = approve_candidate_with_options_at_path(
    &path,
    &candidate_id,
    edited_text.as_deref(),
    &supersede_fact_ids,
  )?;
  Ok(NativeCandidateReviewResult {
    payload: result.payload,
    updated_at: result.updated_at,
    candidate_id: result.candidate_id,
    status: result.status,
    fact_id: result.fact_id,
    superseded_fact_ids: result.superseded_fact_ids,
    invalidated_pack_count: result.invalidated_pack_count,
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
    superseded_fact_ids: result.superseded_fact_ids,
    invalidated_pack_count: result.invalidated_pack_count,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn update_native_access_policy(
  app: AppHandle,
  client_id: String,
  sensitivity_ceiling: Option<String>,
  requires_approval_above: Option<String>,
  domain_allowlist: Option<Vec<String>>,
  passive_capture_allowed: Option<bool>,
) -> Result<NativeVaultSettingsUpdateResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_access_policy_at_path(
    &path,
    &client_id,
    sensitivity_ceiling.as_deref(),
    requires_approval_above.as_deref(),
    domain_allowlist,
    passive_capture_allowed,
  )?;
  Ok(NativeVaultSettingsUpdateResult {
    payload: result.payload,
    updated_at: result.updated_at,
    generated_by: "native_vault_core".to_string(),
  })
}

#[tauri::command]
fn set_connection_standing_delivery(
  app: AppHandle,
  client_id: String,
  enabled: bool,
) -> Result<NativeVaultSettingsUpdateResult, String> {
  let path = vault_db_path(&app)?;
  set_connection_standing_delivery_at_path(&path, &client_id, enabled)?;
  let connection = open_vault_db_at_path(&path)?;
  let vault = load_vault_json_from_connection(&connection)?;
  let payload = serde_json::to_string(&vault).map_err(|e| e.to_string())?;
  let updated_at = vault
    .get("updatedAt")
    .and_then(|v| v.as_str())
    .map(|s| s.to_string());
  Ok(NativeVaultSettingsUpdateResult {
    payload,
    updated_at,
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
fn update_native_source_body(
  app: AppHandle,
  source_id: String,
  body: String,
) -> Result<NativeSourceBodyResult, String> {
  let path = vault_db_path(&app)?;
  let result = update_source_body_at_path(&path, &source_id, &body)?;
  Ok(NativeSourceBodyResult {
    payload: result.payload,
    updated_at: result.updated_at,
    source_id: result.source_id,
    candidate_ids: result.candidate_ids,
    affected_candidate_count: result.affected_candidate_count,
    affected_fact_count: result.affected_fact_count,
    invalidated_pack_count: result.invalidated_pack_count,
    detected_sensitivity: result.detected_sensitivity,
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

/// Persist the delivery-notifications opt-in flag in `runtimePreferences`.
/// When `enabled` is true the caller is responsible for requesting OS
/// permission from the TS side (tauri-plugin-notification's
/// `requestPermission()`).  This command only persists the user intent.
#[tauri::command]
fn set_delivery_notifications_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
  let path = vault_db_path(&app)?;
  let mut prefs = get_runtime_preferences_at_path(&path).unwrap_or_else(|_| json!({}));
  prefs["deliveryNotificationsEnabled"] = json!(enabled);
  save_runtime_preferences_at_path(&path, &prefs)?;
  Ok(enabled)
}

pub fn run() {
  tauri::Builder::default()
    .on_window_event(|window, event| {
      let decision = match event {
        WindowEvent::CloseRequested { .. } => {
          window_lifecycle_decision(WindowLifecycleEventKind::CloseRequested)
        }
        WindowEvent::Destroyed => window_lifecycle_decision(WindowLifecycleEventKind::Destroyed),
        _ => window_lifecycle_decision(WindowLifecycleEventKind::Other),
      };
      match decision {
        WindowLifecycleDecision::HideToBackground => {
          if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
          }
          let _ = window.hide();
          let _ = window
            .app_handle()
            .set_activation_policy(ActivationPolicy::Accessory);
        }
        WindowLifecycleDecision::Ignore => {}
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
      extract_native_document_text,
      native_document_extraction_capabilities,
      detect_ocr_provider_candidates,
      detect_legacy_office_provider_candidates,
      add_native_source_with_candidates,
      approve_native_candidate,
      update_native_candidate_status,
      update_native_access_policy,
      set_connection_standing_delivery,
      update_native_source_lifecycle,
      update_native_source_metadata,
      update_native_source_body,
      update_native_fact_lifecycle,
      update_native_fact_metadata,
      install_claude_desktop_config,
      claude_desktop_config_template,
      login_item_status,
      install_login_item,
      uninstall_login_item,
      export_native_encrypted_backup,
      import_native_encrypted_backup,
      add_native_source_pending_runtime,
      run_local_backup_now,
      recover_vault_with_recovery_key,
      write_recovery_envelope,
      get_native_runtime_preferences,
      save_native_runtime_preferences,
      set_delivery_notifications_enabled
    ])
    .setup(|app| {
      app.set_activation_policy(ActivationPolicy::Regular);
      configure_background_tray(app)?;
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
      let window = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, url)
        .title("Life Context Vault")
        .inner_size(1200.0, 820.0)
        .min_inner_size(960.0, 640.0)
        .resizable(true)
        .visible(true)
        .build()?;
      window.center()?;
      window.show()?;
      window.set_focus()?;
      eprintln!("Life Context Vault main window is visible");

      app.handle().plugin(tauri_plugin_notification::init())?;
      let poller_handle = app.handle().clone();
      std::thread::spawn(move || {
        delivery_notification_poller(poller_handle);
      });
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

// ── Task 7: Zero-touch gate helpers ──────────────────────────────────────────

/// Returns true when a pack item is eligible for zero-touch delivery:
/// - it has been classified (`sensitivityClassified = true`)
/// - its confidence meets or exceeds `bar`
/// - its sensitivity tier is at or below `threshold`
fn zero_touch_eligible(item: &Value, threshold: &str, bar: &str) -> bool {
  let classified = item
    .get("sensitivityClassified")
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let conf = item
    .get("sensitivityConfidence")
    .and_then(Value::as_str)
    .unwrap_or("low");
  let tier = item
    .get("sensitivity")
    .and_then(Value::as_str)
    .unwrap_or("secret_never_send");
  classified
    && confidence_rank(conf) >= confidence_rank(bar)
    && sensitivity_rank(tier) <= sensitivity_rank(threshold)
}

/// Returns the `zeroTouchConfidenceBar` for a given client's access policy,
/// defaulting to `"medium"` when absent or unrecognised.
fn policy_zero_touch_confidence_bar_for_client(vault: &Value, client_id: &str) -> String {
  let value = value_array(vault, "accessPolicies")
    .into_iter()
    .find(|policy| str_field(policy, "clientId") == client_id)
    .map(|policy| str_field(policy, "zeroTouchConfidenceBar"))
    .unwrap_or_default();
  let trimmed = value.trim();
  match trimmed {
    "low" | "medium" | "high" => trimmed.to_string(),
    _ => "medium".to_string(),
  }
}

// ── Task 7: Durable classifier migration ─────────────────────────────────────

const CLASSIFIER_MIGRATION_VERSION: u32 = 1;

/// On first vault open after the classifier is deployed, back-fills
/// `sensitivityClassified` and `sensitivityConfidence` on any Fact that was
/// approved before the classifier existed.  Sets `classifierMigrationVersion`
/// in the vault JSON so subsequent opens are no-ops.
fn migrate_classification_if_needed(connection: &mut Connection) -> Result<(), String> {
  let mut vault = load_vault_json_from_connection(connection)?;
  let current_version = vault
    .get("classifierMigrationVersion")
    .and_then(Value::as_u64)
    .unwrap_or(0) as u32;
  if current_version >= CLASSIFIER_MIGRATION_VERSION {
    return Ok(());
  }
  // Back-fill classification fields only on facts where sensitivityClassified is ABSENT
  // from the persisted JSON (truly legacy). Facts that have an explicit value — even
  // false — were deliberately set (e.g. after a manual sensitivity override) and must
  // not be silently promoted.
  if let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) {
    for fact in facts.iter_mut() {
      let fact_text = str_field(fact, "factText");
      if fact_text.is_empty() {
        continue;
      }
      let classification_key_present = fact.get("sensitivityClassified").is_some();
      if !classification_key_present {
        let result = classify_sensitivity(&fact_text);
        fact["sensitivityClassified"] = Value::Bool(result.classified);
        fact["sensitivityConfidence"] = Value::String(result.confidence.to_string());
        // Preserve the user-reviewed sensitivity tier — only fill classification metadata.
      }
    }
  }
  vault["classifierMigrationVersion"] = json!(CLASSIFIER_MIGRATION_VERSION);
  save_vault_json_with_projection(connection, &vault)?;
  Ok(())
}

// ─── Delivery notification selector (P2 OS notifications) ────────────────────

/// Counts and client names only — NO fact/source/candidate text ever enters this struct.
#[derive(Debug, PartialEq)]
pub struct DeliveryNotice {
  /// Per-client human-readable name + count of zero-touch deliveries.
  pub per_client: Vec<(String, usize)>,
  /// Total zero-touch deliveries across all clients.
  pub total: usize,
  /// The `id` of the newest qualifying audit event (used as the next `last_seen_id`).
  pub newest_event_id: String,
}

/// Pure, content-free selector for zero-touch delivery notifications.
///
/// Scans `events` (an ordered slice of `auditEvents` JSON values, oldest-first) for
/// `context_pack_delivered` events that:
///   - have `metadata.zeroTouch == true` (zero-touch / confirmation-not-required deliveries), and
///   - have an `id` that comes AFTER `last_seen_id` in the slice order.
///
/// Returns `None` when:
///   - `opted_in` is `false`, OR
///   - there are no qualifying events after `last_seen_id`.
///
/// `DeliveryNotice.per_client` is sorted by client name for determinism.
///
/// ASSUMPTION: A `context_pack_delivered` event does not yet exist in the codebase.
/// Task 3 will add it with `metadata.zeroTouch` (bool) and `metadata.clientName` (string).
/// This function is designed against that expected schema.  When current audit events
/// (`context_pack_generated`, `context_pack_confirmed`, …) are scanned, all will simply
/// produce zero matches because none carry `eventType == "context_pack_delivered"`.
pub fn select_delivery_notification(
  events: &[serde_json::Value],
  last_seen_id: Option<&str>,
  opted_in: bool,
) -> Option<DeliveryNotice> {
  if !opted_in {
    return None;
  }

  // Skip events up-to-and-including last_seen_id.
  let skip_before = last_seen_id.map(|seen| {
    events
      .iter()
      .position(|e| e.get("id").and_then(Value::as_str) == Some(seen))
      .map(|pos| pos + 1) // start AFTER the seen event
      .unwrap_or(events.len()) // unknown id → treat all as already seen
  });
  let new_events = &events[skip_before.unwrap_or(0)..];

  // Collect zero-touch deliveries by client name.
  let mut per_client: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
  let mut newest_event_id = String::new();

  for event in new_events {
    let event_type = event.get("eventType").and_then(Value::as_str).unwrap_or("");
    if event_type != "context_pack_delivered" {
      continue;
    }
    let metadata = match event.get("metadata") {
      Some(m) => m,
      None => continue,
    };
    let zero_touch = metadata
      .get("zeroTouch")
      .and_then(Value::as_bool)
      .unwrap_or(false);
    if !zero_touch {
      continue;
    }
    // Content-free: we only read the human display name, never any fact/source/candidate text.
    let client_name = metadata
      .get("clientName")
      .and_then(Value::as_str)
      .unwrap_or("Unknown client")
      .to_string();
    *per_client.entry(client_name).or_insert(0) += 1;
    if let Some(id) = event.get("id").and_then(Value::as_str) {
      newest_event_id = id.to_string();
    }
  }

  if per_client.is_empty() {
    return None;
  }

  let mut per_client_vec: Vec<(String, usize)> = per_client.into_iter().collect();
  per_client_vec.sort_by(|a, b| a.0.cmp(&b.0));
  let total = per_client_vec.iter().map(|(_, c)| c).sum();

  Some(DeliveryNotice {
    per_client: per_client_vec,
    total,
    newest_event_id,
  })
}

// ─── Delivery notification background poller (P2 OS notifications) ───────────

const DELIVERY_NOTIFICATION_LAST_SEEN_KEY: &str = "delivery_notification_last_seen";

fn delivery_notification_poller(app: AppHandle) {
  loop {
    std::thread::sleep(std::time::Duration::from_secs(15));
    if let Err(e) = delivery_notification_poll_once(&app) {
      eprintln!("[delivery-poller] error: {e}");
    }
  }
}

fn delivery_notification_poll_once(app: &AppHandle) -> Result<(), String> {
  let path = vault_db_path(app)?;
  let connection = open_vault_db_at_path(&path)?;
  let vault = load_vault_json_from_connection(&connection)?;
  let prefs = get_runtime_preferences_at_path(&path).unwrap_or_else(|_| json!({}));
  let opted_in = prefs
    .get("deliveryNotificationsEnabled")
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let last_seen: Option<String> = connection
    .query_row(
      "SELECT value FROM projection_state WHERE key = ?1",
      rusqlite::params![DELIVERY_NOTIFICATION_LAST_SEEN_KEY],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("failed to read last-seen marker: {e}"))?;
  let events: Vec<Value> = vault
    .get("auditEvents")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default();
  let Some(notice) = select_delivery_notification(&events, last_seen.as_deref(), opted_in) else {
    return Ok(());
  };
  let body: String = if notice.per_client.len() == 1 {
    let (name, count) = &notice.per_client[0];
    format!("{name} に {count} 件の文脈を渡しました")
  } else {
    notice
      .per_client
      .iter()
      .map(|(name, count)| format!("{name} に {count} 件"))
      .collect::<Vec<_>>()
      .join("、")
  };
  if let Err(e) = app
    .notification()
    .builder()
    .title("Life Context Vault")
    .body(body)
    .show()
  {
    eprintln!("[delivery-poller] notification send failed: {e}");
  }
  connection
    .execute(
      "INSERT INTO projection_state (key, value, updated_at)
       VALUES (?1, ?2, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP",
      rusqlite::params![DELIVERY_NOTIFICATION_LAST_SEEN_KEY, notice.newest_event_id],
    )
    .map_err(|e| format!("failed to persist last-seen marker: {e}"))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::Instant;

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
  fn recovery_sidecar_round_trips_vault_key_at_path() {
    use_test_vault_key();
    let path = temp_vault_path("recovery-io");
    {
      let _connection = open_vault_db_at_path(&path).expect("open vault");
    }
    let recovery_key = "a1b2c3d4-e5f6a7b8-c9d0e1f2-a3b4c5d6-e7f8a9b0";
    write_recovery_envelope_at_path(&path, &recovery_key).expect("write envelope");
    let recovered = recover_vault_key_at_path(&path, &recovery_key).expect("recover key");
    let expected = std::env::var("LCV_VAULT_DB_KEY").expect("test key set");
    assert_eq!(recovered, expected);
    let _ = fs::remove_file(recovery_sidecar_path(&path));
    remove_temp_vault(&path);
  }

  #[test]
  fn encrypted_backup_round_trips_through_vault_db_at_path() {
    use_test_vault_key();
    let passphrase = "Correct-Horse-42!";
    let source_path = temp_vault_path("backup-source");
    let restore_path = temp_vault_path("backup-restore");

    {
      let mut connection = open_vault_db_at_path(&source_path).expect("open source vault");
      let vault = json!({
        "version": 2,
        "sources": [],
        "candidates": [],
        "facts": [{
          "id": "fact_test",
          "factText": "テスト用の事実",
          "domain": "identity_and_profile",
          "factType": "identity",
          "sourceIds": [],
          "sensitivity": "personal",
          "confidence": "user_asserted",
          "status": "active",
          "createdAt": "2026-01-01T00:00:00.000Z",
          "approvedAt": "2026-01-01T00:00:00.000Z",
          "updatedAt": "2026-01-01T00:00:00.000Z",
          "supersedesFactIds": []
        }],
        "accessPolicies": [],
        "passiveCaptureSettings": { "enabled": false, "retentionDays": 14, "allowedSites": [] },
        "passiveCaptureEvents": [],
        "connectorSessions": [],
        "contextPackRequests": [],
        "contextPacks": [],
        "auditEvents": []
      });
      save_vault_json_with_projection(&mut connection, &vault).expect("seed source vault");
    }

    let envelope =
      export_encrypted_backup_at_path(&source_path, passphrase).expect("export should succeed");
    let _restored_payload = import_encrypted_backup_at_path(&restore_path, &envelope, passphrase)
      .expect("import should succeed");

    let connection = open_vault_db_at_path(&restore_path).expect("open restored vault");
    let restored = load_vault_json_from_connection(&connection).expect("load restored vault");
    let facts = restored
      .get("facts")
      .and_then(Value::as_array)
      .expect("restored vault has facts array");
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0]["id"], "fact_test");
    assert_eq!(facts[0]["factText"], "テスト用の事実");

    remove_temp_vault(&source_path);
    remove_temp_vault(&restore_path);
  }

  #[test]
  fn write_local_backup_to_dir_creates_file_and_prunes_old() {
    use_test_vault_key();
    let db_path = temp_vault_path("scheduled-source");
    {
      let mut connection = open_vault_db_at_path(&db_path).expect("open source vault");
      save_vault_json_with_projection(
        &mut connection,
        &json!({"version":2,"sources":[],"candidates":[],"facts":[],"accessPolicies":[],"passiveCaptureSettings":{"enabled":false,"retentionDays":14,"allowedSites":[]},"passiveCaptureEvents":[],"connectorSessions":[],"contextPackRequests":[],"contextPacks":[],"auditEvents":[]}),
      )
      .expect("seed vault");
    }
    let dest = std::env::temp_dir().join(format!(
      "lcv-scheduled-test-{}",
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
    ));
    fs::create_dir_all(&dest).expect("test dest dir");
    fs::write(dest.join("vault-100.lcvbak"), "old").expect("seed old backup");
    let written = write_local_backup_to_dir(&db_path, &dest, 1).expect("write backup");
    assert!(written.exists());
    let count = fs::read_dir(&dest)
      .expect("read dest")
      .filter_map(Result::ok)
      .filter(|entry| entry.file_name().to_string_lossy().ends_with(".lcvbak"))
      .count();
    assert_eq!(count, 1, "retention=1 should prune the old backup");
    let _ = fs::remove_dir_all(&dest);
    remove_temp_vault(&db_path);
  }

  #[test]
  fn local_backup_round_trips_through_vault_db_at_path() {
    use_test_vault_key();
    let source_path = temp_vault_path("local-backup-source");
    let restore_path = temp_vault_path("local-backup-restore");
    {
      let mut connection = open_vault_db_at_path(&source_path).expect("open source");
      let vault = json!({
        "version": 2,
        "sources": [],
        "candidates": [],
        "facts": [{
          "id": "fact_x",
          "factText": "ローカルバックアップテスト",
          "domain": "identity_and_profile",
          "factType": "identity",
          "sourceIds": [],
          "sensitivity": "personal",
          "confidence": "user_asserted",
          "status": "active",
          "createdAt": "2026-01-01T00:00:00.000Z",
          "approvedAt": "2026-01-01T00:00:00.000Z",
          "updatedAt": "2026-01-01T00:00:00.000Z",
          "supersedesFactIds": []
        }],
        "accessPolicies": [],
        "passiveCaptureSettings": { "enabled": false, "retentionDays": 14, "allowedSites": [] },
        "passiveCaptureEvents": [],
        "connectorSessions": [],
        "contextPackRequests": [],
        "contextPacks": [],
        "auditEvents": []
      });
      save_vault_json_with_projection(&mut connection, &vault).expect("seed source vault");
    }
    let envelope = export_local_backup_at_path(&source_path).expect("export local backup");
    import_local_backup_at_path(&restore_path, &envelope).expect("import local backup");
    let connection = open_vault_db_at_path(&restore_path).expect("open restored vault");
    let restored = load_vault_json_from_connection(&connection).expect("load restored vault");
    let facts = restored
      .get("facts")
      .and_then(Value::as_array)
      .expect("facts array");
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0]["id"], "fact_x");
    assert_eq!(facts[0]["factText"], "ローカルバックアップテスト");
    remove_temp_vault(&source_path);
    remove_temp_vault(&restore_path);
  }

  #[test]
  fn sqlite_vec_loads_alongside_sqlcipher() {
    use_test_vault_key();
    // Register the sqlite-vec extension process-wide (same pattern as the
    // sqlite-vec crate's own test), then open a SQLCipher-encrypted connection.
    unsafe {
      rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
        sqlite_vec::sqlite3_vec_init as *const (),
      )));
    }
    let path = temp_vault_path("sqlite-vec-spike");
    let connection = open_vault_db_at_path(&path).expect("open encrypted vault");
    let version: String = connection
      .query_row("SELECT vec_version()", [], |row| row.get(0))
      .expect("vec_version() available on SQLCipher connection");
    assert!(version.starts_with("v"), "vec_version was: {version}");
    connection
      .execute_batch("CREATE VIRTUAL TABLE vec_spike USING vec0(embedding float[4])")
      .expect("create vec0 virtual table on SQLCipher connection");
    connection
      .execute(
        "INSERT INTO vec_spike(rowid, embedding) VALUES (1, ?)",
        [rusqlite::types::Value::Blob(vec![
          0, 0, 128, 63, 0, 0, 0, 64, 0, 0, 64, 64, 0, 0, 128, 64,
        ])],
      )
      .expect("insert vector");
    let distance: f64 = connection
      .query_row(
        "SELECT distance FROM vec_spike WHERE embedding MATCH ? ORDER BY distance LIMIT 1",
        [rusqlite::types::Value::Blob(vec![
          0, 0, 128, 63, 0, 0, 0, 64, 0, 0, 64, 64, 0, 0, 128, 64,
        ])],
        |row| row.get(0),
      )
      .expect("knn query");
    assert!(
      distance.is_finite(),
      "vec0 knn distance should be finite, got {distance}"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn runtime_preferences_round_trip_through_vault() {
    use_test_vault_key();
    let path = temp_vault_path("prefs");
    let prefs = json!({
      "autoStartAiAccess": true,
      "ocrCommand": "/opt/homebrew/bin/tesseract",
      "ocrArgs": "{input}",
      "ocrTimeoutSeconds": 45,
      "legacyOfficeCommand": "",
      "legacyOfficeArgs": "--headless --convert-to {target_ext} --outdir {output_dir} {input}",
      "legacyOfficeTimeoutSeconds": 60
    });
    save_runtime_preferences_at_path(&path, &prefs).expect("save prefs");
    let loaded = get_runtime_preferences_at_path(&path).expect("load prefs");
    assert_eq!(loaded, prefs);
    remove_temp_vault(&path);
  }

  #[test]
  fn delivery_notifications_enabled_persists_in_runtime_preferences() {
    use_test_vault_key();
    let path = temp_vault_path("delivery-notif");
    // default: field absent → treated as false
    let initial = get_runtime_preferences_at_path(&path).unwrap_or_else(|_| json!({}));
    assert_eq!(
      initial
        .get("deliveryNotificationsEnabled")
        .and_then(|v| v.as_bool()),
      None,
      "field should be absent before first write"
    );
    // enable: persist true
    let mut prefs = get_runtime_preferences_at_path(&path).unwrap_or_else(|_| json!({}));
    prefs["deliveryNotificationsEnabled"] = json!(true);
    save_runtime_preferences_at_path(&path, &prefs).expect("save enabled");
    let after_enable = get_runtime_preferences_at_path(&path).expect("load after enable");
    assert_eq!(
      after_enable
        .get("deliveryNotificationsEnabled")
        .and_then(|v| v.as_bool()),
      Some(true),
    );
    // disable: persist false
    let mut prefs2 = after_enable;
    prefs2["deliveryNotificationsEnabled"] = json!(false);
    save_runtime_preferences_at_path(&path, &prefs2).expect("save disabled");
    let after_disable = get_runtime_preferences_at_path(&path).expect("load after disable");
    assert_eq!(
      after_disable
        .get("deliveryNotificationsEnabled")
        .and_then(|v| v.as_bool()),
      Some(false),
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn pending_runtime_source_registers_without_candidates() {
    use_test_vault_key();
    let path = temp_vault_path("pending-runtime");
    let result = add_source_pending_runtime_at_path(&path, "document", "user_upload", "scan.png")
      .expect("add pending source");
    assert!(result.candidate_ids.is_empty());
    let connection = open_vault_db_at_path(&path).expect("reopen vault");
    let vault = load_vault_json_from_connection(&connection).expect("load vault");
    let sources = vault
      .get("sources")
      .and_then(Value::as_array)
      .expect("sources array");
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["processingStatus"], "needs_runtime");
    assert_eq!(sources[0]["title"], "scan.png");
    let candidates = vault
      .get("candidates")
      .and_then(Value::as_array)
      .expect("candidates array");
    assert!(candidates.is_empty());
    remove_temp_vault(&path);
  }

  fn zipped_document(entries: &[(&str, &str)]) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::FileOptions::default();
    for (name, body) in entries {
      writer.start_file(*name, options).expect("start zip entry");
      writer.write_all(body.as_bytes()).expect("write zip entry");
    }
    writer.finish().expect("finish zip").into_inner()
  }

  #[test]
  fn native_document_extraction_reads_docx_text_without_fact_creation() {
    let bytes = zipped_document(&[(
      "word/document.xml",
      r#"
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:r><w:t>Insurance policy renewal is due on 2027-08-31.</w:t></w:r></w:p>
            <w:p><w:r><w:t>Contact the insurer before moving address.</w:t></w:r></w:p>
          </w:body>
        </w:document>
      "#,
    )]);
    let result = extract_native_document_text_from_base64_with_ocr_config(
      "insurance.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      &STANDARD.encode(bytes),
      None,
    )
    .expect("extract docx text");

    assert_eq!(result.detected_kind, "docx");
    assert!(result
      .text
      .contains("Insurance policy renewal is due on 2027-08-31."));
    assert!(result
      .text
      .contains("Contact the insurer before moving address."));
    assert_eq!(result.generated_by, "native_document_extractor");
  }

  #[test]
  fn native_document_extraction_refuses_legacy_office_without_converter() {
    let result = extract_native_document_text_from_base64_with_configs(
      "old-benefits.doc",
      "application/msword",
      &STANDARD.encode([0xD0, 0xCF, 0x11, 0xE0, 0x00]),
      None,
      None,
    );
    let error = result.expect_err("legacy office should require converter");
    assert!(error.contains("旧Office変換Provider"));
  }

  #[cfg(unix)]
  #[test]
  fn native_document_extraction_converts_legacy_office_with_local_provider() {
    let docx_bytes = zipped_document(&[(
      "word/document.xml",
      r#"
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:r><w:t>Legacy pension document renews on 2028-04-01.</w:t></w:r></w:p>
          </w:body>
        </w:document>
      "#,
    )]);
    let temp_dir = env::temp_dir().join(new_id("lcv_legacy_office_test"));
    fs::create_dir_all(&temp_dir).expect("test temp dir");
    let fixture_path = temp_dir.join("converted.docx");
    fs::write(&fixture_path, docx_bytes).expect("fixture docx");
    let script_path = temp_dir.join("convert.sh");
    fs::write(
      &script_path,
      format!("#!/bin/sh\ncp '{}' \"$1\"\n", fixture_path.display()),
    )
    .expect("converter script");
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&script_path, fs::Permissions::from_mode(0o700)).expect("script chmod");
    }
    let config = LegacyOfficeCommandConfig {
      command: script_path.to_string_lossy().to_string(),
      args: vec!["{output}".to_string()],
      timeout: Duration::from_secs(5),
    };
    let result = extract_native_document_text_from_base64_with_configs(
      "old-benefits.doc",
      "application/msword",
      &STANDARD.encode([0xD0, 0xCF, 0x11, 0xE0, 0x00]),
      None,
      Some(config),
    )
    .expect("legacy office conversion");

    assert_eq!(result.detected_kind, "legacy_office_converted");
    assert!(result
      .text
      .contains("Legacy pension document renews on 2028-04-01."));
    assert!(result
      .warnings
      .iter()
      .any(|warning| warning.contains("旧Office文書")));
    let _ = fs::remove_dir_all(temp_dir);
  }

  #[cfg(unix)]
  #[test]
  fn legacy_office_conversion_failure_removes_temp_dir() {
    let before = legacy_office_temp_dirs();
    let config = LegacyOfficeCommandConfig {
      command: "/bin/true".to_string(),
      args: Vec::new(),
      timeout: Duration::from_secs(5),
    };
    let result = extract_native_document_text_from_base64_with_configs(
      "old-benefits.doc",
      "application/msword",
      &STANDARD.encode([0xD0, 0xCF, 0x11, 0xE0, 0x00]),
      None,
      Some(config),
    );

    assert!(result.is_err());
    let after = legacy_office_temp_dirs();
    let leaked = after
      .difference(&before)
      .map(|path| path.display().to_string())
      .collect::<Vec<_>>();
    assert!(leaked.is_empty(), "leaked temp dirs: {leaked:?}");
  }

  #[test]
  fn legacy_office_command_default_timeout_is_sixty_seconds() {
    let config = legacy_office_command_config_from_parts("/usr/bin/libreoffice", None, None)
      .expect("legacy office config");
    assert_eq!(config.timeout, Duration::from_secs(60));
  }

  #[test]
  fn native_document_extraction_refuses_images_without_ocr_provider() {
    let kind = detect_native_document_kind("scan.png", "image/png", b"\x89PNG\r\n")
      .expect("detect image kind");
    assert_eq!(kind, NativeDocumentKind::ImageOcr);

    let mut warnings = Vec::new();
    let result = extract_image_ocr_document_with_optional_config(
      None,
      "scan.png",
      "image/png",
      b"\x89PNG\r\n",
      &mut warnings,
    );
    let error = match result {
      Ok(_) => panic!("image extraction should fail without OCR provider"),
      Err(error) => error,
    };
    assert!(error.contains("画像OCR Provider"));
  }

  #[cfg(unix)]
  #[test]
  fn native_document_extraction_uses_configured_ocr_provider_command() {
    let config = OcrCommandConfig {
      command: "/bin/cat".to_string(),
      args: vec!["{input}".to_string()],
      timeout: Duration::from_secs(5),
    };
    let mut warnings = Vec::new();
    let text = extract_image_ocr_document_with_config(
      &config,
      "scan.png",
      "image/png",
      b"Scanned policy renewal is due on 2027-08-31.",
      &mut warnings,
    )
    .expect("ocr provider command");
    assert!(text.contains("Scanned policy renewal is due on 2027-08-31."));
    assert!(warnings
      .iter()
      .any(|warning| warning.contains("OCR Provider")));
  }

  #[cfg(unix)]
  #[test]
  fn native_document_extraction_drains_noisy_provider_output() {
    let config = OcrCommandConfig {
      command: "/bin/sh".to_string(),
      args: vec![
        "-c".to_string(),
        "i=0; while [ $i -lt 20000 ]; do printf '0123456789abcdef0123456789abcdef\\n' >&2; i=$((i+1)); done; printf 'Noisy OCR text renews on 2029-01-01.'".to_string(),
      ],
      timeout: Duration::from_secs(10),
    };
    let mut warnings = Vec::new();
    let text = extract_image_ocr_document_with_config(
      &config,
      "scan.png",
      "image/png",
      b"tiny image",
      &mut warnings,
    )
    .expect("noisy provider output should not deadlock");

    assert!(text.contains("Noisy OCR text renews on 2029-01-01."));
  }

  #[test]
  fn ocr_provider_detection_finds_path_candidate_without_running_it() {
    let temp_dir = env::temp_dir().join(new_id("lcv_ocr_detect_test"));
    fs::create_dir_all(&temp_dir).expect("create temp dir");
    let binary_name = if cfg!(windows) {
      "tesseract.exe"
    } else {
      "tesseract"
    };
    let binary_path = temp_dir.join(binary_name);
    fs::write(&binary_path, b"not a real executable").expect("write fake provider");
    let path_env = env::join_paths([temp_dir.clone()]).expect("join path");

    let candidates =
      detect_ocr_provider_candidates_from_sources(Some(path_env), &[binary_path.clone()]);

    assert_eq!(candidates.len(), 1);
    assert_eq!(
      candidates[0].command,
      binary_path.to_string_lossy().to_string()
    );
    assert_eq!(candidates[0].args, "{input} stdout");
    assert_eq!(candidates[0].timeout_seconds, 30);
    assert_eq!(candidates[0].source, "PATH");

    fs::remove_dir_all(temp_dir).ok();
  }

  fn legacy_office_temp_dirs() -> HashSet<PathBuf> {
    fs::read_dir(env::temp_dir())
      .ok()
      .into_iter()
      .flatten()
      .filter_map(Result::ok)
      .map(|entry| entry.path())
      .filter(|path| {
        path
          .file_name()
          .and_then(|value| value.to_str())
          .map(|name| {
            name
              .strip_prefix("lcv_legacy_office_")
              .map(|suffix| {
                suffix.len() == 24
                  && suffix.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                  })
              })
              .unwrap_or(false)
          })
          .unwrap_or(false)
      })
      .collect()
  }

  #[test]
  fn legacy_office_provider_detection_finds_path_candidate_without_running_it() {
    let temp_dir = env::temp_dir().join(new_id("lcv_legacy_office_detect_test"));
    fs::create_dir_all(&temp_dir).expect("create temp dir");
    let binary_name = if cfg!(windows) {
      "soffice.exe"
    } else {
      "soffice"
    };
    let binary_path = temp_dir.join(binary_name);
    fs::write(&binary_path, b"not a real executable").expect("write fake provider");
    let path_env = env::join_paths([temp_dir.clone()]).expect("join path");

    let candidates =
      detect_legacy_office_provider_candidates_from_sources(Some(path_env), &[binary_path.clone()]);

    assert_eq!(candidates.len(), 1);
    assert_eq!(
      candidates[0].command,
      binary_path.to_string_lossy().to_string()
    );
    assert_eq!(
      candidates[0].args,
      "--headless --convert-to {target_ext} --outdir {output_dir} {input}"
    );
    assert_eq!(candidates[0].timeout_seconds, 60);
    assert_eq!(candidates[0].source, "PATH");

    fs::remove_dir_all(temp_dir).ok();
  }

  fn benchmark_size_from_env(name: &str, default: usize) -> usize {
    env::var(name)
      .ok()
      .and_then(|value| value.parse::<usize>().ok())
      .filter(|value| *value > 0)
      .unwrap_or(default)
  }

  fn duration_ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
  }

  fn percentile_ms(samples: &mut [Duration], percentile: usize) -> f64 {
    samples.sort();
    let index = samples.len().saturating_mul(percentile).saturating_add(99) / 100;
    let index = index.saturating_sub(1).min(samples.len().saturating_sub(1));
    duration_ms(samples[index])
  }

  fn seed_large_retrieval_benchmark(
    connection: &mut Connection,
    fact_count: usize,
    chunks_per_fact: usize,
  ) {
    connection
      .execute_batch(
        "PRAGMA synchronous = OFF;
         PRAGMA temp_store = MEMORY;",
      )
      .expect("benchmark pragmas");
    let transaction = connection.transaction().expect("benchmark transaction");
    {
      let mut source_statement = transaction
        .prepare(
          "INSERT INTO sources (
            id, kind, title, origin, body, created_at, captured_at, retention_until,
            default_sensitivity, processing_status, deletion_state
          ) VALUES (?1, 'document', ?2, 'user_upload', ?3, ?4, ?4, NULL, ?5, 'ready', 'active')",
        )
        .expect("prepare benchmark sources");
      let mut chunk_statement = transaction
        .prepare(
          "INSERT INTO source_chunks (
            id, source_id, chunk_index, text, detected_sensitivity, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .expect("prepare benchmark chunks");
      let mut fact_statement = transaction
        .prepare(
          "INSERT INTO facts (
            id, fact_text, domain, fact_type, source_ids, sensitivity, confidence,
            status, valid_from, valid_until, due_date, created_at, approved_at, updated_at,
            supersedes_fact_ids, superseded_by_fact_id
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'source_backed', 'active', NULL, NULL, ?7, ?8, ?8, ?8, '[]', NULL)",
        )
        .expect("prepare benchmark facts");
      let mut fts_statement = transaction
        .prepare("INSERT INTO facts_fts (fact_id, fact_text, domain) VALUES (?1, ?2, ?3)")
        .expect("prepare benchmark fts");
      let domains = [
        "home_and_places",
        "contracts_and_policies",
        "procedures_and_obligations",
        "finance_and_benefits",
        "work_and_education",
        "documents_and_evidence",
        "routines_and_logistics",
        "values_goals_and_preferences",
      ];
      let fact_types = [
        "deadline",
        "obligation",
        "contract_term",
        "support_need",
        "place_context",
        "document_reference",
        "routine",
        "preference",
      ];
      let sensitivities = ["public", "personal", "private_consequential", "sensitive"];

      for index in 0..fact_count {
        let source_id = format!("src_bench_{index:06}");
        let fact_id = format!("fact_bench_{index:06}");
        let domain = domains[index % domains.len()];
        let fact_type = fact_types[index % fact_types.len()];
        let sensitivity = sensitivities[index % sensitivities.len()];
        let month = (index % 12) + 1;
        let day = (index % 28) + 1;
        let due_date = format!("2027-{month:02}-{day:02}");
        let updated_at = format!(
          "2026-06-12T{:02}:{:02}:{:02}.000Z",
          index % 24,
          index % 60,
          index % 60
        );
        let fact_text = format!(
          "Benchmark fact {index}: insurance policy renewal, address moving checklist, employer job change, pension benefit paperwork, lease contract obligation, document evidence, due date {due_date}."
        );
        let body = format!(
          "{fact_text} Source paragraph for retrieval benchmark. Chunk text repeats address insurance moving employer pension benefit terms."
        );
        let source_ids_json = format!("[\"{source_id}\"]");

        source_statement
          .execute(params![
            source_id,
            format!("Benchmark source {index}"),
            body,
            updated_at,
            sensitivity
          ])
          .expect("insert benchmark source");
        for chunk_index in 0..chunks_per_fact {
          chunk_statement
            .execute(params![
              format!("chunk_bench_{index:06}_{chunk_index}"),
              source_id,
              chunk_index as i64,
              format!("{fact_text} supporting source chunk {chunk_index}."),
              sensitivity,
              updated_at
            ])
            .expect("insert benchmark source chunk");
        }
        fact_statement
          .execute(params![
            fact_id,
            fact_text,
            domain,
            fact_type,
            source_ids_json,
            sensitivity,
            due_date,
            updated_at
          ])
          .expect("insert benchmark fact");
        fts_statement
          .execute(params![fact_id, fact_text, domain])
          .expect("insert benchmark fts");
      }
    }
    transaction.commit().expect("commit benchmark seed");
  }

  #[test]
  #[ignore = "large benchmark: run explicitly with --ignored; defaults to 100k Facts and 500k source chunks"]
  fn large_scale_retrieval_benchmark_100k_facts_500k_chunks() {
    use_test_vault_key();
    let fact_count = benchmark_size_from_env("LCV_BENCH_FACTS", 100_000);
    let chunks_per_fact = benchmark_size_from_env("LCV_BENCH_CHUNKS_PER_FACT", 5);
    let expected_chunk_count = fact_count * chunks_per_fact;
    let path = temp_vault_path("retrieval-benchmark");
    let mut connection = open_vault_db_at_path(&path).expect("open benchmark vault");

    let seed_start = Instant::now();
    seed_large_retrieval_benchmark(&mut connection, fact_count, chunks_per_fact);
    let seed_elapsed = seed_start.elapsed();

    let fact_total: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("benchmark fact count");
    let chunk_total: i64 = connection
      .query_row("SELECT COUNT(*) FROM source_chunks", [], |row| row.get(0))
      .expect("benchmark chunk count");
    assert_eq!(fact_total as usize, fact_count);
    assert_eq!(chunk_total as usize, expected_chunk_count);

    let search_queries = [
      "insurance address",
      "moving checklist",
      "employer pension",
      "benefit paperwork",
      "lease contract",
      "document evidence",
    ];
    let mut search_samples = Vec::new();
    for _ in 0..4 {
      for query in search_queries {
        let started = Instant::now();
        let results = search_facts_in_connection(&connection, query, None, None, 40)
          .expect("benchmark FTS search");
        assert!(!results.is_empty());
        search_samples.push(started.elapsed());
      }
    }

    let pack_tasks = [
      "What should I update before moving address with my insurance policy?",
      "What should I remember before changing employer for pension benefit paperwork?",
      "Which lease contract obligations and document evidence matter this month?",
      "Help me plan the renewal checklist for insurance, address, and benefits.",
    ];
    let mut pack_samples = Vec::new();
    let mut vault = empty_vault_json();
    for _ in 0..3 {
      for task in pack_tasks {
        let started = Instant::now();
        let (_request_id, pack_id) = create_native_context_pack_request_in_connection(
          &connection,
          &mut vault,
          "conn_benchmark",
          "Benchmark Client",
          task,
          Some("large retrieval benchmark"),
          Some("sensitive"),
          Some("always_review"),
        )
        .expect("benchmark context pack");
        let pack = find_vault_item_by_id(&vault, "contextPacks", &pack_id).expect("benchmark pack");
        assert!(pack
          .get("items")
          .and_then(Value::as_array)
          .map(|items| !items.is_empty())
          .unwrap_or(false));
        pack_samples.push(started.elapsed());
      }
    }

    let search_p95_ms = percentile_ms(&mut search_samples, 95);
    let pack_p95_ms = percentile_ms(&mut pack_samples, 95);
    eprintln!(
      "LCV retrieval benchmark: facts={fact_count}, chunks={expected_chunk_count}, seed_ms={:.1}, fts_p95_ms={search_p95_ms:.1}, context_pack_p95_ms={pack_p95_ms:.1}",
      duration_ms(seed_elapsed)
    );

    assert!(
      search_p95_ms <= 300.0,
      "FTS P95 exceeded target: {search_p95_ms:.1}ms > 300ms"
    );
    assert!(
      pack_p95_ms <= 1000.0,
      "Context Pack P95 exceeded target: {pack_p95_ms:.1}ms > 1000ms"
    );
    remove_temp_vault(&path);
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
      .query_row("SELECT COUNT(*) FROM memory_candidates", [], |row| {
        row.get(0)
      })
      .expect("candidate count");
    let fact_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("fact count");
    let fts_count: i64 = connection
      .query_row(
        "SELECT COUNT(*) FROM facts_fts WHERE facts_fts MATCH 'address'",
        [],
        |row| row.get(0),
      )
      .expect("fts count");

    assert_eq!(source_count, 1);
    assert_eq!(candidate_count, 1);
    assert_eq!(fact_count, 1);
    assert_eq!(fts_count, 1);
  }

  #[test]
  fn sync_projection_splits_large_source_bodies_into_deterministic_chunks() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_vault_schema(&connection).expect("schema");
    let repeated = "Insurance renewal address update evidence. ".repeat(260);
    let payload = json!({
      "version": 2,
      "sources": [{
        "id": "src_large",
        "kind": "document",
        "title": "Large policy document",
        "origin": "user_upload",
        "body": repeated,
        "createdAt": "2026-06-12T00:00:00.000Z",
        "capturedAt": "2026-06-12T00:00:00.000Z",
        "defaultSensitivity": "personal",
        "processingStatus": "ready",
        "deletionState": "active"
      }],
      "candidates": [],
      "facts": [],
      "accessPolicies": [],
      "contextPackRequests": [],
      "contextPacks": [],
      "connectorSessions": [],
      "passiveCaptureEvents": [],
      "auditEvents": []
    })
    .to_string();

    sync_normalized_tables(&mut connection, &payload).expect("sync");

    let chunk_count: i64 = connection
      .query_row(
        "SELECT COUNT(*) FROM source_chunks WHERE source_id = 'src_large'",
        [],
        |row| row.get(0),
      )
      .expect("chunk count");
    let first_chunk: String = connection
      .query_row(
        "SELECT text FROM source_chunks WHERE source_id = 'src_large' AND chunk_index = 0",
        [],
        |row| row.get(0),
      )
      .expect("first chunk");
    let second_chunk: String = connection
      .query_row(
        "SELECT text FROM source_chunks WHERE source_id = 'src_large' AND chunk_index = 1",
        [],
        |row| row.get(0),
      )
      .expect("second chunk");

    assert!(chunk_count > 1);
    assert!(first_chunk.len() < repeated.len());
    assert!(
      second_chunk.starts_with("Insurance renewal") || second_chunk.contains("Insurance renewal")
    );
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
      .filter_map(|candidate| {
        candidate
          .get("candidateType")
          .and_then(Value::as_str)
          .map(str::to_string)
      })
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
      .query_row("SELECT COUNT(*) FROM memory_candidates", [], |row| {
        row.get(0)
      })
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
    assert!(saved
      .get("facts")
      .and_then(Value::as_array)
      .map(Vec::is_empty)
      .unwrap_or(false));
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
      .and_then(|sources| {
        sources
          .iter()
          .find(|source| str_field(source, "id") == source_result.source_id)
      })
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

    assert_eq!(
      source.get("deletionState").and_then(Value::as_str),
      Some("soft_deleted")
    );
    assert_eq!(
      source.get("processingStatus").and_then(Value::as_str),
      Some("deleted")
    );
    assert_eq!(
      fact.get("status").and_then(Value::as_str),
      Some("needs_review")
    );
    assert_eq!(
      fact.get("reviewReason").and_then(Value::as_str),
      Some("source_deleted")
    );
    assert_eq!(result.affected_fact_count, 1);
    assert_eq!(result.invalidated_pack_count, 1);
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("cancelled")
    );
    assert_eq!(
      request.get("status").and_then(Value::as_str),
      Some("expired")
    );

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let search =
      search_facts_in_connection(&connection, "lease", None, None, 20).expect("search facts");
    let normalized_status: String = connection
      .query_row("SELECT status FROM facts LIMIT 1", [], |row| row.get(0))
      .expect("normalized fact status");

    assert!(search.is_empty());
    assert_eq!(normalized_status, "needs_review");
    remove_temp_vault(&path);
  }

  #[test]
  fn browser_capture_source_purge_refuses_non_browser_sources() {
    use_test_vault_key();
    let path = temp_vault_path("capture-host-source-boundary");
    let source_result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Manual note",
      "Need to renew lease by 2027-01-15.",
    )
    .expect("source ingest");

    let error = match purge_browser_passive_capture_source_at_path(&path, &source_result.source_id)
    {
      Ok(_) => panic!("manual source should not be purgeable from capture host"),
      Err(error) => error,
    };

    assert!(error.contains("browser passive-capture"));
    remove_temp_vault(&path);
  }

  #[test]
  fn native_source_body_update_reextracts_candidates_and_reviews_facts() {
    use_test_vault_key();
    let path = temp_vault_path("source-body-update");
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

    let result = update_source_body_at_path(
      &path,
      &source_result.source_id,
      "Need to renew lease by 2027-02-01.",
    )
    .expect("source body update");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let source = saved
      .get("sources")
      .and_then(Value::as_array)
      .and_then(|sources| {
        sources
          .iter()
          .find(|source| str_field(source, "id") == source_result.source_id)
      })
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
    let generated_candidate = saved
      .get("candidates")
      .and_then(Value::as_array)
      .and_then(|candidates| {
        candidates
          .iter()
          .find(|candidate| str_field(candidate, "id") == result.candidate_ids[0])
      })
      .expect("regenerated candidate");

    assert_eq!(result.candidate_ids.len(), 1);
    assert_eq!(result.affected_fact_count, 1);
    assert_eq!(result.invalidated_pack_count, 1);
    assert_eq!(
      source.get("body").and_then(Value::as_str),
      Some("Need to renew lease by 2027-02-01.")
    );
    assert_eq!(
      fact.get("status").and_then(Value::as_str),
      Some("needs_review")
    );
    assert_eq!(
      fact.get("reviewReason").and_then(Value::as_str),
      Some("source_updated")
    );
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("cancelled")
    );
    assert_eq!(
      generated_candidate.get("status").and_then(Value::as_str),
      Some("new")
    );
    assert_eq!(
      generated_candidate
        .get("conflictWithFactIds")
        .cloned()
        .unwrap_or_else(|| json!([])),
      json!([])
    );
    assert!(generated_candidate
      .get("proposedFactText")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .contains("lease"));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let search =
      search_facts_in_connection(&connection, "lease", None, None, 20).expect("search facts");
    let normalized_body: String = connection
      .query_row(
        "SELECT body FROM sources WHERE id = ?1",
        params![source_result.source_id],
        |row| row.get(0),
      )
      .expect("normalized source body");
    let normalized_candidate_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM memory_candidates", [], |row| {
        row.get(0)
      })
      .expect("normalized candidate count");
    let normalized_conflicts: String = connection
      .query_row(
        "SELECT conflict_with_fact_ids FROM memory_candidates WHERE id = ?1",
        params![result.candidate_ids[0].clone()],
        |row| row.get(0),
      )
      .expect("normalized candidate conflicts");

    assert!(search.is_empty());
    assert_eq!(normalized_body, "Need to renew lease by 2027-02-01.");
    assert_eq!(normalized_candidate_count, 2);
    assert_eq!(normalized_conflicts, "[]");
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
      .and_then(|sources| {
        sources
          .iter()
          .find(|source| str_field(source, "id") == source_result.source_id)
      })
      .expect("source");
    let candidate = saved
      .get("candidates")
      .and_then(Value::as_array)
      .and_then(|candidates| {
        candidates
          .iter()
          .find(|candidate| str_field(candidate, "id") == candidate_id)
      })
      .expect("candidate");
    let approval_error = match approve_candidate_at_path(&path, &candidate_id, None) {
      Ok(_) => panic!("purged source candidate should not approve"),
      Err(error) => error,
    };

    assert_eq!(source.get("body").and_then(Value::as_str), Some(""));
    assert_eq!(
      source.get("deletionState").and_then(Value::as_str),
      Some("purged")
    );
    assert_eq!(
      candidate.get("status").and_then(Value::as_str),
      Some("archived")
    );
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
      .and_then(|sources| {
        sources
          .iter()
          .find(|source| str_field(source, "id") == source_result.source_id)
      })
      .expect("source");
    let cancelled_pack =
      find_vault_item_by_id(&saved, "contextPacks", &first_pack.pack_id).expect("cancelled pack");

    assert_eq!(updated.invalidated_pack_count, 1);
    assert_eq!(
      source.get("title").and_then(Value::as_str),
      Some("Apartment lease evidence")
    );
    assert_eq!(
      source.get("defaultSensitivity").and_then(Value::as_str),
      Some("private_consequential")
    );
    assert_eq!(
      cancelled_pack
        .get("confirmationStatus")
        .and_then(Value::as_str),
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
    let second_saved: Value =
      serde_json::from_str(&second_pack.payload).expect("second vault json");
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
    let reviewed =
      approve_candidate_at_path(&path, &candidate_id, None).expect("approve candidate");
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
    assert_eq!(
      fact.get("status").and_then(Value::as_str),
      Some("user_hidden")
    );
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("cancelled")
    );

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let search =
      search_facts_in_connection(&connection, "insurance", None, None, 20).expect("search facts");
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
    let reviewed =
      approve_candidate_at_path(&path, &candidate_id, None).expect("approve candidate");
    let fact_id = reviewed.fact_id.expect("fact id");
    update_source_lifecycle_at_path(&path, &source_result.source_id, "soft_delete")
      .expect("soft delete source");

    let result =
      update_fact_lifecycle_at_path(&path, &fact_id, "keep_active").expect("keep fact active");
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
    let search =
      search_facts_in_connection(&connection, "lease", None, None, 20).expect("search facts");
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
    let reviewed =
      approve_candidate_at_path(&path, &candidate_id, None).expect("approve candidate");
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
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("cancelled")
    );

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let old_search =
      search_facts_in_connection(&connection, "2027-01-15", None, None, 20).expect("old search");
    let new_search =
      search_facts_in_connection(&connection, "apartment", None, None, 20).expect("new search");
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
  fn sanitize_secret_material_redacts_to_end_of_line_without_bleeding_across_lines() {
    // Credential separated from its keyword by >=2 tokens must not survive.
    let out = sanitize_secret_material("My password is hunter2");
    assert!(!out.contains("hunter2"), "secret value leaked: {out}");
    assert!(out.contains("[REDACTED_SECRET]"));

    // "api key <value>" pattern is fully masked.
    let api = sanitize_secret_material("the api key sk-abc123 rotates monthly");
    assert!(!api.contains("sk-abc123"), "api key leaked: {api}");

    // Redaction stops at the line boundary: a later, unrelated line survives.
    let multi =
      sanitize_secret_material("password is hunter2\nNeed to update address before moving.");
    assert!(!multi.contains("hunter2"), "secret value leaked: {multi}");
    assert!(
      multi.contains("Need to update address before moving."),
      "non-secret line was over-redacted: {multi}"
    );

    // Lines with no indicator are untouched.
    let clean = sanitize_secret_material("Tone preference: concise and calm.");
    assert_eq!(clean, "Tone preference: concise and calm.");

    // False positives (a word merely CONTAINING a keyword) must NOT nuke the
    // whole line — only the baseline bounded blast applies, so the tail survives.
    let secretary = sanitize_secret_material("My secretary scheduled the meeting for Tuesday");
    assert!(
      secretary.contains("the meeting for Tuesday"),
      "false-positive over-redacted to end of line: {secretary}"
    );

    // Genuine keywords still match even with adjacent punctuation.
    let punct = sanitize_secret_material("token: abc123");
    assert!(
      !punct.contains("abc123"),
      "punctuated keyword missed: {punct}"
    );
    let kv = sanitize_secret_material("password=hunter2 and more");
    assert!(!kv.contains("hunter2"), "kv secret leaked: {kv}");

    // Pluralized/suffixed keywords must NOT bypass redaction — a value >=2 tokens
    // after a plural keyword must still be masked (the security-review regression).
    let plural = sanitize_secret_material("my passwords are hunter2 and swordfish");
    assert!(
      !plural.contains("hunter2"),
      "plural keyword bypassed redaction: {plural}"
    );
    assert!(
      !plural.contains("swordfish"),
      "plural keyword bypassed redaction: {plural}"
    );
    let toks = sanitize_secret_material("api tokens: tok_abc tok_def");
    assert!(
      !toks.contains("tok_abc"),
      "plural keyword bypassed redaction: {toks}"
    );
  }

  #[test]
  fn context_inclusion_reason_prefers_strongest_signal() {
    let make = |fact_text: &str, domain: &str, fact_type: &str| NativeFactSearchResult {
      id: "fact_x".into(),
      fact_text: fact_text.into(),
      domain: domain.into(),
      fact_type: fact_type.into(),
      source_ids: vec![],
      sensitivity: "personal_sensitive".into(),
      confidence: "high".into(),
      status: "active".into(),
      valid_from: None,
      valid_until: None,
      due_date: None,
      created_at: String::new(),
      approved_at: String::new(),
      updated_at: String::new(),
      rank: 0.0,
      sensitivity_classified: true,
      sensitivity_confidence: "high".into(),
    };

    // Direct token match wins even when the domain differs.
    let f = make("Passport expires in March", "documents_and_evidence", "document_ref");
    assert_eq!(
      context_inclusion_reason(&f, "finance_and_benefits", "renew passport"),
      "質問の語に直接一致する記憶です。"
    );

    // Same domain when there is no token overlap.
    let f = make("血圧の薬を朝に飲む", "health_and_care", "routine");
    assert_eq!(
      context_inclusion_reason(&f, "health_and_care", "週末の旅行"),
      "質問の領域と一致しています。"
    );

    // Stable background as a fallback (no token, different domain, no bridge).
    let f = make("名前は太郎", "identity_and_profile", "background_profile");
    assert_eq!(
      context_inclusion_reason(&f, "finance_and_benefits", "zzz"),
      "安定した背景情報として回答を調整できます。"
    );
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
      .query_row("SELECT COUNT(*) FROM memory_candidates", [], |row| {
        row.get(0)
      })
      .expect("normalized candidate count");
    let normalized_fact_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("normalized fact count");
    let normalized_capture_count: i64 = connection
      .query_row("SELECT COUNT(*) FROM passive_capture_events", [], |row| {
        row.get(0)
      })
      .expect("normalized capture count");

    assert_eq!(normalized_source_count, 1);
    assert_eq!(
      normalized_candidate_count,
      result.candidate_ids.len() as i64
    );
    assert_eq!(normalized_fact_count, 0);
    assert_eq!(normalized_capture_count, 1);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_save_purges_expired_passive_capture_bodies() {
    use_test_vault_key();
    let path = temp_vault_path("passive-capture-ttl");
    let mut connection = open_vault_db_at_path(&path).expect("open vault");
    let mut vault = empty_vault_json();
    vault["passiveCaptureSettings"]["enabled"] = json!(true);
    push_json_array(
      &mut vault,
      "sources",
      json!({
        "id": "src_expired_capture",
        "kind": "passive_capture",
        "title": "Expired ChatGPT capture",
        "origin": "passive_browser",
        "body": "Raw transcript that must expire.",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "capturedAt": "2026-01-01T00:00:00.000Z",
        "retentionUntil": "2026-01-02T00:00:00.000Z",
        "promotedToLongTerm": false,
        "defaultSensitivity": "personal",
        "processingStatus": "ready",
        "deletionState": "active"
      }),
    );
    push_json_array(
      &mut vault,
      "passiveCaptureEvents",
      json!({
        "id": "cap_expired",
        "sourceClient": "chatgpt",
        "conversationId": "thread",
        "urlHash": "hash",
        "textFragmentRef": "src_expired_capture:body",
        "capturedAt": "2026-01-01T00:00:00.000Z",
        "retentionUntil": "2026-01-02T00:00:00.000Z",
        "sensitivityGuess": "personal",
        "processingStatus": "candidate_generated",
        "sourceId": "src_expired_capture",
        "candidateIds": []
      }),
    );
    save_vault_state_payload(&mut connection, &vault.to_string(), None)
      .expect("seed expired vault");
    drop(connection);

    let result = update_passive_capture_settings_at_path(&path, Some(true), None, None)
      .expect("settings update purges expired capture");
    let saved: Value = serde_json::from_str(&result.payload).expect("vault json");
    let source =
      find_vault_item_by_id(&saved, "sources", "src_expired_capture").expect("expired source");
    let event = find_vault_item_by_id(&saved, "passiveCaptureEvents", "cap_expired")
      .expect("expired capture event");
    let audit_text = saved
      .get("auditEvents")
      .and_then(Value::as_array)
      .cloned()
      .map(Value::Array)
      .unwrap_or_else(|| json!([]))
      .to_string();

    assert_eq!(
      source.get("body").and_then(Value::as_str),
      Some("[PURGED_PASSIVE_CAPTURE]")
    );
    assert_eq!(
      source.get("deletionState").and_then(Value::as_str),
      Some("purged")
    );
    assert_eq!(
      event.get("processingStatus").and_then(Value::as_str),
      Some("purged")
    );
    assert!(audit_text.contains("passive_capture_purged"));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let normalized_body: String = connection
      .query_row(
        "SELECT body FROM sources WHERE id = ?1",
        params!["src_expired_capture"],
        |row| row.get(0),
      )
      .expect("normalized source body");
    assert_eq!(normalized_body, "[PURGED_PASSIVE_CAPTURE]");
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
    assert_eq!(
      settings.get("retentionDays").and_then(Value::as_i64),
      Some(90)
    );
    assert_eq!(
      settings
        .get("allowedSites")
        .cloned()
        .unwrap_or_else(|| json!([])),
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
      Some(vec![
        "health_and_care".to_string(),
        "documents_and_evidence".to_string(),
        "health_and_care".to_string(),
      ]),
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
    assert_eq!(
      policy.get("domainAllowlist"),
      Some(&json!(["health_and_care", "documents_and_evidence"]))
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
    let empty_domain_error =
      match update_access_policy_at_path(&path, "conn_chatgpt", None, None, Some(Vec::new()), None)
      {
        Ok(_) => panic!("empty domain allowlist should be rejected"),
        Err(error) => error,
      };
    assert!(empty_domain_error.contains("domainAllowlist"));
    let mixed_domain_error = match update_access_policy_at_path(
      &path,
      "conn_chatgpt",
      None,
      None,
      Some(vec![
        "health_and_care".to_string(),
        "not_a_domain".to_string(),
      ]),
      None,
    ) {
      Ok(_) => panic!("mixed invalid domain allowlist should be rejected"),
      Err(error) => error,
    };
    assert!(mixed_domain_error.contains("unsupported life context domain"));
    remove_temp_vault(&path);
  }

  #[test]
  fn pending_context_pack_has_a_long_confirmation_window() {
    // A confirmation-required request must stay confirmable well beyond the
    // 10-minute delivery TTL, so the user can approve at their leisure instead
    // of racing a 10-minute clock.
    use_test_vault_key();
    let path = temp_vault_path("pending-pack-long-confirm-window");
    let source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Schedule note",
      "Morning routine is a walk at 7am.",
    )
    .expect("source");
    approve_candidate_at_path(&path, source.candidate_ids.first().expect("candidate"), None)
      .expect("approve candidate");
    let built = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "Help me plan my morning.",
      None,
      Some("personal"),
      Some("always_review"),
    )
    .expect("context pack");
    assert_eq!(built.confirmation_status, "pending_user_confirmation");

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open");
    let saved = load_vault_json_from_connection(&connection).expect("vault json");
    let pack = find_vault_item_by_id(&saved, "contextPacks", &built.pack_id).expect("pack");
    let request =
      find_vault_item_by_id(&saved, "contextPackRequests", &built.request_id).expect("request");
    let in_eleven_minutes = chrono::Utc::now() + chrono::Duration::minutes(11);
    let pack_expiry = chrono::DateTime::parse_from_rfc3339(&str_field(&pack, "expiresAt"))
      .expect("pack expiresAt")
      .with_timezone(&chrono::Utc);
    let request_expiry = chrono::DateTime::parse_from_rfc3339(&str_field(&request, "expiresAt"))
      .expect("request expiresAt")
      .with_timezone(&chrono::Utc);
    assert!(
      pack_expiry > in_eleven_minutes,
      "pending pack must not expire within 10 minutes: {}",
      str_field(&pack, "expiresAt")
    );
    assert!(
      request_expiry > in_eleven_minutes,
      "pending request must not expire within 10 minutes: {}",
      str_field(&request, "expiresAt")
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn confirming_pack_restamps_delivery_ttl_from_confirmation() {
    // The 10-minute delivery window must be measured from the moment of human
    // confirmation, not from request creation, so a confirmed pack is retrievable
    // for a full short window afterwards (and not longer).
    use_test_vault_key();
    let path = temp_vault_path("confirm-restamps-delivery-ttl");
    let source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Schedule note",
      "Morning routine is a walk at 7am.",
    )
    .expect("source");
    approve_candidate_at_path(&path, source.candidate_ids.first().expect("candidate"), None)
      .expect("approve candidate");
    let built = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "Help me plan my morning.",
      None,
      Some("personal"),
      Some("always_review"),
    )
    .expect("context pack");
    confirm_context_pack_at_path(&path, &built.pack_id).expect("confirm pack");

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open");
    let saved = load_vault_json_from_connection(&connection).expect("vault json");
    let pack = find_vault_item_by_id(&saved, "contextPacks", &built.pack_id).expect("pack");
    let now = chrono::Utc::now();
    let pack_expiry = chrono::DateTime::parse_from_rfc3339(&str_field(&pack, "expiresAt"))
      .expect("pack expiresAt")
      .with_timezone(&chrono::Utc);
    assert!(
      pack_expiry > now,
      "confirmed pack must not be already expired: {}",
      str_field(&pack, "expiresAt")
    );
    assert!(
      pack_expiry <= now + chrono::Duration::minutes(11),
      "confirmed pack delivery TTL must be re-stamped to ~10 minutes from confirmation: {}",
      str_field(&pack, "expiresAt")
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn native_access_policy_update_invalidates_existing_client_packs() {
    use_test_vault_key();
    let path = temp_vault_path("policy-update-invalidates-pack");
    let source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Care note",
      "Doctor follow-up is scheduled for next month.",
    )
    .expect("source");
    approve_candidate_at_path(
      &path,
      source.candidate_ids.first().expect("candidate"),
      None,
    )
    .expect("approve candidate");
    let built = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "Help me with the doctor follow-up.",
      Some("普段使うAIへの回答文脈"),
      Some("sensitive"),
      Some("always_review"),
    )
    .expect("context pack");
    confirm_context_pack_at_path(&path, &built.pack_id).expect("confirm pack");

    let updated = update_access_policy_at_path(
      &path,
      "conn_chatgpt",
      None,
      None,
      Some(vec!["documents_and_evidence".to_string()]),
      None,
    )
    .expect("policy update");
    let saved: Value = serde_json::from_str(&updated.payload).expect("vault json");
    let pack = find_vault_item_by_id(&saved, "contextPacks", &built.pack_id).expect("pack");
    let request =
      find_vault_item_by_id(&saved, "contextPackRequests", &built.request_id).expect("request");
    let status =
      get_context_request_status_for_client_at_path(&path, &built.request_id, "conn_chatgpt")
        .expect("request status");
    let reconfirm_error = match confirm_context_pack_at_path(&path, &built.pack_id) {
      Ok(_) => panic!("cancelled pack should not be reconfirmed"),
      Err(error) => error,
    };

    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("cancelled")
    );
    assert_eq!(
      request.get("status").and_then(Value::as_str),
      Some("expired")
    );
    assert_eq!(status.status, "expired");
    assert!(status.context_pack.is_none());
    assert!(reconfirm_error.contains("cancelled"));
    remove_temp_vault(&path);
  }

  #[test]
  fn native_policy_domain_allowlist_fails_closed_for_empty_or_invalid_persistence() {
    let empty_policy = json!({
      "accessPolicies": [
        {
          "id": "policy_chatgpt",
          "clientId": "conn_chatgpt",
          "domainAllowlist": []
        }
      ]
    });
    let invalid_policy = json!({
      "accessPolicies": [
        {
          "id": "policy_chatgpt",
          "clientId": "conn_chatgpt",
          "domainAllowlist": ["health_and_care", "not_a_domain"]
        }
      ]
    });
    let empty_allowlist = policy_domain_allowlist_for_client(&empty_policy, "conn_chatgpt");
    let invalid_allowlist = policy_domain_allowlist_for_client(&invalid_policy, "conn_chatgpt");

    assert!(!empty_allowlist.contains(&"health_and_care".to_string()));
    assert!(!invalid_allowlist.contains(&"health_and_care".to_string()));
    assert!(empty_allowlist.contains(&"documents_and_evidence".to_string()));
    assert!(invalid_allowlist.contains(&"documents_and_evidence".to_string()));
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
      .query_row(
        "SELECT COUNT(*) FROM facts_fts WHERE facts_fts MATCH 'concrete'",
        [],
        |row| row.get(0),
      )
      .expect("fts count");

    assert_eq!(fact_count, 1);
    assert_eq!(fts_count, 1);
    remove_temp_vault(&path);
  }

  #[test]
  fn native_candidate_approval_can_supersede_existing_fact() {
    use_test_vault_key();
    let path = temp_vault_path("candidate-supersede");
    let old_source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Old policy note",
      "Insurance policy renews on 2026-08-31.",
    )
    .expect("old source ingest");
    let old_candidate_id = old_source
      .candidate_ids
      .first()
      .cloned()
      .expect("old candidate id");
    let old_review =
      approve_candidate_at_path(&path, &old_candidate_id, None).expect("approve old candidate");
    let old_fact_id = old_review.fact_id.expect("old fact id");
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
    let new_source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "New policy note",
      "Insurance policy renews on 2027-08-31.",
    )
    .expect("new source ingest");
    let new_candidate_id = new_source
      .candidate_ids
      .first()
      .cloned()
      .expect("new candidate id");

    let result = approve_candidate_with_options_at_path(
      &path,
      &new_candidate_id,
      None,
      std::slice::from_ref(&old_fact_id),
    )
    .expect("approve replacement candidate");
    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let new_fact_id = result.fact_id.clone().expect("new fact id");
    let old_fact = find_vault_item_by_id(&saved, "facts", &old_fact_id).expect("old fact");
    let new_fact = find_vault_item_by_id(&saved, "facts", &new_fact_id).expect("new fact");
    let pack = saved
      .get("contextPacks")
      .and_then(Value::as_array)
      .and_then(|packs| packs.first())
      .expect("context pack");

    assert_eq!(result.superseded_fact_ids, vec![old_fact_id.clone()]);
    assert_eq!(result.invalidated_pack_count, 1);
    assert_eq!(
      new_fact
        .get("supersedesFactIds")
        .cloned()
        .unwrap_or_else(|| json!([])),
      json!([old_fact_id.clone()])
    );
    assert_eq!(
      old_fact.get("status").and_then(Value::as_str),
      Some("superseded")
    );
    assert_eq!(
      old_fact.get("supersededByFactId").and_then(Value::as_str),
      Some(new_fact_id.as_str())
    );
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("cancelled")
    );

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let old_search =
      search_facts_in_connection(&connection, "2026", None, None, 20).expect("old search");
    let new_search =
      search_facts_in_connection(&connection, "2027", None, None, 20).expect("new search");
    let normalized_old_status: String = connection
      .query_row(
        "SELECT status FROM facts WHERE id = ?1",
        params![old_fact_id],
        |row| row.get(0),
      )
      .expect("old status");
    let normalized_new_supersedes: String = connection
      .query_row(
        "SELECT supersedes_fact_ids FROM facts WHERE id = ?1",
        params![new_fact_id],
        |row| row.get(0),
      )
      .expect("new supersedes");

    assert!(old_search.is_empty());
    assert_eq!(new_search.len(), 1);
    assert_eq!(normalized_old_status, "superseded");
    assert!(normalized_new_supersedes.contains("fact_"));
    remove_temp_vault(&path);
  }

  #[test]
  fn native_source_ingest_marks_conflicting_candidate_without_changing_fact() {
    use_test_vault_key();
    let path = temp_vault_path("candidate-conflict");
    let old_source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Old policy note",
      "Insurance policy renews on 2026-08-31.",
    )
    .expect("old source ingest");
    let old_candidate_id = old_source
      .candidate_ids
      .first()
      .cloned()
      .expect("old candidate id");
    let old_review =
      approve_candidate_at_path(&path, &old_candidate_id, None).expect("approve old candidate");
    let old_fact_id = old_review.fact_id.expect("old fact id");

    let new_source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "New policy note",
      "Insurance policy renews on 2027-08-31.",
    )
    .expect("new source ingest");
    let saved: Value = serde_json::from_str(&new_source.payload).expect("saved vault json");
    let candidate =
      find_vault_item_by_id(&saved, "candidates", &new_source.candidate_ids[0]).expect("candidate");
    let old_fact = find_vault_item_by_id(&saved, "facts", &old_fact_id).expect("old fact");

    assert_eq!(
      old_fact.get("status").and_then(Value::as_str),
      Some("active")
    );
    assert_eq!(
      candidate
        .get("conflictWithFactIds")
        .cloned()
        .unwrap_or_else(|| json!([])),
      json!([old_fact_id.clone()])
    );
    assert!(candidate
      .get("conflictReason")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .contains("既存のActive Fact"));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let normalized_conflicts: String = connection
      .query_row(
        "SELECT conflict_with_fact_ids FROM memory_candidates WHERE id = ?1",
        params![new_source.candidate_ids[0].clone()],
        |row| row.get(0),
      )
      .expect("normalized candidate conflicts");

    assert!(normalized_conflicts.contains(&old_fact_id));
    remove_temp_vault(&path);
  }

  #[test]
  fn native_source_ingest_marks_current_value_conflict_without_date() {
    use_test_vault_key();
    let path = temp_vault_path("candidate-current-value-conflict");
    let old_source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Old address note",
      "Current address: 1 Main Street, Apt 2.",
    )
    .expect("old source ingest");
    let old_candidate_id = old_source
      .candidate_ids
      .first()
      .cloned()
      .expect("old candidate id");
    let old_review =
      approve_candidate_at_path(&path, &old_candidate_id, None).expect("approve old candidate");
    let old_fact_id = old_review.fact_id.expect("old fact id");

    let new_source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "New address note",
      "Current address: 2 Oak Avenue.",
    )
    .expect("new source ingest");
    let saved: Value = serde_json::from_str(&new_source.payload).expect("saved vault json");
    let candidate =
      find_vault_item_by_id(&saved, "candidates", &new_source.candidate_ids[0]).expect("candidate");
    let old_fact = find_vault_item_by_id(&saved, "facts", &old_fact_id).expect("old fact");

    assert_eq!(
      old_fact.get("status").and_then(Value::as_str),
      Some("active")
    );
    assert_eq!(
      candidate
        .get("conflictWithFactIds")
        .cloned()
        .unwrap_or_else(|| json!([])),
      json!([old_fact_id.clone()])
    );
    assert!(candidate
      .get("conflictReason")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .contains("既存のActive Fact"));

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open test vault");
    let normalized_conflicts: String = connection
      .query_row(
        "SELECT conflict_with_fact_ids FROM memory_candidates WHERE id = ?1",
        params![new_source.candidate_ids[0].clone()],
        |row| row.get(0),
      )
      .expect("normalized candidate conflicts");

    assert!(normalized_conflicts.contains(&old_fact_id));
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

    let reviewed =
      update_candidate_status_at_path(&path, &candidate_id, "archived").expect("archive candidate");
    let saved: Value = serde_json::from_str(&reviewed.payload).expect("saved vault json");
    let candidate = saved
      .get("candidates")
      .and_then(Value::as_array)
      .and_then(|candidates| candidates.first())
      .expect("candidate");

    assert_eq!(reviewed.fact_id, None);
    assert_eq!(
      candidate.get("status").and_then(Value::as_str),
      Some("archived")
    );
    assert!(saved
      .get("facts")
      .and_then(Value::as_array)
      .map(Vec::is_empty)
      .unwrap_or(false));

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
  fn approve_with_edited_text_injecting_secret_is_blocked() {
    // C1 trust-boundary fix: editing a benign candidate to inject a credential
    // must be REJECTED — the edited text's classification governs, not the
    // candidate's original detectedSensitivity.
    use_test_vault_key();
    let path = temp_vault_path("edited-text-secret-inject");
    let ingested = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Hobby",
      "I enjoy hiking on weekends",
    )
    .expect("source ingest");
    let candidate_id = ingested
      .candidate_ids
      .first()
      .expect("candidate id")
      .to_string();

    // Sanity: the candidate itself is NOT secret_never_send (it's benign).
    let conn = vault_crypto::open_encrypted_vault_connection(&path).expect("open vault");
    let vault = load_vault_json_from_connection(&conn).expect("load vault json");
    let cand = find_vault_item_by_id(&vault, "candidates", &candidate_id).expect("candidate");
    let original_tier = str_field(&cand, "detectedSensitivity");
    assert_ne!(
      original_tier, "secret_never_send",
      "Precondition: candidate must start as non-secret"
    );
    drop(conn);

    // Now approve with edited text that injects a credential.
    let secret_text = "AWS_SECRET_ACCESS_KEY=abc123secret";
    let err = approve_candidate_with_options_at_path(&path, &candidate_id, Some(secret_text), &[])
      .err()
      .expect("approval of edited-secret text must be rejected");

    // Must be blocked and no fact created.
    let conn2 = vault_crypto::open_encrypted_vault_connection(&path).expect("open vault 2");
    let fact_count: i64 = conn2
      .query_row("SELECT COUNT(*) FROM facts", [], |row| row.get(0))
      .expect("fact count");
    assert!(
      err.contains("secret") || err.contains("cannot be approved"),
      "error should mention secret rejection, got: {err}"
    );
    assert_eq!(
      fact_count, 0,
      "no fact must be created when edited text is secret"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn approve_with_edited_text_uses_edited_text_sensitivity_tier() {
    // C1 trust-boundary fix: editing a candidate to include an email address
    // must produce a fact with sensitivity == "personal" (the tier derived from
    // the EDITED text), not the original candidate's lower tier.
    use_test_vault_key();
    let path = temp_vault_path("edited-text-tier-promotion");
    let ingested = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Note",
      "generic public note with no signals",
    )
    .expect("source ingest");
    let candidate_id = ingested
      .candidate_ids
      .first()
      .expect("candidate id")
      .to_string();

    // Sanity: original candidate tier should be "public".
    let conn = vault_crypto::open_encrypted_vault_connection(&path).expect("open vault");
    let vault_val = load_vault_json_from_connection(&conn).expect("load vault json");
    let cand = find_vault_item_by_id(&vault_val, "candidates", &candidate_id).expect("candidate");
    let original_tier = str_field(&cand, "detectedSensitivity");
    assert_eq!(
      original_tier, "public",
      "Precondition: candidate must start as public"
    );
    drop(conn);

    // Approve with edited text that contains an email — should classify as "personal".
    let edited = "Contact me at alice@example.com for questions";
    let result = approve_candidate_with_options_at_path(&path, &candidate_id, Some(edited), &[])
      .expect("approval of email-edited text must succeed");

    let fact_id = result.fact_id.expect("fact id");
    let saved: Value = serde_json::from_str(&result.payload).expect("parse payload");
    let fact = find_vault_item_by_id(&saved, "facts", &fact_id).expect("new fact");
    let fact_sensitivity = str_field(&fact, "sensitivity");

    assert_eq!(
      fact_sensitivity, "personal",
      "Fact sensitivity must be derived from edited text (email => personal), not candidate's original tier (public)"
    );
    // Must NOT be eligible for zero-touch delivery (personal is above zero-touch threshold).
    assert_ne!(
      fact_sensitivity, "public",
      "Edited fact must not retain low original tier after email injection"
    );
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

    assert_eq!(
      request.get("id").and_then(Value::as_str),
      Some(request_id.as_str())
    );
    assert_eq!(
      pack.get("id").and_then(Value::as_str),
      Some(pack_id.as_str())
    );
    assert_eq!(
      request.get("status").and_then(Value::as_str),
      Some("pending_user_confirmation")
    );
    assert_eq!(items.len(), 1);
    assert_eq!(
      items[0].get("factId").and_then(Value::as_str),
      Some("fact_insurance")
    );
    assert!(items
      .iter()
      .all(|item| item.get("itemText").and_then(Value::as_str)
        != Some("Unapproved candidate text must not become trusted context.")));
    assert_eq!(snippets.len(), 1);
    assert_eq!(
      snippets[0].get("text").and_then(Value::as_str),
      Some("Insurance policy renews on 2026-09-01.")
    );
    assert!(!snippets[0]
      .get("text")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .contains("RAW_POLICY_BODY"));
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
      public_source
        .candidate_ids
        .first()
        .expect("public candidate"),
      None,
    )
    .expect("approve public candidate");
    let private_approval = approve_candidate_at_path(
      &path,
      private_source
        .candidate_ids
        .first()
        .expect("private candidate"),
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
    let built_pack =
      find_vault_item_by_id(&built_vault, "contextPacks", &built.pack_id).expect("built pack");
    assert!(built_pack
      .get("items")
      .and_then(Value::as_array)
      .map(|items| {
        items
          .iter()
          .any(|item| item.get("factId").and_then(Value::as_str) == Some(private_fact_id.as_str()))
      })
      .unwrap_or(false));

    let edited =
      update_context_pack_item_visibility_at_path(&path, &built.pack_id, &private_fact_id, false)
        .expect("minimize pack");
    let edited_vault: Value = serde_json::from_str(&edited.payload).expect("edited vault");
    let edited_pack =
      find_vault_item_by_id(&edited_vault, "contextPacks", &built.pack_id).expect("edited pack");
    assert_eq!(
      edited_pack
        .get("confirmationStatus")
        .and_then(Value::as_str),
      Some("edited_by_user")
    );
    assert!(edited_pack
      .get("items")
      .and_then(Value::as_array)
      .map(|items| {
        items
          .iter()
          .all(|item| item.get("factId").and_then(Value::as_str) != Some(private_fact_id.as_str()))
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
    let status =
      get_context_request_status_at_path(&path, &built.request_id).expect("request status");
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
    assert!(!client_pack.to_string().contains(&private_fact_id));
    remove_temp_vault(&path);
  }

  #[test]
  fn confirmed_context_pack_expires_before_external_status_return() {
    use_test_vault_key();
    let path = temp_vault_path("confirmed-pack-expiry");
    let source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Travel reminder",
      "Passport expires on 2028-05-01.",
    )
    .expect("source");
    approve_candidate_at_path(
      &path,
      source.candidate_ids.first().expect("candidate"),
      None,
    )
    .expect("approve candidate");
    let built = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "When does my passport expire?",
      Some("普段使うAIへの回答文脈"),
      Some("personal"),
      Some("explicit_sensitive"),
    )
    .expect("context pack");
    confirm_context_pack_at_path(&path, &built.pack_id).expect("confirm pack");

    let mut connection = open_vault_db_at_path(&path).expect("open vault");
    let mut vault = load_vault_json_from_connection(&connection).expect("load vault");
    for request in vault
      .get_mut("contextPackRequests")
      .and_then(Value::as_array_mut)
      .expect("requests")
    {
      if str_field(request, "id") == built.request_id {
        request["expiresAt"] = Value::String("2000-01-01T00:00:00.000Z".to_string());
      }
    }
    for pack in vault
      .get_mut("contextPacks")
      .and_then(Value::as_array_mut)
      .expect("packs")
    {
      if str_field(pack, "id") == built.pack_id {
        pack["expiresAt"] = Value::String("2000-01-01T00:00:00.000Z".to_string());
      }
    }
    save_vault_json_with_projection(&mut connection, &vault).expect("save expired vault");

    let status =
      get_context_request_status_for_client_at_path(&path, &built.request_id, "conn_chatgpt")
        .expect("request status");

    assert_eq!(status.status, "expired");
    assert!(status.context_pack.is_none());
    remove_temp_vault(&path);
  }

  #[test]
  fn confirmed_context_pack_revalidates_current_fact_before_external_status_return() {
    use_test_vault_key();
    let path = temp_vault_path("confirmed-pack-current-fact");
    let source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Passport reminder",
      "Passport expires on 2028-05-01.",
    )
    .expect("source");
    let approved = approve_candidate_at_path(
      &path,
      source.candidate_ids.first().expect("candidate"),
      None,
    )
    .expect("approve candidate");
    let fact_id = approved.fact_id.expect("approved fact id");
    let built = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "When does my passport expire?",
      Some("普段使うAIへの回答文脈"),
      Some("personal"),
      Some("explicit_sensitive"),
    )
    .expect("context pack");
    confirm_context_pack_at_path(&path, &built.pack_id).expect("confirm pack");

    let ok_status =
      get_context_request_status_for_client_at_path(&path, &built.request_id, "conn_chatgpt")
        .expect("request status before fact drift");
    assert_eq!(ok_status.status, "fulfilled");
    assert!(ok_status.context_pack.is_some());

    let mut connection = open_vault_db_at_path(&path).expect("open vault");
    let mut vault = load_vault_json_from_connection(&connection).expect("load vault");
    for fact in vault
      .get_mut("facts")
      .and_then(Value::as_array_mut)
      .expect("facts")
    {
      if str_field(fact, "id") == fact_id {
        fact["status"] = Value::String("user_hidden".to_string());
      }
    }
    save_vault_json_with_projection(&mut connection, &vault).expect("save drifted vault");

    let blocked_status =
      get_context_request_status_for_client_at_path(&path, &built.request_id, "conn_chatgpt")
        .expect("request status after fact drift");

    assert_eq!(blocked_status.status, "expired");
    assert!(blocked_status.context_pack.is_none());
    remove_temp_vault(&path);
  }

  #[test]
  fn confirmed_context_pack_delivers_fact_within_ceiling_despite_cautious_source_sensitivity() {
    use_test_vault_key();
    let path = temp_vault_path("pack-cautious-source-sensitivity");
    let source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Weekly routine",
      "Passport expires on 2028-05-01.",
    )
    .expect("source");
    let approved = approve_candidate_at_path(
      &path,
      source.candidate_ids.first().expect("candidate"),
      None,
    )
    .expect("approve candidate");
    approved.fact_id.expect("approved fact id");

    // Reproduce the in-app "承認ができない" pack-approval bug: the approved fact's own
    // sensitivity stays within the client ceiling, but its source carries a higher,
    // cautious *default* sensitivity. Delivery must honor the fact, not the source.
    {
      let mut connection = open_vault_db_at_path(&path).expect("open vault");
      let mut vault = load_vault_json_from_connection(&connection).expect("load vault");
      for source in vault
        .get_mut("sources")
        .and_then(Value::as_array_mut)
        .expect("sources")
      {
        source["defaultSensitivity"] = Value::String("sensitive".to_string());
      }
      for fact in vault
        .get_mut("facts")
        .and_then(Value::as_array_mut)
        .expect("facts")
      {
        fact["sensitivity"] = Value::String("personal".to_string());
      }
      save_vault_json_with_projection(&mut connection, &vault).expect("save vault");
    }

    let built = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "When does my passport expire?",
      Some("普段使うAIへの回答文脈"),
      Some("private_consequential"),
      Some("explicit_sensitive"),
    )
    .expect("context pack");
    confirm_context_pack_at_path(&path, &built.pack_id).expect("confirm pack");

    let status =
      get_context_request_status_for_client_at_path(&path, &built.request_id, "conn_chatgpt")
        .expect("request status");
    assert_eq!(status.status, "fulfilled");
    assert!(status.context_pack.is_some());
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
    let warnings = pack
      .get("warnings")
      .and_then(Value::as_array)
      .expect("warnings");

    assert!(items.is_empty());
    assert!(excluded.iter().any(|item| {
      item.get("referencedId").and_then(Value::as_str) == Some("fact_health")
        && item.get("reason").and_then(Value::as_str) == Some("sensitivity_policy")
    }));
    assert!(warnings
      .iter()
      .any(|warning| { warning.get("kind").and_then(Value::as_str) == Some("policy_limited") }));
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("not_required")
    );
  }

  #[test]
  fn native_context_pack_applies_domain_allowlist_and_approval_threshold() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_test_vault_connection(&connection);
    let payload = r#"
    {
      "version": 2,
      "sources": [],
      "candidates": [],
      "facts": [
        {
          "id": "fact_health_allowed",
          "factText": "Doctor follow-up is scheduled for next month.",
          "domain": "health_and_care",
          "factType": "support_need",
          "sourceIds": [],
          "sensitivity": "personal",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:20:00.000Z"
        },
        {
          "id": "fact_work_blocked",
          "factText": "Work shift starts at 9am.",
          "domain": "work_and_education",
          "factType": "routine",
          "sourceIds": [],
          "sensitivity": "public",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:21:00.000Z"
        }
      ],
      "accessPolicies": [
        {
          "id": "policy_health_only",
          "clientId": "conn_chatgpt",
          "scopes": ["context_pack.request"],
          "domainAllowlist": ["health_and_care"],
          "sensitivityCeiling": "sensitive",
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
      "conn_chatgpt",
      "ChatGPT",
      "Help me with the doctor follow-up and work shift.",
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
    let request = vault
      .get("contextPackRequests")
      .and_then(Value::as_array)
      .and_then(|requests| requests.first())
      .expect("request");
    let items = pack.get("items").and_then(Value::as_array).expect("items");
    let excluded = pack
      .get("excludedItems")
      .and_then(Value::as_array)
      .expect("excluded");

    assert!(items
      .iter()
      .any(|item| { item.get("factId").and_then(Value::as_str) == Some("fact_health_allowed") }));
    assert!(excluded.iter().any(|item| {
      item.get("referencedId").and_then(Value::as_str) == Some("fact_work_blocked")
        && item.get("reason").and_then(Value::as_str) == Some("domain_policy")
    }));
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("pending_user_confirmation")
    );
    assert_eq!(
      request.get("status").and_then(Value::as_str),
      Some("pending_user_confirmation")
    );
    let restore_error = restore_fact_to_context_pack(
      &connection,
      pack,
      "fact_work_blocked",
      "sensitive",
      &["health_and_care".to_string()],
    )
    .expect_err("domain-limited fact cannot be restored");
    assert!(restore_error.contains("allowed life domains"));
  }

  #[test]
  fn native_context_pack_policy_fails_closed_for_invalid_or_widened_ceiling() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_test_vault_connection(&connection);
    let payload = r#"
    {
      "version": 2,
      "sources": [],
      "candidates": [],
      "facts": [
        {
          "id": "fact_public",
          "factText": "Preferred display name is Kota.",
          "domain": "identity_and_profile",
          "factType": "identity",
          "sourceIds": [],
          "sensitivity": "public",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:20:00.000Z"
        },
        {
          "id": "fact_personal",
          "factText": "Doctor follow-up is scheduled for next month.",
          "domain": "health_and_care",
          "factType": "support_need",
          "sourceIds": [],
          "sensitivity": "personal",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:21:00.000Z"
        },
        {
          "id": "fact_sensitive",
          "factText": "Sensitive care plan should stay tightly controlled.",
          "domain": "health_and_care",
          "factType": "support_need",
          "sourceIds": [],
          "sensitivity": "sensitive",
          "confidence": "source_backed",
          "status": "active",
          "createdAt": "2026-06-12T00:00:00.000Z",
          "approvedAt": "2026-06-12T00:10:00.000Z",
          "updatedAt": "2026-06-12T00:22:00.000Z"
        }
      ],
      "accessPolicies": [
        {
          "id": "policy_chatgpt",
          "clientId": "conn_chatgpt",
          "scopes": ["context_pack.request"],
          "domainAllowlist": ["identity_and_profile", "health_and_care"],
          "sensitivityCeiling": "personal",
          "requiresApprovalAbove": "not_a_tier",
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
      "conn_chatgpt",
      "ChatGPT",
      "Help me with the doctor follow-up and care plan.",
      None,
      Some("sensitive"),
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
    let excluded = pack
      .get("excludedItems")
      .and_then(Value::as_array)
      .expect("excluded");

    assert_eq!(
      request.get("sensitivityCeiling").and_then(Value::as_str),
      Some("personal")
    );
    assert!(items
      .iter()
      .any(|item| { item.get("factId").and_then(Value::as_str) == Some("fact_personal") }));
    assert!(excluded.iter().any(|item| {
      item.get("referencedId").and_then(Value::as_str) == Some("fact_sensitive")
        && item.get("reason").and_then(Value::as_str) == Some("sensitivity_policy")
    }));
    assert_eq!(
      pack.get("confirmationStatus").and_then(Value::as_str),
      Some("pending_user_confirmation")
    );

    let invalid_payload = payload.replace(
      "\"sensitivityCeiling\": \"personal\"",
      "\"sensitivityCeiling\": \"not_a_tier\"",
    );
    let mut invalid_connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_test_vault_connection(&invalid_connection);
    sync_normalized_tables(&mut invalid_connection, &invalid_payload).expect("sync invalid");
    let mut invalid_vault: Value = serde_json::from_str(&invalid_payload).expect("invalid vault");
    create_native_context_pack_request_in_connection(
      &invalid_connection,
      &mut invalid_vault,
      "conn_chatgpt",
      "ChatGPT",
      "Help me with the doctor follow-up.",
      None,
      None,
      Some("explicit_sensitive"),
    )
    .expect("invalid policy context pack");
    let invalid_request = invalid_vault
      .get("contextPackRequests")
      .and_then(Value::as_array)
      .and_then(|requests| requests.first())
      .expect("invalid request");
    let invalid_pack = invalid_vault
      .get("contextPacks")
      .and_then(Value::as_array)
      .and_then(|packs| packs.first())
      .expect("invalid pack");
    let invalid_items = invalid_pack
      .get("items")
      .and_then(Value::as_array)
      .expect("invalid items");
    let invalid_excluded = invalid_pack
      .get("excludedItems")
      .and_then(Value::as_array)
      .expect("invalid excluded");

    assert_eq!(
      invalid_request
        .get("sensitivityCeiling")
        .and_then(Value::as_str),
      Some("public")
    );
    assert!(invalid_items
      .iter()
      .any(|item| { item.get("factId").and_then(Value::as_str) == Some("fact_public") }));
    assert!(invalid_excluded.iter().any(|item| {
      item.get("referencedId").and_then(Value::as_str) == Some("fact_personal")
        && item.get("reason").and_then(Value::as_str) == Some("sensitivity_policy")
    }));
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
    let results = search_facts_in_connection(&connection, "insurance OR passport", None, None, 20)
      .expect("search");

    assert_eq!(results.len(), 0);
    assert_eq!(
      fts_query_from_user_input("insurance OR passport").as_deref(),
      Some("\"insurance\" AND \"OR\" AND \"passport\"")
    );
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

    let result =
      save_vault_state_payload(&mut connection, "{\"local\":true}", Some("old-revision"))
        .expect("save result");
    let stored_payload: String = connection
      .query_row(
        "SELECT payload FROM vault_state WHERE key = ?1",
        params![VAULT_STATE_KEY],
        |row| row.get(0),
      )
      .expect("stored payload");

    assert!(result.conflict);
    assert_eq!(
      result.current_updated_at.as_deref(),
      Some("external-revision")
    );
    assert_eq!(
      result.current_payload.as_deref(),
      Some("{\"external\":true}")
    );
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
    let (server, _) = life_context_claude_server_config_for_paths(
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
  fn login_item_plist_runs_only_the_current_app_binary() {
    let plist = login_item_plist_for_path(
      LOGIN_ITEM_LABEL,
      &PathBuf::from("/Applications/Life Context Vault.app/Contents/MacOS/life-context-vault"),
    );

    assert!(plist.contains(LOGIN_ITEM_LABEL));
    assert!(plist.contains("<key>ProgramArguments</key>"));
    assert!(
      plist.contains("/Applications/Life Context Vault.app/Contents/MacOS/life-context-vault")
    );
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

  #[test]
  fn windows_startup_command_runs_only_the_current_app_binary() {
    let command = windows_login_item_command_for_path(&PathBuf::from(
      r#"C:\Users\Kota\AppData\Local\Life Context Vault\life-context-vault.exe"#,
    ));

    assert!(command.contains("start \"\""));
    assert!(command.contains("life-context-vault.exe"));
    assert!(!command.contains("LCV_VAULT_DB_KEY"));
    assert!(!command.contains("ContextPack"));
  }

  #[test]
  fn linux_desktop_entry_runs_only_the_current_app_binary() {
    let desktop = linux_login_item_desktop_for_path(&PathBuf::from(
      "/opt/Life Context Vault/life-context-vault",
    ));

    assert!(desktop.contains("[Desktop Entry]"));
    assert!(desktop.contains("Type=Application"));
    assert!(desktop.contains("Exec=\"/opt/Life Context Vault/life-context-vault\""));
    assert!(desktop.contains("X-GNOME-Autostart-enabled=true"));
    assert!(!desktop.contains("LCV_VAULT_DB_KEY"));
    assert!(!desktop.contains("ContextPack"));
  }

  #[test]
  fn close_hides_to_background_without_stopping_managed_ai_access() {
    assert_eq!(
      window_lifecycle_decision(WindowLifecycleEventKind::CloseRequested),
      WindowLifecycleDecision::HideToBackground
    );
    assert_eq!(
      window_lifecycle_decision(WindowLifecycleEventKind::Destroyed),
      WindowLifecycleDecision::Ignore
    );
    assert_eq!(
      window_lifecycle_decision(WindowLifecycleEventKind::Other),
      WindowLifecycleDecision::Ignore
    );
  }

  #[test]
  fn standing_delivery_flag_governs_mcp_auto_delivery() {
    use_test_vault_key();
    let path = temp_vault_path("standing-delivery-flag");
    // Use an email address so the classifier marks the fact as classified=true,
    // confidence="high" — required for zero-touch delivery under Task 7's new gate.
    let source = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Contact reminder",
      "Contact alice@example.com for schedule details.",
    )
    .expect("source");
    approve_candidate_at_path(
      &path,
      source.candidate_ids.first().expect("candidate"),
      None,
    )
    .expect("approve candidate");

    // Connection opted into standing delivery, request approval mode = None (core decides).
    // Item is classified=true, confidence="high" → zero-touch eligible → not_required.
    set_connection_standing_delivery_at_path(&path, "conn_chatgpt", true).expect("enable");
    let auto = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "How do I contact alice about the schedule?",
      Some("普段使うAIへの回答文脈"),
      Some("personal"),
      None,
    )
    .expect("auto pack");
    assert_eq!(auto.confirmation_status, "not_required");
    assert!(
      auto.context_pack.is_some(),
      "classified item with standing delivery must auto-deliver"
    );

    // Same connection with standing delivery OFF must pend.
    set_connection_standing_delivery_at_path(&path, "conn_chatgpt", false).expect("disable");
    let pend = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "When does my passport expire?",
      Some("普段使うAIへの回答文脈"),
      Some("private_consequential"),
      None,
    )
    .expect("pending pack");
    assert_eq!(pend.confirmation_status, "pending_user_confirmation");
    assert!(
      pend.context_pack.is_none(),
      "strict connection must not auto-deliver"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn new_policy_created_by_ensure_defaults_standing_delivery_on() {
    use_test_vault_key();
    let path = temp_vault_path("new-policy-standing-default");
    let mut connection = open_vault_db_at_path(&path).expect("open vault");
    let mut vault = empty_vault_json();
    // No policy exists yet for conn_chatgpt
    ensure_access_policy_for_client(&mut vault, "conn_chatgpt");
    save_vault_json_with_projection(&mut connection, &vault).expect("save");
    drop(connection);

    let connection = open_vault_db_at_path(&path).expect("reopen vault");
    let vault = load_vault_json_from_connection(&connection).expect("load vault");
    assert!(
      connection_standing_delivery_enabled(&vault, "conn_chatgpt"),
      "brand-new policy must default standingDeliveryEnabled to true"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn legacy_policy_without_flag_stays_strict() {
    use_test_vault_key();
    let path = temp_vault_path("legacy-policy-strict");
    let mut connection = open_vault_db_at_path(&path).expect("open vault");
    let mut vault = empty_vault_json();
    // Simulate a legacy/upgraded vault: policy persisted WITHOUT standingDeliveryEnabled
    push_json_array(
      &mut vault,
      "accessPolicies",
      json!({
        "id": "policy_chatgpt",
        "clientId": "conn_chatgpt",
        "scopes": [],
        "domainAllowlist": [],
        "sensitivityCeiling": "private_consequential",
        "requiresApprovalAbove": "personal",
        "passiveCaptureAllowed": false,
        "createdAt": "2024-01-01T00:00:00.000Z",
        "updatedAt": "2024-01-01T00:00:00.000Z"
        // standingDeliveryEnabled deliberately absent
      }),
    );
    save_vault_json_with_projection(&mut connection, &vault).expect("save");
    drop(connection);

    let connection = open_vault_db_at_path(&path).expect("reopen vault");
    let vault = load_vault_json_from_connection(&connection).expect("load vault");
    assert!(
      !connection_standing_delivery_enabled(&vault, "conn_chatgpt"),
      "legacy policy without flag must stay strict (no backfill)"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn fresh_default_vault_connections_have_standing_delivery_on() {
    use_test_vault_key();
    let path = temp_vault_path("fresh-vault-standing");
    let mut connection = open_vault_db_at_path(&path).expect("open vault");
    let mut vault = empty_vault_json();
    // Simulate fresh install: ensure policies for the canonical connection IDs
    for client_id in &[
      "conn_chatgpt",
      "conn_claude_desktop",
      "conn_gemini",
      "conn_codex",
    ] {
      ensure_access_policy_for_client(&mut vault, client_id);
    }
    save_vault_json_with_projection(&mut connection, &vault).expect("save");
    drop(connection);

    let connection = open_vault_db_at_path(&path).expect("reopen vault");
    let vault = load_vault_json_from_connection(&connection).expect("load vault");
    for client_id in &[
      "conn_chatgpt",
      "conn_claude_desktop",
      "conn_gemini",
      "conn_codex",
    ] {
      assert!(
        connection_standing_delivery_enabled(&vault, client_id),
        "fresh install connection {client_id} must have standingDeliveryEnabled=true"
      );
    }
    remove_temp_vault(&path);
  }

  // ── classify_sensitivity tests ─────────────────────────────────────────────

  #[test]
  fn classify_sensitivity_no_signal_returns_public_unclassified() {
    let r = classify_sensitivity("Today I went for a walk in the park.");
    assert_eq!(r.tier, "public");
    assert_eq!(r.confidence, "low");
    assert!(!r.classified);
    assert!(r.reasons.is_empty());
  }

  #[test]
  fn classify_sensitivity_email_returns_personal_high() {
    let r = classify_sensitivity("Contact me at alice@example.com for details.");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
    assert!(r.reasons.iter().any(|s| s.contains("email")));
  }

  #[test]
  fn classify_sensitivity_credential_assignment_returns_secret_never_send_high() {
    let r = classify_sensitivity("password=hunter2");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_credential_colon_returns_secret_never_send_high() {
    let r = classify_sensitivity("token: abc123xyz");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_api_key_assignment_returns_secret_never_send_high() {
    let r = classify_sensitivity("api_key=sk-1234567890");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_bare_password_returns_secret_never_send_low() {
    // Bare keyword only (no assignment) → low confidence
    let r = classify_sensitivity("Remember to update your password sometime.");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_bare_token_returns_secret_never_send_low() {
    let r = classify_sensitivity("The token was lost.");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_bare_national_id_returns_secret_never_send_low() {
    let r = classify_sensitivity("Please bring your national id to the office.");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_bare_bank_account_returns_secret_never_send_low() {
    let r = classify_sensitivity("I need your bank account number.");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_japanese_identity_kw_returns_secret_never_send_low() {
    let r = classify_sensitivity("口座番号を教えてください。");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_japanese_my_number_returns_secret_never_send_low() {
    let r = classify_sensitivity("マイナンバーの確認が必要です。");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_japanese_credential_kw_returns_secret_never_send_low() {
    let r = classify_sensitivity("パスワードを変更してください。");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_health_keyword_returns_sensitive_low() {
    let r = classify_sensitivity("My doctor gave me a diagnosis today.");
    assert_eq!(r.tier, "sensitive");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_japanese_health_kw_returns_sensitive_low() {
    let r = classify_sensitivity("病院で診断を受けました。");
    assert_eq!(r.tier, "sensitive");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_financial_keyword_returns_private_consequential_low() {
    let r = classify_sensitivity("My salary and pension are under review.");
    assert_eq!(r.tier, "private_consequential");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_japanese_financial_kw_returns_private_consequential_low() {
    let r = classify_sensitivity("年金と給与の情報が必要です。");
    assert_eq!(r.tier, "private_consequential");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_personal_contact_keyword_returns_personal_low() {
    // "phone" alone is a bare keyword → personal/low
    let r = classify_sensitivity("Leave your phone on the desk.");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_japanese_personal_kw_returns_personal_low() {
    let r = classify_sensitivity("名前と住所を入力してください。");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "low");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_tier_ordering_secret_beats_sensitive() {
    // Text with both health keyword and password keyword → secret_never_send wins
    let r = classify_sensitivity("The patient's password is needed for diagnosis.");
    assert_eq!(r.tier, "secret_never_send");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_structured_beats_bare_same_tier() {
    // credential assignment (high) beats bare credential (low) at same tier
    let r = classify_sensitivity("The secret=abc123 is here.");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
  }

  #[test]
  fn confidence_rank_ordering() {
    assert!(confidence_rank("high") > confidence_rank("medium"));
    assert!(confidence_rank("medium") > confidence_rank("low"));
    assert_eq!(confidence_rank("low"), 0);
    assert_eq!(confidence_rank("high"), 2);
  }

  // ── Task-5 review: zero-separator credential compounds ────────────────────
  #[test]
  fn classify_sensitivity_apikey_no_separator_returns_secret_never_send_high() {
    // "apikey=sk-123" must match structured credential assignment (high confidence)
    // TS regex: api[_\s-]?key  (separator is optional)
    let r = classify_sensitivity("apikey=sk-123");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_privatekey_no_separator_returns_secret_never_send_high() {
    let r = classify_sensitivity("privatekey=-----BEGIN RSA PRIVATE KEY-----");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
  }

  #[test]
  fn classify_sensitivity_recoverycode_no_separator_returns_secret_never_send_high() {
    let r = classify_sensitivity("recoverycode=abc-def-ghi");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
  }

  // ── Task-5 review: bare_national_bank_ja substring-only (no false positives) ──
  #[test]
  fn classify_sensitivity_non_contiguous_kanji_does_not_trigger_ja_identity() {
    // 口, 座, 番 appear but not as the substring 口座番号 — must NOT classify as secret
    let r = classify_sensitivity("口演と座席と番地の話題です。");
    // Should not trigger secret_never_send via bare_national_bank_ja
    assert_ne!(r.tier, "secret_never_send");
  }

  // ── Parity tests: classify_sensitivity tier >= detect_sensitivity tier ─────
  // Enumerates representative inputs for each keyword group in detect_sensitivity
  // and asserts classify_sensitivity never downgrades the tier.

  fn parity_check(text: &str) {
    let old_tier = detect_sensitivity(text);
    let new_result = classify_sensitivity(text);
    let old_rank = sensitivity_rank(old_tier);
    let new_rank = sensitivity_rank(&new_result.tier) as i64;
    assert!(
      new_rank >= old_rank,
      "Parity failure for {:?}: detect_sensitivity={:?} (rank {}) but classify_sensitivity={:?} (rank {})",
      text, old_tier, old_rank, new_result.tier, new_rank
    );
  }

  #[test]
  fn classify_sensitivity_parity_secret_never_send_group() {
    // All keywords from detect_sensitivity secret_never_send group
    parity_check("password reset");
    parity_check("passcode required");
    parity_check("api key configuration");
    parity_check("token expired");
    parity_check("secret value");
    parity_check("private key file");
    parity_check("recovery code sent");
    parity_check("パスワードを忘れた");
    parity_check("秘密鍵の保管");
    parity_check("my number card");
    parity_check("national id required");
    parity_check("bank account details");
    parity_check("口座番号を入力");
    parity_check("マイナンバーの申請");
  }

  #[test]
  fn classify_sensitivity_parity_sensitive_group() {
    parity_check("health insurance");
    parity_check("medical records");
    parity_check("doctor appointment");
    parity_check("diagnosis report");
    parity_check("disability benefit");
    parity_check("legal advice");
    parity_check("minor child");
    parity_check("病院に行く");
    parity_check("診断書が必要");
    parity_check("障害者手帳");
    parity_check("給付金の申請");
    parity_check("法律相談");
    parity_check("未成年の同意");
  }

  #[test]
  fn classify_sensitivity_parity_private_consequential_group() {
    parity_check("finance report");
    parity_check("tax return");
    parity_check("pension plan");
    parity_check("insurance policy");
    parity_check("contract signed");
    parity_check("rent payment");
    parity_check("salary increase");
    parity_check("payment due");
    parity_check("税務申告");
    parity_check("年金受給");
    parity_check("保険証");
    parity_check("契約書");
    parity_check("家賃の支払い");
    parity_check("給与明細");
    parity_check("支払い完了");
  }

  #[test]
  fn classify_sensitivity_parity_personal_group() {
    parity_check("my name is Alice");
    parity_check("home address");
    parity_check("phone number");
    parity_check("email address");
    parity_check("family members");
    parity_check("名前の確認");
    parity_check("住所変更");
    parity_check("電話番号");
    parity_check("メールアドレス");
    parity_check("家族の情報");
  }

  #[test]
  fn classify_sensitivity_parity_public_group() {
    // No signals → both return public
    parity_check("The weather is nice today.");
    parity_check("I bought groceries at the store.");
    parity_check("Meeting at 3pm in the conference room.");
  }

  // ── Task 2: structured entity detectors — positive + FP guard + parity ────

  // luhn_valid helper
  #[test]
  fn luhn_valid_known_visa_true() {
    // Visa test card 4111111111111111 is Luhn-valid
    assert!(luhn_valid("4111111111111111"));
  }

  #[test]
  fn luhn_valid_non_luhn_false() {
    // 16-digit run that is NOT Luhn-valid
    assert!(!luhn_valid("1234567890123456"));
  }

  // match_card_luhn
  #[test]
  fn match_card_luhn_visa_test_card_true() {
    assert!(match_card_luhn("Card: 4111111111111111"));
  }

  #[test]
  fn match_card_luhn_grouped_mastercard_true() {
    // 5105 1051 0510 5100 is a Luhn-valid Mastercard test number
    assert!(match_card_luhn("MC: 5105 1051 0510 5100"));
  }

  #[test]
  fn match_card_luhn_non_luhn_16digits_false() {
    // 16-digit run that fails Luhn — must NOT match
    assert!(!match_card_luhn("reference: 1234567890123456"));
  }

  #[test]
  fn match_card_luhn_date_like_false() {
    // Date-like patterns must not match
    assert!(!match_card_luhn("2024-01-15"));
    assert!(!match_card_luhn("2024/01/15"));
  }

  #[test]
  fn classify_sensitivity_luhn_card_returns_secret_never_send_high() {
    let r = classify_sensitivity("Please charge card 4111111111111111 for the order.");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
    assert!(r.reasons.iter().any(|s| s.contains("Luhn")));
  }

  // match_ssn
  #[test]
  fn match_ssn_standard_format_true() {
    assert!(match_ssn("SSN: 123-45-6789"));
  }

  #[test]
  fn match_ssn_false_positive_date_false() {
    // Date 2024-01-15 has 4-2-2 grouping — must NOT match SSN (3-2-4)
    assert!(!match_ssn("Date: 2024-01-15"));
  }

  #[test]
  fn match_ssn_ip_address_false() {
    // IP 192-168-1-100 must NOT match (4-3-1-3)
    assert!(!match_ssn("IP: 192-168-1-100"));
  }

  #[test]
  fn match_ssn_followed_by_dash_false() {
    // Negative lookahead: NNN-NN-NNNN- must NOT match
    assert!(!match_ssn("ref: 123-45-6789-extra"));
  }

  #[test]
  fn classify_sensitivity_ssn_returns_secret_never_send_high() {
    let r = classify_sensitivity("My SSN is 987-65-4321.");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
    assert!(r.reasons.iter().any(|s| s.contains("SSN")));
  }

  // match_iban
  #[test]
  fn match_iban_gb_format_true() {
    assert!(match_iban("IBAN: GB82 WEST 1234 5698 7654 32"));
  }

  #[test]
  fn match_iban_de_format_true() {
    assert!(match_iban("Transfer to DE89 3704 0044 0532 0130 00"));
  }

  #[test]
  fn match_iban_short_false() {
    // Too short to be a real IBAN
    assert!(!match_iban("AB12 3456"));
  }

  #[test]
  fn classify_sensitivity_iban_returns_secret_never_send_high() {
    let r = classify_sensitivity("Wire to GB82 WEST 1234 5698 7654 32 please.");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
    assert!(r.reasons.iter().any(|s| s.contains("IBAN")));
  }

  // match_my_number
  #[test]
  fn match_my_number_with_digits_true() {
    assert!(match_my_number("マイナンバー: 1234 5678 9012"));
  }

  #[test]
  fn match_my_number_hyphenated_true() {
    assert!(match_my_number("マイナンバー 1234-5678-9012"));
  }

  #[test]
  fn match_my_number_keyword_only_false() {
    // Keyword without 12-digit number must NOT fire the high signal
    assert!(!match_my_number("マイナンバーの確認が必要です"));
  }

  #[test]
  fn classify_sensitivity_my_number_with_digits_returns_secret_never_send_high() {
    let r = classify_sensitivity("マイナンバー: 1234 5678 9012 を提出してください");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
    assert!(r.reasons.iter().any(|s| s.contains("マイナンバー")));
  }

  // match_phone
  #[test]
  fn match_phone_intl_prefix_true() {
    assert!(match_phone("+1 555 123 4567"));
  }

  #[test]
  fn match_phone_parenthesized_area_code_true() {
    assert!(match_phone("Call (555) 123-4567 now"));
  }

  #[test]
  fn match_phone_nanp_3_3_4_true() {
    assert!(match_phone("555-867-5309"));
  }

  #[test]
  fn match_phone_date_4_2_2_false() {
    // 2024-01-15 must NOT match phone
    assert!(!match_phone("Date: 2024-01-15"));
  }

  #[test]
  fn match_phone_ip_address_false() {
    // 192.168.1.100 must NOT match phone
    assert!(!match_phone("IP: 192.168.1.100"));
  }

  #[test]
  fn match_phone_version_false() {
    // 1.2.3 version string must NOT match phone
    assert!(!match_phone("version 1.2.3"));
  }

  #[test]
  fn classify_sensitivity_phone_returns_personal_high() {
    let r = classify_sensitivity("Call me at 555-867-5309.");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
    assert!(r.reasons.iter().any(|s| s.contains("phone")));
  }

  // match_address
  #[test]
  fn match_address_standard_true() {
    assert!(match_address("123 Main Street"));
  }

  #[test]
  fn match_address_multi_word_name_true() {
    assert!(match_address("42 Elm Grove Avenue"));
  }

  #[test]
  fn match_address_lowercase_suffix_false() {
    // "way" not capitalized → must NOT match (mirrors TS tightening)
    assert!(!match_address("exit 23 way out"));
  }

  #[test]
  fn match_address_no_house_number_false() {
    // No leading digit → must NOT match
    assert!(!match_address("Main Street in the city"));
  }

  #[test]
  fn classify_sensitivity_address_returns_personal_high() {
    let r = classify_sensitivity("She lives at 456 Oak Drive.");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
    assert!(r.reasons.iter().any(|s| s.contains("address")));
  }

  // match_jp_postal
  #[test]
  fn match_jp_postal_true() {
    assert!(match_jp_postal("〒100-0001 東京都千代田区"));
  }

  #[test]
  fn match_jp_postal_no_mark_false() {
    // Without 〒 must NOT match
    assert!(!match_jp_postal("100-0001 東京都"));
  }

  #[test]
  fn classify_sensitivity_jp_postal_returns_personal_high() {
    let r = classify_sensitivity("住所は〒530-0001 大阪市北区梅田です。");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "high");
    assert!(r.classified);
    assert!(r
      .reasons
      .iter()
      .any(|s| s.contains("postal") || s.contains("〒")));
  }

  // ── Parity table: each entity classifies at same tier+confidence as TS ────
  // TS tiers: card/SSN/IBAN/マイナンバー → secret_never_send/high
  //           phone/address/〒           → personal/high

  #[test]
  fn parity_structured_card_is_secret_never_send_high() {
    let r = classify_sensitivity("4111111111111111");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
  }

  #[test]
  fn parity_ssn_is_secret_never_send_high() {
    let r = classify_sensitivity("123-45-6789");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
  }

  #[test]
  fn parity_iban_is_secret_never_send_high() {
    let r = classify_sensitivity("GB82 WEST 1234 5698 7654 32");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
  }

  #[test]
  fn parity_my_number_digits_is_secret_never_send_high() {
    let r = classify_sensitivity("マイナンバー 1234 5678 9012");
    assert_eq!(r.tier, "secret_never_send");
    assert_eq!(r.confidence, "high");
  }

  #[test]
  fn parity_phone_nanp_is_personal_high() {
    let r = classify_sensitivity("555-867-5309");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "high");
  }

  #[test]
  fn parity_phone_intl_is_personal_high() {
    let r = classify_sensitivity("+1 800 555 1234");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "high");
  }

  #[test]
  fn parity_address_is_personal_high() {
    let r = classify_sensitivity("123 Main Street");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "high");
  }

  #[test]
  fn parity_jp_postal_is_personal_high() {
    let r = classify_sensitivity("〒100-0001");
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "high");
  }

  // FP guards: inputs that must NOT trigger the new structured detectors
  #[test]
  fn fp_date_does_not_trigger_phone_or_ssn() {
    // 2024-01-15 looks like NNN-NN-NNNN but isn't (4-2-2 grouping)
    let r = classify_sensitivity("Meeting on 2024-01-15.");
    assert_ne!(r.tier, "secret_never_send");
    assert!(r.confidence != "high" || r.tier == "personal" || !r.classified);
  }

  #[test]
  fn fp_ip_address_does_not_trigger_phone() {
    let r = classify_sensitivity("Server at 192.168.1.100");
    // Should not classify as personal/high from phone detector
    // IP has 3-3-1-3 dot grouping, not phone pattern
    assert!(
      r.tier != "personal"
        || r.confidence != "high"
        || !r.reasons.iter().any(|s| s.contains("phone"))
    );
  }

  #[test]
  fn fp_prose_address_does_not_trigger_address_detector() {
    // "exit 23 way out" — no Capitalized street name, lowercase suffix
    assert!(!match_address("exit 23 way out"));
  }

  #[test]
  fn fp_non_luhn_16digit_not_card() {
    // 16-digit string that fails Luhn check
    let r = classify_sensitivity("Order ref: 1234567890123456");
    assert!(
      r.tier != "secret_never_send" || r.reasons.iter().all(|s| !s.contains("Luhn")),
      "Non-Luhn 16-digit number must not trigger card detector"
    );
  }

  // ── D1: card letter-adjacency parity tests ──────────────────────────────
  #[test]
  fn parity_d1_card_letter_adjacent_left_not_matched() {
    // "VISA4111111111111111" — 'A' is ASCII-alphabetic, adjacent to the digit run.
    // TS \b\d{13,19}\b rejects this (no word boundary between 'A' and '4').
    // Rust must now also reject it.
    assert!(
      !match_card_luhn("VISA4111111111111111"),
      "letter-adjacent card (VISA4111...) must NOT match after D1 fix"
    );
  }

  #[test]
  fn parity_d1_card_underscore_adjacent_not_matched() {
    // Underscore is a JS word char, so _4111111111111111 has no \b before the digits.
    assert!(
      !match_card_luhn("_4111111111111111"),
      "underscore-adjacent card must NOT match"
    );
  }

  #[test]
  fn parity_d1_card_space_adjacent_still_matches() {
    // Space is not a word char — word boundary holds, should still match.
    assert!(
      match_card_luhn("card: 4111111111111111"),
      "space-separated valid Luhn card must still match"
    );
  }

  // ── D2: IBAN no-partial-tail parity tests ────────────────────────────────
  #[test]
  fn parity_d2_iban_no_trailing_group_not_matched() {
    // XX99AAAABBBBCCCC — body is exactly N×4 chars, no partial tail.
    // TS /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,3}\b/
    // requires a mandatory 1-3 char trailing group, so this must NOT match.
    assert!(
      !match_iban("XX99AAAABBBBCCCC"),
      "IBAN with no partial trailing group must NOT match after D2 fix"
    );
  }

  #[test]
  fn parity_d2_iban_real_de_still_matches() {
    // DE89 3704 0044 0532 0130 00 — real IBAN with 2-char trailing group "00".
    assert!(
      match_iban("DE89 3704 0044 0532 0130 00"),
      "real DE IBAN must still match after D2 fix"
    );
  }

  // ── D3: address single-char name word parity tests ───────────────────────
  #[test]
  fn parity_d3_address_single_char_name_word_not_matched() {
    // "5 A Street" — 'A' is only 1 char; TS [A-Z][A-Za-z]+ requires ≥2 chars.
    assert!(
      !match_address("5 A Street"),
      "single-char name word '5 A Street' must NOT match after D3 fix"
    );
    // Same for another suffix
    assert!(
      !match_address("5 B Way"),
      "single-char name word '5 B Way' must NOT match after D3 fix"
    );
  }

  #[test]
  fn parity_d3_address_multi_char_name_still_matches() {
    // Real address with 2+ char name words must still match.
    assert!(
      match_address("123 Main Street, Springfield"),
      "valid multi-char address must still match after D3 fix"
    );
  }

  // ── D4: underscore word-boundary parity for SSN ──────────────────────────
  #[test]
  fn parity_d4_ssn_underscore_adjacent_not_matched() {
    // "123-45-6789_record" — trailing '_' is a JS word char, so TS \b rejects this.
    // Rust must also reject it.
    assert!(
      !match_ssn("123-45-6789_record"),
      "underscore-adjacent SSN suffix must NOT match after D4 fix"
    );
  }

  #[test]
  fn parity_d4_ssn_leading_underscore_not_matched() {
    // "_123-45-6789" — leading '_' is a JS word char, so no \b before digits.
    assert!(
      !match_ssn("_123-45-6789"),
      "underscore-prefixed SSN must NOT match after D4 fix"
    );
  }

  // Task 6: sensitivityClassified + sensitivityConfidence flow through projection → pack item

  #[test]
  fn pack_item_carries_sensitivity_classified_and_confidence_from_fact_json() {
    // A fact with sensitivityClassified:true, sensitivityConfidence:"high" in canonical JSON
    // must surface both fields on the resulting pack item.
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_test_vault_connection(&connection);
    // Use contracts_and_policies domain (same as the existing pack test) so
    // rank_context_facts_in_connection scores the fact > 0.
    let payload = r#"
    {
      "version": 2,
      "sources": [
        {
          "id": "src_contract",
          "kind": "manual_note",
          "title": "Contract note",
          "origin": "manual_entry",
          "body": "Insurance policy renews on 2026-09-01.",
          "createdAt": "2026-06-01T00:00:00.000Z",
          "capturedAt": "2026-06-01T00:00:00.000Z",
          "defaultSensitivity": "private_consequential",
          "processingStatus": "ready",
          "deletionState": "active"
        }
      ],
      "candidates": [],
      "facts": [
        {
          "id": "fact_contract_classified",
          "factText": "Insurance policy renews on 2026-09-01.",
          "domain": "contracts_and_policies",
          "factType": "deadline",
          "sourceIds": ["src_contract"],
          "sensitivity": "private_consequential",
          "confidence": "source_backed",
          "status": "active",
          "sensitivityClassified": true,
          "sensitivityConfidence": "high",
          "createdAt": "2026-06-01T00:00:00.000Z",
          "approvedAt": "2026-06-01T00:10:00.000Z",
          "updatedAt": "2026-06-01T00:20:00.000Z"
        }
      ],
      "accessPolicies": [
        {
          "id": "policy_test",
          "clientId": "conn_test",
          "scopes": ["context_pack.request"],
          "domainAllowlist": ["contracts_and_policies"],
          "sensitivityCeiling": "private_consequential",
          "requiresApprovalAbove": "personal",
          "passiveCaptureAllowed": false,
          "createdAt": "2026-06-01T00:00:00.000Z",
          "updatedAt": "2026-06-01T00:00:00.000Z"
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

    let (_request_id, _pack_id) = create_native_context_pack_request_in_connection(
      &connection,
      &mut vault,
      "conn_test",
      "TestClient",
      "What should I check for insurance renewal?",
      None,
      Some("private_consequential"),
      Some("explicit_sensitive"),
    )
    .expect("pack created");

    let pack = vault
      .get("contextPacks")
      .and_then(Value::as_array)
      .and_then(|packs| packs.first())
      .expect("pack");
    let items = pack.get("items").and_then(Value::as_array).expect("items");
    assert_eq!(items.len(), 1, "expected one pack item");
    let item = &items[0];
    assert_eq!(
      item.get("factId").and_then(Value::as_str),
      Some("fact_contract_classified"),
      "factId mismatch"
    );
    assert_eq!(
      item.get("sensitivityClassified").and_then(Value::as_bool),
      Some(true),
      "sensitivityClassified must be true (from canonical JSON)"
    );
    assert_eq!(
      item.get("sensitivityConfidence").and_then(Value::as_str),
      Some("high"),
      "sensitivityConfidence must be 'high' (from canonical JSON)"
    );
  }

  #[test]
  fn pack_item_null_columns_map_to_fail_closed_defaults() {
    // A fact row with NULL sensitivity_classified / sensitivity_confidence columns
    // (legacy schema) must map to classified=false, confidence="low" (fail-closed).
    let connection = Connection::open_in_memory().expect("in-memory sqlite");
    initialize_test_vault_connection(&connection);

    // Directly INSERT a fact row with NULLs for the new columns, simulating a
    // pre-Task-6 vault that has never written sensitivityClassified.
    connection
      .execute(
        "INSERT INTO facts (
           id, fact_text, domain, fact_type, source_ids, sensitivity, confidence,
           status, created_at, approved_at, updated_at,
           sensitivity_classified, sensitivity_confidence
         ) VALUES (
           'fact_legacy', 'Legacy fact text.', 'health', 'note', '[]',
           'sensitive', 'source_backed', 'active',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
           NULL, NULL
         )",
        [],
      )
      .expect("insert legacy fact");
    connection
      .execute(
        "INSERT INTO facts_fts (fact_id, fact_text, domain) VALUES ('fact_legacy', 'Legacy fact text.', 'health')",
        [],
      )
      .expect("insert legacy fts");

    let result = fact_by_id_in_connection(&connection, "fact_legacy")
      .expect("query ok")
      .expect("fact exists");

    assert!(
      !result.sensitivity_classified,
      "NULL sensitivity_classified must map to false (fail-closed)"
    );
    assert_eq!(
      result.sensitivity_confidence, "low",
      "NULL sensitivity_confidence must map to 'low' (fail-closed)"
    );
  }

  // ── Task 7: Gate + retrieval + migration + edit-reclassify ───────────────

  #[test]
  fn gate_unclassified_item_requires_confirmation() {
    // When all items are unclassified (sensitivityClassified=false),
    // requires_confirmation should be true even with explicit_sensitive mode.
    use_test_vault_key();
    let path = temp_vault_path("gate-unclassified");
    let source_result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Plain note",
      "I enjoy hiking on weekends.",
    )
    .expect("source ingest");
    let candidate_id = source_result.candidate_ids.first().cloned().expect("cand");
    approve_candidate_at_path(&path, &candidate_id, None).expect("approve");

    // Manually clear sensitivityClassified to simulate a legacy fact.
    let mut connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open");
    let mut vault = load_vault_json_from_connection(&connection).expect("load vault");
    if let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) {
      for fact in facts.iter_mut() {
        fact["sensitivityClassified"] = Value::Bool(false);
        fact["sensitivityConfidence"] = Value::String("low".to_string());
      }
    }
    save_vault_json_with_projection(&mut connection, &vault).expect("save");
    drop(connection);

    let pack_result = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "What are my hobbies?",
      None,
      Some("sensitive"),
      Some("explicit_sensitive"),
    )
    .expect("pack");
    assert_eq!(
      pack_result.confirmation_status, "pending_user_confirmation",
      "unclassified items must require confirmation"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn gate_always_review_still_requires_confirmation_even_if_all_eligible() {
    // always_review overrides all eligibility: still requires confirmation.
    use_test_vault_key();
    let path = temp_vault_path("gate-always-review");
    let source_result = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Email note",
      "Contact me at alice@example.com for more details.",
    )
    .expect("source ingest");
    let candidate_id = source_result.candidate_ids.first().cloned().expect("cand");
    approve_candidate_at_path(&path, &candidate_id, None).expect("approve");

    let pack_result = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "How should I contact Alice?",
      None,
      Some("personal"),
      Some("always_review"),
    )
    .expect("pack");
    assert_eq!(
      pack_result.confirmation_status, "pending_user_confirmation",
      "always_review must always require confirmation"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn gate_mixed_pack_one_unclassified_requires_confirmation() {
    // A pack where one item is unclassified → requires confirmation.
    use_test_vault_key();
    let path = temp_vault_path("gate-mixed");
    let r1 = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Email note",
      "Contact me at bob@example.com",
    )
    .expect("src1");
    approve_candidate_at_path(&path, r1.candidate_ids.first().expect("c1"), None).expect("a1");

    let r2 = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Generic note",
      "I enjoy cooking pasta.",
    )
    .expect("src2");
    approve_candidate_at_path(&path, r2.candidate_ids.first().expect("c2"), None).expect("a2");

    // Clear classification on the second (last) fact only.
    let mut connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open");
    let mut vault = load_vault_json_from_connection(&connection).expect("load vault");
    if let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) {
      if let Some(fact) = facts.last_mut() {
        fact["sensitivityClassified"] = Value::Bool(false);
      }
    }
    save_vault_json_with_projection(&mut connection, &vault).expect("save");
    drop(connection);

    let pack_result = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "Tell me about Bob and cooking.",
      None,
      Some("personal"),
      Some("explicit_sensitive"),
    )
    .expect("pack");
    assert_eq!(
      pack_result.confirmation_status, "pending_user_confirmation",
      "mixed pack with one unclassified item must require confirmation"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn gate_per_client_bar_high_forces_high_confidence() {
    // When zeroTouchConfidenceBar = "high" on a connection's policy,
    // an item that is classified=true but with confidence="low" is not eligible.
    use_test_vault_key();
    let path = temp_vault_path("gate-bar-high");
    // Use an email so the fact is classified=true, confidence="high" by the
    // classifier — but we then manually lower the confidence to "low" to simulate
    // a fact that was classified below the bar.
    let r = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Contact note",
      "Contact bob@example.com about the project.",
    )
    .expect("src");
    approve_candidate_at_path(&path, r.candidate_ids.first().expect("c"), None).expect("a");

    // Lower the sensitivity confidence to "low" and set bar="high" in the policy.
    let mut connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open");
    let mut vault = load_vault_json_from_connection(&connection).expect("load vault");
    if let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) {
      for fact in facts.iter_mut() {
        // Keep classified=true but drop confidence so it falls below bar=high.
        fact["sensitivityClassified"] = Value::Bool(true);
        fact["sensitivityConfidence"] = Value::String("low".to_string());
      }
    }
    if let Some(policies) = vault
      .get_mut("accessPolicies")
      .and_then(Value::as_array_mut)
    {
      for policy in policies.iter_mut() {
        if str_field(policy, "clientId") == "conn_chatgpt" {
          policy["zeroTouchConfidenceBar"] = Value::String("high".to_string());
        }
      }
    }
    save_vault_json_with_projection(&mut connection, &vault).expect("save");
    drop(connection);

    let pack_result = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "How do I contact bob about the project?",
      None,
      Some("personal"),
      Some("explicit_sensitive"),
    )
    .expect("pack");
    // With bar=high but item confidence=low, the item is below bar → must require confirmation.
    assert_eq!(
      pack_result.confirmation_status, "pending_user_confirmation",
      "per-client bar=high: item with low confidence must require confirmation"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn retrieval_revalidation_rejects_pack_when_item_becomes_unclassified() {
    // Realistic degradation: a zero-touch (not_required) pack was built from a
    // classified Fact, then the CURRENT Fact silently became unclassified.
    // ensure_context_pack_allowed_by_current_policy re-validates against the
    // current Fact (not the frozen pack item) and must fail closed — mirroring
    // the TS analogue's `itemWasClassified && !factIsNowClassified` check.
    use_test_vault_key();
    let path = temp_vault_path("retrieval-revalidate");
    let r = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Email note",
      "Contact alice@example.com for details.",
    )
    .expect("src");
    approve_candidate_at_path(&path, r.candidate_ids.first().expect("c"), None).expect("a");

    let pack_result = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "How do I contact Alice?",
      None,
      Some("personal"),
      Some("explicit_sensitive"),
    )
    .expect("pack");
    let pack_id = pack_result.pack_id;

    // Simulate the realistic degradation: the pack item is a frozen build-time
    // snapshot that WAS classified, but the current Fact has since become
    // unclassified. Mark the pack as zero-touch (not_required).
    let mut connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open");
    let mut vault = load_vault_json_from_connection(&connection).expect("load vault");
    if let Some(packs) = vault.get_mut("contextPacks").and_then(Value::as_array_mut) {
      for pack in packs.iter_mut() {
        if str_field(pack, "id") == pack_id {
          if let Some(items) = pack.get_mut("items").and_then(Value::as_array_mut) {
            for item in items.iter_mut() {
              item["sensitivityClassified"] = Value::Bool(true);
            }
          }
          pack["confirmationStatus"] = Value::String("not_required".to_string());
        }
      }
    }
    // The current Fact silently loses its classification after the pack was built.
    if let Some(facts) = vault.get_mut("facts").and_then(Value::as_array_mut) {
      for fact in facts.iter_mut() {
        fact["sensitivityClassified"] = Value::Bool(false);
      }
    }
    if let Some(requests) = vault
      .get_mut("contextPackRequests")
      .and_then(Value::as_array_mut)
    {
      for request in requests.iter_mut() {
        request["status"] = Value::String("fulfilled".to_string());
        request["approvalMode"] = Value::String("explicit_sensitive".to_string());
      }
    }
    save_vault_json_with_projection(&mut connection, &vault).expect("save");
    drop(connection);

    let connection =
      vault_crypto::open_encrypted_vault_connection(&path).expect("open for retrieval");
    let vault = load_vault_json_from_connection(&connection).expect("load for retrieval");
    let pack = find_vault_item_by_id(&vault, "contextPacks", &pack_id).expect("pack exists");
    let validation_result = ensure_context_pack_allowed_by_current_policy(&vault, &pack);
    assert!(
      validation_result.is_err(),
      "retrieval re-validation must reject pack with unclassified items"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn migration_durability_second_open_is_no_op() {
    // After first open, classifierMigrationVersion must be 1 in vault_state.
    // Second open must not re-write (updated_at unchanged).
    use_test_vault_key();
    let path = temp_vault_path("migration-durability");
    {
      let _connection = open_vault_db_at_path(&path).expect("first open");
    }
    let version: u64 = {
      let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("raw open");
      let vault = load_vault_json_from_connection(&connection).expect("load vault");
      vault
        .get("classifierMigrationVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0)
    };
    assert_eq!(
      version, 1,
      "classifierMigrationVersion must be 1 after first open"
    );

    let first_updated_at: String = {
      let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("raw open2");
      connection
        .query_row(
          "SELECT updated_at FROM vault_state WHERE key = 'vault_state'",
          [],
          |row| row.get(0),
        )
        .expect("get updated_at")
    };
    {
      let _connection = open_vault_db_at_path(&path).expect("second open");
    }
    let second_updated_at: String = {
      let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("raw open3");
      connection
        .query_row(
          "SELECT updated_at FROM vault_state WHERE key = 'vault_state'",
          [],
          |row| row.get(0),
        )
        .expect("get updated_at2")
    };
    assert_eq!(
      first_updated_at, second_updated_at,
      "second open must not churn updated_at (migration was already applied)"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn edit_fact_reclassifies_when_text_changes() {
    // Editing a fact's text (without changing sensitivity) must re-run classify_sensitivity.
    use_test_vault_key();
    let path = temp_vault_path("edit-reclassify");
    let r = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Generic note",
      "I enjoy hiking on weekends.",
    )
    .expect("src");
    approve_candidate_at_path(&path, r.candidate_ids.first().expect("c"), None).expect("a");

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open");
    let vault = load_vault_json_from_connection(&connection).expect("load");
    let fact = vault
      .get("facts")
      .and_then(Value::as_array)
      .and_then(|facts| facts.first())
      .cloned()
      .expect("fact");
    let fact_id = str_field(&fact, "id");
    // Plain text has no sensitive signals → approved as "public".
    let original_sensitivity = str_field(&fact, "sensitivity");
    drop(connection);

    // Edit the fact text to include an email address (triggers high-confidence classification).
    // Keep the SAME sensitivity tier so this is a text-only change (not an override).
    let result = update_fact_metadata_at_path(
      &path,
      &fact_id,
      "Contact alice@example.com for hiking group details.",
      "relationships_and_household",
      &original_sensitivity, // unchanged → text-only branch fires
      None,
      None,
      None,
    )
    .expect("edit fact");

    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let updated_fact = saved
      .get("facts")
      .and_then(Value::as_array)
      .and_then(|facts| facts.iter().find(|f| str_field(f, "id") == fact_id))
      .expect("fact in vault");

    assert!(
      updated_fact
        .get("sensitivityClassified")
        .and_then(Value::as_bool)
        .unwrap_or(false),
      "editing fact text with email should re-classify as classified=true"
    );
    assert_eq!(
      updated_fact
        .get("sensitivityConfidence")
        .and_then(Value::as_str),
      Some("high"),
      "email pattern should produce high confidence"
    );
    remove_temp_vault(&path);
  }

  #[test]
  fn edit_fact_manual_sensitivity_override_clears_classification() {
    // A manual sensitivity change (even when text also changes) must set classified=false,
    // confidence=low — override wins per the plan.
    use_test_vault_key();
    let path = temp_vault_path("edit-override");
    // Use body with "email" keyword so detect_sensitivity returns "personal".
    let r = add_source_with_candidates_at_path(
      &path,
      "manual_note",
      "manual_entry",
      "Contact note",
      "Please send your email address to alice.",
    )
    .expect("src");
    approve_candidate_at_path(&path, r.candidate_ids.first().expect("c"), None).expect("a");

    let connection = vault_crypto::open_encrypted_vault_connection(&path).expect("open");
    let vault = load_vault_json_from_connection(&connection).expect("load");
    let fact = vault
      .get("facts")
      .and_then(Value::as_array)
      .and_then(|facts| facts.first())
      .cloned()
      .expect("fact");
    let fact_id = str_field(&fact, "id");
    let original_sensitivity = str_field(&fact, "sensitivity"); // "personal" from "email" keyword
    drop(connection);
    assert_eq!(
      original_sensitivity, "personal",
      "body with 'email' keyword should yield personal tier"
    );

    // Override sensitivity to "public" (manual change) while also changing text.
    let result = update_fact_metadata_at_path(
      &path,
      &fact_id,
      "Contact alice@example.com for hiking group details.", // text also changed
      "relationships_and_household",
      "public", // different from "personal" → override branch wins
      None,
      None,
      None,
    )
    .expect("edit fact");

    let saved: Value = serde_json::from_str(&result.payload).expect("saved vault json");
    let updated_fact = saved
      .get("facts")
      .and_then(Value::as_array)
      .and_then(|facts| facts.iter().find(|f| str_field(f, "id") == fact_id))
      .expect("fact in vault");

    assert_eq!(
      updated_fact
        .get("sensitivityClassified")
        .and_then(Value::as_bool),
      Some(false),
      "manual sensitivity override must set classified=false"
    );
    assert_eq!(
      updated_fact
        .get("sensitivityConfidence")
        .and_then(Value::as_str),
      Some("low"),
      "manual sensitivity override must set confidence=low"
    );
    assert_eq!(
      updated_fact.get("sensitivity").and_then(Value::as_str),
      Some("public"),
      "override sensitivity must be persisted"
    );
    remove_temp_vault(&path);
  }

  // Serialise all tests that mutate process-global env vars for the
  // `build_non_macos_key_env` code path.  A `static Mutex` is held for the
  // entire duration of each scenario; the drop-guard restores the vars even
  // when an assertion panics, so a failing scenario cannot leave stale state
  // that corrupts other tests running concurrently.
  #[cfg(not(target_os = "macos"))]
  static NON_MACOS_KEY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

  #[cfg(not(target_os = "macos"))]
  #[test]
  fn test_build_non_macos_key_env() {
    // --- scenario 1: LCV_VAULT_KEY_FILE is set, LCV_VAULT_DB_KEY is absent ---
    {
      let _guard = NON_MACOS_KEY_ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
      // A drop-guard struct restores the env vars even on panic.
      struct EnvGuard;
      impl Drop for EnvGuard {
        fn drop(&mut self) {
          std::env::remove_var("LCV_VAULT_DB_KEY");
          std::env::remove_var("LCV_VAULT_KEY_FILE");
        }
      }
      let _env_guard = EnvGuard;

      std::env::remove_var("LCV_VAULT_DB_KEY");
      std::env::set_var("LCV_VAULT_KEY_FILE", "/run/secrets/lcv.key");
      let (env, warning) = build_non_macos_key_env();
      assert_eq!(
        env.get("LCV_VAULT_KEY_FILE").map(String::as_str),
        Some("/run/secrets/lcv.key"),
        "key file path must appear in env block"
      );
      assert!(
        !env.contains_key("LCV_VAULT_DB_KEY"),
        "raw key must not appear in env block"
      );
      assert!(warning.is_none(), "no warning when key file is set");
    }

    // --- scenario 2: only LCV_VAULT_DB_KEY is set (raw key must not leak) ---
    {
      let _guard = NON_MACOS_KEY_ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
      struct EnvGuard;
      impl Drop for EnvGuard {
        fn drop(&mut self) {
          std::env::remove_var("LCV_VAULT_DB_KEY");
          std::env::remove_var("LCV_VAULT_KEY_FILE");
        }
      }
      let _env_guard = EnvGuard;

      std::env::remove_var("LCV_VAULT_KEY_FILE");
      std::env::set_var("LCV_VAULT_DB_KEY", "0123456789abcdef0123456789abcdef");
      let (env, warning) = build_non_macos_key_env();
      assert!(
        !env.contains_key("LCV_VAULT_DB_KEY"),
        "raw key must not be written to env block"
      );
      assert!(
        warning.is_some(),
        "warning must be set when only raw key is present"
      );
    }
  }

  // ── select_delivery_notification tests ─────────────────────────────────────

  fn make_delivery_event(id: &str, client_name: &str, zero_touch: bool) -> serde_json::Value {
    json!({
      "id": id,
      "eventType": "context_pack_delivered",
      "actor": "vault_core",
      "subjectType": "context_pack",
      "subjectId": format!("pack_{id}"),
      "occurredAt": "2025-01-01T00:00:00.000Z",
      "sensitivity": "low",
      "metadata": {
        "clientName": client_name,
        "zeroTouch": zero_touch
      }
    })
  }

  fn make_other_event(id: &str, event_type: &str) -> serde_json::Value {
    json!({
      "id": id,
      "eventType": event_type,
      "actor": "vault_core",
      "subjectType": "context_pack",
      "subjectId": format!("pack_{id}"),
      "occurredAt": "2025-01-01T00:00:00.000Z",
      "sensitivity": "low",
      "metadata": {
        "clientName": "ChatGPT",
        "generatedBy": "native_vault_core"
      }
    })
  }

  #[test]
  fn select_delivery_opted_out_returns_none() {
    let events = vec![make_delivery_event("audit_1", "ChatGPT", true)];
    assert_eq!(
      select_delivery_notification(&events, None, false),
      None,
      "opted-out must return None regardless of events"
    );
  }

  #[test]
  fn select_delivery_no_events_returns_none() {
    assert_eq!(
      select_delivery_notification(&[], None, true),
      None,
      "empty event list must return None"
    );
  }

  #[test]
  fn select_delivery_coalesces_per_client() {
    let events = vec![
      make_delivery_event("audit_1", "ChatGPT", true),
      make_delivery_event("audit_2", "Claude", true),
      make_delivery_event("audit_3", "ChatGPT", true),
    ];
    let notice =
      select_delivery_notification(&events, None, true).expect("should produce a DeliveryNotice");
    // Sorted by name: ChatGPT before Claude
    assert_eq!(
      notice.per_client,
      vec![("ChatGPT".to_string(), 2), ("Claude".to_string(), 1),],
      "per_client must be coalesced and sorted by name"
    );
    assert_eq!(notice.total, 3, "total must sum across all clients");
    assert_eq!(notice.newest_event_id, "audit_3");
  }

  #[test]
  fn select_delivery_confirmed_not_counted() {
    // zero_touch=false means the user confirmed → must NOT be counted
    let events = vec![
      make_delivery_event("audit_1", "ChatGPT", false),
      make_delivery_event("audit_2", "Claude", false),
    ];
    assert_eq!(
      select_delivery_notification(&events, None, true),
      None,
      "user-confirmed deliveries (zeroTouch=false) must not produce a notice"
    );
  }

  #[test]
  fn select_delivery_mixed_zero_touch_and_confirmed() {
    let events = vec![
      make_delivery_event("audit_1", "ChatGPT", false), // confirmed — skip
      make_delivery_event("audit_2", "Claude", true),   // zero-touch — count
      make_delivery_event("audit_3", "ChatGPT", true),  // zero-touch — count
    ];
    let notice = select_delivery_notification(&events, None, true)
      .expect("should notice the zero-touch deliveries");
    assert_eq!(
      notice.per_client,
      vec![("ChatGPT".to_string(), 1), ("Claude".to_string(), 1),]
    );
    assert_eq!(notice.total, 2);
    assert_eq!(notice.newest_event_id, "audit_3");
  }

  #[test]
  fn select_delivery_last_seen_excludes_older_events() {
    let events = vec![
      make_delivery_event("audit_1", "ChatGPT", true),
      make_delivery_event("audit_2", "Claude", true),
      make_delivery_event("audit_3", "ChatGPT", true),
    ];
    // last_seen_id = audit_2 → only audit_3 is new
    let notice = select_delivery_notification(&events, Some("audit_2"), true)
      .expect("audit_3 is new and should produce a notice");
    assert_eq!(
      notice.per_client,
      vec![("ChatGPT".to_string(), 1)],
      "only events after last_seen_id must be included"
    );
    assert_eq!(notice.total, 1);
    assert_eq!(notice.newest_event_id, "audit_3");
  }

  #[test]
  fn select_delivery_all_before_last_seen_returns_none() {
    let events = vec![
      make_delivery_event("audit_1", "ChatGPT", true),
      make_delivery_event("audit_2", "Claude", true),
    ];
    // All events are at/before last_seen_id
    assert_eq!(
      select_delivery_notification(&events, Some("audit_2"), true),
      None,
      "no new events after last_seen_id must return None"
    );
  }

  #[test]
  fn select_delivery_last_seen_is_first_excludes_it() {
    let events = vec![
      make_delivery_event("audit_1", "ChatGPT", true),
      make_delivery_event("audit_2", "Claude", true),
    ];
    // last_seen = audit_1 → audit_2 is new
    let notice =
      select_delivery_notification(&events, Some("audit_1"), true).expect("audit_2 is new");
    assert_eq!(notice.per_client, vec![("Claude".to_string(), 1)]);
    assert_eq!(notice.newest_event_id, "audit_2");
  }

  #[test]
  fn select_delivery_unknown_last_seen_id_returns_none() {
    // Unknown last_seen_id → treat all as already seen → no new events
    let events = vec![make_delivery_event("audit_1", "ChatGPT", true)];
    assert_eq!(
      select_delivery_notification(&events, Some("audit_unknown_xyz"), true),
      None,
      "unknown last_seen_id must treat all events as already seen"
    );
  }

  #[test]
  fn select_delivery_non_delivery_events_not_counted() {
    // context_pack_generated and context_pack_confirmed do NOT count
    let events = vec![
      make_other_event("audit_1", "context_pack_generated"),
      make_other_event("audit_2", "context_pack_confirmed"),
      make_other_event("audit_3", "context_pack_requested"),
    ];
    assert_eq!(
      select_delivery_notification(&events, None, true),
      None,
      "non-delivery event types must not produce a notice"
    );
  }

  #[test]
  fn select_delivery_notice_contains_no_fact_or_source_content() {
    // The DeliveryNotice struct must only carry client name + count
    let events = vec![make_delivery_event("audit_1", "ChatGPT", true)];
    let notice = select_delivery_notification(&events, None, true).unwrap();
    // Verify fields: only per_client (name+count), total, newest_event_id
    let (name, count) = &notice.per_client[0];
    assert_eq!(name, "ChatGPT");
    assert_eq!(*count, 1usize);
    assert_eq!(notice.total, 1);
    // If this compiled and runs, no fact/source/candidate data can exist in DeliveryNotice
    // (the struct definition enforces it at the type level)
  }

  // ── context_pack_delivered fire-once tests ─────────────────────────────────

  fn setup_vault_with_classified_fact_and_standing_delivery(path: &std::path::Path) {
    // Add a source with classified fact via the full pipeline (mirrors standing_delivery test)
    let source = add_source_with_candidates_at_path(
      path,
      "manual_note",
      "manual_entry",
      "Contact info",
      "Contact alice@example.com for schedule details.",
    )
    .expect("add source");
    approve_candidate_at_path(path, source.candidate_ids.first().expect("candidate"), None)
      .expect("approve candidate");
    set_connection_standing_delivery_at_path(path, "conn_chatgpt", true).expect("enable");
  }

  #[test]
  fn context_pack_delivered_zero_touch_fires_once_with_content_free_metadata() {
    use_test_vault_key();
    let path = temp_vault_path("delivered_zero_touch");
    setup_vault_with_classified_fact_and_standing_delivery(&path);

    let result = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "How do I contact alice?",
      None,
      None,
      None,
    )
    .expect("create pack");
    assert_eq!(
      result.confirmation_status, "not_required",
      "should be zero-touch"
    );
    assert!(result.context_pack.is_some(), "zero-touch pack returned");

    let conn = open_vault_db_at_path(&path).expect("open");
    let vault = load_vault_json_from_connection(&conn).expect("load");
    let delivered_events: Vec<&Value> = vault
      .get("auditEvents")
      .and_then(Value::as_array)
      .unwrap()
      .iter()
      .filter(|e| str_field(e, "eventType") == "context_pack_delivered")
      .collect();
    assert_eq!(delivered_events.len(), 1, "exactly one delivered event");
    let meta = &delivered_events[0]["metadata"];
    assert_eq!(meta["zeroTouch"], json!(true));
    assert_eq!(meta["clientName"], json!("ChatGPT"));
    assert_eq!(meta["clientId"], json!("conn_chatgpt"));
    assert!(meta["packId"].as_str().unwrap_or("").starts_with("pack_"));
    // Verify content-free: no factText, no sourceIds
    assert!(meta.get("factText").is_none());
    assert!(meta.get("sourceIds").is_none());
    assert!(meta.get("items").is_none());

    // Second request should produce a second independent event (not re-fire first)
    let result2 = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "another task",
      None,
      None,
      None,
    )
    .expect("create second pack");
    assert_ne!(result2.pack_id, result.pack_id, "distinct packs");
    let conn2 = open_vault_db_at_path(&path).expect("open2");
    let vault2 = load_vault_json_from_connection(&conn2).expect("load2");
    let delivered2: Vec<&Value> = vault2
      .get("auditEvents")
      .and_then(Value::as_array)
      .unwrap()
      .iter()
      .filter(|e| str_field(e, "eventType") == "context_pack_delivered")
      .collect();
    assert_eq!(delivered2.len(), 2, "two packs → two events, not more");

    remove_temp_vault(&path);
  }

  #[test]
  fn context_pack_delivered_confirmed_fires_once_not_on_re_poll() {
    use_test_vault_key();
    let path = temp_vault_path("delivered_confirmed");
    setup_vault_with_classified_fact_and_standing_delivery(&path);

    // Create pending pack by disabling standing delivery
    set_connection_standing_delivery_at_path(&path, "conn_chatgpt", false).expect("disable");
    let built = create_context_pack_request_at_path(
      &path,
      "conn_chatgpt",
      "ChatGPT",
      "pending task",
      None,
      None,
      None,
    )
    .expect("build pack");
    assert_eq!(built.confirmation_status, "pending_user_confirmation");
    assert!(
      built.context_pack.is_none(),
      "pending → no immediate delivery"
    );

    // Confirm the pack
    confirm_context_pack_at_path(&path, &built.pack_id).expect("confirm");

    // First status poll: should fire delivered event and return pack
    let s1 =
      get_context_request_status_for_client_at_path(&path, &built.request_id, "conn_chatgpt")
        .expect("status1");
    assert_eq!(s1.status, "fulfilled");
    assert!(s1.context_pack.is_some());

    let conn = open_vault_db_at_path(&path).expect("open");
    let vault = load_vault_json_from_connection(&conn).expect("load");
    let delivered: Vec<&Value> = vault
      .get("auditEvents")
      .and_then(Value::as_array)
      .unwrap()
      .iter()
      .filter(|e| str_field(e, "eventType") == "context_pack_delivered")
      .collect();
    assert_eq!(delivered.len(), 1, "one delivered event after first poll");
    let meta = &delivered[0]["metadata"];
    assert_eq!(meta["zeroTouch"], json!(false));
    assert_eq!(meta["clientName"], json!("ChatGPT"));
    assert!(meta.get("factText").is_none(), "content-free");

    // Second status poll: should NOT add another delivered event (fire-once)
    let s2 =
      get_context_request_status_for_client_at_path(&path, &built.request_id, "conn_chatgpt")
        .expect("status2");
    assert_eq!(s2.status, "fulfilled");
    let conn2 = open_vault_db_at_path(&path).expect("open2");
    let vault2 = load_vault_json_from_connection(&conn2).expect("load2");
    let delivered2_count = vault2
      .get("auditEvents")
      .and_then(Value::as_array)
      .unwrap()
      .iter()
      .filter(|e| str_field(e, "eventType") == "context_pack_delivered")
      .count();
    assert_eq!(
      delivered2_count, 1,
      "second poll must not add a second delivered event"
    );

    remove_temp_vault(&path);
  }
}
