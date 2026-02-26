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
- **Database:** Supabase (Postgres + Realtime)
- **LLM:** Azure OpenAI (pluggable — swap for Anthropic or local)
- **Visualizations:** React Flow, Recharts, Framer Motion

---

## Quick Start

```bash
# Clone
git clone https://github.com/sagearbor/quorum.git
cd quorum

# Install (from repo root)
pnpm install --filter "./apps/*" --filter "./packages/*"

# Configure
cp .env.example .env
# Fill in: AZURE_OPENAI_ENDPOINT, SUPABASE_URL, SUPABASE_ANON_KEY
# AZURE_OPENAI_KEY is optional — omit for Managed Identity auth (see .env.example)

# Terminal 1 — FastAPI backend (http://localhost:8000)
cd apps && uvicorn api.main:app --reload

# Terminal 2 — Next.js frontend (http://localhost:3000)
cd apps/web && pnpm dev
```

---

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system design
- [CONTRACT.md](./CONTRACT.md) — API + schema spec (machine-readable)
- [DECISIONS.md](./DECISIONS.md) — decision log
- [DASHBOARDS.md](./DASHBOARDS.md) — visualization catalog

---

## Demo Mode (Offline)

Run the full expo experience with no backend, no API key, and no internet:

```bash
# Offline demo — everything runs client-side (http://localhost:3000)
cd apps/web && NEXT_PUBLIC_QUORUM_TEST_MODE=true pnpm dev
```

This activates the **DemoEngine**, which:
- Loads 1 pre-seeded clinical trial quorum with 12 realistic contributions and a draft artifact
- Includes 2 stub quorums (Medical Device Recall, ED Overcrowding) ready for interaction
- Ticks every 5 seconds: picks a random role, adds a realistic fake contribution
- Health score starts at 35 and rises ~3 points per tick, capping at 88
- Emits the same events as Supabase realtime (`contribution`, `health_update`, `artifact_update`)

**Key files:**
- `seed/clinical-trial.json` — structured seed data
- `apps/web/src/lib/demoMode.ts` — DemoEngine class (EventEmitter pattern)
- `apps/web/src/lib/dataProvider.ts` — unified interface (all components import from here)
- `apps/api/seed_loader.py` — loads seed data into Supabase on FastAPI startup

**Detection logic:** Demo mode activates if `NEXT_PUBLIC_QUORUM_TEST_MODE=true` **or** no `NEXT_PUBLIC_SUPABASE_URL` is set.

**To regenerate fixtures with a real API key:** Run the backend with Supabase configured, then export the quorum state from the `/quorums/{id}/state` endpoint.

---

## Status

Active development — MVP targeting Duke Tech Expo 2026
