use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
  collections::HashMap,
  env,
  fs,
  io::{BufRead, BufReader, Read, Write},
  net::{TcpListener, TcpStream},
  path::PathBuf,
  sync::{
    mpsc::{self, Sender},
    Arc, Mutex,
  },
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tungstenite::{accept_hdr, Message};

#[path = "../mcp_stdio.rs"]
mod mcp_stdio;

const DEFAULT_BIND: &str = "127.0.0.1:8765";
const DEFAULT_TOKEN: &str = "dev-local-token";
const REQUEST_TIMEOUT_SECONDS: u64 = 30;
const OAUTH_TOKEN_TTL_SECONDS: u64 = 3600;
const AUTH_CODE_TTL_SECONDS: u64 = 300;
const PAIRING_TTL_SECONDS: u64 = 600;
const MAX_RELAY_REQUEST_EVENTS: usize = 500;
const DEFAULT_RELAY_REQUEST_EVENT_RETENTION_SECONDS: u64 = 30 * 24 * 60 * 60;
const DEFAULT_RELAY_STATE_BACKUP_COUNT: usize = 3;
const MAX_RELAY_STATE_BACKUP_COUNT: usize = 20;
const DEFAULT_RELAY_HANDOFF_TTL_SECONDS: u64 = 10 * 60;
const DEFAULT_MCP_SESSION_TTL_SECONDS: u64 = 24 * 60 * 60;
const DEFAULT_LOCAL_TENANT_ID: &str = "local";
const DEFAULT_MCP_PROTOCOL_VERSION: &str = "2025-03-26";
const SUPPORTED_MCP_PROTOCOL_VERSIONS: &[&str] =
  &["2025-03-26", "2025-06-18", "2025-11-25"];
const RELAY_CORS_ALLOW_HEADERS: &str =
  "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID";
const SUPPORTED_SCOPES: &[&str] = &[
  "context_pack.request",
  "memory.propose",
  "policy.read",
  "request.status",
];

fn main() {
  if let Err(error) = run() {
    eprintln!("lcv-relay error: {error}");
    std::process::exit(1);
  }
}

fn run() -> Result<(), String> {
  let config = Arc::new(RelayConfig::from_env()?);
  let state = RelayState::load_with_retention(
    config.relay_state_path.clone(),
    config.retention,
    config.tenant_id.clone(),
  )?;
  eprintln!("Life Context Vault relay listening on {}", config.base_url);
  let listener = TcpListener::bind(&config.bind)
    .map_err(|error| format!("failed to bind {}: {error}", config.bind))?;

  for stream in listener.incoming() {
    match stream {
      Ok(stream) => {
        let config = config.clone();
        let state = state.clone();
        thread::spawn(move || {
          if let Err(error) = handle_stream(stream, &config, &state) {
            eprintln!("relay request error: {error}");
          }
        });
      }
      Err(error) => eprintln!("relay connection error: {error}"),
    }
  }

  Ok(())
}

#[derive(Clone, Debug)]
struct RelayConfig {
  bind: String,
  base_url: String,
  token: String,
  admin_token: Option<String>,
  allow_static_bearer: bool,
  tenant_id: String,
  mcp_command: PathBuf,
  vault_db_path: Option<String>,
  relay_state_path: Option<PathBuf>,
  allow_direct_sidecar: bool,
  allowed_origins: Vec<String>,
  retention: RelayRetentionPolicy,
}

