use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
  collections::HashMap,
  env,
  fs::{self, File},
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
  let state = RelayState::load(config.relay_state_path.clone())?;
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
  mcp_command: PathBuf,
  vault_db_path: Option<String>,
  relay_state_path: Option<PathBuf>,
  allow_direct_sidecar: bool,
}

impl RelayConfig {
  fn from_env() -> Result<Self, String> {
    let bind = env::var("LCV_RELAY_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let token = env::var("LCV_RELAY_TOKEN").unwrap_or_else(|_| DEFAULT_TOKEN.to_string());
    if !is_loopback_bind(&bind) && env::var("LCV_RELAY_TOKEN").is_err() {
      return Err("LCV_RELAY_TOKEN is required when binding outside loopback".to_string());
    }
    let base_url = env::var("LCV_RELAY_BASE_URL").unwrap_or_else(|_| format!("http://{bind}"));
    Ok(Self {
      bind,
      base_url,
      token,
      admin_token: env::var("LCV_RELAY_ADMIN_TOKEN").ok(),
      mcp_command: env::var("LCV_MCP_COMMAND")
        .map(PathBuf::from)
        .unwrap_or_else(|_| mcp_stdio::resolve_sibling_binary("lcv-mcp")),
      vault_db_path: env::var("LCV_VAULT_DB_PATH").ok(),
      relay_state_path: env::var("LCV_RELAY_STATE_PATH")
        .map(PathBuf::from)
        .ok()
        .or_else(default_relay_state_path),
      allow_direct_sidecar: env::var("LCV_RELAY_ALLOW_DIRECT_SIDECAR")
        .map(|value| value != "0")
        .unwrap_or(true),
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
}

struct RelayStateInner {
  registered_clients: HashMap<String, RegisteredClient>,
  request_events: Vec<RelayRequestEvent>,
  auth_codes: HashMap<String, AuthCode>,
  access_tokens: HashMap<String, AccessToken>,
  pairing_sessions: HashMap<String, PairingSession>,
  pending_agent_responses: HashMap<String, Sender<Result<Option<Value>, String>>>,
  agent_sender: Option<Sender<String>>,
  agent_pairing_id: Option<String>,
  agent_connected_at: Option<SystemTime>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RegisteredClient {
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
  expires_at: SystemTime,
}

#[derive(Clone, Debug)]
struct AccessToken {
  client_id: String,
  scopes: Vec<String>,
  expires_at: SystemTime,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RelayRequestEvent {
  id: String,
  client_id: Option<String>,
  required_scope: String,
  method: String,
  tool_name: Option<String>,
  status: String,
  transport: String,
  occurred_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedRelayState {
  version: u32,
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

impl RelayState {
  #[cfg(test)]
  fn new() -> Self {
    Self::from_persisted(None, PersistedRelayState::empty())
  }

  fn load(store_path: Option<PathBuf>) -> Result<Self, String> {
    let persisted = match &store_path {
      Some(path) if path.exists() => {
        let raw = fs::read_to_string(path)
          .map_err(|error| format!("failed to read relay state store: {error}"))?;
        serde_json::from_str::<PersistedRelayState>(&raw)
          .map_err(|error| format!("failed to parse relay state store: {error}"))?
      }
      _ => PersistedRelayState::empty(),
    };
    Ok(Self::from_persisted(store_path, persisted))
  }

  fn from_persisted(store_path: Option<PathBuf>, mut persisted: PersistedRelayState) -> Self {
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
        auth_codes: HashMap::new(),
        access_tokens: HashMap::new(),
        pairing_sessions: HashMap::new(),
        pending_agent_responses: HashMap::new(),
        agent_sender: None,
        agent_pairing_id: None,
        agent_connected_at: None,
      })),
      store_path,
    }
  }

  fn register_client(
    &self,
    client_name: String,
    redirect_uris: Vec<String>,
  ) -> Result<RegisteredClient, String> {
    let client = RegisteredClient {
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
    {
      let mut inner = self.inner.lock().expect("relay state");
      inner.request_events.insert(0, event);
      if inner.request_events.len() > MAX_RELAY_REQUEST_EVENTS {
        inner.request_events.truncate(MAX_RELAY_REQUEST_EVENTS);
      }
    }
    self.persist()
  }

  fn store_status(&self) -> Value {
    let inner = self.inner.lock().expect("relay state");
    let recent_events: Vec<Value> = inner
      .request_events
      .iter()
      .take(20)
      .map(|event| {
        json!({
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
    json!({
      "storePath": self.store_path.as_ref().map(|path| path.display().to_string()),
      "registeredClientCount": inner.registered_clients.len(),
      "requestEventCount": inner.request_events.len(),
      "recentRequestEvents": recent_events
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

  fn forward_to_agent(&self, body: &str) -> Result<Option<Value>, String> {
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
      let inner = self.inner.lock().expect("relay state");
      PersistedRelayState {
        version: 1,
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
  fn empty() -> Self {
    Self {
      version: 1,
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
    ("POST", "/oauth/token") => oauth_token(request, state),
    ("POST", "/pairing/start") => start_pairing(request, config, state),
    ("GET", "/pairing/status") => pairing_status(request, state),
    ("GET", "/agent/status") => json_response(200, state.agent_status()),
    ("GET", "/relay/state") => relay_state_status(request, config, state),
    ("OPTIONS", "/mcp") => HttpResponse::empty(204).with_cors(),
    ("POST", "/mcp") => handle_mcp_request(request, config, state),
    _ => json_response(404, json!({
      "error": "not_found",
      "message": "Use POST /mcp for MCP JSON-RPC over HTTP."
    })),
  }
}

fn protected_resource_metadata(config: &RelayConfig) -> HttpResponse {
  json_response(200, json!({
    "resource": format!("{}/mcp", config.base_url),
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

  if env::var("LCV_RELAY_AUTO_APPROVE").ok().as_deref() == Some("1") {
    return issue_auth_code_redirect(&query, state);
  }

  let approve_url = format!(
    "/oauth/approve?{}",
    form_encode(&[
      ("client_id", client_id.as_str()),
      ("redirect_uri", redirect_uri.as_str()),
      (
        "code_challenge",
        query.get("code_challenge").map(String::as_str).unwrap_or_default(),
      ),
      (
        "code_challenge_method",
        query
          .get("code_challenge_method")
          .map(String::as_str)
          .unwrap_or("S256"),
      ),
      ("scope", query.get("scope").map(String::as_str).unwrap_or_default()),
      ("state", query.get("state").map(String::as_str).unwrap_or_default()),
    ])
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
       <p><a href=\"{}\" style=\"display:inline-block;background:#26352b;color:white;padding:10px 14px;border-radius:8px;text-decoration:none\">Authorize</a></p>\
       </main>",
      html_escape(&client.client_name),
      html_escape(query.get("scope").map(String::as_str).unwrap_or("default")),
      approve_url
    ),
  )
  .with_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
  .with_header("X-Relay-Issuer", &config.base_url)
}

fn oauth_approve(request: &HttpRequest, state: &RelayState) -> HttpResponse {
  let query = parse_query(&request.query);
  issue_auth_code_redirect(&query, state)
}

fn issue_auth_code_redirect(query: &HashMap<String, String>, state: &RelayState) -> HttpResponse {
  let client_id = query.get("client_id").cloned().unwrap_or_default();
  let redirect_uri = query.get("redirect_uri").cloned().unwrap_or_default();
  let code_challenge = query.get("code_challenge").cloned().unwrap_or_default();
  if client_id.is_empty() || redirect_uri.is_empty() || code_challenge.is_empty() {
    return json_response(400, json!({
      "error": "invalid_request",
      "message": "client_id, redirect_uri, and code_challenge are required."
    }));
  }
  let code = random_token("code");
  let scope_text = query.get("scope").map(String::as_str).unwrap_or_default();
  state.insert_auth_code(
    code.clone(),
    AuthCode {
      client_id,
      redirect_uri: redirect_uri.clone(),
      code_challenge,
      code_challenge_method: query
        .get("code_challenge_method")
        .cloned()
        .unwrap_or_else(|| "S256".to_string()),
      scopes: normalize_scopes(scope_text),
      expires_at: seconds_from_now(AUTH_CODE_TTL_SECONDS),
    },
  );

  let mut redirect = format!("{}?code={}", redirect_uri, url_encode(&code));
  if let Some(state_value) = query.get("state").filter(|value| !value.is_empty()) {
    redirect.push_str("&state=");
    redirect.push_str(&url_encode(state_value));
  }
  HttpResponse::redirect(&redirect)
}

fn oauth_token(request: &HttpRequest, state: &RelayState) -> HttpResponse {
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

  let token = random_token("lcv_at");
  let expires_at = seconds_from_now(OAUTH_TOKEN_TTL_SECONDS);
  state.insert_access_token(
    token.clone(),
    AccessToken {
      client_id: auth_code.client_id.clone(),
      scopes: auth_code.scopes.clone(),
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
    return json_response(401, json!({
      "error": "unauthorized",
      "message": "Missing or invalid Authorization bearer token."
    }))
    .with_header("WWW-Authenticate", "Bearer");
  };

  match state.forward_to_agent(&request.body) {
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
      return HttpResponse::json(200, body).with_cors();
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
      return HttpResponse::empty(202).with_cors();
    }
    Err(agent_error) => {
      if !config.allow_direct_sidecar {
        record_relay_event(
          state,
          Some(client_id),
          required_scope,
          &method,
          tool_name.as_deref(),
          "pending_agent_offline",
          "none",
        );
        return json_response(202, json!({
          "status": "pending_agent_offline",
          "message": "Local Vault Agent is offline; request is waiting for the user's desktop.",
          "detail": agent_error
        }));
      }
    }
  }

  match mcp_stdio::forward_to_stdio_mcp(
    &request.body,
    &config.mcp_command,
    config.vault_db_path.as_deref(),
  ) {
    Ok(Some(body)) => {
      record_relay_event(
        state,
        Some(client_id),
        required_scope,
        &method,
        tool_name.as_deref(),
        "fulfilled",
        "direct_sidecar_fallback",
      );
      HttpResponse::json(200, body).with_cors()
    }
    Ok(None) => {
      record_relay_event(
        state,
        Some(client_id),
        required_scope,
        &method,
        tool_name.as_deref(),
        "accepted_no_body",
        "direct_sidecar_fallback",
      );
      HttpResponse::empty(202).with_cors()
    }
    Err(error) => {
      record_relay_event(
        state,
        Some(client_id),
        required_scope,
        &method,
        tool_name.as_deref(),
        "forward_failed",
        "direct_sidecar_fallback",
      );
      json_response(500, json!({
        "error": "relay_forward_failed",
        "message": error
      }))
    }
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

#[derive(Debug)]
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

  fn with_cors(self) -> Self {
    self
      .with_header("Access-Control-Allow-Origin", "*")
      .with_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
      .with_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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

fn mcp_authorized_client(
  request: &HttpRequest,
  config: &RelayConfig,
  state: &RelayState,
  required_scope: &str,
) -> Option<String> {
  let Some(token) = bearer_token(request) else {
    return None;
  };
  if token == config.token {
    return Some("static-dev-token".to_string());
  }
  let Some(access_token) = state.access_token(token) else {
    return None;
  };
  if SystemTime::now() > access_token.expires_at {
    return None;
  }
  if access_token.scopes.iter().any(|scope| scope == required_scope) {
    Some(access_token.client_id)
  } else {
    None
  }
}

fn admin_authorized(request: &HttpRequest, config: &RelayConfig) -> bool {
  if is_loopback_bind(&config.bind) && config.admin_token.is_none() {
    return true;
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

fn normalize_scopes(scope_text: &str) -> Vec<String> {
  let requested: Vec<String> = scope_text
    .split_whitespace()
    .filter(|scope| SUPPORTED_SCOPES.contains(scope))
    .map(str::to_string)
    .collect();
  if requested.is_empty() {
    SUPPORTED_SCOPES.iter().map(|scope| scope.to_string()).collect()
  } else {
    requested
  }
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
  if File::open("/dev/urandom")
    .and_then(|mut file| file.read_exact(&mut bytes))
    .is_ok()
  {
    return bytes;
  }
  let fallback = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or_default();
  for (index, byte) in bytes.iter_mut().enumerate() {
    *byte = ((fallback >> ((index % 8) * 8)) & 0xff) as u8;
  }
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
    404 => "Not Found",
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
      mcp_command: PathBuf::from("lcv-mcp"),
      vault_db_path: None,
      relay_state_path: None,
      allow_direct_sidecar: true,
    }
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
  fn non_loopback_bind_requires_explicit_token() {
    assert!(is_loopback_bind("127.0.0.1:8765"));
    assert!(is_loopback_bind("localhost:8765"));
    assert!(!is_loopback_bind("0.0.0.0:8765"));
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
        id: "evt_1".to_string(),
        client_id: Some(client.client_id.clone()),
        required_scope: "memory.propose".to_string(),
        method: "tools/call".to_string(),
        tool_name: Some("life_context.propose_memory".to_string()),
        status: "fulfilled".to_string(),
        transport: "agent_websocket".to_string(),
        occurred_at: 123,
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
    assert!(raw.contains("Smoke Client"));
    assert!(raw.contains("life_context.propose_memory"));
    assert!(!raw.contains("Tone preference"));
    let _ = fs::remove_dir_all(dir);
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
