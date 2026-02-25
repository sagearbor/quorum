# Quorum — Architecture

## Data Model

```
Event
├── id, name, slug, access_code, max_active_quorums
├── created_by (architect user id)
└── Quorums[]
    ├── id, title, description, status (open|active|resolved)
    ├── heat_score (active contributors + input velocity)
    ├── authority_hierarchy: Role[] ordered by override rank
    ├── Roles[]
    │   ├── id, name, capacity (1 | unlimited), color
    │   ├── authority_rank (integer, higher = more override power)
    │   ├── prompt_template (structured input fields for this role)
    │   └── fallback_chain: Role[] (proxy escalation if absent)
    ├── Contributions[]
    │   ├── id, role_id, user_token, content, structured_fields
    │   ├── tier (1=keyword | 2=conflict | 3=synthesis)
    │   └── timestamp
    ├── Artifact
    │   ├── id, version, content_hash
    │   ├── sections[] (each section has source contributions)
    │   └── status (draft | pending_ratification | final)
    └── DashboardConfig
        ├── selected_types: DashboardType[]
        └── carousel_mode (multi-view | multi-quorum)
```

## System Components

### Frontend (Next.js / Vercel)

```
/app
  /event/[slug]          — Event landing, quorum card grid
  /event/[slug]/quorum/[id]  — Quorum view (role terminal)
  /display/[slug]        — Read-only projection carousel (no interaction)
  /architect             — Create/manage events and quorums
/components
  /dashboards            — One component per dashboard type
  /carousel              — Dual-panel sliding carousel
  /role-terminal         — Contribution UI per role
  /authority-stack       — Drag-to-rank hierarchy builder
```

### Backend (FastAPI / Railway)

```
POST   /events                    — Create event
POST   /events/{id}/quorums       — Create quorum
POST   /quorums/{id}/contribute   — Submit role contribution
GET    /quorums/{id}/state        — Current quorum state
POST   /quorums/{id}/resolve      — Trigger artifact generation
WS     /quorums/{id}/live         — WebSocket for realtime dashboard updates
```

### LLM Synthesis (Azure OpenAI — pluggable)

Three-tier processing to control cost:
- **Tier 1** (free): Deterministic dedup + keyword extraction
- **Tier 2** (cheap, GPT-4o-mini): Conflict detection between inputs
- **Tier 3** (expensive, GPT-4o): Final artifact synthesis — fires once per quorum

Provider interface: `LLMProvider { complete(prompt, tier) }` — swap Azure / Anthropic / local behind this.

### Realtime (Supabase)

- Supabase Realtime for dashboard state push
- WebSocket debounce: batch artifact updates max 1/sec to prevent thundering herd
- Optimistic locking on artifact writes (version column + CAS)

## Station URL Pattern

```
https://quorum.app/event/duke-expo-2026?station=2
```

- `station=N` sets default role preference (pre-highlights the mapped role pill)
- User can navigate to any quorum and switch roles freely
- Station mapping configured by architect at event setup

## Security

- Events: access_code required for architects to join
- Open quorums: public URL, soft token on join (anon JWT, rate-limited)
- Closed quorums: password required
- LLM inputs: hardened system prompt + output schema validation (prompt injection mitigation)
- API cost: graceful error on budget exhaustion, event owner notified

## Key Design Decisions

See DECISIONS.md for full log. Highlights:
- Terminals are role-first (not scenario-first) — roles are stable, scenarios change
- No forced time-flow or hierarchy in navigation — architect defines structure
- Camera/presence detection is post-MVP (display-only, never gates authority)
- Azure OpenAI default (BAA for HIPAA compliance at DCRI)
