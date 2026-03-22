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

## Local Quickstart

**Prerequisites:** Python 3.11+, Node 18+, pnpm, Postgres (or a Supabase account)

```bash
# 1. Clone + install
git clone https://github.com/sagearbor/quorum.git
cd quorum
pnpm install --filter "./apps/*" --filter "./packages/*"
pip install -r apps/api/requirements.txt

# 2. Configure
cp .env.example .env
# Edit .env — set OPENAI_API_KEY (or set QUORUM_LLM_PROVIDER=local + OLLAMA_BASE_URL for Ollama)

# 3. Database — pick one:
#    Option A: Local Postgres
#      Uncomment DATABASE_PROVIDER=postgres and set DATABASE_URL=postgresql://user:pass@localhost:5432/quorum
#    Option B: Supabase
#      Set SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_KEY

# 4. Run
# Terminal 1 — FastAPI backend (http://localhost:8000)
cd apps && uvicorn api.main:app --reload

# Terminal 2 — Next.js frontend (http://localhost:3000)
cd apps/web && pnpm dev
```

> **Everything else defaults to local** — no Azure account needed. Storage uses the local filesystem, LLM defaults to OpenAI (just an API key). See `.env.example` for all provider toggles.

---

## Quick Start (Azure / Cloud)

```bash
cp .env.example .env
# Fill in: AZURE_OPENAI_ENDPOINT, SUPABASE_URL, SUPABASE_ANON_KEY
# Set QUORUM_LLM_PROVIDER=azure, STORAGE_PROVIDER=azure_blob
# For Azure auth without API keys: omit AZURE_OPENAI_KEY, run `az login`
pip install -r requirements-azure.txt  # Azure-specific deps

cd apps && uvicorn api.main:app --reload
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
