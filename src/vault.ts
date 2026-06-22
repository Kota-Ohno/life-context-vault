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
  CandidateApprovalOptions,
  FactLifecycleAction,
  FactMetadataUpdate,
  LifeContextDomain,
  MemoryCandidate,
  PassiveCaptureEvent,
  PassiveCaptureSettings,
  RawSource,
  SensitivityTier,
  SourceBodyUpdate,
  SourceLifecycleAction,
  SourceMetadataUpdate,
  SourceKind,
  VaultState
} from "./types";
import { classifySensitivity, zeroTouchEligible, SensitivityConfidence } from "./sensitivity";

export const STORAGE_KEY = "life-context-vault-poc";
const BACKUP_KDF_ITERATIONS = 600000;
const LEGACY_BACKUP_KDF_ITERATIONS = 120000;

const sensitivityRank: Record<SensitivityTier, number> = {
  public: 0,
  personal: 1,
  private_consequential: 2,
  sensitive: 3,
  secret_never_send: 4
};

function isSensitivityTier(value: unknown): value is SensitivityTier {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(sensitivityRank, value);
}

function policySensitivityValue(value: unknown, missingDefault: SensitivityTier): SensitivityTier {
  if (value === undefined || value === null || value === "") return missingDefault;
  return isSensitivityTier(value) ? value : "public";
}

function lowerSensitivityTier(left: SensitivityTier, right: SensitivityTier): SensitivityTier {
  return sensitivityRank[left] <= sensitivityRank[right] ? left : right;
}

const domainLabels: Record<LifeContextDomain, string> = {
  identity_and_profile: "本人情報",
  values_goals_and_preferences: "価値観・希望",
  life_events_and_plans: "予定・ライフイベント",
  routines_and_logistics: "日常・手配",
  home_and_places: "住まい・場所",
  documents_and_evidence: "書類・証明",
  contracts_and_policies: "契約・保険",
  procedures_and_obligations: "手続き・義務",
  health_and_care: "医療・ケア",
  finance_and_benefits: "お金・給付",
  work_and_education: "仕事・学び",
  relationships_and_household: "家族・関係",
  constraints_and_accessibility: "制約・配慮"
};

const allLifeDomains = Object.keys(domainLabels) as LifeContextDomain[];
const cautiousLifeDomains = allLifeDomains.filter(
  (domain) =>
    ![
      "identity_and_profile",
      "health_and_care",
      "finance_and_benefits",
      "constraints_and_accessibility"
    ].includes(domain)
);

function isLifeContextDomain(value: unknown): value is LifeContextDomain {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(domainLabels, value);
}

function normalizePolicyDomainAllowlist(
  value: unknown,
  fallback: LifeContextDomain[]
): LifeContextDomain[] {
  const parsed = parsePolicyDomainAllowlist(value);
  return parsed ?? [...fallback];
}