impl RelayConfig {
  fn from_env() -> Result<Self, String> {
    let bind = env::var("LCV_RELAY_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let token = env::var("LCV_RELAY_TOKEN").unwrap_or_else(|_| DEFAULT_TOKEN.to_string());
    let base_url = env::var("LCV_RELAY_BASE_URL").unwrap_or_else(|_| format!("http://{bind}"));
    let admin_token = env::var("LCV_RELAY_ADMIN_TOKEN").ok();
    let allow_direct_sidecar = env::var("LCV_RELAY_ALLOW_DIRECT_SIDECAR")
      .map(|value| value != "0")
      .unwrap_or(true);
    let allow_static_bearer = env::var("LCV_RELAY_ENABLE_STATIC_TOKEN")
      .map(|value| value == "1")
      .unwrap_or(false);
    let allowed_origins = parse_allowed_origins(env::var("LCV_RELAY_ALLOWED_ORIGINS").ok());
    validate_relay_surface(
      &bind,
      &base_url,
      admin_token.as_ref(),
      allow_direct_sidecar,
      allow_static_bearer,
      env::var("LCV_RELAY_TOKEN").is_ok(),
      &allowed_origins,
    )?;
    let tenant_id = relay_tenant_id_from_env(&bind)?;
    Ok(Self {
      bind,
      base_url,
      token,
      admin_token,
      allow_static_bearer,
      tenant_id,
      mcp_command: env::var("LCV_MCP_COMMAND")
        .map(PathBuf::from)
        .unwrap_or_else(|_| mcp_stdio::resolve_sibling_binary("lcv-mcp")),
      vault_db_path: env::var("LCV_VAULT_DB_PATH").ok(),
      relay_state_path: env::var("LCV_RELAY_STATE_PATH")
        .map(PathBuf::from)
        .ok()
        .or_else(default_relay_state_path),
      allow_direct_sidecar,
      allowed_origins,
      retention: RelayRetentionPolicy::from_env(),
    })
  }

  fn ws_base_url(&self) -> String {
    if let Some(rest) = self.base_url.strip_prefix("https://") {
      format!("wss://{rest}")
    } else if let Some(rest) = self.base_url.strip_prefix("http://") {
      format!("ws://{rest}")
    } else {
      self.base_url.clone()
    }
  }

  fn mcp_resource_uri(&self) -> String {
    format!("{}/mcp", self.base_url)
  }

  fn protected_resource_metadata_uri(&self) -> String {
    format!("{}/.well-known/oauth-protected-resource", self.base_url)
  }
}

#[derive(Clone, Copy, Debug)]
struct RelayRetentionPolicy {
  request_event_retention_seconds: u64,
  client_registration_retention_seconds: Option<u64>,
  state_backup_count: usize,
  handoff_ttl_seconds: u64,
}

impl RelayRetentionPolicy {
  fn from_env() -> Self {
    Self {
      request_event_retention_seconds: env_duration_seconds(
        "LCV_RELAY_REQUEST_EVENT_RETENTION_SECONDS",
        "LCV_RELAY_REQUEST_EVENT_RETENTION_DAYS",
        DEFAULT_RELAY_REQUEST_EVENT_RETENTION_SECONDS,
      ),
      client_registration_retention_seconds: env_optional_duration_seconds(
        "LCV_RELAY_CLIENT_RETENTION_SECONDS",
        "LCV_RELAY_CLIENT_RETENTION_DAYS",
      ),
      state_backup_count: env_usize(
        "LCV_RELAY_STATE_BACKUP_COUNT",
        DEFAULT_RELAY_STATE_BACKUP_COUNT,
        MAX_RELAY_STATE_BACKUP_COUNT,
      ),
      handoff_ttl_seconds: env_duration_seconds(
        "LCV_RELAY_HANDOFF_TTL_SECONDS",
        "LCV_RELAY_HANDOFF_TTL_DAYS",
        DEFAULT_RELAY_HANDOFF_TTL_SECONDS,
      ),
    }
  }
}

impl Default for RelayRetentionPolicy {
  fn default() -> Self {
    Self {
      request_event_retention_seconds: DEFAULT_RELAY_REQUEST_EVENT_RETENTION_SECONDS,
      client_registration_retention_seconds: None,
      state_backup_count: DEFAULT_RELAY_STATE_BACKUP_COUNT,
      handoff_ttl_seconds: DEFAULT_RELAY_HANDOFF_TTL_SECONDS,
    }
  }
}

fn env_duration_seconds(seconds_name: &str, days_name: &str, default_seconds: u64) -> u64 {
  env::var(seconds_name)
    .ok()
    .and_then(|value| value.parse::<u64>().ok())
    .filter(|value| *value > 0)
    .or_else(|| {
      env::var(days_name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(|days| days.saturating_mul(24 * 60 * 60))
    })
    .unwrap_or(default_seconds)
}

fn env_optional_duration_seconds(seconds_name: &str, days_name: &str) -> Option<u64> {
  env::var(seconds_name)
    .ok()
    .and_then(|value| value.parse::<u64>().ok())
    .filter(|value| *value > 0)
    .or_else(|| {
      env::var(days_name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(|days| days.saturating_mul(24 * 60 * 60))
    })
}

fn env_usize(name: &str, default_value: usize, max_value: usize) -> usize {
  env::var(name)
    .ok()
    .and_then(|value| value.parse::<usize>().ok())
    .map(|value| value.min(max_value))
    .unwrap_or(default_value)
}

fn validate_relay_surface(
  bind: &str,
  base_url: &str,
  admin_token: Option<&String>,
  allow_direct_sidecar: bool,
  allow_static_bearer: bool,
  static_token_set: bool,
  allowed_origins: &[String],
) -> Result<(), String> {
  if is_loopback_bind(bind) {
    return Ok(());
  }
  if !base_url.starts_with("https://") {
    return Err("LCV_RELAY_BASE_URL must be https:// when binding outside loopback".to_string());
  }
  if admin_token.is_none() {
    return Err("LCV_RELAY_ADMIN_TOKEN is required when binding outside loopback".to_string());
  }
  if allow_direct_sidecar {
    return Err("LCV_RELAY_ALLOW_DIRECT_SIDECAR=0 is required when binding outside loopback".to_string());
  }
  if allow_static_bearer && !static_token_set {
    return Err(
      "LCV_RELAY_TOKEN is required when explicitly enabling static bearer outside loopback"
        .to_string(),
    );
  }
  if allowed_origins.is_empty() {
    return Err(
      "LCV_RELAY_ALLOWED_ORIGINS is required when binding outside loopback".to_string(),
    );
  }
  Ok(())
}

fn parse_allowed_origins(raw: Option<String>) -> Vec<String> {
  raw
    .unwrap_or_default()
    .split(|character: char| character == ',' || character.is_whitespace())
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(|value| value.trim_end_matches('/').to_string())
    .collect()
}

fn relay_tenant_id_from_env(bind: &str) -> Result<String, String> {
  resolve_relay_tenant_id(bind, env::var("LCV_RELAY_TENANT_ID").ok().as_deref())
}

fn resolve_relay_tenant_id(bind: &str, configured: Option<&str>) -> Result<String, String> {
  let tenant_id = match configured {
    Some(value) => value.trim(),
    None if is_loopback_bind(bind) => DEFAULT_LOCAL_TENANT_ID,
    None => {
      return Err(
        "LCV_RELAY_TENANT_ID is required when binding outside loopback".to_string(),
      )
    }
  };
  if valid_relay_tenant_id(tenant_id) {
    Ok(tenant_id.to_string())
  } else {
    Err(
      "LCV_RELAY_TENANT_ID must be 1-80 ASCII letters, numbers, dots, underscores, or hyphens"
        .to_string(),
    )
  }
}

fn valid_relay_tenant_id(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 80
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(target_os = "macos")]
fn default_relay_state_path() -> Option<PathBuf> {
  env::var("HOME").ok().map(|home| {
    PathBuf::from(home)
      .join("Library")
      .join("Application Support")
      .join("dev.life-context-vault.poc")
      .join("relay-state.json")
  })
}

#[cfg(target_os = "windows")]
fn default_relay_state_path() -> Option<PathBuf> {
  env::var("APPDATA")
    .ok()
    .map(|appdata| {
      PathBuf::from(appdata)
        .join("dev.life-context-vault.poc")
        .join("relay-state.json")
    })
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn default_relay_state_path() -> Option<PathBuf> {
  env::var("XDG_DATA_HOME")
    .map(PathBuf::from)
    .or_else(|_| env::var("HOME").map(|home| PathBuf::from(home).join(".local").join("share")))
    .ok()
    .map(|base| base.join("dev.life-context-vault.poc").join("relay-state.json"))
}

#[derive(Clone)]
struct RelayState {
  inner: Arc<Mutex<RelayStateInner>>,
  store_path: Option<PathBuf>,
  retention: RelayRetentionPolicy,
  tenant_id: String,
}

struct RelayStateInner {
  registered_clients: HashMap<String, RegisteredClient>,
  request_events: Vec<RelayRequestEvent>,
  handoffs: HashMap<String, RelayHandoff>,
  pending_authorizations: HashMap<String, PendingAuthorization>,
  auth_codes: HashMap<String, AuthCode>,
  access_tokens: HashMap<String, AccessToken>,
  mcp_sessions: HashMap<String, McpSession>,
  pairing_sessions: HashMap<String, PairingSession>,
  pending_agent_responses: HashMap<String, Sender<Result<Option<Value>, String>>>,
  agent_sender: Option<Sender<String>>,
  agent_pairing_id: Option<String>,
  agent_connected_at: Option<SystemTime>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RegisteredClient {
  #[serde(default)]
  tenant_id: String,
  client_id: String,
  client_name: String,
  redirect_uris: Vec<String>,
  created_at: u64,
}

#[derive(Clone, Debug)]
struct AuthCode {
  client_id: String,
  redirect_uri: String,
  code_challenge: String,
  code_challenge_method: String,
  scopes: Vec<String>,
  resource: Option<String>,
  expires_at: SystemTime,
}

#[derive(Clone, Debug)]
struct PendingAuthorization {
  id: String,
  client_id: String,
  redirect_uri: String,
  code_challenge: String,
  code_challenge_method: String,
  scopes: Vec<String>,
  resource: Option<String>,
  state: Option<String>,
  expires_at: SystemTime,
}

#[derive(Clone, Debug)]
struct AccessToken {
  client_id: String,
  scopes: Vec<String>,
  resource: Option<String>,
  expires_at: SystemTime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RelayRequestEvent {
  #[serde(default)]
  tenant_id: String,
  id: String,
  client_id: Option<String>,
  required_scope: String,
  method: String,
  tool_name: Option<String>,
  status: String,
  transport: String,
  occurred_at: u64,
}

#[derive(Clone, Debug)]
struct RelayHandoff {
  request_id: String,
  client_id: Option<String>,
  body: Value,
  created_at: SystemTime,
  expires_at: SystemTime,
}

#[derive(Clone, Debug)]
struct McpSession {
  id: String,
  client_id: String,
  created_at: SystemTime,
  last_seen_at: SystemTime,
  expires_at: SystemTime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedRelayState {
  version: u32,
  #[serde(default)]
  tenant_id: String,
  registered_clients: Vec<RegisteredClient>,
  #[serde(default)]
  request_events: Vec<RelayRequestEvent>,
}

#[derive(Clone, Debug)]
struct PairingSession {
  id: String,
  code: String,
  created_at: SystemTime,
  expires_at: SystemTime,
  status: PairingStatus,
  connected_at: Option<SystemTime>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PairingStatus {
  Pending,
  Connected,
  Expired,
}

fn prune_persisted_relay_state(
  persisted: &mut PersistedRelayState,
  retention: RelayRetentionPolicy,
  now_seconds: u64,
) {
  prune_request_events(
    &mut persisted.request_events,
    retention.request_event_retention_seconds,
    now_seconds,
  );
  if let Some(client_ttl) = retention.client_registration_retention_seconds {
    let cutoff = now_seconds.saturating_sub(client_ttl);
    persisted
      .registered_clients
      .retain(|client| client.created_at >= cutoff);
  }
}

fn prune_request_events(
  request_events: &mut Vec<RelayRequestEvent>,
  retention_seconds: u64,
  now_seconds: u64,
) {
  let cutoff = now_seconds.saturating_sub(retention_seconds);
  request_events.retain(|event| event.occurred_at >= cutoff);
  if request_events.len() > MAX_RELAY_REQUEST_EVENTS {
    request_events.truncate(MAX_RELAY_REQUEST_EVENTS);
  }
}

fn prune_handoffs(handoffs: &mut HashMap<String, RelayHandoff>, now: SystemTime) {
  handoffs.retain(|_, handoff| now <= handoff.expires_at);
}

fn prune_mcp_sessions(sessions: &mut HashMap<String, McpSession>, now: SystemTime) {
  sessions.retain(|_, session| now <= session.expires_at);
}

fn normalize_persisted_relay_state_tenant(
  persisted: &mut PersistedRelayState,
  tenant_id: &str,
) -> Result<(), String> {
  if persisted.tenant_id.is_empty() {
    persisted.tenant_id = tenant_id.to_string();
  } else if persisted.tenant_id != tenant_id {
    return Err(format!(
      "relay state tenant mismatch: store belongs to '{}' but relay is configured for '{}'",
      persisted.tenant_id, tenant_id
    ));
  }

  for client in &mut persisted.registered_clients {
    if client.tenant_id.is_empty() {
      client.tenant_id = tenant_id.to_string();
    } else if client.tenant_id != tenant_id {
      return Err(format!(
        "relay state contains client '{}' for tenant '{}' but relay is configured for '{}'",
        client.client_id, client.tenant_id, tenant_id
      ));
    }
  }

  for event in &mut persisted.request_events {
    if event.tenant_id.is_empty() {
      event.tenant_id = tenant_id.to_string();
    } else if event.tenant_id != tenant_id {
      return Err(format!(
        "relay state contains request event '{}' for tenant '{}' but relay is configured for '{}'",
        event.id, event.tenant_id, tenant_id
      ));
    }
  }

  Ok(())
}

fn relay_state_backup_path(path: &PathBuf, generation: usize) -> PathBuf {
  let file_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("relay-state.json");
  path.with_file_name(format!("{file_name}.bak{generation}"))
}

fn rotate_relay_state_backups(path: &PathBuf, backup_count: usize) -> Result<(), String> {
  if backup_count == 0 || !path.exists() {
    return Ok(());
  }
  for generation in (2..=backup_count).rev() {
    let from = relay_state_backup_path(path, generation - 1);
    let to = relay_state_backup_path(path, generation);
    if to.exists() {
      fs::remove_file(&to)
        .map_err(|error| format!("failed to remove relay state backup: {error}"))?;
    }
    if from.exists() {
      fs::rename(&from, &to)
        .map_err(|error| format!("failed to rotate relay state backup: {error}"))?;
    }
  }
  let first_backup = relay_state_backup_path(path, 1);
  fs::copy(path, &first_backup)
    .map_err(|error| format!("failed to back up relay state store: {error}"))?;
  Ok(())
}

impl RelayState {
  #[cfg(test)]
  fn new() -> Self {
    Self::from_persisted(None, PersistedRelayState::empty())
  }

  #[cfg(test)]
  fn load(store_path: Option<PathBuf>) -> Result<Self, String> {
    Self::load_with_retention(
      store_path,
      RelayRetentionPolicy::default(),
      DEFAULT_LOCAL_TENANT_ID.to_string(),
    )
  }

  fn load_with_retention(
    store_path: Option<PathBuf>,
    retention: RelayRetentionPolicy,
    tenant_id: String,
  ) -> Result<Self, String> {
    let mut persisted = match &store_path {
      Some(path) if path.exists() => {
        let raw = fs::read_to_string(path)
          .map_err(|error| format!("failed to read relay state store: {error}"))?;
        serde_json::from_str::<PersistedRelayState>(&raw)
          .map_err(|error| format!("failed to parse relay state store: {error}"))?
      }
      _ => PersistedRelayState::empty_for_tenant(&tenant_id),
    };
    normalize_persisted_relay_state_tenant(&mut persisted, &tenant_id)?;
    Ok(Self::from_persisted_with_retention(
      store_path, persisted, retention, tenant_id,
    ))
  }

  #[cfg(test)]
  fn from_persisted(store_path: Option<PathBuf>, persisted: PersistedRelayState) -> Self {
    Self::from_persisted_with_retention(
      store_path,
      persisted,
      RelayRetentionPolicy::default(),
      DEFAULT_LOCAL_TENANT_ID.to_string(),
    )
  }

  fn from_persisted_with_retention(
    store_path: Option<PathBuf>,
    mut persisted: PersistedRelayState,
    retention: RelayRetentionPolicy,
    tenant_id: String,
  ) -> Self {
    normalize_persisted_relay_state_tenant(&mut persisted, &tenant_id)
      .expect("persisted relay state tenant must match");
    prune_persisted_relay_state(&mut persisted, retention, system_time_seconds(SystemTime::now()));
    persisted.request_events.truncate(MAX_RELAY_REQUEST_EVENTS);
    let registered_clients = persisted
      .registered_clients
      .into_iter()
      .map(|client| (client.client_id.clone(), client))
      .collect();
    Self {
      inner: Arc::new(Mutex::new(RelayStateInner {
        registered_clients,
        request_events: persisted.request_events,
        handoffs: HashMap::new(),
        pending_authorizations: HashMap::new(),
        auth_codes: HashMap::new(),
        access_tokens: HashMap::new(),
        mcp_sessions: HashMap::new(),
        pairing_sessions: HashMap::new(),
        pending_agent_responses: HashMap::new(),
        agent_sender: None,
        agent_pairing_id: None,
        agent_connected_at: None,
      })),
      store_path,
      retention,
      tenant_id,
    }
  }

  fn register_client(
    &self,
    client_name: String,
    redirect_uris: Vec<String>,
  ) -> Result<RegisteredClient, String> {
    let client = RegisteredClient {
      tenant_id: self.tenant_id.clone(),
      client_id: random_token("client"),
      client_name,
      redirect_uris,
      created_at: system_time_seconds(SystemTime::now()),
    };
    {
      let mut inner = self.inner.lock().expect("relay state");
      inner
        .registered_clients
        .insert(client.client_id.clone(), client.clone());
    }
    if let Err(error) = self.persist() {
      let mut inner = self.inner.lock().expect("relay state");
      inner.registered_clients.remove(&client.client_id);
      return Err(error);
    }
    Ok(client)
  }

  fn client(&self, client_id: &str) -> Option<RegisteredClient> {
    let inner = self.inner.lock().expect("relay state");
    inner.registered_clients.get(client_id).cloned()
  }

  fn insert_auth_code(&self, code: String, auth_code: AuthCode) {
    let mut inner = self.inner.lock().expect("relay state");
    inner.auth_codes.insert(code, auth_code);
  }

  fn insert_pending_authorization(
    &self,
    authorization: PendingAuthorization,
  ) -> PendingAuthorization {
    let mut inner = self.inner.lock().expect("relay state");
    inner
      .pending_authorizations
      .insert(authorization.id.clone(), authorization.clone());
    authorization
  }

  fn consume_pending_authorization(&self, id: &str) -> Option<PendingAuthorization> {
    let mut inner = self.inner.lock().expect("relay state");
    inner.pending_authorizations.remove(id)
  }

  fn consume_auth_code(&self, code: &str) -> Option<AuthCode> {
    let mut inner = self.inner.lock().expect("relay state");
    inner.auth_codes.remove(code)
  }

  fn insert_access_token(&self, token: String, access_token: AccessToken) {
    let mut inner = self.inner.lock().expect("relay state");
    inner.access_tokens.insert(token, access_token);
  }

  fn access_token(&self, token: &str) -> Option<AccessToken> {
    let inner = self.inner.lock().expect("relay state");
    inner.access_tokens.get(token).cloned()
  }

  fn record_request_event(&self, event: RelayRequestEvent) -> Result<(), String> {
    let mut event = event;
    if event.tenant_id.is_empty() {
      event.tenant_id = self.tenant_id.clone();
    }
    {
      let mut inner = self.inner.lock().expect("relay state");
      inner.request_events.insert(0, event);
      prune_request_events(
        &mut inner.request_events,
        self.retention.request_event_retention_seconds,
        system_time_seconds(SystemTime::now()),
      );
    }
    self.persist()
  }

  fn store_handoff(
    &self,
    request_id: String,
    client_id: Option<String>,
    body: Value,
  ) -> RelayHandoff {
    let handoff = RelayHandoff {
      request_id: request_id.clone(),
      client_id,
      body,
      created_at: SystemTime::now(),
      expires_at: seconds_from_now(self.retention.handoff_ttl_seconds),
    };
    let mut inner = self.inner.lock().expect("relay state");
    prune_handoffs(&mut inner.handoffs, SystemTime::now());
    inner.handoffs.insert(request_id, handoff.clone());
    handoff
  }

  fn handoff_response(&self, request_id: &str, client_id: &str) -> Option<Value> {
    let mut inner = self.inner.lock().expect("relay state");
    prune_handoffs(&mut inner.handoffs, SystemTime::now());
    inner.handoffs.get(request_id).and_then(|handoff| {
      if handoff.client_id.as_deref() == Some(client_id) {
        Some(handoff.body.clone())
      } else {
        None
      }
    })
  }

  fn start_mcp_session(&self, client_id: String) -> McpSession {
    let session = McpSession {
      id: random_token("mcp_session"),
      client_id,
      created_at: SystemTime::now(),
      last_seen_at: SystemTime::now(),
      expires_at: seconds_from_now(DEFAULT_MCP_SESSION_TTL_SECONDS),
    };
    let mut inner = self.inner.lock().expect("relay state");
    prune_mcp_sessions(&mut inner.mcp_sessions, SystemTime::now());
    inner
      .mcp_sessions
      .insert(session.id.clone(), session.clone());
    session
  }

  fn client_has_mcp_session(&self, client_id: &str) -> bool {
    let mut inner = self.inner.lock().expect("relay state");
    prune_mcp_sessions(&mut inner.mcp_sessions, SystemTime::now());
    inner
      .mcp_sessions
      .values()
      .any(|session| session.client_id == client_id)
  }

  fn touch_mcp_session(&self, session_id: &str, client_id: &str) -> Result<(), String> {
    let mut inner = self.inner.lock().expect("relay state");
    prune_mcp_sessions(&mut inner.mcp_sessions, SystemTime::now());
    let Some(session) = inner.mcp_sessions.get_mut(session_id) else {
      return Err("mcp_session_not_found".to_string());
    };
    if session.client_id != client_id {
      return Err("mcp_session_not_found".to_string());
    }
    session.last_seen_at = SystemTime::now();
    session.expires_at = seconds_from_now(DEFAULT_MCP_SESSION_TTL_SECONDS);
    Ok(())
  }

  fn terminate_mcp_session(&self, session_id: &str, client_id: &str) -> Result<(), String> {
    let mut inner = self.inner.lock().expect("relay state");
    prune_mcp_sessions(&mut inner.mcp_sessions, SystemTime::now());
    let Some(session) = inner.mcp_sessions.get(session_id) else {
      return Err("mcp_session_not_found".to_string());
    };
    if session.client_id != client_id {
      return Err("mcp_session_not_found".to_string());
    }
    inner.mcp_sessions.remove(session_id);
    Ok(())
  }

  fn store_status(&self) -> Value {
    let mut inner = self.inner.lock().expect("relay state");
    let now_seconds = system_time_seconds(SystemTime::now());
    prune_handoffs(&mut inner.handoffs, SystemTime::now());
    prune_mcp_sessions(&mut inner.mcp_sessions, SystemTime::now());
    prune_request_events(
      &mut inner.request_events,
      self.retention.request_event_retention_seconds,
      now_seconds,
    );
    if let Some(client_ttl) = self.retention.client_registration_retention_seconds {
      let cutoff = now_seconds.saturating_sub(client_ttl);
      inner
        .registered_clients
        .retain(|_, client| client.created_at >= cutoff);
    }
    let recent_events: Vec<Value> = inner
      .request_events
      .iter()
      .take(20)
      .map(|event| {
        json!({
          "tenantId": event.tenant_id,
          "id": event.id,
          "clientId": event.client_id,
          "requiredScope": event.required_scope,
          "method": event.method,
          "toolName": event.tool_name,
          "status": event.status,
          "transport": event.transport,
          "occurredAt": event.occurred_at
        })
      })
      .collect();
    let recent_handoffs: Vec<Value> = inner
      .handoffs
      .values()
      .take(20)
      .map(|handoff| {
        json!({
          "requestId": handoff.request_id,
          "clientId": handoff.client_id,
          "createdAt": system_time_seconds(handoff.created_at),
          "expiresAt": system_time_seconds(handoff.expires_at)
        })
      })
      .collect();
    let recent_mcp_sessions: Vec<Value> = inner
      .mcp_sessions
      .values()
      .take(20)
      .map(|session| {
        json!({
          "id": session.id,
          "clientId": session.client_id,
          "createdAt": system_time_seconds(session.created_at),
          "lastSeenAt": system_time_seconds(session.last_seen_at),
          "expiresAt": system_time_seconds(session.expires_at)
        })
      })
      .collect();
    json!({
      "tenantId": self.tenant_id,
      "storePath": self.store_path.as_ref().map(|path| path.display().to_string()),
      "registeredClientCount": inner.registered_clients.len(),
      "requestEventCount": inner.request_events.len(),
      "handoffCount": inner.handoffs.len(),
      "mcpSessionCount": inner.mcp_sessions.len(),
      "retention": {
        "requestEventRetentionSeconds": self.retention.request_event_retention_seconds,
        "clientRegistrationRetentionSeconds": self.retention.client_registration_retention_seconds,
        "stateBackupCount": self.retention.state_backup_count,
        "handoffTtlSeconds": self.retention.handoff_ttl_seconds,
        "mcpSessionTtlSeconds": DEFAULT_MCP_SESSION_TTL_SECONDS,
        "maxRequestEvents": MAX_RELAY_REQUEST_EVENTS
      },
      "recentRequestEvents": recent_events,
      "recentHandoffs": recent_handoffs,
      "recentMcpSessions": recent_mcp_sessions
    })
  }

  fn start_pairing(&self) -> PairingSession {
    let session = PairingSession {
      id: random_token("pair"),
      code: random_token("paircode"),
      created_at: SystemTime::now(),
      expires_at: seconds_from_now(PAIRING_TTL_SECONDS),
      status: PairingStatus::Pending,
      connected_at: None,
    };
    let mut inner = self.inner.lock().expect("relay state");
    inner
      .pairing_sessions
      .insert(session.code.clone(), session.clone());
    session
  }

  fn pairing_by_code(&self, code: &str) -> Option<PairingSession> {
    let mut inner = self.inner.lock().expect("relay state");
    let session = inner.pairing_sessions.get_mut(code)?;
    if SystemTime::now() > session.expires_at && session.status == PairingStatus::Pending {
      session.status = PairingStatus::Expired;
    }
    Some(session.clone())
  }

  fn connect_agent(&self, code: &str, sender: Sender<String>) -> Result<PairingSession, String> {
    let mut inner = self.inner.lock().expect("relay state");
    let session = inner
      .pairing_sessions
      .get_mut(code)
      .ok_or_else(|| "unknown pairing code".to_string())?;
    if SystemTime::now() > session.expires_at {
      session.status = PairingStatus::Expired;
      return Err("pairing code expired".to_string());
    }
    session.status = PairingStatus::Connected;
    session.connected_at = Some(SystemTime::now());
    let connected_session = session.clone();
    inner.agent_sender = Some(sender);
    inner.agent_pairing_id = Some(connected_session.id.clone());
    inner.agent_connected_at = connected_session.connected_at;
    Ok(connected_session)
  }

  fn disconnect_agent(&self) {
    let mut inner = self.inner.lock().expect("relay state");
    inner.agent_sender = None;
    inner.agent_pairing_id = None;
    inner.agent_connected_at = None;
  }

  fn agent_status(&self) -> Value {
    let inner = self.inner.lock().expect("relay state");
    json!({
      "connected": inner.agent_sender.is_some(),
      "pairingId": inner.agent_pairing_id,
      "connectedAt": inner.agent_connected_at.map(system_time_seconds),
      "pendingResponseCount": inner.pending_agent_responses.len()
    })
  }

  fn forward_to_agent(&self, body: &str, client_id: &str) -> Result<Option<Value>, String> {
    let request_id = random_token("agent_req");
    let (response_tx, response_rx) = mpsc::channel();
    let sender = {
      let mut inner = self.inner.lock().expect("relay state");
      let sender = inner
        .agent_sender
        .clone()
        .ok_or_else(|| "local agent is not connected".to_string())?;
      inner
        .pending_agent_responses
        .insert(request_id.clone(), response_tx);
      sender
    };

    let outbound = json!({
      "type": "mcp_request",
      "id": request_id,
      "clientId": client_id,
      "body": body
    })
    .to_string();

    if sender.send(outbound).is_err() {
      let mut inner = self.inner.lock().expect("relay state");
      inner.pending_agent_responses.remove(&request_id);
      inner.agent_sender = None;
      return Err("failed to send request to local agent".to_string());
    }

    match response_rx.recv_timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS)) {
      Ok(result) => result,
      Err(_) => {
        let mut inner = self.inner.lock().expect("relay state");
        inner.pending_agent_responses.remove(&request_id);
        Err("timed out waiting for local agent".to_string())
      }
    }
  }

  fn complete_agent_response(&self, request_id: &str, result: Result<Option<Value>, String>) {
    let sender = {
      let mut inner = self.inner.lock().expect("relay state");
      inner.pending_agent_responses.remove(request_id)
    };
    if let Some(sender) = sender {
      let _ = sender.send(result);
    }
  }

  fn persist(&self) -> Result<(), String> {
    let Some(path) = &self.store_path else {
      return Ok(());
    };
    let snapshot = {
      let mut inner = self.inner.lock().expect("relay state");
      prune_request_events(
        &mut inner.request_events,
        self.retention.request_event_retention_seconds,
        system_time_seconds(SystemTime::now()),
      );
      if let Some(client_ttl) = self.retention.client_registration_retention_seconds {
        let cutoff = system_time_seconds(SystemTime::now()).saturating_sub(client_ttl);
        inner
          .registered_clients
          .retain(|_, client| client.created_at >= cutoff);
      }
      PersistedRelayState {
        version: 1,
        tenant_id: self.tenant_id.clone(),
        registered_clients: inner.registered_clients.values().cloned().collect(),
        request_events: inner.request_events.clone(),
      }
    };
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create relay state directory: {error}"))?;
    }
    let payload = serde_json::to_string_pretty(&snapshot)
      .map_err(|error| format!("failed to serialize relay state: {error}"))?;
    let temp_path = path.with_extension(
      path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!("{extension}.tmp"))
        .unwrap_or_else(|| "tmp".to_string()),
    );
    fs::write(&temp_path, payload)
      .map_err(|error| format!("failed to write relay state temp store: {error}"))?;
    rotate_relay_state_backups(path, self.retention.state_backup_count)?;
    #[cfg(target_os = "windows")]
    {
      match fs::rename(&temp_path, path) {
        Ok(()) => return Ok(()),
        Err(rename_error) if path.exists() => {
          fs::remove_file(path)
            .map_err(|error| format!("failed to replace relay state store: {error}"))?;
          fs::rename(&temp_path, path).map_err(|error| {
            format!("failed to replace relay state store after removing existing file: {error}; original error: {rename_error}")
          })?;
          return Ok(());
        }
        Err(error) => return Err(format!("failed to replace relay state store: {error}")),
      }
    }
    #[cfg(not(target_os = "windows"))]
    {
      fs::rename(&temp_path, path)
        .map_err(|error| format!("failed to replace relay state store: {error}"))
    }
  }
}

impl PersistedRelayState {
  #[cfg(test)]
  fn empty() -> Self {
    Self::empty_for_tenant(DEFAULT_LOCAL_TENANT_ID)
  }

  fn empty_for_tenant(tenant_id: &str) -> Self {
    Self {
      version: 1,
      tenant_id: tenant_id.to_string(),
      registered_clients: Vec::new(),
      request_events: Vec::new(),
    }
  }
}

fn handle_stream(stream: TcpStream, config: &RelayConfig, state: &RelayState) -> Result<(), String> {
  if is_agent_websocket_request(&stream)? {
    return handle_agent_websocket(stream, state);
  }
  let mut stream = stream;
  let request = HttpRequest::read(&mut stream)?;
  let response = route_request(&request, config, state);
  response.write_to(&mut stream)
}

fn route_request(request: &HttpRequest, config: &RelayConfig, state: &RelayState) -> HttpResponse {
  match (request.method.as_str(), request.path.as_str()) {
    ("GET", "/health") => json_response(200, json!({
      "status": "ok",
      "server": "life-context-vault-relay",
      "tenantId": config.tenant_id,
      "mcpEndpoint": "/mcp",
      "oauth": true,
      "agent": state.agent_status()
    })),
    ("GET", "/.well-known/oauth-protected-resource") => protected_resource_metadata(config),
    ("GET", "/.well-known/oauth-protected-resource/mcp") => protected_resource_metadata(config),
    ("GET", "/.well-known/oauth-authorization-server") => authorization_server_metadata(config),
    ("GET", "/.well-known/openid-configuration") => authorization_server_metadata(config),
    ("POST", "/oauth/register") => register_oauth_client(request, state),
    ("GET", "/oauth/authorize") => oauth_authorize(request, config, state),
    ("GET", "/oauth/approve") => oauth_approve(request, state),
    ("POST", "/oauth/token") => oauth_token(request, config, state),
    ("POST", "/pairing/start") => start_pairing(request, config, state),
    ("GET", "/pairing/status") => pairing_status(request, state),
    ("GET", "/agent/status") => json_response(200, state.agent_status()),
    ("GET", "/relay/state") => relay_state_status(request, config, state),
    ("OPTIONS", "/relay/handoff") => cors_preflight_response(request, config),
    ("POST", "/relay/handoff") => {
      if cors_origin_for_request(request, config).is_none() {
        cors_forbidden_response()
      } else {
        relay_handoff(request, config, state).with_cors_for_request(request, config)
      }
    }
    ("OPTIONS", "/mcp") => cors_preflight_response(request, config),
    ("POST", "/mcp") => {
      if cors_origin_for_request(request, config).is_none() {
        cors_forbidden_response()
      } else {
        handle_mcp_request(request, config, state)
      }
    }
    ("DELETE", "/mcp") => {
      if cors_origin_for_request(request, config).is_none() {
        cors_forbidden_response()
      } else {
        handle_mcp_session_delete(request, config, state)
      }
    }
    (method, "/mcp") => mcp_method_not_allowed(method, request, config),
    _ => json_response(404, json!({
      "error": "not_found",
      "message": "Use POST /mcp for MCP JSON-RPC over HTTP."
    })),
  }
}

fn mcp_method_not_allowed(
  method: &str,
  request: &HttpRequest,
  config: &RelayConfig,
) -> HttpResponse {
  HttpResponse::json(405, json!({
    "error": "method_not_allowed",
    "method": method,
    "allowedMethods": ["POST", "DELETE", "OPTIONS"],
    "message": "This Relay supports MCP JSON-RPC over POST /mcp. SSE GET /mcp is not enabled."
  }))
  .with_header("Allow", "POST, DELETE, OPTIONS")
  .with_cors_for_request(request, config)
}

fn protected_resource_metadata(config: &RelayConfig) -> HttpResponse {
  json_response(200, json!({
    "resource": config.mcp_resource_uri(),
    "authorization_servers": [config.base_url],
    "scopes_supported": SUPPORTED_SCOPES,
    "bearer_methods_supported": ["header"],
    "resource_name": "Life Context Vault Context Pack API"
  }))
}

fn authorization_server_metadata(config: &RelayConfig) -> HttpResponse {
  json_response(200, json!({
    "issuer": config.base_url,
    "authorization_endpoint": format!("{}/oauth/authorize", config.base_url),
    "token_endpoint": format!("{}/oauth/token", config.base_url),
    "registration_endpoint": format!("{}/oauth/register", config.base_url),
    "response_types_supported": ["code"],
    "grant_types_supported": ["authorization_code"],
    "code_challenge_methods_supported": ["S256"],
    "token_endpoint_auth_methods_supported": ["none"],
    "scopes_supported": SUPPORTED_SCOPES
  }))
}

fn register_oauth_client(request: &HttpRequest, state: &RelayState) -> HttpResponse {
  let body = serde_json::from_str::<Value>(&request.body).unwrap_or_else(|_| json!({}));
  let client_name = body
    .get("client_name")
    .and_then(Value::as_str)
    .unwrap_or("AI MCP Client")
    .to_string();
  let redirect_uris = body
    .get("redirect_uris")
    .and_then(Value::as_array)
    .map(|items| {
      items
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>()
    })
    .filter(|items| !items.is_empty())
    .unwrap_or_else(|| vec!["http://127.0.0.1/oauth/callback".to_string()]);
  let client = match state.register_client(client_name, redirect_uris.clone()) {
    Ok(client) => client,
    Err(error) => {
      return json_response(500, json!({
        "error": "relay_state_persist_failed",
        "message": error
      }));
    }
  };
  json_response(201, json!({
    "client_id": client.client_id,
    "client_name": client.client_name,
    "client_id_issued_at": client.created_at,
    "redirect_uris": redirect_uris,
    "grant_types": ["authorization_code"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none",
    "scope": SUPPORTED_SCOPES.join(" ")
  }))
}

fn relay_state_status(request: &HttpRequest, config: &RelayConfig, state: &RelayState) -> HttpResponse {
  if !admin_authorized(request, config) {
    return json_response(401, json!({
      "error": "unauthorized",
      "message": "Relay state status requires loopback access or LCV_RELAY_ADMIN_TOKEN."
    }))
    .with_header("WWW-Authenticate", "Bearer");
  }
  json_response(200, state.store_status())
}

fn relay_handoff(request: &HttpRequest, config: &RelayConfig, state: &RelayState) -> HttpResponse {
  if !admin_authorized(request, config) {
    return HttpResponse::json(401, json!({
      "error": "unauthorized",
      "message": "Relay handoff requires loopback access or LCV_RELAY_ADMIN_TOKEN."
    }))
    .with_header("WWW-Authenticate", "Bearer");
  }
  let body = match serde_json::from_str::<Value>(&request.body) {
    Ok(value) => value,
    Err(error) => {
      return HttpResponse::json(400, json!({
        "error": "invalid_json",
        "message": format!("handoff body must be JSON: {error}")
      }));
    }
  };
  let mcp_response = body
    .get("mcpResponse")
    .cloned()
    .unwrap_or_else(|| body.clone());
  let request_id = match validate_handoff_mcp_response(&mcp_response) {
    Ok(request_id) => request_id,
    Err(error) => {
      return HttpResponse::json(400, json!({
        "error": "invalid_handoff",
        "message": error
      }));
    }
  };
  let client_id = body
    .get("clientId")
    .and_then(Value::as_str)
    .filter(|value| !value.trim().is_empty())
    .map(str::to_string);
  let Some(client_id) = client_id else {
    return HttpResponse::json(400, json!({
      "error": "missing_client_id",
      "message": "handoff body must include clientId so cached Context Packs remain bound to the requesting AI client."
    }));
  };
  let handoff = state.store_handoff(request_id.clone(), Some(client_id), mcp_response);
  HttpResponse::json(200, json!({
    "status": "stored",
    "requestId": request_id,
    "expiresAt": system_time_seconds(handoff.expires_at),
    "ttlSeconds": state.retention.handoff_ttl_seconds
  }))
}

fn oauth_resource_from_param(
  raw_resource: Option<&String>,
  config: &RelayConfig,
  required: bool,
) -> Result<Option<String>, HttpResponse> {
  let expected = config.mcp_resource_uri();
  let Some(resource) = raw_resource.map(|value| value.trim()).filter(|value| !value.is_empty())
  else {
    if required {
      return Err(json_response(400, json!({
        "error": "invalid_request",
        "message": "resource is required for public Relay OAuth requests."
      })));
    }
    return Ok(None);
  };
  let normalized = resource.trim_end_matches('/');
  if normalized != expected {
    return Err(json_response(400, json!({
      "error": "invalid_target",
      "message": "OAuth resource must match the Relay MCP endpoint."
    })));
  }
  Ok(Some(expected))
}

fn oauth_authorize(request: &HttpRequest, config: &RelayConfig, state: &RelayState) -> HttpResponse {
  let query = parse_query(&request.query);
  let client_id = query.get("client_id").cloned().unwrap_or_default();
  let redirect_uri = query.get("redirect_uri").cloned().unwrap_or_default();
  let Some(client) = state.client(&client_id) else {
    return json_response(400, json!({
      "error": "invalid_client",
      "message": "Register the OAuth client before authorization."
    }));
  };
  if !client.redirect_uris.iter().any(|uri| uri == &redirect_uri) {
    return json_response(400, json!({
      "error": "invalid_redirect_uri",
      "message": "redirect_uri does not match the registered client."
    }));
  }
  if query.get("response_type").map(String::as_str) != Some("code") {
    return json_response(400, json!({
      "error": "unsupported_response_type"
    }));
  }
  if query.get("code_challenge").is_none() {
    return json_response(400, json!({
      "error": "invalid_request",
      "message": "code_challenge is required."
    }));
  }
  let code_challenge_method = query
    .get("code_challenge_method")
    .map(String::as_str)
    .unwrap_or("S256");
  if !code_challenge_method.eq_ignore_ascii_case("S256")
    && !code_challenge_method.eq_ignore_ascii_case("plain")
  {
    return json_response(400, json!({
      "error": "invalid_request",
      "message": "unsupported code_challenge_method"
    }));
  }
  let scopes = match parse_requested_scopes(query.get("scope").map(String::as_str).unwrap_or_default()) {
    Ok(scopes) => scopes,
    Err(message) => {
      return json_response(400, json!({
        "error": "invalid_scope",
        "message": message
      }));
    }
  };
  let resource = match oauth_resource_from_param(
    query.get("resource"),
    config,
    !is_loopback_bind(&config.bind),
  ) {
    Ok(resource) => resource,
    Err(response) => return response,
  };
  let pending = state.insert_pending_authorization(PendingAuthorization {
    id: random_token("oauth_session"),
    client_id: client_id.clone(),
    redirect_uri: redirect_uri.clone(),
    code_challenge: query
      .get("code_challenge")
      .cloned()
      .unwrap_or_default(),
    code_challenge_method: code_challenge_method.to_string(),
    scopes,
    resource,
    state: query.get("state").filter(|value| !value.is_empty()).cloned(),
    expires_at: seconds_from_now(AUTH_CODE_TTL_SECONDS),
  });

  if env::var("LCV_RELAY_AUTO_APPROVE").ok().as_deref() == Some("1") {
    return issue_auth_code_redirect(pending, state);
  }

  let approve_url = format!(
    "/oauth/approve?{}",
    form_encode(&[("session", pending.id.as_str())])
  );
  HttpResponse::html(
    200,
    format!(
      "<!doctype html><meta charset=\"utf-8\"><title>Life Context Vault Authorization</title>\
       <main style=\"font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:680px;margin:48px auto;line-height:1.5\">\
       <p style=\"text-transform:uppercase;letter-spacing:.08em;color:#667267;font-size:12px\">Life Context Vault</p>\
       <h1>Authorize {}</h1>\
       <p>This grants the AI client access only to Life Context Vault MCP tools. Raw Vault reads are not exposed; data leaves through reviewed Context Packs.</p>\
       <p><strong>Scopes:</strong> {}</p>\
       <p><strong>Resource:</strong> {}</p>\
       <p><a href=\"{}\" style=\"display:inline-block;background:#26352b;color:white;padding:10px 14px;border-radius:8px;text-decoration:none\">Authorize</a></p>\
       </main>",
      html_escape(&client.client_name),
      html_escape(&pending.scopes.join(" ")),
      html_escape(pending.resource.as_deref().unwrap_or("local development fallback")),
      approve_url
    ),
  )
  .with_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
  .with_header("X-Relay-Issuer", &config.base_url)
}

fn oauth_approve(request: &HttpRequest, state: &RelayState) -> HttpResponse {
  let query = parse_query(&request.query);
  let session_id = query.get("session").cloned().unwrap_or_default();
  let Some(pending) = state.consume_pending_authorization(&session_id) else {
    return json_response(400, json!({
      "error": "invalid_request",
      "message": "authorization session is missing or already used."
    }));
  };
  if SystemTime::now() > pending.expires_at {
    return json_response(400, json!({
      "error": "invalid_request",
      "message": "authorization session expired."
    }));
  }
  let Some(client) = state.client(&pending.client_id) else {
    return json_response(400, json!({
      "error": "invalid_client"
    }));
  };
  if !client
    .redirect_uris
    .iter()
    .any(|uri| uri == &pending.redirect_uri)
  {
    return json_response(400, json!({
      "error": "invalid_redirect_uri"
    }));
  }
  issue_auth_code_redirect(pending, state)
}

fn issue_auth_code_redirect(pending: PendingAuthorization, state: &RelayState) -> HttpResponse {
  if pending.client_id.is_empty()
    || pending.redirect_uri.is_empty()
    || pending.code_challenge.is_empty()
    || pending.scopes.is_empty()
  {
    return json_response(400, json!({
      "error": "invalid_request",
      "message": "authorization session is incomplete."
    }));
  }
  let code = random_token("code");
  state.insert_auth_code(
    code.clone(),
    AuthCode {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri.clone(),
      code_challenge: pending.code_challenge,
      code_challenge_method: pending.code_challenge_method,
      scopes: pending.scopes,
      resource: pending.resource,
      expires_at: seconds_from_now(AUTH_CODE_TTL_SECONDS),
    },
  );

  let mut redirect = format!("{}?code={}", pending.redirect_uri, url_encode(&code));
  if let Some(state_value) = pending.state.filter(|value| !value.is_empty()) {
    redirect.push_str("&state=");
    redirect.push_str(&url_encode(&state_value));
  }
  HttpResponse::redirect(&redirect)
}

fn oauth_token(request: &HttpRequest, config: &RelayConfig, state: &RelayState) -> HttpResponse {
  let form = parse_query(&request.body);
  if form.get("grant_type").map(String::as_str) != Some("authorization_code") {
    return json_response(400, json!({
      "error": "unsupported_grant_type"
    }));
  }
  let code = form.get("code").cloned().unwrap_or_default();
  let Some(auth_code) = state.consume_auth_code(&code) else {
    return json_response(400, json!({
      "error": "invalid_grant"
    }));
  };
  if SystemTime::now() > auth_code.expires_at {
    return json_response(400, json!({
      "error": "invalid_grant",
      "message": "authorization code expired"
    }));
  }
  if form.get("redirect_uri").map(String::as_str) != Some(auth_code.redirect_uri.as_str()) {
    return json_response(400, json!({
      "error": "invalid_grant",
      "message": "redirect_uri mismatch"
    }));
  }
  let verifier = form.get("code_verifier").cloned().unwrap_or_default();
  if !verify_pkce(
    &auth_code.code_challenge,
    &auth_code.code_challenge_method,
    &verifier,
  ) {
    return json_response(400, json!({
      "error": "invalid_grant",
      "message": "PKCE verification failed"
    }));
  }
  let token_resource = match oauth_resource_from_param(
    form.get("resource"),
    config,
    auth_code.resource.is_some() || !is_loopback_bind(&config.bind),
  ) {
    Ok(resource) => resource,
    Err(response) => return response,
  };
  let resource = match (auth_code.resource.clone(), token_resource) {
    (Some(expected), Some(actual)) if expected == actual => Some(expected),
    (Some(_), Some(_)) => {
      return json_response(400, json!({
        "error": "invalid_target",
        "message": "token resource does not match the authorized MCP resource."
      }));
    }
    (Some(_), None) => {
      return json_response(400, json!({
        "error": "invalid_request",
        "message": "resource is required for this authorization code."
      }));
    }
    (None, Some(actual)) => Some(actual),
    (None, None) => None,
  };

  let token = random_token("lcv_at");
  let expires_at = seconds_from_now(OAUTH_TOKEN_TTL_SECONDS);
  state.insert_access_token(
    token.clone(),
    AccessToken {
      client_id: auth_code.client_id.clone(),
      scopes: auth_code.scopes.clone(),
      resource,
      expires_at,
    },
  );
  json_response(200, json!({
    "access_token": token,
    "token_type": "Bearer",
    "expires_in": OAUTH_TOKEN_TTL_SECONDS,
    "scope": auth_code.scopes.join(" ")
  }))
}

fn start_pairing(request: &HttpRequest, config: &RelayConfig, state: &RelayState) -> HttpResponse {
  if !admin_authorized(request, config) {
    return json_response(401, json!({
      "error": "unauthorized",
      "message": "Pairing start requires loopback access or LCV_RELAY_ADMIN_TOKEN."
    }))
    .with_header("WWW-Authenticate", "Bearer");
  }
  let session = state.start_pairing();
  json_response(200, json!({
    "pairingId": session.id,
    "pairingCode": session.code,
    "status": pairing_status_text(&session.status),
    "expiresAt": system_time_seconds(session.expires_at),
    "agentWebSocketUrl": format!(
      "{}/agent/ws?pairing_code={}",
      config.ws_base_url(),
      session.code
    )
  }))
}

fn pairing_status(request: &HttpRequest, state: &RelayState) -> HttpResponse {
  let query = parse_query(&request.query);
  let code = query.get("code").cloned().unwrap_or_default();
  let Some(session) = state.pairing_by_code(&code) else {
    return json_response(404, json!({
      "error": "pairing_not_found"
    }));
  };
  json_response(200, json!({
    "pairingId": session.id,
    "status": pairing_status_text(&session.status),
    "createdAt": system_time_seconds(session.created_at),
    "expiresAt": system_time_seconds(session.expires_at),
    "connectedAt": session.connected_at.map(system_time_seconds)
  }))
}

fn handle_mcp_request(request: &HttpRequest, config: &RelayConfig, state: &RelayState) -> HttpResponse {
  let protocol_version = match mcp_protocol_version_for_request(request) {
    Ok(protocol_version) => protocol_version,
    Err(message) => {
      return mcp_json_response(request, config, 400, json!({
        "error": "unsupported_protocol_version",
        "message": message,
        "supportedProtocolVersions": SUPPORTED_MCP_PROTOCOL_VERSIONS
      }));
    }
  };
  if let Some(response) = mcp_transport_header_error(request, config, &protocol_version) {
    return response;
  }

  let required_scope = required_scope_for_mcp_body(&request.body);
  let (method, tool_name) = mcp_request_summary(&request.body);
  let Some(client_id) = mcp_authorized_client(request, config, state, required_scope) else {
    record_relay_event(
      state,
      None,
      required_scope,
      &method,
      tool_name.as_deref(),
      "rejected_unauthorized",
      "none",
    );
    return mcp_json_response(request, config, 401, json!({
      "error": "unauthorized",
      "message": "Missing or invalid Authorization bearer token."
    }))
    .with_mcp_protocol_version(&protocol_version)
    .with_header(
      "WWW-Authenticate",
      &mcp_www_authenticate_challenge(config, required_scope),
    );
  };
  if let Some(response) = mcp_session_error_for_request(
    request,
    config,
    state,
    &protocol_version,
    &client_id,
  ) {
    record_relay_event(
      state,
      Some(client_id),
      required_scope,
      &method,
      tool_name.as_deref(),
      "rejected_session",
      "http_session",
    );
    return response;
  }

  match state.forward_to_agent(&request.body, &client_id) {
    Ok(Some(body)) => {
      record_relay_event(
        state,
        Some(client_id.clone()),
        required_scope,
        &method,
        tool_name.as_deref(),
        "fulfilled",
        "agent_websocket",
      );
      return fulfilled_mcp_response(
        request,
        config,
        state,
        &protocol_version,
        &client_id,
        body,
      );
    }
    Ok(None) => {
      record_relay_event(
        state,
        Some(client_id.clone()),
        required_scope,
        &method,
        tool_name.as_deref(),
        "accepted_no_body",
        "agent_websocket",
      );
      return HttpResponse::empty(202)
        .with_mcp_protocol_version(&protocol_version)
        .with_cors_for_request(request, config);
    }
    Err(agent_error) => {
      if !config.allow_direct_sidecar {
        if let Some(handoff_body) = handoff_response_for_mcp_request(state, &request.body, &client_id) {
          record_relay_event(
            state,
            Some(client_id.clone()),
            required_scope,
            &method,
            tool_name.as_deref(),
            "fulfilled_handoff_cache",
            "relay_handoff_cache",
          );
          return fulfilled_mcp_response(
            request,
            config,
            state,
            &protocol_version,
            &client_id,
            handoff_body,
          );
        }
        record_relay_event(
          state,
          Some(client_id.clone()),
          required_scope,
          &method,
          tool_name.as_deref(),
          "pending_agent_offline",
          "none",
        );
        return mcp_json_response(request, config, 202, json!({
          "status": "pending_agent_offline",
          "message": "Local Vault Agent is offline; request is waiting for the user's desktop.",
          "detail": agent_error
        }))
        .with_mcp_protocol_version(&protocol_version);
      }
    }
  }

  match mcp_stdio::forward_to_stdio_mcp(
    &request.body,
    &config.mcp_command,
    config.vault_db_path.as_deref(),
    Some(&client_id),
  ) {
    Ok(Some(body)) => {
      record_relay_event(
        state,
        Some(client_id.clone()),
        required_scope,
        &method,
        tool_name.as_deref(),
        "fulfilled",
        "direct_sidecar_fallback",
      );
      fulfilled_mcp_response(
        request,
        config,
        state,
        &protocol_version,
        &client_id,
        body,
      )
    }
    Ok(None) => {
      record_relay_event(
        state,
        Some(client_id.clone()),
        required_scope,
        &method,
        tool_name.as_deref(),
        "accepted_no_body",
        "direct_sidecar_fallback",
      );
      HttpResponse::empty(202)
        .with_mcp_protocol_version(&protocol_version)
        .with_cors_for_request(request, config)
    }
    Err(error) => {
      if let Some(handoff_body) = handoff_response_for_mcp_request(state, &request.body, &client_id) {
        record_relay_event(
          state,
          Some(client_id.clone()),
          required_scope,
          &method,
          tool_name.as_deref(),
          "fulfilled_handoff_cache",
          "relay_handoff_cache",
        );
        return fulfilled_mcp_response(
          request,
          config,
          state,
          &protocol_version,
          &client_id,
          handoff_body,
        );
      }
      record_relay_event(
        state,
        Some(client_id.clone()),
        required_scope,
        &method,
        tool_name.as_deref(),
        "forward_failed",
        "direct_sidecar_fallback",
      );
      mcp_json_response(request, config, 500, json!({
        "error": "relay_forward_failed",
        "message": error
      }))
      .with_mcp_protocol_version(&protocol_version)
    }
  }
}

fn handle_mcp_session_delete(
  request: &HttpRequest,
  config: &RelayConfig,
  state: &RelayState,
) -> HttpResponse {
  let protocol_version = match mcp_protocol_version_for_request(request) {
    Ok(protocol_version) => protocol_version,
    Err(message) => {
      return mcp_json_response(request, config, 400, json!({
        "error": "unsupported_protocol_version",
        "message": message,
        "supportedProtocolVersions": SUPPORTED_MCP_PROTOCOL_VERSIONS
      }));
    }
  };
  let Some(client_id) = mcp_authenticated_client(request, config, state) else {
    record_relay_event(
      state,
      None,
      "session",
      "DELETE",
      None,
      "rejected_unauthorized",
      "http_session",
    );
    return mcp_json_response(request, config, 401, json!({
      "error": "unauthorized",
      "message": "Missing or invalid Authorization bearer token."
    }))
    .with_mcp_protocol_version(&protocol_version)
    .with_header(
      "WWW-Authenticate",
      &mcp_www_authenticate_challenge(config, "policy.read"),
    );
  };
  let Some(session_id) = mcp_session_id_header(request) else {
    record_relay_event(
      state,
      Some(client_id),
      "session",
      "DELETE",
      None,
      "missing_session",
      "http_session",
    );
    return mcp_json_response(request, config, 400, json!({
      "error": "missing_mcp_session",
      "message": "DELETE /mcp requires MCP-Session-Id."
    }))
    .with_mcp_protocol_version(&protocol_version);
  };
  match state.terminate_mcp_session(&session_id, &client_id) {
    Ok(()) => {
      record_relay_event(
        state,
        Some(client_id),
        "session",
        "DELETE",
        None,
        "session_terminated",
        "http_session",
      );
      HttpResponse::empty(204)
        .with_mcp_protocol_version(&protocol_version)
        .with_cors_for_request(request, config)
    }
    Err(_) => {
      record_relay_event(
        state,
        Some(client_id),
        "session",
        "DELETE",
        None,
        "session_not_found",
        "http_session",
      );
      mcp_json_response(request, config, 404, json!({
        "error": "mcp_session_not_found",
        "message": "MCP session is missing, expired, or belongs to another client."
      }))
      .with_mcp_protocol_version(&protocol_version)
    }
  }
}

fn fulfilled_mcp_response(
  request: &HttpRequest,
  config: &RelayConfig,
  state: &RelayState,
  protocol_version: &str,
  client_id: &str,
  body: Value,
) -> HttpResponse {
  let mut response = HttpResponse::json(200, body.clone())
    .with_mcp_protocol_version(protocol_version)
    .with_cors_for_request(request, config);
  if should_start_mcp_session(&request.body, &body) {
    let session = state.start_mcp_session(client_id.to_string());
    response = response.with_header("MCP-Session-Id", &session.id);
  }
  response
}

fn mcp_session_error_for_request(
  request: &HttpRequest,
  config: &RelayConfig,
  state: &RelayState,
  protocol_version: &str,
  client_id: &str,
) -> Option<HttpResponse> {
  if let Some(session_id) = mcp_session_id_header(request) {
    if state.touch_mcp_session(&session_id, client_id).is_err() {
      return Some(
        mcp_json_response(request, config, 404, json!({
          "error": "mcp_session_not_found",
          "message": "MCP session is missing, expired, or belongs to another client."
        }))
        .with_mcp_protocol_version(protocol_version),
      );
    }
    return None;
  }
  if !is_initialize_request(&request.body) && state.client_has_mcp_session(client_id) {
    return Some(
      mcp_json_response(request, config, 400, json!({
        "error": "missing_mcp_session",
        "message": "This client has an active MCP session and must include MCP-Session-Id."
      }))
      .with_mcp_protocol_version(protocol_version),
    );
  }
  None
}

fn mcp_session_id_header(request: &HttpRequest) -> Option<String> {
  request
    .header("MCP-Session-Id")
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

fn is_initialize_request(body: &str) -> bool {
  serde_json::from_str::<Value>(body)
    .ok()
    .and_then(|value| value.get("method").and_then(Value::as_str).map(str::to_string))
    .as_deref()
    == Some("initialize")
}

fn should_start_mcp_session(request_body: &str, response_body: &Value) -> bool {
  is_initialize_request(request_body)
    && response_body.get("result").is_some()
    && response_body.get("error").is_none()
}

fn mcp_transport_header_error(
  request: &HttpRequest,
  config: &RelayConfig,
  protocol_version: &str,
) -> Option<HttpResponse> {
  if !content_type_is_json(request.header("Content-Type")) {
    return Some(
      mcp_json_response(request, config, 415, json!({
        "error": "unsupported_media_type",
        "message": "MCP Streamable HTTP POST requests must use Content-Type: application/json."
      }))
      .with_mcp_protocol_version(protocol_version),
    );
  }

  if !accepts_mcp_post_response_types(request) {
    return Some(
      mcp_json_response(request, config, 406, json!({
        "error": "not_acceptable",
        "message": "MCP Streamable HTTP POST requests must include Accept with application/json and text/event-stream."
      }))
      .with_mcp_protocol_version(protocol_version),
    );
  }

  None
}

fn content_type_is_json(content_type: Option<&str>) -> bool {
  media_type_without_parameters(content_type.unwrap_or_default())
    .map(|media_type| media_type.eq_ignore_ascii_case("application/json"))
    .unwrap_or(false)
}

fn accepts_mcp_post_response_types(request: &HttpRequest) -> bool {
  let accept_values = request.header_values("Accept");
  !accept_values.is_empty()
    && ["application/json", "text/event-stream"]
      .iter()
      .all(|required| media_range_accepts(&accept_values, required))
}

fn media_range_accepts(header_values: &[&str], required: &str) -> bool {
  header_values.iter().any(|value| {
    value.split(',').any(|part| {
      let Some(media_type) = media_type_without_parameters(part) else {
        return false;
      };
      media_type.eq_ignore_ascii_case(required)
        || media_type == "*/*"
        || required
          .split_once('/')
          .map(|(required_type, _)| media_type == format!("{required_type}/*"))
          .unwrap_or(false)
    })
  })
}

fn media_type_without_parameters(value: &str) -> Option<String> {
  let media_type = value
    .split_once(';')
    .map(|(media_type, _)| media_type)
    .unwrap_or(value)
    .trim()
    .to_ascii_lowercase();
  if media_type.is_empty() {
    None
  } else {
    Some(media_type)
  }
}

fn required_scope_for_mcp_body(body: &str) -> &'static str {
  let Ok(value) = serde_json::from_str::<Value>(body) else {
    return "context_pack.request";
  };
  if value.get("method").and_then(Value::as_str) != Some("tools/call") {
    return "policy.read";
  }
  match value
    .get("params")
    .and_then(|params| params.get("name"))
    .and_then(Value::as_str)
  {
    Some("life_context.propose_memory") => "memory.propose",
    Some("life_context.get_policy_summary") => "policy.read",
    Some("life_context.get_request_status") => "request.status",
    Some("life_context.request_context_pack") => "context_pack.request",
    _ => "context_pack.request",
  }
}

fn mcp_request_summary(body: &str) -> (String, Option<String>) {
  let Ok(value) = serde_json::from_str::<Value>(body) else {
    return ("invalid_json".to_string(), None);
  };
  let method = value
    .get("method")
    .and_then(Value::as_str)
    .unwrap_or("unknown")
    .to_string();
  let tool_name = value
    .get("params")
    .and_then(|params| params.get("name"))
    .and_then(Value::as_str)
    .map(str::to_string);
  (method, tool_name)
}

fn request_status_request_id_from_mcp_body(body: &str) -> Option<String> {
  let value = serde_json::from_str::<Value>(body).ok()?;
  if value.get("method").and_then(Value::as_str) != Some("tools/call") {
    return None;
  }
  let params = value.get("params")?;
  if params.get("name").and_then(Value::as_str) != Some("life_context.get_request_status") {
    return None;
  }
  params
    .get("arguments")
    .and_then(|arguments| arguments.get("requestId"))
    .and_then(Value::as_str)
    .filter(|request_id| !request_id.trim().is_empty())
    .map(str::to_string)
}

fn handoff_response_for_mcp_request(state: &RelayState, body: &str, client_id: &str) -> Option<Value> {
  let request_id = request_status_request_id_from_mcp_body(body)?;
  state.handoff_response(&request_id, client_id)
}

fn validate_handoff_mcp_response(response: &Value) -> Result<String, String> {
  let structured = response
    .get("result")
    .and_then(|result| result.get("structuredContent"))
    .or_else(|| response.get("structuredContent"))
    .ok_or_else(|| "handoff must contain MCP structuredContent".to_string())?;
  if structured.get("status").and_then(Value::as_str) != Some("fulfilled") {
    return Err("handoff structuredContent must be fulfilled".to_string());
  }
  let request_id = structured
    .get("requestId")
    .and_then(Value::as_str)
    .filter(|request_id| !request_id.trim().is_empty())
    .ok_or_else(|| "handoff structuredContent must include requestId".to_string())?;
  let trust_boundary = structured
    .get("contextPack")
    .and_then(|context_pack| context_pack.get("trustBoundary"))
    .and_then(Value::as_str);
  if trust_boundary != Some("ContextPack only") {
    return Err("handoff contextPack must declare trustBoundary: ContextPack only".to_string());
  }
  Ok(request_id.to_string())
}

fn record_relay_event(
  state: &RelayState,
  client_id: Option<String>,
  required_scope: &str,
  method: &str,
  tool_name: Option<&str>,
  status: &str,
  transport: &str,
) {
  let event = RelayRequestEvent {
    tenant_id: String::new(),
    id: random_token("relay_evt"),
    client_id,
    required_scope: required_scope.to_string(),
    method: method.to_string(),
    tool_name: tool_name.map(str::to_string),
    status: status.to_string(),
    transport: transport.to_string(),
    occurred_at: system_time_seconds(SystemTime::now()),
  };
  if let Err(error) = state.record_request_event(event) {
    eprintln!("failed to persist relay request event: {error}");
  }
}

fn handle_agent_websocket(stream: TcpStream, state: &RelayState) -> Result<(), String> {
  let request_uri = Arc::new(Mutex::new(String::new()));
  let request_uri_for_callback = request_uri.clone();
  let mut websocket = accept_hdr(stream, move |request: &tungstenite::handshake::server::Request, response| {
    if let Ok(mut uri) = request_uri_for_callback.lock() {
      *uri = request.uri().to_string();
    }
    Ok(response)
  })
  .map_err(|error| format!("failed to accept agent websocket: {error}"))?;

  let uri = request_uri.lock().expect("request uri").clone();
  let query = uri
    .split_once('?')
    .map(|(_, query)| parse_query(query))
    .unwrap_or_default();
  let code = query.get("pairing_code").cloned().unwrap_or_default();
  let (outbound_tx, outbound_rx) = mpsc::channel::<String>();
  let session = match state.connect_agent(&code, outbound_tx) {
    Ok(session) => session,
    Err(error) => {
      let _ = websocket.send(Message::Text(json!({
        "type": "agent_error",
        "error": error
      }).to_string().into()));
      let _ = websocket.close(None);
      return Ok(());
    }
  };
  eprintln!("Life Context Vault agent paired: {}", session.id);
  websocket
    .get_mut()
    .set_read_timeout(Some(Duration::from_millis(200)))
    .map_err(|error| format!("failed to set agent websocket timeout: {error}"))?;

  loop {
    while let Ok(outbound) = outbound_rx.try_recv() {
      websocket
        .send(Message::Text(outbound.into()))
        .map_err(|error| format!("failed to write agent websocket message: {error}"))?;
    }

    match websocket.read() {
      Ok(Message::Text(text)) => handle_agent_message(text.as_str(), state),
      Ok(Message::Ping(payload)) => {
        websocket
          .send(Message::Pong(payload))
          .map_err(|error| format!("failed to write agent pong: {error}"))?;
      }
      Ok(Message::Close(_)) => break,
      Ok(_) => {}
      Err(tungstenite::Error::Io(error))
        if error.kind() == std::io::ErrorKind::WouldBlock
          || error.kind() == std::io::ErrorKind::TimedOut => {}
      Err(error) => return Err(format!("agent websocket read failed: {error}")),
    }
  }
  state.disconnect_agent();
  Ok(())
}

fn handle_agent_message(text: &str, state: &RelayState) {
  let parsed = match serde_json::from_str::<Value>(text) {
    Ok(value) => value,
    Err(error) => {
      eprintln!("agent returned invalid JSON: {error}");
      return;
    }
  };
  if parsed.get("type").and_then(Value::as_str) != Some("mcp_response") {
    return;
  }
  let id = parsed.get("id").and_then(Value::as_str).unwrap_or_default();
  if id.is_empty() {
    return;
  }
  if let Some(error) = parsed.get("error").and_then(Value::as_str) {
    state.complete_agent_response(id, Err(error.to_string()));
    return;
  }
  state.complete_agent_response(id, Ok(parsed.get("body").cloned()));
}

fn is_agent_websocket_request(stream: &TcpStream) -> Result<bool, String> {
  let mut buffer = [0u8; 512];
  let len = stream
    .peek(&mut buffer)
    .map_err(|error| format!("failed to peek request: {error}"))?;
  let preview = String::from_utf8_lossy(&buffer[..len]);
  Ok(preview.starts_with("GET /agent/ws") && preview.to_ascii_lowercase().contains("upgrade: websocket"))
}

#[derive(Clone, Debug)]
struct HttpRequest {
  method: String,
  path: String,
  query: String,
  headers: Vec<(String, String)>,
  body: String,
}

impl HttpRequest {
  fn read(stream: &mut TcpStream) -> Result<Self, String> {
    let mut reader = BufReader::new(stream);
    let mut start = String::new();
    reader
      .read_line(&mut start)
      .map_err(|error| format!("failed to read request line: {error}"))?;
    let parts: Vec<&str> = start.split_whitespace().collect();
    if parts.len() < 2 {
      return Err("malformed HTTP request line".to_string());
    }

    let mut headers = Vec::new();
    let mut content_length = 0usize;
    loop {
      let mut line = String::new();
      reader
        .read_line(&mut line)
        .map_err(|error| format!("failed to read header: {error}"))?;
      let trimmed = line.trim_end_matches(['\r', '\n']);
      if trimmed.is_empty() {
        break;
      }
      if let Some((name, value)) = trimmed.split_once(':') {
        let name = name.trim().to_string();
        let value = value.trim().to_string();
        if name.eq_ignore_ascii_case("content-length") {
          content_length = value.parse::<usize>().unwrap_or(0);
        }
        headers.push((name, value));
      }
    }

    let mut body_bytes = vec![0; content_length];
    if content_length > 0 {
      reader
        .read_exact(&mut body_bytes)
        .map_err(|error| format!("failed to read body: {error}"))?;
    }

    let request_target = parts[1].to_string();
    let (path, query) = request_target
      .split_once('?')
      .map(|(path, query)| (path.to_string(), query.to_string()))
      .unwrap_or_else(|| (request_target.clone(), String::new()));

    Ok(Self {
      method: parts[0].to_string(),
      path,
      query,
      headers,
      body: String::from_utf8_lossy(&body_bytes).to_string(),
    })
  }

  fn header(&self, name: &str) -> Option<&str> {
    self
      .headers
      .iter()
      .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
      .map(|(_, value)| value.as_str())
  }

  fn header_values(&self, name: &str) -> Vec<&str> {
    self
      .headers
      .iter()
      .filter(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
      .map(|(_, value)| value.as_str())
      .collect()
  }
}

struct HttpResponse {
  status: u16,
  reason: &'static str,
  headers: Vec<(String, String)>,
  body: Vec<u8>,
}

impl HttpResponse {
  fn json(status: u16, body: Value) -> Self {
    let mut response = Self {
      status,
      reason: reason_phrase(status),
      headers: vec![("Content-Type".to_string(), "application/json".to_string())],
      body: body.to_string().into_bytes(),
    };
    response.headers.push(("Cache-Control".to_string(), "no-store".to_string()));
    response
  }

  fn html(status: u16, body: String) -> Self {
    let mut response = Self {
      status,
      reason: reason_phrase(status),
      headers: vec![("Content-Type".to_string(), "text/html; charset=utf-8".to_string())],
      body: body.into_bytes(),
    };
    response.headers.push(("Cache-Control".to_string(), "no-store".to_string()));
    response
  }

  fn redirect(location: &str) -> Self {
    Self::empty(302).with_header("Location", location)
  }

  fn empty(status: u16) -> Self {
    Self {
      status,
      reason: reason_phrase(status),
      headers: Vec::new(),
      body: Vec::new(),
    }
  }

  fn with_header(mut self, name: &str, value: &str) -> Self {
    self.headers.push((name.to_string(), value.to_string()));
    self
  }

  fn with_mcp_protocol_version(self, protocol_version: &str) -> Self {
    self.with_header("MCP-Protocol-Version", protocol_version)
  }

  fn with_cors(self) -> Self {
    self
      .with_header("Access-Control-Allow-Origin", "*")
      .with_header("Access-Control-Allow-Headers", RELAY_CORS_ALLOW_HEADERS)
      .with_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  }

  fn with_cors_for_request(self, request: &HttpRequest, config: &RelayConfig) -> Self {
    let Some(origin) = cors_origin_for_request(request, config) else {
      return self;
    };
    let response = self
      .with_header("Access-Control-Allow-Origin", &origin)
      .with_header("Access-Control-Allow-Headers", RELAY_CORS_ALLOW_HEADERS)
      .with_header("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
    if origin == "*" {
      response
    } else {
      response.with_header("Vary", "Origin")
    }
  }

  fn write_to(&self, stream: &mut TcpStream) -> Result<(), String> {
    write!(stream, "HTTP/1.1 {} {}\r\n", self.status, self.reason)
      .map_err(|error| format!("failed to write response line: {error}"))?;
    for (name, value) in &self.headers {
      write!(stream, "{name}: {value}\r\n")
        .map_err(|error| format!("failed to write response header: {error}"))?;
    }
    write!(stream, "Content-Length: {}\r\n\r\n", self.body.len())
      .map_err(|error| format!("failed to write content length: {error}"))?;
    stream
      .write_all(&self.body)
      .map_err(|error| format!("failed to write response body: {error}"))
  }
}

fn json_response(status: u16, body: Value) -> HttpResponse {
  HttpResponse::json(status, body).with_cors()
}

fn mcp_json_response(
  request: &HttpRequest,
  config: &RelayConfig,
  status: u16,
  body: Value,
) -> HttpResponse {
  HttpResponse::json(status, body).with_cors_for_request(request, config)
}

fn cors_preflight_response(request: &HttpRequest, config: &RelayConfig) -> HttpResponse {
  if cors_origin_for_request(request, config).is_some() {
    HttpResponse::empty(204).with_cors_for_request(request, config)
  } else {
    cors_forbidden_response()
  }
}

fn cors_forbidden_response() -> HttpResponse {
  HttpResponse::json(403, json!({
    "error": "origin_not_allowed",
    "message": "This Relay endpoint is not available to the request Origin."
  }))
}

fn cors_origin_for_request(request: &HttpRequest, config: &RelayConfig) -> Option<String> {
  let Some(origin) = request.header("Origin") else {
    return Some("*".to_string());
  };
  let normalized_origin = origin.trim().trim_end_matches('/');
  if normalized_origin.is_empty() {
    return Some("*".to_string());
  }
  if config.allowed_origins.is_empty() && is_loopback_bind(&config.bind) {
    return Some("*".to_string());
  }
  if config.allowed_origins.iter().any(|allowed| allowed == "*") {
    return Some("*".to_string());
  }
  if config
    .allowed_origins
    .iter()
    .any(|allowed| allowed == normalized_origin)
  {
    return Some(normalized_origin.to_string());
  }
  None
}

fn mcp_protocol_version_for_request(request: &HttpRequest) -> Result<String, String> {
  let Some(protocol_version) = request
    .header("MCP-Protocol-Version")
    .map(str::trim)
    .filter(|value| !value.is_empty())
  else {
    return Ok(DEFAULT_MCP_PROTOCOL_VERSION.to_string());
  };
  if SUPPORTED_MCP_PROTOCOL_VERSIONS
    .iter()
    .any(|supported| *supported == protocol_version)
  {
    Ok(protocol_version.to_string())
  } else {
    Err(format!(
      "unsupported MCP protocol version '{}'; supported versions: {}",
      protocol_version,
      SUPPORTED_MCP_PROTOCOL_VERSIONS.join(", ")
    ))
  }
}

fn mcp_www_authenticate_challenge(config: &RelayConfig, required_scope: &str) -> String {
  format!(
    "Bearer resource_metadata=\"{}\", scope=\"{}\"",
    config.protected_resource_metadata_uri(),
    required_scope
  )
}

fn mcp_authenticated_client(
  request: &HttpRequest,
  config: &RelayConfig,
  state: &RelayState,
) -> Option<String> {
  let Some(token) = bearer_token(request) else {
    return None;
  };
  if config.allow_static_bearer && token == config.token {
    return Some("static-dev-token".to_string());
  }
  let Some(access_token) = state.access_token(token) else {
    return None;
  };
  if SystemTime::now() > access_token.expires_at {
    return None;
  }
  match access_token.resource.as_deref() {
    Some(resource) if resource == config.mcp_resource_uri() => {}
    Some(_) => return None,
    None if !is_loopback_bind(&config.bind) => return None,
    None => {}
  }
  Some(access_token.client_id)
}

fn mcp_authorized_client(
  request: &HttpRequest,
  config: &RelayConfig,
  state: &RelayState,
  required_scope: &str,
) -> Option<String> {
  let Some(token) = bearer_token(request) else {
    return None;
  };
  if config.allow_static_bearer && token == config.token {
    return Some("static-dev-token".to_string());
  }
  let Some(access_token) = state.access_token(token) else {
    return None;
  };
  if SystemTime::now() > access_token.expires_at {
    return None;
  }
  match access_token.resource.as_deref() {
    Some(resource) if resource == config.mcp_resource_uri() => {}
    Some(_) => return None,
    None if !is_loopback_bind(&config.bind) => return None,
    None => {}
  }
  if access_token.scopes.iter().any(|scope| scope == required_scope) {
    Some(access_token.client_id)
  } else {
    None
  }
}

fn admin_authorized(request: &HttpRequest, config: &RelayConfig) -> bool {
  if is_loopback_bind(&config.bind) && config.admin_token.is_none() {
    return request.header("Origin").is_none() && request.header("Referer").is_none();
  }
  match (&config.admin_token, bearer_token(request)) {
    (Some(expected), Some(actual)) => expected == actual,
    _ => false,
  }
}

fn bearer_token(request: &HttpRequest) -> Option<&str> {
  request.header("Authorization")?.strip_prefix("Bearer ")
}

fn is_loopback_bind(bind: &str) -> bool {
  bind.starts_with("127.") || bind.starts_with("localhost:") || bind.starts_with("[::1]:")
}

fn verify_pkce(challenge: &str, method: &str, verifier: &str) -> bool {
  if verifier.is_empty() {
    return false;
  }
  if method.eq_ignore_ascii_case("plain") {
    return challenge == verifier;
  }
  if !method.eq_ignore_ascii_case("S256") {
    return false;
  }
  let digest = Sha256::digest(verifier.as_bytes());
  URL_SAFE_NO_PAD.encode(digest) == challenge
}

fn parse_requested_scopes(scope_text: &str) -> Result<Vec<String>, String> {
  let tokens: Vec<&str> = scope_text.split_whitespace().collect();
  if tokens.is_empty() {
    return Err("At least one supported scope is required.".to_string());
  }
  let mut requested = Vec::new();
  for scope in tokens {
    if !SUPPORTED_SCOPES.contains(&scope) {
      return Err(format!("Unsupported scope: {scope}"));
    }
    if !requested.iter().any(|existing| existing == scope) {
      requested.push(scope.to_string());
    }
  }
  Ok(requested)
}

fn parse_query(query: &str) -> HashMap<String, String> {
  let mut values = HashMap::new();
  for pair in query.split('&').filter(|pair| !pair.is_empty()) {
    let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
    values.insert(percent_decode(key), percent_decode(value));
  }
  values
}

fn form_encode(values: &[(&str, &str)]) -> String {
  values
    .iter()
    .map(|(key, value)| format!("{}={}", url_encode(key), url_encode(value)))
    .collect::<Vec<_>>()
    .join("&")
}

fn percent_decode(value: &str) -> String {
  let value = value.replace('+', " ");
  let mut output = Vec::new();
  let bytes = value.as_bytes();
  let mut index = 0usize;
  while index < bytes.len() {
    if bytes[index] == b'%' && index + 2 < bytes.len() {
      if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
        output.push(hex);
        index += 3;
        continue;
      }
    }
    output.push(bytes[index]);
    index += 1;
  }
  String::from_utf8_lossy(&output).to_string()
}

fn url_encode(value: &str) -> String {
  let mut output = String::new();
  for byte in value.bytes() {
    if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
      output.push(byte as char);
    } else {
      output.push_str(&format!("%{byte:02X}"));
    }
  }
  output
}

fn html_escape(value: &str) -> String {
  value
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
}

fn random_token(prefix: &str) -> String {
  format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(random_bytes(24)))
}

fn random_bytes(count: usize) -> Vec<u8> {
  let mut bytes = vec![0u8; count];
  getrandom::getrandom(&mut bytes)
    .expect("OS randomness is required to generate Relay tokens");
  bytes
}

fn seconds_from_now(seconds: u64) -> SystemTime {
  SystemTime::now() + Duration::from_secs(seconds)
}

fn system_time_seconds(time: SystemTime) -> u64 {
  time
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs())
    .unwrap_or_default()
}

fn pairing_status_text(status: &PairingStatus) -> &'static str {
  match status {
    PairingStatus::Pending => "pending",
    PairingStatus::Connected => "connected",
    PairingStatus::Expired => "expired",
  }
}

fn reason_phrase(status: u16) -> &'static str {
  match status {
    200 => "OK",
    201 => "Created",
    202 => "Accepted",
    204 => "No Content",
    302 => "Found",
    400 => "Bad Request",
    401 => "Unauthorized",
    403 => "Forbidden",
    404 => "Not Found",
    405 => "Method Not Allowed",
    406 => "Not Acceptable",
    415 => "Unsupported Media Type",
    500 => "Internal Server Error",
    _ => "OK",
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn test_config() -> RelayConfig {
    RelayConfig {
      bind: "127.0.0.1:8765".to_string(),
      base_url: "http://127.0.0.1:8765".to_string(),
      token: "test-token".to_string(),
      admin_token: None,
      allow_static_bearer: true,
      tenant_id: DEFAULT_LOCAL_TENANT_ID.to_string(),
      mcp_command: PathBuf::from("lcv-mcp"),
      vault_db_path: None,
      relay_state_path: None,
      allow_direct_sidecar: true,
      allowed_origins: Vec::new(),
      retention: RelayRetentionPolicy::default(),
    }
  }

  fn response_header<'a>(response: &'a HttpResponse, name: &str) -> Option<&'a str> {
    response
      .headers
      .iter()
      .find(|(candidate, _)| candidate.eq_ignore_ascii_case(name))
      .map(|(_, value)| value.as_str())
  }

