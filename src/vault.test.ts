import { describe, expect, it } from "vitest";
import {
  addPassiveCaptureEvent,
  addSourceWithCandidates,
  approveCandidate,
  attachLocalAnswer,
  buildContextPack,
  buildContextPackForRequest,
  confirmContextPack,
  createContextPackRequest,
  createEmptyVault,
  makeAiContextPackPayload,
  purgeExpiredPassiveCaptures,
  searchFacts,
  updateContextPackItemVisibility,
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
});

function savePackForTest(state: ReturnType<typeof createEmptyVault>, pack: ReturnType<typeof buildContextPack>) {
  return {
    ...state,
    contextPacks: [pack, ...state.contextPacks]
  };
}
