use serde_json::{json, Value};
use std::{
  env,
  io::{BufRead, BufReader, Read, Write},
  net::{TcpListener, TcpStream},
  path::PathBuf,
  process::{Command, Stdio},
};

const DEFAULT_BIND: &str = "127.0.0.1:8765";

fn main() {
  if let Err(error) = run() {
    eprintln!("lcv-relay error: {error}");
    std::process::exit(1);
  }
}

fn run() -> Result<(), String> {
  let config = RelayConfig::from_env()?;
  eprintln!("Life Context Vault relay listening on http://{}", config.bind);
  let listener = TcpListener::bind(&config.bind)
    .map_err(|error| format!("failed to bind {}: {error}", config.bind))?;

  for stream in listener.incoming() {
    match stream {
      Ok(stream) => {
        if let Err(error) = handle_stream(stream, &config) {
          eprintln!("relay request error: {error}");
        }
      }
      Err(error) => eprintln!("relay connection error: {error}"),
    }
  }

  Ok(())
}

#[derive(Clone, Debug)]
struct RelayConfig {
  bind: String,
  token: String,
  mcp_command: PathBuf,
  vault_db_path: Option<String>,
}

impl RelayConfig {
  fn from_env() -> Result<Self, String> {
    let bind = env::var("LCV_RELAY_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let token = env::var("LCV_RELAY_TOKEN").unwrap_or_else(|_| "dev-local-token".to_string());
    if !is_loopback_bind(&bind) && env::var("LCV_RELAY_TOKEN").is_err() {
      return Err("LCV_RELAY_TOKEN is required when binding outside loopback".to_string());
    }
    Ok(Self {
      bind,
      token,
      mcp_command: resolve_mcp_command(),
      vault_db_path: env::var("LCV_VAULT_DB_PATH").ok(),
    })
  }
}

fn handle_stream(mut stream: TcpStream, config: &RelayConfig) -> Result<(), String> {
  let request = HttpRequest::read(&mut stream)?;
  let response = route_request(&request, config);
  response.write_to(&mut stream)
}

fn route_request(request: &HttpRequest, config: &RelayConfig) -> HttpResponse {
  match (request.method.as_str(), request.path.as_str()) {
    ("GET", "/health") => json_response(200, json!({
      "status": "ok",
      "server": "life-context-vault-relay",
      "mcpEndpoint": "/mcp"
    })),
    ("GET", "/.well-known/oauth-protected-resource") => json_response(200, json!({
      "resource": format!("http://{}/mcp", config.bind),
      "authorization_servers": [format!("http://{}", config.bind)],
      "scopes_supported": [
        "context_pack.request",
        "memory.propose",
        "policy.read",
        "request.status"
      ],
      "bearer_methods_supported": ["header"]
    })),
    ("OPTIONS", "/mcp") => HttpResponse::empty(204).with_cors(),
    ("POST", "/mcp") => {
      if !authorized(request, &config.token) {
        return json_response(401, json!({
          "error": "unauthorized",
          "message": "Missing or invalid Authorization bearer token."
        }))
        .with_header("WWW-Authenticate", "Bearer");
      }
      match forward_to_stdio_mcp(&request.body, config) {
        Ok(Some(body)) => HttpResponse::json(200, body).with_cors(),
        Ok(None) => HttpResponse::empty(202).with_cors(),
        Err(error) => json_response(500, json!({
          "error": "relay_forward_failed",
          "message": error
        })),
      }
    }
    _ => json_response(404, json!({
      "error": "not_found",
      "message": "Use POST /mcp for MCP JSON-RPC over HTTP."
    })),
  }
}

fn forward_to_stdio_mcp(body: &str, config: &RelayConfig) -> Result<Option<Value>, String> {
  let mut command = Command::new(&config.mcp_command);
  if let Some(path) = &config.vault_db_path {
    command.env("LCV_VAULT_DB_PATH", path);
  }
  let mut child = command
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| {
      format!(
        "failed to start MCP sidecar at {}: {error}",
        config.mcp_command.display()
      )
    })?;

  {
    let stdin = child.stdin.as_mut().ok_or_else(|| "failed to open MCP stdin".to_string())?;
    stdin
      .write_all(body.as_bytes())
      .map_err(|error| format!("failed to write MCP request: {error}"))?;
    stdin
      .write_all(b"\n")
      .map_err(|error| format!("failed to terminate MCP request: {error}"))?;
  }

  let output = child
    .wait_with_output()
    .map_err(|error| format!("failed to read MCP response: {error}"))?;
  if !output.status.success() {
    return Err(format!(
      "MCP sidecar exited with {}: {}",
      output.status,
      String::from_utf8_lossy(&output.stderr)
    ));
  }
  let stdout = String::from_utf8_lossy(&output.stdout);
  let Some(line) = stdout.lines().find(|line| !line.trim().is_empty()) else {
    return Ok(None);
  };
  serde_json::from_str::<Value>(line)
    .map(Some)
    .map_err(|error| format!("MCP sidecar returned invalid JSON: {error}"))
}

#[derive(Debug)]
struct HttpRequest {
  method: String,
  path: String,
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

    Ok(Self {
      method: parts[0].to_string(),
      path: parts[1].split('?').next().unwrap_or("/").to_string(),
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
      .with_header("Access-Control-Allow-Methods", "POST, OPTIONS")
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

fn authorized(request: &HttpRequest, token: &str) -> bool {
  request
    .header("Authorization")
    .and_then(|value| value.strip_prefix("Bearer "))
    .map(|value| value == token)
    .unwrap_or(false)
}

fn is_loopback_bind(bind: &str) -> bool {
  bind.starts_with("127.") || bind.starts_with("localhost:") || bind.starts_with("[::1]:")
}

fn resolve_mcp_command() -> PathBuf {
  if let Ok(command) = env::var("LCV_MCP_COMMAND") {
    return PathBuf::from(command);
  }
  if let Ok(current) = env::current_exe() {
    if let Some(parent) = current.parent() {
      let sibling = parent.join(format!("lcv-mcp{}", env::consts::EXE_SUFFIX));
      if sibling.exists() {
        return sibling;
      }
    }
  }
  PathBuf::from(format!("lcv-mcp{}", env::consts::EXE_SUFFIX))
}

fn reason_phrase(status: u16) -> &'static str {
  match status {
    200 => "OK",
    202 => "Accepted",
    204 => "No Content",
    401 => "Unauthorized",
    404 => "Not Found",
    500 => "Internal Server Error",
    _ => "OK",
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn auth_requires_matching_bearer_token() {
    let request = HttpRequest {
      method: "POST".to_string(),
      path: "/mcp".to_string(),
      headers: vec![("Authorization".to_string(), "Bearer test-token".to_string())],
      body: "{}".to_string(),
    };

    assert!(authorized(&request, "test-token"));
    assert!(!authorized(&request, "wrong-token"));
  }

  #[test]
  fn non_loopback_bind_requires_explicit_token() {
    assert!(is_loopback_bind("127.0.0.1:8765"));
    assert!(is_loopback_bind("localhost:8765"));
    assert!(!is_loopback_bind("0.0.0.0:8765"));
  }
}
