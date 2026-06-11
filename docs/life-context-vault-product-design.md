# Life Context Vault Product Design

Last updated: 2026-06-11

## Purpose

Life Context Vault is a local-first desktop product that helps ordinary users keep high-trust life context that AI can use safely.

The product is not a general note app, a lifelog, or an "AI that remembers everything." It is a user-owned context layer for everyday life: identity, household, relationships, work, learning, routines, health, care, money, benefits, housing, documents, obligations, goals, values, preferences, and the constraints that make AI help actually fit the person.

Important documents and procedures are the first evidence-heavy wedge, not the full product scope. The larger UX goal is to help AI understand the person's background without forcing the user to re-explain their life in every conversation.

The first proof of concept focuses on:

- Desktop app
- In-app AI
- Life Context Home as the first screen, with Memory Inbox as the main review surface
- Selective passive extraction from user conversations, guided onboarding, and uploaded documents
- A user-editable background profile covering the person's life context
- Important documents, procedures, deadlines, and evidence-backed context as the first high-trust use case
- Country-independent product design, with examples that can later be localized

The core product promise:

> Let AI help with the right life context, without giving it your whole life.

## Product Thesis

Most AI memory products optimize for remembering more. Life Context Vault optimizes for remembering appropriately.

The user should feel three things:

1. "I know what this app is keeping about me."
2. "I can correct, delete, or limit it."
3. "When AI uses my context, I can see what it is using before it answers."

The product value is not storage by itself. The value is that an AI can answer questions like "How should I plan this week?", "What should I do before changing jobs?", "Can you help me write this message in a way that fits my situation?", or "What documents should I update before moving?" while using current, sourced, permissioned context instead of guessing or asking the user to re-explain their life.

## Target User

The first PoC is for a non-engineering general user who:

- Has life context scattered across memory, conversations, files, paper scans, calendars, and documents.
- Wants AI help that understands their background, not just the current prompt.
- Wants help with everyday decisions, planning, communication, procedures, and obligations, but does not want all private context exposed to every AI.
- Is willing to review suggested memories if the review is lightweight and clearly useful.
- Does not want to configure a database, MCP server, or prompt system.

The first PoC should also be usable by the project owner and early technical testers, but developer workflows are secondary.

## Product Boundaries

### In Scope For PoC

- Guided background setup for stable context such as household, work/school, important roles, recurring constraints, communication preferences, goals, and current life events.
- Uploading documents such as insurance policies, contracts, benefit notices, lease documents, warranty documents, official letters, and procedure checklists.
- Capturing user-provided conversation snippets inside the app.
- Extracting memory candidates from those sources.
- Letting the user approve, edit, reject, archive, or mark candidates as sensitive.
- Storing approved facts with provenance and validity metadata.
- Letting the user inspect and edit their background profile as a plain-language life model.
- Searching approved facts and sources through hybrid retrieval.
- Producing a Context Pack before the in-app AI answers a question.
- Showing the Context Pack to the user before sensitive or consequential context is sent to an LLM.
- Encrypted local storage and encrypted backup of the whole Vault.

### Out Of Scope For PoC

- Always-on screen, microphone, browser, or email capture.
- Autonomous memory writes without user review.
- Household or family sharing.
- Region-specific procedural advice as a guaranteed authority.
- External MCP adapter as the primary UX.
- Automated form submission, phone calls, or agency on behalf of the user.
- A full calendar, task manager, CRM, therapy app, or medical record system.
- Password manager behavior, private key storage, or storing national ID numbers as ordinary memory.

## First Screen: Life Context Home

The app opens to Life Context Home.

Life Context Home answers one question:

> What does this AI currently understand about my life?

It has three primary areas:

1. Background Snapshot
   - A plain-language summary of stable context: household, work or school, current life events, routines, constraints, goals, and preferences.
   - Each statement has a source, confidence, sensitivity, and edit control.

