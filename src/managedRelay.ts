/**
 * Managed-relay defaults baked into the app for one-click AI connection (P0-B).
 *
 * The managed relay is the operator-hosted metadata-only relay. Baking its
 * endpoint here means end users never type relay URLs; the Connections UI
 * pairs with it directly. Replace the placeholder host with the operator's
 * real domain before public release.
 */

export const MANAGED_RELAY_BASE_URL =
  "https://relay.lifecontextvault.example";

/** WebSocket path on the managed relay that the local agent pairs through. */
export const MANAGED_RELAY_AGENT_WS_PATH = "/agent/ws";

/**
 * Build the `wss://.../agent/ws?pairing_code=...` URL the local `lcv-agent`
 * connects to. Pairing codes are short-lived; the caller generates the code
 * (via the existing start_ai_access_agent_for_relay flow) and discards it
 * once the relay returns `agent_ready`.
 */
export function buildManagedAgentWebSocketUrl(pairingCode: string): string {
  const wsBase = MANAGED_RELAY_BASE_URL.replace(/^http/i, "ws");
  return `${wsBase}${MANAGED_RELAY_AGENT_WS_PATH}?pairing_code=${encodeURIComponent(pairingCode)}`;
}

/**
 * True when the managed relay endpoint has been configured (no longer the
 * placeholder). Used by the Connections UI to decide whether to show the
 * one-click managed path or fall back to copy/manual setup.
 */
export function managedRelayIsConfigured(): boolean {
  return !MANAGED_RELAY_BASE_URL.includes(".example");
}
