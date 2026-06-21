export type SensitivityTier =
  | "public"
  | "personal"
  | "private_consequential"
  | "sensitive"
  | "secret_never_send";

export type LifeContextDomain =
  | "identity_and_profile"
  | "values_goals_and_preferences"
  | "life_events_and_plans"
  | "routines_and_logistics"
  | "home_and_places"
  | "documents_and_evidence"
  | "contracts_and_policies"
  | "procedures_and_obligations"
  | "health_and_care"
  | "finance_and_benefits"
  | "work_and_education"
  | "relationships_and_household"
  | "constraints_and_accessibility";

export type SourceKind =
  | "document"
  | "conversation"
  | "manual_note"
  | "background_onboarding"
  | "passive_capture"
  | "mcp_proposal";

export type SourceOrigin =
  | "user_upload"
  | "in_app_chat"
  | "manual_entry"
  | "guided_onboarding"
  | "passive_browser"
  | "local_mcp"
  | "remote_relay";

export type SourceLifecycleAction =
  | "soft_delete"
  | "restore"
  | "purge_body";

export type SourceMetadataUpdate = {
  title: string;
  defaultSensitivity: SensitivityTier;
  promotedToLongTerm?: boolean;
};

export type SourceBodyUpdate = {
  body: string;
};

export type ConnectorKind =
  | "claude_desktop"
  | "chatgpt"
  | "claude_remote"
  | "gemini"
  | "codex"
  | "generic_mcp"
  | "copy_fallback";

export type ConnectorTransport =
  | "local_mcp"
  | "remote_mcp_relay"
  | "browser_extension"
  | "copy_export";

export type ConnectorStatus =
  | "available"
  | "connected"
  | "needs_pairing"
  | "paused"
  | "blocked";

export type AccessScope =
  | "context_pack.request"
  | "memory.propose"
  | "policy.read"
  | "request.status"
  | "passive_capture.write";

export type CandidateStatus =
  | "new"
  | "needs_user_detail"
  | "approved"
  | "edited_and_approved"
  | "rejected"
  | "archived"
  | "blocked_sensitive";

export type FactStatus =
  | "active"
  | "superseded"
  | "expired"
  | "needs_review"
  | "user_hidden"
  | "deleted";

export type FactLifecycleAction =
  | "keep_active"
  | "mark_needs_review"
  | "hide"
  | "delete"
  | "restore";

export type FactMetadataUpdate = {
  factText: string;
  domain: LifeContextDomain;
  sensitivity: SensitivityTier;
  validFrom?: string;
  validUntil?: string;
  dueDate?: string;
};

export type CandidateApprovalOptions = {
  editedText?: string;
  supersedeFactIds?: string[];
};

export type RawSource = {
  id: string;
  kind: SourceKind;
  title: string;
  origin: SourceOrigin;
  body: string;
  createdAt: string;
  capturedAt: string;
  retentionUntil?: string;
  promotedToLongTerm?: boolean;
  defaultSensitivity: SensitivityTier;
  processingStatus: "ready" | "failed" | "deleted" | "needs_runtime";
  deletionState: "active" | "soft_deleted" | "purged";
};

export type MemoryCandidate = {
  id: string;
  sourceIds: string[];
  sourceChunkIds?: string[];
  proposedFactText: string;
  evidenceSpan?: {
    sourceId: string;
    start: number;
    end: number;
  };
  domain: LifeContextDomain;
  candidateType:
    | "fact"
    | "deadline"
    | "obligation"
    | "contact_point"
    | "preference"
    | "goal"
    | "routine"
    | "constraint"
    | "life_event"
    | "relationship"
    | "background_profile"
    | "conflict"
    | "reminder_candidate"
    | "note";
  detectedSensitivity: SensitivityTier;
  confidence: "low" | "medium" | "high";
  reasonToRemember: string;
  validFrom?: string;
  validUntil?: string;
  dueDate?: string;
  status: CandidateStatus;
  createdAt: string;
  reviewedAt?: string;
  createsFactIds: string[];
  conflictWithFactIds: string[];
  conflictReason?: string;
};

export type MemoryProposal = {
  id: string;
  sourceId: string;
  proposedFactText: string;
  domain: LifeContextDomain;
  detectedSensitivity: SensitivityTier;
  confidence: "low" | "medium" | "high";
  evidenceSpan?: MemoryCandidate["evidenceSpan"];
  reasonToRemember: string;
  status: CandidateStatus;
};

export type ApprovedFact = {
  id: string;
  factText: string;
  domain: LifeContextDomain;
  factType:
    | "identity"
    | "document_reference"
    | "deadline"
    | "obligation"
    | "contract_term"
    | "contact_point"
    | "preference"
    | "relationship"
    | "life_event"
    | "goal"
    | "routine"
    | "constraint"
    | "support_need"
    | "place_context"
    | "background_profile"
    | "note";
  sourceIds: string[];
  sensitivity: SensitivityTier;
  confidence: "user_asserted" | "source_backed" | "inferred_and_confirmed";
  status: FactStatus;
  validFrom?: string;
  validUntil?: string;
  dueDate?: string;
  createdAt: string;
  approvedAt: string;
  updatedAt: string;
  supersedesFactIds: string[];
  supersededByFactId?: string;
  reviewReason?: "source_deleted" | "source_updated";
  reviewSourceId?: string;
};

export type ContextPackItem = {
  id: string;
  factId: string;
  itemText: string;
  reasonIncluded: string;
  sensitivity: SensitivityTier;
  sourceTitles: string[];
  validFrom?: string;
  validUntil?: string;
  confidence: ApprovedFact["confidence"];
};

