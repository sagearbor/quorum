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

# Install
pnpm install

# Configure
cp .env.example .env
# Fill in: AZURE_OPENAI_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

# Dev
pnpm dev
```

---

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system design
- [CONTRACT.md](./CONTRACT.md) — API + schema spec (machine-readable)
- [DECISIONS.md](./DECISIONS.md) — decision log
- [DASHBOARDS.md](./DASHBOARDS.md) — visualization catalog

---

## Status

🚧 Active development — MVP targeting Duke Tech Expo 2026
