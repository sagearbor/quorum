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
CarouselMode: [multi-view, multi-quorum]
LLMTier: [1, 2, 3]
LLMProvider: [azure, anthropic, openai, local]
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

POST /quorums/{quorum_id}/contribute:
  body:
    role_id: uuid
    user_token: string
    content: string
    structured_fields: { [field_name]: string }
  returns: { contribution_id: uuid, tier_processed: LLMTier }

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
AZURE_OPENAI_DEPLOYMENT_T2=   # cheap model (gpt-4o-mini)
AZURE_OPENAI_DEPLOYMENT_T3=   # expensive model (gpt-4o)
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=
NEXTAUTH_SECRET=
```
