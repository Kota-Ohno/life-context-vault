# Deep Research: Life Context Vault

Date: 2026-06-11

## Executive Summary

"Life Context Vault" should not be designed as an app that "remembers everything." That path has strong precedents in lifelogging and personal database research, but it creates immediate fear, privacy load, and trust issues for general users.

The stronger concept is:

> A user-owned life context layer that helps any AI understand the minimum relevant context for the current task, with provenance, permissions, freshness, and user control.

This is closer to a personal data store plus AI memory governance than a note app or vector database.

## Core Product Thesis

The product should specialize in "life context," not in a narrow domain such as benefits, health, or productivity.

Life context includes:

- identity and stable profile
- communication preferences
- values, constraints, and goals
- relationships and household context
- work as part of life, not codebase memory
- health, care, disability, medications, and wellness context
- finances, insurance, benefits, taxes, housing, contracts
- plans, obligations, recurring routines, and important events
- documents and evidence that support life decisions

The unit of value is not "storage." It is "AI can help without making the user re-explain their life, while not overexposing private context."

## Historical And Product Precedents

### MyLifeBits / Memex / Lifelogging

Microsoft Research's MyLifeBits is a direct ancestor of this idea. It describes a "lifetime store of everything" with full-text search, annotations, hyperlinks, and SQL-backed access. The project digitized documents, media, web pages, calls, IM transcripts, meetings, and room conversations.

Sources:

- https://www.microsoft.com/en-us/research/project/mylifebits/
- https://www.microsoft.com/en-us/research/publication/mylifebits-a-personal-database-for-everything/

Design lessons:

- A lifetime store is technically feasible.
- Annotation, saved queries, clustering, pivoting, and fast search were important even before LLMs.
- "Everything capture" is powerful but risky; it needs filtering, curation, and privacy controls to be acceptable to ordinary users.

### Solid Pods / Personal Data Stores

Solid frames the architecture as personal online data stores called Pods. Apps and AI agents can read/write documents from the user's Pod, and the user chooses which applications can access which data and for what purposes.

Source:

- https://solidproject.org/about

Design lessons:

- Decouple data from applications.
- Treat the vault as the user's long-lived asset.
- Let AI clients become replaceable consumers of context, not the canonical owner of memory.
- Permissions and purpose boundaries are part of the product, not admin settings.

### Local-First Software

The local-first movement argues for offline-capable, user-owned, long-lived software with privacy/security by default. The Ink & Switch local-first essay lists ideals including "the network is optional," "long now," "security and privacy by default," and "ultimate ownership and control."

Source:

- https://www.inkandswitch.com/essay/local-first/

Design lessons:

- Local-first is a strong fit for life context because the user's life data should remain useful even if a company disappears.
- Sync should be a convenience layer, not the source of truth.
- Multi-device sync is eventually required, but early product trust benefits from local-first defaults.

### Limitless / Rewind / Pieces / Personal AI

The current product landscape contains several memory-oriented products:

- Limitless/Rewind lineage: ambient personal memory and wearable capture.
- Pieces: local-first workflow memory with MCP integration.
- Personal AI: memory as identity infrastructure, with temporal, episodic, semantic, relationship, and procedural memory.

Sources:

- https://www.limitless.ai/
- https://github.com/pieces-app
- https://docs.pieces.app/products/quick-guides/ltm-context
- https://www.personal.ai/

Design lessons:

- Ambient capture is compelling but creates a high-friction trust problem.
- Developer/workflow memory is easier than general life memory because the privacy boundary is narrower.
- "Memory + context + identity" is a useful framing, but for a consumer product we should avoid implying the AI becomes the person.

### Platform-Native Memories

ChatGPT, Claude, and Gemini increasingly include memory or personalization:

- ChatGPT: saved memories and reference chat history.
- Claude: chat search, memory synthesis, project memory, import/export.
- Gemini Enterprise: personalization profile, connected data sources, saved memories, and controls.

Sources:

- https://help.openai.com/en/articles/8590148-memory-faq
- https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude
- https://docs.cloud.google.com/gemini/enterprise/docs/configure-personalization

Design lessons:

- Platform memory proves user demand.
- Platform memory creates lock-in and inconsistent behavior.
- A user-owned vault can become the canonical memory source, while platform memories are caches/adapters.

## Memory Model

### Cognitive Architecture Reference

CoALA frames language agents as having modular memory components and a structured action space. It distinguishes working memory from long-term memories such as episodic, semantic, and procedural memory.

