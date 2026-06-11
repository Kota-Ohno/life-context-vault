# Personal AI Context Research

Date: 2026-06-11

## Research Question

Can we build a user-owned context store that accumulates personal context through AI conversations and active capture, then makes that context usable across multiple AI assistants while preserving control, provenance, and privacy?

Short answer: yes. The ecosystem already contains close pieces: local-first MCP memory servers, memory SDKs, knowledge graph memory engines, Obsidian/Markdown bridges, and platform-native memory in ChatGPT, Claude, and Gemini. The gap is a product and governance layer for high-trust life context: consent, sensitivity, provenance, freshness, correction, and "use this only with care" behavior.

## Closest Existing Work

### Mem0 / OpenMemory

- Sources:
  - https://mem0.ai/blog/introducing-openmemory-mcp
  - https://github.com/mem0ai/mem0
  - https://github.com/mem0ai/mem0-mcp
- Pattern:
  - Universal memory layer for AI agents.
  - OpenMemory MCP is positioned as a private, local-first memory server with a built-in UI.
  - MCP tools include add, search, list, and delete memory.
  - Good reference for "one memory layer, many MCP clients."
- Caveat:
  - Local storage does not necessarily mean fully local inference; setup examples use OpenAI keys for extraction/embedding workflows.
  - The memory model is oriented toward assistant/agent personalization, not necessarily high-assurance personal administrative facts.

### Basic Memory

- Source: https://github.com/basicmachines-co/basic-memory
- Pattern:
  - Markdown-first knowledge graph and MCP bridge.
  - Explicitly targets Claude Desktop, Claude Code, Codex, Cursor, VS Code, ChatGPT Custom GPT actions, and any MCP client.
  - Strong "no lock-in" posture: local Markdown, wikilinks, export, snapshots, backups.
- Design lesson:
  - Plain files are valuable because humans can audit and edit the knowledge base without special tooling.
  - This is probably the best reference for a personal context vault starting point.

### Pieces

- Sources:
  - https://github.com/pieces-app
  - https://docs.pieces.app/products/quick-guides/ltm-context
- Pattern:
  - Local-first workflow memory that captures notes, browser activity, conversations, documents, code, and other work context.
  - PiecesOS provides the local foundation; MCP brings that context into clients such as Cursor, Claude Desktop, GitHub Copilot, and Codex CLI.
  - Long-Term Memory can capture context from active windows and later retrieve it conversationally.
- Design lesson:
  - Active/passive capture is powerful but has high privacy risk. For our use case, passive capture should be opt-in and scoped.

### Obsidian MCP Bridges

- Sources:
  - https://github.com/jacksteamdev/obsidian-mcp-tools
  - https://github.com/aaronsb/obsidian-mcp-plugin
- Pattern:
  - Expose an existing human-maintained vault to AI via MCP.
  - Common features: read notes, semantic search, template execution, graph traversal.
  - Some bridges emphasize not giving AI direct raw file access, but going through a controlled API.
- Design lesson:
  - A context vault can be an ordinary notes app plus a permissioned MCP surface.

### LangMem / LangGraph Memory

- Source: https://langchain-ai.github.io/langmem/
- Pattern:
  - SDK primitives for extracting important information from conversations.
  - Supports hot-path memory tools and background memory management.
  - Integrates with LangGraph long-term memory storage.
- Design lesson:
  - Memory extraction should not be a single monolithic write. It should include background consolidation, deduplication, and updates.

### Letta / MemGPT

- Sources:
  - https://github.com/letta-ai/letta
  - https://arxiv.org/abs/2310.08560
- Pattern:
  - Stateful agents with memory blocks and self-improving behavior.
  - MemGPT frames memory as a hierarchy that manages limited context windows like an operating system.
- Design lesson:
  - Treat the LLM context window as a cache, not the source of truth.
  - Store durable memory outside the model; load only relevant slices.

### Zep / Graphiti

- Sources:
  - https://help.getzep.com/graphiti/getting-started/overview
  - https://github.com/getzep/graphiti
  - https://arxiv.org/html/2501.13956v1
