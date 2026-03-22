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
AZURE_OPENAI_KEY=
AZURE_OPENAI_DEPLOYMENT_T2=    # cheap model (gpt-4o-mini) — conflict detection
AZURE_OPENAI_DEPLOYMENT_T3=    # expensive model (gpt-4o) — artifact synthesis
AZURE_OPENAI_DEPLOYMENT_T5=    # embedding model (text-embedding-ada-002 or text-embedding-3-small)
                                # Used for semantic similarity in tag affinity engine.
                                # Falls back to tag-only Jaccard similarity if unset.
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=           # required for seed-agent-documents.py (bypasses RLS)
NEXTAUTH_SECRET=
```
