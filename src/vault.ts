import {
  AiContextPackPayload,
  AccessPolicy,
  ApprovedFact,
  AuditEvent,
  BackgroundSetupInput,
  ConnectorKind,
  ConnectorSession,
  ContextPack,
  ContextPackItem,
  ContextPackRequest,
  FactLifecycleAction,
  LifeContextDomain,
  MemoryCandidate,
  PassiveCaptureEvent,
  PassiveCaptureSettings,
  RawSource,
  SensitivityTier,
  SourceLifecycleAction,
  SourceKind,
  VaultState
} from "./types";

export const STORAGE_KEY = "life-context-vault-poc";

const sensitivityRank: Record<SensitivityTier, number> = {
  public: 0,
  personal: 1,
  private_consequential: 2,
  sensitive: 3,
  secret_never_send: 4
};

const domainLabels: Record<LifeContextDomain, string> = {
  identity_and_profile: "Identity",
  values_goals_and_preferences: "Values and goals",
  life_events_and_plans: "Life events",
  routines_and_logistics: "Routines",
  home_and_places: "Home and places",
  documents_and_evidence: "Documents",
  contracts_and_policies: "Contracts",
  procedures_and_obligations: "Procedures",
  health_and_care: "Health and care",
  finance_and_benefits: "Finance and benefits",
  work_and_education: "Work and education",
  relationships_and_household: "Relationships",
  constraints_and_accessibility: "Constraints"
};

type LegacyVaultState = Omit<VaultState, "version"> & { version: 1 };
type PersistedVaultState = VaultState | LegacyVaultState | Partial<VaultState>;

const defaultAllowedSites = ["chat.openai.com", "chatgpt.com", "claude.ai", "gemini.google.com"];

