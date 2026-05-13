# CONTRACT.md — Machine-Readable API + Schema Spec

> This file is for AI agents onboarding to this codebase.
> No prose. Structured definitions only.

## Enums

```yaml
QuorumStatus: [open, active, resolved, archived]
RoleCapacity: integer | "unlimited"
ArtifactStatus: [draft, pending_ratification, final]
DashboardType:
  - authority_cascade_tree
  - quorum_health_chart
  - contribution_river
  - consensus_heat_ring
  - conflict_topology_map
  - decision_waterfall
  - resolution_radar
  - role_coverage_map
  - decision_dependency_dag
  - momentum_pulse
  - authority_weighted_gauge
  - contribution_timeline
  - artifact_lineage_graph
  - live_stance_board
  - voice_pulse_matrix
  - agent_document_viewer  # renders agent_documents: Gantt/budget/protocol/json
  - agent_affinity_graph   # force-directed graph of agent tag-affinity
CarouselMode: [multi-view, multi-quorum]
LLMTier: [1, 2, 3, 21, 31]  # 21=AGENT_CHAT (gpt-4o-mini), 31=AGENT_REASON (gpt-4o)
LLMProvider: [azure, anthropic, openai, local]
DocFormat: [json, yaml, csv, markdown]
DocStatus: [active, superseded, canceled]
MessageRole: [user, assistant, system]
InsightType: [summary, conflict, suggestion, question, decision, escalation]
A2AStatus: [pending, acknowledged, processing, resolved, expired]
A2ARequestType: [conflict_flag, input_request, review_request, doc_edit_notify, escalation, negotiation]
SynthesisTier: [keyword, conflict, synthesis]
DeviceKind: [laptop, phone]
AutonomyAutoContributeMode: [off, concat, synthesize]
```

## API Routes

