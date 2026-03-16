# Agent System Documentation

This document covers the complete agent facilitator system in Quorum: how
agents are defined, how they process station turns, how they communicate
via Agent-to-Agent (A2A) requests, and how to test and operate the system.

---

## 1. Overview

Each quorum can have 1–N roles.  When a human at a station submits a
contribution or asks a direct question, the agent facilitator for that role
wakes up, reviews its context, and responds.

The system is designed around three principles:

1. **Dormant until triggered.** Agents do not run on a schedule.  They run
   when a human speaks at their station, or when another agent sends them
   an A2A request.

2. **Stateless across turns.** All persistent state lives in Supabase
   (`station_messages`, `agent_insights`, `agent_documents`,
   `agent_requests`).  The agent engine loads, processes, and writes back
   on every turn — there is no in-process conversation state.

3. **Tag-driven context routing.** Agents declare `domain_tags` in their
   YAML definition.  The engine uses Jaccard similarity to decide which
   cross-station insights and documents are relevant to each agent without
   brute-forcing every piece of context into every LLM call.

---

## 2. Architecture

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │                         ARCHITECT SETUP                               │
  │  POST /events → POST /events/{id}/quorums (roles defined here)       │
  │  POST /events/{eid}/quorums/{qid}/seed-documents                      │
  └──────────────────────────┬───────────────────────────────────────────┘
                             │
         ┌───────────────────┼──────────────────────┐
         ▼                   ▼                      ▼
  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │  Station 1   │   │  Station 2   │   │  Station N   │
  │  Role: IRB   │   │  Role: Site  │   │  Role: Spons │
  │  Human + AI  │   │  Human + AI  │   │  Human + AI  │
  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
         │                  │                  │
         │ POST /contribute  │                  │
         │ POST /stations/.../ask               │
         ▼                  ▼                  ▼
  ┌─────────────────────────────────────────────────────┐
  │                    FastAPI Backend                    │
  │                                                      │
  │  agent_engine.process_agent_turn()                   │
  │    1. Load role name + agent definition (YAML)       │
  │    2. Load conversation history (station_messages)   │
  │    3. Load quorum context (quorum title/description) │
  │    4. Load cross-station insights (tag affinity)     │
  │    5. Load relevant documents (tag affinity)         │
  │    6. Load pending A2A requests for this role        │
  │    7. Build prompt → LLM call                        │
  │    8. Persist user + assistant messages              │
  │    9. Extract tags → grow quorum vocabulary          │
  │   10. Publish insight if reply is substantive        │
  │   11. Notify high-affinity agents via A2A            │
  │   12. Return (reply, message_id, tags)               │
  │                                                      │
  │  document_engine.update_document()                   │
  │    CAS write with version guard                      │
  │    Change log + oscillation detection                │
  └───────────────────────┬─────────────────────────────┘
                          │
         ┌────────────────┼──────────────┐
         ▼                ▼              ▼
  ┌──────────────┐ ┌───────────┐ ┌─────────────────┐
  │  Supabase DB │ │ Tag       │ │ Document Store  │
  │  + Realtime  │ │ Affinity  │ │ (agent_docs +   │
  │  Channels    │ │ Engine    │ │  change log)    │
  └──────────────┘ └───────────┘ └─────────────────┘
          │
          ▼
  ┌──────────────────────────────────────────────────┐
  │                 Frontend (Next.js)                │
  │                                                   │
  │  ConversationThread ← station_messages realtime   │
  │  DocumentPanel      ← agent_documents realtime    │
  │  useStationConversation hook (sendMessage, ask)   │
  └──────────────────────────────────────────────────┘
```

---

## 3. Agent Definitions

Agents are defined in YAML files at `agents/definitions/{slug}.yaml`.

### File naming

The file slug is derived from the role name by lowercasing and replacing
spaces/hyphens with underscores:

```
"Safety Monitor"  →  agents/definitions/safety_monitor.yaml
"IRB Officer"     →  agents/definitions/irb_officer.yaml
"Budget Analyst"  →  agents/definitions/budget_analyst.yaml
```

If no definition file is found, the engine uses a generic prompt template
based on the role name.  Agents without definitions still work — they just
lack domain tags and custom instructions.

### YAML schema

```yaml
name: Safety Monitor
version: "1.0"
description: >
  Monitors participant safety, reviews adverse events, and enforces protocol
  safety criteria across the trial.