  fn mcp_post_headers() -> Vec<(String, String)> {
    vec![
      ("Content-Type".to_string(), "application/json".to_string()),
      (
        "Accept".to_string(),
        "application/json, text/event-stream".to_string(),
      ),
    ]
  }

  fn authorized_mcp_post_headers(token: &str) -> Vec<(String, String)> {
    let mut headers = mcp_post_headers();
    headers.push(("Authorization".to_string(), format!("Bearer {token}")));
    headers
  }

  fn authorized_mcp_delete_headers(token: &str, session_id: &str) -> Vec<(String, String)> {
    vec![
      ("Authorization".to_string(), format!("Bearer {token}")),
      ("MCP-Session-Id".to_string(), session_id.to_string()),
      ("MCP-Protocol-Version".to_string(), "2025-11-25".to_string()),
    ]
  }

  fn public_test_config() -> RelayConfig {
    RelayConfig {
      bind: "0.0.0.0:8765".to_string(),
      base_url: "https://relay.example.com".to_string(),
      admin_token: Some("admin-secret".to_string()),
      allow_static_bearer: false,
      tenant_id: "tenant-test".to_string(),
      allow_direct_sidecar: false,
      allowed_origins: vec!["https://chatgpt.com".to_string()],
      ..test_config()
    }
  }

