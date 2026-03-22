# Quorum Codebase Context

## Stack
- Frontend: Next.js 14 (app router), TypeScript, Tailwind, Zustand, React Query — `apps/web/`
- Backend: FastAPI, Python, Supabase (postgres) — `apps/api/`
- Tests: Vitest (frontend), pytest (backend) — ALL MUST STAY GREEN
- Monorepo root: `pnpm` workspaces

## Key files
- `apps/api/main.py` — FastAPI app entrypoint
- `apps/api/routes.py` — all HTTP routes
- `apps/api/models.py` — Pydantic models
- `apps/api/llm.py` — LLM calls (uses QUORUM_TEST_MODE=true for tests, returns mock data)
- `apps/api/ws_manager.py` — WebSocket broadcast
- `apps/web/src/store/architect.ts` — Zustand store for Architect wizard
- `apps/web/src/app/architect/` — Architect UI (3-step wizard: CreateEvent, CreateQuorum/roles, LiveDashboard)
- `apps/web/src/app/display/[slug]/` — Display projector view
- `apps/web/src/app/station/` — Station participant view

## Database (Supabase)
Tables: events, quorums, roles, contributions, synthesis_snapshots
- roles has: id, quorum_id, name, capacity, authority_rank, prompt_template, fallback_chain

## A2A branch (runtime/track-y) — NOT YET MERGED
Has: CoordinationBackend ABC, SupabaseBackend, A2ABackend, factory, agent_card.py, a2a_server.py, a2a_client.py, orchestrator.py
Factory: COORDINATION_BACKEND=supabase|a2a env var

## Test commands
- Backend: cd apps/api && QUORUM_TEST_MODE=true pytest
- Frontend: cd apps/web && pnpm test --run