function parsePolicyDomainAllowlist(value: unknown): LifeContextDomain[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: LifeContextDomain[] = [];
  for (const item of value) {
    if (!isLifeContextDomain(item)) return null;
    if (!normalized.includes(item)) normalized.push(item);
  }
  return normalized.length > 0 ? normalized : null;
}

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
    auditEvents: [],
    classifierMigrationVersion: CLASSIFIER_MIGRATION_VERSION
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const runtimeCrypto = globalThis.crypto;
  if (runtimeCrypto?.randomUUID) {
    return `${prefix}_${runtimeCrypto.randomUUID()}`;
  }
  if (runtimeCrypto?.getRandomValues) {
    const bytes = runtimeCrypto.getRandomValues(new Uint8Array(16));
    return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("Web Crypto is required to generate Life Context Vault identifiers.");
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

const CLASSIFIER_MIGRATION_VERSION = 1;

export function normalizeFactForLoad(fact: ApprovedFact): ApprovedFact {
  return {
    ...fact,
    sensitivityClassified: fact.sensitivityClassified ?? false,
    sensitivityConfidence: fact.sensitivityConfidence ?? "low"
  };
}

export function reclassifyLegacyFacts(state: VaultState, absentClassificationIds?: Set<string>): VaultState {
  if ((state.classifierMigrationVersion ?? 0) >= CLASSIFIER_MIGRATION_VERSION) return state;
  // Only back-fill facts whose sensitivityClassified key was ABSENT in the persisted JSON
  // (truly legacy). Facts with an explicit sensitivityClassified value — even false — were
  // deliberately set and must not be silently promoted.
  const facts = state.facts.map((fact) => {
    if (absentClassificationIds && !absentClassificationIds.has(fact.id)) {
      // Field was explicitly present in persisted data: leave it untouched.
      return fact;
    }
    const r = classifySensitivity(fact.factText);
    return { ...fact, sensitivityClassified: r.classified, sensitivityConfidence: r.confidence };
  });
  return { ...state, facts, classifierMigrationVersion: CLASSIFIER_MIGRATION_VERSION };
}

export function normalizeVaultState(parsed: PersistedVaultState): VaultState {
  const empty = createEmptyVault();
  if (!parsed || typeof parsed !== "object") return empty;
  // Collect the IDs of facts whose sensitivityClassified key is ABSENT in the raw persisted
  // data before normalizeFactForLoad defaults it to false. reclassifyLegacyFacts uses this
  // set to skip facts that have an explicit (even false) value — those were deliberately set
  // and must not be silently promoted.
  const absentClassificationIds = new Set<string>(
    (parsed.facts ?? [])
      .filter((f) => f.sensitivityClassified === undefined || f.sensitivityClassified === null)
      .map((f) => f.id)
  );
  const normalized: VaultState = {
    ...empty,
    ...parsed,
    version: 2,
    sources: parsed.sources ?? [],
    candidates: (parsed.candidates ?? []).map((candidate) => ({
      ...candidate,
      conflictWithFactIds: candidate.conflictWithFactIds ?? []
    })),
    facts: (parsed.facts ?? []).map((fact) =>
      normalizeFactForLoad({
        ...fact,
        supersedesFactIds: fact.supersedesFactIds ?? []
      })
    ),
    accessPolicies: normalizeAccessPolicies(parsed.accessPolicies, empty.accessPolicies),
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
    auditEvents: parsed.auditEvents ?? [],
    classifierMigrationVersion: parsed.classifierMigrationVersion
  };
  return reclassifyLegacyFacts(normalized, absentClassificationIds);
}

function normalizeAccessPolicies(
  parsedPolicies: AccessPolicy[] | undefined,
  defaultPolicies: AccessPolicy[]
): AccessPolicy[] {
  const incoming = Array.isArray(parsedPolicies) ? parsedPolicies : [];
  const defaultClientIds = new Set(defaultPolicies.map((policy) => policy.clientId));
  const normalizedDefaults = defaultPolicies.map((defaultPolicy) => {
    const incomingPolicy = incoming.find((policy) => policy.clientId === defaultPolicy.clientId);
    if (!incomingPolicy) return normalizeAccessPolicy(defaultPolicy, defaultPolicy);
    // Restore the raw incoming standingDeliveryEnabled after the merge so the default's `true`
    // cannot silently opt in an existing vault that never had the flag set.
    const merged = { ...defaultPolicy, ...incomingPolicy, standingDeliveryEnabled: incomingPolicy.standingDeliveryEnabled };
    return normalizeAccessPolicy(merged, defaultPolicy);
  });
  const extraPolicies = incoming
    .filter((policy) => policy.clientId && !defaultClientIds.has(policy.clientId))
    .map((policy) => normalizeAccessPolicy(policy, createDefaultAccessPolicy(policy.clientId, nowIso())));
  return [...normalizedDefaults, ...extraPolicies];
}

function normalizeAccessPolicy(policy: AccessPolicy, fallbackPolicy: AccessPolicy): AccessPolicy {
  return {
    ...fallbackPolicy,
    ...policy,
    sensitivityCeiling: policySensitivityValue(policy.sensitivityCeiling, fallbackPolicy.sensitivityCeiling),
    requiresApprovalAbove: policySensitivityValue(policy.requiresApprovalAbove, fallbackPolicy.requiresApprovalAbove),
    domainAllowlist: normalizePolicyDomainAllowlist(policy.domainAllowlist, cautiousLifeDomains),
    // Preserve the policy's own value (including absent/undefined) so the fallback's `true`
    // can never silently opt in an existing vault that never had this flag set.
    standingDeliveryEnabled: policy.standingDeliveryEnabled
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
      : classifySensitivity(input.body).tier,
    processingStatus: "ready",
    deletionState: "active"
  };
  const candidates = annotateCandidateConflicts(state, extractCandidates(source));
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
    const r = classifySensitivity(line);
    // Secret indicators (api key/token/password/…) are caught by the legacy
    // detector and must always pin to secret_never_send; they are never
    // zero-touch eligible, so mark them unclassified.
    const secretTier = detectSensitivity(line) === "secret_never_send";
    const sensitivity = secretTier ? "secret_never_send" : r.tier;
    const classified = secretTier ? false : r.classified;
    const confidence = secretTier ? "low" : r.confidence;
    const status: MemoryCandidate["status"] =
      sensitivity === "sensitive" || sensitivity === "secret_never_send"
        ? "blocked_sensitive"
        : "new";
    const common = {
      id: newId("cand"),
      sourceIds: [source.id],
      detectedSensitivity: sensitivity,
      sensitivityClassified: classified,
      sensitivityConfidence: confidence,
      confidence: "medium" as const,
      createdAt: nowIso(),
      status,
      createsFactIds: [] as string[],
      conflictWithFactIds: [] as string[]
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
    const r = classifySensitivity(source.body);
    const secretTier = detectSensitivity(source.body) === "secret_never_send";
    const sensitivity = secretTier ? "secret_never_send" : r.tier;
    candidates.push({
      id: newId("cand"),
      sourceIds: [source.id],
      proposedFactText: normalizeFactText(source.body.slice(0, 220)),
      domain: classifyDomain(source.body),
      candidateType: "note",
      detectedSensitivity: sensitivity,
      sensitivityClassified: secretTier ? false : r.classified,
      sensitivityConfidence: secretTier ? "low" : r.confidence,
      confidence: "low",
      reasonToRemember: "この情報は後で背景文脈として役立つ可能性があります。",
      status:
        sensitivity === "sensitive" || sensitivity === "secret_never_send"
          ? "blocked_sensitive"
          : "new",
      createdAt: nowIso(),
      createsFactIds: [],
      conflictWithFactIds: []
    } as MemoryCandidate);
  }

  return candidates;
}

function annotateCandidateConflicts(
  state: VaultState,
  candidates: MemoryCandidate[]
): MemoryCandidate[] {
  return candidates.map((candidate) => {
    const conflictingFacts = state.facts
      .filter((fact) => fact.status === "active" && fact.domain === candidate.domain)
      .filter((fact) => candidateConflictsWithFact(candidate, fact))
      .slice(0, 4);
    if (conflictingFacts.length === 0) return candidate;
    return {
      ...candidate,
      conflictWithFactIds: conflictingFacts.map((fact) => fact.id),
      conflictReason: "既存のActive Factと日付または内容が異なる可能性があります。保存前に置き換えるか確認してください。"
    };
  });
}

function candidateConflictsWithFact(candidate: MemoryCandidate, fact: ApprovedFact): boolean {
  const candidateDate = candidate.dueDate ?? extractDate(candidate.proposedFactText);
  const factDate = fact.dueDate ?? extractDate(fact.factText);
  if (!candidateDate || !factDate || candidateDate === factDate) return false;

  const candidateKeywords = conflictKeywords(candidate.proposedFactText);
  const factKeywords = conflictKeywords(fact.factText);
  const overlap = candidateKeywords.filter((keyword) => factKeywords.includes(keyword));
  return overlap.length >= 2;
}

function conflictKeywords(text: string): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "before",
    "after",
    "need",
    "needs",
    "update",
    "updated",
    "renew",
    "renews",
    "on",
    "by",
    "to",
    "of"
  ]);
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/\d{4}-\d{2}-\d{2}/g, " ")
        .replace(/[^a-z0-9一-龠ぁ-んァ-ンー]+/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopWords.has(token))
    )
  );
}

