import { describe, expect, it } from "vitest";
import {
  addPassiveCaptureEvent,
  addSourceWithCandidates,
  approveCandidate,
  buildContextPack,
  buildContextPackForRequest,
  createContextPackRequest,
  createEmptyVault,
  purgeExpiredPassiveCaptures,
  searchFacts
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