export function createEmptyVault(): VaultState {
  const createdAt = nowIso();
  return {
    version: 2,
    sources: [],
    candidates: [],
    facts: [],
    accessPolicies: defaultAccessPolicies(createdAt),
    passiveCaptureSettings: {
      enabled: false,
      retentionDays: 14,
      allowedSites: defaultAllowedSites
    },
    passiveCaptureEvents: [],
    connectorSessions: defaultConnectorSessions(createdAt),
    contextPackRequests: [],
    contextPacks: [],
    auditEvents: []
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function loadVault(): VaultState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createEmptyVault();
  try {
    return normalizeVaultState(JSON.parse(raw) as PersistedVaultState);
  } catch {
    return createEmptyVault();
  }
}

export function normalizeVaultState(parsed: PersistedVaultState): VaultState {
  const empty = createEmptyVault();
  if (!parsed || typeof parsed !== "object") return empty;
  return {
    ...empty,
    ...parsed,
    version: 2,
    sources: parsed.sources ?? [],
    candidates: parsed.candidates ?? [],
    facts: parsed.facts ?? [],
    accessPolicies:
      parsed.accessPolicies && parsed.accessPolicies.length > 0
        ? parsed.accessPolicies
        : empty.accessPolicies,
    passiveCaptureSettings: {
      ...empty.passiveCaptureSettings,
      ...(parsed.passiveCaptureSettings ?? {})
    },
    passiveCaptureEvents: parsed.passiveCaptureEvents ?? [],
    connectorSessions:
      parsed.connectorSessions && parsed.connectorSessions.length > 0
        ? parsed.connectorSessions
        : empty.connectorSessions,
    contextPackRequests: parsed.contextPackRequests ?? [],
    contextPacks: parsed.contextPacks ?? [],
    auditEvents: parsed.auditEvents ?? []
  };
}

export function saveVault(state: VaultState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function audit(
  eventType: AuditEvent["eventType"],
  subjectType: AuditEvent["subjectType"],
  subjectId: string,
  sensitivity: SensitivityTier,
  metadata: Record<string, unknown> = {}
): AuditEvent {
  return {
    id: newId("audit"),
    eventType,
    actor: "system",
    subjectType,
    subjectId,
    occurredAt: nowIso(),
    sensitivity,
    metadata
  };
}

export function addSourceWithCandidates(
  state: VaultState,
  input: {
    kind: SourceKind;
    origin: RawSource["origin"];
    title: string;
    body: string;
  }
): VaultState {
  const sanitized = sanitizeSecretMaterial(input.body);
  const source: RawSource = {
    id: newId("src"),
    kind: input.kind,
    title: input.title.trim() || "Untitled source",
    origin: input.origin,
    body: sanitized.text,
    createdAt: nowIso(),
    capturedAt: nowIso(),
    defaultSensitivity: sanitized.secretFound
      ? "secret_never_send"
      : detectSensitivity(input.body),
    processingStatus: "ready",
    deletionState: "active"
  };
  const candidates = extractCandidates(source);
  return {
    ...state,
    sources: [source, ...state.sources],
    candidates: [...candidates, ...state.candidates],
    auditEvents: [
      audit("source_added", "source", source.id, source.defaultSensitivity, {
        title: source.title,
        kind: source.kind
      }),
      ...candidates.map((candidate) =>
        audit(
          "candidate_generated",
          "candidate",
          candidate.id,
          candidate.detectedSensitivity,
          { sourceId: source.id }
        )
      ),
      ...state.auditEvents
    ]
  };
}

export function backgroundSetupBody(input: BackgroundSetupInput): string {
  return [
    input.displayName && `Preferred name: ${input.displayName}`,
    input.tonePreference && `Tone preference: ${input.tonePreference}`,
    input.activeLifeAreas && `Active life areas: ${input.activeLifeAreas}`,
    input.recurringConstraints && `Recurring constraints: ${input.recurringConstraints}`,
    input.confirmationTopics &&
      `Topics requiring explicit confirmation: ${input.confirmationTopics}`
  ]
    .filter(Boolean)
    .join("\n");
}

export function createBackgroundSource(
  state: VaultState,
  input: BackgroundSetupInput
): VaultState {
  const body = backgroundSetupBody(input);

  if (!body.trim()) return state;

  return addSourceWithCandidates(state, {
    kind: "background_onboarding",
    origin: "guided_onboarding",
    title: "Guided background setup",
    body
  });
}

export function extractCandidates(source: RawSource): MemoryCandidate[] {
  const lines = source.body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates: MemoryCandidate[] = [];

  for (const line of lines) {
    const sensitivity = detectSensitivity(line);
    const status: MemoryCandidate["status"] =
      sensitivity === "sensitive" || sensitivity === "secret_never_send"
        ? "blocked_sensitive"
        : "new";
    const common = {
      id: newId("cand"),
      sourceIds: [source.id],
      detectedSensitivity: sensitivity,
      confidence: "medium" as const,
      createdAt: nowIso(),
      status,
      createsFactIds: [] as string[]
    };

    if (/preferred name|nickname|名前|呼び名/i.test(line)) {
      candidates.push({
        ...common,
        proposedFactText: normalizeFactText(line),
        domain: "identity_and_profile",
        candidateType: "background_profile",
        reasonToRemember: "AIの呼び方や本人性の文脈として使えます。"
      });
      continue;
    }

    if (/tone|communication|話し方|文体|口調|伝え方/i.test(line)) {
      candidates.push({
        ...common,
        proposedFactText: normalizeFactText(line),
        domain: "values_goals_and_preferences",
        candidateType: "preference",
        reasonToRemember: "文章作成や会話支援の出力を本人に合わせられます。"
      });
      continue;
    }

    if (/goal|priority|want to|目標|優先|大事|やりたい/i.test(line)) {
      candidates.push({
        ...common,
        proposedFactText: normalizeFactText(line),
        domain: "values_goals_and_preferences",
        candidateType: "goal",
        reasonToRemember: "提案や計画を本人の優先順位に合わせられます。"
      });
      continue;
    }

    if (/constraint|budget|energy|accessibility|schedule|制約|予算|体力|予定|アクセシビリティ/i.test(line)) {
      candidates.push({
        ...common,
        proposedFactText: normalizeFactText(line),
        domain: "constraints_and_accessibility",
        candidateType: "constraint",
        reasonToRemember: "現実的な計画や提案の制約として重要です。"
      });
      continue;
    }

    const date = extractDate(line);
    if (
      date &&
      /deadline|due|renew|expires|expiration|submit|update|期限|締切|更新|提出|満了/i.test(
        line
      )
    ) {
      candidates.push({
        ...common,
        proposedFactText: normalizeFactText(line),
        domain: classifyDomain(line),
        candidateType: "deadline",
        dueDate: date,
        reasonToRemember: "期限や更新日は生活上の手続きに影響します。"
      });
      continue;
    }

    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(line) || /\+?\d[\d\s().-]{7,}\d/.test(line)) {
      candidates.push({
        ...common,
        proposedFactText: normalizeFactText(line),
        domain: classifyDomain(line),
        candidateType: "contact_point",
        reasonToRemember: "必要なときの連絡先として参照できます。"
      });
      continue;
    }

    if (/must|need to|required|submit|notify|cancel|renew|必要|提出|連絡|解約|更新/i.test(line)) {
      candidates.push({
        ...common,
        proposedFactText: normalizeFactText(line),
        domain: classifyDomain(line),
        candidateType: "obligation",
        reasonToRemember: "やるべきことや注意点として後から役立ちます。"
      });
      continue;
    }

    if (/moving|move|job change|travel|caregiving|引っ越|転職|旅行|介護|入学|卒業/i.test(line)) {
      candidates.push({
        ...common,
        proposedFactText: normalizeFactText(line),
        domain: "life_events_and_plans",
        candidateType: "life_event",
        reasonToRemember: "生活イベントは関連する助言や手続きの前提になります。"
      });
      continue;
    }
  }

  if (candidates.length === 0 && source.body.trim()) {
    const sensitivity = detectSensitivity(source.body);
    candidates.push({
      id: newId("cand"),
      sourceIds: [source.id],
      proposedFactText: normalizeFactText(source.body.slice(0, 220)),
      domain: classifyDomain(source.body),
      candidateType: "note",
      detectedSensitivity: sensitivity,
      confidence: "low",
      reasonToRemember: "この情報は後で背景文脈として役立つ可能性があります。",
      status:
        sensitivity === "sensitive" || sensitivity === "secret_never_send"
          ? "blocked_sensitive"
          : "new",
      createdAt: nowIso(),
      createsFactIds: []
    } as MemoryCandidate);
  }

  return candidates;
}

export function approveCandidate(
  state: VaultState,
  candidateId: string,
  editedText?: string
): VaultState {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) return state;
  if (candidate.detectedSensitivity === "secret_never_send") return state;
  if (candidate.sourceIds.some((sourceId) => state.sources.find((source) => source.id === sourceId)?.deletionState !== "active")) {
    return state;
  }

  const text = (editedText ?? candidate.proposedFactText).trim();
  if (!text) return state;

  const fact: ApprovedFact = {
    id: newId("fact"),
    factText: text,
    domain: candidate.domain,
    factType: candidateTypeToFactType(candidate.candidateType),
    sourceIds: candidate.sourceIds,
    sensitivity: candidate.detectedSensitivity,
    confidence:
      candidate.sourceIds.length > 0 ? "source_backed" : "inferred_and_confirmed",
    status: "active",
    validFrom: candidate.validFrom,
    validUntil: candidate.validUntil,
    dueDate: candidate.dueDate,
    createdAt: nowIso(),
    approvedAt: nowIso(),
    updatedAt: nowIso()
  };

  return {
    ...state,
    facts: [fact, ...state.facts],
    candidates: state.candidates.map((item) =>
      item.id === candidateId
        ? {
            ...item,
            status:
              editedText && editedText.trim() !== item.proposedFactText
                ? "edited_and_approved"
                : "approved",
            reviewedAt: nowIso(),
            createsFactIds: [fact.id]
          }
        : item
    ),
    auditEvents: [
      audit("candidate_reviewed", "candidate", candidate.id, candidate.detectedSensitivity, {
        action: "approved"
      }),
      audit("fact_created", "fact", fact.id, fact.sensitivity, {
        candidateId: candidate.id
      }),
      ...state.auditEvents
    ]
  };
}

export function updateCandidateStatus(
  state: VaultState,
  candidateId: string,
  status: MemoryCandidate["status"]
): VaultState {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) return state;
  return {
    ...state,
    candidates: state.candidates.map((item) =>
      item.id === candidateId ? { ...item, status, reviewedAt: nowIso() } : item
    ),
    auditEvents: [
      audit("candidate_reviewed", "candidate", candidate.id, candidate.detectedSensitivity, {
        action: status
      }),
      ...state.auditEvents
    ]
  };
}

