# agent.md — AI Agent Onboarding

> Read this first. Everything an AI agent needs to understand and extend this codebase.

## What This Is

Quorum is a multi-agent coordination platform. Real people with different roles and authority levels collaborate to solve problems in real time. A live dashboard shows the problem resolving. A downloadable artifact is produced at the end.

## Read These Files

1. **docs/ARCHITECTURE.md** — system design, data model, component map
2. **docs/CONTRACT.md** — all API routes, Supabase tables, enums, env vars (machine-readable)
3. **docs/DECISIONS.md** — why things are built the way they are; do not re-propose rejected alternatives
4. **docs/DASHBOARDS.md** — visualization catalog and how to add new ones
5. **docs/AVATAR.md** — avatar facilitator spec (eye tracking, TTS, transitions)

## Key Concepts

- **Event** → **Quorums** → **Roles** → **Contributions** → **Artifact**
- Roles have `authority_rank` — higher rank = overrides lower on conflict
- Roles have `capacity: 1 | "unlimited"` — single person or committee
- LLM calls are tiered (1=free, 2=cheap, 3=expensive-once-per-quorum)
- All realtime state flows through Supabase + WebSocket
- Station URLs: `?station=N` sets default role, user can navigate freely
- `/display` route is projection-only, read-only, carousel auto-rotates

## Stack

- Next.js 14 (App Router) — frontend
- FastAPI — backend
- Supabase — DB + realtime
- Azure OpenAI — LLM (pluggable via `LLMProvider` interface)
- React Flow — graph dashboards
- Recharts — line/chart dashboards
- Framer Motion — animations
- pnpm — package manager

## Rules

- Never hardcode Azure credentials — use env vars from docs/CONTRACT.md
- Never bypass the `LLMProvider` interface — swap providers there, not in business logic
- All artifact writes use optimistic locking (version + CAS)
- Dashboard components must accept standard props — see docs/DASHBOARDS.md
- Do not add prose to docs/CONTRACT.md — structured YAML/JSON only
- Append to docs/DECISIONS.md when making architectural choices

## Repo Structure (target)

```
quorum/
├── apps/
│   ├── web/          # Next.js frontend
│   └── api/          # FastAPI backend
├── packages/
│   ├── types/        # Shared TypeScript types
│   └── llm/          # LLMProvider interface + adapters
├── components/
│   └── dashboards/   # One file per dashboard type
├── supabase/
│   └── migrations/   # DB schema migrations
├── seed/
│   └── clinical-trial.json  # Seed quorum (anchor demo)
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CONTRACT.md
│   ├── DASHBOARDS.md
│   ├── DECISIONS.md
│   ├── PRD.md
│   ├── AVATAR.md         # Avatar facilitator spec
│   ├── AVATAR_PRD.md     # Avatar product requirements
│   └── SETUP.md          # Manual setup walkthrough
├── README.md
├── CLAUDE.md
└── agent.md          # This file
```