# Azure Assistants API field name (system prompt)
instructions: |
  You are the Safety Monitor for this clinical trial quorum.
  Your primary responsibility is participant safety and adverse event surveillance.
  ...

# Jaccard affinity matching uses these tags
domain_tags:
  - safety
  - adverse_events
  - egfr
  - dsmb
  - protocol

# Matches the quorum roles table authority_rank
authority_rank: 7

# Model routing:
#   gpt-4o-mini  → Chat Completions API
#   gpt-5-*      → Responses API (when provider.respond() is available)
model: gpt-4o-mini

tools:
  - edit_document    # shorthand: becomes function tool with matching name
  - flag_conflict

# Agent behavior metadata
metadata:
  auto_create_docs: false
  escalation_model: gpt-4o
  personality:
    tone: direct
    verbosity: concise
    initiative: proactive

# A2A skills (Google Agent Card format)
a2a:
  skills:
    - id: safety_review
      name: Safety Review
      description: Review safety data and flag adverse events
    - id: protocol_escalation
      name: Protocol Escalation
      description: Escalate protocol violations to highest-authority role

# Azure Assistants API (filled by deployment script)
azure:
  assistant_id: null
```

### Loading agents

```python
from agents import load_agent, list_agents

# Load by slug
agent = load_agent("safety_monitor")
print(agent.instructions)
print(agent.domain_tags)

# List all
agents = list_agents()
```

The engine loads agents lazily per turn.  `FileNotFoundError` is caught and
treated as "no definition" — the turn continues with a generic prompt.

---

## 4. Station Conversation Flow

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/quorums/{id}/contribute` | Submit contribution (triggers agent turn when `station_id` provided) |
| `POST` | `/quorums/{id}/stations/{sid}/ask` | Direct question to the facilitator |
| `GET`  | `/quorums/{id}/stations/{sid}/messages` | Load conversation history |

### Turn pipeline (`agent_engine.process_agent_turn`)

```
Input: quorum_id, role_id, station_id, user_message

1. Resolve role_name + authority_rank from DB
2. Load agent definition (YAML) by role name slug
3. Load last 10 messages for this station (conversation history)
4. Load quorum title/description for system prompt context
5. Load up to 5 insights from other stations with tag affinity ≥ 0.2
6. Load up to 3 documents sorted by tag affinity (baseline 0.1 for untagged)
7. Load pending A2A requests addressed to this role
8. Build messages list:
     [system: role persona + quorum context]
     [user: documents + insights + pending requests]
     [assistant: "Understood — I've reviewed the context"]
     [... conversation history ...]
     [user: current user_message]
9. LLM call (routing: gpt-5 → Responses API, others → chat() → complete())
10. Persist user message row → station_messages
11. Extract tags from reply (explicit [tags: ...] blocks + tier-1 keywords)
12. Grow quorum vocabulary in memory (tag_vocabulary module)
13. Persist assistant reply row → station_messages
14. Publish insight row → agent_insights if reply > 50 chars
15. Notify high-affinity agents (affinity ≥ 0.6) via A2A request

Returns: (reply_text, reply_message_id, reply_tags)
```

### Error handling

`process_agent_turn` **never raises**.  On any failure it returns a graceful
fallback string: `"I encountered an issue processing your message. Please try again."`

Each step (role load, history load, LLM call, DB persist) is individually
try/caught.  Failures are logged at WARNING level but do not abort the turn.
The contribution is always stored regardless of whether the agent turn fires.

### Prompt structure (for prompt caching)

The system message is kept stable across turns (same role, same quorum) to
maximize Azure prefix-cache hits.  The context block (documents + insights)
is also prepended as a user/assistant exchange before history so it stays in
the cached prefix region on models that support prefix caching.

---

## 5. A2A Protocol

Agent-to-agent requests allow agents to wake each other without waiting for
a human to act.

### Request types

| Type | When used | Priority (default) |
|------|-----------|-------------------|
| `conflict_flag` | Agent detects a contradiction with another role's data | 3 (high) |
| `input_request` | Agent needs information from another role | 2 (medium) |
| `review_request` | Agent asks another to review a document or decision | 2 (medium) |
| `doc_edit_notify` | Agent notifies another that a relevant document changed | 1 (low) |
| `escalation` | Automated escalation (e.g., from oscillation detection) | 4 (critical) |
| `negotiation` | Agents negotiate a shared value (e.g., budget reallocation) | 2 (medium) |