  #[test]
  fn get_mcp_returns_method_not_allowed_boundary() {
    let request = HttpRequest {
      method: "GET".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: Vec::new(),
      body: String::new(),
    };

    let response = route_request(&request, &test_config(), &RelayState::new());
    assert_eq!(response.status, 405);
    assert_eq!(response.reason, "Method Not Allowed");
    assert_eq!(
      response
        .headers
        .iter()
        .find(|(name, _)| name == "Allow")
        .map(|(_, value)| value.as_str()),
      Some("POST, DELETE, OPTIONS")
    );
    let body = String::from_utf8(response.body).expect("response body");
    assert!(body.contains("method_not_allowed"));
    assert!(body.contains("POST /mcp"));
  }

  #[test]
  fn mcp_cors_uses_configured_origin_allowlist() {
    let config = RelayConfig {
      allowed_origins: vec!["https://chatgpt.com".to_string()],
      ..test_config()
    };
    let allowed = HttpRequest {
      method: "OPTIONS".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: vec![("Origin".to_string(), "https://chatgpt.com".to_string())],
      body: String::new(),
    };
    let allowed_response = route_request(&allowed, &config, &RelayState::new());

    assert_eq!(allowed_response.status, 204);
    assert_eq!(
      response_header(&allowed_response, "Access-Control-Allow-Origin"),
      Some("https://chatgpt.com")
    );
    assert_eq!(response_header(&allowed_response, "Vary"), Some("Origin"));
    assert!(
      response_header(&allowed_response, "Access-Control-Allow-Headers")
        .unwrap_or_default()
        .contains("MCP-Protocol-Version")
    );
    assert!(
      response_header(&allowed_response, "Access-Control-Allow-Methods")
        .unwrap_or_default()
        .contains("DELETE")
    );

    let denied = HttpRequest {
      headers: vec![("Origin".to_string(), "https://evil.example".to_string())],
      ..allowed
    };
    let denied_response = route_request(&denied, &config, &RelayState::new());

    assert_eq!(denied_response.status, 403);
    assert_eq!(
      response_header(&denied_response, "Access-Control-Allow-Origin"),
      None
    );
  }

