use serde_json::{json, Value};
use std::{
  env, fs,
  path::{Path, PathBuf},
  thread,
  time::{Duration, SystemTime, UNIX_EPOCH},
};
use tungstenite::{connect, Message};

#[path = "../mcp_stdio.rs"]
mod mcp_stdio;

fn main() {
  if let Err(error) = run() {
    eprintln!("lcv-agent error: {}", redact_pairing_code_text(&error));
    std::process::exit(1);
  }
}

fn run() -> Result<(), String> {
  let config = AgentConfig::from_env()?;
  write_agent_status(&config, "connecting", None);
  loop {
    match run_once(&config) {
      Ok(()) => {
        write_agent_status(&config, "disconnected", Some("relay connection closed"));
        if !config.reconnect {
          return Ok(());
        }
      }
      Err(error) => {
        let public_error = redact_pairing_code_text(&error);
        eprintln!("lcv-agent disconnected: {public_error}");
        write_agent_status(&config, "disconnected", Some(&public_error));
        if !config.reconnect {
          return Err(public_error);
        }
      }
    }
    thread::sleep(Duration::from_secs(config.reconnect_delay_seconds));
  }
}

#[derive(Clone, Debug)]
struct AgentConfig {
  relay_ws_url: String,
  mcp_command: PathBuf,
  vault_db_path: Option<String>,
  status_path: Option<PathBuf>,
  status_token: Option<String>,
  reconnect: bool,
  reconnect_delay_seconds: u64,
}

impl AgentConfig {
  fn from_env() -> Result<Self, String> {
    let relay_ws_url = env::var("LCV_AGENT_RELAY_WS").map_err(|_| {
      "LCV_AGENT_RELAY_WS is required, for example ws://127.0.0.1:8765/agent/ws?pairing_code=ABC123"
        .to_string()
    })?;
    Ok(Self {
      relay_ws_url,
      mcp_command: env::var("LCV_MCP_COMMAND")
        .map(PathBuf::from)
        .unwrap_or_else(|_| mcp_stdio::resolve_sibling_binary("lcv-mcp")),
      vault_db_path: env::var("LCV_VAULT_DB_PATH").ok(),
      status_path: env::var("LCV_AGENT_STATUS_PATH").ok().map(PathBuf::from),
      status_token: env::var("LCV_AGENT_STATUS_TOKEN").ok(),
      reconnect: env::var("LCV_AGENT_RECONNECT")
        .map(|value| value != "0")
        .unwrap_or(true),
      reconnect_delay_seconds: env::var("LCV_AGENT_RECONNECT_DELAY_SECONDS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(2),
    })
  }
}

fn run_once(config: &AgentConfig) -> Result<(), String> {
  let (mut socket, _) = connect(config.relay_ws_url.as_str())
    .map_err(|error| format!("failed to connect relay: {error}"))?;
  eprintln!(
    "Life Context Vault agent connected to {}",
    redacted_relay_ws_url(&config.relay_ws_url)
  );
  let mut ready_seen = false;

  loop {
    let message = socket
      .read()
      .map_err(|error| format!("failed to read relay websocket message: {error}"))?;
    let text = match message {
      Message::Text(text) => text.to_string(),
      Message::Ping(payload) => {
        socket
          .send(Message::Pong(payload))
          .map_err(|error| format!("failed to write pong: {error}"))?;
        if ready_seen {
          write_agent_status(config, "connected", None);
        }
        continue;
      }
      Message::Close(_) => return Ok(()),
      _ => continue,
    };
    let action = handle_relay_message(&text, config, ready_seen);
    if !ready_seen && !relay_action_allowed_before_ready(&action) {
      return Err("relay sent MCP traffic before readiness was confirmed".to_string());
    }
    match action {
      AgentMessageAction::Ready => {
        ready_seen = true;
        write_agent_status(config, "connected", None);
      }
      AgentMessageAction::Respond(response) => {
        write_agent_status(config, "connected", None);
        socket
          .send(Message::Text(response.to_string().into()))
          .map_err(|error| format!("failed to write relay websocket response: {error}"))?;
      }
      AgentMessageAction::Ignore => {}
      AgentMessageAction::RejectedBeforeReady => {
        return Err("relay sent MCP traffic before readiness was confirmed".to_string());
      }
    }
  }
}

fn write_agent_status(config: &AgentConfig, state: &str, last_error: Option<&str>) {
  let Some(path) = config.status_path.as_deref() else {
    return;
  };
  let now = unix_seconds();
  let last_connected_at = if state == "connected" {
    Some(now)
  } else {
    previous_last_connected_at(path)
  };
  let payload = json!({
    "state": state,
    "relayBaseUrl": relay_base_url_from_ws_url(&config.relay_ws_url),
    "updatedAt": now,
    "lastConnectedAt": last_connected_at,
    "lastError": last_error.map(redact_pairing_code_text),
    "statusToken": config.status_token,
    "processId": std::process::id()
  });
  if let Some(parent) = path.parent() {
    let _ = fs::create_dir_all(parent);
  }
  let temp_path = path.with_extension("json.tmp");
  if fs::write(&temp_path, payload.to_string()).is_ok() {
    let _ = fs::rename(temp_path, path);
  }
}

fn previous_last_connected_at(path: &Path) -> Option<u64> {
  fs::read_to_string(path)
    .ok()
    .and_then(|content| serde_json::from_str::<Value>(&content).ok())
    .and_then(|value| value.get("lastConnectedAt").and_then(Value::as_u64))
}

fn unix_seconds() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs())
    .unwrap_or_default()
}