export function updateSourceLifecycle(
  state: VaultState,
  sourceId: string,
  action: SourceLifecycleAction
): VaultState {
  const source = state.sources.find((item) => item.id === sourceId);
  if (!source) return state;
  if (action === "restore" && source.deletionState === "purged") return state;

  const now = nowIso();
  const isDeleting = action === "soft_delete" || action === "purge_body";
  const affectedFactIds = new Set(
    state.facts
      .filter((fact) => fact.sourceIds.includes(sourceId))
      .map((fact) => fact.id)
  );
  const nextSources = state.sources.map((item) => {
    if (item.id !== sourceId) return item;
    if (action === "restore") {
      return { ...item, deletionState: "active" as const, processingStatus: "ready" as const };
    }
    if (action === "purge_body") {
      return {
        ...item,
        body: "",
        deletionState: "purged" as const,
        processingStatus: "deleted" as const,
        promotedToLongTerm: false
      };
    }
    return { ...item, deletionState: "soft_deleted" as const, processingStatus: "deleted" as const };
  });
  const nextCandidates = isDeleting
    ? state.candidates.map((candidate) =>
        candidate.sourceIds.includes(sourceId) &&
        ["new", "needs_user_detail", "blocked_sensitive"].includes(candidate.status)
          ? { ...candidate, status: "archived" as const, reviewedAt: now }
          : candidate
      )
    : state.candidates;
  const nextFacts = state.facts.map((fact) => {
    if (!fact.sourceIds.includes(sourceId)) return fact;
    if (isDeleting && fact.status === "active") {
      return {
        ...fact,
        status: "needs_review" as const,
        updatedAt: now,
        reviewReason: "source_deleted" as const,
        reviewSourceId: sourceId
      };
    }
    if (
      action === "restore" &&
      fact.status === "needs_review" &&
      fact.reviewReason === "source_deleted" &&
      fact.reviewSourceId === sourceId
    ) {
      const { reviewReason: _reviewReason, reviewSourceId: _reviewSourceId, ...restored } = fact;
      return { ...restored, status: "active" as const, updatedAt: now };
    }
    return fact;
  });
  const nextPacks = isDeleting ? invalidatePacksForFacts(state.contextPacks, affectedFactIds) : state.contextPacks;
  const invalidatedRequestIds = new Set(
    nextPacks
      .filter((pack, index) => pack.confirmationStatus !== state.contextPacks[index]?.confirmationStatus)
      .map((pack) => pack.requestId)
      .filter((requestId): requestId is string => Boolean(requestId))
  );
  const nextRequests = isDeleting
    ? state.contextPackRequests.map((request) =>
        invalidatedRequestIds.has(request.id) ? { ...request, status: "expired" as const } : request
      )
    : state.contextPackRequests;
  const eventType =
    action === "restore" ? "source_restored" : action === "purge_body" ? "source_purged" : "source_deleted";

  return {
    ...state,
    sources: nextSources,
    candidates: nextCandidates,
    facts: nextFacts,
    contextPacks: nextPacks,
    contextPackRequests: nextRequests,
    auditEvents: [
      audit(eventType, "source", sourceId, source.defaultSensitivity, {
        title: source.title,
        affectedFactCount: affectedFactIds.size,
        invalidatedPackCount: invalidatedRequestIds.size
      }),
      ...state.auditEvents
    ]
  };
}

export function updateFactLifecycle(
  state: VaultState,
  factId: string,
  action: FactLifecycleAction
): VaultState {
  const fact = state.facts.find((item) => item.id === factId);
  if (!fact) return state;

  const now = nowIso();
  const nextStatus = factStatusForAction(action);
  const isRemovingFromActiveContext = ["mark_needs_review", "hide", "delete"].includes(action);
  const affectedFactIds = new Set([factId]);
  const nextFacts = state.facts.map((item) => {
    if (item.id !== factId) return item;
    const updated: ApprovedFact = {
      ...item,
      status: nextStatus,
      updatedAt: now
    };
    if (nextStatus === "active") {
      const { reviewReason: _reviewReason, reviewSourceId: _reviewSourceId, ...restored } = updated;
      return restored;
    }
    if (nextStatus === "needs_review") {
      return {
        ...updated,
        reviewReason: updated.reviewReason ?? "source_deleted"
      };
    }
    return updated;
  });
  const nextPacks = isRemovingFromActiveContext
    ? invalidatePacksForFacts(state.contextPacks, affectedFactIds)
    : state.contextPacks;
  const invalidatedRequestIds = new Set(
    nextPacks
      .filter((pack, index) => pack.confirmationStatus !== state.contextPacks[index]?.confirmationStatus)
      .map((pack) => pack.requestId)
      .filter((requestId): requestId is string => Boolean(requestId))
  );
  const nextRequests = isRemovingFromActiveContext
    ? state.contextPackRequests.map((request) =>
        invalidatedRequestIds.has(request.id) ? { ...request, status: "expired" as const } : request
      )
    : state.contextPackRequests;

  return {
    ...state,
    facts: nextFacts,
    contextPacks: nextPacks,
    contextPackRequests: nextRequests,
    auditEvents: [
      audit("fact_updated", "fact", factId, fact.sensitivity, {
        action,
        status: nextStatus,
        invalidatedPackCount: invalidatedRequestIds.size
      }),
      ...state.auditEvents
    ]
  };
}

function factStatusForAction(action: FactLifecycleAction): ApprovedFact["status"] {
  if (action === "keep_active" || action === "restore") return "active";
  if (action === "hide") return "user_hidden";
  if (action === "delete") return "deleted";
  return "needs_review";
}

function invalidatePacksForFacts(
  packs: VaultState["contextPacks"],
  affectedFactIds: Set<string>
): VaultState["contextPacks"] {
  if (affectedFactIds.size === 0) return packs;
  return packs.map((pack) => {
    const hasAffectedItem = pack.items.some((item) => affectedFactIds.has(item.factId));
    if (!hasAffectedItem || pack.confirmationStatus === "cancelled") return pack;
    return {
      ...pack,
      confirmationStatus: "cancelled",
      warnings: [
        {
          kind: "source_deleted",
          message: "根拠Sourceが削除または消去されたため、このContext Packは無効化されました。",
          relatedIds: Array.from(affectedFactIds)
        },
        ...pack.warnings
      ]
    };
  });
}

export function searchFacts(
  state: VaultState,
  query: string,
  filters?: { domain?: LifeContextDomain | "all"; sensitivity?: SensitivityTier | "all" }
): ApprovedFact[] {
  const normalized = query.toLowerCase().trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return state.facts
    .filter((fact) => fact.status === "active")
    .filter((fact) => !filters?.domain || filters.domain === "all" || fact.domain === filters.domain)
    .filter(
      (fact) =>
        !filters?.sensitivity ||
        filters.sensitivity === "all" ||
        fact.sensitivity === filters.sensitivity
    )
    .map((fact) => {
      const haystack = `${fact.factText} ${fact.domain}`.toLowerCase();
      const score =
        tokens.length === 0
          ? 1
          : tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 2 : 0), 0);
      return { fact, score };
    })
    .filter(({ score }) => tokens.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || b.fact.updatedAt.localeCompare(a.fact.updatedAt))
    .map(({ fact }) => fact);
}

