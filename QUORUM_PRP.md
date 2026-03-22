# Quorum — Product Requirements Proposal (PRP)
## Phase 2: AI Coordination, Provider Abstraction, Avatar System
**Version:** 2.0 | **Last updated:** 2026-03-22 | **Owner:** Sage Arbor

---

## Design Principles

1. **Local-first, cloud-optional.** Every feature must work with zero cloud accounts. Azure/Supabase are toggled via env vars.
2. **No stubs.** Every interface that is wired gets tested end-to-end.
3. **Commit every file.** Agents must commit after each meaningful unit of work.
4. **Tests stay green.** All 78+ backend (pytest) + 131+ frontend (vitest) tests must pass at every commit.
5. **Agents use real clients.** No placeholder implementations of inter-agent communication.

---

## Environment Variables (canonical reference)

```env
# Storage
STORAGE_PROVIDER=local          # local | azure_blob
AZURE_STORAGE_ACCOUNT=
AZURE_STORAGE_CONTAINER=quorum-files
AZURE_STORAGE_CONNECTION_STRING= # for local dev against Azurite

# Database
DATABASE_PROVIDER=supabase      # supabase | postgres
SUPABASE_URL=
SUPABASE_ANON_KEY=
DATABASE_URL=                   # postgresql://user:pass@host/db

# LLM
LLM_PROVIDER=openai             # openai | azure | local
OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_DEPLOYMENT=gpt-4o
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.3

# Coordination
COORDINATION_BACKEND=supabase   # supabase | a2a

# Avatar
AVATAR_PROVIDER=mock            # mock | elevenlabs | simli
AVATAR_MOCK=true
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=

# Testing
QUORUM_TEST_MODE=true           # zero API cost, mock all external calls
```

---

## Feature 1: Provider Abstraction Layer
**Branch:** `feature/provider-abstraction` | **Status:** ✅ Done (2026-03-22)

### Storage
- `apps/api/storage/provider.py` — ABC: `upload(key, data, content_type) -> str`, `download(key) -> bytes`, `get_url(key) -> str`, `delete(key) -> bool`
- `apps/api/storage/local_provider.py` — writes to `./uploads/`, serves via FastAPI `/static`
- `apps/api/storage/azure_blob_provider.py` — uses `DefaultAzureCredential` (no hardcoded keys); falls back to `AZURE_STORAGE_CONNECTION_STRING` for local dev against Azurite
- `apps/api/storage/factory.py` — `STORAGE_PROVIDER` → provider instance

### Database
- `apps/api/db/provider.py` — ABC with `get_client()`, `execute(query, params)`
- `apps/api/db/supabase_provider.py` — wraps existing Supabase client
- `apps/api/db/postgres_provider.py` — uses `DATABASE_URL`, works with any Postgres (local, Azure PG, Neon, Railway)
- `apps/api/db/factory.py` — `DATABASE_PROVIDER` → provider instance
- Note: existing `routes.py` not yet migrated; TODO comment added

### LLM
- `apps/api/llm/provider.py` — ABC: `complete(messages) -> str`, `stream(messages) -> AsyncIterator[str]`
- `apps/api/llm/openai_provider.py` — plain OpenAI API key (default for open-source users)
- `apps/api/llm/azure_provider.py` — `DefaultAzureCredential` + bearer token, `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT`
- `apps/api/llm/local_provider.py` — Ollama via openai SDK at `OLLAMA_BASE_URL`
- `apps/api/llm/factory.py` — `LLM_PROVIDER` → provider instance; `QUORUM_TEST_MODE=true` always returns mock

---

## Feature 2: A2A Coordination Backend
**Branch:** `feature/a2a-wire` | **Status:** ✅ Done (2026-03-22)

### What A2A is
Google's Agent-to-Agent protocol. Each agent exposes an HTTP endpoint. Agents send typed Tasks to each other. The Architect agent can send guidance to station agents in real time.