- Pattern:
  - Temporal knowledge graph for AI agents.
  - Stores entities, relationships, facts, validity windows, and provenance episodes.
  - Supports hybrid retrieval: semantic, full-text, graph traversal, and time.
- Design lesson:
  - This is important for life context because facts change. "Works at Company A" and "insured by X" need effective dates and supersession.

### Cognee

- Source: https://github.com/topoteretes/cognee
- Pattern:
  - Open-source AI memory platform with self-hosted knowledge graph.
  - Exposes remember, recall, forget, and improve operations.
  - Combines vector embeddings, graph reasoning, ontology generation, traceability, and tenant isolation.
- Design lesson:
  - Good reference for graph/vector hybrid memory, but probably heavier than a first personal MVP.

### Platform-Native Memory

- ChatGPT sources:
  - https://help.openai.com/en/articles/8590148-memory-faq
  - https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work
- Claude sources:
  - https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
  - https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude
- Gemini Enterprise source:
  - https://docs.cloud.google.com/gemini/enterprise/docs/configure-personalization
- Pattern:
  - Each platform increasingly has saved memories, chat-history reference, and/or project memory.
  - Claude now supports memory import/export using a prompt-based transfer flow.
  - Gemini Enterprise exposes personalization profiles, connected data sources, saved memories, controls, and deletion.
- Limitation:
  - These memories are not a user-owned canonical store.
  - Behavior and retention are platform-specific.
  - They are useful adapters, but should not be the source of truth for a cross-AI context system.

### Solid / Personal Data Stores

- Source: https://www.inrupt.com/solid
- Pattern:
  - Personal data stores/pods decouple data from applications and give users a place to access, update, and share data.
- Design lesson:
  - The broader architectural idea is "user-owned data, app-granted access." Our version can be much smaller: a local vault plus explicit AI access surfaces.

## Research And Evaluation Context

- MemGPT: memory hierarchy and virtual context management for LLMs.
  - https://arxiv.org/abs/2310.08560
- Mem0 paper: dynamically extracts, consolidates, and retrieves salient information; reports lower latency/token cost than full-context approaches.
  - https://arxiv.org/abs/2504.19413
- LoCoMo benchmark: evaluates long-term conversational memory over multi-session conversations.
  - https://arxiv.org/abs/2402.17753
- Generative Agents: memory, reflection, and planning architecture for believable agents.
  - https://arxiv.org/abs/2304.03442

Takeaway: memory quality is not just vector search. Good systems separate raw episodes, derived facts, reflections/summaries, temporal reasoning, and retrieval policy.

## MCP As The Integration Layer

- Sources:
  - https://modelcontextprotocol.io/docs/getting-started/intro
  - https://modelcontextprotocol.io/specification/2025-06-18/server/tools
  - https://developers.openai.com/api/docs/guides/tools-connectors-mcp
- Pattern:
  - MCP connects AI apps to external data, tools, and workflows.
  - Tools are model-controlled, but implementations should keep a human in the loop for trust and safety.
  - OpenAI supports remote MCP servers and connectors in the API, with a secure tunnel option for private/on-prem servers.
- Design implication:
  - MCP is the right adapter layer for AI clients.
  - The core memory rules and data model should not live only inside MCP. They should live in the vault/server and be exposed through controlled tools.

## Security And Privacy Constraints

- MCP security sources:
  - https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
  - https://owasp.org/www-project-mcp-top-10/
  - https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- Japan sensitive personal information:
  - https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/
  - https://www.japaneselawtranslation.go.jp/en/laws/view/4241/en
- Key risks:
  - Sensitive information disclosure.
  - Prompt injection through stored notes or imported documents.
  - Tool poisoning or malicious MCP servers.
  - Over-recall: irrelevant private facts being injected into prompts.
  - Stale facts being treated as current.
  - Unclear deletion: removing a derived memory but leaving source evidence elsewhere.
