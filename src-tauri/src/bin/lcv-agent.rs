use serde_json::{json, Value};
use std::{env, path::PathBuf, thread, time::Duration};
use tungstenite::{connect, Message};

#[path = "../mcp_stdio.rs"]
mod mcp_stdio;

fn main() {
  if let Err(error) = run() {
    eprintln!("lcv-agent error: {error}");
    std::process::exit(1);
  }
}

fn run() -> Result<(), String> {
  let config = AgentConfig::from_env()?;
  loop {
    match run_once(&config) {
      Ok(()) => {
        if !config.reconnect {
          return Ok(());
        }
      }
      Err(error) => {
        eprintln!("lcv-agent disconnected: {error}");
        if !config.reconnect {
          return Err(error);
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
  eprintln!("Life Context Vault agent connected to {}", config.relay_ws_url);

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
        continue;
      }
      Message::Close(_) => return Ok(()),
      _ => continue,
    };
    let response = handle_relay_message(&text, config);
    socket
      .send(Message::Text(response.to_string().into()))
      .map_err(|error| format!("failed to write relay websocket response: {error}"))?;
  }
}

fn handle_relay_message(text: &str, config: &AgentConfig) -> Value {
  let parsed = match serde_json::from_str::<Value>(text) {
    Ok(value) => value,
    Err(error) => {
      return json!({
        "type": "agent_error",
        "error": format!("invalid JSON from relay: {error}")
      });
    }
  };
  if parsed.get("type").and_then(Value::as_str) != Some("mcp_request") {
    return json!({
      "type": "agent_error",
      "error": "unsupported relay message type"
    });
  }
  let id = parsed.get("id").and_then(Value::as_str).unwrap_or_default();
  let body = parsed.get("body").and_then(Value::as_str).unwrap_or_default();
  if id.is_empty() || body.is_empty() {
    return json!({
      "type": "mcp_response",
      "id": id,
      "error": "relay request is missing id or body"
    });
  }

  match mcp_stdio::forward_to_stdio_mcp(
    body,
    &config.mcp_command,
    config.vault_db_path.as_deref(),
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
      reconnect: false,
      reconnect_delay_seconds: 0,
    };
    let response = handle_relay_message("not-json", &config);
    assert_eq!(response.get("type").and_then(Value::as_str), Some("agent_error"));
  }
}
