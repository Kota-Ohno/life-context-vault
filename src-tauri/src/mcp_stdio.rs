use serde_json::Value;
use std::{
  env,
  io::Write,
  path::PathBuf,
  process::{Command, Stdio},
};

#[allow(dead_code)]
pub fn forward_to_stdio_mcp(
  body: &str,
  mcp_command: &PathBuf,
  vault_db_path: Option<&str>,
) -> Result<Option<Value>, String> {
  let mut command = Command::new(mcp_command);
  if let Some(path) = vault_db_path {
    command.env("LCV_VAULT_DB_PATH", path);
  }
  if let Ok(key) = env::var("LCV_VAULT_DB_KEY") {
    command.env("LCV_VAULT_DB_KEY", key);
  }

  let mut child = command
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| {
      format!(
        "failed to start MCP sidecar at {}: {error}",
        mcp_command.display()
      )
    })?;

  {
    let stdin = child
      .stdin
      .as_mut()
      .ok_or_else(|| "failed to open MCP stdin".to_string())?;
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

pub fn resolve_sibling_binary(name: &str) -> PathBuf {
  if let Ok(current) = env::current_exe() {
    if let Some(parent) = current.parent() {
      for candidate in binary_candidates(parent, name) {
        if candidate.exists() {
          return candidate;
        }
      }
      if let Some(contents_dir) = parent.parent() {
        let resources = contents_dir.join("Resources");
        for candidate in binary_candidates(&resources, name) {
          if candidate.exists() {
            return candidate;
          }
        }
      }
    }
  }
  PathBuf::from(format!("{name}{}", env::consts::EXE_SUFFIX))
}

fn binary_candidates(parent: &std::path::Path, name: &str) -> Vec<PathBuf> {
  let mut candidates = vec![parent.join(format!("{name}{}", env::consts::EXE_SUFFIX))];
  if let Some(triple) = host_triple() {
    candidates.push(parent.join(format!("{name}-{triple}{}", env::consts::EXE_SUFFIX)));
  }
  candidates
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn host_triple() -> Option<&'static str> {
  Some("aarch64-apple-darwin")
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn host_triple() -> Option<&'static str> {
  Some("x86_64-apple-darwin")
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn host_triple() -> Option<&'static str> {
  Some("x86_64-unknown-linux-gnu")
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn host_triple() -> Option<&'static str> {
  Some("x86_64-pc-windows-msvc")
}

#[cfg(not(any(
  all(target_os = "macos", target_arch = "aarch64"),
  all(target_os = "macos", target_arch = "x86_64"),
  all(target_os = "linux", target_arch = "x86_64"),
  all(target_os = "windows", target_arch = "x86_64")
)))]
fn host_triple() -> Option<&'static str> {
  None
}