export function buildContextPack(state: VaultState, taskText: string): ContextPack {
  return buildContextPackWithOptions(state, taskText, {
    sensitivityCeiling: "sensitive"
  });
}

export function createContextPackRequest(
  state: VaultState,
  input: {
    clientId: string;
    clientName: string;
    taskText: string;
    purpose?: string;
    requestedDomains?: Array<LifeContextDomain | "mixed" | "unknown">;
    sensitivityCeiling?: SensitivityTier;
    approvalMode?: ContextPackRequest["approvalMode"];
    ttlMinutes?: number;
  }
): { state: VaultState; request: ContextPackRequest } {
  const now = nowIso();
  const request: ContextPackRequest = {
    id: newId("req"),
    clientId: input.clientId,
    clientName: input.clientName,
    taskText: input.taskText,
    purpose: input.purpose ?? "Answer with user-approved life context",
    requestedDomains: input.requestedDomains ?? [classifyDomain(input.taskText)],
    sensitivityCeiling: input.sensitivityCeiling ?? policyCeilingForClient(state, input.clientId),
    approvalMode: input.approvalMode ?? "explicit_sensitive",
    createdAt: now,
    expiresAt: minutesFromNow(input.ttlMinutes ?? 10),
    status: "pending_user_confirmation"
  };

  const next = {
    ...state,
    contextPackRequests: [request, ...state.contextPackRequests],
    connectorSessions: touchConnector(state.connectorSessions, request.clientId),
    auditEvents: [
      audit("context_pack_requested", "context_pack_request", request.id, request.sensitivityCeiling, {
        clientName: request.clientName,
        purpose: request.purpose
      }),
      ...state.auditEvents
    ]
  };
  return { state: next, request };
}

export function buildContextPackForRequest(
  state: VaultState,
  requestId: string
): { state: VaultState; pack: ContextPack | null } {
  const request = state.contextPackRequests.find((item) => item.id === requestId);
  if (!request) return { state, pack: null };
  if (isExpired(request.expiresAt)) {
    return {
      state: {
        ...state,
        contextPackRequests: state.contextPackRequests.map((item) =>
          item.id === requestId ? { ...item, status: "expired" } : item
        )
      },
      pack: null
    };
  }
  const pack = buildContextPackWithOptions(state, request.taskText, {
    requestId: request.id,
    expiresAt: request.expiresAt,
    sensitivityCeiling: request.sensitivityCeiling,
    clientId: request.clientId,
    approvalMode: request.approvalMode
  });
  const auditEvent = audit(
    "context_pack_generated",
    "context_pack",
    pack.id,
    pack.maxSensitivityIncluded,
    {
      requestId: request.id,
      clientName: request.clientName,
      itemCount: pack.items.length,
      excludedCount: pack.excludedItems.length
    }
  );
  const savedPack: ContextPack = { ...pack, auditEventId: auditEvent.id };
  return {
    state: {
      ...state,
      contextPacks: [savedPack, ...state.contextPacks],
      contextPackRequests: state.contextPackRequests.map((item) =>
        item.id === requestId
          ? {
              ...item,
              status:
                savedPack.confirmationStatus === "pending_user_confirmation"
                  ? "pending_user_confirmation"
                  : "approved"
            }
          : item
      ),
      auditEvents: [auditEvent, ...state.auditEvents]
    },
    pack: savedPack
  };
}

function buildContextPackWithOptions(
  state: VaultState,
  taskText: string,
  options: {
    requestId?: string;
    expiresAt?: string;
    sensitivityCeiling: SensitivityTier;
    clientId?: string;
    approvalMode?: ContextPackRequest["approvalMode"];
  }
): ContextPack {
  const taskDomain = classifyDomain(taskText);
  const riskLevel = classifyRisk(taskText);
  const relevant = rankFactsForTask(state, taskText).slice(0, 12);
  const items: ContextPackItem[] = [];
  const excludedItems: ContextPack["excludedItems"] = [];
  const warnings: ContextPack["warnings"] = [];
  const sourceSnippets: NonNullable<ContextPack["sourceSnippets"]> = [];

  for (const fact of relevant) {
    if (fact.sensitivity === "secret_never_send") {
      excludedItems.push({ referencedId: fact.id, reason: "secret_never_send" });
      continue;
    }
    if (sensitivityRank[fact.sensitivity] > sensitivityRank[options.sensitivityCeiling]) {
      excludedItems.push({ referencedId: fact.id, reason: "sensitivity_policy" });
      continue;
    }
    if (fact.status !== "active") {
      excludedItems.push({
        referencedId: fact.id,
        reason: fact.status === "expired" ? "expired" : fact.status === "deleted" ? "deleted" : "user_hidden"
      });
      continue;
    }
    if (fact.validUntil && isExpired(fact.validUntil)) {
      excludedItems.push({ referencedId: fact.id, reason: "expired" });
      continue;
    }
    items.push({
      id: newId("ctxitem"),
      factId: fact.id,
      itemText: fact.factText,
      reasonIncluded:
        fact.domain === taskDomain
          ? "質問の領域と一致しています。"
          : "本人の背景情報として回答を調整できます。",
      sensitivity: fact.sensitivity,
      sourceTitles: fact.sourceIds.map((id) => sourceTitle(state, id)),
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      confidence: fact.confidence
    });
    const snippet = sourceSnippetForFact(state, fact, options.sensitivityCeiling);
    if (snippet) sourceSnippets.push(snippet);
  }

  if (items.some((item) => sensitivityRank[item.sensitivity] >= 2)) {
    warnings.push({
      kind: "sensitive_context",
      message: "このContext Packには私的またはセンシティブな背景情報が含まれます。",
      relatedIds: items
        .filter((item) => sensitivityRank[item.sensitivity] >= 2)
        .map((item) => item.factId)
    });
  }
  const lowConfidenceIds = items
    .filter((item) => item.confidence === "inferred_and_confirmed")
    .map((item) => item.factId);
  if (lowConfidenceIds.length > 0) {
    warnings.push({
      kind: "low_confidence",
      message: "一部の背景情報は推定後に確認された情報です。必要ならSourceを確認してください。",
      relatedIds: lowConfidenceIds
    });
  }
  const staleIds = items
    .filter((item) => item.validUntil && isExpired(item.validUntil))
    .map((item) => item.factId);
  if (staleIds.length > 0) {
    warnings.push({
      kind: "stale_fact",
      message: "期限切れまたは古い可能性がある背景情報があります。",
      relatedIds: staleIds
    });
  }
  const sourceDeletedIds = items
    .filter((item) =>
      state.facts
        .find((fact) => fact.id === item.factId)
        ?.sourceIds.some((id) => state.sources.find((source) => source.id === id)?.deletionState !== "active")
    )
    .map((item) => item.factId);
  if (sourceDeletedIds.length > 0) {
    warnings.push({
      kind: "source_deleted",
      message: "根拠Sourceが削除または無効化されたFactがあります。",
      relatedIds: sourceDeletedIds
    });
  }

  const maxSensitivityIncluded = items.reduce<SensitivityTier>(
    (max, item) =>
      sensitivityRank[item.sensitivity] > sensitivityRank[max] ? item.sensitivity : max,
    "public"
  );

  return {
    id: newId("pack"),
    requestId: options.requestId,
    taskText,
    taskDomain,
    riskLevel,
    generatedAt: nowIso(),
    expiresAt: options.expiresAt,
    maxSensitivityIncluded,
    items,
    sourceSnippets,
    excludedItems,
    warnings,
    confirmationStatus:
      options.approvalMode === "always_review" ||
      sensitivityRank[maxSensitivityIncluded] >= 2
        ? "pending_user_confirmation"
        : "not_required"
  };
}