2. Memory Inbox
   - A review queue for AI-suggested additions, corrections, conflicts, and sensitive items.
   - This remains the main trust-building surface.

3. Ask With Context
   - A compact entry point to the in-app AI.
   - The UI indicates whether the next answer will use no context, ordinary background, or context requiring confirmation.

The first screen should feel like a calm personal context dashboard, not a database and not a chat-only product.

## Memory Inbox

Memory Inbox is where AI-suggested context becomes trustworthy context. Every item is a candidate until the user acts.

Each candidate card shows:

- Plain-language proposed memory.
- Source such as onboarding answer, document, note, or conversation.
- Why it may matter.
- Detected category.
- Detected sensitivity.
- Suggested validity or expiration date if any.
- Confidence level.
- Actions: Save, Edit, Reject, Later, Mark Sensitive.

The inbox should not feel like a generic task list. It is a review queue for "things AI thinks may matter later."

### Candidate States

- `new`: extracted but not reviewed.
- `needs_user_detail`: useful but missing a required field.
- `approved`: converted into one or more approved facts.
- `edited_and_approved`: user changed the content before approval.
- `rejected`: user said this should not be remembered.
- `archived`: not useful now, but retained as an inbox decision.
- `blocked_sensitive`: too sensitive to save under current policy without explicit confirmation.

Approval is the trust boundary. Before approval, a candidate may be displayed in the inbox, but it must not be used as canonical context for AI answers.

## Core UX Flows

### Flow 1: Guided Background Setup

1. User opens the app for the first time.
2. App asks a small number of optional background questions.
3. User can skip any question.
4. App creates MemoryCandidate records from answers, not ApprovedFact records directly.
5. User reviews the candidates in Memory Inbox or accepts a grouped "save these basics" review.
6. Approved facts appear in Background Snapshot.

Initial prompts should cover:

- What name or nickname should AI use?
- What language and tone preferences matter?
- What major life areas are active right now: work, school, caregiving, moving, job search, health logistics, finances, family, projects?
- Are there recurring constraints AI should remember: schedule, accessibility, energy, budget, location, communication style?
- Are there topics that should never be used without explicit confirmation?

Guided setup must be optional. The product should become useful through normal conversations and document uploads even if the user skips onboarding.

### Flow 2: Upload Important Document

1. User drops a document into the app.
2. App stores the raw source locally.
3. App extracts text locally when possible.
4. App classifies document type, sensitivity, dates, parties, obligations, and contact points.
5. App creates MemoryCandidate records.
6. User reviews candidates in Memory Inbox.
7. Approved candidates become ApprovedFact records.
8. Search indexes are updated.
9. App shows a summary: saved facts, rejected facts, sensitive items requiring stronger confirmation.

Example user-visible outcome:

- "Your insurance renewal date is May 31 every year."
- "The contact phone number for this policy appears to be ..."
- "This document contains financial information, so it will require confirmation before being used in AI answers."

### Flow 3: Conversation Enriches Background

1. User asks the in-app AI about ordinary life, such as planning a week, preparing for a meeting, talking to family, moving, changing jobs, renewing a contract, or handling paperwork.
2. The conversation includes potentially reusable life context.
3. AI proposes MemoryCandidate records after the turn, not silently during it.
4. Memory Inbox shows the proposed candidates.
5. User approves only what should become durable context.

The product should avoid interrupting the user mid-conversation unless the detected context is both high-value and time-sensitive. Most background enrichment should appear as a gentle post-turn suggestion.

### Flow 4: Ask In-App AI With Background

1. User asks a question.
2. App classifies the purpose and risk level of the question.
3. App retrieves relevant approved background facts and source-backed facts.
4. App builds a Context Pack.
5. If the Context Pack includes private, sensitive, or consequential context, the app shows it before answer generation.
6. User confirms, edits, or removes items from the Context Pack.
7. Only confirmed context is sent to the LLM.
8. AI answers and cites which context was used.

The user should never have to wonder why the AI knew something personal.

