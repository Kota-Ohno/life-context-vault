import { describe, expect, it } from "vitest";
import {
  MANAGED_RELAY_AGENT_WS_PATH,
  MANAGED_RELAY_BASE_URL,
  buildManagedAgentWebSocketUrl,
  managedRelayIsConfigured
} from "./managedRelay";

describe("managedRelay", () => {
  it("builds a wss:// pairing URL with the code encoded", () => {
    const url = buildManagedAgentWebSocketUrl("abc 123/+");
    expect(url).toBe(
      `wss://relay.lifecontextvault.example${MANAGED_RELAY_AGENT_WS_PATH}?pairing_code=abc%20123%2F%2B`
    );
  });

  it("uses the agent ws path under the managed host", () => {
    const url = buildManagedAgentWebSocketUrl("code");
    expect(url.startsWith("wss://")).toBe(true);
    expect(url).toContain(MANAGED_RELAY_AGENT_WS_PATH);
  });

  it("reports unconfigured while the placeholder host is in place", () => {
    expect(managedRelayIsConfigured()).toBe(false);
  });
});
