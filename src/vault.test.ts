import { describe, expect, it } from "vitest";
import type { VaultState } from "./types";
import {
  addPassiveCaptureEvent,
  addSourceWithCandidates,
  approveCandidate,
  attachLocalAnswer,
  buildContextPack,
  buildContextPackForRequest,
  buildActivityTimeline,
  canSendContextPackToAi,
  confirmContextPack,
  createContextPackRequest,
  createEmptyVault,
  domainLabel,
  exportApprovedFactsMarkdown,
  factsByDomain,
  exportEncryptedBackup,
  importEncryptedBackup,
  makeAiContextPackPayload,
  normalizeVaultState,
  purgeExpiredPassiveCaptures,
  recordContextPackDelivery,
  searchFacts,
  updateAccessPolicy,
  updateContextPackItemVisibility,
  updateFactMetadata,
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
          sensitivityClassified: false,
          sensitivityConfidence: "low",
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
          sensitivityClassified: false,
          sensitivityConfidence: "low",
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
        sensitivityClassified: false,
        sensitivityConfidence: "low",
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
        sensitivityClassified: false,
        sensitivityConfidence: "low",
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
        sensitivityClassified: false,
        sensitivityConfidence: "low",
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
          sensitivityClassified: false,
          sensitivityConfidence: "low",
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
          sensitivityClassified: false,
          sensitivityConfidence: "low",
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
          sensitivityClassified: false,
          sensitivityConfidence: "low",
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

  it("delivers an approved fact within the client ceiling even when its source default sensitivity is higher", () => {
    const base = createEmptyVault();
    const now = "2026-06-12T00:00:00.000Z";
    const normalized = normalizeVaultState({
      ...base,
      sources: [
        {
          id: "src_cautious",
          kind: "background_onboarding",
          title: "Guided background setup",
          origin: "guided_onboarding",
          body: "Recurring constraints, with an incidental mention of health.",
          createdAt: now,
          capturedAt: now,
          defaultSensitivity: "sensitive",
          processingStatus: "ready",
          deletionState: "active"
        }
      ],
      facts: [
        {
          id: "fact_constraint",
          sensitivityClassified: false,
          sensitivityConfidence: "low",
          factText: "Recurring constraints: weekday time is limited.",
          domain: "constraints_and_accessibility",
          factType: "constraint",
          sourceIds: ["src_cautious"],
          sensitivity: "personal",
          confidence: "source_backed",
          status: "active",
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: []
        }
      ]
    });
    const requested = createContextPackRequest(normalized, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me plan my week",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);

    // The approved fact's own sensitivity (personal) is within the ChatGPT ceiling
    // (private_consequential), so the build must include it.
    expect(built.pack?.items.some((item) => item.factId === "fact_constraint")).toBe(true);

    // Confirming must succeed and the pack must stay deliverable: the source's cautious
    // default sensitivity must NOT override the user's explicit fact-level approval at
    // delivery time. Regression guard for the "承認ができない" pack-approval bug.
    const confirmed = confirmContextPack(built.state, built.pack!.id);
    const confirmedPack = confirmed.contextPacks.find((pack) => pack.id === built.pack!.id)!;
    expect(confirmedPack.confirmationStatus).toBe("confirmed");
    expect(canSendContextPackToAi(confirmed, confirmedPack)).toBe(true);
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

  it("standing-delivery opt-in governs whether a personal-tier pack auto-delivers", () => {
    const base = createEmptyVault();
    const now = "2026-06-12T00:00:00.000Z";
    const withFact = normalizeVaultState({
      ...base,
      facts: [{
        id: "fact_name", factText: "Preferred name: Kota", domain: "identity_and_profile",
        factType: "identity", sourceIds: [], sensitivity: "personal", confidence: "inferred_and_confirmed",
        status: "active", createdAt: now, approvedAt: now, updatedAt: now, supersedesFactIds: [],
        sensitivityClassified: true, sensitivityConfidence: "high"
      }]
    });
    const enabled = {
      ...withFact,
      accessPolicies: withFact.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt" ? { ...p, standingDeliveryEnabled: true } : p)
    };
    const r1 = createContextPackRequest(enabled, { clientId: "conn_chatgpt", clientName: "ChatGPT", taskText: "name?", ttlMinutes: 10 });
    const b1 = buildContextPackForRequest(r1.state, r1.request.id);
    expect(b1.pack?.confirmationStatus).toBe("not_required");

    const disabled = {
      ...withFact,
      accessPolicies: withFact.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt" ? { ...p, standingDeliveryEnabled: false } : p)
    };
    const r2 = createContextPackRequest(disabled, { clientId: "conn_chatgpt", clientName: "ChatGPT", taskText: "name?", ttlMinutes: 10 });
    const b2 = buildContextPackForRequest(r2.state, r2.request.id);
    expect(b2.pack?.confirmationStatus).toBe("pending_user_confirmation");
  });

  // ── buildActivityTimeline ─────────────────────────────────────────────────

  it("buildActivityTimeline returns [] for an empty vault", () => {
    const result = buildActivityTimeline(createEmptyVault());
    expect(result).toEqual([]);
  });

  it("buildActivityTimeline groups today's packs into one day labelled 今日 with correct disclosures and fact categories", () => {
    const now = new Date("2026-06-21T12:00:00.000Z");
    const todayTs = "2026-06-21T10:00:00.000Z";
    const todayTs2 = "2026-06-21T11:00:00.000Z";

    const base = createEmptyVault();
    const state: typeof base = {
      ...base,
      facts: [
        {
          id: "fact_1",
          sensitivityClassified: false,
          sensitivityConfidence: "low",
          factText: "My name is Kota",
          domain: "identity_and_profile",
          factType: "identity",
          sourceIds: [],
          sensitivity: "personal",
          confidence: "user_asserted",
          status: "active",
          createdAt: todayTs,
          approvedAt: todayTs,
          updatedAt: todayTs,
          supersedesFactIds: [],
        },
      ],
      contextPackRequests: [
        {
          id: "req_chatgpt",
          clientId: "client_chatgpt",
          clientName: "ChatGPT",
          taskText: "What is my name?",
          purpose: "answering question",
          requestedDomains: ["identity_and_profile"],
          sensitivityCeiling: "personal",
          approvalMode: "auto_low_risk",
          createdAt: todayTs,
          expiresAt: "2026-06-21T10:10:00.000Z",
          status: "fulfilled",
        },
        {
          id: "req_claude",
          clientId: "client_claude",
          clientName: "Claude",
          taskText: "Who am I?",
          purpose: "answering question",
          requestedDomains: ["identity_and_profile"],
          sensitivityCeiling: "personal",
          approvalMode: "always_review",
          createdAt: todayTs2,
          expiresAt: "2026-06-21T11:10:00.000Z",
          status: "pending_user_confirmation",
        },
      ],
      contextPacks: [
        {
          id: "pack_auto",
          requestId: "req_chatgpt",
          taskText: "What is my name?",
          taskDomain: "identity_and_profile",
          riskLevel: "low",
          generatedAt: todayTs,
          maxSensitivityIncluded: "personal",
          items: [
            {
              id: "item_1",
              sensitivityClassified: false,
              sensitivityConfidence: "low",
              factId: "fact_1",
              itemText: "My name is Kota",
              reasonIncluded: "relevant",
              sensitivity: "personal",
              sourceTitles: [],
              confidence: "user_asserted",
            },
          ],
          excludedItems: [],
          warnings: [],
          confirmationStatus: "not_required",
        },
        {
          id: "pack_pending",
          requestId: "req_claude",
          taskText: "Who am I?",
          taskDomain: "identity_and_profile",
          riskLevel: "low",
          generatedAt: todayTs2,
          maxSensitivityIncluded: "personal",
          items: [
            {
              id: "item_2",
              sensitivityClassified: false,
              sensitivityConfidence: "low",
              factId: "fact_1",
              itemText: "My name is Kota",
              reasonIncluded: "relevant",
              sensitivity: "personal",
              sourceTitles: [],
              confidence: "user_asserted",
            },
          ],
          excludedItems: [],
          warnings: [],
          confirmationStatus: "pending_user_confirmation",
        },
      ],
    };

    const days = buildActivityTimeline(state, { scope: "all", now });
    expect(days).toHaveLength(1);
    expect(days[0].label).toBe("今日");
    expect(days[0].entries).toHaveLength(2);

    // Entries are sorted newest-first within the day
    const [first, second] = days[0].entries;
    expect(first.packId).toBe("pack_pending");
    expect(first.disclosure).toBe("pending");
    expect(first.clientName).toBe("Claude");

    expect(second.packId).toBe("pack_auto");
    expect(second.disclosure).toBe("auto");
    expect(second.clientName).toBe("ChatGPT");

    // Fact category via domainLabel
    expect(first.facts[0].category).toBe(domainLabel("identity_and_profile"));
    expect(second.facts[0].category).toBe(domainLabel("identity_and_profile"));
  });

  it("buildActivityTimeline scope:week excludes packs older than 7 days but scope:all includes them", () => {
    const now = new Date("2026-06-21T12:00:00.000Z");
    const todayTs = "2026-06-21T10:00:00.000Z";
    const oldTs = "2026-05-22T10:00:00.000Z"; // 30 days ago

    const base = createEmptyVault();
    const state: typeof base = {
      ...base,
      facts: [],
      contextPackRequests: [],
      contextPacks: [
        {
          id: "pack_today",
          taskText: "recent",
          taskDomain: "identity_and_profile",
          riskLevel: "low",
          generatedAt: todayTs,
          maxSensitivityIncluded: "public",
          items: [],
          excludedItems: [],
          warnings: [],
          confirmationStatus: "not_required",
        },
        {
          id: "pack_old",
          taskText: "old task",
          taskDomain: "identity_and_profile",
          riskLevel: "low",
          generatedAt: oldTs,
          maxSensitivityIncluded: "public",
          items: [],
          excludedItems: [],
          warnings: [],
          confirmationStatus: "confirmed",
        },
      ],
    };

    const weekResult = buildActivityTimeline(state, { scope: "week", now });
    const allPackIds = weekResult.flatMap((d) => d.entries.map((e) => e.packId));
    expect(allPackIds).toContain("pack_today");
    expect(allPackIds).not.toContain("pack_old");

    const allResult = buildActivityTimeline(state, { scope: "all", now });
    const allIds = allResult.flatMap((d) => d.entries.map((e) => e.packId));
    expect(allIds).toContain("pack_today");
    expect(allIds).toContain("pack_old");
  });

  it("loading an existing vault whose policy lacks standingDeliveryEnabled stays strict (no silent opt-in)", () => {
    // Simulate an existing vault stored before standingDeliveryEnabled existed:
    // the persisted accessPolicy for conn_chatgpt has NO standingDeliveryEnabled key.
    const now = "2026-06-12T00:00:00.000Z";
    const storedState = {
      ...createEmptyVault(),
      facts: [{
        id: "fact_name", factText: "Preferred name: Kota", domain: "identity_and_profile",
        factType: "identity", sourceIds: [], sensitivity: "personal", confidence: "inferred_and_confirmed",
        status: "active", createdAt: now, approvedAt: now, updatedAt: now, supersedesFactIds: [],
        sensitivityClassified: true, sensitivityConfidence: "high"
      }],
      accessPolicies: [{
        clientId: "conn_chatgpt",
        clientName: "ChatGPT",
        sensitivityCeiling: "personal" as const,
        requiresApprovalAbove: "professional_sensitive" as const,
        domainAllowlist: [],
        approvalMode: "always_review" as const,
        createdAt: now,
        updatedAt: now
        // standingDeliveryEnabled intentionally OMITTED — simulates pre-upgrade vault
      }]
    };

    // normalizeVaultState is the load path used when reading a persisted vault
    const loaded = normalizeVaultState(storedState as unknown as Parameters<typeof normalizeVaultState>[0]);
    const chatgptPolicy = loaded.accessPolicies.find((p) => p.clientId === "conn_chatgpt");
    // The flag must remain absent/undefined — not silently coerced to true
    expect(chatgptPolicy?.standingDeliveryEnabled).toBeUndefined();

    // Confirm the pack stays strict: personal-tier fact must require user confirmation
    const req = createContextPackRequest(loaded, { clientId: "conn_chatgpt", clientName: "ChatGPT", taskText: "name?", ttlMinutes: 10 });
    const built = buildContextPackForRequest(req.state, req.request.id);
    expect(built.pack?.confirmationStatus).toBe("pending_user_confirmation");
  });

  // Task 4: fail-safe classifier tests
  it("normalizeFactForLoad defaults missing classifier fields to fail-closed", () => {
    const base = createEmptyVault();
    const now = "2026-06-21T00:00:00.000Z";
    const legacyFact = {
      id: "fact_legacy",
      factText: "Preferred name: Kota",
      domain: "identity_and_profile" as const,
      factType: "background_profile" as const,
      sourceIds: [],
      sensitivity: "public" as const,
      confidence: "source_backed" as const,
      status: "active" as const,
      createdAt: now,
      approvedAt: now,
      updatedAt: now,
      supersedesFactIds: []
      // intentionally omit sensitivityClassified and sensitivityConfidence
    };
    const normalized = normalizeVaultState({ ...base, facts: [legacyFact as any] });
    const fact = normalized.facts[0];
    expect(fact.sensitivityClassified).toBe(false);
    expect(fact.sensitivityConfidence).toBe("low");
  });

  it("reclassifyLegacyFacts upgrades legacy persisted facts (no migration version) on load", () => {
    const base = createEmptyVault();
    const now = "2026-06-21T00:00:00.000Z";
    // Legacy persisted state: a fact with classifier-significant text, NO classifier fields, NO migration version.
    const legacyFact = {
      id: "fact_legacy_email",
      factText: "Contact me at user@example.com",
      domain: "identity_and_profile" as const,
      factType: "background_profile" as const,
      sourceIds: [],
      sensitivity: "public" as const,
      confidence: "source_backed" as const,
      status: "active" as const,
      createdAt: now,
      approvedAt: now,
      updatedAt: now,
      supersedesFactIds: []
    };
    // Strip the migration version to simulate genuinely legacy persisted JSON.
    const legacyState: any = { ...base, facts: [legacyFact as any] };
    delete legacyState.classifierMigrationVersion;
    const normalized = normalizeVaultState(legacyState);
    const fact = normalized.facts[0];
    // The email pattern → classified true, high confidence (proves migration ran, not just defaults).
    expect(fact.sensitivityClassified).toBe(true);
    expect(fact.sensitivityConfidence).toBe("high");
    expect(normalized.classifierMigrationVersion).toBe(1);
  });

  it("mixed pack: one eligible item + one unclassified → pending_user_confirmation", () => {
    const base = createEmptyVault();
    const now = "2026-06-21T00:00:00.000Z";
    const state: VaultState = {
      ...base,
      facts: [
        {
          id: "fact_classified",
          factText: "Preferred name: Kota",
          domain: "identity_and_profile" as const,
          factType: "background_profile" as const,
          sourceIds: [],
          sensitivity: "public" as const,
          confidence: "source_backed" as const,
          status: "active" as const,
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: [],
          sensitivityClassified: true,
          sensitivityConfidence: "high" as const
        },
        {
          id: "fact_unclassified",
          factText: "Some note about plans.",
          domain: "life_events_and_plans" as const,
          factType: "note" as const,
          sourceIds: [],
          sensitivity: "public" as const,
          confidence: "source_backed" as const,
          status: "active" as const,
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: [],
          sensitivityClassified: false,
          sensitivityConfidence: "low" as const
        }
      ],
      accessPolicies: base.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? { ...p, standingDeliveryEnabled: false, requiresApprovalAbove: "sensitive" as const }
          : p
      )
    };
    // Untrusted connection in explicit_sensitive mode: the strict gate
    // (classified+confidence+tier) applies, so an unclassified item blocks
    // auto-delivery. (A trusted connection would relax to tier-only.)
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me with my plans",
      approvalMode: "explicit_sensitive",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    expect(built.pack?.confirmationStatus).toBe("pending_user_confirmation");
  });

  it("trusted connection auto-delivers an unclassified low-sensitivity fact (tier-only)", () => {
    const base = createEmptyVault();
    const now = "2026-06-21T00:00:00.000Z";
    const state: VaultState = {
      ...base,
      facts: [
        {
          id: "fact_unclassified_low",
          factText: "Preferred name: Kota",
          domain: "identity_and_profile" as const,
          factType: "background_profile" as const,
          sourceIds: [],
          sensitivity: "public" as const,
          confidence: "source_backed" as const,
          status: "active" as const,
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: [],
          sensitivityClassified: false,
          sensitivityConfidence: "low" as const
        }
      ],
      accessPolicies: base.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? { ...p, standingDeliveryEnabled: true, requiresApprovalAbove: "personal" as const }
          : p
      )
    };
    // Trusted connection: tier (public ≤ personal) alone makes it eligible, so the
    // unclassified fact auto-delivers without per-request confirmation.
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "What is my preferred name?",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    expect(built.pack?.confirmationStatus).toBe("not_required");
    expect(built.pack?.items.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("always_review short-circuit: even all-eligible items → pending_user_confirmation", () => {
    const base = createEmptyVault();
    const now = "2026-06-21T00:00:00.000Z";
    const state: VaultState = {
      ...base,
      facts: [
        {
          id: "fact_eligible",
          factText: "Preferred name: Kota",
          domain: "identity_and_profile" as const,
          factType: "background_profile" as const,
          sourceIds: [],
          sensitivity: "public" as const,
          confidence: "source_backed" as const,
          status: "active" as const,
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: [],
          sensitivityClassified: true,
          sensitivityConfidence: "high" as const
        }
      ],
      accessPolicies: base.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? { ...p, standingDeliveryEnabled: false }
          : p
      )
    };
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me with my plans",
      approvalMode: "always_review",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    expect(built.pack?.confirmationStatus).toBe("pending_user_confirmation");
  });

  it("empty pack: zero items → not_required (vacuous)", () => {
    const base = createEmptyVault();
    const state: VaultState = {
      ...base,
      facts: [],
      accessPolicies: base.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? { ...p, standingDeliveryEnabled: true }
          : p
      )
    };
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me plan",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    expect(built.pack?.items).toHaveLength(0);
    expect(built.pack?.confirmationStatus).toBe("not_required");
  });

  it("edit-adds-secret: approve with edited text reclassifies; manual updateFactMetadata sets sensitivityClassified=false + confidence=low", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Tone note",
      body: "Tone preference: concise"
    });
    const candidateId = state.candidates[0].id;
    // Approve with edited text that adds an email (personal/high confidence)
    state = approveCandidate(state, candidateId, { editedText: "Contact: user@example.com" });
    const fact = state.facts[0];
    expect(fact.sensitivityClassified).toBe(true);
    expect(fact.sensitivityConfidence).toBe("high"); // email pattern → high
    expect(fact.sensitivity).toBe("personal"); // email → personal tier

    // Manual override via updateFactMetadata sets sensitivityClassified=false, confidence=low
    state = updateFactMetadata(state, fact.id, {
      factText: fact.factText,
      domain: fact.domain,
      sensitivity: "public" // manual override
    });
    const updated = state.facts.find((f) => f.id === fact.id)!;
    expect(updated.sensitivityClassified).toBe(false);
    expect(updated.sensitivityConfidence).toBe("low");
  });

  it("updateFactMetadata text-only edit re-classifies the new text (classified=true)", () => {
    // Start with a fact approved from plain text (no sensitive signals → classified=false).
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Public note",
      body: "Today I went for a walk."
    });
    const candidateId = state.candidates[0].id;
    state = approveCandidate(state, candidateId);
    const fact = state.facts[0];
    // Plain text → no sensitive signals; sensitivityClassified may be false.

    // Edit to add an email address — keep same sensitivity tier (personal already set by
    // the email signal), passing current sensitivity so it's not a manual override.
    const editedText = "Contact me at user@example.com for details.";
    // The new text has an email: classifier will return personal/high.
    // We pass the SAME sensitivity value that would be on the fact after approve so the
    // branch is text-change-only (no sensitivity override).
    state = updateFactMetadata(state, fact.id, {
      factText: editedText,
      domain: fact.domain,
      sensitivity: fact.sensitivity // same tier as before → text-only branch
    });
    const edited = state.facts.find((f) => f.id === fact.id)!;
    // Re-classification should have run: email → classified=true, confidence=high.
    expect(edited.sensitivityClassified).toBe(true);
    expect(edited.sensitivityConfidence).toBe("high");
  });

  it("updateFactMetadata manual override wins even when text also changes", () => {
    // Start with a fact with an email (personal/high).
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Contact",
      body: "Contact: user@example.com"
    });
    const candidateId = state.candidates[0].id;
    state = approveCandidate(state, candidateId);
    const fact = state.facts[0];
    expect(fact.sensitivity).toBe("personal");

    // Change BOTH text AND sensitivity (override wins → classified=false, not re-classified).
    state = updateFactMetadata(state, fact.id, {
      factText: "New contact: other@example.com",
      domain: fact.domain,
      sensitivity: "public" // manual override different from "personal"
    });
    const updated = state.facts.find((f) => f.id === fact.id)!;
    expect(updated.sensitivityClassified).toBe(false);
    expect(updated.sensitivityConfidence).toBe("low");
    expect(updated.sensitivity).toBe("public");
  });

  it("updateFactMetadata domain-only edit leaves classification fields unchanged", () => {
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Work note",
      body: "Contact: user@example.com"
    });
    const candidateId = state.candidates[0].id;
    state = approveCandidate(state, candidateId);
    const fact = state.facts[0];
    const beforeClassified = fact.sensitivityClassified;
    const beforeConfidence = fact.sensitivityConfidence;

    // Change only domain — text and sensitivity unchanged.
    state = updateFactMetadata(state, fact.id, {
      factText: fact.factText,
      domain: "work_and_education",
      sensitivity: fact.sensitivity
    });
    const updated = state.facts.find((f) => f.id === fact.id)!;
    expect(updated.sensitivityClassified).toBe(beforeClassified);
    expect(updated.sensitivityConfidence).toBe(beforeConfidence);
    expect(updated.domain).toBe("work_and_education");
  });

  it("reclassifyLegacyFacts does NOT overwrite explicit sensitivityClassified=false (deliberate override)", () => {
    // Simulate a vault persisted after a manual override (sensitivityClassified explicitly false).
    const now = "2026-06-21T00:00:00.000Z";
    const rawWithExplicitFalse = {
      facts: [
        {
          id: "fact_override",
          factText: "Contact: user@example.com",
          domain: "identity_and_profile",
          sensitivity: "public", // manually overridden
          sensitivityClassified: false, // explicitly set to false
          sensitivityConfidence: "low",
          factType: "background_profile",
          sourceIds: [],
          confidence: "source_backed",
          status: "active",
          supersedesFactIds: [],
          createdAt: now,
          approvedAt: now,
          updatedAt: now
        }
      ]
      // classifierMigrationVersion absent → migration would normally run
    };
    const loaded = normalizeVaultState(rawWithExplicitFalse as any);
    const fact = loaded.facts.find((f) => f.id === "fact_override")!;
    // Must NOT re-classify: the explicit false must be preserved.
    expect(fact.sensitivityClassified).toBe(false);
    expect(fact.sensitivityConfidence).toBe("low");
    expect(fact.sensitivity).toBe("public");
  });

  it("per-client bar: zeroTouchConfidenceBar=high blocks medium-confidence item", () => {
    const base = createEmptyVault();
    const now = "2026-06-21T00:00:00.000Z";
    const state: VaultState = {
      ...base,
      facts: [
        {
          id: "fact_medium_conf",
          factText: "Preferred name: Kota",
          domain: "identity_and_profile" as const,
          factType: "background_profile" as const,
          sourceIds: [],
          sensitivity: "public" as const,
          confidence: "source_backed" as const,
          status: "active" as const,
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: [],
          sensitivityClassified: true,
          sensitivityConfidence: "medium" as const // medium confidence
        }
      ],
      accessPolicies: base.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? {
              ...p,
              standingDeliveryEnabled: false,
              zeroTouchConfidenceBar: "high" as const, // bar set to high → medium is below
              requiresApprovalAbove: "sensitive" as const
            }
          : p
      )
    };
    // Untrusted + explicit_sensitive: the strict confidence bar applies.
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "Help me",
      approvalMode: "explicit_sensitive",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    expect(built.pack?.confirmationStatus).toBe("pending_user_confirmation");
  });

  it("retrieval re-validation: fact going unclassified after build makes pack non-deliverable", () => {
    const base = createEmptyVault();
    const now = "2026-06-21T00:00:00.000Z";
    const state: VaultState = {
      ...base,
      facts: [
        {
          id: "fact_eligible",
          factText: "Preferred name: Kota",
          domain: "identity_and_profile" as const,
          factType: "background_profile" as const,
          sourceIds: [],
          sensitivity: "public" as const,
          confidence: "source_backed" as const,
          status: "active" as const,
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: [],
          sensitivityClassified: true,
          sensitivityConfidence: "high" as const
        }
      ],
      accessPolicies: base.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? { ...p, standingDeliveryEnabled: false, requiresApprovalAbove: "sensitive" as const }
          : p
      )
    };
    // Untrusted + explicit_sensitive: classification still gates eligibility, so a
    // fact going unclassified after build makes the pack non-deliverable.
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "What is my name?",
      approvalMode: "explicit_sensitive",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    const confirmedState = confirmContextPack(built.state, built.pack!.id);
    const confirmedPack = confirmedState.contextPacks.find((p) => p.id === built.pack!.id)!;
    expect(canSendContextPackToAi(confirmedState, confirmedPack)).toBe(true);

    // Now simulate the fact becoming unclassified
    const degradedState: VaultState = {
      ...confirmedState,
      facts: confirmedState.facts.map((f) =>
        f.id === "fact_eligible"
          ? { ...f, sensitivityClassified: false }
          : f
      )
    };
    expect(canSendContextPackToAi(degradedState, confirmedPack)).toBe(false);
  });

  it("retrieval re-validation: zero-touch pack blocked when confidence now below raised per-client bar", () => {
    // A fact classified at medium confidence; policy bar raised to "high" before the
    // zero-touch pack is confirmed → confirmation must be cancelled (sensitivity_policy).
    // In TS, contextPackPolicyViolation fires at confirmContextPack time for not_required packs.
    const base = createEmptyVault();
    const now = "2026-06-21T00:00:00.000Z";
    const stateWithMediumBar: VaultState = {
      ...base,
      facts: [
        {
          id: "fact_bar",
          factText: "Preferred name: Kota",
          domain: "identity_and_profile" as const,
          factType: "background_profile" as const,
          sourceIds: [],
          sensitivity: "public" as const,
          confidence: "source_backed" as const,
          status: "active" as const,
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: [],
          sensitivityClassified: true,
          sensitivityConfidence: "medium" as const
        }
      ],
      accessPolicies: base.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? {
              ...p,
              standingDeliveryEnabled: false,
              requiresApprovalAbove: "sensitive" as const,
              zeroTouchConfidenceBar: "medium" as const // medium bar → medium confidence passes
            }
          : p
      )
    };
    // Untrusted + explicit_sensitive: the per-client confidence bar gates eligibility.
    const requested = createContextPackRequest(stateWithMediumBar, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "What is my name?",
      approvalMode: "explicit_sensitive",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    // Pack is zero-touch at build time: medium confidence meets the medium bar.
    expect(built.pack?.confirmationStatus).toBe("not_required");

    // Simulate the bar being raised to "high" before the user confirms the pack.
    const tightenedState: VaultState = {
      ...built.state,
      accessPolicies: built.state.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? { ...p, zeroTouchConfidenceBar: "high" as const }
          : p
      )
    };
    // Confirming now must fail: medium confidence is below the raised "high" bar.
    const afterConfirm = confirmContextPack(tightenedState, built.pack!.id);
    const pack = afterConfirm.contextPacks.find((p) => p.id === built.pack!.id)!;
    expect(pack.confirmationStatus).toBe("cancelled");
  });

  it("retrieval re-validation: user-confirmed pack is NOT blocked by raised per-client zero-touch bar", () => {
    // A pack that went through user confirmation (always_review path) must remain deliverable
    // even if the zero-touch bar is later raised — a human already reviewed it.
    const base = createEmptyVault();
    const now = "2026-06-21T00:00:00.000Z";
    // Disable standingDeliveryEnabled so the approval mode is always_review → pending_user_confirmation.
    const stateForConfirmed: VaultState = {
      ...base,
      facts: [
        {
          id: "fact_confirmed_bar",
          factText: "Preferred name: Kota",
          domain: "identity_and_profile" as const,
          factType: "background_profile" as const,
          sourceIds: [],
          sensitivity: "public" as const,
          confidence: "source_backed" as const,
          status: "active" as const,
          createdAt: now,
          approvedAt: now,
          updatedAt: now,
          supersedesFactIds: [],
          sensitivityClassified: true,
          sensitivityConfidence: "medium" as const
        }
      ],
      accessPolicies: base.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? { ...p, standingDeliveryEnabled: false } // force always_review → pending_user_confirmation
          : p
      )
    };
    const requested = createContextPackRequest(stateForConfirmed, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "What is my name?",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    // Without standingDeliveryEnabled, pack requires user confirmation.
    expect(built.pack?.confirmationStatus).toBe("pending_user_confirmation");
    // User confirms it.
    const confirmedState = confirmContextPack(built.state, built.pack!.id);
    const confirmedPack = confirmedState.contextPacks.find((p) => p.id === built.pack!.id)!;
    expect(confirmedPack.confirmationStatus).toBe("confirmed");
    expect(canSendContextPackToAi(confirmedState, confirmedPack)).toBe(true);

    // Now set a high zero-touch bar on the policy — confirmed packs must remain deliverable.
    const tightenedState: VaultState = {
      ...confirmedState,
      accessPolicies: confirmedState.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt"
          ? { ...p, zeroTouchConfidenceBar: "high" as const }
          : p
      )
    };
    // Confirmed pack: confirmationStatus is "confirmed", not "not_required", so the
    // zero-touch bar re-check must NOT fire — pack stays deliverable.
    expect(canSendContextPackToAi(tightenedState, confirmedPack)).toBe(true);
  });

  it("pack-build secret filter: editing a candidate with injected secret excludes fact from pack", () => {
    // Set up a source with a benign candidate.
    let state = addSourceWithCandidates(createEmptyVault(), {
      kind: "manual_note",
      origin: "manual_entry",
      title: "Notes",
      body: "I prefer mornings for meetings."
    });
    const candidate = state.candidates[0];

    // Approve the candidate with EDITED text that injects a secret.
    // classifySensitivity detects "password=..." → secret_never_send.
    const editedWithSecret = "password=SuperSecret123 I prefer mornings.";
    state = approveCandidate(state, candidate.id, editedWithSecret);
    const secretFact = state.facts[0];
    // Confirm the secret was detected at approve time.
    expect(secretFact.sensitivity).toBe("secret_never_send");

    // Build a pack — secret facts are filtered from ranking before the build loop
    // (rankFactsForTask excludes secret_never_send), so they never reach pack items.
    const requested = createContextPackRequest(state, {
      clientId: "conn_chatgpt",
      clientName: "ChatGPT",
      taskText: "What time do I prefer for meetings?",
      ttlMinutes: 10
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);

    // The secret fact must NEVER appear in pack items — this is the security property.
    expect(built.pack?.items.some((item) => item.factId === secretFact.id)).toBe(false);
    // The pack should have no items at all (the only fact is secret and was filtered out).
    expect(built.pack?.items).toHaveLength(0);
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

describe("exportApprovedFactsMarkdown", () => {
  const now = "2026-06-12T00:00:00.000Z";
  const mkFact = (over: Partial<VaultState["facts"][number]>): VaultState["facts"][number] => ({
    id: "fact_x",
    factText: "プレースホルダ",
    domain: "identity_and_profile",
    factType: "identity",
    sourceIds: [],
    sensitivity: "personal",
    confidence: "user_asserted",
    status: "active",
    createdAt: now,
    approvedAt: now,
    updatedAt: now,
    supersedesFactIds: [],
    sensitivityClassified: true,
    sensitivityConfidence: "high",
    ...over
  });

  const nowMs = Date.parse("2026-06-12T00:00:00.000Z");

  it("exports active approved facts but never secret_never_send, non-active, expired, or raw sources", () => {
    const state = normalizeVaultState({
      ...createEmptyVault(),
      facts: [
        mkFact({ id: "f1", factText: "好きな色は青", sensitivity: "personal", status: "active" }),
        mkFact({ id: "f2", factText: "API キー sk-leak-123", sensitivity: "secret_never_send", status: "active" }),
        mkFact({ id: "f3", factText: "古い住所", sensitivity: "personal", status: "superseded" }),
        mkFact({
          id: "f4",
          factText: "期限切れの予定",
          sensitivity: "personal",
          status: "active",
          validUntil: "2026-01-01T00:00:00.000Z"
        })
      ]
    });

    const md = exportApprovedFactsMarkdown(state, nowMs);

    expect(md).toContain("好きな色は青");
    expect(md).not.toContain("sk-leak-123"); // secret_never_send must never reach a plaintext file
    expect(md).not.toContain("古い住所"); // non-active excluded
    expect(md).not.toContain("期限切れの予定"); // past validUntil excluded (matches pack retrieval)
    expect(md).toContain("暗号化されていません"); // plaintext warning present
  });

  it("surfaces unknown-domain facts under a fallback heading and flattens newlines", () => {
    const state = normalizeVaultState({
      ...createEmptyVault(),
      facts: [
        mkFact({
          id: "f5",
          factText: "行1\n## 偽の見出し",
          domain: "not_a_real_domain" as VaultState["facts"][number]["domain"],
          status: "active"
        })
      ]
    });

    const md = exportApprovedFactsMarkdown(state, nowMs);

    expect(md).toContain("## その他"); // not silently dropped
    expect(md).toContain("行1 ## 偽の見出し"); // newline flattened, no forged header
    expect(md.match(/^## /gm)?.length).toBe(1); // exactly one real heading (その他)
  });

  it("returns a friendly placeholder when there is nothing to export", () => {
    const md = exportApprovedFactsMarkdown(createEmptyVault());
    expect(md).toContain("まだありません");
  });
});

describe("factsByDomain", () => {
  const now = "2026-06-12T00:00:00.000Z";
  const mk = (id: string, domain: VaultState["facts"][number]["domain"]): VaultState["facts"][number] => ({
    id,
    factText: `fact ${id}`,
    domain,
    factType: "note",
    sourceIds: [],
    sensitivity: "personal",
    confidence: "user_asserted",
    status: "active",
    createdAt: now,
    approvedAt: now,
    updatedAt: now,
    supersedesFactIds: [],
    sensitivityClassified: true,
    sensitivityConfidence: "high"
  });

  it("groups facts by domain in canonical order and drops empty domains", () => {
    const groups = factsByDomain([
      mk("a", "health_and_care"),
      mk("b", "identity_and_profile"),
      mk("c", "health_and_care")
    ]);
    // Only the two populated domains appear, ordered as in allLifeDomains
    // (identity_and_profile precedes health_and_care).
    expect(groups.map((g) => g.domain)).toEqual([
      "identity_and_profile",
      "health_and_care"
    ]);
    expect(groups[0].facts.map((f) => f.id)).toEqual(["b"]);
    expect(groups[1].facts.map((f) => f.id)).toEqual(["a", "c"]);
  });

  it("returns an empty array when there are no facts", () => {
    expect(factsByDomain([])).toEqual([]);
  });
});