export function approveCandidate(
  state: VaultState,
  candidateId: string,
  approval?: string | CandidateApprovalOptions
): VaultState {
  const candidate = state.candidates.find((item) => item.id === candidateId);
  if (!candidate) return state;
  if (candidate.detectedSensitivity === "secret_never_send") return state;
  if (candidate.sourceIds.some((sourceId) => state.sources.find((source) => source.id === sourceId)?.deletionState !== "active")) {
    return state;
  }

  const editedText = typeof approval === "string" ? approval : approval?.editedText;
  const supersedeFactIds = typeof approval === "string" ? [] : approval?.supersedeFactIds ?? [];
  const text = (editedText ?? candidate.proposedFactText).trim();
  if (!text) return state;
  const now = nowIso();
  const supersededIds = Array.from(new Set(supersedeFactIds)).filter((factId) =>
    state.facts.some((fact) => fact.id === factId && fact.status === "active")
  );

  const classifiedForFact = editedText ? classifySensitivity(text) : null;
  const fact: ApprovedFact = {
    id: newId("fact"),
    factText: text,
    domain: candidate.domain,
    factType: candidateTypeToFactType(candidate.candidateType),
    sourceIds: candidate.sourceIds,
    sensitivity: classifiedForFact ? classifiedForFact.tier : candidate.detectedSensitivity,
    confidence:
      candidate.sourceIds.length > 0 ? "source_backed" : "inferred_and_confirmed",
    status: "active",
    validFrom: candidate.validFrom,
    validUntil: candidate.validUntil,
    dueDate: candidate.dueDate,
    createdAt: now,
    approvedAt: now,
    updatedAt: now,
    supersedesFactIds: supersededIds,
    sensitivityClassified: classifiedForFact ? classifiedForFact.classified : (candidate.sensitivityClassified ?? false),
    sensitivityConfidence: classifiedForFact ? classifiedForFact.confidence : (candidate.sensitivityConfidence ?? "low")
  };
  const affectedFactIds = new Set(supersededIds);
  const nextPacks = invalidatePacksForFacts(state.contextPacks, affectedFactIds, {
    kind: "stale_fact",
    message: "Factが新しいFactに置き換えられたため、このContext Packは無効化されました。"
  });
  const invalidatedPacks = nextPacks.filter(
    (pack, index) => pack.confirmationStatus !== state.contextPacks[index]?.confirmationStatus
  );
  const invalidatedRequestIds = new Set(
    invalidatedPacks.map((pack) => pack.requestId).filter((requestId): requestId is string => Boolean(requestId))
  );

  return {
    ...state,
    facts: [
      fact,
      ...state.facts.map((item) =>
        supersededIds.includes(item.id)
          ? {
              ...item,
              status: "superseded" as const,
              updatedAt: now,
              supersededByFactId: fact.id
            }
          : item
      )
    ],
    candidates: state.candidates.map((item) =>
      item.id === candidateId
        ? {
            ...item,
            status:
              editedText && editedText.trim() !== item.proposedFactText
                ? "edited_and_approved"
                : "approved",
            reviewedAt: now,
            createsFactIds: [fact.id]
          }
        : item
    ),
    contextPacks: nextPacks,
    contextPackRequests: state.contextPackRequests.map((request) =>
      invalidatedRequestIds.has(request.id) ? { ...request, status: "expired" as const } : request
    ),
    auditEvents: [
      audit("candidate_reviewed", "candidate", candidate.id, candidate.detectedSensitivity, {
        action: "approved",
        supersededFactIds: supersededIds
      }),
      audit("fact_created", "fact", fact.id, fact.sensitivity, {
        candidateId: candidate.id,
        supersedesFactIds: supersededIds,
        invalidatedPackCount: invalidatedPacks.length
      }),
      ...supersededIds.map((supersededFactId) =>
        audit("fact_updated", "fact", supersededFactId, fact.sensitivity, {
          action: "superseded",
          supersededByFactId: fact.id
        })
      ),
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
  const nextPacks = isDeleting
    ? invalidatePacksForFacts(state.contextPacks, affectedFactIds, {
        kind: "source_deleted",
        message: "根拠Sourceが削除または消去されたため、このContext Packは無効化されました。"
      })
    : state.contextPacks;
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

export function updateSourceMetadata(
  state: VaultState,
  sourceId: string,
  input: SourceMetadataUpdate
): VaultState {
  const source = state.sources.find((item) => item.id === sourceId);
  const title = input.title.trim();
  if (!source || !title) return state;

  const affectedFactIds = new Set(
    state.facts.filter((fact) => fact.sourceIds.includes(sourceId)).map((fact) => fact.id)
  );
  const nextPacks = invalidatePacksForFacts(state.contextPacks, affectedFactIds, {
    kind: "stale_fact",
    message: "根拠Sourceのメタデータが更新されたため、このContext Packは無効化されました。"
  });
  const invalidatedPacks = nextPacks.filter(
    (pack, index) => pack.confirmationStatus !== state.contextPacks[index]?.confirmationStatus
  );
  const invalidatedRequestIds = new Set(
    invalidatedPacks.map((pack) => pack.requestId).filter((requestId): requestId is string => Boolean(requestId))
  );
  const promotedToLongTerm = source.retentionUntil
    ? input.promotedToLongTerm ?? source.promotedToLongTerm ?? false
    : source.promotedToLongTerm;

  return {
    ...state,
    sources: state.sources.map((item) =>
      item.id === sourceId
        ? {
            ...item,
            title,
            defaultSensitivity: input.defaultSensitivity,
            promotedToLongTerm
          }
        : item
    ),
    contextPacks: nextPacks,
    contextPackRequests: state.contextPackRequests.map((request) =>
      invalidatedRequestIds.has(request.id) ? { ...request, status: "expired" as const } : request
    ),
    auditEvents: [
      audit("source_updated", "source", sourceId, input.defaultSensitivity, {
        title,
        promotedToLongTerm,
        invalidatedPackCount: invalidatedPacks.length
      }),
      ...state.auditEvents
    ]
  };
}

export function updateSourceBody(
  state: VaultState,
  sourceId: string,
  input: SourceBodyUpdate
): VaultState {
  const source = state.sources.find((item) => item.id === sourceId);
  const body = input.body.trim();
  if (!source || source.deletionState !== "active" || !body) return state;

  const now = nowIso();
  const sanitized = sanitizeSecretMaterial(body);
  const nextSensitivity = sanitized.secretFound ? "secret_never_send" : classifySensitivity(body).tier;
  const updatedSource: RawSource = {
    ...source,
    body: sanitized.text,
    defaultSensitivity: nextSensitivity,
    processingStatus: "ready"
  };
  const reviewedFacts = state.facts.map((fact) =>
    fact.sourceIds.includes(sourceId) && fact.status === "active"
      ? {
          ...fact,
          status: "needs_review" as const,
          updatedAt: now,
          reviewReason: "source_updated" as const,
          reviewSourceId: sourceId
        }
      : fact
  );
  const newCandidates = annotateCandidateConflicts(
    { ...state, facts: reviewedFacts },
    extractCandidates(updatedSource)
  ).map((candidate) => ({
    ...candidate,
    createdAt: now
  }));
  const archivedCandidates = state.candidates.map((candidate) =>
    candidate.sourceIds.includes(sourceId) &&
    ["new", "needs_user_detail", "blocked_sensitive"].includes(candidate.status)
      ? { ...candidate, status: "archived" as const, reviewedAt: now }
      : candidate
  );
  const affectedFactIds = new Set(
    state.facts.filter((fact) => fact.sourceIds.includes(sourceId)).map((fact) => fact.id)
  );
  const nextPacks = invalidatePacksForFacts(state.contextPacks, affectedFactIds, {
    kind: "stale_fact",
    message: "根拠Source本文が更新されたため、このContext Packは無効化されました。"
  });
  const invalidatedPacks = nextPacks.filter(
    (pack, index) => pack.confirmationStatus !== state.contextPacks[index]?.confirmationStatus
  );
  const invalidatedRequestIds = new Set(
    invalidatedPacks.map((pack) => pack.requestId).filter((requestId): requestId is string => Boolean(requestId))
  );

  return {
    ...state,
    sources: state.sources.map((item) => (item.id === sourceId ? updatedSource : item)),
    candidates: [...newCandidates, ...archivedCandidates],
    facts: reviewedFacts,
    contextPacks: nextPacks,
    contextPackRequests: state.contextPackRequests.map((request) =>
      invalidatedRequestIds.has(request.id) ? { ...request, status: "expired" as const } : request
    ),
    auditEvents: [
      audit("source_updated", "source", sourceId, nextSensitivity, {
        title: source.title,
        action: "body_reextracted",
        candidateCount: newCandidates.length,
        affectedFactCount: affectedFactIds.size,
        invalidatedPackCount: invalidatedPacks.length
      }),
      ...newCandidates.map((candidate) =>
        audit("candidate_generated", "candidate", candidate.id, candidate.detectedSensitivity, {
          sourceId,
          regenerated: true
        })
      ),
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
    ? invalidatePacksForFacts(state.contextPacks, affectedFactIds, {
        kind: "stale_fact",
        message: "Factの表示状態が変更されたため、このContext Packは無効化されました。"
      })
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

export function updateFactMetadata(
  state: VaultState,
  factId: string,
  input: FactMetadataUpdate
): VaultState {
  const fact = state.facts.find((item) => item.id === factId);
  const factText = input.factText.trim();
  if (!fact || !factText || input.sensitivity === "secret_never_send") return state;

  const now = nowIso();

  // Task 7: re-run classifier when factText changes; clear classification on manual
  // sensitivity override so the gate knows the item has not been auto-classified.
  // Branch order mirrors Rust update_fact_metadata_at_path:
  //   1. Manual sensitivity override (wins even when text also changed) → classified=false, confidence=low
  //   2. Text-only change → re-classify with the new text
  //   3. Domain-only or no-change edit → leave classification fields untouched
  let classificationPatch: Partial<Pick<ApprovedFact, "sensitivityClassified" | "sensitivityConfidence">>;
  if (input.sensitivity !== fact.sensitivity) {
    // Manual override: caller explicitly chose a different sensitivity tier.
    classificationPatch = { sensitivityClassified: false, sensitivityConfidence: "low" };
  } else if (factText !== fact.factText) {
    // Text changed, sensitivity not overridden: re-classify the new text.
    const r = classifySensitivity(factText);
    classificationPatch = { sensitivityClassified: r.classified, sensitivityConfidence: r.confidence };
  } else {
    // No change to sensitivity or text (e.g. domain-only edit): leave classification as-is.
    classificationPatch = {};
  }

  const affectedFactIds = new Set([factId]);
  const nextPacks = invalidatePacksForFacts(state.contextPacks, affectedFactIds, {
    kind: "stale_fact",
    message: "Factが更新されたため、このContext Packは無効化されました。"
  });
  const invalidatedPacks = nextPacks.filter(
    (pack, index) => pack.confirmationStatus !== state.contextPacks[index]?.confirmationStatus
  );
  const invalidatedRequestIds = new Set(
    invalidatedPacks.map((pack) => pack.requestId).filter((requestId): requestId is string => Boolean(requestId))
  );
  return {
    ...state,
    facts: state.facts.map((item) =>
      item.id === factId
        ? {
            ...item,
            factText,
            domain: input.domain,
            sensitivity: input.sensitivity,
            ...classificationPatch,
            validFrom: blankToUndefined(input.validFrom),
            validUntil: blankToUndefined(input.validUntil),
            dueDate: blankToUndefined(input.dueDate),
            updatedAt: now
          }
        : item
    ),
    contextPacks: nextPacks,
    contextPackRequests: state.contextPackRequests.map((request) =>
      invalidatedRequestIds.has(request.id) ? { ...request, status: "expired" as const } : request
    ),
    auditEvents: [
      audit("fact_updated", "fact", factId, input.sensitivity, {
        action: "metadata_updated",
        invalidatedPackCount: invalidatedPacks.length
      }),
      ...state.auditEvents
    ]
  };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function factStatusForAction(action: FactLifecycleAction): ApprovedFact["status"] {
  if (action === "keep_active" || action === "restore") return "active";
  if (action === "hide") return "user_hidden";
  if (action === "delete") return "deleted";
  return "needs_review";
}

function invalidatePacksForFacts(
  packs: VaultState["contextPacks"],
  affectedFactIds: Set<string>,
  warning: { kind: "source_deleted" | "stale_fact"; message: string }
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
          kind: warning.kind,
          message: warning.message,
          relatedIds: Array.from(affectedFactIds)
        },
        ...pack.warnings
      ]
    };
  });
}

function invalidatePacksForClientPolicy(
  packs: VaultState["contextPacks"],
  requests: VaultState["contextPackRequests"],
  clientId: string
): {
  packs: VaultState["contextPacks"];
  requests: VaultState["contextPackRequests"];
  invalidatedCount: number;
} {
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  const requestIdsForClient = new Set(
    requests.filter((request) => request.clientId === clientId).map((request) => request.id)
  );
  if (requestIdsForClient.size === 0) {
    return { packs, requests, invalidatedCount: 0 };
  }

  const invalidatedRequestIds = new Set<string>();
  const nextPacks = packs.map((pack) => {
    if (!pack.requestId || !requestIdsForClient.has(pack.requestId) || pack.confirmationStatus === "cancelled") {
      return pack;
    }
    const request = requestsById.get(pack.requestId);
    if (isExpired(pack.expiresAt ?? request?.expiresAt ?? "")) return pack;
    invalidatedRequestIds.add(pack.requestId);
    return {
      ...pack,
      confirmationStatus: "cancelled" as const,
      confirmedAt: undefined,
      warnings: [
        {
          kind: "policy_limited" as const,
          message: "AI接続ポリシーが更新されたため、このContext Packは無効化されました。新しいContext Packを作成してください。",
          relatedIds: [clientId]
        },
        ...pack.warnings
      ]
    };
  });
  const nextRequests = requests.map((request) =>
    invalidatedRequestIds.has(request.id) ? { ...request, status: "expired" as const } : request
  );
  return {
    packs: nextPacks,
    requests: nextRequests,
    invalidatedCount: invalidatedRequestIds.size
  };
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
    sensitivityCeiling: "sensitive",
    requiresApprovalAbove: "personal"
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
  const policyCeiling = policyCeilingForClient(state, input.clientId);
  const requestedCeiling =
    input.sensitivityCeiling === undefined
      ? policyCeiling
      : policySensitivityValue(input.sensitivityCeiling, "public");
  const request: ContextPackRequest = {
    id: newId("req"),
    clientId: input.clientId,
    clientName: input.clientName,
    taskText: input.taskText,
    purpose: input.purpose ?? "Answer with user-approved life context",
    requestedDomains: input.requestedDomains ?? [classifyDomain(input.taskText)],
    sensitivityCeiling: lowerSensitivityTier(policyCeiling, requestedCeiling),
    approvalMode: input.approvalMode ?? connectionApprovalMode(state, input.clientId),
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
    approvalMode: request.approvalMode,
    domainAllowlist: policyDomainAllowlistForClient(state, request.clientId),
    requiresApprovalAbove: policyRequiresApprovalAboveForClient(state, request.clientId),
    zeroTouchConfidenceBar: policyZeroTouchConfidenceBarForClient(state, request.clientId)
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
    domainAllowlist?: LifeContextDomain[];
    requiresApprovalAbove?: SensitivityTier;
    clientId?: string;
    approvalMode?: ContextPackRequest["approvalMode"];
    zeroTouchConfidenceBar?: SensitivityConfidence;
  }
): ContextPack {
  const sensitivityCeiling = policySensitivityValue(options.sensitivityCeiling, "public");
  const requiresApprovalAbove = policySensitivityValue(
    options.requiresApprovalAbove ?? "personal",
    "personal"
  );
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
    if (sensitivityRank[fact.sensitivity] > sensitivityRank[sensitivityCeiling]) {
      excludedItems.push({ referencedId: fact.id, reason: "sensitivity_policy" });
      continue;
    }
    if (
      options.domainAllowlist &&
      options.domainAllowlist.length > 0 &&
      !options.domainAllowlist.includes(fact.domain)
    ) {
      excludedItems.push({ referencedId: fact.id, reason: "domain_policy" });
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
      sensitivityClassified: fact.sensitivityClassified,
      sensitivityConfidence: fact.sensitivityConfidence,
      sourceTitles: sourceTitlesForFact(state, fact, sensitivityCeiling),
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      confidence: fact.confidence
    });
    const snippet = sourceSnippetForFact(state, fact, sensitivityCeiling);
    if (snippet) sourceSnippets.push(snippet);
  }

  warnings.push(...warningsForContextItems(state, items, excludedItems));
  const maxSensitivityIncluded = maxSensitivityForContextItems(items);

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
      !items.every((item) =>
        zeroTouchEligible(item, {
          requiresApprovalAbove,
          zeroTouchConfidenceBar: options.zeroTouchConfidenceBar
        })
      )
        ? "pending_user_confirmation"
        : "not_required"
  };
}

