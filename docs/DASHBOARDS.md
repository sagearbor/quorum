# DASHBOARDS.md — Visualization Catalog

Each dashboard is a React component in `/components/dashboards/`. Built with React Flow (graphs), Recharts (charts), Framer Motion (animations).

## Default Dashboard

**Quorum Health Chart** — rendered for every quorum automatically.

Line chart, time on X, composite score 0–100 on Y (always good = up). Multiple lines (completion %, consensus, role coverage, critical path inverted). Target line (dotted) shows artifact generation threshold. Updates sub-second via Supabase realtime. Watching the line rise in real time as people contribute is the core engagement hook.

---

## Dashboard Catalog

| Name | Best For | What It Shows | Library |
|------|----------|---------------|---------|
| **Quorum Health Chart** | All scenarios (default) | Composite progress score rising over time as contributions come in | Recharts |
| **Authority Cascade Tree** | Hierarchical orgs (hospital, military) | Who overruled whom; which decisions still open at each authority level | React Flow |
| **Contribution River** | Disaster relief, supply chain | Role inputs as tributaries merging toward artifact delta; volume = weight | D3 |
| **Consensus Heat Ring** | Policy, ethics, course disputes | Concentric rings pulse outward as agreement builds; cold = conflict, amber = convergence | D3 + Framer |
| **Conflict Topology Map** | Multi-party negotiations | 3D terrain; peaks = unresolved conflicts, valleys = settled; erodes in real time | Three.js |
| **Decision Waterfall** | Clinical trials, regulatory | Decisions cascade through authority tiers; animated drops on each ruling | D3 + Framer |
| **Resolution Radar** | Multi-issue disputes | Spider chart per open issue; polygon tightens toward center as issues resolve | Recharts |
| **Role Coverage Map** | Auditing participation gaps | Which roles have contributed to each decision domain; gaps highlighted | React Flow |
| **Decision Dependency DAG** | Multi-phase plans | Blocked decisions vs. unblocked; critical path highlighted | React Flow |
| **Momentum Pulse** | Long-running quorums | Activity rate as sparkline; reveals stalls vs. acceleration | Recharts |
| **Authority-Weighted Gauge** | Near-complete quorums | Single dial: weighted consensus score → "readiness to close" | D3 |
| **Contribution Timeline** | Time-sensitive crises | Each role's contributions chronologically; conflict markers where positions diverged | Recharts |
| **Artifact Lineage Graph** | Any artifact-producing quorum | DAG tracing which contributions shaped each artifact section | React Flow |
| **Live Stance Board** | Fast negotiations, triage | Current position of each participant per open question; real-time scorecard | Custom |
| **Voice Pulse Matrix** | Live multi-human sessions | Role cards with live waveform; pulses on active contribution, fades on silence | Web Audio + Framer |
| **Authority Gravity Well** | IRB reviews, trial rescue | Roles orbit decision point as mass-bodies; authority = gravitational pull | D3 force |
| **Dissent Fault Lines** | High-stakes consensus | Tectonic map; disagreement = cracks, resolution = sealed; seismic tension bar | D3 |
| **Role Orbit Diagram** | Onboarding demos | Roles as planets; proximity to center = current influence; trailing arcs on activity | D3 force |
| **Temporal Scrub Timeline** | Post-hoc review, audit | Full session playback; scrub backward to replay any moment | Custom |
| **Conflict Resolution Flow** | Complex multi-round disputes | Sankey: initial disagreement → mediation → resolution; authority labeled per step | D3 Sankey |

---

## Carousel Configuration

The `/display` route shows a dual-panel carousel. Two modes:

**Multi-view:** Same quorum, different dashboards cycling every ~25s. Left panel shows current, right panel previews next.

**Multi-quorum:** Same dashboard type, different active quorums side by side. E.g., two Health Charts — both lines climbing simultaneously.

Event owner configures mode and selected dashboard types from architect view. Auto-mode: single quorum → multi-view; 3+ quorums → multi-quorum.

---

## Adding a New Dashboard

1. Create `/components/dashboards/MyDashboard.tsx`
2. Accept props: `{ quorum: Quorum, contributions: Contribution[], artifact: Artifact | null }`
3. Subscribe to realtime updates via `useQuorumLive(quorumId)`
4. Add entry to `DashboardType` enum in CONTRACT.md
5. Register in `/components/dashboards/index.ts`
