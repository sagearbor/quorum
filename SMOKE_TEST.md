# Smoke Test Results

**Date:** 2026-03-22
**Branch:** `feature/e2e-smoke`
**Environment:** `QUORUM_TEST_MODE=true AVATAR_MOCK=true`

## Backend Tests (pytest)

- **81 passed, 0 failed**
- Includes: A2A wire tests, architect agent tests, A2A wakeup tests, agent endpoint tests
- Note: Must run from repo root (`python3 -m pytest apps/api/`) for module resolution

## Frontend Tests (vitest)

- **467 passed, 0 failed** across 34 test files
- Covers: avatar system (IdleScene, VisionTracker, EmotionDetector, StereoAnalyzer, AvatarPanel, AvatarProvider, transitions, archetypes), dashboards, architect wizard, stores, mocks, data provider

## Import Checks

| Module | Status |
|--------|--------|
| `apps.api.main` | OK |
| `apps.api.routes.router` | OK |
| `apps.api.architect_agent.generate_roles` | OK |
| `apps.api.a2a.a2a_client.A2AClient` | OK |

Requires `pip install -e packages/llm` for `quorum_llm` module.

## Frontend Build

- **Passes** (`pnpm --filter web build`)
- All routes compile and generate successfully

## Fixes Applied

1. **ESLint errors** — removed unused imports/variables, added eslint-disable for necessary `any` types on MediaPipe detectors
2. **Set downlevel iteration** — used `Array.from()` for Set spread in display page
3. **DemoQuorum type mismatch** — added `created_at` field to `DemoQuorum` interface and seed data
4. **EnrichedQuorum cast** — bridged DemoQuorum→EnrichedQuorum type gap in event page

## Known Issues

- Backend tests fail if run from `apps/api/` directory (module resolution); run from repo root instead
- `quorum_llm` package must be installed separately (`pip install -e packages/llm`)
- Avatar components use `any` for MediaPipe detector/landmarker types (no TS typings available)

## How to Run Locally

```bash
cp .env.example .env
# Set OPENAI_API_KEY or OLLAMA_BASE_URL/OLLAMA_MODEL in .env
# Or set QUORUM_TEST_MODE=true for zero-cost mock mode

pip install -e packages/llm
pnpm install

# Backend
QUORUM_TEST_MODE=true python3 -m pytest apps/api/

# Frontend
pnpm --filter web test --run
pnpm --filter web build

# Dev server (demo mode, no backend needed)
NEXT_PUBLIC_QUORUM_TEST_MODE=true pnpm --filter web dev
```