function removeFactFromPack(
  state: VaultState,
  pack: ContextPack,
  factId: string,
  sensitivityCeiling: SensitivityTier
): ContextPack {
  if (!pack.items.some((item) => item.factId === factId)) return pack;
  const items = pack.items.filter((item) => item.factId !== factId);
  const excludedItems = pack.excludedItems.some(
    (item) => item.referencedId === factId && item.reason === "user_hidden"
  )
    ? pack.excludedItems
    : [{ referencedId: factId, reason: "user_hidden" as const }, ...pack.excludedItems];
  return refreshEditedContextPack(state, pack, items, excludedItems, sensitivityCeiling);
}

function restoreFactToPack(
  state: VaultState,
  pack: ContextPack,
  factId: string,
  sensitivityCeiling: SensitivityTier,
  domainAllowlist?: LifeContextDomain[]
): ContextPack {
  if (pack.items.some((item) => item.factId === factId)) return pack;
  const fact = state.facts.find((item) => item.id === factId);
  if (!fact || !factEligibleForContextPack(fact, sensitivityCeiling)) return pack;
  if (domainAllowlist && domainAllowlist.length > 0 && !domainAllowlist.includes(fact.domain)) {
    return pack;
  }
  const restoredItem = contextPackItemForFact(state, fact, pack.taskDomain, sensitivityCeiling);
  const items = [...pack.items, restoredItem].sort((a, b) =>
    contextPackFactOrder(state, pack, a.factId) - contextPackFactOrder(state, pack, b.factId)
  );
  const excludedItems = pack.excludedItems.filter(
    (item) => !(item.referencedId === factId && item.reason === "user_hidden")
  );
  return refreshEditedContextPack(state, pack, items, excludedItems, sensitivityCeiling);
}