```yaml
POST /events:
  body: { name: string, slug: string, access_code: string, max_active_quorums: integer }
  returns: { id: uuid, slug: string, created_at: timestamp }

POST /events/{event_id}/quorums:
  body:
    title: string
    description: string
    roles:
      - name: string
        capacity: integer | "unlimited"
        authority_rank: integer
        prompt_template: { field_name: string, prompt: string }[]
        fallback_chain: role_id[]
    dashboard_types: DashboardType[]
    carousel_mode: CarouselMode
  returns: { id: uuid, status: QuorumStatus, share_url: string }

POST /events/{event_id}/quorums/{quorum_id}/seed-documents:
  description: Load pre-seeded agent documents from seed/clinical-trial-documents.json. Idempotent — existing titles skipped.
  returns:
    quorum_id: uuid
    inserted: { id: uuid, title: string, doc_type: string }[]
    skipped: string[]
    total_problems_seeded: integer

POST /quorums/{quorum_id}/contribute:
  body:
    role_id: uuid
    user_token: string
    content: string
    structured_fields: { [field_name]: string }
    station_id: string?  # optional; if present, triggers agent facilitator turn
  returns:
    contribution_id: uuid
    tier_processed: LLMTier
    facilitator_reply: string | null
    facilitator_message_id: uuid | null
    facilitator_tags: string[] | null

GET /quorums/{quorum_id}/stations/{station_id}/messages:
  query: { limit: int = 50, before: timestamp? }
  returns: StationMessage[]

POST /quorums/{quorum_id}/stations/{station_id}/ask:
  body: { role_id: uuid, content: string }
  returns: { reply: string, message_id: uuid, tags: string[] }

GET /quorums/{quorum_id}/documents:
  query: { status: DocStatus = 'active', doc_type: string? }
  returns: AgentDocument[]

POST /quorums/{quorum_id}/documents:
  body:
    title: string
    doc_type: string
    format: DocFormat
    content: object
    tags: string[]
    created_by_role_id: uuid?
  returns: AgentDocument
  status: 201

PUT /quorums/{quorum_id}/documents/{doc_id}:
  body:
    content: object
    expected_version: integer
    changed_by_role: uuid
    rationale: string
  returns: { version: integer, merged: boolean }
  errors: { 409: "Version conflict — re-fetch and retry" }

GET /quorums/{quorum_id}/insights:
  query: { role_id: uuid?, insight_type: InsightType?, limit: int = 20 }
  returns: AgentInsight[]

POST /quorums/{quorum_id}/a2a/request:
  body:
    from_role_id: uuid
    to_role_id: uuid
    request_type: A2ARequestType
    content: string
    tags: string[]
    document_id: uuid?
    priority: integer  # 0 = lowest, 4 = critical
  returns: AgentRequest & { target_response: string? }
  status: 201

GET /quorums/{quorum_id}/state:
  returns:
    quorum: Quorum
    contributions: Contribution[]
    artifact: Artifact | null
    health_score: float  # 0-100, good = high
    active_roles: { role_id: uuid, participant_count: integer }[]

POST /quorums/{quorum_id}/resolve:
  body: { sign_off_token: string }
  returns: { artifact_id: uuid, download_url: string }

WS /quorums/{quorum_id}/live:
  emits:
    - { type: "contribution", data: Contribution }
    - { type: "health_update", data: { score: float, metrics: HealthMetrics } }
    - { type: "artifact_update", data: Artifact }
    - { type: "role_join", data: { role_id: uuid, count: integer } }
    - type: "facilitator_narration"
      data:
        narration: string          # one-sentence speaker-election rationale
        next_role_id: uuid
        next_role_name: string
        reason: string             # orchestrator reason code

# --- Sessions / participants (migration: 20260512000003_participants.sql) ---

POST /sessions/participant:
  description: Mint an anonymous participant_id from a QR scan or first station-page load. No JWT.
  body:
    quorum_id: uuid
    role_id: uuid?
    station_label: string?
    device_kind: DeviceKind
  returns:
    participant_id: uuid
    display_name: string           # auto-assigned "Visitor N" per (quorum_id, station_label)
  status: 201
  errors:
    422: "device_kind must be 'laptop' or 'phone'"
    404: "Quorum or role not found"

POST /sessions/heartbeat:
  description: 30s presence keepalive — refreshes participants.last_heartbeat_at.
  body: { participant_id: uuid }
  returns: null
  status: 204
  errors: { 404: "Participant not found" }

# --- A2A protocol (Linux Foundation a2a-sdk 1.0.x) ---

GET /a2a/:
  description: Discovery banner — declares the host speaks LF A2A 1.0.
  returns:
    protocol: "a2a"
    protocol_version: "1.0"
    implementation: "a2a-sdk"
    name: string
    description: string

GET /a2a/agents/{role_id}/.well-known/agent-card.json:
  description: LF A2A 1.0 canonical AgentCard for a role. Public, no auth.
  returns: AgentCard               # SDK-shaped JSON (camelCase, see a2a-sdk types)
  errors: { 404: "Role not found" }
  aliases:
    - GET /a2a/agents/{role_id}/.well-known/agent.json   # 0.3→1.0 migration alias
    - GET /a2a/agents/{role_id}/agent.json               # pre-1.0 alias

POST /a2a/agents/{role_id}/message:send:
  description: LF A2A 1.0 canonical send-message — dispatches a turn to the role's agent.
  body:                            # SendMessageRequest (a2a-sdk protobuf, camelCase JSON)
    message:
      messageId: string
      role: "ROLE_USER" | "ROLE_AGENT"
      contextId: string?           # treated as station_id by our agent_engine
      taskId: string?
      parts: [{ text: string }]    # v1.0 uses `parts`; v0.3 `content` is auto-rewritten
  returns: SendMessageResponse     # Task with status=TASK_STATE_COMPLETED + reply artifact
  errors:
    400: "Invalid A2A SendMessageRequest body | SendMessageRequest missing message | Role has no quorum_id"
    404: "Role not found"
  aliases:
    - POST /a2a/agents/{role_id}/tasks/send   # pre-1.0 name; accepts bare-message body too
```

## Supabase Tables