export function saveContextPack(state: VaultState, pack: ContextPack): VaultState {
  const event = audit("context_pack_generated", "context_pack", pack.id, pack.maxSensitivityIncluded, {
    itemCount: pack.items.length,
    riskLevel: pack.riskLevel,
    requestId: pack.requestId
  });
  return {
    ...state,
    contextPacks: [{ ...pack, auditEventId: event.id }, ...state.contextPacks],
    auditEvents: [event, ...state.auditEvents]
  };
}

export function confirmContextPack(state: VaultState, packId: string): VaultState {
  const pack = state.contextPacks.find((item) => item.id === packId);
  if (!pack) return state;
  return {
    ...state,
    contextPacks: state.contextPacks.map((pack) =>
      pack.id === packId
        ? { ...pack, confirmationStatus: "confirmed", confirmedAt: nowIso() }
        : pack
    ),
    contextPackRequests: state.contextPackRequests.map((request) =>
      pack?.requestId && request.id === pack.requestId
        ? { ...request, status: "fulfilled" }
        : request
    ),
    auditEvents: [
      audit("context_pack_confirmed", "context_pack", packId, pack.maxSensitivityIncluded, {
        requestId: pack.requestId
      }),
      ...state.auditEvents
    ]
  };
}

export function makeAiContextPackPayload(pack: ContextPack): AiContextPackPayload {
  return {
    trustBoundary: "ContextPack only",
    id: pack.id,
    requestId: pack.requestId,
    taskText: pack.taskText,
    taskDomain: pack.taskDomain,
    generatedAt: pack.generatedAt,
    expiresAt: pack.expiresAt,
    maxSensitivityIncluded: pack.maxSensitivityIncluded,
    items: pack.items,
    sourceSnippets: pack.sourceSnippets,
    warnings: pack.warnings,
    excludedItems: pack.excludedItems,
    confirmationStatus: pack.confirmationStatus
  };
}

export function denyContextPackRequest(state: VaultState, requestId: string): VaultState {
  const request = state.contextPackRequests.find((item) => item.id === requestId);
  if (!request) return state;
  return {
    ...state,
    contextPackRequests: state.contextPackRequests.map((item) =>
      item.id === requestId ? { ...item, status: "denied" } : item
    ),
    contextPacks: state.contextPacks.map((pack) =>
      pack.requestId === requestId ? { ...pack, confirmationStatus: "cancelled" } : pack
    ),
    auditEvents: [
      audit("context_pack_denied", "context_pack_request", request.id, request.sensitivityCeiling, {
        clientName: request.clientName
      }),
      ...state.auditEvents
    ]
  };
}

export function attachLocalAnswer(
  state: VaultState,
  packId: string,
  answer: string
): VaultState {
  return {
    ...state,
    contextPacks: state.contextPacks.map((pack) =>
      pack.id === packId ? { ...pack, localAnswer: answer } : pack
    )
  };
}

export function updatePassiveCaptureSettings(
  state: VaultState,
  settings: Partial<PassiveCaptureSettings>
): VaultState {
  const nextSettings = {
    ...state.passiveCaptureSettings,
    ...settings,
    retentionDays: Math.max(1, Math.min(90, settings.retentionDays ?? state.passiveCaptureSettings.retentionDays))
  };
  return {
    ...state,
    passiveCaptureSettings: nextSettings,
    auditEvents: [
      audit("policy_updated", "policy", "passive_capture", "personal", {
        enabled: nextSettings.enabled,
        retentionDays: nextSettings.retentionDays
      }),
      ...state.auditEvents
    ]
  };
}

export function updateAccessPolicy(
  state: VaultState,
  clientId: string,
  settings: Partial<Pick<AccessPolicy, "sensitivityCeiling" | "requiresApprovalAbove" | "passiveCaptureAllowed">>
): VaultState {
  const now = nowIso();
  const currentPolicy = state.accessPolicies.find((policy) => policy.clientId === clientId);
  if (!currentPolicy) return state;
  const updatedPolicy: AccessPolicy = {
    ...currentPolicy,
    ...settings,
    updatedAt: now
  };
  const accessPolicies = state.accessPolicies.map((policy) =>
    policy.clientId === clientId ? updatedPolicy : policy
  );
  return {
    ...state,
    accessPolicies,
    auditEvents: [
      audit("policy_updated", "policy", updatedPolicy.id, updatedPolicy.sensitivityCeiling, {
        clientId,
        sensitivityCeiling: updatedPolicy.sensitivityCeiling,
        requiresApprovalAbove: updatedPolicy.requiresApprovalAbove,
        passiveCaptureAllowed: updatedPolicy.passiveCaptureAllowed
      }),
      ...state.auditEvents
    ]
  };
}