function refreshEditedContextPack(
  state: VaultState,
  pack: ContextPack,
  items: ContextPackItem[],
  excludedItems: ContextPack["excludedItems"],
  sensitivityCeiling: SensitivityTier
): ContextPack {
  return {
    ...pack,
    items,
    sourceSnippets: sourceSnippetsForContextItems(state, items, sensitivityCeiling),
    excludedItems,
    warnings: warningsForContextItems(state, items, excludedItems),
    maxSensitivityIncluded: maxSensitivityForContextItems(items),
    confirmationStatus: "edited_by_user",
    confirmedAt: undefined,
    localAnswer: undefined
  };
}

function contextPackItemForFact(
  state: VaultState,
  fact: ApprovedFact,
  taskDomain: ContextPack["taskDomain"],
  sensitivityCeiling: SensitivityTier
): ContextPackItem {
  return {
    id: newId("ctxitem"),
    factId: fact.id,
    itemText: fact.factText,
    reasonIncluded:
      fact.domain === taskDomain
        ? "質問の領域と一致しています。"
        : "本人の背景情報として回答を調整できます。",
    sensitivity: fact.sensitivity,
    sensitivityClassified: fact.sensitivityClassified,
    sensitivityConfidence: fact.sensitivityConfidence,
    sourceTitles: sourceTitlesForFact(state, fact, sensitivityCeiling),
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    confidence: fact.confidence
  };
}

function factEligibleForContextPack(fact: ApprovedFact, sensitivityCeiling: SensitivityTier): boolean {
  return (
    fact.status === "active" &&
    fact.sensitivity !== "secret_never_send" &&
    sensitivityRank[fact.sensitivity] <= sensitivityRank[sensitivityCeiling] &&
    !(fact.validUntil && isExpired(fact.validUntil))
  );
}

function sourceSnippetsForContextItems(
  state: VaultState,
  items: ContextPackItem[],
  sensitivityCeiling: SensitivityTier
): NonNullable<ContextPack["sourceSnippets"]> {
  const snippets: NonNullable<ContextPack["sourceSnippets"]> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const fact = state.facts.find((fact) => fact.id === item.factId);
    if (!fact) continue;
    const snippet = sourceSnippetForFact(state, fact, sensitivityCeiling);
    if (!snippet || seen.has(snippet.id)) continue;
    snippets.push(snippet);
    seen.add(snippet.id);
  }
  return snippets;
}