fn relay_base_url_from_ws_url(url: &str) -> Option<String> {
  let (scheme, rest) = if let Some(rest) = url.strip_prefix("wss://") {
    ("https://", rest)
  } else if let Some(rest) = url.strip_prefix("ws://") {
    ("http://", rest)
  } else {
    return None;
  };
  let authority = rest.split('/').next()?.trim();
  if authority.is_empty() || authority.contains('@') {
    None
  } else {
    Some(format!("{scheme}{authority}"))
  }
}

fn redacted_relay_ws_url(url: &str) -> String {
  url
    .split_once('?')
    .map(|(base, _)| format!("{base}?query=REDACTED"))
    .unwrap_or_else(|| url.to_string())
}

fn redact_pairing_code_text(value: &str) -> String {
  let mut output = String::new();
  let mut rest = value;
  while let Some(index) = rest.find("/agent/ws?") {
    let query_start = index + "/agent/ws".len();
    output.push_str(&rest[..query_start]);
    output.push_str("?query=REDACTED");
    let after = &rest[query_start + 1..];
    let skip = after
      .find(|character: char| {
        character.is_whitespace()
          || character == '"'
          || character == '\''
          || character == ')'
          || character == '}'
      })
      .unwrap_or(after.len());
    rest = &after[skip..];
  }
  output.push_str(rest);
  output
}

enum AgentMessageAction {
  Ready,
  Respond(Value),
  Ignore,
  RejectedBeforeReady,
}

fn relay_action_allowed_before_ready(action: &AgentMessageAction) -> bool {
  matches!(action, AgentMessageAction::Ready | AgentMessageAction::Ignore)
}

fn handle_relay_message(text: &str, config: &AgentConfig, ready_seen: bool) -> AgentMessageAction {
  let parsed = match serde_json::from_str::<Value>(text) {
    Ok(value) => value,
    Err(error) => {
      return AgentMessageAction::Respond(json!({
        "type": "agent_error",
        "error": format!("invalid JSON from relay: {error}")
      }));
    }
  };
  let message_type = parsed.get("type").and_then(Value::as_str);
  if message_type == Some("agent_ready") {
    return AgentMessageAction::Ready;
  }
  if message_type != Some("mcp_request") {
    return AgentMessageAction::Ignore;
  }
  if !ready_seen {
    return AgentMessageAction::RejectedBeforeReady;
  }
  let id = parsed.get("id").and_then(Value::as_str).unwrap_or_default();
  let body = parsed.get("body").and_then(Value::as_str).unwrap_or_default();
  let client_id = parsed
    .get("clientId")
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty());
  if id.is_empty() || body.is_empty() {
    return AgentMessageAction::Respond(json!({
      "type": "mcp_response",
      "id": id,
      "error": "relay request is missing id or body"
    }));
  }

  AgentMessageAction::Respond(match mcp_stdio::forward_to_stdio_mcp(
    body,
    &config.mcp_command,
    config.vault_db_path.as_deref(),
    client_id,
  ) {
    Ok(Some(body)) => json!({
      "type": "mcp_response",
      "id": id,
      "body": body
    }),
    Ok(None) => json!({
      "type": "mcp_response",
      "id": id,
      "body": null
    }),
    Err(error) => json!({
      "type": "mcp_response",
      "id": id,
      "error": error
    }),
  })
}