export function addPassiveCaptureEvent(
  state: VaultState,
  input: {
    sourceClient: ConnectorKind;
    conversationId: string;
    url: string;
    text: string;
  }
): VaultState {
  if (!state.passiveCaptureSettings.enabled) return state;
  const capturedAt = nowIso();
  const retentionUntil = daysFromNow(state.passiveCaptureSettings.retentionDays);
  const sanitized = sanitizeSecretMaterial(input.text);
  const source: RawSource = {
    id: newId("src"),
    kind: "passive_capture",
    title: `${clientLabel(input.sourceClient)} passive capture`,
    origin: "passive_browser",
    body: sanitized.text,
    createdAt: capturedAt,
    capturedAt,
    retentionUntil,
    promotedToLongTerm: false,
    defaultSensitivity: sanitized.secretFound
      ? "secret_never_send"
      : detectSensitivity(input.text),
    processingStatus: "ready",
    deletionState: "active"
  };
  const candidates = extractCandidates(source);
  const event: PassiveCaptureEvent = {
    id: newId("cap"),
    sourceClient: input.sourceClient,
    conversationId: input.conversationId,
    urlHash: stableHash(input.url),
    textFragmentRef: `${source.id}:body`,
    capturedAt,
    retentionUntil,
    sensitivityGuess: source.defaultSensitivity,
    processingStatus: candidates.length > 0 ? "candidate_generated" : "ignored",
    sourceId: source.id,
    candidateIds: candidates.map((candidate) => candidate.id)
  };
  return {
    ...state,
    sources: [source, ...state.sources],
    candidates: [...candidates, ...state.candidates],
    passiveCaptureEvents: [event, ...state.passiveCaptureEvents],
    auditEvents: [
      audit("passive_capture_recorded", "passive_capture_event", event.id, source.defaultSensitivity, {
        sourceClient: input.sourceClient,
        candidateCount: candidates.length,
        retentionUntil
      }),
      ...candidates.map((candidate) =>
        audit("candidate_generated", "candidate", candidate.id, candidate.detectedSensitivity, {
          sourceId: source.id,
          passiveCaptureEventId: event.id
        })
      ),
      ...state.auditEvents
    ]
  };
}

export function purgeExpiredPassiveCaptures(
  state: VaultState,
  at: Date = new Date()
): VaultState {
  const expiredSourceIds = new Set(
    state.sources
      .filter(
        (source) =>
          source.kind === "passive_capture" &&
          !source.promotedToLongTerm &&
          source.retentionUntil &&
          new Date(source.retentionUntil).getTime() <= at.getTime()
      )
      .map((source) => source.id)
  );
  if (expiredSourceIds.size === 0) return state;
  const auditEvents = Array.from(expiredSourceIds).map((sourceId) =>
    audit("passive_capture_purged", "source", sourceId, "personal", {})
  );
  return {
    ...state,
    sources: state.sources.map((source) =>
      expiredSourceIds.has(source.id)
        ? {
            ...source,
            body: "[PURGED_PASSIVE_CAPTURE]",
            deletionState: "purged" as const,
            processingStatus: "ready" as const
          }
        : source
    ),
    passiveCaptureEvents: state.passiveCaptureEvents.map((event) =>
      event.sourceId && expiredSourceIds.has(event.sourceId)
        ? { ...event, processingStatus: "purged" as const }
        : event
    ),
    auditEvents: [...auditEvents, ...state.auditEvents]
  };
}

export function proposeMemoryFromConnector(
  state: VaultState,
  input: {
    clientId: string;
    clientKind: ConnectorKind;
    clientName: string;
    text: string;
  }
): VaultState {
  const source: RawSource = {
    id: newId("src"),
    kind: "mcp_proposal",
    title: `${input.clientName} memory proposal`,
    origin: input.clientKind === "chatgpt" || input.clientKind === "claude_remote" ? "remote_relay" : "local_mcp",
    body: sanitizeSecretMaterial(input.text).text,
    createdAt: nowIso(),
    capturedAt: nowIso(),
    defaultSensitivity: detectSensitivity(input.text),
    processingStatus: "ready",
    deletionState: "active"
  };
  const candidates = extractCandidates(source);
  return {
    ...state,
    sources: [source, ...state.sources],
    candidates: [...candidates, ...state.candidates],
    connectorSessions: touchConnector(state.connectorSessions, input.clientId),
    auditEvents: [
      audit("memory_proposed", "source", source.id, source.defaultSensitivity, {
        clientId: input.clientId,
        clientKind: input.clientKind,
        candidateCount: candidates.length
      }),
      ...candidates.map((candidate) =>
        audit("candidate_generated", "candidate", candidate.id, candidate.detectedSensitivity, {
          sourceId: source.id
        })
      ),
      ...state.auditEvents
    ]
  };
}

export function generateLocalAnswer(pack: ContextPack): string {
  const contextLines = pack.items.map((item) => `- ${item.itemText}`);
  const hasContext = contextLines.length > 0;
  const task = pack.taskText.toLowerCase();
  const suggestions: string[] = [];

  if (/plan|week|予定|今週|計画/.test(task)) {
    suggestions.push("今週やることを、固定予定・体力や時間の制約・期限の近いものに分けて整理しましょう。");
  }
  if (/move|moving|引っ越|住所/.test(task)) {
    suggestions.push("住所変更が必要な契約、本人確認書類、保険、勤務先や学校への連絡を確認しましょう。");
  }
  if (/job|work|転職|勤務|仕事/.test(task)) {
    suggestions.push("勤務先変更で影響する保険、福利厚生、契約、通勤、予定制約を確認しましょう。");
  }
  if (/message|メール|連絡|文章|断/.test(task)) {
    suggestions.push("相手との関係性と希望する口調に合わせ、短く、理由を言いすぎず、次の行動を明確にしましょう。");
  }
  if (suggestions.length === 0) {
    suggestions.push("背景情報に照らして、事実確認、期限、関係者、次の一手の順に整理しましょう。");
  }

  return [
    "ローカルPoCアシスタントの回答です。",
    "",
    hasContext
      ? "今回使う背景情報:"
      : "今回は保存済み背景情報が少ないため、一般的な整理として回答します。",
    ...contextLines,
    "",
    "提案:",
    ...suggestions.map((line) => `- ${line}`),
    "",
    "次に確認するとよいこと:",
    "- この回答に使ってよい背景情報が正しいか確認する",
    "- 古い情報や使いたくない情報があればVaultで修正または非表示にする",
    "- 期限や契約が関係する場合は原本のSourceを開いて確認する"
  ].join("\n");
}

export function domainLabel(domain: LifeContextDomain): string {
  return domainLabels[domain];
}

export function sensitivityLabel(sensitivity: SensitivityTier): string {
  return {
    public: "公開/低リスク",
    personal: "個人",
    private_consequential: "重要な私的情報",
    sensitive: "センシティブ",
    secret_never_send: "保存/送信不可"
  }[sensitivity];
}