function warningsForContextItems(
  state: VaultState,
  items: ContextPackItem[],
  excludedItems: ContextPack["excludedItems"]
): ContextPack["warnings"] {
  const warnings: ContextPack["warnings"] = [];
  const sensitiveIds = items
    .filter((item) => sensitivityRank[item.sensitivity] >= 2)
    .map((item) => item.factId);
  if (sensitiveIds.length > 0) {
    warnings.push({
      kind: "sensitive_context",
      message: "このContext Packには私的またはセンシティブな背景情報が含まれます。",
      relatedIds: sensitiveIds
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
  const excludedExpiredIds = excludedItems
    .filter((item) => item.reason === "expired")
    .map((item) => item.referencedId);
  if (excludedExpiredIds.length > 0) {
    warnings.push({
      kind: "stale_fact",
      message: "期限切れまたは古い可能性がある背景情報は除外されました。",
      relatedIds: excludedExpiredIds
    });
  }
  const policyLimitedIds = excludedItems
    .filter((item) => item.reason === "sensitivity_policy" || item.reason === "domain_policy")
    .map((item) => item.referencedId);
  if (policyLimitedIds.length > 0) {
    warnings.push({
      kind: "policy_limited",
      message: "一部の背景情報はAI接続の感度ポリシーにより除外されました。",
      relatedIds: policyLimitedIds
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
  return warnings;
}

function maxSensitivityForContextItems(items: ContextPackItem[]): SensitivityTier {
  return items.reduce<SensitivityTier>(
    (max, item) =>
      sensitivityRank[item.sensitivity] > sensitivityRank[max] ? item.sensitivity : max,
    "public"
  );
}

function contextPackFactOrder(state: VaultState, pack: ContextPack, factId: string): number {
  const currentIndex = pack.items.findIndex((item) => item.factId === factId);
  if (currentIndex >= 0) return currentIndex;
  const fact = state.facts.find((item) => item.id === factId);
  if (!fact) return Number.MAX_SAFE_INTEGER;
  return state.facts.findIndex((item) => item.id === fact.id) + pack.items.length;
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
  if (pack.confirmationStatus === "cancelled") return state;
  const request = pack.requestId
    ? state.contextPackRequests.find((item) => item.id === pack.requestId)
    : null;
  if (isExpired(pack.expiresAt ?? request?.expiresAt ?? "")) {
    return {
      ...state,
      contextPackRequests: state.contextPackRequests.map((item) =>
        pack.requestId && item.id === pack.requestId ? { ...item, status: "expired" as const } : item
      )
    };
  }
  const policyViolation = contextPackPolicyViolation(state, pack);
  if (policyViolation) {
    return cancelContextPackForPolicyViolation(state, pack, policyViolation);
  }
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
        ...contextPackReceiptMetadata(state, pack),
        deliveryStatus: "available_for_ai"
      }),
      ...state.auditEvents
    ]
  };
}

export function recordContextPackDelivery(
  state: VaultState,
  packId: string,
  input: {
    channel: "clipboard_copy" | "relay_handoff";
    status: "copied" | "registered" | "failed" | "skipped";
    ttlSeconds?: number | null;
    relayExpiresAt?: number | null;
    message?: string;
  }
): VaultState {
  const pack = state.contextPacks.find((item) => item.id === packId);
  if (!pack) return state;
  const metadata = {
    ...contextPackReceiptMetadata(state, pack),
    deliveryChannel: input.channel,
    deliveryStatus: input.status,
    ttlSeconds: input.ttlSeconds ?? null,
    relayExpiresAt: input.relayExpiresAt ?? null,
    message: input.message,
    bodyStoredInAudit: false
  };
  return {
    ...state,
    auditEvents: [
      audit("context_pack_delivered", "context_pack", pack.id, pack.maxSensitivityIncluded, metadata),
      ...state.auditEvents
    ]
  };
}

export function canSendContextPackToAi(state: VaultState, pack: ContextPack): boolean {
  return pack.confirmationStatus === "confirmed" && contextPackPolicyViolation(state, pack) === null;
}

function contextPackPolicyViolation(
  state: VaultState,
  pack: ContextPack
): "domain_policy" | "sensitivity_policy" | "deleted" | "expired" | null {
  const request = pack.requestId
    ? state.contextPackRequests.find((item) => item.id === pack.requestId)
    : null;
  if (!request) return "deleted";
  if (request.status === "denied" || request.status === "expired") return "expired";
  if (isExpired(pack.expiresAt ?? request.expiresAt)) return "expired";
  const currentCeiling = lowerSensitivityTier(
    policyCeilingForClient(state, request.clientId),
    request.sensitivityCeiling
  );
  const domainAllowlist = policyDomainAllowlistForClient(state, request.clientId);
  for (const item of pack.items) {
    const fact = state.facts.find((candidate) => candidate.id === item.factId);
    if (!fact) return "deleted";
    if (fact.status !== "active") return "deleted";
    if (fact.sensitivity === "secret_never_send") return "sensitivity_policy";
    if (fact.validUntil && isExpired(fact.validUntil)) return "expired";
    if (item.itemText !== fact.factText) return "deleted";
    if (item.validFrom !== fact.validFrom || item.validUntil !== fact.validUntil) return "deleted";
    if (sensitivityRank[item.sensitivity] > sensitivityRank[currentCeiling]) return "sensitivity_policy";
    if (sensitivityRank[fact.sensitivity] > sensitivityRank[currentCeiling]) return "sensitivity_policy";
    if (!domainAllowlist.includes(fact.domain)) return "domain_policy";
    if (fact.sourceIds.length > 0) {
      const hasAiEligibleSource = fact.sourceIds.some((sourceId) => {
        const source = state.sources.find((candidate) => candidate.id === sourceId);
        // A source-backed fact stays deliverable as long as it still has a live,
        // non-secret source. The fact's OWN sensitivity is already gated against the
        // client ceiling above; the source's cautious *default* sensitivity is only a
        // pre-approval heuristic and must not override the user's explicit fact-level
        // approval here — otherwise a pack containing any fact derived from a
        // cautiously-classified source could never be approved for AI.
        return (
          source?.deletionState === "active" &&
          source.defaultSensitivity !== "secret_never_send"
        );
      });
      if (!hasAiEligibleSource) return "deleted";
    }
  }
  // After all per-item checks pass, check zero-touch degradation.
  // Only fail if an item was classified at build time but is now unclassified
  // (a previously-verified fact silently becoming unverified is a fail-closed signal).
  for (const item of pack.items) {
    const fact = state.facts.find((candidate) => candidate.id === item.factId);
    if (!fact) continue; // already caught above
    const itemWasClassified = item.sensitivityClassified ?? false;
    const factIsNowClassified = fact.sensitivityClassified ?? false;
    if (itemWasClassified && !factIsNowClassified) return "sensitivity_policy";
  }
  return null;
}

function cancelContextPackForPolicyViolation(
  state: VaultState,
  pack: ContextPack,
  reason: "domain_policy" | "sensitivity_policy" | "deleted" | "expired"
): VaultState {
  const message =
    reason === "expired"
      ? "Context Packの有効期限が切れました。新しいContext Packを作成してください。"
      : "現在のAI接続ポリシーでは、このContext PackはAIに渡せません。新しいContext Packを作成してください。";
  return {
    ...state,
    contextPacks: state.contextPacks.map((item) =>
      item.id === pack.id
        ? {
            ...item,
            confirmationStatus: "cancelled" as const,
            confirmedAt: undefined,
            warnings: [
              {
                kind: reason === "expired" || reason === "deleted" ? "stale_fact" as const : "policy_limited" as const,
                message,
                relatedIds: [pack.requestId ?? pack.id]
              },
              ...item.warnings
            ]
          }
        : item
    ),
    contextPackRequests: state.contextPackRequests.map((item) =>
      pack.requestId && item.id === pack.requestId ? { ...item, status: "expired" as const } : item
    ),
    auditEvents: [
      audit("context_pack_updated", "context_pack", pack.id, pack.maxSensitivityIncluded, {
        action: "policy_invalidated",
        reason,
        ...contextPackReceiptMetadata(state, pack)
      }),
      ...state.auditEvents
    ]
  };
}

function contextPackReceiptMetadata(state: VaultState, pack: ContextPack): Record<string, unknown> {
  const request = pack.requestId
    ? state.contextPackRequests.find((item) => item.id === pack.requestId)
    : null;
  const includedDomains = Array.from(
    new Set(
      pack.items
        .map((item) => state.facts.find((fact) => fact.id === item.factId)?.domain)
        .filter(isLifeContextDomain)
    )
  );
  return {
    requestId: pack.requestId,
    packId: pack.id,
    clientId: request?.clientId ?? null,
    clientName: request?.clientName ?? null,
    requestStatus: request?.status ?? null,
    taskDomain: pack.taskDomain,
    itemCount: pack.items.length,
    sourceSnippetCount: pack.sourceSnippets?.length ?? 0,
    excludedCount: pack.excludedItems.length,
    warningCount: pack.warnings.length,
    includedDomains,
    maxSensitivityIncluded: pack.maxSensitivityIncluded,
    confirmationStatus: pack.confirmationStatus,
    expiresAt: pack.expiresAt ?? request?.expiresAt ?? null,
    trustBoundary: "ContextPack only",
    bodyStoredInAudit: false,
    rawSourceIncluded: false,
    unapprovedCandidateIncluded: false
  };
}

export function updateContextPackItemVisibility(
  state: VaultState,
  packId: string,
  factId: string,
  included: boolean
): VaultState {
  const pack = state.contextPacks.find((item) => item.id === packId);
  if (!pack || pack.confirmationStatus === "cancelled" || pack.confirmationStatus === "confirmed") {
    return state;
  }
  const request = pack.requestId
    ? state.contextPackRequests.find((item) => item.id === pack.requestId)
    : null;
  if (request && ["denied", "expired", "fulfilled"].includes(request.status)) {
    return state;
  }

  const ceiling = policySensitivityValue(request?.sensitivityCeiling ?? pack.maxSensitivityIncluded, "public");
  const domainAllowlist = request ? policyDomainAllowlistForClient(state, request.clientId) : undefined;
  const nextPack = included
    ? restoreFactToPack(state, pack, factId, ceiling, domainAllowlist)
    : removeFactFromPack(state, pack, factId, ceiling);
  if (nextPack === pack) return state;

  return {
    ...state,
    contextPacks: state.contextPacks.map((item) => (item.id === packId ? nextPack : item)),
    contextPackRequests: state.contextPackRequests.map((item) =>
      pack.requestId && item.id === pack.requestId ? { ...item, status: "pending_user_confirmation" as const } : item
    ),
    auditEvents: [
      audit("context_pack_updated", "context_pack", packId, nextPack.maxSensitivityIncluded, {
        requestId: pack.requestId,
        factId,
        action: included ? "restored_item" : "excluded_item",
        itemCount: nextPack.items.length,
        excludedCount: nextPack.excludedItems.length
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
    excludedItems: sanitizeContextExclusionsForAi(pack.excludedItems),
    confirmationStatus: pack.confirmationStatus
  };
}

function sanitizeContextExclusionsForAi(excludedItems: ContextPack["excludedItems"]): AiContextPackPayload["excludedItems"] {
  return excludedItems.map((item) => ({ reason: item.reason }));
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
        requestId: request.id,
        clientId: request.clientId,
        clientName: request.clientName,
        deliveryStatus: "denied",
        trustBoundary: "ContextPack only",
        bodyStoredInAudit: false,
        rawSourceIncluded: false,
        unapprovedCandidateIncluded: false
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
  settings: Partial<Pick<AccessPolicy, "sensitivityCeiling" | "requiresApprovalAbove" | "passiveCaptureAllowed" | "domainAllowlist" | "standingDeliveryEnabled">>
): VaultState {
  const now = nowIso();
  const existingPolicy = state.accessPolicies.find((policy) => policy.clientId === clientId);
  const currentPolicy = normalizeAccessPolicy(
    existingPolicy ?? createDefaultAccessPolicy(clientId, now),
    existingPolicy ?? createDefaultAccessPolicy(clientId, now)
  );
  const nextDomainAllowlist =
    settings.domainAllowlist === undefined ? currentPolicy.domainAllowlist : parsePolicyDomainAllowlist(settings.domainAllowlist);
  if (!nextDomainAllowlist) return state;
  const updatedPolicy: AccessPolicy = {
    ...currentPolicy,
    ...settings,
    domainAllowlist: nextDomainAllowlist,
    updatedAt: now
  };
  const accessPolicies = existingPolicy
    ? state.accessPolicies.map((policy) => (policy.clientId === clientId ? updatedPolicy : policy))
    : [updatedPolicy, ...state.accessPolicies];
  const invalidated = invalidatePacksForClientPolicy(state.contextPacks, state.contextPackRequests, clientId);
  return {
    ...state,
    accessPolicies,
    contextPacks: invalidated.packs,
    contextPackRequests: invalidated.requests,
    auditEvents: [
      audit("policy_updated", "policy", updatedPolicy.id, updatedPolicy.sensitivityCeiling, {
        clientId,
        sensitivityCeiling: updatedPolicy.sensitivityCeiling,
        requiresApprovalAbove: updatedPolicy.requiresApprovalAbove,
        domainAllowlist: updatedPolicy.domainAllowlist,
        domainAllowlistCount: updatedPolicy.domainAllowlist.length,
        passiveCaptureAllowed: updatedPolicy.passiveCaptureAllowed,
        invalidatedPackCount: invalidated.invalidatedCount
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
      : classifySensitivity(input.text).tier,
    processingStatus: "ready",
    deletionState: "active"
  };
  const candidates = annotateCandidateConflicts(state, extractCandidates(source));
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
    defaultSensitivity: classifySensitivity(input.text).tier,
    processingStatus: "ready",
    deletionState: "active"
  };
  const candidates = annotateCandidateConflicts(state, extractCandidates(source));
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
    "ローカル回答です。",
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

// ── Activity Timeline (pure selector for Home disclosure ledger) ──────────────

export type TimelineDisclosure = "auto" | "pending" | "confirmed" | "cancelled";

export type TimelineFact = {
  factId: string;
  text: string;
  category: string;
  sensitivity: SensitivityTier;
};

export type TimelineEntry = {
  packId: string;
  requestId?: string;
  clientId: string;
  clientName: string;
  task: string;
  at: string;
  disclosure: TimelineDisclosure;
  maxSensitivity: SensitivityTier;
  facts: TimelineFact[];
};

export type TimelineDay = {
  dayKey: string;
  label: string;
  entries: TimelineEntry[];
};

/**
 * Derives the Home disclosure-ledger timeline from VaultState.
 *
 * @param state      - current VaultState
 * @param opts.scope - "week" (default, last 7 days) | "month" (~31 days) | "all"
 * @param opts.now   - override "now" for testing (ISO string or Date); default new Date()
 */
export function buildActivityTimeline(
  state: VaultState,
  opts?: { scope?: "week" | "month" | "all"; now?: string | Date }
): TimelineDay[] {
  const scope = opts?.scope ?? "week";
  const now = opts?.now ? new Date(opts.now) : new Date();

  // Compute earliest allowed timestamp by scope
  let cutoffMs: number | null = null;
  if (scope === "week") {
    cutoffMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  } else if (scope === "month") {
    cutoffMs = now.getTime() - 31 * 24 * 60 * 60 * 1000;
  }

  // Lookup maps
  const factById = new Map<string, ApprovedFact>();
  for (const f of state.facts) {
    factById.set(f.id, f);
  }
  const requestById = new Map<string, ContextPackRequest>();
  for (const r of state.contextPackRequests) {
    requestById.set(r.id, r);
  }

  // Map confirmationStatus → TimelineDisclosure
  function toDisclosure(
    status: ContextPack["confirmationStatus"]
  ): TimelineDisclosure {
    if (status === "not_required") return "auto";
    if (status === "confirmed" || status === "edited_by_user") return "confirmed";
    if (status === "pending_user_confirmation") return "pending";
    if (status === "cancelled") return "cancelled";
    return "confirmed";
  }

  // Highest sensitivity tier among an array (fallback "public")
  const sensitivityOrder: SensitivityTier[] = [
    "public",
    "personal",
    "private_consequential",
    "sensitive",
    "secret_never_send",
  ];
  function highestSensitivity(tiers: SensitivityTier[]): SensitivityTier {
    let best = 0;
    for (const t of tiers) {
      const rank = sensitivityOrder.indexOf(t);
      if (rank > best) best = rank;
    }
    return sensitivityOrder[best];
  }

  // Build entries, applying scope filter
  const entries: TimelineEntry[] = [];
  for (const pack of state.contextPacks) {
    const at = pack.confirmedAt ?? pack.generatedAt;
    if (cutoffMs !== null && new Date(at).getTime() < cutoffMs) {
      continue;
    }

    const request = pack.requestId ? requestById.get(pack.requestId) : undefined;
    const clientId = request?.clientId ?? "";
    const clientName = request?.clientName ?? "不明なクライアント";
    const task = request?.taskText ?? pack.taskText ?? "";

    const facts: TimelineFact[] = pack.items.map((item) => {
      const fact = factById.get(item.factId);
      const domain = fact?.domain;
      const category = domain ? domainLabel(domain) : "";
      return {
        factId: item.factId,
        text: item.itemText,
        sensitivity: item.sensitivity,
        category,
      };
    });

    const maxSensitivity: SensitivityTier =
      pack.maxSensitivityIncluded ??
      highestSensitivity(facts.map((f) => f.sensitivity));

    entries.push({
      packId: pack.id,
      requestId: pack.requestId,
      clientId,
      clientName,
      task,
      at,
      disclosure: toDisclosure(pack.confirmationStatus),
      maxSensitivity,
      facts,
    });
  }

  // Group by local calendar day of `at`
  const dayMap = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const d = new Date(entry.at);
    const dayKey = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
    const bucket = dayMap.get(dayKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      dayMap.set(dayKey, [entry]);
    }
  }

  // Compute today/yesterday keys in local time
  const todayKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const yd = new Date(now);
  yd.setDate(yd.getDate() - 1);
  const yesterdayKey = [
    yd.getFullYear(),
    String(yd.getMonth() + 1).padStart(2, "0"),
    String(yd.getDate()).padStart(2, "0"),
  ].join("-");

  function dayLabel(key: string): string {
    if (key === todayKey) return "今日";
    if (key === yesterdayKey) return "昨日";
    const [, mm, dd] = key.split("-");
    return `${parseInt(mm, 10)}月${parseInt(dd, 10)}日`;
  }

  // Sort days descending; within each day sort entries descending by `at`
  return Array.from(dayMap.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([dayKey, dayEntries]) => ({
      dayKey,
      label: dayLabel(dayKey),
      entries: dayEntries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)),
    }));
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
  validateBackupPassphrase(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, BACKUP_KDF_ITERATIONS);
  const encoded = new TextEncoder().encode(JSON.stringify(state));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    encoded
  );
  const payload = {
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: BACKUP_KDF_ITERATIONS,
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
    iterations?: number;
    salt: string;
    iv: string;
    cipherText: string;
  };
  if (payload.version !== 1) throw new Error("Unsupported backup version.");
  const iterations =
    Number.isFinite(payload.iterations) && payload.iterations && payload.iterations > 0
      ? payload.iterations
      : LEGACY_BACKUP_KDF_ITERATIONS;
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const cipherText = fromBase64(payload.cipherText);
  const key = await deriveKey(passphrase, salt, iterations);
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

function sourceTitlesForFact(
  state: VaultState,
  fact: ApprovedFact,
  sensitivityCeiling: SensitivityTier
): string[] {
  return fact.sourceIds
    .map((id) => state.sources.find((source) => source.id === id))
    .filter((source): source is RawSource => Boolean(source))
    .filter((source) => source.deletionState === "active")
    .filter((source) => source.defaultSensitivity !== "secret_never_send")
    .filter((source) => sensitivityRank[source.defaultSensitivity] <= sensitivityRank[sensitivityCeiling])
    .map((source) => source.title);
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
  return [
    createDefaultAccessPolicy("conn_claude_desktop", createdAt),
    createDefaultAccessPolicy("conn_chatgpt", createdAt),
    createDefaultAccessPolicy("conn_browser_capture", createdAt),
    createDefaultAccessPolicy("conn_copy_fallback", createdAt)
  ];
}

function createDefaultAccessPolicy(clientId: string, createdAt: string): AccessPolicy {
  return {
    id: `policy_${clientId.replace(/^conn_/, "")}`,
    clientId,
    scopes:
      clientId === "conn_browser_capture"
        ? ["passive_capture.write", "memory.propose"]
        : ["context_pack.request", "memory.propose", "policy.read", "request.status"],
    domainAllowlist: [...allLifeDomains],
    sensitivityCeiling:
      clientId === "conn_claude_desktop"
        ? "sensitive"
        : clientId === "conn_browser_capture"
          ? "personal"
          : "private_consequential",
    requiresApprovalAbove: clientId === "conn_browser_capture" ? "public" : "personal",
    passiveCaptureAllowed: false,
    standingDeliveryEnabled: true,
    createdAt,
    updatedAt: createdAt
  };
}

function policyCeilingForClient(state: VaultState, clientId: string): SensitivityTier {
  return policySensitivityValue(
    state.accessPolicies.find((policy) => policy.clientId === clientId)?.sensitivityCeiling,
    "private_consequential"
  );
}

function policyDomainAllowlistForClient(state: VaultState, clientId: string): LifeContextDomain[] {
  return normalizePolicyDomainAllowlist(
    state.accessPolicies.find((policy) => policy.clientId === clientId)?.domainAllowlist,
    cautiousLifeDomains
  );
}

function policyRequiresApprovalAboveForClient(state: VaultState, clientId: string): SensitivityTier {
  return policySensitivityValue(
    state.accessPolicies.find((policy) => policy.clientId === clientId)?.requiresApprovalAbove,
    "personal"
  );
}

function policyZeroTouchConfidenceBarForClient(
  state: VaultState,
  clientId: string
): SensitivityConfidence | undefined {
  return state.accessPolicies.find((policy) => policy.clientId === clientId)?.zeroTouchConfidenceBar;
}

function connectionApprovalMode(state: VaultState, clientId: string): ContextPackRequest["approvalMode"] {
  const policy = state.accessPolicies.find((p) => p.clientId === clientId);
  return policy?.standingDeliveryEnabled === true ? "explicit_sensitive" : "always_review";
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

function validateBackupPassphrase(passphrase: string) {
  const trimmed = passphrase.trim();
  if (!trimmed) throw new Error("Passphrase is required.");
  const classes = [
    /[a-z]/.test(trimmed),
    /[A-Z]/.test(trimmed),
    /\d/.test(trimmed),
    /[^A-Za-z0-9]/.test(trimmed)
  ].filter(Boolean).length;
  if (trimmed.length < 12 || classes < 3) {
    throw new Error("バックアップのパスフレーズは12文字以上で、英大文字・英小文字・数字・記号のうち3種類以上を含めてください。");
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
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
      iterations,
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