```yaml
events:
  id: uuid PK
  name: text
  slug: text UNIQUE
  access_code: text
  max_active_quorums: integer DEFAULT 5
  created_by: text
  created_at: timestamptz

quorums:
  id: uuid PK
  event_id: uuid FK events.id
  title: text
  description: text
  status: QuorumStatus DEFAULT 'open'
  heat_score: float DEFAULT 0
  carousel_mode: CarouselMode DEFAULT 'multi-view'
  created_at: timestamptz

roles:
  id: uuid PK
  quorum_id: uuid FK quorums.id
  name: text
  capacity: text DEFAULT 'unlimited'
  authority_rank: integer DEFAULT 0
  prompt_template: jsonb
  fallback_chain: uuid[]
  color: text

contributions:
  id: uuid PK
  quorum_id: uuid FK quorums.id
  role_id: uuid FK roles.id
  user_token: text
  content: text
  structured_fields: jsonb
  tier_processed: integer
  created_at: timestamptz

artifacts:
  id: uuid PK
  quorum_id: uuid FK quorums.id
  version: integer DEFAULT 1
  content_hash: text
  sections: jsonb
  status: ArtifactStatus DEFAULT 'draft'
  created_at: timestamptz

artifact_versions:
  id: uuid PK
  artifact_id: uuid FK artifacts.id
  version: integer
  sections: jsonb
  diff: jsonb
  created_at: timestamptz

# --- Agent system tables (migration: 20260314000002_agent_system.sql) ---

agent_configs:
  id: uuid PK
  role_id: uuid FK roles.id UNIQUE
  quorum_id: uuid FK quorums.id
  agent_slug: text               # matches filename in agents/definitions/
  system_prompt: text
  temperature: float DEFAULT 0.4
  max_tokens: integer DEFAULT 1024
  doc_permissions: text[]
  auto_create_docs: boolean DEFAULT false
  auto_suggest_dashboards: boolean DEFAULT false
  domain_tags: text[]
  created_at: timestamptz

station_messages:
  id: uuid PK
  quorum_id: uuid FK quorums.id
  role_id: uuid FK roles.id
  station_id: text               # ?station=N URL param value
  role: MessageRole
  content: text
  tags: text[]
  embedding: vector(1536)        # nullable; populated async by ada-002
  metadata: jsonb
  created_at: timestamptz

agent_documents:
  id: uuid PK
  quorum_id: uuid FK quorums.id
  title: text
  doc_type: text                 # 'budget' | 'timeline' | 'protocol' | 'risk_register' | etc.
  format: DocFormat DEFAULT 'json'
  content: jsonb                 # schema_version + sections + metadata envelope
  status: DocStatus DEFAULT 'active'
  version: integer DEFAULT 1     # CAS field — bump on every write
  tags: text[]
  created_by_role_id: uuid FK roles.id (nullable)
  created_at: timestamptz
  updated_at: timestamptz

document_changes:
  id: uuid PK
  document_id: uuid FK agent_documents.id
  version: integer               # version of document AFTER this change
  changed_by_role: uuid FK roles.id
  change_type: text              # 'create' | 'edit' | 'status_change'
  diff: jsonb
  rationale: text
  previous_content: jsonb
  tags: text[]
  created_at: timestamptz

agent_insights:
  id: uuid PK
  quorum_id: uuid FK quorums.id
  source_role_id: uuid FK roles.id
  insight_type: InsightType DEFAULT 'summary'
  content: text
  tags: text[]
  document_id: uuid FK agent_documents.id (nullable)
  self_relevance: float DEFAULT 0.5
  embedding: vector(1536)
  version: integer DEFAULT 1
  created_at: timestamptz

agent_requests:
  id: uuid PK
  quorum_id: uuid FK quorums.id
  from_role_id: uuid FK roles.id
  to_role_id: uuid FK roles.id
  request_type: A2ARequestType
  content: text
  tags: text[]
  document_id: uuid FK agent_documents.id (nullable)
  status: A2AStatus DEFAULT 'pending'
  response: text
  response_tags: text[]
  version: integer DEFAULT 1     # CAS field for concurrent acknowledgement
  priority: integer DEFAULT 0    # 0=lowest, 4=critical
  created_at: timestamptz
  resolved_at: timestamptz

oscillation_events:
  id: uuid PK
  document_id: uuid FK agent_documents.id
  quorum_id: uuid FK quorums.id
  field_path: text               # JSON path of oscillating field
  cycle_count: integer           # number of A→B→A full cycles
  involved_roles: uuid[]
  values_sequence: jsonb
  escalated: boolean DEFAULT false
  created_at: timestamptz

# --- Synthesis snapshots (migration: 20260512000001_synthesis_snapshots.sql) ---

synthesis_snapshots:
  id: uuid PK
  quorum_id: uuid FK quorums.id ON DELETE CASCADE
  tier: SynthesisTier             # 'keyword' | 'conflict' | 'synthesis'
  content: jsonb                  # raw structured tier output
  contribution_ids: uuid[] DEFAULT '{}'
  token_cost: integer (nullable)  # prompt+completion tokens; null for tier 1
  model: text (nullable)          # e.g. 'gpt-4o-mini', 'gpt-4o' — null for tier 1
  version: integer DEFAULT 1      # monotonic per (quorum_id, tier); bumped on re-synthesis
  created_at: timestamptz
  rls:
    select: open
    insert/update/delete: service_role only

# --- Participants (migration: 20260512000003_participants.sql) ---

participants:
  id: uuid PK
  quorum_id: uuid FK quorums.id ON DELETE CASCADE
  role_id: uuid FK roles.id ON DELETE SET NULL (nullable)
  station_label: text (nullable)
  display_name: text             # auto: "Visitor N" per (quorum_id, station_label)
  device_kind: DeviceKind        # 'laptop' | 'phone'
  last_heartbeat_at: timestamptz DEFAULT now()
  created_at: timestamptz DEFAULT now()
  rls:
    select: open
    insert/update/delete: service_role only

# Column additions from 20260512000003_participants.sql:
station_messages:
  participant_id: uuid FK participants.id ON DELETE SET NULL (nullable)   # attributes message to originating participant
contributions:
  participant_id: uuid FK participants.id ON DELETE SET NULL (nullable)   # attributes contribution to originating participant

# --- A2A endpoint registry (migration: 20260512000004_agent_endpoints.sql) ---

agent_endpoints:
  role_id: uuid PK FK roles.id ON DELETE CASCADE
  url: text                      # base URL the A2A client POSTs to (no trailing slash)
  capabilities: jsonb DEFAULT '{}'  # mirrored from AgentCard (skills, domain_tags, ...)
  registered_at: timestamptz DEFAULT now()
  last_seen_at: timestamptz DEFAULT now()
  realtime: true                 # ADDED to supabase_realtime publication
  rls:
    select: public
    insert/update/delete: service_role only

# Column additions from 20260512000005_a2a_request_claimed_at.sql:
agent_requests:
  claimed_at: timestamptz (nullable)   # set when autonomy loop CAS-claims a 'pending' row → 'processing'
  # A2AStatus enum: 'processing' value (re-asserted; defensively added by this migration if missing)
  # Index: idx_agent_requests_processing_claimed_at — partial, WHERE status = 'processing'
```