export function makeDemoVault(): VaultState {
  let state = createEmptyVault();
  state = createBackgroundSource(state, {
    displayName: "Kota",
    tonePreference: "落ち着いて具体的。必要なときだけ詳しく。",
    activeLifeAreas: "仕事、生活手続き、体調に合わせた計画づくり",
    recurringConstraints: "平日は作業時間を細かく区切るほうが動きやすい",
    confirmationTopics: "健康、給付、金融に関する情報"
  });
  state = addSourceWithCandidates(state, {
    kind: "document",
    origin: "user_upload",
    title: "Sample insurance renewal note",
    body: "Insurance policy renews on 2026-08-31. Need to update address before renewal. Contact support@example.com for policy changes."
  });
  for (const candidate of state.candidates.filter((item) => item.status === "new")) {
    state = approveCandidate(state, candidate.id);
  }
  return state;
}

export async function exportEncryptedBackup(
  state: VaultState,
  passphrase: string
): Promise<string> {
  if (!passphrase.trim()) throw new Error("Passphrase is required.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const encoded = new TextEncoder().encode(JSON.stringify(state));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    encoded
  );
  const payload = {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: 120000,
    salt: toBase64(salt),
    iv: toBase64(iv),
    cipherText: toBase64(new Uint8Array(cipher))
  };
  return JSON.stringify(payload, null, 2);
}

export async function importEncryptedBackup(
  backupText: string,
  passphrase: string
): Promise<VaultState> {
  const payload = JSON.parse(backupText) as {
    version: number;
    salt: string;
    iv: string;
    cipherText: string;
  };
  if (payload.version !== 1) throw new Error("Unsupported backup version.");
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const cipherText = fromBase64(payload.cipherText);
  const key = await deriveKey(passphrase, salt);
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(cipherText)
  );
  const state = normalizeVaultState(JSON.parse(new TextDecoder().decode(clear)) as PersistedVaultState);
  if (state.version !== 2) throw new Error("Unsupported vault version.");
  return state;
}

