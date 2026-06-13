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
  hostedRelayRegistrationReadiness,
  InboxView,
  aiAccessChecklistItems,
  isHostedRelayConfirmed,
  makeRestorePreview,
  manualCopyPayloadForPack,
  shouldShowCopyFallbackStarter,
  sourceReviewCandidates,
  webAiMcpEndpoint
} from "./App";
import { createEmptyVault } from "./vault";
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

  it("marks hosted relay registration ready only after confirmed public HTTPS pairing", () => {
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

    const readiness = hostedRelayRegistrationReadiness(
      hostedStatus,
      "/Users/kota/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3",
      "wss://relay.example.com/agent/ws?pairing_code=secret-code",
      "https://relay.example.com/mcp"
    );

    expect(readiness.tone).toBe("ready");
    expect(readiness.title).toBe("Web AIへ登録できます");
    expect(readiness.items.find((item) => item.label === "Public MCP URL")?.state).toBe("ready");
    expect(readiness.items.find((item) => item.label === "OAuth metadata")?.state).toBe("ready");
    expect(JSON.stringify(readiness)).not.toContain("secret-code");
  });

  it("keeps hosted relay registration pending until pairing is confirmed", () => {
    const pendingStatus = {
      managedByApp: true,
      relayMode: "hosted_agent",
      relayReachable: true,
      relayManagedRunning: false,
      agentManagedRunning: true,
      agentConnected: false,
      relayUrl: "https://relay.example.com",
      mcpServerUrl: "https://relay.example.com/mcp",
      relayStateStatusUrl: "https://relay.example.com/relay/state",
      agentRuntimeStatus: null,
      pairingCode: null,
      lastError: null
    } satisfies AiAccessServiceStatus;

    const readiness = hostedRelayRegistrationReadiness(
      pendingStatus,
      "/Users/kota/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3",
      "wss://relay.example.com/agent/ws?pairing_code=secret-code",
      null
    );

    expect(readiness.tone).toBe("attention");
    expect(readiness.title).toBe("pairing確認待ちです");
    expect(readiness.items.find((item) => item.label === "短命Agent URL")?.state).toBe("ready");
    expect(readiness.items.find((item) => item.label === "Public MCP URL")?.state).toBe("pending");
    expect(JSON.stringify(readiness)).not.toContain("secret-code");
  });

  it("blocks hosted relay registration for invalid agent URLs or browser-only use", () => {
    const invalidUrl = hostedRelayRegistrationReadiness(
      null,
      "/Users/kota/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3",
      "https://relay.example.com/agent/ws?pairing_code=secret-code",
      null
    );

    expect(invalidUrl.tone).toBe("blocked");
    expect(invalidUrl.title).toBe("Agent URLの形式を確認してください");
    expect(invalidUrl.items.find((item) => item.label === "短命Agent URL")?.state).toBe("blocked");
    expect(JSON.stringify(invalidUrl)).not.toContain("secret-code");

    const browserOnly = hostedRelayRegistrationReadiness(
      null,
      null,
      "wss://relay.example.com/agent/ws?pairing_code=secret-code",
      "https://relay.example.com/mcp"
    );

    expect(browserOnly.tone).toBe("blocked");
    expect(browserOnly.title).toBe("Desktop appでVaultを開いてください");
    expect(browserOnly.items.find((item) => item.label === "Desktop Vault")?.state).toBe("blocked");
    expect(JSON.stringify(browserOnly)).not.toContain("secret-code");
  });

  it("separates SSE ready diagnostics from unsupported event replay in the AI access checklist", () => {
    const status = {
      managedByApp: true,
      relayMode: "local_managed",
      relayReachable: true,
      relayManagedRunning: true,
      agentManagedRunning: true,
      agentConnected: true,
      relayUrl: "http://127.0.0.1:8765",
      mcpServerUrl: "http://127.0.0.1:8765/mcp",
      relayStateStatusUrl: "http://127.0.0.1:8765/relay/state",
      agentRuntimeStatus: null,
      pairingCode: null,
      lastError: null
    } satisfies AiAccessServiceStatus;

    const streamableHttp = aiAccessChecklistItems(
      status,
      "/Users/kota/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3"
    ).find((item) => item.label === "Streamable HTTP");

    expect(streamableHttp?.state).toBe("ready");
    expect(streamableHttp?.detail).toContain("GET SSE ready");
    expect(streamableHttp?.detail).toContain("SSE event replayは未広告");
    expect(streamableHttp?.detail).toContain("Last-Event-ID値を保存しません");
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

  it("builds a restore receipt that explains backup contents and current Vault replacement", () => {
    const current = createEmptyVault();
    current.sources = [
      {
        id: "source_current",
        kind: "manual_note",
        title: "Current note",
        origin: "manual_entry",
        body: "Current source body",
        createdAt: "2026-06-01T00:00:00.000Z",
        capturedAt: "2026-06-01T00:00:00.000Z",
        defaultSensitivity: "personal",
        processingStatus: "ready",
        deletionState: "active"
      }
    ];
    current.facts = [
      {
        id: "fact_current",
        factText: "Current approved fact",
        domain: "routines_and_logistics",
        factType: "note",
        sourceIds: ["source_current"],
        sensitivity: "personal",
        confidence: "user_asserted",
        status: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
        approvedAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        supersedesFactIds: []
      }
    ];

    const restored = createEmptyVault();
    restored.sources = [
      {
        id: "source_backup",
        kind: "document",
        title: "Backup insurance document",
        origin: "user_upload",
        body: "A backup source body that must not appear in the restore receipt.",
        createdAt: "2026-06-10T00:00:00.000Z",
        capturedAt: "2026-06-10T00:00:00.000Z",
        promotedToLongTerm: true,
        defaultSensitivity: "sensitive",
        processingStatus: "ready",
        deletionState: "active"
      }
    ];
    restored.facts = [
      {
        id: "fact_backup",
        factText: "Backup approved fact",
        domain: "contracts_and_policies",
        factType: "contract_term",
        sourceIds: ["source_backup"],
        sensitivity: "sensitive",
        confidence: "source_backed",
        status: "active",
        createdAt: "2026-06-10T00:00:00.000Z",
        approvedAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
        supersedesFactIds: []
      }
    ];
    restored.connectorSessions = [
      {
        id: "conn_chatgpt",
        clientKind: "chatgpt",
        clientName: "ChatGPT",
        transport: "remote_mcp_relay",
        oauthSubject: "oauth_subject_hash",
        scopes: ["context_pack.request"],
        status: "connected",
        createdAt: "2026-06-10T00:00:00.000Z",
        lastUsedAt: "2026-06-11T00:00:00.000Z"
      }
    ];
    restored.passiveCaptureEvents = [
      {
        id: "capture_expired",
        sourceClient: "chatgpt",
        conversationId: "conversation_1",
        urlHash: "hash_1",
        textFragmentRef: "fragment_ref",
        capturedAt: "2020-01-01T00:00:00.000Z",
        retentionUntil: "2020-01-15T00:00:00.000Z",
        sensitivityGuess: "personal",
        processingStatus: "captured",
        candidateIds: []
      }
    ];
    restored.auditEvents = [
      {
        id: "audit_1",
        eventType: "context_pack_delivered",
        actor: "user",
        subjectType: "context_pack",
        subjectId: "pack_1",
        occurredAt: "2026-06-12T00:00:00.000Z",
        sensitivity: "sensitive",
        metadata: {
          clientName: "ChatGPT",
          itemCount: 1
        }
      }
    ];

    const preview = makeRestorePreview(restored, current);

    expect(preview.counts).toMatchObject({
      sources: 1,
      facts: 1,
      connectorSessions: 1,
      policies: 4,
      captureEvents: 1,
      auditEvents: 1
    });
    expect(preview.currentCounts.sources).toBe(1);
    expect(preview.sensitivitySummary).toBe("センシティブ");
    expect(preview.activeConnectorCount).toBe(1);
    expect(preview.pairedConnectorCount).toBe(1);
    expect(preview.expiredCaptureCount).toBe(1);
    expect(preview.promotedSourceCount).toBe(1);
    expect(preview.receiptSections.map((section) => section.label)).toContain("AI接続とPolicy");
    expect(preview.receiptSections.find((section) => section.label === "Capture履歴")?.detail).toContain("TTL切れCapture");
    expect(preview.overwriteSections.find((section) => section.label === "生活コンテキスト")?.value).toContain(
      "1 Sources / 1 Facts -> 1 Sources / 1 Facts"
    );
    expect(JSON.stringify(preview)).not.toContain("must not appear");
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

  it("sends first-time Home onboarding to the guided background setup", () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      createElement(HomeView, {
        facts: [],
        candidates: [],
        connectors: [],
        captureSettings: {
          enabled: false,
          retentionDays: 14,
          allowedSites: []
        },
        captureEvents: [],
        sources: [],
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

    expect(html).toContain("生活背景を入れる");
    expect(html).toContain("入力欄へ");
    expect(html).toContain("生活背景を追加");
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