  #[test]
  fn mcp_unauthorized_response_points_to_oauth_resource_metadata() {
    let mut headers = mcp_post_headers();
    headers.push(("Origin".to_string(), "https://chatgpt.com".to_string()));
    headers.push(("MCP-Protocol-Version".to_string(), "2025-11-25".to_string()));
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers,
      body: r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"life_context.get_request_status"}}"#.to_string(),
    };
    let config = RelayConfig {
      allowed_origins: vec!["https://chatgpt.com".to_string()],
      ..test_config()
    };
    let response = route_request(&request, &config, &RelayState::new());

    assert_eq!(response.status, 401);
    assert_eq!(
      response_header(&response, "MCP-Protocol-Version"),
      Some("2025-11-25")
    );
    let challenge = response_header(&response, "WWW-Authenticate").unwrap_or_default();
    assert!(challenge.contains("Bearer"));
    assert!(challenge.contains("resource_metadata=\"http://127.0.0.1:8765/.well-known/oauth-protected-resource\""));
    assert!(challenge.contains("scope=\"request.status\""));
  }

  #[test]
  fn mcp_rejects_streamable_http_requests_without_required_accept() {
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Authorization".to_string(), "Bearer test-token".to_string()),
        ("MCP-Protocol-Version".to_string(), "2025-11-25".to_string()),
      ],
      body: r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string(),
    };

    let response = route_request(&request, &test_config(), &RelayState::new());

    assert_eq!(response.status, 406);
    assert_eq!(response.reason, "Not Acceptable");
    assert_eq!(
      response_header(&response, "MCP-Protocol-Version"),
      Some("2025-11-25")
    );
    let body = String::from_utf8(response.body).expect("response body");
    assert!(body.contains("not_acceptable"));
    assert!(body.contains("application/json"));
    assert!(body.contains("text/event-stream"));
  }

  #[test]
  fn mcp_rejects_non_json_streamable_http_content_type() {
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: vec![
        ("Content-Type".to_string(), "text/plain".to_string()),
        (
          "Accept".to_string(),
          "application/json, text/event-stream".to_string(),
        ),
        ("Authorization".to_string(), "Bearer test-token".to_string()),
      ],
      body: r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string(),
    };

    let response = route_request(&request, &test_config(), &RelayState::new());
    let body = String::from_utf8(response.body).expect("response body");

    assert_eq!(response.status, 415);
    assert_eq!(response.reason, "Unsupported Media Type");
    assert!(body.contains("unsupported_media_type"));
  }

  #[test]
  fn mcp_rejects_unsupported_protocol_version_before_forwarding() {
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: vec![
        ("Authorization".to_string(), "Bearer test-token".to_string()),
        ("MCP-Protocol-Version".to_string(), "2024-01-01".to_string()),
      ],
      body: r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string(),
    };
    let response = route_request(&request, &test_config(), &RelayState::new());
    let body = String::from_utf8(response.body).expect("response body");

    assert_eq!(response.status, 400);
    assert!(body.contains("unsupported_protocol_version"));
    assert!(body.contains("2025-11-25"));
  }

  #[test]
  fn static_bearer_token_still_authorizes_mcp() {
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: vec![("Authorization".to_string(), "Bearer test-token".to_string())],
      body: "{}".to_string(),
    };

    assert_eq!(
      mcp_authorized_client(
        &request,
        &test_config(),
        &RelayState::new(),
        "context_pack.request"
      ),
      Some("static-dev-token".to_string())
    );
    assert_eq!(
      mcp_authorized_client(
        &request,
        &RelayConfig {
          allow_static_bearer: false,
          ..test_config()
        },
        &RelayState::new(),
        "context_pack.request"
      ),
      None
    );
    assert_eq!(
      mcp_authorized_client(
        &request,
        &RelayConfig {
          token: "wrong-token".to_string(),
          ..test_config()
        },
        &RelayState::new(),
        "context_pack.request"
      ),
      None
    );
  }

  #[test]
  fn loopback_bind_detection_is_explicit() {
    assert!(is_loopback_bind("127.0.0.1:8765"));
    assert!(is_loopback_bind("localhost:8765"));
    assert!(!is_loopback_bind("0.0.0.0:8765"));
  }

  #[test]
  fn public_relay_surface_requires_https_admin_and_agent_only_path() {
    let admin_token = "admin-secret".to_string();
    assert!(validate_relay_surface(
      "127.0.0.1:8765",
      "http://127.0.0.1:8765",
      None,
      true,
      false,
      false,
      &[]
    )
    .is_ok());
    assert!(validate_relay_surface(
      "0.0.0.0:8765",
      "http://relay.example.com",
      Some(&admin_token),
      false,
      false,
      false,
      &["https://chatgpt.com".to_string()]
    )
    .expect_err("public relay must require https")
    .contains("https://"));
    assert!(validate_relay_surface(
      "0.0.0.0:8765",
      "https://relay.example.com",
      None,
      false,
      false,
      false,
      &["https://chatgpt.com".to_string()]
    )
    .expect_err("public relay must require admin token")
    .contains("ADMIN_TOKEN"));
    assert!(validate_relay_surface(
      "0.0.0.0:8765",
      "https://relay.example.com",
      Some(&admin_token),
      true,
      false,
      false,
      &["https://chatgpt.com".to_string()]
    )
    .expect_err("public relay must disable direct sidecar")
    .contains("ALLOW_DIRECT_SIDECAR=0"));
    assert!(validate_relay_surface(
      "0.0.0.0:8765",
      "https://relay.example.com",
      Some(&admin_token),
      false,
      true,
      false,
      &["https://chatgpt.com".to_string()]
    )
    .expect_err("explicit static bearer requires token")
    .contains("LCV_RELAY_TOKEN"));
    assert!(validate_relay_surface(
      "0.0.0.0:8765",
      "https://relay.example.com",
      Some(&admin_token),
      false,
      false,
      false,
      &[]
    )
    .expect_err("public relay must require allowed origins")
    .contains("ALLOWED_ORIGINS"));
    assert!(validate_relay_surface(
      "0.0.0.0:8765",
      "https://relay.example.com",
      Some(&admin_token),
      false,
      false,
      false,
      &["https://chatgpt.com".to_string()]
    )
    .is_ok());
  }

  #[test]
  fn non_loopback_bind_requires_explicit_tenant_id() {
    assert_eq!(
      resolve_relay_tenant_id("127.0.0.1:8765", None).expect("local tenant"),
      DEFAULT_LOCAL_TENANT_ID
    );
    assert!(resolve_relay_tenant_id("0.0.0.0:8765", None).is_err());
    assert_eq!(
      resolve_relay_tenant_id("0.0.0.0:8765", Some("prod.us_1")).expect("tenant"),
      "prod.us_1"
    );
    assert!(resolve_relay_tenant_id("127.0.0.1:8765", Some("bad tenant")).is_err());
  }

  #[test]
  fn pkce_s256_verification_matches_challenge() {
    let verifier = "correct-horse-battery-staple";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    assert!(verify_pkce(&challenge, "S256", verifier));
    assert!(!verify_pkce(&challenge, "S256", "wrong"));
  }

  #[test]
  fn oauth_metadata_exposes_required_endpoints() {
    let response = authorization_server_metadata(&test_config());
    let body = String::from_utf8(response.body).expect("json body");
    assert!(body.contains("authorization_endpoint"));
    assert!(body.contains("token_endpoint"));
    assert!(body.contains("registration_endpoint"));
    assert!(body.contains("S256"));
  }

  #[test]
  fn oauth_approve_requires_pending_authorization_session() {
    let state = RelayState::new();
    let request = HttpRequest {
      method: "GET".to_string(),
      path: "/oauth/approve".to_string(),
      query: form_encode(&[
        ("client_id", "client_attacker"),
        ("redirect_uri", "https://example.com/callback"),
        ("code_challenge", "challenge"),
        ("scope", "request.status"),
      ]),
      headers: Vec::new(),
      body: String::new(),
    };
    let response = oauth_approve(&request, &state);
    assert_eq!(response.status, 400);
    let body = String::from_utf8(response.body).expect("approve body");
    assert!(body.contains("authorization session"));
  }

  #[test]
  fn oauth_authorize_rejects_empty_scope_and_approve_consumes_session() {
    let state = RelayState::new();
    let client = state
      .register_client(
        "Test Client".to_string(),
        vec!["https://client.example/callback".to_string()],
      )
      .expect("client registration");
    let verifier = "correct-horse-battery-staple";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let empty_scope = HttpRequest {
      method: "GET".to_string(),
      path: "/oauth/authorize".to_string(),
      query: form_encode(&[
        ("response_type", "code"),
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", "https://client.example/callback"),
        ("code_challenge", &challenge),
      ]),
      headers: Vec::new(),
      body: String::new(),
    };
    assert_eq!(
      oauth_authorize(&empty_scope, &test_config(), &state).status,
      400
    );

    let authorize = HttpRequest {
      query: form_encode(&[
        ("response_type", "code"),
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", "https://client.example/callback"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("scope", "request.status"),
        ("state", "client-state"),
      ]),
      ..empty_scope
    };
    let response = oauth_authorize(&authorize, &test_config(), &state);
    assert_eq!(response.status, 200);
    let session_id = {
      let inner = state.inner.lock().expect("relay state");
      inner
        .pending_authorizations
        .keys()
        .next()
        .cloned()
        .expect("pending authorization")
    };
    let approve = HttpRequest {
      method: "GET".to_string(),
      path: "/oauth/approve".to_string(),
      query: form_encode(&[("session", session_id.as_str())]),
      headers: Vec::new(),
      body: String::new(),
    };
    let approved = oauth_approve(&approve, &state);
    assert_eq!(approved.status, 302);
    let location = approved
      .headers
      .iter()
      .find(|(name, _)| name == "Location")
      .map(|(_, value)| value.clone())
      .expect("redirect location");
    assert!(location.contains("code="));
    assert!(location.contains("state=client-state"));
  }

  #[test]
  fn public_oauth_requires_and_binds_mcp_resource() {
    let config = public_test_config();
    let state = RelayState::new();
    let client = state
      .register_client(
        "Public Client".to_string(),
        vec!["https://client.example/callback".to_string()],
      )
      .expect("client registration");
    let verifier = "correct-horse-battery-staple";
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let resource = config.mcp_resource_uri();

    let missing_resource = HttpRequest {
      method: "GET".to_string(),
      path: "/oauth/authorize".to_string(),
      query: form_encode(&[
        ("response_type", "code"),
        ("client_id", client.client_id.as_str()),
        ("redirect_uri", "https://client.example/callback"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("scope", "request.status"),
      ]),
      headers: Vec::new(),
      body: String::new(),
    };
    assert_eq!(
      oauth_authorize(&missing_resource, &config, &state).status,
      400
    );

    let issue_code = || -> String {
      let authorize = HttpRequest {
        query: form_encode(&[
          ("response_type", "code"),
          ("client_id", client.client_id.as_str()),
          ("redirect_uri", "https://client.example/callback"),
          ("code_challenge", &challenge),
          ("code_challenge_method", "S256"),
          ("scope", "request.status"),
          ("resource", resource.as_str()),
        ]),
        ..missing_resource.clone()
      };
      assert_eq!(oauth_authorize(&authorize, &config, &state).status, 200);
      let session_id = {
        let inner = state.inner.lock().expect("relay state");
        inner
          .pending_authorizations
          .keys()
          .next()
          .cloned()
          .expect("pending authorization")
      };
      let approve = HttpRequest {
        method: "GET".to_string(),
        path: "/oauth/approve".to_string(),
        query: form_encode(&[("session", session_id.as_str())]),
        headers: Vec::new(),
        body: String::new(),
      };
      let approved = oauth_approve(&approve, &state);
      assert_eq!(approved.status, 302);
      let location = response_header(&approved, "Location").expect("redirect location");
      let (_, query) = location.split_once('?').expect("redirect query");
      parse_query(query)
        .get("code")
        .cloned()
        .expect("authorization code")
    };

    let code_without_token_resource = issue_code();
    let missing_token_resource = HttpRequest {
      method: "POST".to_string(),
      path: "/oauth/token".to_string(),
      query: String::new(),
      headers: Vec::new(),
      body: form_encode(&[
        ("grant_type", "authorization_code"),
        ("code", code_without_token_resource.as_str()),
        ("redirect_uri", "https://client.example/callback"),
        ("code_verifier", verifier),
      ]),
    };
    assert_eq!(
      oauth_token(&missing_token_resource, &config, &state).status,
      400
    );

    let code = issue_code();
    let token_request = HttpRequest {
      body: form_encode(&[
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", "https://client.example/callback"),
        ("code_verifier", verifier),
        ("resource", resource.as_str()),
      ]),
      ..missing_token_resource
    };
    let token_response = oauth_token(&token_request, &config, &state);
    assert_eq!(token_response.status, 200);
    let token_body: Value = serde_json::from_slice(&token_response.body).expect("token body");
    let token = token_body
      .get("access_token")
      .and_then(Value::as_str)
      .expect("access token");
    let mcp_request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: vec![("Authorization".to_string(), format!("Bearer {token}"))],
      body: "{}".to_string(),
    };

    assert_eq!(
      mcp_authorized_client(&mcp_request, &config, &state, "request.status"),
      Some(client.client_id.clone())
    );
    assert_eq!(
      mcp_authorized_client(
        &mcp_request,
        &RelayConfig {
          base_url: "https://other.example".to_string(),
          ..config
        },
        &state,
        "request.status",
      ),
      None
    );
  }

  #[test]
  fn pairing_start_returns_agent_websocket_url() {
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/pairing/start".to_string(),
      query: String::new(),
      headers: Vec::new(),
      body: String::new(),
    };
    let response = start_pairing(&request, &test_config(), &RelayState::new());
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    assert_eq!(body.get("status").and_then(Value::as_str), Some("pending"));
    assert!(body
      .get("agentWebSocketUrl")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .starts_with("ws://127.0.0.1:8765/agent/ws?pairing_code="));
  }

  #[test]
  fn relay_state_persists_clients_and_metadata_only_events() {
    let dir = env::temp_dir().join(format!(
      "lcv-relay-state-test-{}",
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("test dir");
    let path = dir.join("relay-state.json");

    let state = RelayState::load(Some(path.clone())).expect("relay state");
    let client = state
      .register_client(
        "Smoke Client".to_string(),
        vec!["http://127.0.0.1/callback".to_string()],
      )
      .expect("register client");
    state
      .record_request_event(RelayRequestEvent {
        tenant_id: String::new(),
        id: "evt_1".to_string(),
        client_id: Some(client.client_id.clone()),
        required_scope: "memory.propose".to_string(),
        method: "tools/call".to_string(),
        tool_name: Some("life_context.propose_memory".to_string()),
        status: "fulfilled".to_string(),
        transport: "agent_websocket".to_string(),
        occurred_at: system_time_seconds(SystemTime::now()),
      })
      .expect("record relay event");

    let reloaded = RelayState::load(Some(path.clone())).expect("reloaded relay state");
    assert!(reloaded.client(&client.client_id).is_some());
    let status = reloaded.store_status();
    assert_eq!(
      status.get("registeredClientCount").and_then(Value::as_u64),
      Some(1)
    );
    assert_eq!(
      status.get("requestEventCount").and_then(Value::as_u64),
      Some(1)
    );

    let raw = fs::read_to_string(&path).expect("state json");
    assert!(raw.contains("\"tenant_id\": \"local\""));
    assert!(raw.contains("Smoke Client"));
    assert!(raw.contains("life_context.propose_memory"));
    assert!(!raw.contains("Tone preference"));
    let _ = fs::remove_dir_all(dir);
  }

  fn test_handoff_response(request_id: &str) -> Value {
    json!({
      "jsonrpc": "2.0",
      "id": 1,
      "result": {
        "content": [{
          "type": "text",
          "text": "The Context Pack has been confirmed and can be used for this answer."
        }],
        "structuredContent": {
          "mutated": false,
          "status": "fulfilled",
          "requestId": request_id,
          "contextPack": {
            "trustBoundary": "ContextPack only",
            "id": "pack_handoff",
            "requestId": request_id,
            "items": [{
              "factId": "fact_1",
              "itemText": "Approved handoff context"
            }],
            "sourceSnippets": [],
            "warnings": [],
            "excludedItems": [],
            "maxSensitivityIncluded": "personal",
            "confirmationStatus": "confirmed"
          },
          "message": "The Context Pack has been confirmed and can be used for this answer."
        },
        "isError": false
      }
    })
  }

  #[test]
  fn relay_handoff_accepts_only_context_pack_only_responses() {
    let state = RelayState::new();
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/relay/handoff".to_string(),
      query: String::new(),
      headers: Vec::new(),
      body: json!({
        "clientId": "client_chatgpt",
        "mcpResponse": test_handoff_response("req_handoff")
      })
      .to_string(),
    };
    let response = relay_handoff(&request, &test_config(), &state);
    assert_eq!(response.status, 200);
    let body: Value = serde_json::from_slice(&response.body).expect("handoff response");
    assert_eq!(body.get("status").and_then(Value::as_str), Some("stored"));
    assert_eq!(body.get("requestId").and_then(Value::as_str), Some("req_handoff"));

    let status = state.store_status();
    assert_eq!(status.get("handoffCount").and_then(Value::as_u64), Some(1));
    assert_eq!(
      status
        .get("retention")
        .and_then(|retention| retention.get("handoffTtlSeconds"))
        .and_then(Value::as_u64),
      Some(DEFAULT_RELAY_HANDOFF_TTL_SECONDS)
    );
    let status_text = status.to_string();
    assert!(status_text.contains("req_handoff"));
    assert!(!status_text.contains("Approved handoff context"));

    let invalid_request = HttpRequest {
      body: json!({
        "structuredContent": {
          "status": "fulfilled",
          "requestId": "req_bad",
          "contextPack": {
            "trustBoundary": "Raw Vault"
          }
        }
      })
      .to_string(),
      ..request
    };
    let invalid_response = relay_handoff(&invalid_request, &test_config(), &state);
    assert_eq!(invalid_response.status, 400);
  }

  #[test]
  fn relay_handoff_returns_cached_status_when_agent_offline() {
    let state = RelayState::new();
    state.store_handoff(
      "req_cached".to_string(),
      Some("static-dev-token".to_string()),
      test_handoff_response("req_cached"),
    );
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: authorized_mcp_post_headers("test-token"),
      body: r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"life_context.get_request_status","arguments":{"requestId":"req_cached"}}}"#.to_string(),
    };
    let response = handle_mcp_request(
      &request,
      &RelayConfig {
        allow_direct_sidecar: false,
        ..test_config()
      },
      &state,
    );
    assert_eq!(response.status, 200);
    let body_text = String::from_utf8(response.body).expect("cached body");
    assert!(body_text.contains("Approved handoff context"));

    let status = state.store_status();
    assert_eq!(
      status
        .get("recentRequestEvents")
        .and_then(Value::as_array)
        .and_then(|events| events.first())
        .and_then(|event| event.get("status"))
        .and_then(Value::as_str),
      Some("fulfilled_handoff_cache")
    );
  }

  #[test]
  fn relay_handoff_cache_is_bound_to_client_id() {
    let state = RelayState::new();
    state.store_handoff(
      "req_other_client".to_string(),
      Some("client_chatgpt".to_string()),
      test_handoff_response("req_other_client"),
    );
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: authorized_mcp_post_headers("test-token"),
      body: r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"life_context.get_request_status","arguments":{"requestId":"req_other_client"}}}"#.to_string(),
    };
    let response = handle_mcp_request(
      &request,
      &RelayConfig {
        allow_direct_sidecar: false,
        ..test_config()
      },
      &state,
    );
    assert_eq!(response.status, 202);
    let body = String::from_utf8(response.body).expect("pending body");
    assert!(body.contains("pending_agent_offline"));
  }

  #[test]
  fn initialize_response_starts_memory_only_mcp_session() {
    let state = RelayState::new();
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: authorized_mcp_post_headers("test-token"),
      body: r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#.to_string(),
    };
    let response = fulfilled_mcp_response(
      &request,
      &test_config(),
      &state,
      "2025-11-25",
      "static-dev-token",
      json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
          "protocolVersion": "2025-11-25",
          "capabilities": {},
          "serverInfo": { "name": "life-context-vault", "version": "0.1.0" }
        }
      }),
    );
    let session_id = response_header(&response, "MCP-Session-Id")
      .expect("session id")
      .to_string();

    assert!(session_id.starts_with("mcp_session_"));
    let status = state.store_status();
    assert_eq!(status.get("mcpSessionCount").and_then(Value::as_u64), Some(1));
    assert_eq!(
      status
        .get("recentMcpSessions")
        .and_then(Value::as_array)
        .and_then(|sessions| sessions.first())
        .and_then(|session| session.get("id"))
        .and_then(Value::as_str),
      Some(session_id.as_str())
    );
    let status_text = status.to_string();
    assert!(status_text.contains("static-dev-token"));
    assert!(!status_text.contains("serverInfo"));
    assert!(state.touch_mcp_session(&session_id, "static-dev-token").is_ok());
  }

  #[test]
  fn active_mcp_session_requires_session_id_on_later_requests() {
    let state = RelayState::new();
    state.start_mcp_session("static-dev-token".to_string());
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: authorized_mcp_post_headers("test-token"),
      body: r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string(),
    };

    let response = handle_mcp_request(
      &request,
      &RelayConfig {
        allow_direct_sidecar: false,
        ..test_config()
      },
      &state,
    );
    let body = String::from_utf8(response.body).expect("missing session body");

    assert_eq!(response.status, 400);
    assert!(body.contains("missing_mcp_session"));
  }

  #[test]
  fn unknown_mcp_session_id_returns_not_found_before_forwarding() {
    let state = RelayState::new();
    let mut headers = authorized_mcp_post_headers("test-token");
    headers.push(("MCP-Session-Id".to_string(), "mcp_session_missing".to_string()));
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers,
      body: r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#.to_string(),
    };

    let response = handle_mcp_request(
      &request,
      &RelayConfig {
        allow_direct_sidecar: false,
        ..test_config()
      },
      &state,
    );
    let body = String::from_utf8(response.body).expect("session body");

    assert_eq!(response.status, 404);
    assert!(body.contains("mcp_session_not_found"));
  }

  #[test]
  fn delete_mcp_terminates_session_for_same_client_only() {
    let state = RelayState::new();
    let session = state.start_mcp_session("static-dev-token".to_string());
    let request = HttpRequest {
      method: "DELETE".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: authorized_mcp_delete_headers("test-token", &session.id),
      body: String::new(),
    };

    let response = route_request(&request, &test_config(), &state);

    assert_eq!(response.status, 204);
    assert_eq!(
      response_header(&response, "MCP-Protocol-Version"),
      Some("2025-11-25")
    );
    assert!(state.touch_mcp_session(&session.id, "static-dev-token").is_err());
  }

  #[test]
  fn delete_mcp_rejects_session_owned_by_another_client() {
    let state = RelayState::new();
    let session = state.start_mcp_session("client_other".to_string());
    let request = HttpRequest {
      method: "DELETE".to_string(),
      path: "/mcp".to_string(),
      query: String::new(),
      headers: authorized_mcp_delete_headers("test-token", &session.id),
      body: String::new(),
    };

    let response = route_request(&request, &test_config(), &state);
    let body = String::from_utf8(response.body).expect("delete body");

    assert_eq!(response.status, 404);
    assert!(body.contains("mcp_session_not_found"));
    assert!(state.touch_mcp_session(&session.id, "client_other").is_ok());
  }

  #[test]
  fn relay_state_persist_rotates_metadata_backups() {
    let dir = env::temp_dir().join(format!(
      "lcv-relay-state-backup-test-{}",
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("test dir");
    let path = dir.join("relay-state.json");
    let state = RelayState::load_with_retention(
      Some(path.clone()),
      RelayRetentionPolicy {
        request_event_retention_seconds: DEFAULT_RELAY_REQUEST_EVENT_RETENTION_SECONDS,
        client_registration_retention_seconds: None,
        state_backup_count: 2,
        handoff_ttl_seconds: DEFAULT_RELAY_HANDOFF_TTL_SECONDS,
      },
      DEFAULT_LOCAL_TENANT_ID.to_string(),
    )
    .expect("relay state");

    state
      .register_client(
        "First Client".to_string(),
        vec!["http://127.0.0.1/first".to_string()],
      )
      .expect("first client");
    assert!(!relay_state_backup_path(&path, 1).exists());

    state
      .register_client(
        "Second Client".to_string(),
        vec!["http://127.0.0.1/second".to_string()],
      )
      .expect("second client");
    let backup = fs::read_to_string(relay_state_backup_path(&path, 1)).expect("backup");
    assert!(backup.contains("First Client"));
    assert!(!backup.contains("Second Client"));
    assert!(backup.contains("\"tenant_id\": \"local\""));
    assert!(!backup.contains("ContextPack"));

    state
      .register_client(
        "Third Client".to_string(),
        vec!["http://127.0.0.1/third".to_string()],
      )
      .expect("third client");
    assert!(relay_state_backup_path(&path, 2).exists());
    let status = state.store_status();
    assert_eq!(
      status
        .get("retention")
        .and_then(|retention| retention.get("stateBackupCount"))
        .and_then(Value::as_u64),
      Some(2)
    );
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn relay_state_refuses_mismatched_tenant_store() {
    let dir = env::temp_dir().join(format!(
      "lcv-relay-state-tenant-mismatch-test-{}",
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("test dir");
    let path = dir.join("relay-state.json");
    fs::write(
      &path,
      r#"{"version":1,"tenant_id":"tenant-a","registered_clients":[],"request_events":[]}"#,
    )
    .expect("state json");

    let error = match RelayState::load_with_retention(
      Some(path),
      RelayRetentionPolicy::default(),
      "tenant-b".to_string(),
    ) {
      Ok(_) => panic!("tenant mismatch should fail"),
      Err(error) => error,
    };
    assert!(error.contains("tenant mismatch"));
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn relay_state_migrates_legacy_tenantless_metadata_to_configured_tenant() {
    let dir = env::temp_dir().join(format!(
      "lcv-relay-state-tenant-migration-test-{}",
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("test dir");
    let path = dir.join("relay-state.json");
    fs::write(
      &path,
      r#"{
        "version": 1,
        "registered_clients": [{
          "client_id": "client_legacy",
          "client_name": "Legacy Client",
          "redirect_uris": ["http://127.0.0.1/callback"],
          "created_at": 10
        }],
        "request_events": [{
          "id": "evt_legacy",
          "client_id": "client_legacy",
          "required_scope": "policy.read",
          "method": "tools/list",
          "tool_name": null,
          "status": "fulfilled",
          "transport": "agent_websocket",
          "occurred_at": 10
        }]
      }"#,
    )
    .expect("state json");

    let state = RelayState::load_with_retention(
      Some(path),
      RelayRetentionPolicy {
        request_event_retention_seconds: u64::MAX,
        client_registration_retention_seconds: None,
        state_backup_count: DEFAULT_RELAY_STATE_BACKUP_COUNT,
        handoff_ttl_seconds: DEFAULT_RELAY_HANDOFF_TTL_SECONDS,
      },
      "tenant-migrated".to_string(),
    )
    .expect("legacy state migrates");
    assert!(state.client("client_legacy").is_some());
    let status = state.store_status();
    assert_eq!(
      status.get("tenantId").and_then(Value::as_str),
      Some("tenant-migrated")
    );
    assert_eq!(
      status
        .get("recentRequestEvents")
        .and_then(Value::as_array)
        .and_then(|events| events.first())
        .and_then(|event| event.get("tenantId"))
        .and_then(Value::as_str),
      Some("tenant-migrated")
    );
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn relay_state_prunes_request_events_by_retention_policy() {
    let now = system_time_seconds(SystemTime::now());
    let state = RelayState::from_persisted_with_retention(
      None,
      PersistedRelayState {
        version: 1,
        tenant_id: DEFAULT_LOCAL_TENANT_ID.to_string(),
        registered_clients: Vec::new(),
        request_events: vec![
          RelayRequestEvent {
            tenant_id: DEFAULT_LOCAL_TENANT_ID.to_string(),
            id: "evt_old".to_string(),
            client_id: Some("client_old".to_string()),
            required_scope: "context_pack.request".to_string(),
            method: "tools/call".to_string(),
            tool_name: Some("life_context.request_context_pack".to_string()),
            status: "fulfilled".to_string(),
            transport: "agent_websocket".to_string(),
            occurred_at: now.saturating_sub(120),
          },
          RelayRequestEvent {
            tenant_id: DEFAULT_LOCAL_TENANT_ID.to_string(),
            id: "evt_recent".to_string(),
            client_id: Some("client_recent".to_string()),
            required_scope: "policy.read".to_string(),
            method: "tools/list".to_string(),
            tool_name: None,
            status: "fulfilled".to_string(),
            transport: "agent_websocket".to_string(),
            occurred_at: now.saturating_sub(5),
          },
        ],
      },
      RelayRetentionPolicy {
        request_event_retention_seconds: 60,
        client_registration_retention_seconds: None,
        state_backup_count: DEFAULT_RELAY_STATE_BACKUP_COUNT,
        handoff_ttl_seconds: DEFAULT_RELAY_HANDOFF_TTL_SECONDS,
      },
      DEFAULT_LOCAL_TENANT_ID.to_string(),
    );

    let status = state.store_status();
    assert_eq!(
      status.get("requestEventCount").and_then(Value::as_u64),
      Some(1)
    );
    assert_eq!(
      status
        .get("recentRequestEvents")
        .and_then(Value::as_array)
        .and_then(|events| events.first())
        .and_then(|event| event.get("id"))
        .and_then(Value::as_str),
      Some("evt_recent")
    );
  }

  #[test]
  fn relay_state_prunes_clients_only_when_client_ttl_is_set() {
    let now = system_time_seconds(SystemTime::now());
    let old_client = RegisteredClient {
      tenant_id: DEFAULT_LOCAL_TENANT_ID.to_string(),
      client_id: "client_old".to_string(),
      client_name: "Old Client".to_string(),
      redirect_uris: vec!["http://127.0.0.1/old".to_string()],
      created_at: now.saturating_sub(120),
    };
    let recent_client = RegisteredClient {
      tenant_id: DEFAULT_LOCAL_TENANT_ID.to_string(),
      client_id: "client_recent".to_string(),
      client_name: "Recent Client".to_string(),
      redirect_uris: vec!["http://127.0.0.1/recent".to_string()],
      created_at: now.saturating_sub(5),
    };
    let persisted = PersistedRelayState {
      version: 1,
      tenant_id: DEFAULT_LOCAL_TENANT_ID.to_string(),
      registered_clients: vec![old_client, recent_client],
      request_events: Vec::new(),
    };

    let durable_state = RelayState::from_persisted_with_retention(
      None,
      persisted.clone(),
      RelayRetentionPolicy {
        request_event_retention_seconds: 60,
        client_registration_retention_seconds: None,
        state_backup_count: DEFAULT_RELAY_STATE_BACKUP_COUNT,
        handoff_ttl_seconds: DEFAULT_RELAY_HANDOFF_TTL_SECONDS,
      },
      DEFAULT_LOCAL_TENANT_ID.to_string(),
    );
    assert!(durable_state.client("client_old").is_some());

    let pruned_state = RelayState::from_persisted_with_retention(
      None,
      persisted,
      RelayRetentionPolicy {
        request_event_retention_seconds: 60,
        client_registration_retention_seconds: Some(60),
        state_backup_count: DEFAULT_RELAY_STATE_BACKUP_COUNT,
        handoff_ttl_seconds: DEFAULT_RELAY_HANDOFF_TTL_SECONDS,
      },
      DEFAULT_LOCAL_TENANT_ID.to_string(),
    );
    assert!(pruned_state.client("client_old").is_none());
    assert!(pruned_state.client("client_recent").is_some());
  }

  #[test]
  fn failed_relay_state_persist_rolls_back_client_registration() {
    let dir = env::temp_dir().join(format!(
      "lcv-relay-state-failure-test-{}",
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("test dir");
    let blocked_parent = dir.join("blocked-parent");
    fs::write(&blocked_parent, "not a directory").expect("blocked parent");
    let path = blocked_parent.join("relay-state.json");

    let state = RelayState::load(Some(path)).expect("relay state");
    let result = state.register_client(
      "Broken Persist Client".to_string(),
      vec!["http://127.0.0.1/callback".to_string()],
    );

    assert!(result.is_err());
    assert_eq!(
      state
        .store_status()
        .get("registeredClientCount")
        .and_then(Value::as_u64),
      Some(0)
    );
    let _ = fs::remove_dir_all(dir);
  }

  #[test]
  fn mcp_tool_calls_map_to_minimum_oauth_scope() {
    assert_eq!(
      required_scope_for_mcp_body(
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"life_context.propose_memory"}}"#
      ),
      "memory.propose"
    );
    assert_eq!(
      required_scope_for_mcp_body(
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"life_context.get_request_status"}}"#
      ),
      "request.status"
    );
    assert_eq!(
      required_scope_for_mcp_body(
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"life_context.request_context_pack"}}"#
      ),
      "context_pack.request"
    );
  }
}