export type ContextPackRequestStatus =
  | "draft"
  | "pending_user_confirmation"
  | "approved"
  | "denied"
  | "fulfilled"
  | "expired";

export type ApprovalMode = "auto_low_risk" | "always_review" | "explicit_sensitive";

export type ContextPackRequest = {
  id: string;
  clientId: string;
  clientName: string;
  taskText: string;
  purpose: string;
  requestedDomains: Array<LifeContextDomain | "mixed" | "unknown">;
  sensitivityCeiling: SensitivityTier;
  approvalMode: ApprovalMode;
  createdAt: string;
  expiresAt: string;
  status: ContextPackRequestStatus;
};

export type SourceSnippet = {
  id: string;
  sourceId: string;
  title: string;
  text: string;
  sensitivity: SensitivityTier;
  reasonIncluded: string;
};

export type ContextExclusion = {
  referencedId: string;
  reason:
    | "sensitivity_policy"
    | "domain_policy"
    | "provider_policy"
    | "expired"
    | "deleted"
    | "user_hidden"
    | "not_relevant"
    | "secret_never_send";
};

export type ContextWarning = {
  kind:
    | "stale_fact"
    | "conflicting_facts"
    | "low_confidence"
    | "sensitive_context"
    | "source_deleted"
    | "policy_limited";
  message: string;
  relatedIds: string[];
};

export type ContextPack = {
  id: string;
  requestId?: string;
  taskText: string;
  taskDomain: LifeContextDomain | "mixed" | "unknown";
  riskLevel: "low" | "medium" | "high";
  generatedAt: string;
  expiresAt?: string;
  maxSensitivityIncluded: SensitivityTier;
  items: ContextPackItem[];
  sourceSnippets?: SourceSnippet[];
  excludedItems: ContextExclusion[];
  warnings: ContextWarning[];
  confirmationStatus:
    | "not_required"
    | "pending_user_confirmation"
    | "confirmed"
    | "edited_by_user"
    | "cancelled";
  confirmedAt?: string;
  auditEventId?: string;
  localAnswer?: string;
};

export type AiContextPackPayload = Pick<
  ContextPack,
  | "id"
  | "requestId"
  | "taskText"
  | "taskDomain"
  | "generatedAt"
  | "expiresAt"
  | "maxSensitivityIncluded"
  | "items"
  | "sourceSnippets"
  | "warnings"
  | "confirmationStatus"
> & {
  trustBoundary: "ContextPack only";
  excludedItems: Array<Pick<ContextExclusion, "reason">>;
};

export type AccessPolicy = {
  id: string;
  clientId: string;
  scopes: AccessScope[];
  domainAllowlist: LifeContextDomain[];
  sensitivityCeiling: SensitivityTier;
  requiresApprovalAbove: SensitivityTier;
  passiveCaptureAllowed: boolean;
  standingDeliveryEnabled?: boolean;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PassiveCaptureSettings = {
  enabled: boolean;
  retentionDays: number;
  allowedSites: string[];
  pausedUntil?: string;
};

export type PassiveCaptureEvent = {
  id: string;
  sourceClient: ConnectorKind;
  conversationId: string;
  urlHash: string;
  textFragmentRef: string;
  capturedAt: string;
  retentionUntil: string;
  sensitivityGuess: SensitivityTier;
  processingStatus: "captured" | "candidate_generated" | "ignored" | "purged";
  sourceId?: string;
  candidateIds: string[];
};

export type ConnectorSession = {
  id: string;
  clientKind: ConnectorKind;
  clientName: string;
  transport: ConnectorTransport;
  deviceId?: string;
  oauthSubject?: string;
  scopes: AccessScope[];
  status: ConnectorStatus;
  createdAt: string;
  lastUsedAt?: string;
};

export type AuditEvent = {
  id: string;
  eventType:
    | "source_added"
    | "source_updated"
    | "source_deleted"
    | "source_restored"
    | "source_purged"
    | "candidate_generated"
    | "candidate_reviewed"
    | "fact_created"
    | "fact_updated"
    | "context_pack_requested"
    | "context_pack_generated"
    | "context_pack_updated"
    | "context_pack_confirmed"
    | "context_pack_delivered"
    | "context_pack_denied"
    | "connector_updated"
    | "memory_proposed"
    | "passive_capture_recorded"
    | "passive_capture_purged"
    | "policy_updated"
    | "backup_created"
    | "restore_completed"
    | "vault_cleared";
  actor: "user" | "system" | "connector";
  subjectType:
    | "source"
    | "candidate"
    | "fact"
    | "context_pack_request"
    | "context_pack"
    | "connector_session"
    | "passive_capture_event"
    | "policy"
    | "backup"
    | "vault";
  subjectId: string;
  occurredAt: string;
  sensitivity: SensitivityTier;
  metadata: Record<string, unknown>;
};

export type VaultState = {
  version: 2;
  sources: RawSource[];
  candidates: MemoryCandidate[];
  facts: ApprovedFact[];
  accessPolicies: AccessPolicy[];
  passiveCaptureSettings: PassiveCaptureSettings;
  passiveCaptureEvents: PassiveCaptureEvent[];
  connectorSessions: ConnectorSession[];
  contextPackRequests: ContextPackRequest[];
  contextPacks: ContextPack[];
  auditEvents: AuditEvent[];
};

export type BackgroundSetupInput = {
  displayName: string;
  tonePreference: string;
  activeLifeAreas: string;
  recurringConstraints: string;
  confirmationTopics: string;
};
