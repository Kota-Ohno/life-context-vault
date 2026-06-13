import { describe, expect, it } from "vitest";
import type { VaultState } from "./types";
import {
  addPassiveCaptureEvent,
  addSourceWithCandidates,
  approveCandidate,
  attachLocalAnswer,
  buildContextPack,
  buildContextPackForRequest,
  canSendContextPackToAi,
  confirmContextPack,
  createContextPackRequest,
  createEmptyVault,
  exportEncryptedBackup,
  importEncryptedBackup,
  makeAiContextPackPayload,
  normalizeVaultState,
  purgeExpiredPassiveCaptures,
  recordContextPackDelivery,
  searchFacts,
  updateAccessPolicy,
  updateContextPackItemVisibility,
  updateSourceBody,
  updateSourceMetadata
} from "./vault";

describe("vault flow", () => {
  it("creates candidates from a source without creating approved facts", () => {
    const state = addSourceWithCandidates(createEmptyVault(), {
      kind: "document",
      origin: "user_upload",
      title: "Renewal note",
      body: "Insurance policy renews on 2026-08-31. Need to update address before renewal."
    });

    expect(state.sources).toHaveLength(1);
    expect(state.candidates.length).toBeGreaterThan(0);
    expect(state.facts).toHaveLength(0);
    expect(state.candidates.some((candidate) => candidate.candidateType === "deadline")).toBe(true);
  });

  it("requires stronger backup passphrases and records KDF cost", async () => {
    const state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Backup note",
      body: "Preferred name: Kota"
    });

    await expect(exportEncryptedBackup(state, "short")).rejects.toThrow("12文字以上");
    const backup = await exportEncryptedBackup(state, "LongBackup-2026!");
    const payload = JSON.parse(backup) as { iterations: number; kdf: string };
    expect(payload.kdf).toBe("PBKDF2-SHA256");
    expect(payload.iterations).toBeGreaterThanOrEqual(600000);
    const restored = await importEncryptedBackup(backup, "LongBackup-2026!");

    expect(restored.sources[0].title).toBe("Backup note");
    expect(restored.candidates.length).toBeGreaterThan(0);
  });

  it("turns an approved candidate into a canonical fact", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Tone",
      body: "Tone preference: concise and calm"
    });
    const candidate = state.candidates[0];

    state = approveCandidate(state, candidate.id);

    expect(state.facts).toHaveLength(1);
    expect(state.facts[0].factText).toContain("Tone preference");
    expect(state.candidates[0].status).toBe("approved");
  });

  it("can approve a candidate as a replacement for an older fact", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Old policy note",
      body: "Insurance policy renews on 2026-08-31."
    });
    state = approveCandidate(state, state.candidates[0].id);
    const oldFactId = state.facts[0].id;
    const pack = buildContextPack(state, "What should I remember about insurance renewal?");
    state = savePackForTest(state, pack);

    state = addSourceWithCandidates(state, {
      kind: "manual_note",
      origin: "manual_entry",
      title: "New policy note",
      body: "Insurance policy renews on 2027-08-31."
    });
    state = approveCandidate(state, state.candidates[0].id, {
      supersedeFactIds: [oldFactId]
    });

    const newFact = state.facts[0];
    const oldFact = state.facts.find((fact) => fact.id === oldFactId)!;
    expect(newFact.supersedesFactIds).toEqual([oldFactId]);
    expect(oldFact.status).toBe("superseded");
    expect(oldFact.supersededByFactId).toBe(newFact.id);
    expect(state.contextPacks[0].confirmationStatus).toBe("cancelled");
    expect(searchFacts(state, "2026")).toEqual([]);
    expect(searchFacts(state, "2027")[0].id).toBe(newFact.id);
  });

  it("flags a new candidate that conflicts with an active fact", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Old policy note",
      body: "Insurance policy renews on 2026-08-31."
    });
    state = approveCandidate(state, state.candidates[0].id);
    const oldFactId = state.facts[0].id;

    state = addSourceWithCandidates(state, {
      kind: "manual_note",
      origin: "manual_entry",
      title: "New policy note",
      body: "Insurance policy renews on 2027-08-31."
    });

    expect(state.candidates[0].conflictWithFactIds).toEqual([oldFactId]);
    expect(state.candidates[0].conflictReason).toContain("既存のActive Fact");
    expect(state.candidates[0].status).toBe("new");
    expect(state.facts[0].status).toBe("active");
  });

  it("does not self-conflict when a source body re-extracts an approved fact", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Policy note",
      body: "Insurance policy renews on 2026-08-31."
    });
    state = approveCandidate(state, state.candidates[0].id);
    const sourceId = state.sources[0].id;

    state = updateSourceBody(state, sourceId, {
      body: "Insurance policy renews on 2027-08-31."
    });

    expect(state.facts[0].status).toBe("needs_review");
    expect(state.candidates[0].conflictWithFactIds).toEqual([]);
  });

  it("redacts secret values from source text and generated candidates", () => {
    const state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Secret note",
      body: "API key sk-test-12345 should not be stored.\nPassword hunter2"
    });

    expect(state.sources[0].body).not.toContain("sk-test-12345");
    expect(state.sources[0].body).not.toContain("hunter2");
    expect(state.sources[0].defaultSensitivity).toBe("secret_never_send");
    expect(state.candidates[0].proposedFactText).not.toContain("sk-test-12345");
    expect(state.candidates[0].proposedFactText).not.toContain("hunter2");
    expect(state.candidates[0].detectedSensitivity).toBe("secret_never_send");
    expect(state.candidates[0].status).toBe("blocked_sensitive");
    expect(state.facts).toHaveLength(0);
  });

  it("requires confirmation when context pack includes consequential private context", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "document",
      origin: "user_upload",
      title: "Insurance",
      body: "Insurance policy renews on 2026-08-31."
    });
    state = approveCandidate(state, state.candidates[0].id);

    const pack = buildContextPack(state, "What should I check before changing jobs?");

    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.maxSensitivityIncluded).toBe("private_consequential");
    expect(pack.confirmationStatus).toBe("pending_user_confirmation");
  });

  it("searches only approved facts", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Work",
      body: "Active life areas: work and learning"
    });

    expect(searchFacts(state, "work")).toHaveLength(0);

    state = approveCandidate(state, state.candidates[0].id);

    expect(searchFacts(state, "work")).toHaveLength(1);
  });

  it("creates a short-lived context pack from an AI client request", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Insurance",
      body: "Insurance policy renews on 2026-09-01. Need to update address before renewal."
    });
    state = approveCandidate(state, state.candidates[0].id);

    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me prepare before changing jobs",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);

    expect(built.pack?.requestId).toBe(requested.request.id);
    expect(built.pack?.expiresAt).toBe(requested.request.expiresAt);
    expect(built.pack?.items.length).toBeGreaterThan(0);
    expect(built.state.contextPackRequests[0].status).toBe("pending_user_confirmation");
  });

  it("applies client domain allowlist and approval threshold to context packs", () => {
    const base = createEmptyVault();
    const now = "2026-06-12T00:00:00.000Z";
    const state: VaultState = {
      ...base,
      facts: [
        {
          id: "fact_work_blocked",
          factText: "Work shift starts at 9am.",
          domain: "work_and_education",
          factType: "routine",
          sourceIds: [],
          sensitivity: "public",
          confidence: "source_backed",
          status: "active",
          createdAt: now,
          approvedAt: now,
          updatedAt: "2026-06-12T00:21:00.000Z",
          supersedesFactIds: []
        },
        {
          id: "fact_health_allowed",
          factText: "Doctor follow-up is scheduled for next month.",
          domain: "health_and_care",
          factType: "support_need",
          sourceIds: [],
          sensitivity: "personal",
          confidence: "source_backed",
          status: "active",
          createdAt: now,
          approvedAt: now,
          updatedAt: "2026-06-12T00:20:00.000Z",
          supersedesFactIds: []
        }
      ],
      accessPolicies: base.accessPolicies.map((policy) =>
        policy.clientId === "conn_chatgpt"
          ? {
              ...policy,
              domainAllowlist: ["health_and_care"],
              sensitivityCeiling: "sensitive",
              requiresApprovalAbove: "public"
            }
          : policy
      )
    };

    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me with the doctor follow-up and work shift",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);

    expect(built.pack?.items.some((item) => item.factId === "fact_health_allowed")).toBe(true);
    expect(
      built.pack?.excludedItems.some(
        (item) => item.referencedId === "fact_work_blocked" && item.reason === "domain_policy"
      )
    ).toBe(true);
    expect(built.pack?.confirmationStatus).toBe("pending_user_confirmation");
    expect(built.state.contextPackRequests[0].status).toBe("pending_user_confirmation");

    const restored = updateContextPackItemVisibility(
      built.state,
      built.pack!.id,
      "fact_work_blocked",
      true
    );
    const restoredPack = restored.contextPacks.find((pack) => pack.id === built.pack!.id)!;
    expect(restoredPack.items.some((item) => item.factId === "fact_work_blocked")).toBe(false);
    expect(
      restoredPack.excludedItems.some(
        (item) => item.referencedId === "fact_work_blocked" && item.reason === "domain_policy"
      )
    ).toBe(true);
  });

  it("fails closed for invalid policy sensitivity values and request widening", () => {
    const base = createEmptyVault();
    const now = "2026-06-12T00:00:00.000Z";
    const facts: VaultState["facts"] = [
      {
        id: "fact_public",
        factText: "Preferred display name is Kota.",
        domain: "identity_and_profile",
        factType: "identity",
        sourceIds: [],
        sensitivity: "public",
        confidence: "source_backed",
        status: "active",
        createdAt: now,
        approvedAt: now,
        updatedAt: "2026-06-12T00:20:00.000Z",
        supersedesFactIds: []
      },
      {
        id: "fact_personal",
        factText: "Doctor follow-up is scheduled for next month.",
        domain: "health_and_care",
        factType: "support_need",
        sourceIds: [],
        sensitivity: "personal",
        confidence: "source_backed",
        status: "active",
        createdAt: now,
        approvedAt: now,
        updatedAt: "2026-06-12T00:21:00.000Z",
        supersedesFactIds: []
      },
      {
        id: "fact_sensitive",
        factText: "Sensitive care plan should stay tightly controlled.",
        domain: "health_and_care",
        factType: "support_need",
        sourceIds: [],
        sensitivity: "sensitive",
        confidence: "source_backed",
        status: "active",
        createdAt: now,
        approvedAt: now,
        updatedAt: "2026-06-12T00:22:00.000Z",
        supersedesFactIds: []
      }
    ];
    const limitedState: VaultState = {
      ...base,
      facts,
      accessPolicies: base.accessPolicies.map((policy) =>
        policy.clientId === "conn_chatgpt"
          ? {
              ...policy,
              sensitivityCeiling: "personal",
              requiresApprovalAbove: "not_a_tier" as typeof policy.requiresApprovalAbove
            }
          : policy
      )
    };

    const widenedRequest = createContextPackRequest(limitedState, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help with my doctor follow-up and care plan",
      sensitivityCeiling: "sensitive"
    });
    const widenedPack = buildContextPackForRequest(
      widenedRequest.state,
      widenedRequest.request.id
    ).pack!;

    expect(widenedRequest.request.sensitivityCeiling).toBe("personal");
    expect(widenedPack.items.some((item) => item.factId === "fact_personal")).toBe(true);
    expect(widenedPack.excludedItems).toContainEqual({
      referencedId: "fact_sensitive",
      reason: "sensitivity_policy"
    });
    expect(widenedPack.confirmationStatus).toBe("pending_user_confirmation");

    const invalidCeilingState: VaultState = {
      ...base,
      facts,
      accessPolicies: base.accessPolicies.map((policy) =>
        policy.clientId === "conn_chatgpt"
          ? {
              ...policy,
              sensitivityCeiling: "not_a_tier" as typeof policy.sensitivityCeiling
            }
          : policy
      )
    };
    const invalidRequest = createContextPackRequest(invalidCeilingState, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help with my doctor follow-up"
    });
    const invalidPack = buildContextPackForRequest(invalidRequest.state, invalidRequest.request.id).pack!;

    expect(invalidRequest.request.sensitivityCeiling).toBe("public");
    expect(invalidPack.items.some((item) => item.factId === "fact_public")).toBe(true);
    expect(invalidPack.items.some((item) => item.factId === "fact_personal")).toBe(false);
    expect(invalidPack.excludedItems).toContainEqual({
      referencedId: "fact_personal",
      reason: "sensitivity_policy"
    });
  });

  it("updates client domain allowlists without accepting empty or unknown domains", () => {
    const state = createEmptyVault();
    const updated = updateAccessPolicy(state, "conn_chatgpt", {
      domainAllowlist: [
        "health_and_care",
        "documents_and_evidence",
        "health_and_care"
      ]
    });
    const policy = updated.accessPolicies.find((policy) => policy.clientId === "conn_chatgpt")!;

    expect(policy.domainAllowlist).toEqual(["health_and_care", "documents_and_evidence"]);
    expect(updated.auditEvents[0].metadata?.domainAllowlistCount).toBe(2);

    const unchanged = updateAccessPolicy(updated, "conn_chatgpt", {
      domainAllowlist: [] as VaultState["accessPolicies"][number]["domainAllowlist"]
    });
    expect(unchanged.accessPolicies.find((item) => item.clientId === "conn_chatgpt")?.domainAllowlist).toEqual([
      "health_and_care",
      "documents_and_evidence"
    ]);

    const unknownIgnored = updateAccessPolicy(updated, "conn_chatgpt", {
      domainAllowlist: ["not_a_domain" as VaultState["accessPolicies"][number]["domainAllowlist"][number]]
    });
    expect(unknownIgnored.accessPolicies.find((item) => item.clientId === "conn_chatgpt")?.domainAllowlist).toEqual([
      "health_and_care",
      "documents_and_evidence"
    ]);

    const mixedInvalidIgnored = updateAccessPolicy(updated, "conn_chatgpt", {
      domainAllowlist: [
        "health_and_care",
        "not_a_domain" as VaultState["accessPolicies"][number]["domainAllowlist"][number]
      ]
    });
    expect(
      mixedInvalidIgnored.accessPolicies.find((item) => item.clientId === "conn_chatgpt")?.domainAllowlist
    ).toEqual(["health_and_care", "documents_and_evidence"]);
  });

  it("invalidates client context packs when the AI access policy changes", () => {
    const base = createEmptyVault();
    const now = "2026-06-12T00:00:00.000Z";
    const state: VaultState = {
      ...base,
      facts: [
        {
          id: "fact_health",
          factText: "Doctor follow-up is scheduled for next month.",
          domain: "health_and_care",
          factType: "support_need",
          sourceIds: [],
          sensitivity: "personal",
          confidence: "source_backed",
          status: "active",
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: []
        },
        {
          id: "fact_work",
          factText: "Work shift starts at 9am.",
          domain: "work_and_education",
          factType: "routine",
          sourceIds: [],
          sensitivity: "public",
          confidence: "source_backed",
          status: "active",
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: []
        }
      ]
    };
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me with the doctor follow-up and work shift",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);

    expect(built.pack?.items.some((item) => item.factId === "fact_work")).toBe(true);

    const tightened = updateAccessPolicy(built.state, "conn_chatgpt", {
      domainAllowlist: ["health_and_care"]
    });
    const cancelledPack = tightened.contextPacks.find((pack) => pack.id === built.pack!.id)!;
    const expiredRequest = tightened.contextPackRequests.find((request) => request.id === requested.request.id)!;

    expect(cancelledPack.confirmationStatus).toBe("cancelled");
    expect(expiredRequest.status).toBe("expired");
    expect(tightened.auditEvents[0].metadata?.invalidatedPackCount).toBe(1);
    expect(canSendContextPackToAi(tightened, cancelledPack)).toBe(false);

    const confirmed = confirmContextPack(tightened, built.pack!.id);
    expect(confirmed.contextPacks.find((pack) => pack.id === built.pack!.id)?.confirmationStatus).toBe("cancelled");
  });

  it("fails closed when a persisted access policy has an empty domain allowlist", () => {
    const base = createEmptyVault();
    const now = "2026-06-12T00:00:00.000Z";
    const normalized = normalizeVaultState({
      ...base,
      facts: [
        {
          id: "fact_health",
          factText: "Doctor follow-up is scheduled for next month.",
          domain: "health_and_care",
          factType: "support_need",
          sourceIds: [],
          sensitivity: "personal",
          confidence: "source_backed",
          status: "active",
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: []
        }
      ],
      accessPolicies: base.accessPolicies.map((policy) =>
        policy.clientId === "conn_chatgpt" ? { ...policy, domainAllowlist: [] } : policy
      )
    });
    const requested = createContextPackRequest(normalized, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me with the doctor follow-up",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);

    expect(
      built.pack?.excludedItems.some(
        (item) => item.referencedId === "fact_health" && item.reason === "domain_policy"
      )
    ).toBe(true);
    expect(built.pack?.items.some((item) => item.factId === "fact_health")).toBe(false);
  });

  it("confirms a context pack for external AI without generating a local answer", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Benefits",
      body: "Disability benefit documents should be checked before changing jobs."
    });
    state = approveCandidate(state, state.candidates[0].id);

    const requested = createContextPackRequest(state, {
      clientId: "conn_claude_desktop",
      clientName: "Claude Desktop",
      taskText: "Help me prepare before changing jobs",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    expect(built.pack).toBeTruthy();

    const confirmed = confirmContextPack(built.state, built.pack!.id);
    const confirmedPack = confirmed.contextPacks.find((pack) => pack.id === built.pack!.id);
    const confirmedRequest = confirmed.contextPackRequests.find(
      (request) => request.id === requested.request.id
    );

    expect(confirmedPack?.confirmationStatus).toBe("confirmed");
    expect(confirmedPack?.confirmedAt).toBeTruthy();
    expect(confirmedPack?.localAnswer).toBeUndefined();
    expect(confirmedRequest?.status).toBe("fulfilled");
    expect(confirmed.auditEvents[0]).toMatchObject({
      eventType: "context_pack_confirmed",
      sensitivity: built.pack!.maxSensitivityIncluded
    });
  });

  it("revalidates current fact state before allowing a confirmed pack to be sent", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Passport note",
      body: "Passport expires on 2028-05-01."
    });
    state = approveCandidate(state, state.candidates[0].id);
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "When does my passport expire?",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    const confirmed = confirmContextPack(built.state, built.pack!.id);
    const confirmedPack = confirmed.contextPacks.find((pack) => pack.id === built.pack!.id)!;

    expect(canSendContextPackToAi(confirmed, confirmedPack)).toBe(true);

    const hiddenFactState: VaultState = {
      ...confirmed,
      facts: confirmed.facts.map((fact) =>
        fact.id === confirmedPack.items[0].factId ? { ...fact, status: "user_hidden" } : fact
      )
    };
    expect(canSendContextPackToAi(hiddenFactState, confirmedPack)).toBe(false);

    const staleTextState: VaultState = {
      ...confirmed,
      facts: confirmed.facts.map((fact) =>
        fact.id === confirmedPack.items[0].factId
          ? { ...fact, factText: "Passport expires on 2029-05-01.", updatedAt: new Date().toISOString() }
          : fact
      )
    };
    expect(canSendContextPackToAi(staleTextState, confirmedPack)).toBe(false);
  });

  it("records an AI delivery receipt without pack or raw source body text", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Passport note",
      body: "Passport expires on 2028-05-01.\nUnrelated source-only detail: blue folders stay in the closet."
    });
    const passportCandidate = state.candidates.find((candidate) =>
      candidate.proposedFactText.includes("Passport expires")
    );
    expect(passportCandidate).toBeTruthy();
    state = approveCandidate(state, passportCandidate!.id);
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "When should I renew my passport?",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    state = confirmContextPack(built.state, built.pack!.id);
    state = recordContextPackDelivery(state, built.pack!.id, {
      channel: "clipboard_copy",
      status: "copied"
    });

    const event = state.auditEvents[0];
    const metadata = JSON.stringify(event.metadata);
    expect(event).toMatchObject({
      eventType: "context_pack_delivered",
      subjectType: "context_pack",
      sensitivity: built.pack!.maxSensitivityIncluded
    });
    expect(event.metadata).toMatchObject({
      clientName: "ChatGPT",
      deliveryChannel: "clipboard_copy",
      deliveryStatus: "copied",
      itemCount: 1,
      includedDomains: ["documents_and_evidence"],
      trustBoundary: "ContextPack only",
      bodyStoredInAudit: false,
      rawSourceIncluded: false,
      unapprovedCandidateIncluded: false
    });
    expect(metadata).not.toContain("Passport expires on 2028-05-01");
    expect(metadata).not.toContain("blue folders");
  });

  it("creates an AI-bound context pack payload without internal response fields", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Tone",
      body: "Tone preference: concise and calm"
    });
    state = approveCandidate(state, state.candidates[0].id);
    const pack = buildContextPack(state, "Draft a message in my preferred tone");
    state = savePackForTest(state, pack);
    state = attachLocalAnswer(state, pack.id, "Local-only answer body");

    const savedPack = state.contextPacks.find((item) => item.id === pack.id)!;
    const payload = makeAiContextPackPayload(savedPack);

    expect(payload.trustBoundary).toBe("ContextPack only");
    expect(payload.items).toHaveLength(1);
    expect("localAnswer" in payload).toBe(false);
    expect("auditEventId" in payload).toBe(false);
  });

  it("does not include unapproved passive capture candidates in context packs", () => {
    let state = createEmptyVault();
    state = {
      ...state,
      passiveCaptureSettings: { ...state.passiveCaptureSettings, enabled: true }
    };
    state = addPassiveCaptureEvent(state, {
      sourceClient: "chatgpt",
      conversationId: "thread-1",
      url: "https://chatgpt.com/c/thread-1",
      text: "I am moving next month and need to remember utility address changes."
    });

    expect(state.candidates.length).toBeGreaterThan(0);
    expect(state.facts).toHaveLength(0);

    const pack = buildContextPack(state, "What should I update before moving?");

    expect(pack.items).toHaveLength(0);
  });

  it("does not leak raw source body into context pack source snippets", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Preferences",
      body: "Tone preference: concise and calm\nUnrelated note: I dislike morning errands."
    });
    const toneCandidate = state.candidates.find((candidate) =>
      candidate.proposedFactText.includes("Tone preference")
    );
    expect(toneCandidate).toBeTruthy();
    state = approveCandidate(state, toneCandidate!.id);

    const pack = buildContextPack(state, "Draft a message in my preferred tone");

    expect(pack.sourceSnippets?.[0]?.text).toBe(state.facts[0].factText);
    expect(pack.sourceSnippets?.[0]?.text).not.toContain("morning errands");
  });

  it("updates source metadata without leaking secret source titles to context packs", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Lease note",
      body: "Need to renew lease by 2027-01-15."
    });
    state = approveCandidate(state, state.candidates[0].id);
    const pack = buildContextPack(state, "What should I remember about lease renewal?");
    state = savePackForTest(state, pack);

    state = updateSourceMetadata(state, state.sources[0].id, {
      title: "Private password file",
      defaultSensitivity: "secret_never_send"
    });
    const rebuilt = buildContextPack(state, "What should I remember about lease renewal?");

    expect(state.sources[0].title).toBe("Private password file");
    expect(state.contextPacks[0].confirmationStatus).toBe("cancelled");
    expect(state.contextPacks[0].warnings[0].kind).toBe("stale_fact");
    expect(rebuilt.items[0].sourceTitles).toEqual([]);
    expect(rebuilt.sourceSnippets).toEqual([]);
  });

  it("re-extracts source body into candidates and moves linked facts back to review", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Lease note",
      body: "Need to renew lease by 2027-01-15."
    });
    state = approveCandidate(state, state.candidates[0].id);
    const pack = buildContextPack(state, "What should I remember about lease renewal?");
    state = savePackForTest(state, pack);

    state = updateSourceBody(state, state.sources[0].id, {
      body: "Need to update utility contract by 2027-02-01."
    });

    expect(state.sources[0].body).toContain("utility contract");
    expect(state.facts[0].status).toBe("needs_review");
    expect(state.facts[0].reviewReason).toBe("source_updated");
    expect(state.contextPacks[0].confirmationStatus).toBe("cancelled");
    expect(state.contextPacks[0].warnings[0].kind).toBe("stale_fact");
    expect(state.candidates.some((candidate) => candidate.proposedFactText.includes("utility contract"))).toBe(true);
    expect(searchFacts(state, "lease")).toEqual([]);
  });

  it("lets users minimize a context pack before it leaves to AI", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Planning notes",
      body: "Need to renew library card by 2027-01-10.\nNeed to renew apartment lease by 2027-01-15."
    });
    const publicCandidate = state.candidates.find((candidate) => candidate.proposedFactText.includes("library"))!;
    const privateCandidate = state.candidates.find((candidate) => candidate.proposedFactText.includes("lease"))!;
    state = approveCandidate(state, publicCandidate.id);
    state = approveCandidate(state, privateCandidate.id);

    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me plan renewals this month",
      approvalMode: "always_review"
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    state = built.state;
    const pack = built.pack!;
    const privateFactId = state.facts.find((fact) => fact.factText.includes("lease"))!.id;

    state = updateContextPackItemVisibility(state, pack.id, privateFactId, false);
    const minimizedPack = state.contextPacks.find((item) => item.id === pack.id)!;
    const payload = makeAiContextPackPayload(minimizedPack);

    expect(minimizedPack.confirmationStatus).toBe("edited_by_user");
    expect(minimizedPack.items.some((item) => item.factId === privateFactId)).toBe(false);
    expect(minimizedPack.excludedItems).toContainEqual({
      referencedId: privateFactId,
      reason: "user_hidden"
    });
    expect(minimizedPack.maxSensitivityIncluded).toBe("public");
    expect(minimizedPack.warnings.some((warning) => warning.kind === "sensitive_context")).toBe(false);
    expect(payload.excludedItems).toContainEqual({ reason: "user_hidden" });
    expect(JSON.stringify(payload)).not.toContain(privateFactId);
    expect(JSON.stringify(payload)).not.toContain("apartment lease");
  });

  it("purges expired passive capture source text without deleting review history", () => {
    let state = createEmptyVault();
    state = {
      ...state,
      passiveCaptureSettings: { ...state.passiveCaptureSettings, enabled: true, retentionDays: 1 }
    };
    state = addPassiveCaptureEvent(state, {
      sourceClient: "claude_remote",
      conversationId: "thread-2",
      url: "https://claude.ai/chat/thread-2",
      text: "Tone preference: very concise"
    });
    const sourceId = state.passiveCaptureEvents[0].sourceId;

    const purged = purgeExpiredPassiveCaptures(
      state,
      new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
    );

    expect(purged.sources.find((source) => source.id === sourceId)?.body).toBe("[PURGED_PASSIVE_CAPTURE]");
    expect(purged.passiveCaptureEvents[0].processingStatus).toBe("purged");
    expect(purged.candidates.length).toBeGreaterThan(0);
  });

  it("exports encrypted backups with a stronger KDF and rejects weak passphrases", async () => {
    const state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Backup note",
      body: "Backup should include life context only after local encryption."
    });

    await expect(exportEncryptedBackup(state, "short")).rejects.toThrow("12文字以上");

    const backup = await exportEncryptedBackup(state, "StrongPassphrase1!");
    const payload = JSON.parse(backup) as { iterations: number; cipherText: string };
    const restored = await importEncryptedBackup(backup, "StrongPassphrase1!");

    expect(payload.iterations).toBe(600000);
    expect(payload.cipherText).not.toContain("Backup should include");
    expect(restored.sources[0].title).toBe("Backup note");
  });

  it("imports legacy encrypted backups that omitted the iteration count", async () => {
    const state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Legacy backup note",
      body: "Legacy backup import should remain compatible."
    });
    const backup = await makeEncryptedBackupForTest(state, "LegacyPassphrase1!", 120000, false);

    const restored = await importEncryptedBackup(backup, "LegacyPassphrase1!");

    expect(restored.sources[0].title).toBe("Legacy backup note");
    expect(restored.sources[0].body).toContain("Legacy backup import");
  });
});

function savePackForTest(state: ReturnType<typeof createEmptyVault>, pack: ReturnType<typeof buildContextPack>) {
  return {
    ...state,
    contextPacks: [pack, ...state.contextPacks]
  };
}

async function makeEncryptedBackupForTest(
  state: VaultState,
  passphrase: string,
  iterations: number,
  includeIterations: boolean
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKeyForTest(passphrase, salt, iterations);
  const encoded = new TextEncoder().encode(JSON.stringify(state));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: typedArrayBuffer(iv) },
    key,
    encoded
  );
  const payload: Record<string, unknown> = {
    version: 1,
    kdf: "PBKDF2-SHA256",
    salt: bytesToBase64ForTest(salt),
    iv: bytesToBase64ForTest(iv),
    cipherText: bytesToBase64ForTest(new Uint8Array(cipher))
  };
  if (includeIterations) payload.iterations = iterations;
  return JSON.stringify(payload);
}

async function deriveBackupKeyForTest(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: typedArrayBuffer(salt),
      iterations,
      hash: "SHA-256"
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function typedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64ForTest(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