Source:

- https://arxiv.org/html/2309.02427v3

For this product, the useful translation is:

- Working memory: the current AI conversation context pack.
- Episodic memory: what happened, when, with source and surrounding context.
- Semantic memory: durable facts, preferences, relationships, and current profile.
- Procedural memory: user-approved rules for how AI should behave for this user.
- Prospective memory: future obligations, reminders, plans, deadlines, and intentions.

### Recommended Vault Layers

1. Raw Sources
   - Files, documents, transcripts, notes, images, email snippets, calendar entries.
   - Not always exposed to AI.

2. Episodes
   - Time-bounded event records.
   - Example: "On 2026-06-11, user applied for a pension booklet."
   - Fields: time, location if relevant, source, involved entities, confidence, sensitivity.

3. Facts
   - Atomic claims derived from episodes or entered directly.
   - Example: "User prefers Japanese for product design discussions."
   - Fields: subject, predicate, object, validity window, source episode, confidence, sensitivity, review date.

4. Entities
   - People, organizations, places, accounts, documents, projects, assets, pets if relevant, services, institutions.
   - Entities should have aliases and external identifiers only when safe.

5. Relationships
   - Links between entities and facts.
   - Example: person -> works_at -> company, document -> supports -> fact, person -> family_role -> parent.

6. Summaries / Models
   - Curated human-readable "current picture" documents.
   - Example: "Health context summary," "Household context," "Work preferences."
   - Summaries are generated from lower layers but should be user-reviewable.

7. Policies
   - What can be saved automatically.
   - What requires confirmation.
   - What can be retrieved for which purpose.
   - What must never be sent to external AI.

8. Context Packs
   - Temporary, task-specific bundles assembled for an AI.
   - These are not the vault; they are views.

## Vault Storage Architecture

### MVP Recommendation

Use a hybrid local-first structure:

- Human-readable Markdown for curated summaries and policies.
- JSONL or SQLite rows for append-only episodes and fact records.
- SQLite for canonical structured storage, FTS, metadata filtering, audit log, and indexes.
- Optional local vector extension or sidecar vector index for semantic search.

Suggested local directory:

```text
vault/
  profile/
    self.md
    preferences.md
    values.md
  domains/
    work.md
    health.md
    money.md
    home.md
    relationships.md
    projects.md
  sources/
    documents/
    imports/
  memory/
    episodes.jsonl
    facts.jsonl
    entities.jsonl
    relationships.jsonl
  policies/
    privacy.md
    retrieval.md
    retention.md
  indexes/
    life_context.sqlite
```

### Why SQLite First

SQLite FTS5 provides full-text search as a virtual table module and is designed for efficient search over a collection of documents.

Source:

- https://sqlite.org/fts5.html

sqlite-vec provides local vector search inside SQLite, runs on laptops, mobile, browsers/WASM, and does not require a separate server.

Source:

- https://alexgarcia.xyz/sqlite-vec/

Rationale:

- General users need local speed and simple installation.
- SQLite is easy to inspect, back up, sync, and encrypt at the file level.
- FTS handles exact names, institutions, document titles, and dates better than embeddings.
- Local vector search handles fuzzy recall and natural-language queries.

### When To Graduate From SQLite

For a single user's personal life context, SQLite can likely carry the product through a large MVP and beyond. Graduation triggers:

- multi-user household or caregiver sharing
- many devices with complex conflict resolution
- large document/image/audio corpus
- enterprise-like compliance and audit needs
- high-throughput memory ingestion
- server-hosted product with many users

Scalable directions:

- Postgres + pgvector for relational consistency, metadata filtering, vector search, and operational maturity.
- Qdrant/Weaviate/OpenSearch for dedicated vector/hybrid search at scale.
- Object storage for raw documents and media.
- Event log as the canonical write path.

pgvector supports HNSW and IVFFlat. HNSW has better query performance at the cost of build time and memory; IVFFlat builds faster and uses less memory but has lower speed/recall tradeoff. pgvector also recommends combining with Postgres full-text search for hybrid search and using RRF or cross-encoders to combine results.

Source:

- https://github.com/pgvector/pgvector

Qdrant emphasizes payload filtering because not all business requirements can be expressed in embeddings.

Source:

- https://qdrant.tech/documentation/search/filtering/

Weaviate and LanceDB both document hybrid search patterns combining vector and keyword/BM25-style search with fusion/reranking.

Sources:

