import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  aiConnectionDiagnostic,
  aiMcpEndpointDisplay,
  auditReceiptBody,
  canCopyAiMcpEndpoint,
  clearVaultImpactSections,
  connectionDiagnosticSummaryBadge,
  contextPackDeliveryState,
  contextPackBoundaryReceipt,
  documentIngestionReadiness,
  effectiveRequestStatus,
  factInventoryCounts,
  factSourceNames,
  homeAiBoundarySections,
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
  webAiRegistrationGuides,
  webAiMcpEndpoint
} from "./App";
import { createEmptyVault } from "./vault";
import type {
  AuditEvent,
  ContextPack,
  ContextPackRequest,
  PassiveCaptureEvent,
  PassiveCaptureSettings,
  RawSource
} from "./types";
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

    const summary = connectionDiagnosticSummaryBadge(diagnostic);
    expect(summary).toEqual({ label: "要確認", detail: "1/4 ready" });
    expect(JSON.stringify(summary)).not.toContain("secret-code");
    expect(JSON.stringify(summary)).not.toContain("secret-token");
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
    expect(connectionDiagnosticSummaryBadge(diagnostic)).toEqual({ label: "Ready", detail: "4/4 ready" });
  });

  it("keeps the connection diagnostic summary useful when desktop is unavailable", () => {
    const diagnostic = aiConnectionDiagnostic(null, null, "", null);

    expect(diagnostic.tone).toBe("blocked");
    expect(connectionDiagnosticSummaryBadge(diagnostic)).toEqual({ label: "利用不可", detail: "0/4 ready" });
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

  it("turns hosted relay readiness into provider-specific Web AI registration steps", () => {
    const readiness = {
      tone: "ready" as const,
      title: "Web AIへ登録できます",
      summary: "公開HTTPS Relayとのpairing確認済みです。",
      nextStep: "Web AI用接続情報をコピーします。",
      items: []
    };

    const guides = webAiRegistrationGuides(readiness, {
      name: "Life Context Vault",
      url: "https://relay.example.com/mcp"
    });

    expect(guides).toHaveLength(3);
    expect(guides.find((guide) => guide.provider === "ChatGPT")?.status).toBe("ready");
    expect(guides.find((guide) => guide.provider === "ChatGPT")?.steps).toContain("ChatGPTに接続情報を貼り付け");
    expect(guides.find((guide) => guide.provider === "ChatGPT")?.boundary).toContain("登録方式を切り替え");
    expect(guides.find((guide) => guide.provider === "Claude Web")?.actionLabel).toBe("Claude用JSONをコピー");
    expect(guides.find((guide) => guide.provider === "MCPなしのAI")?.status).toBe("ready");
    expect(JSON.stringify(guides)).toContain("確認済みContext Pack");
  });

  it("keeps Web AI registration steps pending until connector info is available", () => {
    const readiness = {
      tone: "attention" as const,
      title: "pairing確認待ちです",
      summary: "公開MCP URLは推定できます。",
      nextStep: "Hosted RelayへAgent接続を実行します。",
      items: []
    };

    const guides = webAiRegistrationGuides(readiness, null);

    expect(guides.find((guide) => guide.provider === "ChatGPT")?.status).toBe("pending");
    expect(guides.find((guide) => guide.provider === "ChatGPT")?.actionLabel).toBe("pairing後にコピー");
    expect(guides.find((guide) => guide.provider === "MCPなしのAI")?.status).toBe("ready");
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

  it("separates SSE ready diagnostics from metadata-only event replay in the AI access checklist", () => {
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
    expect(streamableHttp?.detail).toContain("SSE再開はメタデータ限定");
    expect(streamableHttp?.detail).toContain("Context Pack本文は保存しません");
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

  it("summarizes document ingestion readiness without widening storage or AI send boundaries", () => {
    const disconnected = documentIngestionReadiness(false, null, false, null);

    expect(disconnected.find((item) => item.label === "PDF / DOCX等")?.state).toBe("ready");
    expect(disconnected.find((item) => item.label === "画像OCR")?.state).toBe("attention");
    expect(disconnected.find((item) => item.label === "画像OCR")?.detail).toContain("Source化せず");
    expect(disconnected.find((item) => item.label === "旧DOC / XLS / PPT")?.detail).toContain("Source化せず");

    const connected = documentIngestionReadiness(true, "Tesseract OCR", true, "LibreOffice");

    expect(connected.find((item) => item.label === "画像OCR")?.value).toBe("Tesseract OCR 接続済み");
    expect(connected.find((item) => item.label === "旧DOC / XLS / PPT")?.value).toBe("LibreOffice 接続済み");
    expect(connected.find((item) => item.label === "PDF / DOCX等")?.detail).toContain("Fact化とAI送信は別確認");
  });

  it("keeps the copy fallback starter available unless a pack is already selected", () => {
    expect(shouldShowCopyFallbackStarter([], null)).toBe(true);
    expect(shouldShowCopyFallbackStarter([{ id: "request_1" }], null)).toBe(true);
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

  it("summarizes the Context Pack delivery boundary without exposing raw content", () => {
    const pack: ContextPack = {
      id: "pack_1",
      requestId: "request_1",
      taskText: "来月の手続きを整理して",
      taskDomain: "routines_and_logistics",
      riskLevel: "medium",
      generatedAt: "2026-06-13T00:00:00.000Z",
      expiresAt: "2099-06-13T00:10:00.000Z",
      maxSensitivityIncluded: "sensitive",
      confirmationStatus: "pending_user_confirmation",
      items: [
        {
          id: "item_1",
          factId: "fact_1",
          itemText: "Approved fact text that may be sent",
          reasonIncluded: "Relevant to the user's task",
          sensitivity: "sensitive",
          sourceTitles: ["Insurance document"],
          confidence: "source_backed"
        }
      ],
      sourceSnippets: [
        {
          id: "snippet_1",
          sourceId: "source_1",
          title: "Insurance document",
          text: "Short approved snippet",
          sensitivity: "sensitive",
          reasonIncluded: "Evidence for the approved fact"
        }
      ],
      excludedItems: [
        {
          referencedId: "candidate_1",
          reason: "secret_never_send"
        },
        {
          referencedId: "raw_source_1",
          reason: "deleted"
        }
      ],
      warnings: []
    };
    const request: ContextPackRequest = {
      id: "request_1",
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "来月の手続きを整理して",
      purpose: "planning",
      requestedDomains: ["routines_and_logistics"],
      sensitivityCeiling: "sensitive",
      approvalMode: "always_review",
      createdAt: "2026-06-13T00:00:00.000Z",
      expiresAt: "2099-06-13T00:10:00.000Z",
      status: "pending_user_confirmation"
    };

    const receipt = contextPackBoundaryReceipt(pack, request);

    expect(receipt.find((item) => item.label === "AIに渡る")?.value).toBe("1 Facts / 1 snippets");
    expect(receipt.find((item) => item.label === "AIに渡る")?.detail).toContain("ChatGPT");
    expect(receipt.find((item) => item.label === "AIに渡らない")?.value).toBe("2 exclusions");
    expect(receipt.find((item) => item.label === "AIに渡らない")?.detail).toContain("送信禁止");
    expect(receipt.find((item) => item.label === "確認状態")?.tone).toBe("attention");
    expect(receipt.find((item) => item.label === "確認状態")?.detail).toContain("承認するまでPack本文");
    expect(JSON.stringify(receipt)).not.toContain("Approved fact text that may be sent");
    expect(JSON.stringify(receipt)).not.toContain("Short approved snippet");

    const noApprovalRequired = contextPackBoundaryReceipt(
      { ...pack, confirmationStatus: "not_required" },
      { ...request, status: "approved" }
    );

    expect(noApprovalRequired.find((item) => item.label === "確認状態")?.value).toBe("確認不要");
    expect(noApprovalRequired.find((item) => item.label === "確認状態")?.detail).toContain("返却またはコピーするまでPack本文");
    expect(
      contextPackDeliveryState(
        { ...pack, confirmationStatus: "not_required" },
        { ...request, status: "approved" },
        Date.parse("2026-06-13T00:05:00.000Z")
      )
    ).toMatchObject({
      canDeliver: false,
      closed: false,
      expired: false,
      confirmed: false,
      requiresApproval: false,
      awaitingReturn: true
    });

    const confirmed = contextPackBoundaryReceipt(
      { ...pack, confirmationStatus: "confirmed", expiresAt: "2000-01-01T00:00:00.000Z" },
      { ...request, status: "fulfilled", expiresAt: "2000-01-01T00:00:00.000Z" }
    );

    expect(confirmed.find((item) => item.label === "確認状態")?.tone).toBe("attention");
    expect(confirmed.find((item) => item.label === "確認状態")?.value).toBe("期限切れ");
    expect(confirmed.find((item) => item.label === "有効期限")?.value).toBe("期限切れ");
  });

  it("treats expired fulfilled requests as not deliverable in UI state", () => {
    const nowMs = Date.parse("2026-06-13T12:00:00.000Z");
    const request: ContextPackRequest = {
      id: "request_expired",
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "期限切れPackを確認",
      purpose: "planning",
      requestedDomains: ["routines_and_logistics"],
      sensitivityCeiling: "personal",
      approvalMode: "always_review",
      createdAt: "2026-06-13T11:00:00.000Z",
      expiresAt: "2026-06-13T11:10:00.000Z",
      status: "fulfilled"
    };
    const pack: ContextPack = {
      id: "pack_expired",
      requestId: "request_expired",
      taskText: "期限切れPackを確認",
      taskDomain: "routines_and_logistics",
      riskLevel: "low",
      generatedAt: "2026-06-13T11:00:00.000Z",
      expiresAt: "2026-06-13T11:10:00.000Z",
      maxSensitivityIncluded: "personal",
      confirmationStatus: "confirmed",
      items: [],
      excludedItems: [],
      warnings: []
    };

    expect(effectiveRequestStatus(request, nowMs)).toBe("expired");
    expect(contextPackDeliveryState(pack, request, nowMs)).toMatchObject({
      canDeliver: false,
      closed: true,
      expired: true,
      confirmed: true,
      requiresApproval: false,
      awaitingReturn: false
    });

    const receipt = contextPackBoundaryReceipt(pack, request, nowMs);

    expect(receipt.find((item) => item.label === "確認状態")?.value).toBe("期限切れ");
    expect(receipt.find((item) => item.label === "確認状態")?.detail).toContain("Pack本文を返しません");
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
    restored.contextPackRequests = [
      {
        id: "request_live",
        clientId: "conn_chatgpt",
        clientName: "ChatGPT",
        taskText: "A live restored request whose text should not appear in restore receipt",
        purpose: "planning",
        requestedDomains: ["contracts_and_policies"],
        sensitivityCeiling: "sensitive",
        approvalMode: "always_review",
        createdAt: "2099-06-10T00:00:00.000Z",
        expiresAt: "2099-06-10T00:10:00.000Z",
        status: "fulfilled"
      },
      {
        id: "request_expired_restore",
        clientId: "conn_chatgpt",
        clientName: "ChatGPT",
        taskText: "An expired restored request whose text should not appear in restore receipt",
        purpose: "planning",
        requestedDomains: ["contracts_and_policies"],
        sensitivityCeiling: "sensitive",
        approvalMode: "always_review",
        createdAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:10:00.000Z",
        status: "fulfilled"
      }
    ];
    restored.contextPacks = [
      {
        id: "pack_live",
        requestId: "request_live",
        taskText: "A live restored pack whose task should not appear in restore receipt",
        taskDomain: "contracts_and_policies",
        riskLevel: "medium",
        generatedAt: "2099-06-10T00:00:00.000Z",
        expiresAt: "2099-06-10T00:10:00.000Z",
        maxSensitivityIncluded: "sensitive",
        confirmationStatus: "confirmed",
        items: [
          {
            id: "item_live",
            factId: "fact_backup",
            itemText: "Restored pack body text must not appear in restore receipt.",
            reasonIncluded: "Relevant backup fact",
            sensitivity: "sensitive",
            sourceTitles: ["Backup insurance document"],
            confidence: "source_backed"
          }
        ],
        excludedItems: [],
        warnings: []
      },
      {
        id: "pack_expired_restore",
        requestId: "request_expired_restore",
        taskText: "An expired restored pack whose task should not appear in restore receipt",
        taskDomain: "contracts_and_policies",
        riskLevel: "medium",
        generatedAt: "2000-01-01T00:00:00.000Z",
        expiresAt: "2000-01-01T00:10:00.000Z",
        maxSensitivityIncluded: "sensitive",
        confirmationStatus: "confirmed",
        items: [],
        excludedItems: [],
        warnings: []
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
      requests: 2,
      packs: 2,
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
    expect(preview.aiBoundarySections.find((section) => section.label === "取得可能Pack")?.value).toBe("1件");
    expect(preview.aiBoundarySections.find((section) => section.label === "期限切れPack")?.value).toBe("1件");
    expect(preview.aiBoundarySections.find((section) => section.label === "AI接続メタデータ")?.detail).toContain(
      "Connections"
    );
    expect(preview.overwriteSections.find((section) => section.label === "生活コンテキスト")?.value).toContain(
      "1 Sources / 1 Facts -> 1 Sources / 1 Facts"
    );
    expect(JSON.stringify(preview)).not.toContain("must not appear");
    expect(JSON.stringify(preview)).not.toContain("Restored pack body text");
    expect(JSON.stringify(preview)).not.toContain("live restored request");
  });

  it("summarizes Vault clear impact without exposing stored body text", () => {
    const state = createEmptyVault();
    state.sources = [
      {
        id: "source_clear",
        kind: "document",
        title: "Clear impact source",
        origin: "user_upload",
        body: "Source body that must not appear in the clear impact receipt.",
        createdAt: "2026-06-13T00:00:00.000Z",
        capturedAt: "2026-06-13T00:00:00.000Z",
        defaultSensitivity: "sensitive",
        processingStatus: "ready",
        deletionState: "active"
      }
    ];
    state.facts = [
      {
        id: "fact_clear",
        factText: "Fact text that must not appear in the clear impact receipt.",
        domain: "documents_and_evidence",
        factType: "document_reference",
        sourceIds: ["source_clear"],
        sensitivity: "sensitive",
        confidence: "source_backed",
        status: "active",
        createdAt: "2026-06-13T00:00:00.000Z",
        approvedAt: "2026-06-13T00:00:00.000Z",
        updatedAt: "2026-06-13T00:00:00.000Z",
        supersedesFactIds: []
      }
    ];
    state.contextPackRequests = [
      {
        id: "request_clear",
        clientId: "conn_chatgpt",
        clientName: "ChatGPT",
        taskText: "Request text that must not appear in the clear impact receipt.",
        purpose: "planning",
        requestedDomains: ["documents_and_evidence"],
        sensitivityCeiling: "sensitive",
        approvalMode: "always_review",
        createdAt: "2099-06-13T00:00:00.000Z",
        expiresAt: "2099-06-13T00:10:00.000Z",
        status: "fulfilled"
      }
    ];
    state.contextPacks = [
      {
        id: "pack_clear",
        requestId: "request_clear",
        taskText: "Pack task that must not appear in the clear impact receipt.",
        taskDomain: "documents_and_evidence",
        riskLevel: "medium",
        generatedAt: "2099-06-13T00:00:00.000Z",
        expiresAt: "2099-06-13T00:10:00.000Z",
        maxSensitivityIncluded: "sensitive",
        confirmationStatus: "confirmed",
        items: [
          {
            id: "item_clear",
            factId: "fact_clear",
            itemText: "Pack body that must not appear in the clear impact receipt.",
            reasonIncluded: "Relevant",
            sensitivity: "sensitive",
            sourceTitles: ["Clear impact source"],
            confidence: "source_backed"
          }
        ],
        excludedItems: [],
        warnings: []
      }
    ];
    state.connectorSessions = [
      {
        id: "conn_chatgpt",
        clientKind: "chatgpt",
        clientName: "ChatGPT",
        transport: "remote_mcp_relay",
        oauthSubject: "oauth_subject_hash",
        scopes: ["context_pack.request"],
        status: "connected",
        createdAt: "2026-06-13T00:00:00.000Z",
        lastUsedAt: "2026-06-13T00:00:00.000Z"
      }
    ];
    state.auditEvents = [
      {
        id: "audit_clear",
        eventType: "context_pack_delivered",
        actor: "user",
        subjectType: "context_pack",
        subjectId: "pack_clear",
        occurredAt: "2026-06-13T00:00:00.000Z",
        sensitivity: "sensitive",
        metadata: {
          clientName: "ChatGPT",
          itemCount: 1
        }
      }
    ];

    const sections = clearVaultImpactSections(state);

    expect(sections.find((section) => section.label === "生活コンテキスト")?.value).toContain("1 Sources / 1 Facts");
    expect(sections.find((section) => section.label === "AI境界")?.detail).toContain("1件の取得可能Pack");
    expect(sections.find((section) => section.label === "AI接続とPolicy")?.detail).toContain("外部サービス側");
    expect(sections.find((section) => section.label === "Audit / Capture")?.detail).toContain("AI配達");
    expect(JSON.stringify(sections)).not.toContain("Source body that must not appear");
    expect(JSON.stringify(sections)).not.toContain("Fact text that must not appear");
    expect(JSON.stringify(sections)).not.toContain("Pack body that must not appear");
    expect(JSON.stringify(sections)).not.toContain("Request text that must not appear");
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
        contextPacks: [],
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
        confirmAllCapturePurge: false,
        cancelAllCapturePurge: noop,
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

    const confirmHtml = renderToStaticMarkup(
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
        contextPacks: [],
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
        confirmAllCapturePurge: true,
        cancelAllCapturePurge: noop,
        seedDemo: noop,
        goInbox: noop,
        goSources: noop,
        goRequests: noop,
        goConnections: noop
      })
    );

    expect(confirmHtml).toContain("1件のCapture本文を消去します");
    expect(confirmHtml).toContain("Raw transcript本文だけを消去します");
    expect(confirmHtml).toContain("確認して全本文を消去");
  });

  it("prioritizes a first Context Pack trial before MCP setup once facts are approved", () => {
    expect(
      homeNextActionKind({
        candidateCount: 0,
        backgroundStarted: true,
        approvedFactCount: 2,
        pendingRequestCount: 0,
        deliverablePackCount: 0,
        aiAccessReady: false
      })
    ).toBe("try_context_pack");
    expect(
      homeNextActionKind({
        candidateCount: 0,
        backgroundStarted: true,
        approvedFactCount: 2,
        pendingRequestCount: 0,
        deliverablePackCount: 0,
        aiAccessReady: false
      })
    ).toBe("try_context_pack");
    expect(
      homeNextActionKind({
        candidateCount: 0,
        backgroundStarted: true,
        approvedFactCount: 2,
        pendingRequestCount: 0,
        deliverablePackCount: 1,
        aiAccessReady: false
      })
    ).toBe("connect_ai");
    expect(
      homeNextActionKind({
        candidateCount: 1,
        backgroundStarted: true,
        approvedFactCount: 2,
        pendingRequestCount: 0,
        deliverablePackCount: 0,
        aiAccessReady: false
      })
    ).toBe("review_candidates");
    expect(
      homeNextActionKind({
        candidateCount: 0,
        backgroundStarted: true,
        approvedFactCount: 0,
        pendingRequestCount: 0,
        deliverablePackCount: 0,
        aiAccessReady: false
      })
    ).toBe("add_background");
  });

  it("summarizes the Home AI boundary without exposing stored context text", () => {
    const nowMs = Date.parse("2026-06-13T12:00:00.000Z");
    const facts = [
      { status: "active" as const, factText: "Approved fact text must stay out of the Home boundary receipt." },
      { status: "needs_review" as const, factText: "Review fact text must stay out of the Home boundary receipt." }
    ];
    const candidates = [
      { status: "new" as const, proposedFactText: "Candidate text must stay out of the Home boundary receipt." }
    ];
    const requests = [
      {
        id: "request_ready",
        status: "fulfilled" as const,
        expiresAt: "2026-06-13T12:10:00.000Z",
        taskText: "Ready request text must stay out of the Home boundary receipt."
      },
      {
        id: "request_pending",
        status: "pending_user_confirmation" as const,
        expiresAt: "2026-06-13T12:10:00.000Z",
        taskText: "Pending request text must stay out of the Home boundary receipt."
      },
      {
        id: "request_expired",
        status: "fulfilled" as const,
        expiresAt: "2026-06-13T11:00:00.000Z",
        taskText: "Expired request text must stay out of the Home boundary receipt."
      }
    ];
    const contextPacks = [
      {
        requestId: "request_ready",
        confirmationStatus: "confirmed" as const,
        expiresAt: "2026-06-13T12:10:00.000Z",
        taskText: "Ready pack text must stay out of the Home boundary receipt."
      },
      {
        requestId: "request_expired",
        confirmationStatus: "confirmed" as const,
        expiresAt: "2026-06-13T11:00:00.000Z",
        taskText: "Expired pack text must stay out of the Home boundary receipt."
      }
    ];

    const sections = homeAiBoundarySections({ facts, candidates, requests, contextPacks, nowMs });

    expect(sections.find((section) => section.label === "AIが使える正本")?.value).toBe("1 Facts");
    expect(sections.find((section) => section.label === "未承認で止める")?.value).toBe("1 candidates");
    expect(sections.find((section) => section.label === "確認/返却待ち")?.value).toBe("1 requests");
    expect(sections.find((section) => section.label === "AIへ返せるPack")?.value).toBe("1 ready");
    expect(sections.find((section) => section.label === "AIへ返せるPack")?.detail).toContain("期限切れPack");
    expect(JSON.stringify(sections)).not.toContain("Approved fact text");
    expect(JSON.stringify(sections)).not.toContain("Candidate text");
    expect(JSON.stringify(sections)).not.toContain("request text");
    expect(JSON.stringify(sections)).not.toContain("pack text");
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
        contextPacks: [],
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
        confirmAllCapturePurge: false,
        cancelAllCapturePurge: noop,
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
    expect(html).toContain("AI Boundary Today");
    expect(html).toContain("保存されたこととAIへ渡ること");
    expect(html).toContain("Sourceや候補だけではAIに渡る文脈になりません");
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