### Wake-up flow (`routes.py` → `agent_engine.process_a2a_request`)

```
POST /quorums/{id}/a2a/request
  → Insert agent_requests row (status=pending)
  → process_a2a_request(request_id)
      1. Load request from agent_requests
      2. Load target role name + agent definition
      3. Load sender role name for context
      4. Build minimal prompt:
           [system: target agent persona]
           [user: "You received a {type} from {sender}: {content}\nRespond concisely."]
      5. LLM call (routing: gpt-5 → Responses API, others → chat() → complete())
      6. Extract tags from response
      7. Update agent_requests: status=acknowledged, response=..., response_tags=...
      8. Return response text
  → Broadcast via WebSocket:
      { type: "agent_request", data: { request_id, from, to, request_type, response } }
  → Return A2ARequestResponse with target_response populated
```

### Automatic A2A notifications (`_notify_relevant_agents`)

After each substantive agent reply, the engine:
1. Computes tag affinity against all other roles in the quorum
   (using `agent_configs.domain_tags` as the source of truth)
2. Sends a `doc_edit_notify` A2A request to any role with affinity ≥ 0.6
3. The request is stored as `pending` (the target processes it next time
   their station is active — wake-up is not immediate for auto-notifications)

### Priority levels

| Priority | Value | Handling |
|----------|-------|----------|
| Low | 1 | Background context only |
| Medium | 2 | Included in next agent turn's pending requests |
| High | 3 | Surfaced prominently in prompt |
| Critical | 4 | Escalation — auto-created by oscillation detection |

---

## 6. Document System

Agents can read and write structured documents that represent shared artifacts
in the quorum (budget, protocol, timeline, risk register, etc.).

### Document formats

| Format | Use case |
|--------|----------|
| `json` | Structured data (default) |
| `yaml` | Configuration-style documents |
| `csv`  | Tabular data (budget line items) |
| `markdown` | Free-text reports |

All seed documents use the `json` format envelope even when their logical
content is tabular.

### CAS (Compare-and-Swap) update protocol

Every write must provide `expected_version`.  The update is rejected (409)
if the document has been modified since the client last read it.

```python
# Good: optimistic write
response = PUT /quorums/{id}/documents/{doc_id}
body = {
    "content": { ... },
    "expected_version": 3,       # I last saw version 3
    "changed_by_role": role_id,
    "rationale": "Raised eGFR threshold per safety review"
}
# 200 → {"version": 4, "merged": false}  — success
# 409 → "Version conflict — current version is 5"  — re-fetch and retry
```

### Change log

Every write appends a row to `document_changes` with:
- `diff`: field-level diff `{field_path: {from, to}}`
- `rationale`: agent's stated reason
- `changed_by_role`: role ID
- `previous_content`: snapshot for rollback

The diff is intentionally shallow (top-level keys only).  Nested structures
are captured as whole subtrees.

### Oscillation detection

After every write, `detect_oscillation()` scans the last 10 changes.  It
looks for any JSON field path where the sequence of values alternates
A→B→A→B (two or more full cycles).

When oscillation is detected:
1. An `oscillation_events` row is inserted
2. The highest-authority role NOT involved in the oscillation receives an
   automatic `escalation` A2A request (priority=4)
3. If all roles are involved (no neutral arbiter), the event is logged at
   WARNING and flagged for architect review

---

## 7. Tag Affinity Engine

Tags are the connective tissue of the agent system.  They determine which
context is injected into each agent's prompt without sending everything to
every agent.

### Tag canonicalization

All tags are normalized before comparison:
- Lowercase
- Spaces and hyphens → underscores
- Strip non-alphanumeric characters
- Truncate to 30 characters

Example: `"Adverse Event"` → `"adverse_event"`

### Affinity scoring (Jaccard similarity)

```
affinity(A, B) = |A ∩ B| / |A ∪ B|
```

Thresholds used in the system:

| Threshold | Used for |
|-----------|----------|
| 0.1 | Document affinity graph (minimum edge for sparse graph) |
| 0.2 | Insight relevance — below this, insights are excluded from context |
| 0.6 | A2A auto-notification — only very close agents are woken automatically |

### Vocabulary evolution

Each quorum maintains a growing vocabulary of canonical tags in memory
(`tag_vocabulary` module).  When an agent extracts tags from text:

1. Explicit `[tags: x, y, z]` blocks are parsed first (authoritative)
2. Tier-1 keyword extraction runs on the full text
3. Each extracted tag is checked against the quorum vocabulary:
   - Exact match → use vocabulary term
   - Prefix/suffix variant within 5 chars → normalize to vocabulary term
   - No match → add as new term

This prevents tag fragmentation (e.g., `"adverse_event"` vs `"adverse_events"`).

The vocabulary is in-memory only.  On process restart it re-grows from the
tags stored in `agent_insights` and `station_messages`.

---

## 8. LLM Routing

The engine supports two LLM APIs with automatic routing based on the agent
definition's model field.

### Chat Completions API (gpt-4o, gpt-4o-mini)

Used for standard agents.  The full message list (system + context + history
+ user message) is passed to `provider.chat(messages, LLMTier.AGENT_CHAT)`.

### Responses API (gpt-5-*)

When an agent definition specifies a `gpt-5-*` model AND the provider
exposes a `respond()` method:

```python
reply, _ = await provider.respond(
    instructions=system_message_content,
    input_text=last_user_message_content,
    tier=LLMTier.AGENT_RESPOND,
)
```

If `respond()` fails, the engine falls back to `chat()`.

### Fallback chain

```
gpt-5 + respond() available → Responses API
                            → (on error) chat()
                            → (on error) complete() with flattened messages
```

This ensures agents always produce a response, even if the preferred API
path is unavailable.

### LLM tiers

| Tier | Enum value | Use case | Approximate cost |
|------|------------|----------|-----------------|
| KEYWORD | 1 | Every contribution (deterministic tier-1) | Free |
| CONFLICT | 2 | Tier-2 conflict detection | Cheap |
| AGENT_CHAT | 21 | Station conversation turns | Medium |
| AGENT_RESPOND | 22 | GPT-5 Responses API turns | Medium |
| SYNTHESIS | 3 | Artifact generation at resolve | Expensive |
| AGENT_REASON | 31 | Complex multi-step agent reasoning | Expensive |

---

## 9. Azure Deployment Guide

### Deploying agents as Azure Assistants

Each agent definition can be deployed to the Azure OpenAI Assistants API:

```python
from agents import load_agent

agent = load_agent("safety_monitor")
payload = agent.to_azure_assistant()
# payload = {name, description, instructions, model, tools, metadata}

# Use Azure SDK or REST API to create/update assistant
client = AzureOpenAI(...)
assistant = client.beta.assistants.create(**payload)

# Store the ID back in the YAML
# azure:
#   assistant_id: asst_xxx
```

### Environment variables required

```
AZURE_OPENAI_ENDPOINT=https://your-instance.openai.azure.com
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini   # default model deployment name
AZURE_OPENAI_GPT5_DEPLOYMENT=gpt-5    # if using gpt-5 agents
```

These are set in `apps/api/.env` (never committed).  See `docs/CONTRACT.md`
for the full list.

### MockLLMProvider for development

Set `QUORUM_TEST_MODE=true` in the server environment to use the
`MockLLMProvider` which returns deterministic responses without making
network calls.  The E2E test script supports `--mock` for the same effect.

---

## 10. Testing Guide

### Unit tests

```bash
# LLM package (affinity, models, pipeline)
cd packages/llm && python -m pytest tests/ -v

# Agent loader
python -m pytest agents/tests/ -v

# API routes + agent engine (uses mocked Supabase + LLM)
python -m pytest apps/api/tests/ -v
```

### Integration test (no browser)

The E2E Python script exercises the full HTTP API end-to-end:

```bash
# With live stack (real Azure LLM calls)
python scripts/e2e-agent-test.py --api-url http://localhost:8000

# With mock LLM (no Azure keys needed, requires server running)
python scripts/e2e-agent-test.py --mock

# Verbose output (shows HTTP status for each call)
python scripts/e2e-agent-test.py --mock --verbose
```

The script covers:
1. Server health check
2. Event + quorum creation (3 roles)
3. Role ID resolution via `GET /quorums/{id}/roles`
4. Document seeding
5. 3-station simulation (contribute + ask per station)
6. Cross-station insight verification
7. A2A request creation + target agent response
8. Document CRUD (create + CAS update + CAS conflict)
9. Final state checks

### Browser E2E (Playwright)