### Components
- `apps/api/coordination/backend.py` — ABC `CoordinationBackend`
- `apps/api/coordination/supabase_backend.py` — existing Supabase coordination logic
- `apps/api/coordination/a2a_backend.py` — A2A Task-based coordination
- `apps/api/coordination/factory.py` — `COORDINATION_BACKEND` → backend
- `apps/api/a2a/agent_card.py` — generate A2A agent card JSON per role
- `apps/api/a2a/a2a_server.py` — FastAPI endpoints: `POST /a2a/tasks/send`, `POST /a2a/tasks/sendSubscribe` (SSE), mounted at `/a2a`
- `apps/api/a2a/a2a_client.py` — async HTTP client to send Tasks to peer agents
- `apps/api/a2a/orchestrator.py` — collect contributions via A2A Tasks, synthesize

### Key endpoints
- `GET /a2a/agents/{role_id}/agent.json` — per-role A2A agent card
- `POST /a2a/guidance` — `{quorum_id, message, target_role_id?}` — Architect sends guidance; falls back to Supabase if agent unreachable
- `GET /api/quorums/{quorum_id}/state-snapshot` — compressed quorum state (for Architect to read efficiently)
- `GET /a2a/guidance/{quorum_id}` — recent architect guidance messages

### State snapshot schema (Supabase table: quorum_state_snapshots)
```sql
CREATE TABLE IF NOT EXISTS quorum_state_snapshots (
  quorum_id uuid PRIMARY KEY,
  updated_at timestamptz,
  snapshot jsonb  -- {role_health: dict, key_tensions: [str], contributions_count: int, last_synthesis_excerpt: str, blocked_roles: [str]}
);
```
Written after every synthesis run. Architect reads this for O(1) context cost regardless of session length.

---

## Feature 3: Role Dependency Chains (blocked_by)
**Branch:** `feature/blocked-by` | **Status:** ✅ Done (2026-03-22)

### Purpose
Architect can sequence roles: "Data Analyst must contribute before Synthesizer can speak." Enables structured deliberation workflows where some roles depend on others.

### DB changes
```sql
ALTER TABLE roles ADD COLUMN IF NOT EXISTS blocked_by uuid[] DEFAULT '{}';
ALTER TABLE roles ADD COLUMN IF NOT EXISTS status text DEFAULT 'active'
  CHECK (status IN ('pending','blocked','active','completed'));
```

### Logic
- On quorum create: roles with non-empty `blocked_by` get `status='blocked'`
- After each contribution is stored: `resolve_dependencies(quorum_id, role_id)` unblocks any role whose full `blocked_by` list is now satisfied
- WebSocket event `role_unblocked` fires when a role becomes active
- `GET /api/quorums/{quorum_id}/role-status` — current status of all roles

### UI
- **RoleBuilder**: "Depends on" multi-select per role card
- **Display dashboard**: blocked roles show gray overlay + lock icon + "Waiting for: [names]"; animates unlock on WS event

---

## Feature 4: AI Architect Agent
**Branch:** `feature/ai-architect` | **Status:** ✅ Done (2026-03-22)

### Purpose
Human types a problem description → AI generates 4-6 roles → human either auto-starts or reviews/edits first.

### Mode A (Auto-start)
Problem → generate_roles → create quorum + roles immediately → redirect to live dashboard.

### Mode B (Review first)
Problem → generate_roles → show editable role cards → human approves/edits/adds/removes → Approve & Start → create quorum → redirect.

### Backend
- `apps/api/architect_agent.py`
  - `RoleSuggestion`: name, description, authority_rank (1-5), capacity, suggested_prompt_focus
  - `generate_roles(problem, llm_provider) -> list[RoleSuggestion]` — LLM call with structured JSON output; mock in QUORUM_TEST_MODE
  - `send_guidance(quorum_id, message, target_role_id?)` — uses real `A2AClient`; Supabase fallback
- `POST /api/events/{event_id}/architect/generate-roles` — `{problem}` → `{roles, problem_summary}`
- `POST /api/events/{event_id}/architect/ai-start` — `{problem, roles, mode, quorum_title}` → `{quorum_id, share_url}`
- `POST /api/quorums/{quorum_id}/architect/guidance` — `{message, target_role_id?}`

### Frontend
- `apps/web/src/app/architect/components/AIArchitectPanel.tsx` — problem textarea, mode selector, role cards (editable), Start/Approve & Start buttons
- `apps/web/src/app/architect/page.tsx` — tab toggle: "Manual Setup" | "AI Architect"
- `apps/web/src/store/architect.ts` — adds: aiMode, problemDescription, generatedRoles

