import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  auditReceiptBody,
  clearVaultImpactSections,
  contextPackDeliveryState,
  contextPackBoundaryReceipt,
  documentIngestionReadiness,
  effectiveRequestStatus,
  factInventoryCounts,
  factSourceNames,
  homeAiBoundarySections,
  homeCaptureSafetySummary,
  makeRestorePreview,
  manualCopyPayloadForPack,
  shouldShowCopyFallbackStarter,
  sourceReviewCandidates,
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

describe("AI access UI safety", () => {

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
    expect(disconnected.find((item) => item.label === "画像OCR")?.detail).toContain("取り込めません");
    expect(disconnected.find((item) => item.label === "旧DOC / XLS / PPT")?.detail).toContain("取り込めません");

    const connected = documentIngestionReadiness(true, "Tesseract OCR", true, "LibreOffice");

    expect(connected.find((item) => item.label === "画像OCR")?.value).toBe("Tesseract OCR 接続済み");
    expect(connected.find((item) => item.label === "旧DOC / XLS / PPT")?.value).toBe("LibreOffice 接続済み");
    expect(connected.find((item) => item.label === "PDF / DOCX等")?.detail).toContain("承認とAI送信は別確認");
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
          confidence: "source_backed",
          sensitivityClassified: false,
          sensitivityConfidence: "low"
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

    expect(receipt.find((item) => item.label === "AIに渡る")?.value).toBe("1 件の記憶 / 1 snippets");
    expect(receipt.find((item) => item.label === "AIに渡る")?.detail).toContain("ChatGPT");
    expect(receipt.find((item) => item.label === "AIに渡らない")?.value).toBe("2 exclusions");
    expect(receipt.find((item) => item.label === "AIに渡らない")?.detail).toContain("非公開");
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
        supersedesFactIds: [],
        sensitivityClassified: false,
        sensitivityConfidence: "low"
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
        supersedesFactIds: [],
        sensitivityClassified: false,
        sensitivityConfidence: "low"
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
            confidence: "source_backed",
            sensitivityClassified: false,
            sensitivityConfidence: "low"
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
    expect(preview.sensitivitySummary).toBe("要確認");
    expect(preview.activeConnectorCount).toBe(1);
    expect(preview.pairedConnectorCount).toBe(1);
    expect(preview.expiredCaptureCount).toBe(1);
    expect(preview.promotedSourceCount).toBe(1);
    expect(preview.receiptSections.map((section) => section.label)).toContain("AI接続とポリシー");
    expect(preview.receiptSections.find((section) => section.label === "キャプチャ履歴")?.detail).toContain("TTL切れCapture");
    expect(preview.aiBoundarySections.find((section) => section.label === "取得可能Pack")?.value).toBe("1件");
    expect(preview.aiBoundarySections.find((section) => section.label === "期限切れPack")?.value).toBe("1件");
    expect(preview.aiBoundarySections.find((section) => section.label === "AI接続メタデータ")?.detail).toContain(
      "接続"
    );
    expect(preview.overwriteSections.find((section) => section.label === "生活コンテキスト")?.value).toContain(
      "1件のソース / 1件の記憶 -> 1件のソース / 1件の記憶"
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
        supersedesFactIds: [],
        sensitivityClassified: false,
        sensitivityConfidence: "low"
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
            confidence: "source_backed",
            sensitivityClassified: false,
            sensitivityConfidence: "low"
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

    expect(sections.find((section) => section.label === "生活コンテキスト")?.value).toContain("1件のソース / 1件の記憶");
    expect(sections.find((section) => section.label === "AI境界")?.detail).toContain("1件の取得可能Pack");
    expect(sections.find((section) => section.label === "AI接続とポリシー")?.detail).toContain("外部サービス側");
    expect(sections.find((section) => section.label === "監査 / キャプチャ")?.detail).toContain("AI配信");
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
    expect(summary.body).toContain("確認待ちの記憶");
    expect(summary.body).toContain("AIに渡した内容（記憶）の確認");
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
    expect(summary.title).toBe("受動キャプチャは停止中");
    expect(summary.body).toContain("書き込みません");
    expect(summary.allowedSitesLabel).toBe("未設定");
    expect(summary.purgeableCount).toBe(0);
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

    expect(sections.find((section) => section.label === "AIが使える正本")?.value).toBe("1 件の記憶");
    expect(sections.find((section) => section.label === "未承認で止める")?.value).toBe("1 candidates");
    expect(sections.find((section) => section.label === "確認/返却待ち")?.value).toBe("1 requests");
    expect(sections.find((section) => section.label === "AIへ返せるPack")?.value).toBe("1 ready");
    expect(sections.find((section) => section.label === "AIへ返せるPack")?.detail).toContain("期限切れPack");
    expect(JSON.stringify(sections)).not.toContain("Approved fact text");
    expect(JSON.stringify(sections)).not.toContain("Candidate text");
    expect(JSON.stringify(sections)).not.toContain("request text");
    expect(JSON.stringify(sections)).not.toContain("pack text");
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
    expect(body).toContain("2件の記憶");
    expect(body).toContain("取り込み元の原文と確認待ちの記憶は含めていません");
  });

});