See `apps/web/e2e/agent-flow.spec.ts` for the full spec.  Setup instructions
are in the file header comments.

Quick start:
```bash
cd apps/web
pnpm add -D @playwright/test
npx playwright install chromium
NEXT_PUBLIC_API_URL=http://localhost:8000 pnpm test:e2e
```

### What to verify in manual testing

1. Open 3 browser windows to the same quorum with different `?station=N` values
2. In each window, select a role and submit a contribution
3. Verify each window shows a facilitator reply in ConversationThread
4. Verify the Documents tab shows the seeded documents
5. Make a follow-up contribution from Station 1 — verify Station 2's context
   block mentions Station 1's insight on the NEXT turn (A2A propagation)
6. Check the Insights endpoint: `GET /quorums/{id}/insights`
7. Trigger a CAS conflict: make two rapid document edits from different stations

---

## 11. Known Limitations and Future Work

| Issue | Severity | Workaround / Future fix |
|-------|----------|------------------------|
| `CreateQuorumResponse` does not return role IDs | Medium | Use `GET /quorums/{id}/roles` (added in Phase 4) |
| Tag vocabulary is in-memory only | Low | Re-derivable from DB tags on restart; persist to Supabase KV for HA |
| A2A notifications do not immediately wake agents | Low | Fire-and-forget pending rows; agents process on next human interaction |
| Oscillation escalation targets any uninvolved role | Low | Should prefer the architect or a designated mediator role |
| `_notify_relevant_agents` uses `agent_configs` table | Medium | `agent_configs` must be populated at quorum creation time; fallback to YAML domain_tags |
| No deduplication of A2A notifications | Low | Multiple turns with the same tags can generate duplicate `doc_edit_notify` requests |

---

## 12. Using GPT-5-nano

GPT-5-nano is the recommended model for `AGENT_RESPOND` turns (T5 tier).  It
uses OpenAI's **Responses API** (`client.responses.create`) rather than Chat
Completions, which means several Chat Completions parameters are not supported.

### API constraints

| Parameter | Chat Completions | Responses API (GPT-5) |
|-----------|-----------------|----------------------|
| `temperature` | supported | **NOT supported** — fixed at 1, causes 400 if passed |
| `top_p` | supported | **NOT supported** — causes 400 if passed |
| `presence_penalty` | supported | **NOT supported** — causes 400 if passed |
| `frequency_penalty` | supported | **NOT supported** — causes 400 if passed |
| `reasoning_effort` | top-level string | **nested object**: `reasoning={"effort": "low"}` |
| `function` role in messages | supported | **NOT supported** — use `tool` role |

Valid `reasoning.effort` values: `"low"`, `"medium"`, `"high"`.

The Responses API also supports stateful threading via `previous_response_id`,
which avoids re-sending the full conversation history on every turn and reduces
latency + cost.

### Setup

1. Deploy `gpt-5-nano` in Azure AI Foundry under your Azure OpenAI resource.
2. Note the deployment name you chose (e.g. `gpt5-nano-prod`).
3. Add the env var to your `.env` file (or CI secrets):
   ```
   AZURE_OPENAI_DEPLOYMENT_T5=gpt5-nano-prod
   ```
4. To switch an agent to GPT-5-nano, change its YAML model field:
   ```yaml
   model: gpt-5-nano
   ```
   The provider auto-detects `gpt-5-*` model names and routes to the T5
   deployment with the Responses API.  No other code changes are needed.

### Fallback behaviour

If `AZURE_OPENAI_DEPLOYMENT_T5` is not set, the T5 slot falls back to the T2
deployment (`gpt-4o-mini`).  The provider detects this fallback and uses Chat
Completions instead of the Responses API, so agents continue to work without
GPT-5-nano configured.

### Environment variable reference

| Var | Required | Example |
|-----|----------|---------|
| `AZURE_OPENAI_ENDPOINT` | Yes | `https://my-resource.openai.azure.com/` |
| `AZURE_OPENAI_KEY` | No (use Managed Identity if omitted) | `abc123...` |
| `AZURE_OPENAI_DEPLOYMENT_T2` | Yes | `gpt-4o-mini` |
| `AZURE_OPENAI_DEPLOYMENT_T3` | Yes | `gpt-4o` |
| `AZURE_OPENAI_DEPLOYMENT_T5` | No (falls back to T2) | `gpt5-nano-prod` |