---

## Feature 5: Avatar System (Phase 4)
**Branches:** `avatar/track-{a,b,c,d}` all merged to main | **Status:** ✅ Core done, integration pending

### Summary (see AVATAR.md + AVATAR_PRD.md for full spec)
- **Track A**: Asset pipeline — placeholder GLTF generator, animation stubs, RPM setup scripts
- **Track B**: 12 role archetypes — keyword resolver, Duke blue material override (#003087)
- **Track C**: IdleScene (R3F), VisionTracker (MediaPipe gaze), EmotionDetector (MediaPipe face)
- **Track D**: 6 named transitions (ZoomIn, JogAndPeek, RunAndBounce, SitDown, DepthBlur, EyeMatchCut) + TransitionEngine + test harness
- **Track E (pending)**: Integration — wire IdleScene + transitions + archetypes into AvatarPanel + useAvatarController

### Key env vars
```env
AVATAR_PROVIDER=mock            # mock | elevenlabs | simli
AVATAR_MOCK=true                # CSS/SVG fallbacks, zero deps
AVATAR_TRANSITION_TEST=true     # cycles all 6 transitions
AVATAR_TRANSITION_INTERVAL=5000 # ms between transitions
```

### AVATAR_MOCK=true requirement
Every avatar component must have a non-three.js fallback so `AVATAR_MOCK=true` works with zero external deps.

---

## Feature 6: Azure Migration Path (planned)
**Status:** 🔲 Not started

### Target architecture
All services deployable to Azure, toggled via env vars, no code changes required.

| Service | Local | Azure |
|---|---|---|
| Database | Supabase / local Postgres | Azure Database for PostgreSQL Flexible Server |
| LLM | OpenAI API key | Azure OpenAI + Managed Identity |
| Storage | Local filesystem | Azure Blob Storage |
| Auth | Supabase Auth | Azure Entra ID (post-expo) |
| Hosting | Local / Vercel | Azure Container Apps |

### Security pitch (expo)
"Runs entirely within Duke's Azure tenant. Managed Identity — no API keys stored anywhere. HIPAA-eligible infrastructure."

### Implementation plan
1. Bicep/Terraform: Azure PG Flexible Server + Blob Storage + Container Apps (one `azuredeploy.bicep`)
2. Schema migration script: `supabase db dump | psql $AZURE_PG_URL`
3. Connection config: existing `DATABASE_URL` env var routes to Azure PG
4. Container build: `Dockerfile` for API + `next build` for web → Azure Container Registry
5. Managed Identity: already built in `azure_provider.py` and `azure_blob_provider.py`

### Agent task (ready to spawn when wanted)
- Create `/tmp/quorum-azure-deploy` worktree on `feature/azure-deploy`
- Task: write Bicep templates, Dockerfiles, GitHub Actions CI/CD, migration script
- Estimate: 1 agent session, ~1 hour

---

## Integration Checklist (what still needs wiring)

- [ ] **Track E Avatar integration** — wire IdleScene, VisionTracker, archetypes, transitions into AvatarPanel
- [ ] **Migrate routes.py to DatabaseProvider** — remove direct Supabase calls, use `db/factory.py`
- [ ] **Azure deploy templates** — Bicep + Dockerfiles + CI/CD
- [x] **Merge all feature branches to main** — feature/a2a-wire, feature/blocked-by, feature/ai-architect, feature/provider-abstraction
- [ ] **End-to-end test** — `AVATAR_MOCK=true QUORUM_TEST_MODE=true pnpm dev` → verify all features work together

---

## Agent Instructions (for any coding agent reading this)

1. **Always read this file first** before starting work
2. **Check `git log --oneline main..HEAD`** to see what's already done on your branch
3. **Commit every file** — not batches. One logical unit per commit.
4. **Run tests before final commit**: `cd apps/api && QUORUM_TEST_MODE=true pytest` + `cd apps/web && pnpm test --run`
5. **No stubs** — if an interface isn't ready, coordinate with Sophie; don't fake it
6. **QUORUM_TEST_MODE=true** must work with zero external API calls
7. **AVATAR_MOCK=true** must work with zero Three.js / WebGL deps
