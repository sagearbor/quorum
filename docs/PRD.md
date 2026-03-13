# Quorum — Product Requirements Document

## Problem

Disparate parties in complex domains (biomedical, academic, emergency response) fail to coordinate effectively. They communicate through different channels, have no shared authority model, and produce no actionable artifact. Decisions stall. Patients wait. Opportunities disappear.

**The core failure:** No single person sees the whole picture, and no system resolves who gets the final say.

## Solution

Quorum is a multi-agent coordination platform. Parties with configurable authority levels collaborate in real time around a shared problem. A live dashboard shows the problem resolving. A downloadable artifact is produced at the end.

Works with partial adoption — even 2 of 10 parties create value. No full institutional buy-in required.

---

## Users / Personas

| Persona | Who | Goal |
|---|---|---|
| **Architect** | Event organizer | Create event, define quorums, set roles + authority hierarchy |
| **Participant** | Domain expert (IRB, physician, patient, etc.) | Walk up to a station or scan QR, contribute as their role |
| **Observer** | Conference attendee, leadership | Watch the projected dashboard, see the problem resolving live |
| **Async Participant** | Absent role holder | Approve/reject via email link (signed JWT, no login required) |

---

## MVP Feature Set

### 1. Event Management
- Create an event with name, slug, access code, max concurrent quorums (default 5)
- Architects join via access code
- New event = clean slate (no bleed from prior events)

### 2. Quorum Creation (Architect)
- Define: title, description, roles
- Per role: name, capacity (1 = single / unlimited = committee), authority_rank, prompt_template fields
- Drag-to-rank authority hierarchy (chips in vertical stack)
- Choose dashboard type(s) for this quorum
- Carousel mode: multi-view or multi-quorum

### 3. Station URL Routing
- Every station is a dumb browser: `https://quorum.app/event/{slug}?station=N`
- `?station=N` sets default role preference (pre-highlights that role)
- User can navigate to any quorum and switch roles freely — station default is a preference, not a lock
- Pre-print one QR code per station. Works for all quorums created after the fact.

