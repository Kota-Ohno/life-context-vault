import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  aiConnectionDiagnostic,
  aiMcpEndpointDisplay,
  auditReceiptBody,
  canCopyAiMcpEndpoint,
  factInventoryCounts,
  factSourceNames,
  homeCaptureSafetySummary,
  homeNextActionKind,
  HomeView,
  InboxView,
  isHostedRelayConfirmed,
  manualCopyPayloadForPack,
  shouldShowCopyFallbackStarter,
  sourceReviewCandidates,
  webAiMcpEndpoint
} from "./App";
import type { AuditEvent, PassiveCaptureEvent, PassiveCaptureSettings, RawSource } from "./types";
import type { AiAccessServiceStatus } from "./nativeStorage";

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

  it("summarizes connection diagnostics without leaking hosted pairing secrets", () => {
    const hostedStatus = {
      managedByApp: true,
      relayMode: "hosted_agent",
      relayReachable: true,
      relayManagedRunning: false,
      agentManagedRunning: true,
      agentConnected: false,
      relayUrl: "https://relay.example.com",
      mcpServerUrl: "https://relay.example.com/mcp",
      relayStateStatusUrl: "https://relay.example.com/relay/state",
      agentRuntimeStatus: {
        state: "connecting",
        relayBaseUrl: "https://relay.example.com",
        updatedAt: 1781280000,
        lastConnectedAt: null,
        lastError: "failed wss://relay.example.com/agent/ws?pairing_code=secret-code Authorization: Bearer secret-token",
        statusToken: null,
        processId: null
      },
      pairingCode: null,
      lastError: null
    } satisfies AiAccessServiceStatus;

    const diagnostic = aiConnectionDiagnostic(
      hostedStatus,
      "/Users/kota/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3",
      "wss://relay.example.com/agent/ws?pairing_code=secret-code",
      null
    );

    expect(diagnostic.tone).toBe("attention");
    expect(diagnostic.primaryAction).toBe("start_hosted_agent");
    expect(diagnostic.issue).toContain("pairing_code=...");
    expect(diagnostic.issue).toContain("Bearer ...");
    expect(diagnostic.issue).not.toContain("secret-code");
    expect(diagnostic.issue).not.toContain("secret-token");
    expect(diagnostic.items.find((item) => item.label === "Web AI")?.state).toBe("pending");
  });

  it("marks confirmed hosted relay diagnostics ready for Web AI connector setup", () => {
    const hostedStatus = {
      managedByApp: true,
      relayMode: "hosted_agent",
      relayReachable: true,
      relayManagedRunning: false,
      agentManagedRunning: true,
      agentConnected: true,
      relayUrl: "https://relay.example.com",
      mcpServerUrl: "https://relay.example.com/mcp",
      relayStateStatusUrl: "https://relay.example.com/relay/state",
      agentRuntimeStatus: null,
      pairingCode: null,
      lastError: null
    } satisfies AiAccessServiceStatus;

    const diagnostic = aiConnectionDiagnostic(
      hostedStatus,
      "/Users/kota/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3",
      "",
      "https://relay.example.com/mcp"
    );

    expect(diagnostic.tone).toBe("ready");
    expect(diagnostic.primaryAction).toBe("copy_web_connector");
    expect(diagnostic.items.find((item) => item.label === "Web AI")?.value).toBe("Remote MCP登録可");
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

  it("shows the copy fallback starter only on an empty Context Requests inbox", () => {
    expect(shouldShowCopyFallbackStarter([], null)).toBe(true);
    expect(shouldShowCopyFallbackStarter([{ id: "request_1" }], null)).toBe(false);
    expect(shouldShowCopyFallbackStarter([], { id: "pack_1" })).toBe(false);
  });

  it("shows a manual copy payload only for the active Context Pack", () => {
    const payload = {
      packId: "pack_1",
      payloadText: "{\"trustBoundary\":\"ContextPack only\"}",
      createdAt: "2026-06-13T00:00:00.000Z"
    };

    expect(manualCopyPayloadForPack(payload, { id: "pack_1" })).toEqual(payload);
    expect(manualCopyPayloadForPack(payload, { id: "pack_2" })).toBeNull();
    expect(manualCopyPayloadForPack(null, { id: "pack_1" })).toBeNull();
    expect(manualCopyPayloadForPack(payload, null)).toBeNull();
  });

  it("summarizes Home passive capture safety without treating captures as facts", () => {
    const settings: PassiveCaptureSettings = {
      enabled: true,
      retentionDays: 14,
      allowedSites: ["chatgpt.com", "claude.ai", "gemini.google.com"]
    };
    const event: PassiveCaptureEvent = {
      id: "capture_1",
      sourceClient: "chatgpt",
      conversationId: "thread_1",
      urlHash: "urlhash_1",
      textFragmentRef: "source_capture_1:0-48",
      capturedAt: "2026-06-13T00:00:00.000Z",
      retentionUntil: "2026-06-27T00:00:00.000Z",
      sensitivityGuess: "personal",
      processingStatus: "candidate_generated",
      sourceId: "source_capture_1",
      candidateIds: ["candidate_1"]
    };
    const source: RawSource = {
      id: "source_capture_1",
      kind: "passive_capture",
      title: "Passive capture from ChatGPT",
      origin: "passive_browser",
      body: "来月引っ越す予定。住所変更が必要な契約を確認したい。",
      createdAt: "2026-06-13T00:00:00.000Z",
      capturedAt: "2026-06-13T00:00:00.000Z",
      retentionUntil: "2026-06-27T00:00:00.000Z",
      defaultSensitivity: "personal",
      processingStatus: "ready",
      deletionState: "active"
    };

    const summary = homeCaptureSafetySummary(settings, [event], [source]);

    expect(summary.tone).toBe("ready");
    expect(summary.allowedSitesLabel).toBe("chatgpt.com, claude.ai +1");
    expect(summary.lastPreview).toContain("来月引っ越す予定");
    expect(summary.purgeableCount).toBe(1);
    expect(summary.body).toContain("未承認候補");
    expect(summary.body).toContain("Context Pack確認");
    const longPreview = homeCaptureSafetySummary(
      settings,
      [event],
      [
        {
          ...source,
          body: "これはとても長い会話断片です。".repeat(10)
        }
      ]
    ).lastPreview;
    expect(longPreview?.endsWith("...")).toBe(true);
    expect(longPreview?.length).toBeLessThanOrEqual(87);
    expect(
      homeCaptureSafetySummary(
        { ...settings, allowedSites: ["chatgpt.com", "claude.ai", "gemini.google.com"] },
        [],
        []
      ).allowedSitesLabel
    ).toBe("chatgpt.com, claude.ai +1");
  });

  it("shows paused capture safety as non-writing and keeps purged bodies out of purge count", () => {
    const settings: PassiveCaptureSettings = {
      enabled: false,
      retentionDays: 14,
      allowedSites: []
    };
    const event: PassiveCaptureEvent = {
      id: "capture_1",
      sourceClient: "claude_remote",
      conversationId: "thread_1",
      urlHash: "urlhash_1",
      textFragmentRef: "source_capture_1:0-48",
      capturedAt: "2026-06-13T00:00:00.000Z",
      retentionUntil: "2026-06-27T00:00:00.000Z",
      sensitivityGuess: "personal",
      processingStatus: "purged",
      sourceId: "source_capture_1",
      candidateIds: []
    };
    const source: RawSource = {
      id: "source_capture_1",
      kind: "passive_capture",
      title: "Purged passive capture",
      origin: "passive_browser",
      body: "",
      createdAt: "2026-06-13T00:00:00.000Z",
      capturedAt: "2026-06-13T00:00:00.000Z",
      retentionUntil: "2026-06-27T00:00:00.000Z",
      defaultSensitivity: "personal",
      processingStatus: "deleted",
      deletionState: "purged"
    };

    const summary = homeCaptureSafetySummary(settings, [event], [source]);

    expect(summary.tone).toBe("attention");
    expect(summary.title).toBe("Passive Captureは停止中");
    expect(summary.body).toContain("書き込みません");
    expect(summary.allowedSitesLabel).toBe("未設定");
    expect(summary.purgeableCount).toBe(0);
  });

  it("renders passive capture controls on Home so users can pause or purge without hunting", () => {
    const noop = () => undefined;
    const settings: PassiveCaptureSettings = {
      enabled: true,
      retentionDays: 14,
      allowedSites: ["chatgpt.com"]
    };
    const event: PassiveCaptureEvent = {
      id: "capture_1",
      sourceClient: "chatgpt",
      conversationId: "thread_1",
      urlHash: "urlhash_1",
      textFragmentRef: "source_capture_1:0-24",
      capturedAt: "2026-06-13T00:00:00.000Z",
      retentionUntil: "2026-06-27T00:00:00.000Z",
      sensitivityGuess: "personal",
      processingStatus: "candidate_generated",
      sourceId: "source_capture_1",
      candidateIds: ["candidate_1"]
    };
    const source: RawSource = {
      id: "source_capture_1",
      kind: "passive_capture",
      title: "Passive capture from ChatGPT",
      origin: "passive_browser",
      body: "来月引っ越す予定。住所変更が必要な契約を確認したい。",
      createdAt: "2026-06-13T00:00:00.000Z",
      capturedAt: "2026-06-13T00:00:00.000Z",
      retentionUntil: "2026-06-27T00:00:00.000Z",
      defaultSensitivity: "personal",
      processingStatus: "ready",
      deletionState: "active"
    };

    const html = renderToStaticMarkup(
      createElement(HomeView, {
        facts: [],
        candidates: [],
        connectors: [
          {
            id: "connector_capture",
            clientKind: "chatgpt",
            clientName: "ChatGPT Capture",
            transport: "browser_extension",
            scopes: ["passive_capture.write"],
            status: "available",
            createdAt: "2026-06-13T00:00:00.000Z",
            lastUsedAt: "2026-06-13T00:00:00.000Z"
          }
        ],
        captureSettings: settings,
        captureEvents: [event],
        sources: [source],
        requests: [],
        nativePath: null,
        aiServiceStatus: null,
        aiServiceBusy: false,
        setup: {
          displayName: "",
          tonePreference: "",
          activeLifeAreas: "",
          recurringConstraints: "",
          confirmationTopics: ""
        },
        setSetup: noop,
        submitBackground: noop,
        startAiAccess: noop,
        updateCapture: noop,
        purgeAllPassiveCaptures: noop,
        seedDemo: noop,
        goInbox: noop,
        goSources: noop,
        goRequests: noop,
        goConnections: noop
      })
    );

    expect(html).toContain("Capture safety");
    expect(html).toContain("許可サイトだけをローカルで候補化中");
    expect(html).toContain("Captureを一時停止");
    expect(html).toContain("Capture詳細");
    expect(html).toContain("全本文を消去");
    expect(html).toContain("chatgpt.com");
    expect(html).toContain("来月引っ越す予定");
    expect(html).toContain("未承認候補");
  });

  it("prioritizes a first Context Pack trial before MCP setup once facts are approved", () => {
    expect(
      homeNextActionKind({
        candidateCount: 0,
        backgroundStarted: true,
        approvedFactCount: 2,
        pendingRequestCount: 0,
        requestCount: 0,
        aiAccessReady: false
      })
    ).toBe("try_context_pack");
    expect(
      homeNextActionKind({
        candidateCount: 0,
        backgroundStarted: true,
        approvedFactCount: 2,
        pendingRequestCount: 0,
        requestCount: 1,
        aiAccessReady: false
      })
    ).toBe("connect_ai");
    expect(
      homeNextActionKind({
        candidateCount: 1,
        backgroundStarted: true,
        approvedFactCount: 2,
        pendingRequestCount: 0,
        requestCount: 0,
        aiAccessReady: false
      })
    ).toBe("review_candidates");
    expect(
      homeNextActionKind({
        candidateCount: 0,
        backgroundStarted: true,
        approvedFactCount: 0,
        pendingRequestCount: 0,
        requestCount: 0,
        aiAccessReady: false
      })
    ).toBe("add_background");
  });

  it("describes AI delivery receipts by life domain without storing body text", () => {
    const event: AuditEvent = {
      id: "audit_1",
      eventType: "context_pack_delivered",
      actor: "user",
      subjectType: "context_pack",
      subjectId: "pack_1",
      occurredAt: "2026-06-13T00:00:00.000Z",
      sensitivity: "private_consequential",
      metadata: {
        includedDomains: ["contracts_and_policies", "documents_and_evidence"],
        itemCount: 2,
        sourceSnippetCount: 1,
        excludedCount: 3,
        bodyStoredInAudit: false
      }
    };

    const body = auditReceiptBody(event);

    expect(body).toContain("契約・保険、書類・証明の文脈");
    expect(body).toContain("2件のApprovedFact");
    expect(body).toContain("Raw Source本文と未承認候補は含めていません");
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
