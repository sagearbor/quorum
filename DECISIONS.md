# DECISIONS.md — Append-Only Decision Log

> Format: [date] | decision | why | alternatives rejected

---

[2026-02-25] | Repo name: `quorum` under `sagearbor` | Clean, memorable, brand is Quorum not ArborQuorum | ArborQuorum (too long), quorum (not unique enough on its own without org context)

[2026-02-25] | Terminals are role-first, not scenario-first | Roles are stable (IRB, Patient); scenarios change on the fly. Tent card printed QR only needs station number. | Scenario-first terminals (brittle — requires reprinting QR per scenario)

[2026-02-25] | No forced time-flow or hierarchy in UI navigation | Many problems have no natural sequence or flat authority. Imposing structure misleads users. | Time-flow layout (rejected — doesn't generalize), authority-sorted layout (rejected — same reason)

[2026-02-25] | Single URL per station with `?station=N` param | Dumb boxes, no install, no per-scenario reprinting. Station default is a preference not a lock. | Per-scenario QR codes (brittle to on-the-fly quorum creation)

[2026-02-25] | Azure OpenAI as default LLM provider | DCRI has BAA for HIPAA compliance. Cost covered by institutional account. | Anthropic (no BAA at DCRI), OpenAI (same issue)

[2026-02-25] | LLM provider behind pluggable interface | Allow swap to Anthropic / OpenAI / local without app changes | Hardcoding Azure (limits non-DCRI deployment)

[2026-02-25] | Three-tier LLM synthesis (keyword → conflict → artifact) | Controls cost. ~3 LLM calls per quorum regardless of input count. | Per-input LLM calls (cost explosion at scale)

[2026-02-25] | API cost: graceful catch only, no upfront rate limiting | Low friction. Cost abuse unlikely in controlled event settings. Alert owner on exhaustion. | Upfront rate limiting (rejected — adds friction to normal use)

[2026-02-25] | Camera/presence detection is post-MVP | Product works as remote URL tool. Expo kiosk mode is a nice-to-have, not core value. | Camera as core feature (rejected — brittle in loud/bright expo environments)

[2026-02-25] | Role capacity: 1 (single) or unlimited (committee) | CEO needs single claim; IRB is a committee. Architect sets at quorum creation. | All roles unlimited (rejected — loses governance fidelity)

[2026-02-25] | Quorum max cap per event (configurable) | Prevents 50-idea fragmentation at expo. Creates natural "hot topic" dynamics. | No cap (rejected — fragments attention, dilutes engagement)

[2026-02-25] | Projection display as separate read-only `/display` route | Projector just loads a URL. No interaction surface. Carousel auto-rotates. | Dedicated display app (overkill), sharing architect view (exposes controls)

[2026-02-25] | Dashboard carousel: dual-panel, slides right, two modes | Always in motion. Multi-view (dashboards per quorum) or multi-quorum (same dashboard, different quorums). | Single dashboard (static, boring), manual switching (requires operator)

[2026-02-25] | Quorum Health Chart as default dashboard for every quorum | Line going up = good. Unambiguous progress signal. Drives participation via visible feedback loop. | Contribution matrix with color (rejected — red/green ambiguous without direction)

[2026-02-25] | Seed quorum: pre-built clinical trial scenario | Ensures expo has a live, polished demo even if participation is low. Rises on heat metrics by default. | No seed (cold start risk at expo)

[2026-02-25] | Proxy escalation for absent roles | Absent high-authority role shouldn't stall quorum. Fallback chain + async email approve/reject (signed JWT, no login). | Block on absence (rejected — breaks partial adoption promise)

[2026-02-25] | CONTRACT.md as machine-readable spec | Any AI agent can onboard and build a client from CONTRACT.md alone. No prose needed. | Only ARCHITECTURE.md (rejected — too narrative for AI consumption)

[2026-02-25] | `dashboard_types text[]` column on quorums table | API route accepts `dashboard_types: DashboardType[]` and ARCHITECTURE shows DashboardConfig as child of quorum. Storing as `text[]` on the quorums table is simplest — no junction table needed for a small, bounded enum set. Default `['quorum_health_chart']`. | Separate dashboard_config junction table (rejected — over-normalized for an array of enum strings), jsonb column (rejected — text[] is more queryable and type-safe for string arrays)

[2026-02-25] | DemoEngine uses plain EventEmitter pattern, not Supabase mock | Simpler, zero dependencies, no network. Components subscribe via same interface through dataProvider abstraction. | Mock Supabase client (rejected — complex to maintain, couples demo to Supabase internals), MSW/service worker (rejected — overkill for demo, adds build complexity)

[2026-02-25] | dataProvider as unified interface, components never import supabase directly | Single switching point for demo vs live mode. isDemoMode() checks env var or missing Supabase URL. Lazy-imports supabase module in live mode to avoid crashes when env vars are missing. | Direct Supabase imports with conditional checks everywhere (rejected — scattered, error-prone), context provider wrapping entire app (rejected — adds unnecessary React coupling for what's a data access pattern)

[2026-02-25] | Seed JSON at repo root `seed/clinical-trial.json` shared by frontend DemoEngine and backend seed_loader | Single source of truth. Frontend imports JSON directly; backend reads file on startup. Avoids drift between demo data and DB seed. | Separate frontend fixtures and backend SQL (rejected — data drift), API endpoint to dump fixtures (rejected — requires live backend for demo)

[2026-02-25] | Seed roles renamed to match task spec: Site Coordinator, IRB Officer, Patient Advocate, Safety Monitor, Sponsor | Task spec requires these 5 role names. Mapped from seed.sql roles (PI→Sponsor, IRB Chair→IRB Officer, Sponsor Medical Monitor→Safety Monitor). Keeps demo consistent with expo branding. | Keep seed.sql names as-is (rejected — task spec is explicit about role names)
