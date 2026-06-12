import { describe, expect, it } from "vitest";
import {
  aiMcpEndpointDisplay,
  canCopyAiMcpEndpoint,
  factSourceNames,
  isHostedRelayConfirmed,
  webAiMcpEndpoint
} from "./App";

describe("AI access UI safety", () => {
  it("blocks public MCP endpoint copying while hosted relay pairing is unconfirmed", () => {
    const pendingHosted = { relayMode: "hosted_agent", agentConnected: false } as const;

    expect(isHostedRelayConfirmed(pendingHosted)).toBe(false);
    expect(canCopyAiMcpEndpoint(pendingHosted)).toBe(false);
    expect(aiMcpEndpointDisplay(pendingHosted, "https://relay.example.com/mcp")).toBe("pairing確認後に表示");
    expect(webAiMcpEndpoint(pendingHosted, "https://relay.example.com/mcp")).toBeNull();
  });

  it("allows MCP endpoint copying for confirmed hosted and local modes", () => {
    const confirmedHosted = { relayMode: "hosted_agent", agentConnected: true } as const;
    const localRelay = { relayMode: "local_managed", agentConnected: false } as const;

    expect(isHostedRelayConfirmed(confirmedHosted)).toBe(true);
    expect(canCopyAiMcpEndpoint(confirmedHosted)).toBe(true);
    expect(aiMcpEndpointDisplay(confirmedHosted, "https://relay.example.com/mcp")).toBe("https://relay.example.com/mcp");
    expect(webAiMcpEndpoint(confirmedHosted, "https://relay.example.com/mcp")).toBe("https://relay.example.com/mcp");
    expect(canCopyAiMcpEndpoint(localRelay)).toBe(true);
    expect(aiMcpEndpointDisplay(localRelay, "http://127.0.0.1:8765/mcp")).toBe("http://127.0.0.1:8765/mcp");
    expect(webAiMcpEndpoint(localRelay, "http://127.0.0.1:8765/mcp")).toBeNull();
    expect(webAiMcpEndpoint(localRelay, "https://relay.example.com/mcp")).toBe("https://relay.example.com/mcp");
  });

  it("shows source titles for source-backed facts", () => {
    expect(
      factSourceNames(
        { sourceIds: ["source_background", "source_policy", "source_extra"] },
        [
          { id: "source_background", title: "Guided background setup" },
          { id: "source_policy", title: "Sample insurance renewal note" }
        ]
      )
    ).toBe("Guided background setup, Sample insurance renewal note, +1");
    expect(factSourceNames({ sourceIds: [] }, [])).toBe("出典なし");
    expect(factSourceNames({ sourceIds: ["missing"] }, [])).toBe("Source未検出");
  });
});