## Health Score Metrics

```yaml
HealthMetrics:
  completion_pct: float       # % artifact sections resolved
  consensus_score: float      # authority-weighted agreement 0-100
  critical_path_score: float  # inverted est. time to close (100 = done)
  role_coverage_pct: float    # % defined roles with ≥1 contribution
  blocker_score: float        # inverted blocker count (100 = no blockers)
```

## LLM Provider Interface

```typescript
interface LLMProvider {
  complete(prompt: string, tier: LLMTier): Promise<string>;
  embed(text: string): Promise<number[]>;
}
```

## Environment Variables

```
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_KEY=                       # optional — omit to use Managed Identity (DefaultAzureCredential)
AZURE_OPENAI_DEPLOYMENT_T2=             # cheap model (gpt-4o-mini) — conflict detection / agent chat
AZURE_OPENAI_DEPLOYMENT_T3=             # expensive model (gpt-4o) — artifact synthesis / deep reasoning
AZURE_OPENAI_DEPLOYMENT_T5=             # gpt-5-nano deployment via Responses API (optional — falls back to T2)
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=      # embedding deployment (text-embedding-3-small → 1536 dims,
                                        # text-embedding-3-large → 3072 dims).
                                        # REQUIRED for embed() on Azure; chat deployments do NOT serve embeddings.
                                        # Unset → AzureOpenAIProvider.embed() raises ValueError.
AZURE_OPENAI_API_VERSION=               # default: 2025-03-01-preview (required for Responses API on gpt-5)
AZURE_OPENAI_REASONING_DEPLOYMENTS=     # optional comma list of deployment names that should use Responses API

OPENAI_API_KEY=                         # required for plain OpenAIProvider
OPENAI_MODEL_T2=                        # default: gpt-4o-mini
OPENAI_MODEL_T3=                        # default: gpt-4o
OPENAI_EMBEDDING_MODEL=                 # default: text-embedding-3-small (1536 dims)

ANTHROPIC_API_KEY=                      # AnthropicProvider — embed() raises NotImplementedError
ANTHROPIC_MODEL_T2=                     # default: claude-haiku-4-5-20251001
ANTHROPIC_MODEL_T3=                     # default: claude-sonnet-4-6

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=                   # required for seed-agent-documents.py (bypasses RLS)
NEXTAUTH_SECRET=

# --- LLM provider envs (Pydantic AI provider implementations) ---
AZURE_OPENAI_API_VERSION=       # default '2025-03-01-preview'
AZURE_OPENAI_REASONING_DEPLOYMENTS=   # comma-separated deployment names that are reasoning models
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL_T2=             # e.g. 'claude-3-5-haiku-20241022'
ANTHROPIC_MODEL_T3=             # e.g. 'claude-3-5-sonnet-20241022'
OPENAI_API_KEY=
OPENAI_MODEL_T2=                # e.g. 'gpt-4o-mini'
OPENAI_MODEL_T3=                # e.g. 'gpt-4o'
OLLAMA_BASE_URL=                # local Ollama endpoint, e.g. 'http://localhost:11434'
OLLAMA_MODEL=                   # local model tag

# --- A2A protocol ---
QUORUM_A2A_BASE_URL=            # overrides the host advertised in AgentCard urls
                                # falls back to the incoming request origin if unset

# --- Autonomy loop ---
AUTONOMY_AUTO_CONTRIBUTE_MODE=  # 'off' (default) | 'concat' | 'synthesize'
                                # Controls whether the autonomy loop fabricates contributions
                                # when humans are silent. KEEP DEFAULT 'off' for expo —
                                # 'concat' produces fragment-salad artifacts;
                                # 'synthesize' adds one LLM call per turn.
```