### 4. Contribution UI (Role Terminal)
- Card grid of active quorums on load
- Tap a quorum → see roles as full-width pill buttons with live participant count (e.g. `IRB (2)`)
- Tap a role → structured input form (fields defined by architect's prompt_template)
- Text input (primary); voice input via Web Speech API (secondary, MVP)
- Turn queue: if multiple voices detected, record segments, show side-by-side, tap to submit
- Persistent bottom bar: `[⊞ All Quorums]` + current role chip

### 5. LLM Synthesis (Three-Tier, Azure OpenAI)
- **Tier 1** (free): deterministic dedup + keyword extraction — runs on every input
- **Tier 2** (cheap, GPT-4o-mini): conflict detection — runs when ≥2 inputs address same field
- **Tier 3** (expensive, GPT-4o): final artifact synthesis — runs once per quorum on resolve
- LLM provider behind `LLMProvider` interface — swap Azure / Anthropic / local without app changes
- On API budget exhaustion: graceful error, event owner notified, no upfront rate limiting

### 6. Quorum Health Chart (Default Dashboard)
- Line chart: time on X, composite score 0–100 on Y (always good = up)
- Metrics: completion %, consensus score, role coverage %, critical path (inverted)
- Optional target line (dotted): artifact generation threshold
- Updates sub-second via Supabase realtime + smooth CSS transition
- Watching the line rise as people talk is the core engagement hook

### 7. Artifact Generation
- Triggered by Architect (or auto when health score > threshold)
- PDF download: sections, source contributions, authority sign-off block
- Artifact versioning: content-hashed, "compare to previous" diff view
- Status: `draft` → `pending_ratification` → `final`

### 8. Projection Display (`/display` route)
- Read-only URL — plug into projector, no interaction surface
- Dual-panel carousel: two dashboards visible, new ones slide in from left
- **Multi-view mode**: same quorum, different dashboard types cycling ~25s
- **Multi-quorum mode**: same dashboard, different quorums side by side
- Auto-mode: 1 quorum active → multi-view; 3+ quorums → multi-quorum
- Event owner configures mode from architect view

### 9. Proxy Escalation (Absent Roles)
- Each role has a configured fallback chain at quorum creation
- If role absent after N minutes → escalate to delegate
- If no delegate → artifact tagged `PENDING_RATIFICATION`
- Absent role gets email with one-click approve/reject (signed JWT, no login)
- Dashboard shows: `2/3 live, 1 async-pending`

### 10. Seed Quorum (Clinical Trial Anchor)
- Pre-built, pre-populated clinical trial scenario loaded at every new event
- Synthetic but realistic data (fake trial NCT#, fake sites, realistic IRB block)
- Rises on heat metrics by default — ensures expo always has a live, polished demo
- First participant interaction makes the flowchart visibly move

---

## Out of Scope for MVP

- Camera / presence detection (post-MVP, lower priority)
- Dashboard types beyond Quorum Health Chart (add in Phase 2)
- HIPAA-compliant hosting (MVP uses synthetic data only; DCRI deployment is Phase 3)
- Mobile native app
- Multi-event analytics / admin dashboard
- SSO / institutional auth

---

## User Flows

### Flow 1: Architect Creates Event + Quorum
1. Go to `/architect` → enter event name + access code → create
2. Share access code with other architects
3. Click "New Quorum" → enter title + description
4. Add roles → set name, capacity, authority rank (drag chips to reorder)
5. Set dashboard type + carousel mode
6. Share event slug (`/event/duke-expo-2026`) — project `/display/duke-expo-2026` on screen

### Flow 2: Participant at Station
1. Station loads `quorum.app/event/duke-expo-2026?station=3`
2. Card grid shows active quorums — default role pre-highlighted
3. Tap a quorum card → roles expand as pills
4. Tap role pill → structured form appears (fields from prompt_template)
5. Type or speak → submit → health chart rises on projected display
6. Bottom bar persists — tap `⊞ All Quorums` to switch

### Flow 3: Observer Watches Projection
1. `/display/duke-expo-2026` on projector
2. Two dashboards side by side, cycling automatically
3. Health chart lines rise in real time as contributions come in
4. Hot quorums rise to top — crowd naturally gathers around active problems

### Flow 4: Absent Role (Async)
1. IRB role not staffed at event
2. After 10 min → email sent to IRB contact with quorum summary
3. IRB clicks "Approve" or "Reject" in email → no login, no app
4. Dashboard updates: IRB node turns green; artifact moves to `final`

---

## Non-Functional Requirements

- Station terminal loads in < 2s on average conference WiFi
- Health chart updates in < 1s from submission to visible line movement
- Supabase realtime: debounce updates, max 1 broadcast/sec per quorum
- Offline-first: IndexedDB buffers inputs if WiFi drops; replays on reconnect
- Optimistic locking on artifact writes (version + CAS, 409 retry)
- Azure OpenAI as default LLM (DCRI BAA for HIPAA compliance)
- All LLM calls behind `LLMProvider` interface for provider swapping

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), TypeScript |
| Backend | FastAPI, Python |
| Database | Supabase (Postgres + Realtime) |
| LLM | Azure OpenAI (GPT-4o-mini T2, GPT-4o T3) via pluggable interface |
| Dashboards | Recharts (Health Chart), React Flow (graphs), Framer Motion (animations) |
| Auth | Supabase Auth (architects), anon JWT (participants) |
| Hosting | Vercel (frontend), Railway (backend) |
| Package manager | pnpm |

---

## Repo Structure (Target)

```
quorum/
├── apps/
│   ├── web/          # Next.js frontend
│   └── api/          # FastAPI backend
├── packages/
│   ├── types/        # Shared TypeScript types (generated from CONTRACT.md)
│   └── llm/          # LLMProvider interface + Azure/Anthropic/OpenAI adapters
├── components/
│   └── dashboards/   # One file per dashboard type
├── supabase/
│   └── migrations/   # DB schema from CONTRACT.md
├── seed/
│   └── clinical-trial.json  # Anchor seed quorum
├── PRD.md            # This file
├── ARCHITECTURE.md
├── CONTRACT.md
├── DECISIONS.md
├── DASHBOARDS.md
├── CLAUDE.md         # Points to agent.md
├── agent.md          # AI agent onboarding
├── .env.example
└── .gitignore
```

---

## Success Criteria (MVP)

- [ ] Architect can create an event + quorum with roles + hierarchy in < 5 minutes
- [ ] Participant can walk up to a station URL and submit a contribution in < 60 seconds
- [ ] Health chart visibly rises within 1 second of submission
- [ ] Artifact PDF downloads with all contributions attributed by role
- [ ] Seed clinical trial quorum is live and populated on every new event
- [ ] `/display` route runs unattended on a projector for a 4-hour event

---

## Parallel Build Plan (for coding agents)

These workstreams are independent and can be built simultaneously:

| Stream | Work | Dependencies |
|---|---|---|
| **A** | Supabase migrations (all tables from CONTRACT.md) | None |
| **B** | Shared TypeScript types package | CONTRACT.md enums/schemas |
| **C** | Next.js app skeleton + routing (`/event`, `/display`, `/architect`) | None |
| **D** | FastAPI skeleton + WebSocket `/quorums/{id}/live` | None |
| **E** | LLM package (`LLMProvider` interface + Azure adapter) | None |

Phase 2 (after A–E):
| Stream | Work | Dependencies |
|---|---|---|
| **F** | Contribution UI (role pills, structured form, submit) | A, B, C |
| **G** | LLM synthesis pipeline (3-tier) | A, B, D, E |
| **H** | Quorum Health Chart dashboard | A, B, C |
| **I** | Architect view (create event, quorum, drag-rank) | A, B, C |
| **J** | Seed quorum loader | A |
