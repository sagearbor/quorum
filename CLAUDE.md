# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@agent.md

## Build & Dev Commands

### Frontend (apps/web) — Next.js + pnpm
```bash
pnpm install                          # install all workspace deps
pnpm --filter web dev                 # dev server (localhost:3000)
pnpm --filter web build               # production build
pnpm --filter web lint                # ESLint
pnpm --filter web test                # vitest run (all tests)
pnpm --filter web test -- src/path/to/file.test.tsx  # single test file
pnpm --filter web test:watch          # vitest watch mode
```

### Backend (apps/api) — FastAPI + Python
```bash
cd apps/api && pip install -r requirements.txt
uvicorn apps.api.main:app --reload    # dev server (localhost:8000)
```

### LLM Package (packages/llm) — Python
```bash
cd packages/llm && pip install -e ".[dev]"
pytest packages/llm/tests/            # run LLM package tests
pytest packages/llm/tests/test_budget.py  # single test file
```

### Shared Types (packages/types) — TypeScript
```bash
pnpm --filter @quorum/types build     # compile TS types
pnpm --filter @quorum/types typecheck # type-check only
```

### Demo Mode (no backend, no API keys)
```bash
NEXT_PUBLIC_QUORUM_TEST_MODE=true pnpm --filter web dev
```

## Architecture

**Monorepo** (pnpm workspaces): `apps/web`, `apps/api`, `packages/types`, `packages/llm`.

### Data flow: Event → Quorums → Roles → Contributions → Artifact

The frontend has two data paths that share the same interface:

- **Live mode**: Components call `dataProvider.ts` which queries Supabase and subscribes to Postgres realtime channels.
- **Demo mode**: `dataProvider.ts` activates only when `NEXT_PUBLIC_QUORUM_TEST_MODE=true` is explicitly set, and routes to `demoMode.ts` (DemoEngine), an in-memory EventEmitter that ticks fake contributions from `seed/clinical-trial.json`. Missing Supabase URL yields empty state, not mock data.

Components must **always import from `@/lib/dataProvider`**, never from `supabase.ts` or `demoMode.ts` directly.

### Frontend state management
- **Zustand** stores: `architect.ts` (event/quorum creation wizard), `quorumStore.ts` (live quorum state)
- **Realtime hook**: `useQuorumLive(quorumId)` subscribes via dataProvider

### Backend LLM processing — three tiers
- **Tier 1** (deterministic): keyword extraction on every contribution
- **Tier 2** (GPT-4o-mini): conflict detection when structured fields overlap
- **Tier 3** (GPT-4o): full artifact synthesis — fires once per quorum at resolve time

All LLM calls go through `packages/llm/quorum_llm/interface.py:LLMProvider` ABC. The factory (`factory.py`) auto-selects `MockLLMProvider` when `QUORUM_TEST_MODE=true`. Never call Azure/Anthropic SDKs directly — use the provider interface.

### Artifact writes use optimistic locking
The `/quorums/{id}/resolve` route uses version + CAS (compare-and-swap) on the artifacts table. If version conflicts, it returns 409.

### Testing
- Frontend: Vitest + jsdom + React Testing Library + MSW for API mocking
- MSW handlers in `apps/web/src/mocks/handlers.ts` match `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:8000`)
- Test setup: `apps/web/src/test/setup.ts` (cleanup), test helper: `src/test/renderWithProviders.tsx`
- Python: pytest + pytest-asyncio for `packages/llm`

### Key routes (App Router)
- `/architect` — event creation wizard (multi-step form)
- `/event/[slug]` — event landing with quorum cards
- `/event/[slug]/quorum/[id]` — live quorum view
- `/display/[slug]` — read-only projection carousel (no interaction)

### Avatar Facilitator System
- Spec: `docs/AVATAR.md` (feature spec), `docs/AVATAR_PRD.md` (product requirements)
- 12 archetypes (medical, ethics, researcher, etc.) with Ready Player Me GLTFs in `apps/web/public/avatars/`
- `apps/web/src/components/avatar/` — AvatarPanel, IdleScene (R3F), VisionTracker (MediaPipe), EmotionDetector, StereoAnalyzer
- Pluggable provider: `AvatarProvider` interface with MockProvider, SimliProvider, ElevenLabsProvider
- Role → archetype mapping: `archetypes/resolveArchetype.ts`
- 6 transition effects: `transitions/TransitionEngine.ts`
- Asset pipeline: `scripts/setup-avatar-assets.sh` (placeholder GLTFs ship in repo; replace with real RPM avatars)

### Adding a new dashboard
1. Create `apps/web/src/components/dashboards/MyDashboard.tsx`
2. Accept props: `{ quorum, contributions, artifact }` + use `useQuorumLive(quorumId)`
3. Add to `DashboardType` enum in docs/CONTRACT.md and `packages/types/src/dashboard.ts`
4. Register in `components/dashboards/index.ts`