- Japan-specific note:
  - Medical history, disability-related facts, and similar details can fall under sensitive personal information / 要配慮個人情報. The system should treat these as high-sensitivity by default.

## Design Patterns Worth Reusing

1. Source episode + derived memory separation
   - Store raw source snippets/events separately from extracted facts.
   - Every derived fact should cite source, date, extractor, confidence, and last reviewed time.

2. Temporal facts
   - Facts need effective dates and supersession.
   - Example: employer, insurer, address, benefit status, dependent status.

3. Sensitivity tiers
   - Public-ish preferences: tone, language, work style.
   - Private ordinary: address region, family, employment, finances.
   - Sensitive: health, disability, pension, legal, religion, sexuality, biometrics, secrets.
   - Secret: credentials, tokens, My Number, account numbers. Default should be "never expose to LLM."

4. Consent-gated writes
   - AI can propose memories.
   - User approves, edits, rejects, or marks as sensitive.
   - Autonomous writes can be allowed only for low-risk preferences.

5. Retrieval budget and purpose binding
   - Retrieve only what is relevant to the current purpose.
   - Each retrieval request should include task purpose, sensitivity ceiling, and context budget.

6. Human-readable vault
   - Markdown for durable facts and policies.
   - SQLite for index, audit log, embeddings, and graph edges.
   - Human editability is a feature, not an implementation compromise.

7. Audit and undo
   - Show what was retrieved, why, and where it came from.
   - Support delete, correct, expire, and "do not use for this purpose."

8. Export/import
   - Generate context packs for non-MCP AIs.
   - Import ChatGPT/Claude/Gemini memory exports as untrusted candidate memories, not canonical truth.

## Likely MVP Shape

### Storage

- `profile/*.md`: curated stable context.
- `events/*.jsonl`: raw or semi-raw life events with timestamps.
- `facts/*.jsonl`: extracted atomic facts with sensitivity, source, confidence, and validity.
- `policies/*.md`: retrieval and write rules.
- `index.sqlite`: search, graph edges, audit logs, and optional embeddings metadata.

### MCP Tools

- `context_search(query, purpose, sensitivity_max, time_range, limit)`
- `context_pack(task, purpose, sensitivity_max, token_budget)`
- `propose_memory(source_text, source_uri, suggested_scope)`
- `commit_memory(candidate_id, user_edits, sensitivity, validity)`
- `update_memory(memory_id, patch, reason)`
- `forget_memory(memory_id, mode)`
- `audit_recent_access(limit)`

### Skills / Operating Rules

- Before answering personal-admin, medical, legal, money, insurance, tax, immigration, or employment questions, retrieve only relevant context.
- For sensitive context, say what context is being relied on and ask before using or revealing it unless the user clearly requested that use.
- For public-law or benefits procedures, always verify current official sources before giving procedural guidance.
- Do not store secrets or identifiers as ordinary memory.
- If a fact is stale or uncertain, treat it as a clue, not truth.

## Recommended Direction

Build a small local-first context vault first, then add MCP.

Best starting architecture:

1. Markdown + JSONL vault that is easy to inspect.
2. A small CLI to propose, approve, search, and export context.
3. SQLite index for search and audit.
4. MCP server exposing read/search/context-pack tools first.
5. Add write tools only after consent workflow and audit are solid.
6. Add passive capture or app integrations later, one source at a time.

## Open Design Questions

1. Is this primarily for the user personally, or eventually a product for others?
2. Should the first version optimize for life-admin context, work/project context, or relationship/preferences context?
3. How much automatic capture is acceptable?
4. Should the vault be local-only, cloud-syncable, or self-hostable?
5. Which AI clients matter first: Codex, ChatGPT, Claude, Gemini, Cursor, Obsidian?
6. What is the maximum acceptable risk for sensitive facts?
7. Should high-risk memories require periodic review or expiration?

## Initial Opinion

The best product shape is not "AI remembers everything." It is "AI can ask a trusted personal context layer for the minimum relevant context, with provenance and permissions."

MCP is the connector. Skills are the behavioral policy. The vault is the source of truth.