function rankFactsForTask(state: VaultState, taskText: string): ApprovedFact[] {
  const taskDomain = classifyDomain(taskText);
  const lowerTask = taskText.toLowerCase();
  const tokens = taskText.toLowerCase().split(/\s+/).filter(Boolean);
  return state.facts
    .filter((fact) => fact.status === "active")
    .filter((fact) => fact.sensitivity !== "secret_never_send")
    .map((fact) => {
      const haystack = `${fact.factText} ${fact.domain}`.toLowerCase();
      const tokenScore = tokens.reduce(
        (sum, token) => sum + (haystack.includes(token) ? 3 : 0),
        0
      );
      const domainScore = fact.domain === taskDomain ? 4 : isStableBackgroundFact(fact) ? 1 : 0;
      const bridgeScore = crossDomainBridgeScore(lowerTask, fact.domain);
      const sensitivityPenalty = sensitivityRank[fact.sensitivity] >= 3 ? -1 : 0;
      return { fact, score: tokenScore + domainScore + bridgeScore + sensitivityPenalty };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.fact.updatedAt.localeCompare(a.fact.updatedAt))
    .map(({ fact }) => fact);
}

function crossDomainBridgeScore(task: string, domain: LifeContextDomain): number {
  if (/job|work|employer|転職|勤務先|仕事/.test(task)) {
    return [
      "contracts_and_policies",
      "procedures_and_obligations",
      "finance_and_benefits"
    ].includes(domain)
      ? 2
      : 0;
  }
  if (/move|moving|address|引っ越|住所/.test(task)) {
    return [
      "home_and_places",
      "contracts_and_policies",
      "procedures_and_obligations",
      "documents_and_evidence"
    ].includes(domain)
      ? 2
      : 0;
  }
  return 0;
}

function isStableBackgroundFact(fact: ApprovedFact): boolean {
  const stableTypes: ApprovedFact["factType"][] = [
    "identity",
    "preference",
    "relationship",
    "life_event",
    "goal",
    "routine",
    "constraint",
    "support_need",
    "place_context",
    "background_profile"
  ];
  if (!stableTypes.includes(fact.factType)) return false;
  return [
    "identity_and_profile",
    "values_goals_and_preferences",
    "life_events_and_plans",
    "routines_and_logistics",
    "home_and_places",
    "work_and_education",
    "relationships_and_household",
    "constraints_and_accessibility"
  ].includes(fact.domain);
}

function classifyDomain(text: string): LifeContextDomain {
  const lower = text.toLowerCase();
  if (/health|medical|doctor|disability|care|病院|健康|障害|介護/.test(lower)) {
    return "health_and_care";
  }
  if (/finance|benefit|pension|tax|bank|payment|money|給付|年金|税|銀行|支払/.test(lower)) {
    return "finance_and_benefits";
  }
  if (/work|job|school|employer|student|勤務|仕事|学校|転職|職場/.test(lower)) {
    return "work_and_education";
  }
  if (/family|partner|child|household|家族|配偶者|子ども|世帯/.test(lower)) {
    return "relationships_and_household";
  }
  if (/home|address|lease|rent|utility|housing|住所|住居|賃貸|家/.test(lower)) {
    return "home_and_places";
  }
  if (/contract|policy|insurance|warranty|契約|保険|保証/.test(lower)) {
    return "contracts_and_policies";
  }
  if (/deadline|submit|renew|procedure|form|期限|提出|更新|手続/.test(lower)) {
    return "procedures_and_obligations";
  }
  if (/goal|priority|preference|tone|目標|優先|好み|口調/.test(lower)) {
    return "values_goals_and_preferences";
  }
  if (/routine|schedule|habit|commute|予定|習慣|通勤/.test(lower)) {
    return "routines_and_logistics";
  }
  if (/move|moving|travel|plan|引っ越|旅行|予定|計画/.test(lower)) {
    return "life_events_and_plans";
  }
  return "documents_and_evidence";
}

function classifyRisk(text: string): ContextPack["riskLevel"] {
  const sensitivity = detectSensitivity(text);
  if (sensitivity === "sensitive" || sensitivity === "secret_never_send") return "high";
  if (sensitivity === "private_consequential") return "medium";
  if (/contract|deadline|benefit|health|legal|money|契約|期限|給付|健康|法務|お金/.test(text.toLowerCase())) {
    return "medium";
  }
  return "low";
}

function detectSensitivity(text: string): SensitivityTier {
  const lower = text.toLowerCase();
  if (/password|passcode|api key|token|secret|private key|recovery code|パスワード|秘密鍵/.test(lower)) {
    return "secret_never_send";
  }
  if (/my number|national id|bank account|口座番号|マイナンバー/.test(lower)) {
    return "secret_never_send";
  }
  if (/health|medical|doctor|diagnosis|disability|benefit|legal|minor|病院|診断|障害|給付|法律|未成年/.test(lower)) {
    return "sensitive";
  }
  if (/finance|tax|pension|insurance|contract|rent|salary|payment|税|年金|保険|契約|家賃|給与|支払/.test(lower)) {
    return "private_consequential";
  }
  if (/name|address|phone|email|family|名前|住所|電話|メール|家族/.test(lower)) {
    return "personal";
  }
  return "public";
}

function sanitizeSecretMaterial(text: string): { text: string; secretFound: boolean } {
  const patterns = [
    /\b(password|passcode|api key|token|secret|private key|recovery code)\b\s*[:=]?\s*\S+/gi,
    /(パスワード|秘密鍵)\s*[:=：]?\s*\S+/gi
  ];
  let sanitized = text;
  let secretFound = false;
  for (const pattern of patterns) {
    sanitized = sanitized.replace(pattern, () => {
      secretFound = true;
      return "[REDACTED_SECRET]";
    });
  }
  return { text: sanitized, secretFound };
}

function normalizeFactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractDate(text: string): string | undefined {
  const iso = text.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return undefined;
}

function factTypeFromCandidate(candidateType: MemoryCandidate["candidateType"]): ApprovedFact["factType"] {
  return candidateTypeToFactType(candidateType);
}

function candidateTypeToFactType(candidateType: MemoryCandidate["candidateType"]): ApprovedFact["factType"] {
  switch (candidateType) {
    case "deadline":
      return "deadline";
    case "obligation":
      return "obligation";
    case "contact_point":
      return "contact_point";
    case "preference":
      return "preference";
    case "relationship":
      return "relationship";
    case "life_event":
      return "life_event";
    case "goal":
      return "goal";
    case "routine":
      return "routine";
    case "constraint":
      return "constraint";
    case "background_profile":
      return "background_profile";
    default:
      return "note";
  }
}

function sourceTitle(state: VaultState, sourceId: string): string {
  return state.sources.find((source) => source.id === sourceId)?.title ?? "Unknown source";
}

function sourceSnippetForFact(
  state: VaultState,
  fact: ApprovedFact,
  sensitivityCeiling: SensitivityTier
): NonNullable<ContextPack["sourceSnippets"]>[number] | null {
  const source = fact.sourceIds
    .map((id) => state.sources.find((item) => item.id === id))
    .find((item): item is RawSource => item !== undefined && item.deletionState === "active");
  if (!source) return null;
  if (sensitivityRank[source.defaultSensitivity] > sensitivityRank[sensitivityCeiling]) return null;
  if (source.defaultSensitivity === "secret_never_send") return null;
  return {
    id: newId("snippet"),
    sourceId: source.id,
    title: source.title,
    text: fact.factText,
    sensitivity: source.defaultSensitivity,
    reasonIncluded: "Raw Source本文ではなく、承認済みFact本文だけを根拠として含めています。"
  };
}

function defaultConnectorSessions(createdAt: string): ConnectorSession[] {
  return [
    {
      id: "conn_claude_desktop",
      clientKind: "claude_desktop",
      clientName: "Claude Desktop",
      transport: "local_mcp",
      scopes: ["context_pack.request", "memory.propose", "policy.read", "request.status"],
      status: "available",
      createdAt
    },
    {
      id: "conn_chatgpt",
      clientKind: "chatgpt",
      clientName: "ChatGPT",
      transport: "remote_mcp_relay",
      scopes: ["context_pack.request", "memory.propose", "policy.read", "request.status"],
      status: "needs_pairing",
      createdAt
    },
    {
      id: "conn_browser_capture",
      clientKind: "generic_mcp",
      clientName: "AI Chat Browser Capture",
      transport: "browser_extension",
      scopes: ["passive_capture.write", "memory.propose"],
      status: "paused",
      createdAt
    },
    {
      id: "conn_copy_fallback",
      clientKind: "copy_fallback",
      clientName: "Copy Context Pack",
      transport: "copy_export",
      scopes: ["context_pack.request"],
      status: "available",
      createdAt
    }
  ];
}

function defaultAccessPolicies(createdAt: string): AccessPolicy[] {
  const allDomains: LifeContextDomain[] = [
    "identity_and_profile",
    "values_goals_and_preferences",
    "life_events_and_plans",
    "routines_and_logistics",
    "home_and_places",
    "documents_and_evidence",
    "contracts_and_policies",
    "procedures_and_obligations",
    "health_and_care",
    "finance_and_benefits",
    "work_and_education",
    "relationships_and_household",
    "constraints_and_accessibility"
  ];
  return [
    {
      id: "policy_claude_desktop",
      clientId: "conn_claude_desktop",
      scopes: ["context_pack.request", "memory.propose", "policy.read", "request.status"],
      domainAllowlist: allDomains,
      sensitivityCeiling: "sensitive",
      requiresApprovalAbove: "personal",
      passiveCaptureAllowed: false,
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "policy_chatgpt",
      clientId: "conn_chatgpt",
      scopes: ["context_pack.request", "memory.propose", "policy.read", "request.status"],
      domainAllowlist: allDomains,
      sensitivityCeiling: "private_consequential",
      requiresApprovalAbove: "personal",
      passiveCaptureAllowed: false,
      createdAt,
      updatedAt: createdAt
    },
    {
      id: "policy_browser_capture",
      clientId: "conn_browser_capture",
      scopes: ["passive_capture.write", "memory.propose"],
      domainAllowlist: allDomains,
      sensitivityCeiling: "personal",
      requiresApprovalAbove: "public",
      passiveCaptureAllowed: false,
      createdAt,
      updatedAt: createdAt
    }
  ];
}

function policyCeilingForClient(state: VaultState, clientId: string): SensitivityTier {
  return (
    state.accessPolicies.find((policy) => policy.clientId === clientId)?.sensitivityCeiling ??
    "private_consequential"
  );
}

function touchConnector(
  sessions: ConnectorSession[],
  clientId: string
): ConnectorSession[] {
  return sessions.map((session) =>
    session.id === clientId
      ? {
          ...session,
          status: session.status === "available" || session.status === "needs_pairing" ? "connected" : session.status,
          lastUsedAt: nowIso()
        }
      : session
  );
}

function clientLabel(client: ConnectorKind): string {
  return {
    claude_desktop: "Claude Desktop",
    chatgpt: "ChatGPT",
    claude_remote: "Claude",
    gemini: "Gemini",
    codex: "Codex",
    generic_mcp: "AI chat",
    copy_fallback: "Copy fallback"
  }[client];
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isExpired(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

function stableHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `hash_${(hash >>> 0).toString(16)}`;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
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
      salt: toArrayBuffer(salt),
      iterations: 120000,
      hash: "SHA-256"
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
