# Quorum

**Multi-agent coordination platform for real-world problem-solving.**

Quorum lets groups with different roles and authority levels collaborate on problems in real time, producing a downloadable artifact (decision brief, recovery plan, action item list).

Built for distributed teams. Demoed at Duke Tech Expo 2026.

---

## What It Does

- An **Event** (e.g., "Duke Tech Expo") contains multiple **Quorums** (problems being solved)
- Each Quorum has **Roles** with a configurable authority hierarchy (IRB > Physician > Patient, or flat)
- **Role Terminals** are just browser URLs — any device, no install
- Contributions stream in via voice or text; AI synthesizes per role
- A live **dashboard** (carousel of visualization types) shows the Quorum resolving in real time
- When resolved, a **downloadable artifact** is generated (PDF/JSON)

## Works With Partial Adoption

Even if only 2 of 10 parties use it, Quorum creates value. Absent roles trigger async fallback (email approve/reject link). No full buy-in required.

---

## Stack

- **Frontend:** Next.js (Vercel)
- **Backend:** FastAPI + WebSockets (Railway)
- **Database:** Supabase (Postgres + Realtime) — or any Postgres
- **LLM:** OpenAI (default), Azure OpenAI, Anthropic, or Ollama (local)
- **Storage:** Local filesystem (default) or Azure Blob
- **Visualizations:** React Flow, Recharts, Framer Motion

---

## Quickstart

**Prerequisites:** Python 3.11+, Node 18+, pnpm

```bash
git clone https://github.com/sagearbor/quorum.git
cd quorum
pnpm install
pip3 install -r apps/api/requirements.txt && pip3 install -e packages/llm
```

### Run with Supabase (default — production-like)

Set your credentials in `apps/web/.env.local` and `apps/api/.env`:

```bash
# apps/api/.env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
QUORUM_LLM_PROVIDER=openai          # or azure, anthropic, local
OPENAI_API_KEY=sk-...               # if using openai provider
```

```bash
./scripts/start.sh          # API (8000) + frontend (3000)
./scripts/start.sh api      # backend only
./scripts/start.sh web      # frontend only
```

### Run locally (no Supabase, no API keys)

```bash
./scripts/start.sh --local           # SQLite + MockLLM, everything offline
./scripts/start.sh --local api       # backend only
```

### Demo mode (no backend at all)

```bash
cd apps/web && NEXT_PUBLIC_QUORUM_TEST_MODE=true pnpm dev
```

---

## Docs

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — system design
- [CONTRACT.md](./docs/CONTRACT.md) — API + schema spec (machine-readable)
- [DECISIONS.md](./docs/DECISIONS.md) — decision log
- [SETUP.md](./docs/SETUP.md) — manual setup walkthrough
- [DASHBOARDS.md](./docs/DASHBOARDS.md) — visualization catalog

---

## A2A Agent Autonomy

Quorum includes an agent-to-agent (A2A) communication system. Set `autonomy_level` (0-1) when creating a quorum:

| Level | Behavior |
|-------|----------|
| 0.0 | Human only — agents respond to messages but don't initiate |
| 0.1-0.3 | Human-led — agents occasionally share insights across stations |
| 0.4-0.6 | Collaborative — agents proactively contribute |
| 0.7-0.9 | Agent-led — agents auto-contribute and drive toward resolution |
| 1.0 | Fully autonomous — agents solve it on their own |

The architect can adjust autonomy in real-time from the quorum page header.

---

## Status

Active development — MVP targeting Duke Tech Expo 2026