### Flow 5: New Source Conflicts With Old Fact

1. User uploads a newer document.
2. Extraction finds a fact that conflicts with an existing approved fact.
3. App creates a conflict candidate rather than overwriting the old fact.
4. User sees both facts, their sources, dates, and confidence.
5. User chooses: replace, keep both, mark old as expired, or reject new extraction.

The default is no silent overwrite.

## Information Architecture

The PoC has six primary surfaces:

1. Life Context Home
   - Shows the Background Snapshot.
   - Highlights stale, missing, sensitive, or conflicting context.
   - Offers a low-friction entry point to Ask With Context.

2. Memory Inbox
   - Review extracted candidates.
   - Approve, edit, reject, or mark sensitive.

3. Sources
   - Upload and inspect raw sources such as documents, onboarding answers, manual notes, and in-app conversations.
   - See extraction status and linked facts.

4. Ask
   - In-app AI interface.
   - Context Pack preview before sensitive answers.

5. Search
   - Search approved facts, background context, and sources.
   - Filter by category, date, source, sensitivity, and validity.

6. Settings
   - Vault location.
   - Backup configuration.
   - AI provider settings.
   - Sensitivity defaults.
   - Context-sharing policies.

No marketing screen is required inside the app. The first useful screen is the user's own life context.

## Life Context Domains

The first domain taxonomy should be stable but not too detailed.

Use these top-level domains:

- `identity_and_profile`: name variants, address history, household composition, preferred language, accessibility needs.
- `values_goals_and_preferences`: values, goals, priorities, communication style, decision preferences, dislikes, and personal rules.
- `life_events_and_plans`: moves, job changes, school transitions, travel, caregiving changes, major projects, and planned milestones.
- `routines_and_logistics`: recurring schedule constraints, commute, habits, appointments, chores, and day-to-day logistics.
- `home_and_places`: home context, important places, local constraints, housing situation, utilities, and neighborhood-specific context.
- `documents_and_evidence`: source documents, certificates, notices, letters, IDs as references, proof records.
- `contracts_and_policies`: insurance, leases, utilities, subscriptions, warranties, service terms.
- `procedures_and_obligations`: forms to submit, renewals, notifications, required updates, deadlines.
- `health_and_care`: health, disability, care, benefits, medical logistics. Strongly sensitive by default.
- `finance_and_benefits`: banking references, benefits, taxes, pension, reimbursement, allowances. Strongly sensitive by default.
- `work_and_education`: employer/school context, role, schedule constraints, HR procedures.
- `relationships_and_household`: spouse, partner, children, dependents, caregivers, emergency contacts. Strongly sensitive when third-party details are involved.
- `constraints_and_accessibility`: accessibility needs, energy constraints, budget constraints, boundaries, and other durable limits AI should respect.

PoC examples should use these domains without committing the app to one country's laws or administrative system.

## Sensitivity Defaults

Sensitivity is conservative by default.

| Tier | Name | Meaning | Default Behavior |
| --- | --- | --- | --- |
| 0 | Public or harmless preference | Low-risk preferences and non-private setup choices | May be saved after lightweight review |
| 1 | Personal ordinary | Personal but not highly consequential | Requires user approval before becoming fact |
| 2 | Private consequential | Could affect money, housing, employment, benefits, or legal outcomes | Requires explicit approval and answer-time visibility |
| 3 | Sensitive | Health, disability, care, benefits, legal, finance, biometrics, minors, intimate relationships | Requires explicit storage approval and explicit use approval |
| 4 | Secret or never-send | Passwords, tokens, private keys, full national IDs, full account numbers | Do not save as ordinary memory and do not send to LLM |

Tier 3 and Tier 4 detection does not mean the app should hide the issue. It means the app should slow down, explain, and require user choice.

## Context Pack UX

Context Pack is the bridge between Vault and AI. It is also the main trust-building moment.

Context Packs should distinguish:

- Stable background: general facts that make advice fit the person.
- Task-specific evidence: documents, deadlines, contracts, and obligations relevant to the current question.
- Sensitive context: private details that require explicit confirmation before use.

Before a sensitive or consequential answer, the user sees:

- The question or task.
- Context items the app wants to use.
- Source names and dates.
- Sensitivity labels.
- Items excluded because of policy.
- Controls to remove individual context items.
- A clear confirmation action.

The AI answer should include a compact "used context" footer when context was used. It should not expose long raw document excerpts unless the user opens details.

## Voice And Positioning

Use:

- "context you control"
- "your background"
- "life context"
- "approved facts"
- "source-backed"
- "used for this answer"
- "review before saving"
- "private by default"

Avoid:

- "remembers everything"
- "digital twin"
- "never forgets"
- "AI version of you"
- "automatic life capture"

The tone should be calm and practical. This is not a surveillance product and not a futuristic companion fantasy. It is a trusted memory steward.

## Representative Scenarios

### Weekly Planning With Background

User asks: "Help me plan the rest of this week."

The app proposes a Context Pack containing:

- Current work or school constraints.
- Caregiving or household responsibilities if approved.
- Energy, accessibility, budget, or location constraints if approved.
- Existing deadlines or appointments from approved facts.

The app does not expose sensitive health, family, or finance context unless the user confirms it for this answer.

The answer adapts to the person's real background instead of giving generic productivity advice.

### Communication Help With Personal Context

User asks: "Help me write a message declining this invitation."

The app may use:

- Preferred tone.
- Relevant relationship context if approved.
- The user's stated boundaries or constraints.

It should not reveal hidden relationship details or infer motivations beyond approved context.

### Insurance Renewal

User uploads an insurance policy PDF.

The app extracts:

- Policy provider.
- Policy name.
- Renewal date.
- Contact method.
- Premium or payment cadence if present.
- Documents required for claims if present.

The app marks payment and policy details as private consequential. The user approves renewal date and contact method, but marks premium as hidden from AI by default.

### Moving Preparation

User tells the in-app AI: "I may move next month."

The app proposes:

- A temporary life event: moving planned next month.
- Possible procedure category: address update.
- Follow-up reminder candidate: collect documents that require address changes.

It does not infer a new address or update existing address without explicit user input.

### Sensitive Benefit Notice

User uploads a benefit or medical support notice.

The app detects sensitive information.

The inbox card says:

- "This appears to include sensitive benefit or care-related information."
- "Save only the parts you want AI to remember."
- Suggested facts are hidden behind a review action.

No sensitive fact becomes available to AI until the user approves it.

### Asking With Context

User asks: "What should I check before changing jobs?"

The app proposes a Context Pack containing:

- Current employer-related facts.
- Active insurance or benefit facts.
- Contract deadlines.
- Private or sensitive items only if policy allows and the user confirms.

The answer says what it used and what it intentionally did not use.

### Conflict Resolution

User uploads a newer contract.

The app detects a different renewal date from an older approved fact.

The inbox shows:

- Old date and source.
- New date and source.
- Which document appears newer.
- Recommended action: mark old fact expired and approve new fact.

The user decides.

## Review Checklist

The design is acceptable only if:

- A general user can understand what is saved.
- A general user can understand what is sent to AI.
- Candidate memories are not treated as approved facts.
- Sensitive information is strongly conservative by default.
- AI answers can cite the Context Pack used.
- The user can correct and delete approved facts.
- Conflicts are visible and not silently overwritten.
- The app remains useful without always-on passive capture.

## References

- [Deep research memo](./deep-research-life-context-vault-2026-06-11.md)
- [Personal AI context research](./research-personal-ai-context-2026-06-11.md)
- [Solid project](https://solidproject.org/about)
- [Local-first software](https://www.inkandswitch.com/essay/local-first/)
- [MyLifeBits](https://www.microsoft.com/en-us/research/project/mylifebits/)
- [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18)
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