#[cfg(test)]
fn legacy_handle_relay_message_for_test(text: &str, config: &AgentConfig) -> Value {
  match handle_relay_message(text, config, true) {
    AgentMessageAction::Respond(value) => value,
    AgentMessageAction::Ready => json!({
      "type": "agent_ready"
    }),
    AgentMessageAction::Ignore => json!({
      "type": "agent_error",
      "error": "unsupported relay message type"
    }),
    AgentMessageAction::RejectedBeforeReady => json!({
      "type": "agent_error",
      "error": "relay readiness has not been confirmed"
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn malformed_relay_message_returns_agent_error() {
    let config = AgentConfig {
      relay_ws_url: "ws://127.0.0.1:8765/agent/ws?pairing_code=test".to_string(),
      mcp_command: PathBuf::from("lcv-mcp"),
      vault_db_path: None,
      status_path: None,
      status_token: None,
      reconnect: false,
      reconnect_delay_seconds: 0,
    };
    let response = legacy_handle_relay_message_for_test("not-json", &config);
    assert_eq!(response.get("type").and_then(Value::as_str), Some("agent_error"));
  }

  #[test]
  fn relay_ws_url_log_redacts_pairing_code() {
    assert_eq!(
      redacted_relay_ws_url("ws://127.0.0.1:8765/agent/ws?pairing_code=secret"),
      "ws://127.0.0.1:8765/agent/ws?query=REDACTED"
    );
    assert_eq!(
      redacted_relay_ws_url("ws://127.0.0.1:8765/agent/ws"),
      "ws://127.0.0.1:8765/agent/ws"
    );
    assert_eq!(
      redact_pairing_code_text(
        "failed to connect wss://relay.example.com/agent/ws?pairing_code=secret&other=value"
      ),
      "failed to connect wss://relay.example.com/agent/ws?query=REDACTED"
    );
  }

  #[cfg(unix)]
  #[test]
  fn relay_message_forwards_effective_client_id_to_mcp_sidecar() {
    use std::os::unix::fs::PermissionsExt;

    let script_path = std::env::temp_dir().join(format!(
      "lcv-agent-env-test-{}.sh",
      std::process::id()
    ));
    std::fs::write(
      &script_path,
      "#!/bin/sh\ncat >/dev/null\nprintf '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"clientId\":\"%s\"}}\\n' \"$LCV_EFFECTIVE_CLIENT_ID\"\n",
    )
    .expect("write fake mcp sidecar");
    let mut permissions = std::fs::metadata(&script_path)
      .expect("metadata")
      .permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&script_path, permissions).expect("chmod fake mcp sidecar");

    let config = AgentConfig {
      relay_ws_url: "ws://127.0.0.1:8765/agent/ws?pairing_code=test".to_string(),
      mcp_command: script_path.clone(),
      vault_db_path: None,
      status_path: None,
      status_token: None,
      reconnect: false,
      reconnect_delay_seconds: 0,
    };
    let response = legacy_handle_relay_message_for_test(
      &json!({
        "type": "mcp_request",
        "id": "relay_req_1",
        "clientId": "client_chatgpt_oauth",
        "body": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
      })
      .to_string(),
      &config,
    );

    let body = response
      .get("body")
      .expect("body")
      .get("result")
      .expect("result");
    assert_eq!(
      body.get("clientId").and_then(Value::as_str),
      Some("client_chatgpt_oauth")
    );
    let _ = std::fs::remove_file(script_path);
  }

  #[test]
  fn relay_ready_message_updates_agent_status_without_mcp_response() {
    let config = AgentConfig {
      relay_ws_url: "wss://relay.example.com/agent/ws?pairing_code=test".to_string(),
      mcp_command: PathBuf::from("lcv-mcp"),
      vault_db_path: None,
      status_path: None,
      status_token: Some("status-token".to_string()),
      reconnect: false,
      reconnect_delay_seconds: 0,
    };
    match handle_relay_message(r#"{"type":"agent_ready","pairingId":"pair_1"}"#, &config, false) {
      AgentMessageAction::Ready => {}
      _ => panic!("agent_ready should not be forwarded to MCP"),
    }
  }

  #[test]
  fn mcp_request_is_not_allowed_before_relay_ready() {
    let config = AgentConfig {
      relay_ws_url: "wss://relay.example.com/agent/ws?pairing_code=test".to_string(),
      mcp_command: PathBuf::from("lcv-mcp"),
      vault_db_path: None,
      status_path: None,
      status_token: Some("status-token".to_string()),
      reconnect: false,
      reconnect_delay_seconds: 0,
    };
    let action = handle_relay_message(
      &json!({
        "type": "mcp_request",
        "id": "relay_req_1",
        "body": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
      })
      .to_string(),
      &config,
      false,
    );
    assert!(!relay_action_allowed_before_ready(&action));
    assert!(relay_action_allowed_before_ready(&AgentMessageAction::Ready));
  }

  #[cfg(unix)]
  #[test]
  fn pre_ready_mcp_request_does_not_launch_mcp_sidecar() {
    use std::os::unix::fs::PermissionsExt;

    let marker_path = std::env::temp_dir().join(format!(
      "lcv-agent-pre-ready-marker-{}.txt",
      std::process::id()
    ));
    let script_path = std::env::temp_dir().join(format!(
      "lcv-agent-pre-ready-test-{}.sh",
      std::process::id()
    ));
    std::fs::write(
      &script_path,
      format!(
        "#!/bin/sh\necho ran > '{}'\ncat >/dev/null\nprintf '{{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{{}}}}\\n'\n",
        marker_path.display()
      ),
    )
    .expect("write fake mcp sidecar");
    let mut permissions = std::fs::metadata(&script_path)
      .expect("metadata")
      .permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&script_path, permissions).expect("chmod fake mcp sidecar");

    let config = AgentConfig {
      relay_ws_url: "wss://relay.example.com/agent/ws?pairing_code=test".to_string(),
      mcp_command: script_path.clone(),
      vault_db_path: None,
      status_path: None,
      status_token: Some("status-token".to_string()),
      reconnect: false,
      reconnect_delay_seconds: 0,
    };
    let action = handle_relay_message(
      &json!({
        "type": "mcp_request",
        "id": "relay_req_1",
        "body": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
      })
      .to_string(),
      &config,
      false,
    );

    assert!(matches!(action, AgentMessageAction::RejectedBeforeReady));
    assert!(!marker_path.exists());
    let _ = std::fs::remove_file(script_path);
    let _ = std::fs::remove_file(marker_path);
  }

  #[test]
  fn agent_status_file_redacts_pairing_code_and_records_base_url() {
    let status_path = std::env::temp_dir().join(format!(
      "lcv-agent-status-test-{}.json",
      std::process::id()
    ));
    let config = AgentConfig {
      relay_ws_url: "wss://relay.example.com/agent/ws?pairing_code=super-secret".to_string(),
      mcp_command: PathBuf::from("lcv-mcp"),
      vault_db_path: None,
      status_path: Some(status_path.clone()),
      status_token: Some("status-token".to_string()),
      reconnect: false,
      reconnect_delay_seconds: 0,
    };

    write_agent_status(
      &config,
      "disconnected",
      Some("failed wss://relay.example.com/agent/ws?pairing_code=super-secret"),
    );
    let content = std::fs::read_to_string(&status_path).expect("status file");
    assert!(!content.contains("super-secret"));
    let parsed: Value = serde_json::from_str(&content).expect("status json");
    assert_eq!(parsed.get("state").and_then(Value::as_str), Some("disconnected"));
    assert_eq!(
      parsed.get("relayBaseUrl").and_then(Value::as_str),
      Some("https://relay.example.com")
    );
    assert_eq!(
      parsed.get("statusToken").and_then(Value::as_str),
      Some("status-token")
    );
    assert_eq!(
      parsed.get("lastError").and_then(Value::as_str),
      Some("failed wss://relay.example.com/agent/ws?query=REDACTED")
    );
    let _ = std::fs::remove_file(status_path);
  }
}
