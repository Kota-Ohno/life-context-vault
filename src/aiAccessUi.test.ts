import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  aiMcpEndpointDisplay,
  canCopyAiMcpEndpoint,
  factInventoryCounts,
  factSourceNames,
  InboxView,
  isHostedRelayConfirmed,
  sourceReviewCandidates,
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

  it("counts which approved facts are eligible for AI context", () => {
    expect(
      factInventoryCounts([
        { status: "active" },
        { status: "needs_review" },
        { status: "user_hidden" },
        { status: "deleted" },
        { status: "superseded" },
        { status: "expired" }
      ])
    ).toEqual({
      total: 6,
      active: 1,
      needsReview: 1,
      hiddenOrDeleted: 2,
      history: 2
    });
  });

  it("shows only source-backed unapproved candidates in the Sources review queue", () => {
    expect(
      sourceReviewCandidates([
        { id: "candidate_new", sourceIds: ["source_1"], status: "new" },
        { id: "candidate_detail", sourceIds: ["source_1"], status: "needs_user_detail" },
        { id: "candidate_sensitive", sourceIds: ["source_2"], status: "blocked_sensitive" },
        { id: "candidate_without_source", sourceIds: [], status: "new" },
        { id: "candidate_approved", sourceIds: ["source_3"], status: "approved" },
        { id: "candidate_rejected", sourceIds: ["source_3"], status: "rejected" }
      ])
    ).toEqual([
      { id: "candidate_new", sourceIds: ["source_1"], status: "new" },
      { id: "candidate_detail", sourceIds: ["source_1"], status: "needs_user_detail" },
      { id: "candidate_sensitive", sourceIds: ["source_2"], status: "blocked_sensitive" }
    ]);
  });

  it("gives first-time users clear entry points from an empty Memory Inbox", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      createElement(InboxView, {
        candidates: [],
        facts: [],
        edits: {},
        supersedes: {},
        setEdit: noop,
        toggleSupersede: noop,
        approve: noop,
        reject: noop,
        archive: noop,
        markSensitive: noop,
        goHome: noop,
        goSources: noop,
        goConnections: noop
      })
    );

    expect(html).toContain("Inboxは空です");
    expect(html).toContain("背景情報を追加");
    expect(html).toContain("文書・メモを追加");
    expect(html).toContain("AI会話Captureを設定");
    expect(html).toContain("候補は承認するとFactになり");
    expect(html).toContain("Context Pack確認後だけAIに渡ります");
  });
});