- https://docs.weaviate.io/weaviate/search/hybrid
- https://docs.lancedb.com/search/hybrid-search

## Retrieval Architecture

### Retrieval Must Be Hybrid

Do not use "vector search over everything" as the core architecture.

Use:

- permission and sensitivity filter first
- time and validity filter
- lexical search: names, exact terms, institutions, procedures, document titles
- vector search: fuzzy meaning and semantically related memories
- graph traversal: relationships and entity context
- recency/frequency signals
- confidence and user-review status
- reranking and context compression

Retrieval flow:

```text
user request
  -> classify purpose and risk
  -> choose sensitivity ceiling
  -> identify relevant domains/entities/time window
  -> retrieve candidates through FTS + vector + graph
  -> filter by permission, validity, source trust, freshness
  -> rerank
  -> assemble context pack
  -> show/record what was used
```

### Context Pack Design

A context pack should include:

- task purpose
- retrieval timestamp
- sensitivity ceiling
- memory snippets with IDs
- source and confidence
- validity dates
- "do not infer beyond this" caveats
- optional user-facing explanation

The context pack is the only thing external AI should see. The entire vault should never be copied into a model context.

### Retrieval UX

General users need visibility without cognitive overload.

Recommended UI:

- "Used 4 memories" expandable chip.
- Each memory can be corrected, hidden for this answer, expired, or deleted.
- Sensitive memories require one-tap approval before use.
- High-risk answers show "context used" and "official/current info needed" prompts.
- Users can ask, "Why did you use this?" and "Do not use this type of memory for this topic."

## Sync And Multi-Device

Local-first sync is important because life context is used across phone, desktop, and AI clients.

Candidate patterns:

- File sync for early Markdown/JSONL vaults.
- SQLite local database + encrypted cloud backup.
- PowerSync-style backend DB to in-app SQLite sync for app productization.
- Electric-style Postgres partial replication for server-managed products.
- CRDT/Automerge for collaborative notes or household-shared mutable documents.

Sources:

- https://automerge.org/
- https://powersync.com/
- https://github.com/electric-sql/electric
- https://doc.replicache.dev/concepts/how-it-works

Recommendation:

- Do not start with CRDT everywhere.
- Use append-only event records for memory changes; append-only logs are naturally easier to merge.
- Use CRDT only for user-edited rich text or collaborative household notes.
- Keep canonical fact IDs stable across devices.
- Sync indexes as rebuildable derived state, not canonical state.

## Privacy, Consent, And Safety

### General Privacy Principles

The ICO's data protection principles are a useful design checklist even beyond UK/GDPR compliance:

- transparency
- purpose limitation
- data minimization
- accuracy
- storage limitation
- integrity/confidentiality
- accountability

Source:

- https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/

NIST AI RMF frames AI risk management around trustworthiness considerations in design, development, use, and evaluation.

Source:

- https://www.nist.gov/itl/ai-risk-management-framework

OWASP flags prompt injection, sensitive information disclosure, insecure plugin design, excessive agency, and overreliance as relevant LLM risks.

Source:

- https://owasp.org/www-project-top-10-for-large-language-model-applications/

### User Research On LLM Memory Privacy

A 2025 study on users' privacy perceptions toward RAG-based LLM memory found that users value personalization but want granular control over memory generation, management, usage, updating, review, editing, deletion, categorization, and transparency into how memories are used.

Source:

- https://arxiv.org/html/2508.07664v1

Design implications:

- Memory approval cannot be buried.
- Users need memory categories and plain-language labels.
- "AI inferred this" must be distinguishable from "you explicitly told us this."
- Memory use must be inspectable at answer time.

### Episodic Memory Safety

Research on episodic memory in AI agents proposes principles that map well to this product:

- Memories should be interpretable by users.
- Users should be able to add or delete memories.
- Memories should be isolateable/detachable from the system.
- Memories should not be editable by AI agents.

Source:

- https://arxiv.org/html/2501.11739v2

For this product, "AI should not edit memory" should mean:

- AI can propose candidate memories.
- AI can suggest updates or contradictions.
- The system can write low-risk ephemeral candidates.
- Canonical user memory requires user approval or a trusted deterministic workflow.

### MCP Security And Consent

MCP is a good integration layer but must be treated carefully. The MCP specification says users must consent to and understand data access and operations, retain control over what is shared, and get clear UIs for authorizing activities.

Source:

- https://modelcontextprotocol.io/specification/2025-06-18

MCP elicitation supports structured user input, but explicitly says servers must not request sensitive information through elicitation.

Source:

- https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation

Design implication:

- MCP should expose context search and context pack tools.
- Sensitive writes/collection should happen in the first-party app UI, not through a random MCP client prompt.
- MCP tools need scopes: read-low, read-private, read-sensitive, propose-memory, commit-memory, audit.

## Sensitivity Model

Recommended sensitivity tiers:

0. Public/preferences
   - tone, language, favorite formats, harmless preferences.
   - auto-save candidate allowed.

1. Personal ordinary
   - work role, city-level location, household context, hobbies, routines.
   - confirm or batch-review.

2. Private consequential
   - employer, contracts, finances, insurance, exact address, relationship conflict.
   - explicit approval for storage and use.

3. Sensitive
   - health, disability, benefits, religion, sexuality, legal matters, biometrics, minors.
   - explicit storage approval, purpose-bound retrieval, answer-time visibility.

4. Secret / never-send
   - passwords, tokens, My Number, full account numbers, private keys.
   - do not store as ordinary memory; if stored at all, use a secrets manager.

## Important Differentiation

Existing systems often optimize for:

- remembering more
- retrieving faster
- connecting more AI clients
- passive capture
- assistant personalization

This product should optimize for:

- remembering appropriately
- retrieving minimally
- preserving user ownership
- making memory use inspectable
- supporting life decisions with current, sourced context
- letting the user correct their life model over time

## MVP Recommendation

Build a local-first Life Context Vault app, not an MCP server first.

MVP components:

1. Vault data model
   - episodes, facts, entities, relationships, policies, audit log.

2. Manual and conversational capture
   - user writes notes or talks to AI.
   - AI proposes memories into an Inbox.
   - user approves/edits/rejects.

3. Hybrid local search
   - SQLite FTS5 for text.
   - local vector index for semantic recall.
   - simple entity graph tables.

4. Context pack generator
   - creates minimal task-specific context.
   - shows used memories.

5. MCP read adapter
   - search context.
   - get context pack.
   - audit recent access.
   - no direct sensitive write in v1.

6. Safety UX
   - memory inbox.
   - sensitivity labels.
   - "used memories" panel.
   - delete/correct/expire.
   - never-send category.

Avoid in MVP:

- always-on audio/screen capture
- automatic import from all apps
- autonomous memory edits
- complex CRDT sync
- medical/legal/financial advice automation
- giving third-party AI clients broad vault access

## Suggested Technical Shape

```text
Client App
  - chat/capture UI
  - memory inbox
  - context inspector
  - local SQLite
  - local FTS/vector search

Vault Core
  - append-only event log
  - fact/entity graph
  - policy engine
  - retrieval/reranking
  - context pack generation
  - audit trail

MCP Adapter
  - read scoped context packs
  - propose memories
  - audit access
  - no raw vault dump

Optional Cloud Sync
  - encrypted backup
  - device sync
  - server-side index rebuild
  - shareable family/caregiver scopes
```

## Design Questions To Resolve Next

1. Primary UX
   - Is the first surface a chat, a memory inbox, a life dashboard, or a browser/phone extension?

2. Capture policy
   - Should memory be explicit-first, AI-suggested, or passive for selected sources?

3. Trust posture
   - Should the product say "AI remembers for you" or "you own context that AI may use"?

4. Search UX
   - Should users search memories directly, or mainly see context used in AI answers?

5. Sync posture
   - Local-only MVP, local + encrypted backup, or multi-device from day one?

6. AI client priority
   - ChatGPT, Claude, Codex, Cursor, mobile assistant, or a first-party assistant?

7. Sensitivity defaults
   - How conservative should the product be before the user configures it?

## Initial Product Positioning

Candidate positioning:

> Your life context, owned by you. Let any AI help with the right context, without giving it your whole life.

Avoid:

- "remembers everything"
- "digital twin"
- "AI version of you"
- "never forget anything"

Better:

- "context you control"
- "AI that understands what matters"
- "private memory for everyday life"
- "useful context, not surveillance"

## Design Hypothesis

The winning experience will feel less like a database and more like a trusted memory steward:

- It notices useful context.
- It asks before keeping sensitive context.
- It forgets when asked.
- It explains what it used.
- It keeps facts fresh.
- It helps AI answer with less repetition and fewer unsafe assumptions.

The key architectural decision is to make "user-governed context packs" the primary interface between the vault and AI.
